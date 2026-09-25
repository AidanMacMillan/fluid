import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  query,
  renameSession,
  type CanUseTool,
  type Options,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { TabActivity, ViewConnection } from '@fluid/sdk'
import type {
  ClaudeFromView,
  ClaudeModel,
  ClaudeRevert,
  ClaudeToView,
  ClaudeUpload
} from '../shared/protocol'
import {
  CLAUDE_DEFAULT_MODE,
  CLAUDE_TAB,
  isClaudeTab,
  type ClaudeEffort,
  type ClaudePermissionMode,
  type ClaudeTabPayload
} from '../shared/tab'
import { attachmentKey, attachmentsDirectory } from './attachments'
import { claudeExecutable } from './cli'
import { context } from './context'
import {
  contextFromResponse,
  makeClaudeStream,
  usageFromResponse,
  kindOfTool,
  type ClaudeApproval,
  type ClaudeDecision,
  type ClaudeEvent,
  type ClaudeQuestion,
  type ClaudeStream
} from './events'
import { describeScope, READ_ONLY_TOOLS, scopeOf, workspaceTools, type ClaudeScope } from './tools'

/**
 * The Claude Code sessions behind Claude tabs.
 *
 * The same split terminals follow, and for the same reason: there is a real
 * process on the other side of the tab, and spawning it is not a thing a
 * sandboxed web page gets to do. What crosses to the view is events out and
 * instructions in — see ./events.ts for the vocabulary, and
 * ../shared/protocol.ts for the two channels it travels over.
 *
 * A session outlives being looked away from, the way a shell does. A view can
 * be let go of — pushed out of the app's warm set, or crashed — and the
 * session carries on; the next view to connect is handed everything it
 * emitted in the meantime. That replay is also the transcript: nothing is
 * written down separately, because the buffer already holds the conversation
 * in the form the view draws.
 *
 * The one thing a shell never does is ask a question. A session does — every
 * tool it wants to run that is not already allowed stops here until the user
 * answers, and answering happens in a view that may not exist yet. Hence
 * `pending`, and hence the rule that closing a session settles every question
 * still open in it: a tab whose session is gone must not be left waiting on an
 * answer that can never come.
 *
 * The session is also what writes the tab: which conversation it is, how its
 * controls are set, and what it is called. Here rather than in the view,
 * because the session is where each of those is first known, and it goes on
 * knowing them with no view connected at all.
 *
 * @module sessions
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * How much of a conversation is kept for replay.
 *
 * Whole events are dropped from the front rather than the list being cut to a
 * count, and a session that runs past this loses its opening rather than its
 * latest turn — the same trade the terminal's replay buffer makes, for the same
 * reason: what is on screen now matters more than what was on screen an hour
 * ago. A session that overflows can still be re-read from disk on the next
 * attach, which is where the whole transcript lives anyway.
 */
const MAX_REPLAY_EVENTS = 4000

/** How long events are gathered before being sent, in milliseconds. */
const FLUSH_MS = 16

/** How stale the plan's limits may get before a finished turn re-reads them. */
const USAGE_REFRESH_MS = 60_000

/** A question waiting on the user, and the promise the session is parked on. */
type Pending = {
  settle: (decision: ClaudeDecision) => void
  /** Suggested rules for "allow for this session", when the CLI offered any. */
  suggestions?: PermissionUpdate[]
  input: Record<string, unknown>
}

/** A clarifying question waiting on the user. */
type PendingQuestion = {
  settle: (answers: Record<string, string> | null) => void
  input: Record<string, unknown>
}

type Session = {
  tabId: string
  query: Query
  stream: ClaudeStream
  /** Pushes the next user turn into the query's prompt. See `pump`. */
  send: (message: SDKUserMessage) => void
  /** Ends the prompt iterable, which ends the query. */
  close: () => void
  cwd: string
  /** Set once the session has said what it is, and written to the tab's payload then. */
  sessionId: string | null
  /** Where files dropped into this session are put, and which it may read. */
  attachments: string
  replay: ClaudeEvent[]
  outgoing: ClaudeEvent[]
  flush: ReturnType<typeof setTimeout> | null
  /**
   * The views drawing this session right now. Usually one, and often none: a
   * session carries on with nobody watching, and whoever connects next is
   * handed the replay.
   */
  viewers: Set<ViewConnection>
  /** How many turns the user has sent, which names the next one. */
  turns: number
  /** The last write to the tab's payload; see `writePayload`. */
  writes: Promise<void>
  /** Approvals and questions parked on the user, by request id. */
  pending: Map<string, Pending>
  questions: Map<string, PendingQuestion>
  /**
   * Whether this app ended the session rather than it ending on its own. Such
   * an exit is not reported: the tab it would name is already going.
   */
  ended: boolean
  /** Whether a turn is in flight; see `ClaudeSnapshot.running`. Changed through `setRunning`. */
  running: boolean
  /** The last write of the tab's activity dot; see `markTab`. */
  activity: Promise<void>
  /**
   * What that write said. Only ever this session's own news: `done` taken off
   * by the window is not reflected here, and does not need to be — the next
   * thing this says is always `working`.
   */
  shown: TabActivity | null
  /** What the conversation is called, as far as this session knows. */
  title: string | null
  /** When the plan's limits were last asked for; see `USAGE_REFRESH_MS`. */
  usageReadAt: number
  exit: { error: string | null } | null
}

/**
 * tab id → its session. Sessions outlive their views; only a tab stopping, or
 * the extension, ends one.
 */
