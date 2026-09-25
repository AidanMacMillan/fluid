import type {
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse
} from '@anthropic-ai/claude-agent-sdk'
import { readTurn } from './turns'

/**
 * What a Claude session says, in the app's own words.
 *
 * The Agent SDK speaks in messages shaped like the Anthropic API's — assembled
 * assistant messages, raw streaming frames, tool results buried in user turns.
 * None of that is a thing to draw. This module turns it into a flat sequence of
 * events about a conversation: text arrived, a tool started, a turn ended.
 *
 * The union below is the whole of what crosses the bridge, and it is the reason
 * the view imports nothing from the SDK. It is also the seam a second kind
 * of session would join at — a chat that is not about code produces the same
 * events from a different producer, and the pane cannot tell.
 *
 * The mapper is stateful because the SDK's stream is: text and tool inputs
 * arrive in fragments that only mean something in order. `makeClaudeStream`
 * holds that state for one session; see the notes on `ClaudeStream.read`.
 *
 * @module events
 */

// ---------------------------------------------------------------------------
// What a session emits
// ---------------------------------------------------------------------------

/**
 * What kind of thing a tool call is, as far as drawing it goes.
 *
 * Coarser than the tool list on purpose: a pane wants to know whether to draw a
 * diff, a scrollback or a one-line chip, and there are far fewer answers to
 * that than there are tools. Anything unrecognised is a `tool`, which draws as
 * a collapsible card — so a tool added to Claude Code next month appears as
 * itself rather than as a gap.
 */
export type ClaudeItemKind =
  'command' | 'file-change' | 'file-read' | 'search' | 'task' | 'todo' | 'tool'

/** How a tool call ended, or that it has not. */
export type ClaudeItemStatus = 'running' | 'ok' | 'error'

/**
 * One tool call, as the transcript holds it.
 *
 * Sent whole on every change rather than as a patch. A tool call is small and
 * changes a handful of times, and a pane that is handed the current state has
 * nothing to get wrong — where a pane applying patches has to be right about
 * every one of them, including the ones it missed while the tab was closed.
 */
export type ClaudeItem = {
  /** The tool-use id. Stable from the moment the call starts. */
  id: string
  kind: ClaudeItemKind
  toolName: string
  /** What to call this in a heading: `Run command`, `Edit file`. */
  title: string
  /** The one line under it — the command, the path. Absent until the input parses. */
  detail?: string
  /**
   * The tool's arguments, as far as they have been read.
   *
   * Empty while the model is still writing them: inputs stream as JSON
   * fragments and only a complete fragment parses. See `ClaudeStream.read`.
   */
  input: Record<string, unknown>
  status: ClaudeItemStatus
  /** What the tool printed, once it has run. */
  output?: string
  /**
   * The subagent that ran this, if it was not the main thread.
   *
   * Set from `parent_tool_use_id` — the id of the Task call that spawned the
   * agent. A pane uses it to draw these under their task rather than loose in
   * the transcript, which is the whole reason they are attributed at all.
   */
  agentId?: string
}

