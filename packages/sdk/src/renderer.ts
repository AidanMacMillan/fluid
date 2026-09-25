import type { NewTab } from './api'
import type { Client } from './client'
import type { Tab, TaskFact } from './models'
import type { TaskColor, TaskIcon } from './task-icons'

/**
 * The half of an extension that runs in the app's windows: how its tab types
 * are drawn, and what it adds to the new-tab and new-task launchers. Its
 * section of the settings window is drawn by its views instead (see
 * `ExtensionViews.settings`).
 *
 * Kept apart from `Extension` because the two halves run in different
 * processes. This one talks to the workspace through `host.api`, and to its
 * own main-process half through `host.call`, which reaches the methods it
 * registered with `ctx.rpc`.
 *
 * `Component` is whatever the app draws with (Svelte, today); the SDK only
 * carries it.
 */

/** What the app gives an extension's renderer code. */
export type RendererHost = {
  /** The workspace, as the window sees it. */
  api: Client
  /** Calls one of the extension's own `ctx.rpc` methods. */
  call<T = unknown>(method: string, input?: unknown): Promise<T>
  /** Opens a link the way a click in a page would: in a tab, or in the pinned tab it belongs to. */
  openLink(url: string): void
  /**
   * Remembers how a tab was left looking. Written after a short pause, so it
   * can be called on every keystroke.
   */
  setViewState(tabId: string, viewState: unknown): void
  /** Writes any view state still waiting out its pause. */
  flushViewState(tabId: string): void
  /** The sentence to show for a failed call, without the transport's framing. */
  reasonFrom(error: unknown): string
  /** Opens the app's settings window. */
  openSettings(): void
  /**
   * Asks the user for a folder with the OS picker, over whichever window the
   * code is running in. Null when they dismissed it.
   */
  chooseFolder(options?: FolderPickerOptions): Promise<string | null>
}

export type FolderPickerOptions = {
  /** The picker's title, where the OS shows one. */
  title?: string
  /** What the confirming button says. Defaults to the OS's own. */
  buttonLabel?: string
}

/**
 * How one of the extension's tab types is drawn, and how its row in the strip
 * reads. A type registered with a `view` is drawn by its `ExtensionView`
 * instead, and has no `pane` here.
 */
export type TabView<Component = unknown> = {
  /** Drawn in the content area. Receives `{ tab, host }`. */
  pane?: Component
  /** An Iconify class for the tab's row, e.g. `icon-[logos--slack-icon]`. */
  icon?: string
  /** What the row says, when the tab has no title of its own. */
  label?: (tab: Tab) => string | null
  /** The row's tooltip. */
  tooltip?: (tab: Tab) => string | null
  /**
   * Whether a followed link is this tab's own address, so that the link goes
   * to the tab instead of opening a page beside it.
   */
  owns?: (tab: Tab, url: string) => boolean
  /**
   * What the tab says while a web view's address is being worked out (see
   * `WebViewDeclaration.url`), for one that can take a while — a server
   * starting, say. `detail` is a second, quieter line.
   */
  starting?: { message: string; detail?: string }
}

/**
 * Where the launcher was opened: what an entry may want to know to decide what
 * its row says and where the tab it opens should start.
 */
export type LauncherContext = {
  /**
   * The active project's folder. Null for a project with none, and until the
   * launcher has heard which project is active — it opens and is typed into
   * faster than it can ask, so a row should read as itself without one.
   */
  projectRoot: string | null
}

/**
 * What a launcher entry's `open` is handed: the window's host, and where the
 * launcher was opened.
 */
export type LauncherHost = RendererHost & { launcher: LauncherContext }

/** What every launcher entry has, for a new tab or a new task: the row itself. */
export type LauncherRow = {
  /** Unique within the extension. */
  id: string
  label: string
  /** The row's second line, which may depend on where the launcher is. */
  detail?: string | ((context: LauncherContext) => string)
  /** An Iconify class. */
  icon: string
  keywords?: string[]
}

/** What a new-tab entry has: the row, and the other answers its menu offers. */
type TabLauncherRow = LauncherRow & {
  /**
   * Other things the row can do, offered by right-clicking it: the same kind of
   * tab, opened somewhere other than where taking the row opens it.
   */
  alternatives?: LauncherAlternative[]
}

/**
 * One of a row's other answers. Taking it closes the launcher first, and runs
 * in the window the launcher was opened over — so a folder picker it opens is
 * a sheet on that window, with no panel left to keep open behind it.
 */
export type LauncherAlternative = {
  /** Unique within the entry. */
  id: string
  /** The menu item. */
  label: string
  /** The tab to open, or null for one the user decided against. */
  open: (host: RendererHost) => Promise<NewTab | null>
}

/**
 * A launcher row that, when taken, asks for one line of input and turns it
 * into a tab — a link to a thread, say, which there is no way to guess.
 */
export type LauncherPromptEntry = TabLauncherRow & {
  typed?: undefined
  prompt: {
    placeholder: string
    /** Shown when `parse` returns null. */
    rejection: string
  }
  /**
   * Reads what was typed. Returns null for something that is not one of these,
   * or a value to hand to `open`. Also tried against whatever is typed or
   * pasted into the launcher's main field, so a pasted link is recognised
   * without choosing the row first.
   */
  parse: (text: string) => unknown | null
  /** The tab to open for a parsed value. */
  open: (value: unknown, host: LauncherHost) => Promise<NewTab>
}

/**
 * A launcher row that opens a tab as soon as it is taken, for a tab that needs
 * nothing from the user to start — a new session, a new scratchpad.
 */