const sessions = new Map<string, Session>()

/**
 * Sessions being started, by tab: reading the transcript back and working out
 * the scope both wait, and a second view connecting in that time must join the
 * session the first is starting rather than start another.
 */
const starting = new Map<string, Promise<Session | { failure: string }>>()

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

/**
 * The environment a session runs in.
 *
 * `ANTHROPIC_API_KEY` is deliberately removed. The CLI resolves credentials in
 * order and an API key wins over the claude.ai login stored in the keychain —
 * so a key left exported in the shell this app was launched from would quietly
 * move every session onto per-token billing, beside a subscription the user is
 * already paying for. A tab in this app means the user's plan; anyone wanting
 * the other thing can run `claude` in a terminal tab.
 */
function sessionEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.ANTHROPIC_API_KEY
  delete environment.ANTHROPIC_AUTH_TOKEN
  // Electron sets these for its own child processes and the CLI is not one of
  // them; left in place they make node behave as Electron's helper rather than
  // as node. Same removals the terminal makes, for the same reason.
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_OPTIONS
  return environment
}

/**
 * What is appended to Claude Code's own system prompt.
 *
 * Takes the work the tab is for, which today is nothing: a Claude tab knows
 * only its folder. The parameter is here because the next thing this grows is
 * a session that opens already knowing which review it is about — the task's
 * facts, the thread it came from — and that wants to arrive as context rather
 * than as a first turn the user did not type. Threading it now costs a line and
 * saves changing every caller later.
 */
function buildPreamble(scope: ClaudeScope | null): string {
  const lines = [
    'You are running inside Fluid, a desktop workspace, in a tab rather than a terminal.',
    'Terminal-drawing tools and anything that expects a TTY will not render for the user.'
  ]
  // Absent for a session whose tab, task or project could not be read, which is
  // the same case that leaves it without the tools — so the preamble says
  // nothing about a workspace it cannot act on.
  if (scope) lines.push('', ...describeScope(scope))
  return lines.join('\n')
}

/**
 * Connects a view to its tab's session, starting the session if this is the
 * first view since it stopped.
 *
 * Nothing is sent until the view asks — see `ClaudeFromView` — and what it is
 * sent then is everything it needs to look the way the last view did.
 */
export function connectView(connection: ViewConnection): void {
  connection.onMessage((message) => {
    if ((message as ClaudeFromView | null)?.type === 'attach') void attach(connection)
  })
}

async function attach(connection: ViewConnection): Promise<void> {
  const post = (message: ClaudeToView): void => connection.post(message)
  const opened = await sessionFor(connection.tabId)
  if (!connection.connected) return
  if ('failure' in opened) {
    post({ type: 'failure', message: opened.failure })
    return
  }

  const session = opened
  // Whatever is gathered but not yet sent goes to the views already watching
  // first. It is part of the replay too, so the new view gets it there, and
  // holding it back until after would hand the new view the same events twice.
  flushNow(session)
  post({
    type: 'snapshot',
    replay: [...session.replay],
    exit: session.exit,
    running: session.running,
    thinking: await showsThinking()
  })
  if (!connection.connected || sessions.get(session.tabId) !== session) return
  session.viewers.add(connection)
  connection.onDisconnect(() => session.viewers.delete(connection))
}

/** The tab's session, started if it is not running. */
function sessionFor(tabId: string): Promise<Session | { failure: string }> {
  const running = sessions.get(tabId)
  if (running) return Promise.resolve(running)
  let opening = starting.get(tabId)
  if (!opening) {
    opening = open(tabId).finally(() => {
      if (starting.get(tabId) === opening) starting.delete(tabId)
    })
    starting.set(tabId, opening)
  }
  return opening
}

/**
 * Starts a tab's session: its conversation so far, read back off disk, and
 * the query that carries it on.
 */
async function open(tabId: string): Promise<Session | { failure: string }> {
  const tab = await context().api.tabs.get({ id: tabId })
  if (!tab || !isClaudeTab(tab)) return { failure: 'This tab no longer exists.' }
  const options = tab.payload

  // Read before the session starts rather than alongside it, so the
  // conversation so far is in front of whatever the resumed session says next.
  // A tab opened for the first time has nothing to read and skips it.
  const history = options.sessionId ? await readHistory(options) : []

  // Worked out here rather than inside `start`, which cannot wait: what a
  // session may touch is three rows away from the tab id (see `scopeOf`), and
  // it has to be settled before the query is built because the tools close
  // over it.
  const scope = await scopeOf(tabId, options.cwd)

  // The tab was stopped while this was waiting. Starting a process for it now
  // would leave one running that nothing will ever stop.
  if (!starting.has(tabId)) return { failure: 'This session has stopped.' }

  try {
    const session = start(tabId, options, history, scope)
    sessions.set(tabId, session)
    // A tab opened with its question already asked. Only before the
    // conversation exists: once it does, the prompt is cleared with the id that
    // names it (see `pump`), and one left over would be asked twice.
    if (options.prompt && !options.sessionId) sendToClaude(tabId, options.prompt, [])
    // Asked now rather than when the CLI says the session is up, because it
    // says that at the start of the first *turn* — so a tab reopened and left
    // alone would show empty gauges until it was spoken to, which reads as "no
    // usage" rather than "not asked yet". Both answer on an idle session.
    void readUsage(session)
    void readContext(session)
    return session
  } catch (error) {
    return { failure: reasonOf(error) }
  }
}

