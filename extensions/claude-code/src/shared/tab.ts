import type { ExtensionTab, Tab } from '@fluid/sdk'

/**
 * The one tab type the extension contributes, shared by all three halves.
 *
 * @module tab
 */

/** The tab type a Claude Code session is stored under. */
export const CLAUDE_TAB = 'claude-code.session'

/** Thinking level, as Claude Code names it. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

/**
 * The modes worth offering, in order of how much rope they give.
 *
 * The CLI has one more, `dontAsk`, which is left out: it turns every prompt
 * into a refusal without asking anyone, which is what a headless agent wants
 * and the opposite of what a tab is for — a tab has a user sitting in front of
 * it, and the whole point of the cards is that they can answer.
 */
export const CLAUDE_MODES = ['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'] as const
export type ClaudePermissionMode = (typeof CLAUDE_MODES)[number]

/**
 * What a tab runs in until somebody says otherwise.
 *
 * `auto` rather than the CLI's own `default`, because a tab is watched: the
 * easy calls are made for the user and the rest still arrive as cards they can
 * answer, which is the trade a pane in front of somebody wants and the reason
 * the mode exists. The picker falls back to the same, so a tab that has never
 * been set shows the mode it is actually in.
 */
export const CLAUDE_DEFAULT_MODE: ClaudePermissionMode = 'auto'

/** What a tab thinks at until somebody says otherwise. The picker falls back to it too. */
export const CLAUDE_DEFAULT_EFFORT: ClaudeEffort = 'high'

/**
 * A Claude Code session, in a tab rather than a terminal.
 *
 * Everything here is the session's own answer to a question asked once and then
 * kept, because all four of them outlive the app being closed: which folder the
 * conversation is about, which conversation it is, and how the user had the
 * controls set when they last looked at it.
 */
export type ClaudeTabPayload = {
  /**
   * The folder the session runs in. Asked for when the tab is made — the same
   * folder a new terminal starts in — and fixed from there: a session's working
   * directory is settled when its process starts, so unlike a terminal's there
   * is nothing later that could change it.
   */
  cwd: string
  /**
   * Claude Code's own id for the conversation, once it has said what it is.
   *
   * This is the whole of what makes a tab survive a restart. The transcript is
   * not written down here — Claude Code already keeps it, under
   * `~/.claude/projects`, and a second copy would only be a worse one that
   * drifts. What this tab has to remember is which of those to pick up.
   */
  sessionId?: string
  /**
   * A first turn to send as soon as the session starts, for a tab opened with a
   * question already asked (Ask Claude, in the new-task panel). Cleared once
   * the conversation exists, so a restarted tab resumes it rather than asking
   * again.
   */
  prompt?: string
  /** What the user last set the controls to. Absent means the defaults above. */
  model?: string
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
}

/**
 * A turn half typed, held because it is written a keystroke at a time and
 * losing it loses the sentence rather than the tab.
 *
 * Deliberately not where the conversation lives. The transcript is Claude
 * Code's own (see `ClaudeTabPayload.sessionId`); this is only the part of it
 * that has not been said yet, and so is not anywhere else.
 */
export type ClaudeViewState = {
  draft: string
}

export type ClaudeTab = ExtensionTab<typeof CLAUDE_TAB, ClaudeTabPayload, ClaudeViewState>

export function isClaudeTab(tab: Tab): tab is ClaudeTab {
  return tab.type === CLAUDE_TAB
}

/** The last part of a path, which is what the folder is called. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name === '' ? '/' : name
}