export type LauncherActionEntry = TabLauncherRow & {
  prompt?: undefined
  parse?: undefined
  typed?: undefined
  /**
   * The tab to open, or null for one the user decided against — a picker the
   * entry opened and they dismissed — which leaves the launcher as it was.
   */
  open: (host: LauncherHost) => Promise<NewTab | null>
}

/**
 * A launcher row that is only there once something has been typed, and is
 * about whatever that is — a question to start a session with, a command to
 * run. The new-tab counterpart of `NewTaskTypedEntry`, and drawn the same way:
 * just under the row that searches for (or goes to) what was typed, so it is
 * never what Enter takes by default, reading as the text with the entry's
 * `label` for its detail.
 */
export type LauncherTypedEntry = LauncherRow & {
  typed: true
  prompt?: undefined
  parse?: undefined
  alternatives?: undefined
  /** The tab to open for what was typed (trimmed), or null for one the user decided against. */
  open: (text: string, host: LauncherHost) => Promise<NewTab | null>
}

/**
 * A way to open one of the extension's tabs from the launcher: a row that
 * either asks for a line of input first (`prompt`), opens straight away, or
 * is offered for whatever was typed (`typed`). Either way the tab lands in the
 * task the window has selected.
 */
export type LauncherEntry = LauncherPromptEntry | LauncherActionEntry | LauncherTypedEntry

/**
 * The task a new-task entry starts: what it is called, what kind it is, and the
 * tabs it opens with. Every field is optional — an empty template is a blank
 * task, the same one the launcher's own first row makes. The task lands at the
 * end of the active project's strip and is selected, on its first tab.
 */
export type NewTaskTemplate = {
  /** Defaults to `NEW_TASK_TITLE`. */
  title?: string
  /** One of the extension's task types, as `extensionId.id` (see `TaskTypeContribution`). */
  type?: string | null
  /** Defaults to `DEFAULT_TASK_ICON`. */
  icon?: TaskIcon
  /** Defaults to `DEFAULT_TASK_COLOR`. */
  color?: TaskColor
  facts?: TaskFact[] | null
  /** Opened in order; the first is the one the task opens on. */
  tabs?: NewTab[]
}

/**
 * A new-task row that asks for one line of input and turns it into a task — a
 * link to the thread the work is about, say. Like a new-tab prompt entry, its
 * `parse` is also tried against whatever is typed or pasted into the main
 * field, so a pasted link is recognised without choosing the row first.
 */
export type NewTaskPromptEntry = LauncherRow & {
  typed?: undefined
  prompt: LauncherPromptEntry['prompt']
  parse: (text: string) => unknown | null
  open: (value: unknown, host: LauncherHost) => Promise<NewTaskTemplate>
}

/** A new-task row that starts its task as soon as it is taken. */
export type NewTaskActionEntry = LauncherRow & {
  prompt?: undefined
  parse?: undefined
  typed?: undefined
  /** The task to start, or null for one the user decided against. */
  open: (host: LauncherHost) => Promise<NewTaskTemplate | null>
}

/**
 * A new-task row that is only there once something has been typed, and is
 * about whatever that is — a question to start a session with, say. Offered for
 * any text at all, just under the row that names a blank task after it, so it
 * is never what Enter takes by default. The row reads as what was typed, with
 * the entry's `label` for its detail, the way the new-tab panel's search row
 * reads as the query and "Search Google".
 */
export type NewTaskTypedEntry = LauncherRow & {
  typed: true
  prompt?: undefined
  parse?: undefined
  /** The task to start for what was typed (trimmed), or null for one the user decided against. */
  open: (text: string, host: LauncherHost) => Promise<NewTaskTemplate | null>
}

/**
 * A kind of task the new-task panel offers (Cmd+Shift+T, and the plus at the
 * end of the task strip), below the blank task it always leads with.
 */
export type NewTaskEntry = NewTaskPromptEntry | NewTaskActionEntry | NewTaskTypedEntry

/** Whether an entry asks for a line of input before it opens anything. */
export function asksForInput(entry: LauncherEntry): entry is LauncherPromptEntry
export function asksForInput(entry: NewTaskEntry): entry is NewTaskPromptEntry
export function asksForInput(entry: LauncherEntry | NewTaskEntry): boolean {
  return entry.prompt !== undefined
}

/** Whether an entry is offered only for what has been typed. */
export function forTypedText(entry: LauncherEntry): entry is LauncherTypedEntry
export function forTypedText(entry: NewTaskEntry): entry is NewTaskTypedEntry
export function forTypedText(entry: LauncherEntry | NewTaskEntry): boolean {
  return entry.typed === true
}

/** What an entry's row says under its label, where the launcher now is. */
export function launcherDetail(entry: LauncherRow, context: LauncherContext): string {
  return typeof entry.detail === 'function' ? entry.detail(context) : (entry.detail ?? '')
}

export type RendererExtension<Component = unknown> = {
  /** The same id as the extension's main half. */
  id: string
  /** Keyed by the tab type's own id, without the extension prefix. */
  tabs?: Record<string, TabView<Component>>
  /** Rows in the new-tab launcher (Cmd+T). */
  launcher?: LauncherEntry[]
  /** Rows in the new-task panel (Cmd+Shift+T), for tasks that start as something. */
  newTask?: NewTaskEntry[]
}

/** Declares an extension's renderer half. An identity function, there for the types. */
export function defineRendererExtension<Component>(
  extension: RendererExtension<Component>
): RendererExtension<Component> {
  return extension
}
