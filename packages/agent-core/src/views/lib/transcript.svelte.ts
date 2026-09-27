import type {
  AgentApproval,
  AgentAside,
  AgentEvent,
  AgentItem,
  AgentPlanStep,
  AgentQuestion,
  AgentContext,
  AgentCredits,
  AgentUsageWindow
} from '../../shared/events'

/**
 * An agent conversation, as the view draws it.
 *
 * The session sends events — text arrived, a tool started, a turn ended — and
 * this folds them into the thing on screen. It is a class of its own rather
 * than state inside the pane because the fold is the part worth being sure
 * about, and it is easier to be sure about a thing with no markup in it.
 *
 * Holds no connection. Events arrive by being handed to `apply`, wherever they
 * came from — the live session, or a replay of one that was running while no
 * view was drawing it. The two are the same events in the same order, which is the whole
 * reason a restored conversation needs no second code path.
 *
 * @module transcript
 */

/** One thing in the transcript, in the order it happened. */
export type AgentEntry =
  /**
   * `at` is when this arrived here, not when the model wrote it. For a live
   * conversation those are the same thing; for one read back off disk it is
   * when it was read, which is why a restored turn says "just now". The
   * transcript on disk carries no timestamps to do better with.
   */
  | {
      kind: 'user'
      id: string
      at: number
      text: string
      uuid?: string
      /** Files that went with the turn, drawn above it. See the event. */
      attachments?: { name: string; key: string }[]
    }
  | {
      kind: 'text'
      id: string
      at: number
      /** Thinking is drawn quieter, and folded away; otherwise they are the same. */
      thinking: boolean
      text: string
      /** False while the model is still adding to it. */
      done: boolean
    }
  | { kind: 'item'; id: string; item: AgentItem }
  /** A plan the model proposed and stopped on, waiting to be told what to do. */
  | { kind: 'proposal'; id: string; markdown: string }
  /**
   * Something the harness did between the turns — a background task reporting
   * back, a slash command's output. Drawn as a line, not as a turn: see the
   * type for why these arrive wearing the user's role.
   */
  | { kind: 'aside'; id: string; at: number; aside: AgentAside }
  | { kind: 'compacted'; id: string; trigger: 'manual' | 'auto' }
  | { kind: 'notice'; id: string; level: 'warning' | 'error'; message: string }

/** What the session said about itself when it started. */
export type AgentSession = {
  sessionId: string
  model: string
  permissionMode: string
  cwd: string
  slashCommands: string[]
  version: string
  apiKeySource: string
}

export class AgentTranscript {
  /** Everything said so far, oldest first. */
  entries = $state<AgentEntry[]>([])
  session = $state<AgentSession | null>(null)
  /**
   * What the conversation is called: the agent's own summary of it, or the
   * name the user gave it. Null until there is enough of a conversation for the
   * CLI to have named one, which is the tab's cue to fall back to its folder.
   */
  title = $state<string | null>(null)
  /** The model's plan, when it has written one. Drawn in a panel, not inline. */
  plan = $state<AgentPlanStep[]>([])
  usage = $state<AgentUsageWindow[]>([])
  /**
   * What the account is on — `team`, `max` — or null off a plan. Not `plan`,
   * which above is the model's list of steps.
   */
  subscription = $state<string | null>(null)
  /** Extra usage spend, when the account has any. */
  credits = $state<AgentCredits | null>(null)
  /** How full the model's context window is. Null until the session has said. */
  context = $state<AgentContext | null>(null)
  /** The approval waiting on the user, if any. At most one is ever open. */
  approvals = $state<AgentApproval[]>([])
  get approval(): AgentApproval | null {
    return this.approvals[0] ?? null
  }
  /** The model's questions, waiting on the user. */
  questions = $state<
    { requestId: string; questions: AgentQuestion[]; responseMode?: 'blocking' | 'message' }[]
  >([])
  get question(): {
    requestId: string
    questions: AgentQuestion[]
    responseMode?: 'blocking' | 'message'
  } | null {
    return this.questions[0] ?? null
  }
  /** Whether the model is working. Drives the composer's send-or-stop button. */
  running = $state(false)
  /** What the last turn cost, cumulative for the session. */
  costUsd = $state<number | null>(null)
  /**
   * When the turn in flight started, so the footer can count up.
   *
   * Taken from the user's own turn rather than from the first thing the model
   * said, because the wait the reader is measuring starts when they pressed
   * send, not when the answer began.
   */
  startedAt = $state<number | null>(null)
  /** How the last turn went, for the line under it. Cleared when a new one starts. */
  lastTurn = $state<{ ms: number; outputTokens?: number } | null>(null)
  /** Set when the session has stopped; the pane draws a notice and stops sending. */
  stopped = $state<string | null>(null)
  /**
   * What the agent thinks the next thing to ask is, offered in the empty
   * composer until the turn it was a guess about stops being the last one.
   */
  suggestion = $state<string | null>(null)