/**
 * The conversation this tab was having, off disk.
 *
 * Claude Code keeps every session's transcript itself, which is why none is
 * kept here — and this is the other half of that bargain: the tab remembers
 * which session it was, and the messages come back from the CLI's own store.
 *
 * They come back as whole messages rather than as the stream that produced
 * them, which is exactly the case the mapper's fallback path exists for: no
 * frames means the assembled message is the only copy, and its text is emitted
 * in one go. The view cannot tell a restored conversation from a live one,
 * because by the time either reaches it they are the same events.
 *
 * A history that cannot be read is not a reason to refuse the tab. The session
 * still resumes with its context intact — it is only the part on screen that is
 * missing, and saying so is better than failing to open.
 */
async function readHistory(options: ClaudeTabPayload): Promise<ClaudeEvent[]> {
  try {
    const messages = await getSessionMessages(options.sessionId!, { dir: options.cwd })
    const stream = makeClaudeStream({ includeUserTurns: true })
    const events: ClaudeEvent[] = []
    for (const message of messages) {
      // `SessionMessage` carries the raw message under a wrapper of its own.
      // What the mapper reads of it — the type, the content, the owning agent —
      // is the same in both shapes.
      events.push(
        ...stream.read({
          type: message.type,
          message: message.message,
          parent_tool_use_id: message.parent_tool_use_id
        } as unknown as SDKMessage)
      )
    }
    return events.map(unpackAttachments)
  } catch (error) {
    console.error('Failed to read a Claude transcript:', error)
    return [
      {
        type: 'notice',
        level: 'warning',
        message: 'The earlier part of this conversation could not be read back.'
      }
    ]
  }
}

/**
 * Takes the attachment paths back out of a restored turn.
 *
 * A transcript read off disk has only what was sent — the paths and the words,
 * in one string — because the split above is this extension's and the CLI
 * never knew about it. So it is undone here by recognising the lines for what
 * they are: leading lines naming a file inside the attachments root, which is a
 * place nothing but this writes to and no user types the name of by hand. See
 * `attachmentKey`, which also knows where the app kept them before.
 */
function unpackAttachments(event: ClaudeEvent): ClaudeEvent {
  if (event.type !== 'user' || event.attachments) return event
  const lines = event.text.split('\n')
  const attachments: { name: string; key: string }[] = []
  let at = 0
  while (at < lines.length) {
    const key = attachmentKey(lines[at]!)
    if (key === null) break
    attachments.push({ name: basename(lines[at]!), key })
    at += 1
  }
  if (attachments.length === 0) return event
  // The blank line that separated them from the turn goes too.
  while (at < lines.length && lines[at] === '') at += 1
  return { ...event, text: lines.slice(at).join('\n'), attachments }
}

function start(
  tabId: string,
  options: ClaudeTabPayload,
  history: ClaudeEvent[],
  scope: ClaudeScope | null
): Session {
  const attachments = attachmentsDirectory(tabId)

  /**
   * The prompt side of the session.
   *
   * The SDK has no session object to hold — the one it had was withdrawn — so a
   * live session is a single `query()` whose prompt never ends. This is that
   * end of it: turns are pushed in, and the iterable waits between them.
   */
  const queue: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let closed = false

  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  })()

  const send = (message: SDKUserMessage): void => {
    queue.push(message)
    const resume = wake
    wake = null
    resume?.()
  }
  const close = (): void => {
    closed = true
    const resume = wake
    wake = null
    resume?.()
  }

  const session: Session = {
    tabId,
    // Filled in immediately below; the callbacks need the session to exist.
    query: undefined as unknown as Query,
    stream: makeClaudeStream({ includeUserTurns: false }),
    send,
    close,
    usageReadAt: 0,
    cwd: options.cwd,
    sessionId: options.sessionId ?? null,
    attachments,
    replay: [...history],
    outgoing: [],
    flush: null,
    viewers: new Set(),
    turns: 0,
    writes: Promise.resolve(),
    pending: new Map(),
    questions: new Map(),
    ended: false,
    running: false,
    activity: Promise.resolve(),
    shown: null,
    title: null,
    exit: null
  }

  const executable = claudeExecutable()
  const sdkOptions: Options = {
    cwd: options.cwd,
    // The user's own `claude` when it is at least as new as the bundled one,
    // so the model picker keeps up with releases — see ./cli.ts.
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    permissionMode: options.permissionMode ?? CLAUDE_DEFAULT_MODE,
    ...(options.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.sessionId ? { resume: options.sessionId } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildPreamble(scope)
    },
    // The workspace the session is sitting in, as tools it can use — see
    // ./tools.ts. Built per session because each one closes over
    // the project it is allowed to touch, and left out entirely for a session
    // that has no scope: tools that cannot say what they may act on are worse
    // than no tools at all.
    //
    // Not serializable, and deliberately: an MCP server made here is a live
    // object in the app's process, which is what lets a tool reach the
    // workspace API directly. It is also why these tools exist for tabs alone
    // and not for `claude` in a terminal.
    ...(scope ? { mcpServers: { fluid: workspaceTools(scope) } } : {}),
    // Pinned rather than left to default, so what a session picks up off the
    // disk is a decision this file made and not one it inherited.
    settingSources: ['user', 'project', 'local'],
    additionalDirectories: [attachments],
    includePartialMessages: true,
    // What makes reverting possible: the CLI keeps a copy of every file it
    // touches, keyed to the turn that touched it. Off by default, and there is
    // no way to ask for the copies after the fact.
    enableFileCheckpointing: true,
    // A guess at the next thing to ask, offered in the empty composer and taken
    // with Tab. Nearly free: it rides on the turn's own prompt cache. The CLI
    // withholds them in the cases where a guess would be unwelcome — the first
    // turn, plan mode, after an error, at the usage limit — and the user's own
    // `promptSuggestionEnabled: false` still wins, so this asks rather than
    // insists.
    promptSuggestions: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    env: sessionEnvironment(),
    canUseTool: approver(session),
    stderr: (data: string) => console.error(`claude (${tabId}):`, data.trimEnd())
  }

  session.query = query({ prompt, options: sdkOptions })
  void pump(session)
  // A resumed session already has a name; asking now means the row carries it
  // from the moment the tab opens rather than from the end of the next turn.
  if (session.sessionId) void readTitle(session)
  return session
}

