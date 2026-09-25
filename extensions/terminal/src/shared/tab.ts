import type { ExtensionTab, Tab } from '@fluid/sdk'

/**
 * The one tab type the extension contributes, and what its two halves say to
 * each other, shared by all three.
 *
 * @module tab
 */

/** The tab type a terminal is stored under. */
export const TERMINAL_TAB = 'terminal.shell'

export type TerminalTabPayload = {
  /**
   * Where the shell is. Set when the tab is made, and kept up to date from
   * there: shells report every `cd` with an escape sequence of their own, and
   * the tab follows it (see ../main/sessions.ts). So this is the working directory
   * rather than the starting one — which is what a tab restored on the next
   * launch should open in, and what its row in the sidebar is named after.
   *
   * A shell that reports nothing simply leaves this at wherever it began.
   */
  cwd: string
  /** The shell to run; absent means whatever the user's login shell is. */
  shell?: string
  /**
   * A command typed into the shell each time it starts — when the tab is
   * opened, and again when it is restored after a relaunch — as the user
   * would have typed it.
   */
  command?: string
  /**
   * A command typed into the shell once, when it first starts, and then taken
   * off the tab — so unlike `command`, a tab restored after a relaunch, or
   * reopened after its task settled, starts at a prompt rather than doing it
   * again. For a command somebody typed to run now: `git push`, say.
   */
  run?: string
  /**
   * The command line the shell is running, while it runs — `pnpm dev` — which
   * is what the row says in place of the folder, the way a terminal
   * emulator's tab does. Absent at the prompt, and for a shell that does not
   * report its commands (see ../main/integration.ts).
   */
  running?: string
}

export type TerminalTab = ExtensionTab<typeof TERMINAL_TAB, TerminalTabPayload, null>

export function isTerminalTab(tab: Tab): tab is TerminalTab {
  return tab.type === TERMINAL_TAB
}

/** The last part of a path, which is what the folder is called. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name === '' ? '/' : name
}

/**
 * What a view says to its main half. The view connects, measures itself and
 * asks to `open`; from then on it is keystrokes and sizes.
 */
export type ViewMessage =
  | { type: 'open'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/**
 * What the main half says back. `ready` answers `open` with everything the
 * shell has printed that is still held, and only after it is sent does output
 * start to follow — both go down the same channel, in order, so a chunk can
 * never arrive both inside the replay and after it.
 *
 * `failed` is the one case the view cannot do anything about — the native
 * module failed to load, or the shell could not be spawned — and the message
 * is shown as is.
 */
export type MainMessage =
  | { type: 'ready'; replay: string }
  | { type: 'output'; data: string }
  | { type: 'failed'; message: string }