  /**
   * Where to find things that are still changing: a text block a delta has to
   * grow, a tool card a result has to close. Id to its index in `entries`.
   *
   * Plain records rather than reactive maps on purpose. Nothing draws these —
   * they only say where in `entries` to look, and `entries` is the reactive
   * thing. A reactive map here would invalidate the transcript on every
   * bookkeeping write, which is every delta.
   */
  private open: Record<string, number> = {}
  private cards: Record<string, number> = {}

  /**
   * The turn a revert or a fork at `index` would name.
   *
   * Both operations anchor to a user turn, because that is what the agent
   * keeps a checkpoint against. Reverting an answer means reverting to just
   * before the question that provoked it, so an assistant entry looks backwards
   * for the turn it belongs to; a user entry is its own answer.
   */
  anchorFor(index: number): { uuid: string; text: string } | undefined {
    for (let at = index; at >= 0; at -= 1) {
      const entry = this.entries[at]
      if (entry?.kind !== 'user') continue
      // The words come back with the id because forking hands them to the new
      // tab's composer: a branch taken to ask something differently should open
      // with the old wording in front of you, not a blank box and a memory.
      return entry.uuid ? { uuid: entry.uuid, text: entry.text } : undefined
    }
    return undefined
  }

  reset(): void {
    this.entries = []
    this.session = null
    this.title = null
    this.plan = []
    this.usage = []
    this.subscription = null
    this.credits = null
    this.context = null
    this.approvals = []
    this.questions = []
    this.running = false
    this.costUsd = null
    this.startedAt = null
    this.lastTurn = null
    this.stopped = null
    this.suggestion = null
    this.open = {}
    this.cards = {}
  }

  apply(events: AgentEvent[]): void {
    for (const event of events) this.one(event)
  }