/**
 * Reads the session for as long as it lasts.
 *
 * One loop per session, started once. Its end is the session's end, whether
 * that came from the user closing the tab, the CLI stopping, or a failure —
 * which is why the exit is reported from the one place all three arrive.
 */
async function pump(session: Session): Promise<void> {
  try {
    for await (const message of session.query as AsyncIterable<SDKMessage>) {
      const events = session.stream.read(message)
      if (events.length > 0) {
        for (const event of events) {
          if (event.type !== 'session' || event.sessionId === session.sessionId) continue
          session.sessionId = event.sessionId
          // The id is the whole of what makes this tab the same conversation
          // after a restart, so it is written the moment it is known rather
          // than on the way out — an app that is killed has no way out.
          void writePayload(session, { sessionId: event.sessionId, prompt: undefined })
        }
        record(session, events)
      }
      // Asked for once the session has said who it is, because that is the
      // first moment the answer exists. Failures are silent: a gauge that
      // cannot be drawn is not a reason to interrupt a conversation.
      // The turn is over when the CLI says so, whatever the transcript looks
      // like at that moment.
      if (message.type === 'result') {
        setRunning(session, false)
        void readTitle(session)
        void readContext(session)
        // Not on every turn: the windows move slowly, the streamed
        // `rate_limit_event` frames keep them roughly current in between, and
        // this one goes out to the account's usage endpoint rather than being
        // answered locally.
        if (Date.now() - session.usageReadAt > USAGE_REFRESH_MS) void readUsage(session)
      }
    }
    finish(session, null)
  } catch (error) {
    finish(session, reasonOf(error))
  }
}

/**
 * Starts or ends a turn, and says so on the tab's row (see `TabActivity`):
 * working while a turn is in flight, done once it has finished, or `after` for
 * a turn that ended some other way.
 */
function setRunning(session: Session, running: boolean, after: 'done' | null = 'done'): void {
  if (session.running === running) return
  session.running = running
  if (running) showParked(session)
  else markTab(session, after)
}

/**
 * Says on the row whether the turn in flight is stopped on the user — an
 * approval or a question open — or getting on by itself. Run whenever one is
 * opened or answered.
 */
function showParked(session: Session): void {
  if (!session.running) return
  markTab(session, session.pending.size + session.questions.size > 0 ? 'waiting' : 'working')
}

/**
 * Writes the tab's activity. Chained, so that a turn over in a moment still
 * lands as working and then done, in that order.
 *
 * A session this app ended says nothing: its tab is closing, or its task is
 * settling and the app takes the dot off itself.
 */
function markTab(session: Session, activity: TabActivity | null): void {
  if (session.ended || session.shown === activity) return
  session.shown = activity
  session.activity = session.activity
    .then(async () => {
      await context().api.tabs.setActivity({ id: session.tabId, activity })
    })
    .catch((error: unknown) => console.error('Failed to mark a Claude tab:', error))
}

/** Asks the CLI what the plan's usage windows are, and draws them. */
async function readUsage(session: Session): Promise<void> {
  session.usageReadAt = Date.now()
  try {
    const response = await session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      // The scan this skips reads every transcript touched in the last week,
      // and fills in a section about past behaviour that nothing here draws.
      skipBehaviors: true
    })
    const { windows, plan, credits } = usageFromResponse(response)
    if (windows.length > 0 || credits) {
      record(session, [{ type: 'usage', windows, plan, credits }])
    }
  } catch {
    // An older CLI, or a session with no plan behind it. Either way there are
    // no gauges to draw and nothing to say about it.
  }
}

/**
 * Asks how full the context window is.
 *
 * After every turn, because that is when it changes and the answer is a cheap
 * control request rather than anything the model is asked. Before the first
 * turn it is worth asking too: a resumed conversation arrives with a window
 * already most of the way full, and the gauge should say so on sight.
 */
async function readContext(session: Session): Promise<void> {
  try {
    const context = contextFromResponse(await session.query.getContextUsage({ detail: 'summary' }))
    if (context) record(session, [{ type: 'context', context }])
  } catch {
    // Same as above: an older CLI, or a session that has gone. Nothing to draw.
  }
}

/**
 * Asks what this conversation is called, and says so if the answer is new.
 *
 * Claude Code names a session itself — a short summary it writes once there is
 * enough of a conversation to summarise — and a rename overwrites that same
 * name rather than sitting beside it. So there is one name, the CLI owns it,
 * and this is the only thing that reads it.
 *
 * Asked after each turn rather than watched, because there is nothing to watch:
 * the name is a line in the session's file on disk, and a turn ending is the
 * only moment it is likely to have changed.
 */
