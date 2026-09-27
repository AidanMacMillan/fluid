/**
 * What kind of thing a tool call is, as far as drawing it goes.
 *
 * Coarser than the tool list on purpose: a pane wants to know whether to draw a
 * diff, a scrollback or a one-line chip, and there are far fewer answers to
 * that than there are tools. Anything unrecognised is a `tool`, which draws as
 * a collapsible card — so a tool added to the agent next month appears as
 * itself rather than as a gap.
 */
export type AgentItemKind =
  'command' | 'file-change' | 'file-read' | 'search' | 'task' | 'todo' | 'tool'

/** How a tool call ended, or that it has not. */
export type AgentItemStatus = 'running' | 'ok' | 'error'

/**
 * One tool call, as the transcript holds it.
 *
 * Sent whole on every change rather than as a patch. A tool call is small and
 * changes a handful of times, and a pane that is handed the current state has
 * nothing to get wrong — where a pane applying patches has to be right about
 * every one of them, including the ones it missed while the tab was closed.
 */
export type AgentItem = {
  /** The tool-use id. Stable from the moment the call starts. */
  id: string
  kind: AgentItemKind
  toolName: string
  /** What to call this in a heading: `Run command`, `Edit file`. */
  title: string
  /** The one line under it — the command, the path. Absent until the input parses. */
  detail?: string
  /**
   * The tool's arguments, as far as they have been read.
   *
   * Empty while the model is still writing them: inputs stream as JSON
   * fragments and only a complete fragment parses. See `AgentStream.read`.
   */
  input: Record<string, unknown>
  status: AgentItemStatus
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
export type AgentPlanStep = {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

/**
 * One of the plan's usage windows — five hours, a week — as a gauge.
 *
 * `usedPercent` is 0–100 whichever source filled it in; the two the CLI offers
 * disagree about that and are reconciled on the way in. See `usageFromResponse`.
 */
export type AgentUsageWindow = {
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
export type AgentCredits = {
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
export type AgentContext = {
  usedTokens: number
  /** The window the usage is measured against. */
  maxTokens: number
  usedPercent: number
  segments: { name: string; tokens: number; colour: string; kind: 'used' | 'buffer' | 'free' }[]
}

/** A question the model asked, from the `AskUserQuestion` tool. */
export type AgentQuestion = {
  id?: string
  secret?: boolean
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
export type AgentApproval = {
  requestId: string
  toolUseId: string
  toolName: string
  kind: AgentItemKind
  /** The CLI's own sentence: "Agent wants to read foo.txt". */
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
 * the agent writes turns of its own into the transcript and gives them the
 * user's role, because the user's role is the only one a client may write in:
 * a background task reporting back, the output of a slash command, the note it
 * leaves itself when a conversation is summarised. They are addressed to the
 * model, not to the reader, and drawn as a quiet line rather than as a bubble
 * the user never typed. See ./turns.ts for how they are told
 * apart from the person speaking.
 */
export type AgentAside = {
  kind: 'task' | 'command' | 'skill' | 'output' | 'interrupted' | 'summary' | 'image'
  /** One line, always drawn. */
  label: string
  /** The rest of it, folded away behind the label. */
  detail?: string
}

/** What the user did with an approval card. */
export type AgentDecision = 'once' | 'always' | 'deny' | 'cancel'

export type AgentEvent =
  | { type: 'user.removed'; itemId: string }
  | { type: 'running'; running: boolean }
  | { type: 'text.set'; itemId: string; kind: 'text' | 'thinking'; text: string }
  | { type: 'user.anchor'; itemId: string; uuid: string }
  /**
   * The session is up. Everything here is settled at start and answers the
   * questions the chrome asks before the first turn — which model, which mode,
   * which commands exist.
   */
  | {
      type: 'session'
      sessionId: string
      model: string
      permissionMode: string
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
       * the agent's own id for this turn in the transcript.
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
  /** Something the harness did. See `AgentAside`. */
  | { type: 'aside'; itemId: string; aside: AgentAside }
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
  | { type: 'item.started'; item: AgentItem }
  | { type: 'item.updated'; item: AgentItem }
  | { type: 'item.completed'; item: AgentItem }
  | { type: 'plan'; steps: AgentPlanStep[] }
  /** A plan the model proposed and is waiting on; see the note in ./sessions.ts. */
  | { type: 'proposal'; markdown: string }
  | { type: 'approval.opened'; approval: AgentApproval }
  | { type: 'approval.resolved'; requestId: string; decision: AgentDecision }
  | {
      type: 'question.opened'
      requestId: string
      questions: AgentQuestion[]
      responseMode?: 'blocking' | 'message'
    }
  | { type: 'question.resolved'; requestId: string }
  /**
   * What the conversation is called.
   *
   * the agent names a session itself once it has enough of one to name, and
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
      windows: AgentUsageWindow[]
      plan?: string | null
      credits?: AgentCredits | null
    }
  /** How full the context window is. Re-read after every turn. */
  | { type: 'context'; context: AgentContext }
  /**
   * What the agent guesses you will say next, offered in the empty composer.
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
