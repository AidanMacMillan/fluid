import type { TabSplit } from './splits'
import type { TaskColor, TaskIcon } from './task-icons'

/**
 * The workspace's records as the API hands them out.
 *
 * These are the shapes every caller sees — the app's own windows and every
 * extension alike — so they are defined here, in the package both depend on,
 * and the app's database schema is checked against them rather than the other
 * way round.
 */

/** A browsing world: the cookies and logins a project's pages run under. */
export type Space = {
  id: string
  name: string
  position: number
  createdAt: Date
  updatedAt: Date
}

/** A body of work, with the folder it lives in and the space its pages browse in. */
export type Project = {
  id: string
  name: string
  /** Absolute path, or null for a project that has no folder of its own. */
  root: string | null
  spaceId: string
  position: number
  createdAt: Date
  updatedAt: Date
}

export type TaskStatus = 'open' | 'settled'

/** One line of what is known about a task, drawn in the panel above its pinned tabs. */
export type TaskFact = {
  label: string
  value: string
  /** An address an `<img>` can load: a face, usually. */
  image?: string
}

/** What a task is called until somebody names it. */
export const NEW_TASK_TITLE = 'New Task'

/**
 * Something the user is working on, drawn as a tab in the strip across the top.
 *
 * `type` is null for a task the user opened themselves. Extensions give tasks
 * a type of their own — always namespaced as `extension.kind`, see
 * `TaskTypeContribution` — which is what the sidebar names above its title.
 * What the tab wears is the task's own `icon` and `color`, which every task
 * has, and which an extension sets when it creates one (see `task-icons.ts`).
 */
export type Task = {
  id: string
  projectId: string
  title: string | null
  type: string | null
  /** The glyph on the task's tab: one of `TASK_ICONS`. */
  icon: TaskIcon
  /** The colour that glyph is drawn in: one of `TASK_COLORS`. */
  color: TaskColor
  facts: TaskFact[] | null
  status: TaskStatus
  /** The tab the task opens on. Null only when it has no tabs. */
  activeTabId: string | null
  /**
   * Its tabs drawn side by side, each split shown whenever one of its tabs is
   * the active one (see `splits.ts`). Empty for a task that has never split.
   */
  splits: TabSplit[]
  position: number
  createdAt: Date
  updatedAt: Date
}

/** A note left on a task, by a person or an agent. Notes carry no author. */
export type TaskNote = {
  id: string
  taskId: string
  body: string
  createdAt: Date
  updatedAt: Date
}

// Tabs

export type BrowserTabPayload = {
  url: string
  /** Last known document title, for restoring the strip before the page loads. */
  pageTitle?: string
  /** Last known favicon, as a `data:` URL, for the same reason as `pageTitle`. */
  favicon?: string
}

/**
 * A file dropped onto a task. The file itself is not referenced where it was
 * dropped from: dragging it in copies it into the app's own store (see
 * the app's file store), so the tab keeps working after the original is moved,
 * renamed, or deleted, and nothing the app does can touch the user's copy.
 */
export type FileTabPayload = {
  /** Path of the app's copy, relative to the store root. Never absolute. */
  storageKey: string
  /** The name the file was dropped under, which is what the strip shows. */
  fileName: string
  /** Media type guessed from the extension; empty when the extension is unknown. */
  mimeType: string
  /** Bytes, as of the copy. */
  size: number
  /** Where the file came from, kept for reference only — never read back. */
  sourcePath?: string
  /**
   * A small preview of the file, as a `data:` URL, for the strip to draw. Made
   * once at import and stored here for the same reason a favicon is: the row
   * needs something to show before — and without — reading the file itself.
   * Absent for anything that has no preview, images the app cannot decode
   * included.
   */
  thumbnail?: string
}

/**
 * How the user left a tab looking — as opposed to `payload`, which is what the
 * tab *is*. The split is worth keeping: a payload is written rarely and losing
 * it loses the tab, while view state is written continuously as the user works
 * and losing it costs nothing but a scroll position. Null means the tab has not
 * been touched yet and should open however its kind opens by default, which is
 * also what every tab restored from before this column existed says.
 *
 * Tab kinds that have nothing to remember simply never write one.
 */
export type ImageViewState = {
  /**
   * Magnification against the image's natural size; 1 is actual pixels. Null
   * where the user has moved the image without settling on a magnification:
   * the view is still the fitted one, and stays fitted as the window resizes.
   */
  scale: number | null
  /**
   * How far the image sits from centred, in the viewport's own pixels. Stored
   * rather than derived: it is where the user put it, and no later window size
   * can recompute that.
   */
  offsetX: number
  offsetY: number
}