async function readTitle(session: Session): Promise<void> {
  if (!session.sessionId) return
  try {
    const info = await getSessionInfo(session.sessionId, { dir: session.cwd })
    const title = info?.customTitle ?? info?.summary
    if (!title || title === session.title) return
    nameTab(session, title)
  } catch {
    // A session file that is not readable yet, or a CLI that does not keep
    // names. The tab falls back to its folder, which is what it showed before.
  }
}

/**
 * Renames the conversation.
 *
 * Written to the session rather than only to the tab, so the name is the same
 * one `claude --resume` and every other client shows. The tab follows through
 * `nameTab`, which is the same path the CLI's own name arrives by — there is
 * one way a name reaches the row, whoever chose it.
 */
export async function renameClaude(tabId: string, title: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session?.sessionId) return
  const trimmed = title.trim()
  if (trimmed === '' || trimmed === session.title) return
  await renameSession(session.sessionId, trimmed, { dir: session.cwd })
  nameTab(session, trimmed)
}

/**
 * Puts the files back as they were before a turn.
 *
 * Files only. The conversation is not rewound — Claude still remembers
 * everything it did, and saying otherwise would be the kind of half-truth that
 * costs somebody an afternoon. What this undoes is the damage, not the memory,
 * which is usually the thing actually wanted: the model can be told what went
 * wrong and try again with the work in front of it.
 *
 * `dryRun` answers what would change without changing it, which is what the
 * view asks before it offers the button.
 */
export async function revertClaude(
  tabId: string,
  uuid: string,
  dryRun = false
): Promise<ClaudeRevert> {
  const session = sessions.get(tabId)
  if (!session || session.exit) return { ok: false, error: 'The session has stopped.' }
  try {
    const result = await session.query.rewindFiles(uuid, { dryRun })
    return {
      ok: result.canRewind,
      ...(result.error ? { error: result.error } : {}),
      ...(result.filesChanged ? { filesChanged: result.filesChanged } : {}),
      ...(typeof result.insertions === 'number' ? { insertions: result.insertions } : {}),
      ...(typeof result.deletions === 'number' ? { deletions: result.deletions } : {})
    }
  } catch (error) {
    return { ok: false, error: reasonOf(error) }
  }
}

/**
 * Branches the conversation at a turn, into a tab of its own.
 *
 * The original is untouched and keeps its id; the new tab holds a copy of
 * everything up to that turn, beside this one in the same task. Two tabs, two
 * directions, both resumable — and the user is taken to the new one, with the
 * turn it branched from waiting in its composer, so the branch is taken by
 * editing the question rather than by remembering it.
 *
 * A fork is a file on disk rather than a running process, so this needs no live
 * session. It does need the id the tab is holding.
 *
 * Answers with why it could not, or null once the tab is open.
 */
export async function forkClaude(
  tabId: string,
  uuid: string,
  draft: string
): Promise<string | null> {
  const session = sessions.get(tabId)
  if (!session?.sessionId) return 'This conversation has not started yet.'

  let sessionId: string | null
  try {
    // `upToMessageId` is inclusive, and the turn being forked from is the one
    // the user wants to ask again — so the fork has to stop at the entry before
    // it. Forking inclusively would leave the old wording in the branch and the
    // new wording about to be typed, and the reader would have asked twice.
    const messages = await getSessionMessages(session.sessionId, { dir: session.cwd })
    const index = messages.findIndex((message) => message.uuid === uuid)

    // Nothing before it: the branch is an empty conversation in the same
    // folder, which is a new tab rather than a fork of anything.
    sessionId =
      index <= 0
        ? null
        : (
            await forkSession(session.sessionId, {
              dir: session.cwd,
              upToMessageId: messages[index - 1]!.uuid
            })
          ).sessionId
  } catch (error) {
    return reasonOf(error)
  }

  const api = context().api
  const tab = await api.tabs.get({ id: tabId })
  if (!tab) return 'This tab no longer exists.'
  const payload: ClaudeTabPayload = { cwd: session.cwd, ...(sessionId ? { sessionId } : {}) }
  const branch = await api.tabs.open({
    taskId: tab.taskId,
    tab: { type: CLAUDE_TAB, title: null, payload }
  })
  // Written before the tab is shown, so its view reads the draft as it loads
  // rather than having it appear underneath.
  if (draft !== '') await api.tabs.update({ id: branch.id, viewState: { draft } })
  await api.ui.reveal({ taskId: tab.taskId, tabId: branch.id })
  return null
}

