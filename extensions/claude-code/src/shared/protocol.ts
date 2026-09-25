import type { ClaudeDecision, ClaudeEvent } from '../main/events'
import type { ClaudeEffort, ClaudePermissionMode } from './tab'

/**
 * What crosses between a session, in the extension's main half, and the view
 * that draws it.
 *
 * Two channels, for two kinds of traffic. What the session says goes over the
 * view's connection (see `ViewConnection` in the SDK), because it is a stream
 * the view did not ask for: text arriving, a tool starting, a card waiting on
 * an answer. What the user does goes the other way as the extension's own RPC
 * methods, because each of those is a question with an answer — did the model
 * change, what would reverting touch — and RPC already carries the answer and
 * any refusal back.
 *
 * @module protocol
 */

// ---------------------------------------------------------------------------
// Over the connection
// ---------------------------------------------------------------------------

/**
 * What a view posts once it is listening: the one message it sends. The main
 * half says nothing until it arrives, so nothing it says can reach a page that
 * is not ready to draw it.
 */
export type ClaudeFromView = { type: 'attach' }

/**
 * What a view is told when it attaches: the conversation so far, and whether
 * the session is still there to add to it.
 */
export type ClaudeSnapshot = {
  type: 'snapshot'
  replay: ClaudeEvent[]
  /** How the session ended, if it has: `error` is null when it simply stopped. */
  exit: { error: string | null } | null
  /**
   * Whether a turn is in flight right now.
   *
   * Sent rather than left for the view to infer. A view can only guess from
   * the events it has — and the two cases look identical from there: a
   * conversation restored from disk ends mid-turn because the transcript
   * simply stops, where a live session attached to mid-turn ends the same way
   * because the turn has not finished. Guessing wrong leaves the composer stuck
   * showing a stop button for a session that is idle.
   */
  running: boolean
  /** Whether the model's thinking is drawn. One preference for every tab. */
  thinking: boolean
}

export type ClaudeToView =
  | ClaudeSnapshot
  /**
   * The session could not start, for a reason the view cannot do anything
   * about — the CLI is not installed, or the user is not signed in. Shown as is.
   */
  | { type: 'failure'; message: string }
  /** Events since the last batch, coalesced across a frame. */
  | { type: 'events'; events: ClaudeEvent[] }
  /** The session stopped on its own. `error` is null when it simply ended. */
  | { type: 'exit'; error: string | null }
  /** Thinking was shown or hidden, in some tab; every tab follows. */
  | { type: 'thinking'; show: boolean }

// ---------------------------------------------------------------------------
// Over RPC
// ---------------------------------------------------------------------------

/** A file dropped or pasted into the composer, as base64. */
export type ClaudeUpload = { name: string; data: string }

/** One row of the model picker. */
export type ClaudeModel = {
  /** The alias to ask for — `default`, `opus[1m]`, `sonnet`. */
  id: string
  /**
   * The model, named the way somebody would say it: `Opus 5`, `Haiku 4.5`.
   *
   * Not the CLI's own `displayName`, which names the *alias* — "Default
   * (recommended)", "Opus (1M context)" — and so answers a question the picker
   * does not ask. Which model a row runs is the question, and the row's place
   * in the list already says which one is recommended.
   */
  label: string
  /**
   * What that alias currently resolves to, which is what a running session
   * reports as its model.
   *
   * The two are different vocabularies and have to be matched up somewhere: a
   * session started on `default` says it is running `claude-opus-5[1m]`, and a
   * picker listing aliases has no option with that value. This is the bridge.
   */
  resolved: string
  description: string
  /**
   * Whether a thinking level means anything for this model. The picker greys
   * itself out rather than offering a choice the CLI would ignore.
   */
  supportsEffort: boolean
}

/** What reverting a turn did, for the view to report. */
export type ClaudeRevert = {
  ok: boolean
  /** Why not, when the CLI refused — no checkpoint for that turn, mostly. */
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/**
 * The extension's RPC methods, by name, with what each takes and answers.
 * Every one but the preference names the tab it is about.
 */
export type ClaudeMethods = {
  'session.send': {
    input: { tabId: string; text: string; attachments: ClaudeUpload[] }
    output: void
  }
  'session.interrupt': { input: { tabId: string }; output: void }
  'session.respond': {
    input: { tabId: string; requestId: string; decision: ClaudeDecision }
    output: void
  }
  'session.answer': {
    input: { tabId: string; requestId: string; answers: Record<string, string> | null }
    output: void
  }
  'session.models': { input: { tabId: string }; output: ClaudeModel[] }
  'session.setModel': { input: { tabId: string; model: string }; output: void }
  'session.setEffort': { input: { tabId: string; effort: ClaudeEffort }; output: void }
  'session.setMode': { input: { tabId: string; mode: ClaudePermissionMode }; output: void }
  'session.rename': { input: { tabId: string; title: string }; output: void }
  'session.revert': {
    input: { tabId: string; uuid: string; dryRun: boolean }
    output: ClaudeRevert
  }
  /**
   * Branches the conversation at a turn into a tab of its own, beside this
   * one, with `draft` waiting in its composer. Answers with why not, or null.
   */
  'session.fork': { input: { tabId: string; uuid: string; draft: string }; output: string | null }
  'thinking.set': { input: { show: boolean }; output: void }
}

export type ClaudeMethod = keyof ClaudeMethods