/**
 * How wide an HTML file is being read.
 *
 * A width rather than a choice between two of them: the toggle in the bar is
 * only the quick way to the two that matter, and the handles either side of the
 * view can put it anywhere in between. Which half of the toggle lights up is
 * then read back off the number rather than stored beside it — there is one
 * fact here, and a mode kept alongside the width could disagree with it.
 */
export type DocumentViewState = {
  /**
   * The width the view is drawn at, in CSS pixels. Null is the whole of what
   * the window has to give, which is what a document opens at.
   */
  width: number | null
  /**
   * The width the toggle comes back to when it leaves the phone, so that a
   * document dragged to a particular size and looked at on a phone is still
   * that size on the way back. Null is the full width, the same as above, and
   * absent means it has never been anything else.
   */
  desktopWidth?: number | null
}

/**
 * What a file tab remembers, which depends on which viewer the file gets: a
 * picture remembers where it was left, a document remembers how wide it was
 * being read. Discriminated by the file's media type rather than by a field of
 * its own, the same way a tab's payload is discriminated by the tab's `type`.
 */
export type FileViewState = ImageViewState | DocumentViewState

/** The kinds of tab the app itself knows how to draw. */
export const CORE_TAB_TYPES = ['browser', 'file'] as const

export type CoreTabType = (typeof CORE_TAB_TYPES)[number]

/**
 * A tab type an extension contributes. Always `extension.kind`: the dot is what
 * keeps these apart from the core types, both in the database and in
 * TypeScript, where `tab.type === 'browser'` still narrows cleanly because no
 * core type contains one.
 */
export type ExtensionTabType = `${string}.${string}`

export type TabType = CoreTabType | ExtensionTabType

/**
 * What a tab says about work going on in it, for its row — and its task's tab,
 * rolled up — to show as a dot. Null, no dot, for a tab with nothing to report,
 * which is nearly all of them.
 *
 * - `working`: under way. Yellow.
 * - `waiting`: stopped on the user, for an answer or an approval. Blue, and
 *   kept until the work moves on: seeing the tab is not answering it.
 * - `done`: finished since the user last had the tab open. Blue, and cleared
 *   by the app the moment they have it open, so nothing that sets it needs to
 *   know whether anyone was looking.
 *
 * Set by whatever does the work, through `tabs.setActivity`: a Claude Code tab
 * while it answers, a terminal while a command runs.
 */
export const TAB_ACTIVITIES = ['working', 'waiting', 'done'] as const

export type TabActivity = (typeof TAB_ACTIVITIES)[number]

/** A tab with something to report, as `tabs.activity` lists it. */
export type TabActivityEntry = {
  tabId: string
  taskId: string
  activity: TabActivity
}

type TabColumns = {
  id: string
  taskId: string
  /**
   * The folder the tab is in, or null for a tab at the top of its section. A
   * tab in a folder is in the folder's section: its `pinned` always agrees.
   */
  folderId: string | null
  title: string | null
  /**
   * Order among the tab's siblings — whatever else sits directly in the same
   * folder, or at the top of the same section, folders included. Only
   * comparable within those; `tabs.list` hands tabs out in the order the
   * sidebar draws them, which is the order to read them in.
   */
  position: number
  /** Whether the tab belongs to the task, drawn above the divider, rather than merely being open in it. */
  pinned: boolean
  /** Where a pinned tab that can wander off comes home to. */
  pinnedUrl: string | null
  /** The browsing profile a browser tab runs in; null is the default one. See `Profile`. */
  profile: number | null
  /** Work under way in the tab, or finished and not yet seen. See `TabActivity`. */
  activity: TabActivity | null
  createdAt: Date
  updatedAt: Date
}

export type BrowserTab = TabColumns & {
  type: 'browser'
  payload: BrowserTabPayload
  viewState: null
}

export type FileTab = TabColumns & {
  type: 'file'
  payload: FileTabPayload
  viewState: FileViewState | null
}

export type CoreTab = BrowserTab | FileTab

/**
 * A tab of a type an extension contributed. The payload and view state are the
 * extension's own business, so the API carries them without looking inside.
 */
export type ExtensionTab<
  Type extends ExtensionTabType = ExtensionTabType,
  Payload = Record<string, unknown>,
  ViewState = unknown
> = TabColumns & {
  type: Type
  payload: Payload
  viewState: ViewState | null
}

export type Tab = CoreTab | ExtensionTab