function finish(session: Session, error: string | null): void {
  setRunning(session, false)
  settleAll(session, 'cancel')
  flushNow(session)
  if (session.ended) return
  session.exit = { error }
  post(session, { type: 'exit', error })
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * The callback the SDK asks before running a tool that is not already allowed.
 *
 * Three things arrive here that are not the same question, and only the last is
 * an approval:
 *
 * `AskUserQuestion` is the model asking the user something, not asking to do
 * something. It gets its own card and its answer goes back as the tool's result.
 *
 * `ExitPlanMode` is the model saying it has finished planning. It is denied
 * rather than allowed: the plan is taken out of the call and drawn as a card of
 * its own, and the model is told to stop and wait. Letting the tool succeed
 * would move the session out of plan mode on the model's say-so, which is the
 * user's decision to make against a plan they have read.
 *
 * Everything else is an approval, and parks here until the user answers. There
 * is no deadline on that — the session waits as long as the tab is open.
 */
function approver(session: Session): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') {
      const answers = await askQuestion(session, options.requestId, input)
      if (!answers) return { behavior: 'deny', message: 'The user dismissed the question.' }
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }

    // Reading the workspace the user is sitting in front of, which is theirs
    // and which the session can already see most of. See `READ_ONLY_TOOLS`.
    if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }

    if (toolName === 'ExitPlanMode') {
      const markdown = typeof input.plan === 'string' ? input.plan : null
      if (markdown) record(session, [{ type: 'proposal', markdown }])
      return {
        behavior: 'deny',
        message:
          'The client captured your proposed plan and is showing it to the user. Stop here and wait for their answer in a later turn.'
      }
    }

    const approval: ClaudeApproval = {
      requestId: options.requestId,
      toolUseId: options.toolUseID,
      toolName,
      kind: kindOfTool(toolName),
      // The CLI writes this sentence itself. Rebuilding one from the tool name
      // and its arguments would be a worse sentence that also goes out of date.
      title: options.title ?? `Claude wants to use ${toolName}`,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      input,
      ...(options.decisionReason ? { reason: options.decisionReason } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      allowAlways: options.suppressAlwaysAllowRule !== true,
      defaultToNo: options.defaultToNo === true
    }

    const decision = await new Promise<ClaudeDecision>((resolve) => {
      session.pending.set(options.requestId, {
        settle: resolve,
        ...(options.suggestions ? { suggestions: options.suggestions } : {}),
        input
      })
      record(session, [{ type: 'approval.opened', approval }])
      showParked(session)

      // The signal may already have been raised while the event above was
      // being written down, so it is checked as well as listened for.
      const abort = (): void => {
        if (!session.pending.delete(options.requestId)) return
        record(session, [
          { type: 'approval.resolved', requestId: options.requestId, decision: 'cancel' }
        ])
        showParked(session)
        resolve('cancel')
      }
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
    })

    if (decision === 'once' || decision === 'always') {
      const pending = session.pending.get(options.requestId)
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(decision === 'always'
          ? { updatedPermissions: sessionRules(toolName, pending?.suggestions) }
          : {})
      }
    }
    return {
      behavior: 'deny',
      message:
        decision === 'cancel' ? 'The session was interrupted.' : 'The user declined this action.'
    }
  }
}

/**
 * The rules to write for "allow for the rest of this session".
 *
 * The CLI's own suggestions are reused, but rescoped: as offered they target
 * `localSettings`, which is a file in the user's repository — so echoing them
 * back verbatim would turn a choice about the next ten minutes into a rule
 * checked into the project. Rewriting the destination is the whole difference
 * between the two.
 *
 * A tool the CLI made no suggestion for — MCP tools, mostly — gets a rule for
 * the whole tool instead, so the answer still sticks rather than quietly
 * degrading into a one-time yes and another prompt a minute later.
 */
function sessionRules(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined
): PermissionUpdate[] {
  const rescoped = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: 'session'
  }))
  if (rescoped.length > 0) return rescoped
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}

/** Puts the model's questions to the user and waits for what they pick. */
function askQuestion(
  session: Session,
  requestId: string,
  input: Record<string, unknown>
): Promise<Record<string, string> | null> {
  const questions = questionsOf(input)
  if (questions.length === 0) return Promise.resolve(null)

  return new Promise((resolve) => {
    session.questions.set(requestId, { settle: resolve, input })
    record(session, [{ type: 'question.opened', requestId, questions }])
    showParked(session)
  })
}

function questionsOf(input: Record<string, unknown>): ClaudeQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  const questions: ClaudeQuestion[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { question, header, options, multiSelect } = entry as Record<string, unknown>
    if (typeof question !== 'string' || !Array.isArray(options)) continue
    questions.push({
      question,
      header: typeof header === 'string' ? header : '',
      multiSelect: multiSelect === true,
      options: options.flatMap((option) => {
        if (typeof option !== 'object' || option === null) return []
        const { label, description } = option as Record<string, unknown>
        if (typeof label !== 'string') return []
        return [{ label, description: typeof description === 'string' ? description : '' }]
      })
    })
  }
  return questions
}

/**
 * Answers an approval card.
 *
 * Called from a view, which may be answering a card drawn by a page that has
 * since reloaded — hence the quiet return rather than a throw for a request
 * nobody is waiting on any more.
 */
export function respondToClaude(tabId: string, requestId: string, decision: ClaudeDecision): void {
  const session = sessions.get(tabId)
  const pending = session?.pending.get(requestId)
  if (!session || !pending) return
  session.pending.delete(requestId)
  record(session, [{ type: 'approval.resolved', requestId, decision }])
  showParked(session)
  pending.settle(decision)
}

/** Answers the model's questions. `answers` maps each question to what was picked. */
export function answerClaude(
  tabId: string,
  requestId: string,
  answers: Record<string, string> | null
): void {
  const session = sessions.get(tabId)
  const pending = session?.questions.get(requestId)
  if (!session || !pending) return
  session.questions.delete(requestId)
  record(session, [{ type: 'question.resolved', requestId }])
  showParked(session)
  pending.settle(answers)
}

/**
 * Settles everything parked on the user.
 *
 * Run on the way out, always. A request nobody can answer any more must not
 * stay open: the session is waiting on it, and a session waiting on an answer
 * that will never arrive is a tab that can never be closed cleanly.
 */
function settleAll(session: Session, decision: ClaudeDecision): void {
  for (const pending of session.pending.values()) pending.settle(decision)
  session.pending.clear()
  for (const pending of session.questions.values()) pending.settle(null)
  session.questions.clear()
}