/** A step in the model's plan, as `TodoWrite` writes it. */
export type ClaudePlanStep = {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

/**
 * One of the plan's usage windows — five hours, a week — as a gauge.
 *
 * `usedPercent` is 0–100 whichever source filled it in; the two the CLI offers
 * disagree about that and are reconciled on the way in. See `usageFromResponse`.
 */
export type ClaudeUsageWindow = {
  /** Matches the CLI's own name for the window, so the two sources land on one row. */
  id: string
  label: string
  usedPercent: number
  /** When the window rolls over, as an ISO timestamp. Absent if the CLI did not say. */
  resetsAt?: string
}

/**
 * Extra usage: what the account has agreed to spend beyond its plan.
 *
 * A different kind of number from the windows above — money rather than a share
 * of an allowance — which is why it is its own row rather than a sixth gauge.
 */
export type ClaudeCredits = {
  usedUsd: number
  /** The cap, when the account has one. */
  limitUsd: number | null
  usedPercent: number
  /** ISO 4217, for the few accounts that are not billed in dollars. */
  currency: string
}

/**
 * How full the model's context window is, and with what.
 *
 * The categories are the CLI's own breakdown and are drawn as one bar in the
 * order given. `colour` is the CLI's name for a colour rather than a colour —
 * `claude`, `warning`, `inactive` — because the palette is the view's to
 * choose. Rows the CLI marks deferred are left out: they are tool schemas that
 * are not in the window, listed for awareness, and counting them would make the
 * bar disagree with its own total.
 */
export type ClaudeContext = {
  usedTokens: number
  /** The window the usage is measured against. */
  maxTokens: number
  usedPercent: number
  segments: { name: string; tokens: number; colour: string; kind: 'used' | 'buffer' | 'free' }[]
}

/** A question the model asked, from the `AskUserQuestion` tool. */
export type ClaudeQuestion = {
  question: string
  /** A short label for the question, at most a dozen characters. */
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

/**
 * A tool call waiting on the user.
 *
 * Most of this is written by the CLI rather than worked out here: it renders
 * the prompt sentence itself, and reconstructing one from the tool name and its
 * arguments would be a worse sentence that also drifts. What this module adds
 * is the kind, so the card can be drawn like the tool it is about.
 */
export type ClaudeApproval = {
  requestId: string
  toolUseId: string
  toolName: string
  kind: ClaudeItemKind
  /** The CLI's own sentence: "Claude wants to read foo.txt". */
  title: string
  /** Its short form, for a button: "Read file". */
  displayName?: string
  /** The longer warning under it, when the CLI wrote one. */
  description?: string
  input: Record<string, unknown>
  /** Why this was asked at all, when the CLI explained it. */
  reason?: string
  /** The path that provoked the ask, for a command reaching outside its folder. */
  blockedPath?: string
  /**
   * Whether the card may offer "allow for this session".
   *
   * False when the CLI says the rule that choice would write grants more than
   * the action being asked about. The card must honour it rather than treat it
   * as advice.
   */
  allowAlways: boolean
  /** Whether the card should open on its decline option rather than its accept. */
  defaultToNo: boolean
}

/**
 * Something that happened between the turns, rather than something either side
 * said.
 *
 * Claude Code writes turns of its own into the transcript and gives them the
 * user's role, because the user's role is the only one a client may write in:
 * a background task reporting back, the output of a slash command, the note it
 * leaves itself when a conversation is summarised. They are addressed to the
 * model, not to the reader, and drawn as a quiet line rather than as a bubble
 * the user never typed. See ./turns.ts for how they are told
 * apart from the person speaking.
 */
export type ClaudeAside = {
  kind: 'task' | 'command' | 'skill' | 'output' | 'interrupted' | 'summary' | 'image'
  /** One line, always drawn. */
  label: string
  /** The rest of it, folded away behind the label. */
  detail?: string
}

/** What the user did with an approval card. */
export type ClaudeDecision = 'once' | 'always' | 'deny' | 'cancel'

export type ClaudeEvent =
  /**
   * The session is up. Everything here is settled at start and answers the
   * questions the chrome asks before the first turn — which model, which mode,
   * which commands exist.
   */
  | {
      type: 'session'
      sessionId: string
      model: string
      permissionMode: PermissionMode
      cwd: string
      slashCommands: string[]
      version: string
      /**
       * Where the credential came from. `'none'` is the ordinary case and means
       * the claude.ai login — anything else means an API key is in play and the
       * session is billed rather than drawn from the plan, which is worth
       * saying out loud in the chrome.
       */
      apiKeySource: string
    }
  /** The user said something. Held here so a restored transcript has both halves. */
  | {
      type: 'user'
      itemId: string
      text: string
      /**
       * Claude Code's own id for this turn in the transcript.
       *
       * Minted here rather than read back: a user message may carry a `uuid`
       * and the CLI keeps it as the entry's own, which is what makes reverting
       * and forking possible at all — both of those name a turn, and without
       * this there would be nothing to name it by.
       *
       * Absent on a turn read back from a transcript written before this, and
       * on anything the CLI wrote itself.
       */
      uuid?: string
      /**
       * Files that went with this turn, for the pane to draw as attachments.
       *
       * The paths are also in `text`, because that is how the model finds them
       * — it is told where they are and reads them. Here they are named
       * separately so the transcript can show the picture rather than the path:
       * the turn the user typed is `text` without them, and the same file is
       * both a line in the prompt and a thumbnail above it.
       *
       * `key` is relative to the attachments root, so it can be served over
       * `claude-code-file://attachments/` without the view ever naming an
       * absolute path.
       */
      attachments?: { name: string; key: string }[]
    }
  /** Something the harness did. See `ClaudeAside`. */
  | { type: 'aside'; itemId: string; aside: ClaudeAside }
  | {
      type: 'turn.completed'
      /** `success`, or one of the SDK's error subtypes. */
      subtype: string
      costUsd?: number
      inputTokens?: number
      outputTokens?: number
    }
  /**
   * More of a block of prose. `itemId` names the block, not the turn: a message
   * can hold several, and thinking is a block like any other.
   */
  | { type: 'text.delta'; itemId: string; kind: 'text' | 'thinking'; delta: string }
  | { type: 'text.ended'; itemId: string }
  | { type: 'item.started'; item: ClaudeItem }
  | { type: 'item.updated'; item: ClaudeItem }
  | { type: 'item.completed'; item: ClaudeItem }
  | { type: 'plan'; steps: ClaudePlanStep[] }
  /** A plan the model proposed and is waiting on; see the note in ./sessions.ts. */
  | { type: 'proposal'; markdown: string }
  | { type: 'approval.opened'; approval: ClaudeApproval }
  | { type: 'approval.resolved'; requestId: string; decision: ClaudeDecision }
  | { type: 'question.opened'; requestId: string; questions: ClaudeQuestion[] }
  | { type: 'question.resolved'; requestId: string }
  /**
   * What the conversation is called.
   *
   * Claude Code names a session itself once it has enough of one to name, and
   * renaming it writes over that name rather than beside it — so there is only
   * ever one, and this carries whichever it currently is.
   */
  | { type: 'title'; title: string }
  /**
   * The plan's limits.
   *
   * `plan` and `credits` come only from the full read at session start; a
   * streamed update carries one window and says nothing about either, so both
   * are optional and absent means "unchanged" rather than "none".
   */
  | {
      type: 'usage'
      windows: ClaudeUsageWindow[]
      plan?: string | null
      credits?: ClaudeCredits | null
    }
  /** How full the context window is. Re-read after every turn. */
  | { type: 'context'; context: ClaudeContext }
  /**
   * What Claude Code guesses you will say next, offered in the empty composer.
   *
   * One per turn at most, and only sometimes: never on the first turn, never in
   * plan mode, never after an API error, and never while the account is at its
   * limit. So the absence of one means nothing, and the composer says nothing
   * about it.
   */
  | { type: 'suggestion'; text: string }
  /** The conversation was summarised to make room. Drawn as a rule across the transcript. */
  | { type: 'compacted'; trigger: 'manual' | 'auto' }
  | { type: 'notice'; level: 'warning' | 'error'; message: string }

// ---------------------------------------------------------------------------
// Naming tools
// ---------------------------------------------------------------------------

/**
 * Which drawing a tool call wants.
 *
 * Read off the name, and off the arguments where the name is not enough:
 * `Bash` is a command, but `Bash` running `cat` is closer to a read, and the
 * distinction is not worth the guessing — so only the clear-cut cases are
 * claimed and everything else falls to `tool`.
 */
export function kindOfTool(toolName: string): ClaudeItemKind {
  const name = toolName.toLowerCase()
  if (name === 'bash' || name === 'bashoutput' || name === 'killshell') return 'command'
  if (name === 'edit' || name === 'write' || name === 'notebookedit') return 'file-change'
  if (name === 'read') return 'file-read'
  if (name === 'glob' || name === 'grep' || name === 'websearch' || name === 'webfetch') {
    return 'search'
  }
  if (name === 'task' || name === 'agent') return 'task'
  if (name === 'todowrite') return 'todo'
  return 'tool'
}

/** What to put in a tool card's heading. */
function titleOfKind(kind: ClaudeItemKind, toolName: string): string {
  switch (kind) {
    case 'command':
      return 'Run command'
    case 'file-change':
      return 'Edit file'
    case 'file-read':
      return 'Read file'
    case 'search':
      return 'Search'
    case 'task':
      return 'Subagent'
    case 'todo':
      return 'Plan'
    default:
      return toolName
  }
}

/**
 * The one line under the heading: the command, the path, the pattern.
 *
 * Deliberately a single line of the tool's own words rather than a summary —
 * what the user is checking is exactly what Claude is about to do, and a
 * paraphrase is the wrong thing to check.
 */
function detailOfTool(toolName: string, input: Record<string, unknown>): string | undefined {
  const text = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  switch (kindOfTool(toolName)) {
    case 'command':
      return text('command')
    case 'file-change':
    case 'file-read':
      return text('file_path') ?? text('notebook_path')
    case 'search':
      return text('pattern') ?? text('query') ?? text('url')
    case 'task':
      return text('description')
    default:
      return text('description')
  }
}

function makeItem(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  agentId?: string
): ClaudeItem {
  const kind = kindOfTool(toolName)
  const detail = detailOfTool(toolName, input)
  return {
    id,
    kind,
    toolName,
    title: titleOfKind(kind, toolName),
    ...(detail ? { detail } : {}),
    input,
    status: 'running',
    ...(agentId ? { agentId } : {})
  }
}

/** The plan out of a `TodoWrite` call, or null if the argument is not one. */
function planFrom(input: Record<string, unknown>): ClaudePlanStep[] | null {
  const todos = input.todos
  if (!Array.isArray(todos)) return null
  const steps: ClaudePlanStep[] = []
  for (const entry of todos) {
    if (typeof entry !== 'object' || entry === null) continue
    const { content, activeForm, status } = entry as Record<string, unknown>
    const step =
      typeof content === 'string' ? content : typeof activeForm === 'string' ? activeForm : null
    if (step === null) continue
    steps.push({
      step,
      status:
        status === 'completed' ? 'completed' : status === 'in_progress' ? 'inProgress' : 'pending'
    })
  }
  return steps.length > 0 ? steps : null
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * The account-wide windows, named as the CLI names them.
 *
 * Both sources of usage — the `get_usage` request answered at start, and the
 * `rate_limit_event` frames that arrive during a turn — key on these, so a
 * mid-turn update lands on the row the first read drew rather than opening a
 * second one beside it.
 */
const WINDOWS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet'
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

/**
 * Usage as the `get_usage` control request reports it: every window at once,
 * already as percentages, with ISO reset times.
 *
 * Returns no windows at all when the session is not on a plan — an API key, or
 * one of the cloud providers — because there are then no limits to draw, which
 * is a different thing from limits that are all at zero.
 */
export function usageFromResponse(response: SDKControlGetUsageResponse): {
  windows: ClaudeUsageWindow[]
  plan: string | null
  credits: ClaudeCredits | null
} {
  const plan = response.subscription_type
  if (!response.rate_limits_available || !response.rate_limits) {
    return { windows: [], plan, credits: null }
  }
  const rates = response.rate_limits
  const limits = rates as Record<
    string,
    { utilization: number | null; resets_at: string | null } | null | undefined
  >
  const windows: ClaudeUsageWindow[] = []
  // The per-model weekly windows the server itself named, when it named any.
  // They supersede the fixed `seven_day_opus` and `seven_day_sonnet` keys: a
  // CLI new enough to send this list sends every model in it, and reading both
  // would draw some models twice.
  const scoped = rates.model_scoped
  for (const [id, label] of Object.entries(WINDOWS)) {
    if (scoped && id !== 'five_hour' && id !== 'seven_day') continue
    const window = limits[id]
    if (!window || typeof window.utilization !== 'number') continue
    windows.push({
      id,
      label,
      usedPercent: clampPercent(window.utilization),
      ...(window.resets_at ? { resetsAt: window.resets_at } : {})
    })
  }
  for (const window of scoped ?? []) {
    if (typeof window.utilization !== 'number') continue
    windows.push({
      // Keyed on the name the server gave, since there is no other id — and the
      // name is what a later read would key on too.
      id: `model:${window.display_name}`,
      label: `Weekly · ${window.display_name}`,
      usedPercent: clampPercent(window.utilization),
      ...(window.resets_at ? { resetsAt: window.resets_at } : {})
    })
  }
  return { windows, plan, credits: creditsFrom(rates.extra_usage) }
}

/**
 * Extra usage, in the currency's own units.
 *
 * The CLI counts credits in minor units — 2001 is $20.01 — and says how many
 * places to shift in a field the SDK's types do not carry. So the field is read
 * defensively and assumed to be two places when it is missing, which is what
 * every currency this is likely to meet uses.
 */
function creditsFrom(
  extra: NonNullable<SDKControlGetUsageResponse['rate_limits']>['extra_usage']
): ClaudeCredits | null {
  if (!extra || !extra.is_enabled || typeof extra.used_credits !== 'number') return null
  const places = (extra as { decimal_places?: number }).decimal_places
  const scale = 10 ** (typeof places === 'number' ? places : 2)
  return {
    usedUsd: extra.used_credits / scale,
    limitUsd: typeof extra.monthly_limit === 'number' ? extra.monthly_limit / scale : null,
    usedPercent: clampPercent(extra.utilization ?? 0),
    currency: extra.currency ?? 'USD'
  }
}

/**
 * The context window, as the `get_context_usage` request reports it.
 *
 * Deferred rows are dropped rather than drawn: they are tool schemas sitting
 * outside the window, and a bar that included them would not add up to the
 * window it is a picture of.
 */
export function contextFromResponse(
  response: SDKControlGetContextUsageResponse
): ClaudeContext | null {
  if (typeof response.totalTokens !== 'number' || typeof response.maxTokens !== 'number') {
    return null
  }
  return {
    usedTokens: response.totalTokens,
    maxTokens: response.maxTokens,
    usedPercent: clampPercent(response.percentage),
    segments: response.categories
      .filter((category) => category.kind !== 'deferred' && category.tokens > 0)
      .map((category) => ({
        name: category.name,
        tokens: category.tokens,
        colour: category.color,
        kind: category.kind as 'used' | 'buffer' | 'free'
      }))
  }
}

/**
 * Usage as a streamed frame reports it: one window, as a fraction, with the
 * reset time in epoch seconds.
 *
 * Undefined when the frame carries no utilization, which is most of them — the
 * CLI leaves it out while a window is comfortably inside its limit. That is why
 * the gauges are drawn from `get_usage` first and only kept up to date here.
 */
export function usageFromEvent(info: SDKRateLimitInfo): ClaudeUsageWindow | undefined {
  const id = info.rateLimitType
  if (!id || typeof info.utilization !== 'number') return undefined
  const label = WINDOWS[id]
  if (!label) return undefined
  const resetsAt =
    typeof info.resetsAt === 'number' && info.resetsAt > 0
      ? new Date(info.resetsAt * 1000).toISOString()
      : undefined
  return {
    id,
    label,
    usedPercent: clampPercent(info.utilization * 100),
    ...(resetsAt ? { resetsAt } : {})
  }
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

/**
 * What a tool result carries, named off the SDK's own user message rather than
 * imported: the block types are the Anthropic API's, and reaching for them by
 * name would pin this file to whichever of the SDK's re-exports happens to be
 * public this release.
 */
type UserContent = Extract<SDKMessage, { type: 'user' }>['message']['content']
type ToolResultContent = Extract<
  Exclude<UserContent, string>[number],
  { type: 'tool_result' }
>['content']

/** A block of prose being streamed, keyed by its index in the message. */
type TextBlock = {
  itemId: string
  kind: 'text' | 'thinking'
}

/** A tool call being streamed, keyed by its index in the message. */
type ToolBlock = {
  item: ClaudeItem
  /** The argument JSON so far. Complete fragments parse; the rest do not. */
  partial: string
  /** The last input actually sent, so an unchanged one is not sent again. */
  fingerprint?: string
}

const parseRecord = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

let itemCounter = 0
const nextItemId = (): string => `block-${(itemCounter += 1)}`

/**
 * Turns one session's SDK messages into events.
 *
 * Stateful, and has to be: a text block arrives as deltas that mean nothing
 * apart, and a tool's arguments arrive as JSON fragments of which only the last
 * parses. One of these belongs to one session and is thrown away with it.
 */
/**
 * How a stream should treat the user's own turns.
 *
 * A live session announces what was typed the moment it is sent, before the CLI
 * has seen it, so its stream ignores the echo that comes back — counting both
 * would draw every turn twice. A transcript read off disk has no such
 * announcement, and the echo is the only record there is.
 */
export type ClaudeStreamOptions = { includeUserTurns: boolean }

export class ClaudeStream {
  private texts = new Map<number, TextBlock>()
  private tools = new Map<number, ToolBlock>()
  /** Tool calls by their id, for matching a result to the call it answers. */
  private inFlight = new Map<string, ClaudeItem>()
  /**
   * Whether the current assistant message arrived as a stream.
   *
   * The assembled message follows the frames that built it, carrying the same
   * text again. When the frames came, the message is used only to settle tool
   * arguments; when they did not — partials off, or a transcript being read
   * back off disk — it is the only copy there is, and the text is emitted from
   * it. One rendering path either way, which is the point.
   */
  private streamed = false

  constructor(private readonly options: ClaudeStreamOptions) {}

  /**
   * Reads one message. Returns the events it means, which is often none.
   *
   * Never throws: a session that emits something unrecognised should cost the
   * user that message, not the tab.
   */
  read(message: SDKMessage): ClaudeEvent[] {
    try {
      return this.dispatch(message)
    } catch (error) {
      console.error('Failed to read a Claude message:', error)
      return []
    }
  }

  private dispatch(message: SDKMessage): ClaudeEvent[] {
    switch (message.type) {
      case 'system':
        return this.readSystem(message)
      case 'stream_event':
        return this.readStream(message)
      case 'assistant':
        return this.readAssistant(message)
      case 'user':
        return this.readUser(message)
      case 'result':
        return this.readResult(message)
      case 'rate_limit_event': {
        const window = usageFromEvent(message.rate_limit_info)
        return window ? [{ type: 'usage', windows: [window] }] : []
      }
      // Arrives after the turn's result rather than as part of it, which is why
      // the session keeps reading past `result` rather than treating it as the
      // end of what a turn produces.
      case 'prompt_suggestion':
        return message.suggestion.trim() === ''
          ? []
          : [{ type: 'suggestion', text: message.suggestion }]
      default:
        return []
    }
  }

  private readSystem(message: Extract<SDKMessage, { type: 'system' }>): ClaudeEvent[] {
    if (message.subtype === 'init') {
      return [
        {
          type: 'session',
          sessionId: message.session_id,
          model: message.model,
          permissionMode: message.permissionMode,
          cwd: message.cwd,
          slashCommands: message.slash_commands,
          version: message.claude_code_version,
          apiKeySource: message.apiKeySource
        }
      ]
    }
    if (message.subtype === 'compact_boundary') {
      return [{ type: 'compacted', trigger: message.compact_metadata.trigger }]
    }
    return []
  }

  /**
   * Reads one streaming frame.
   *
   * Subagent traffic needs splitting rather than dropping: its narration would
   * interleave several agents' voices into the transcript, but its tool blocks
   * and the fragments carrying their arguments have to flow, or the cards drawn
   * under the task come out with nothing in them.
   */
  private readStream(message: Extract<SDKMessage, { type: 'stream_event' }>): ClaudeEvent[] {
    const { event } = message
    const agentId = message.parent_tool_use_id ?? undefined

    if (event.type === 'message_start') {
      this.texts.clear()
      this.tools.clear()
      this.streamed = false
      return []
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block
      const isTool =
        block.type === 'tool_use' ||
        block.type === 'server_tool_use' ||
        block.type === 'mcp_tool_use'
      if (agentId && !isTool) return []
      this.streamed = true

      if (!isTool) {
        if (block.type !== 'text' && block.type !== 'thinking') return []
        const text: TextBlock = {
          itemId: nextItemId(),
          kind: block.type === 'thinking' ? 'thinking' : 'text'
        }
        this.texts.set(event.index, text)
        return []
      }

      const input =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {}
      const item = makeItem(block.id, block.name, input, agentId)
      this.tools.set(event.index, {
        item,
        partial: '',
        ...(Object.keys(input).length > 0 ? { fingerprint: JSON.stringify(input) } : {})
      })
      this.inFlight.set(item.id, item)
      return [{ type: 'item.started', item }]
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        if (agentId) return []
        this.streamed = true
        const text = this.texts.get(event.index)
        const body = delta.type === 'text_delta' ? delta.text : delta.thinking
        if (!text || typeof body !== 'string' || body === '') return []
        return [{ type: 'text.delta', itemId: text.itemId, kind: text.kind, delta: body }]
      }

      if (delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return []
      const tool = this.tools.get(event.index)
      if (!tool) return []

      tool.partial += delta.partial_json
      const input = parseRecord(tool.partial)
      if (!input) return []

      // Only what actually changed is sent on. A long `Write` streams its
      // argument in hundreds of fragments, and every one of them after the
      // first complete parse says the same thing — sending each would fill the
      // bridge with messages that redraw the card identically.
      const fingerprint = JSON.stringify(input)
      if (fingerprint === tool.fingerprint) return []
      tool.fingerprint = fingerprint

      const detail = detailOfTool(tool.item.toolName, input)
      const kind = kindOfTool(tool.item.toolName)
      tool.item = {
        ...tool.item,
        kind,
        title: titleOfKind(kind, tool.item.toolName),
        ...(detail ? { detail } : {}),
        input
      }
      this.inFlight.set(tool.item.id, tool.item)

      const events: ClaudeEvent[] = [{ type: 'item.updated', item: tool.item }]
      const steps = tool.item.kind === 'todo' ? planFrom(input) : null
      if (steps) events.push({ type: 'plan', steps })
      return events
    }

    if (event.type === 'content_block_stop') {
      const text = this.texts.get(event.index)
      if (text) return [{ type: 'text.ended', itemId: text.itemId }]
      return []
    }

    return []
  }

  /**
   * Reads an assembled assistant message.
   *
   * What this does depends entirely on whether the frames that built it came
   * through — see `streamed`. Either way the tool blocks here carry arguments
   * the model finished writing, which is the authoritative copy.
   */
  private readAssistant(message: SDKAssistantMessage): ClaudeEvent[] {
    const agentId = message.parent_tool_use_id ?? undefined
    const events: ClaudeEvent[] = []

    for (const block of message.message.content) {
      if (block.type === 'text' || block.type === 'thinking') {
        // Already on screen, delta by delta.
        if (this.streamed || agentId) continue
        const body = block.type === 'text' ? block.text : block.thinking
        if (typeof body !== 'string' || body === '') continue
        const itemId = nextItemId()
        events.push({
          type: 'text.delta',
          itemId,
          kind: block.type === 'thinking' ? 'thinking' : 'text',
          delta: body
        })
        events.push({ type: 'text.ended', itemId })
        continue
      }

      if (block.type !== 'tool_use' && block.type !== 'server_tool_use') continue
      const input =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {}
      const known = this.inFlight.get(block.id)
      // The arguments the frames already assembled are usually these exactly —
      // this message is the same call, finished. Saying so again would redraw
      // the card to look how it already looks.
      if (known && JSON.stringify(known.input) === JSON.stringify(input)) continue

      const detail = known ? detailOfTool(known.toolName, input) : undefined
      const item = known
        ? { ...known, input, ...(detail ? { detail } : {}) }
        : makeItem(block.id, block.name, input, agentId)
      this.inFlight.set(item.id, item)
      events.push({ type: known ? 'item.updated' : 'item.started', item })

      const steps = item.kind === 'todo' ? planFrom(input) : null
      if (steps) events.push({ type: 'plan', steps })
    }

    this.streamed = false
    return events
  }

  /**
   * Reads a user turn.
   *
   * Three quite different things arrive under the same type. Most of them are
   * tool results riding back in — a result is how a tool call ends, and the
   * call it answers is named by id rather than by position, because parallel
   * calls come back in whatever order they finished. Of the rest, some are what
   * the person actually typed, and some are Claude Code writing to the only
   * role a client is allowed to write in: a background task reporting back, the
   * output of a slash command, the summary of a compacted conversation. What
   * tells those apart is `readTurn`.
   *
   * The live session announces what was typed itself, at the moment it sends it
   * (see `sendToClaude`), so the spoken half of this does nothing there — the
   * turn is already on screen before the CLI has seen it. It earns its place
   * when a transcript is read back off disk, where this is the only record that
   * the user said anything at all. Without it a restored conversation is one
   * side of itself. The asides are emitted either way, bar the ones that are
   * that same echo in another form: nothing else announces a task reporting
   * back, and a task that finished is news in a live conversation too.
   */
  private readUser(message: Extract<SDKMessage, { type: 'user' }>): ClaudeEvent[] {
    const content = message.message.content
    const results = this.readToolResults(content)
    if ((message as { isSynthetic?: boolean }).isSynthetic === true) return results

    const blocks =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : []

    const events: ClaudeEvent[] = []
    for (const block of blocks) {
      for (const part of readTurn(block)) {
        if (part.kind === 'aside') {
          if (part.echo === true && !this.options.includeUserTurns) continue
          events.push({ type: 'aside', itemId: nextItemId(), aside: part.aside })
        } else if (this.options.includeUserTurns) {
          events.push({ type: 'user', itemId: nextItemId(), text: part.text })
        }
      }
    }

    // Ahead of the results, because a turn that both answers a tool and says
    // something was typed before either happened.
    return [...events, ...results]
  }

  /** The half of a user turn that ends tool calls, which every path wants. */
  private readToolResults(content: UserContent): ClaudeEvent[] {
    if (typeof content === 'string' || !Array.isArray(content)) return []
    const events: ClaudeEvent[] = []
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const item = this.inFlight.get(block.tool_use_id)
      if (!item) continue
      this.inFlight.delete(block.tool_use_id)

      const output = textOfResult(block.content)
      events.push({
        type: 'item.completed',
        item: {
          ...item,
          status: block.is_error === true ? 'error' : 'ok',
          ...(output ? { output } : {})
        }
      })
    }
    return events
  }

  private readResult(message: Extract<SDKMessage, { type: 'result' }>): ClaudeEvent[] {
    return [
      {
        type: 'turn.completed',
        subtype: message.subtype,
        ...(typeof message.total_cost_usd === 'number' ? { costUsd: message.total_cost_usd } : {}),
        ...(message.usage
          ? {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens
            }
          : {})
      }
    ]
  }
}

/**
 * What a tool printed, flattened to text.
 *
 * A result's content is either a string or a list of blocks of which only the
 * text ones can be shown here; an image a tool returned is dropped rather than
 * described, because a card that says `[image]` is worse than one that says
 * nothing.
 */
function textOfResult(content: ToolResultContent): string | undefined {
  if (typeof content === 'string') return content === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    if (entry.type === 'text' && entry.text !== '') parts.push(entry.text)
  }
  const joined = parts.join('\n')
  return joined === '' ? undefined : joined
}

export const makeClaudeStream = (options: ClaudeStreamOptions): ClaudeStream =>
  new ClaudeStream(options)