  private one(event: AgentEvent): void {
    switch (event.type) {
      case 'user.removed': {
        this.entries = this.entries.filter((e) => e.id !== event.itemId)
        this.open = {}
        this.cards = {}
        return
      }
      case 'running':
        this.running = event.running
        return
      case 'user.anchor': {
        const entry = this.entries.find((e) => e.id === event.itemId)
        if (entry?.kind === 'user') entry.uuid = event.uuid
        return
      }
      case 'text.set': {
        const entry = this.entries.find((e) => e.id === event.itemId)
        if (entry?.kind === 'text') {
          entry.text = event.text
          entry.done = true
        } else
          this.entries.push({
            kind: 'text',
            id: event.itemId,
            at: Date.now(),
            thinking: event.kind === 'thinking',
            text: event.text,
            done: true
          })
        delete this.open[event.itemId]
        return
      }
      case 'session':
        this.session = {
          sessionId: event.sessionId,
          model: event.model,
          permissionMode: event.permissionMode,
          cwd: event.cwd,
          slashCommands: event.slashCommands,
          version: event.version,
          apiKeySource: event.apiKeySource
        }
        return

      case 'user':
        if (this.entries.some((e) => e.id === event.itemId)) return
        this.entries.push({
          kind: 'user',
          id: event.itemId,
          at: Date.now(),
          text: event.text,
          ...(event.uuid ? { uuid: event.uuid } : {}),
          ...(event.attachments ? { attachments: event.attachments } : {})
        })
        this.running = true
        this.startedAt = Date.now()
        this.lastTurn = null
        // Whatever was guessed about the last turn is about the last turn. The
        // next guess arrives when this one is answered, or does not.
        this.suggestion = null
        return

      case 'aside':
        this.entries.push({
          kind: 'aside',
          id: event.itemId,
          at: Date.now(),
          aside: event.aside
        })
        return

      case 'turn.completed':
        this.running = false
        if (this.startedAt !== null) {
          this.lastTurn = {
            ms: Date.now() - this.startedAt,
            ...(typeof event.outputTokens === 'number' ? { outputTokens: event.outputTokens } : {})
          }
          this.startedAt = null
        }
        if (typeof event.costUsd === 'number') this.costUsd = event.costUsd
        if (event.subtype !== 'success' && event.subtype !== 'interrupted') {
          this.entries.push({
            kind: 'notice',
            id: `notice-${this.entries.length}`,
            level: 'error',
            message: noticeFor(event.subtype)
          })
        }
        // A turn that ended takes its unanswered questions with it: the session
        // is no longer parked on them, so a card left on screen would be one
        // the user could click to no effect.
        this.approvals = []
        this.questions = this.questions.filter((q) => q.responseMode === 'message')
        for (const entry of this.entries) {
          if (entry.kind === 'text') entry.done = true
        }
        this.open = {}
        return

      case 'text.delta': {
        const at = this.open[event.itemId] ?? this.entries.findIndex((e) => e.id === event.itemId)
        const existing = at === undefined ? undefined : this.entries[at]
        if (existing?.kind === 'text') {
          this.open[event.itemId] = at
          existing.done = false
          existing.text += event.delta
          return
        }
        this.open[event.itemId] = this.entries.length
        this.entries.push({
          kind: 'text',
          id: event.itemId,
          at: Date.now(),
          thinking: event.kind === 'thinking',
          text: event.delta,
          done: false
        })
        this.running = true
        return
      }

      case 'text.ended': {
        const at = this.open[event.itemId]
        const entry = at === undefined ? undefined : this.entries[at]
        if (entry?.kind === 'text') entry.done = true
        delete this.open[event.itemId]
        return
      }

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const at =
          this.cards[event.item.id] ?? this.entries.findIndex((e) => e.id === event.item.id)
        const entry = at === undefined ? undefined : this.entries[at]
        if (entry?.kind === 'item') {
          entry.item = event.item
        } else {
          // A result for a call this transcript never saw start — a replay that
          // lost its opening to the buffer's cap. Drawn as itself rather than
          // dropped: a finished tool call is still worth seeing.
          this.cards[event.item.id] = this.entries.length
          this.entries.push({ kind: 'item', id: event.item.id, item: event.item })
        }
        if (event.type === 'item.started') this.running = true
        return
      }

      case 'plan':
        this.plan = event.steps
        return

      case 'proposal':
        this.entries.push({
          kind: 'proposal',
          id: `proposal-${this.entries.length}`,
          markdown: event.markdown
        })
        return

      case 'approval.opened':
        this.approvals = [
          ...this.approvals.filter((a) => a.requestId !== event.approval.requestId),
          event.approval
        ]
        return

      case 'approval.resolved':
        this.approvals = this.approvals.filter((a) => a.requestId !== event.requestId)
        return

      case 'question.opened':
        this.questions = [
          ...this.questions.filter((q) => q.requestId !== event.requestId),
          {
            requestId: event.requestId,
            questions: event.questions,
            responseMode: event.responseMode
          }
        ]
        return

      case 'question.resolved':
        this.questions = this.questions.filter((q) => q.requestId !== event.requestId)
        return

      case 'title':
        this.title = event.title
        return

      case 'usage':
        this.usage = merge(this.usage, event.windows)
        // Only the full read carries these; a streamed update of one window
        // says nothing about them and must not clear them. See the event.
        if (event.plan !== undefined) this.subscription = event.plan
        if (event.credits !== undefined) this.credits = event.credits
        return

      case 'context':
        this.context = event.context
        return

      case 'suggestion':
        this.suggestion = event.text
        return

      case 'compacted':
        this.entries.push({
          kind: 'compacted',
          id: `compacted-${this.entries.length}`,
          trigger: event.trigger
        })
        return

      case 'notice':
        this.entries.push({
          kind: 'notice',
          id: `notice-${this.entries.length}`,
          level: event.level,
          message: event.message
        })
        return
    }
  }
}

/**
 * Folds new gauge readings into the ones on screen.
 *
 * By id rather than by replacing the list, because the two sources disagree
 * about how much they know: the reading taken at the start of a session has
 * every window in it, and the ones that arrive during a turn have one. A
 * replacement would leave a single window on screen and the rest blank.
 */
function merge(current: AgentUsageWindow[], incoming: AgentUsageWindow[]): AgentUsageWindow[] {
  const merged = current.map(
    (window) => incoming.find((update) => update.id === window.id) ?? window
  )
  const added = incoming.filter((update) => !current.some((window) => window.id === update.id))
  return [...merged, ...added]
}

/** What to say about a turn that did not end well. */
function noticeFor(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Agent stopped after reaching the turn limit for this request.'
    case 'error_max_budget_usd':
      return 'Agent stopped after reaching the spending limit for this request.'
    case 'error_during_execution':
      return 'The turn ended with an error.'
    default:
      return `The turn ended: ${subtype}.`
  }
}