// ---------------------------------------------------------------------------
// Telling it things
// ---------------------------------------------------------------------------

/**
 * Sends a turn.
 *
 * Attachments are written into the session's own directory and named in the
 * text rather than carried in it — see `attachmentsDirectory`. The paths go in
 * ahead of what the user typed, because a question about a file reads better
 * after the file than before it.
 */
export function sendToClaude(tabId: string, text: string, attachments: ClaudeUpload[]): void {
  const session = sessions.get(tabId)
  if (!session || session.exit) return

  const paths: string[] = []
  const saved: { name: string; key: string }[] = []
  for (const file of attachments) {
    try {
      const name = safeName(file.name)
      const path = join(session.attachments, name)
      writeFileSync(path, Buffer.from(file.data, 'base64'))
      paths.push(path)
      // Relative to the attachments root rather than to this tab's directory:
      // the tab id is part of what makes the key unique, and the view turns the
      // whole of it into a `claude-code-file://attachments/` URL.
      saved.push({ name, key: `${tabId}/${name}` })
    } catch (error) {
      console.error('Failed to save a Claude attachment:', error)
    }
  }

  // The model is told where the files are, in the turn itself. The view is told
  // the same thing twice over — once as the words the user typed, once as the
  // files — so it can draw the second rather than repeat the first.
  const body = paths.length > 0 ? `${paths.join('\n')}\n\n${text}` : text
  // Minted here so the turn has a name before it has been sent. The CLI keeps
  // it as the transcript entry's own id, which is what `revertClaude` and
  // `forkClaude` below then have to point at.
  const uuid = randomUUID()
  setRunning(session, true)
  session.turns += 1
  record(session, [
    {
      type: 'user',
      itemId: `user-${session.turns}`,
      text,
      uuid,
      ...(saved.length > 0 ? { attachments: saved } : {})
    }
  ])
  // No session id: the query already knows which conversation it is, and a
  // turn that named one would be asserting it rather than being part of it.
  session.send({
    type: 'user',
    message: { role: 'user', content: body },
    parent_tool_use_id: null,
    uuid
  } as SDKUserMessage)
}

/** A file name that cannot climb out of the directory it is written into. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '-').replace(/^\.+/, '')
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 120)
}

/** Stops the turn in progress. The session stays up and can be told more. */
export async function interruptClaude(tabId: string): Promise<void> {
  const session = sessions.get(tabId)
  if (!session || session.exit) return
  // Anything parked on the user goes with the turn it belonged to; the SDK
  // raises the signal for these too, but settling here means the view's cards
  // close at the moment the user asked rather than a round trip later.
  settleAll(session, 'cancel')
  // Nothing finished for the user to come back to: they stopped it, from the tab.
  setRunning(session, false, null)
  try {
    await session.query.interrupt()
  } catch (error) {
    console.error('Failed to interrupt a Claude session:', error)
  }
}

/**
 * The controls beside the composer: model, thinking level, permission mode.
 *
 * Each is applied to the running session and then written to the payload, so
 * the tab reopens the way the user left it. A session that has stopped only has
 * the choice written down, for when it starts again. One the session refuses —
 * `auto` is not offered on every setup — is not written at all, and the refusal
 * goes back to the view to say so.
 */

/** Switches model. Takes effect on the next turn. */
export async function setClaudeModel(tabId: string, model: string): Promise<void> {
  const session = sessions.get(tabId)
  if (session && !session.exit) await session.query.setModel(model)
  await writeControls(tabId, { model })
}

/** Switches permission mode. Takes effect on the next tool call. */
export async function setClaudeMode(tabId: string, mode: ClaudePermissionMode): Promise<void> {
  const session = sessions.get(tabId)
  if (session && !session.exit) await session.query.setPermissionMode(mode)
  await writeControls(tabId, { permissionMode: mode })
}

/**
 * Switches thinking level.
 *
 * Goes through the flag settings layer rather than the query's options, which
 * are settled when the session starts. The level is the tab's alone: nothing is
 * written to the user's settings files, so a tab set to `max` for one hard
 * question does not quietly become how every later session starts.
 */
export async function setClaudeEffort(tabId: string, effort: ClaudeEffort): Promise<void> {
  const session = sessions.get(tabId)
  if (session && !session.exit) await session.query.applyFlagSettings({ effortLevel: effort })
  await writeControls(tabId, { effort })
}

function writeControls(tabId: string, changes: Partial<ClaudeTabPayload>): Promise<void> {
  const session = sessions.get(tabId)
  return session ? writePayload(session, changes) : updatePayload(tabId, changes)
}

/**
 * A model id as a name: `claude-haiku-4-5-20251001` → `Haiku 4.5`.
 *
 * Read off the id rather than kept in a table here, so a model released next
 * month names itself correctly without this file being touched. The window
 * suffix goes — `opus-5[1m]` and `opus-5` are one model — and so does the
 * release date, which is not part of what anybody calls it. Anything that is
 * not shaped like a Claude id at all keeps the CLI's own wording.
 */
function modelName(id: string, fallback: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id.replace(/\[[^\]]*\]$/, ''))
  if (!match) return fallback
  const [, family, major, minor] = match
  const named = family!.charAt(0).toUpperCase() + family!.slice(1)
  return minor ? `${named} ${major}.${minor}` : `${named} ${major}`
}