/**
 * A named group of tabs in a task's sidebar, and of other folders: they nest
 * as deep as the user cares to take them.
 *
 * A folder sits in one of the two sections like a tab does, and everything in
 * it is in that section too — a pinned folder's tabs are all pinned, and
 * moving the folder across the divider moves them with it.
 */
export type TabFolder = {
  id: string
  taskId: string
  /** The folder this one is in, or null for one at the top of its section. */
  parentId: string | null
  name: string
  pinned: boolean
  /** Whether the sidebar is showing what is in it. Kept, so it survives a restart. */
  collapsed: boolean
  /** Order among its siblings, on the same terms as `Tab.position`. */
  position: number
  createdAt: Date
  updatedAt: Date
}

/** What a folder is called until somebody names it. */
export const NEW_FOLDER_NAME = 'New Folder'

// Bookmarks

/**
 * A place worth one keystroke from the launcher.
 *
 * `source` says where it came from. The user's own are stored and can be
 * edited; an extension's are supplied live while it is enabled, and are never
 * written down — updating or removing the extension updates or removes them.
 */
export type Bookmark = {
  id: string
  label: string
  url: string
  /** An address an `<img>` can load. */
  icon?: string
  /** Extra words that should find this bookmark, beyond its label and address. */
  keywords?: string[]
  /** Launcher section the bookmark is grouped under. */
  group?: string
  /**
   * Only offered once something has been typed: for long catalogues that would
   * bury everything else if they were listed while the launcher is empty.
   */
  searchOnly?: boolean
  source: { kind: 'user' } | { kind: 'extension'; extensionId: string }
}

// Profiles

export type ProfileColor = 'red' | 'blue' | 'orange' | 'green' | 'purple' | 'grey'

/**
 * A separate login a browser tab can be opened in. There is a fixed set of
 * them; what identifies one is its colour.
 */
export type Profile = {
  id: number
  name: string
  color: ProfileColor
  /** Held in memory and emptied when its last tab closes. */
  ephemeral?: boolean
}

// Extensions

/** A task type as the windows draw it: see `TaskTypeContribution`. */
export type TaskTypeInfo = {
  /** The full type, `extensionId.id`. */
  id: string
  label: string
  description?: string
}

/** A tab type an extension contributes: see `TabTypeContribution`. */
export type TabTypeInfo = {
  /** The full type, `extensionId.id`. */
  id: string
  label: string
  /**
   * Whether tabs of this type are drawn in a view of their own, and which kind
   * (see `TabViewDeclaration`); null for a type drawn in the app's window.
   */
  view: 'page' | 'web' | null
  /** Whether its view draws its own bar across its top (see `PageViewDeclaration.drawsBar`). */
  drawsBar?: boolean
  /**
   * What agents are told a tab of this type is, for a type offered to them (see
   * `TabTypeContribution.agentDescription`).
   */
  agentDescription?: string
  /** The JSON Schema a payload has to match, for a type that declared one. */
  payloadSchema?: Record<string, unknown>
}

/** A file viewer an extension contributes, as the windows see it. */
export type FileViewerInfo = {
  /** The full id, `extensionId.id`. */
  id: string
  label: string
  mimeTypes: string[]
  /**
   * How it draws, as far as the window around it has to know: whether a page
   * of the extension's does, or Chromium itself — and then whether the window
   * offers widths to read the file at.
   */
  view: { kind: 'page' } | { kind: 'native'; resizable: boolean }
}

/** An installed extension, and what it currently contributes. */
export type ExtensionInfo = {
  id: string
  name: string
  description?: string
  enabled: boolean
  /** Whether it is running. False while disabled, or if activating it failed. */
  active: boolean
  /** Why it failed to activate, when it did. */
  error?: string
  /** Compiled into the app, or installed into its data folder. */
  source: 'built-in' | 'installed'
  /** An installed extension's own version. */
  version?: string
  /**
   * Installed while the app was running, but only starts once it relaunches:
   * it serves a scheme, and schemes are registered as the app starts.
   */
  pendingRelaunch?: boolean
  /**
   * Why an installed extension is waiting for the user's approval before it
   * runs: it is in the app's data folder but was not installed through the app
   * (`new`), or its files have changed since it was (`changed`).
   */
  needsApproval?: 'new' | 'changed'
  /** What an installed extension may do beyond the workspace API, as its manifest asks. */
  permissions?: { hosts: string[]; commands: string[]; extensions: string[] }
  /** The section it draws in the settings window, if it has one (see `Extension.settings`). */
  settings?: { label: string }
  taskTypes: TaskTypeInfo[]
  tabTypes: TabTypeInfo[]
  fileViewers: FileViewerInfo[]
}
