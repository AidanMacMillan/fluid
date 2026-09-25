import type { LauncherChoice } from '../../../main/launcher-window'

/**
 * The things a new tab can be that are not somewhere to go.
 *
 * The launcher is mostly an address bar: a bookmark or something typed, and
 * either way a page. A terminal, a Claude Code session or an editor has no
 * address at all, so it cannot be offered as one more row in that list — it
 * belongs below the line, as a different answer to the same question. Every
 * one of those is an extension's launcher entry now (see `LauncherEntry` in
 * the SDK); what is here is the shape the panel draws them in.
 *
 * Kept separate from the bookmarks for that reason rather than for tidiness: the
 * two are filtered by the same field and drawn in the same list, and the only
 * thing that tells them apart is which side of the divider they fall on.
 */

/**
 * A second step the panel can show instead of answering straight away: one of
 * an extension's launcher entries, named `extensionId.entryId`, asking for the
 * one line it needs (a link, say, which there is no way to guess from a
 * name). The same panel, the same field, asking a narrower question.
 */
export type LauncherPrompt = string

export type LauncherOutcome =
  | { kind: 'choice'; choice: LauncherChoice }
  | { kind: 'prompt'; prompt: LauncherPrompt }
  /**
   * An extension's entry, with what was typed already read by it: taking the
   * row asks the extension for the tab (see `LauncherEntry.open`) and opens it.
   */
  | { kind: 'extension'; prompt: LauncherPrompt; value: unknown }
  /**
   * An extension's entry that asks for nothing (see `LauncherActionEntry`):
   * taking the row asks the extension for the tab straight away. Named the way
   * a prompt is, `extensionId.entryId`.
   */
  | { kind: 'extension-action'; entry: string }
  /**
   * A new-task entry offered for whatever was typed (see `NewTaskTypedEntry`):
   * taking the row hands the extension the text and starts the task it answers
   * with. Named the way a prompt is, `extensionId.entryId`.
   */
  | { kind: 'typed'; entry: string; text: string }

export type LauncherAction = {
  /** Stable, and what a stored ordering would name later. */
  id: string
  label: string
  /** The dimmer half of the row: what choosing it will do. */
  detail: string
  /** An Iconify class — see `@iconify/tailwind4` in src/renderer/src/assets/main.css. */
  icon: string
  /** What happens when this row is taken: an answer, or a question. */
  outcome: LauncherOutcome
  /** Extra words that should find this row, beyond its label. */
  keywords?: string[]
}