/** The models this session could switch to, for the picker. */
export async function claudeModels(tabId: string): Promise<ClaudeModel[]> {
  const session = sessions.get(tabId)
  if (!session || session.exit) return []
  try {
    const models = await session.query.supportedModels()
    const rows: ClaudeModel[] = []
    for (const model of models) {
      const resolved = model.resolvedModel ?? model.value
      // One row per model, not per alias. The CLI lists `default` and
      // `opus[1m]` separately because they are different things to ask for, but
      // they run the same model, and a picker offering the same model twice is
      // asking the user to tell apart two rows that cannot be told apart. The
      // first wins, which is the CLI's own recommendation.
      if (rows.some((row) => row.resolved === resolved)) continue
      rows.push({
        id: model.value,
        label: modelName(resolved, model.displayName),
        resolved,
        description: model.description,
        supportsEffort: model.supportsEffort !== false
      })
    }
    return rows
  } catch {
    // An older CLI, or a session that has gone away between the click and the
    // question. An empty picker is the honest answer either way.
    return []
  }
}

// ---------------------------------------------------------------------------
// Sending it on
// ---------------------------------------------------------------------------

/** Holds events for replay and queues them for the views. */
function record(session: Session, events: ClaudeEvent[]): void {
  session.replay.push(...events)
  if (session.replay.length > MAX_REPLAY_EVENTS) {
    session.replay.splice(0, session.replay.length - MAX_REPLAY_EVENTS)
  }
  session.outgoing.push(...events)
  if (session.flush === null) {
    session.flush = setTimeout(() => flushNow(session), FLUSH_MS)
  }
}

function flushNow(session: Session): void {
  if (session.flush !== null) {
    clearTimeout(session.flush)
    session.flush = null
  }
  if (session.outgoing.length === 0) return
  const events = session.outgoing
  session.outgoing = []
  post(session, { type: 'events', events })
}

function post(session: Session, message: ClaudeToView): void {
  for (const viewer of session.viewers) viewer.post(message)
}

// ---------------------------------------------------------------------------
// Writing the tab
// ---------------------------------------------------------------------------

/**
 * Writes what the session settled into the tab's payload.
 *
 * One write at a time per session: the id and a control can be settled in the
 * same moment, and two writes that each started from the payload as it was
 * would each lose the other's change.
 */
function writePayload(session: Session, changes: Partial<ClaudeTabPayload>): Promise<void> {
  const write = session.writes.then(() => updatePayload(session.tabId, changes))
  session.writes = write.catch((error: unknown) => {
    console.error(`Failed to write ${session.tabId}'s session to its tab:`, error)
  })
  return write
}

async function updatePayload(tabId: string, changes: Partial<ClaudeTabPayload>): Promise<void> {
  const api = context().api
  const tab = await api.tabs.get({ id: tabId })
  if (!tab || !isClaudeTab(tab)) return
  const payload: ClaudeTabPayload = { ...tab.payload, ...changes }
  const keys = Object.keys(changes) as (keyof ClaudeTabPayload)[]
  if (keys.every((key) => payload[key] === tab.payload[key])) return
  await api.tabs.update({ id: tabId, payload })
}

/**
 * Names the tab after the conversation.
 *
 * The session owns the name — Claude Code writes it, and a rename goes back
 * through the session rather than stopping at the row — so this only copies.
 * Once the tab has a title the row stops saying which folder the session is in
 * and starts saying what it is about, which is the whole point. The view is
 * told too, for its header.
 */
function nameTab(session: Session, title: string): void {
  session.title = title
  record(session, [{ type: 'title', title }])
  void context()
    .api.tabs.update({ id: session.tabId, title })
    .catch((error: unknown) => console.error(`Failed to name ${session.tabId}:`, error))
}

// ---------------------------------------------------------------------------
// Showing thinking
// ---------------------------------------------------------------------------

/**
 * Whether the views draw the model's thinking along with its answer.
 *
 * One preference for every tab rather than one per tab: it is a question about
 * how the reader likes to read, not about any one conversation. Kept in the
 * extension's storage, and pushed to every view when it changes so the tabs
 * warm behind this one follow along.
 */
const THINKING_KEY = 'thinking'

async function showsThinking(): Promise<boolean> {
  return (await context().storage.get<boolean>(THINKING_KEY)) !== false
}

export async function setShowsThinking(show: boolean): Promise<void> {
  await context().storage.set(THINKING_KEY, show)
  for (const session of sessions.values()) post(session, { type: 'thinking', show })
}

// ---------------------------------------------------------------------------
// Ending one
// ---------------------------------------------------------------------------

/**
 * Ends a session: its tab has stopped, or the extension has. A view going away
 * leaves its session running.
 */
export function destroyClaude(tabId: string): void {
  // One still starting sees this and stops itself; see `open`.
  starting.delete(tabId)
  const session = sessions.get(tabId)
  if (!session) return
  sessions.delete(tabId)
  // Before the close below, so the end it provokes is recognised as this
  // extension's doing rather than reported as a session that stopped on its own.
  session.ended = true
  if (session.flush !== null) clearTimeout(session.flush)
  settleAll(session, 'cancel')
  session.close()
  try {
    void session.query.interrupt()
  } catch {
    // Already gone; nothing to stop.
  }
}

export function destroyAllClaude(): void {
  for (const tabId of [...starting.keys(), ...sessions.keys()]) destroyClaude(tabId)
}

/** The sentence out of whatever went wrong, for a view to show. */
function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw === '' ? 'The Claude Code session stopped.' : raw
}
