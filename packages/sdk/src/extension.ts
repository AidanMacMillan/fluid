import type { z } from 'zod'
import type { Client } from './client'
import type { Bookmark, Tab, Task } from './models'

/**
 * Extensions: what they are made of and what the app hands them.
 *
 * An extension runs in the app's main process and reaches the workspace only
 * through `ctx.api` — the same API the app's own windows use — so everything it
 * does is announced to every subscriber like any other change. What it adds to
 * the app (task types, tab types, file viewers, bookmarks, scheduled jobs) is
 * registered on `ctx` while it activates and taken away again when it is
 * disabled, removed or updated: nothing it contributes is written into the
 * workspace's own data.
 */

/** Something that can be undone: a registration, a subscription, a schedule. */
export type Disposable = { dispose(): void }

/** A key–value store private to one extension. Values are anything JSON can hold. */
export type ExtensionStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Every key, or only those starting with `prefix`. */
  keys(prefix?: string): Promise<string[]>
}

/**
 * Credentials private to one extension, encrypted at rest with the OS keychain.
 * Synchronous because they are read on the hot path of requests.
 */
export type ExtensionSecrets = {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
  has(name: string): boolean
  /**
   * Whether one is stored and when it was saved, and whether this computer can
   * store one securely at all — for a settings card, which never sees the secret.
   */
  status(name: string): { available: boolean; configured: boolean; updatedAt: string | null }
}

/** A job the app runs on a timer while the extension is enabled. */
export type ScheduledJob = {
  /** Unique within the extension. */
  id: string
  /** How long after one run finishes the next one starts. Runs never overlap. */
  intervalMs: number
  /** How long after activation the first run starts. Defaults to a few seconds. */
  initialDelayMs?: number
  run(): Promise<void>
}

/** A bookmark as an extension supplies it. The app fills in `source`, and namespaces the id. */
export type BookmarkContribution = Omit<Bookmark, 'source'>

/**
 * A kind of task. Tasks of this type carry `extensionId.id` in their `type`,
 * which the sidebar names above the task's title.
 *
 * A type has no icon of its own: every task has one, and an extension that
 * wants its tasks to look like something passes `icon` (and `color`) to
 * `tasks.create`. The user can change it afterwards like any other task's.
 */
export type TaskTypeContribution = {
  /** Unique within the extension; the task's type is `extensionId.id`. */
  id: string
  /** What the sidebar calls it. Short. */
  label: string
  /** A longer description, for tooltips. */
  description?: string
  /**
   * Buttons for a task of this type, drawn in the panel above its pinned tabs.
   * Asked whenever that panel shows the task, and again after one of them has
   * run, so the list can follow the world: disable what has already been done
   * rather than leave it to fail. An empty list draws no buttons.
   *
   * Asked again, too, when one is pressed — the one that runs is the one with
   * the same `id` in the fresh list — so an action that has stopped making
   * sense since the panel was drawn does not run on a stale promise.
   */
  actions?: (task: Task) => TaskAction[] | Promise<TaskAction[]>
}

/**
 * One button in a task's panel (see `TaskTypeContribution.actions`).
 *
 * `run` executes here, in the main process. What it throws is shown under the
 * buttons as it was worded, so throw sentences meant for the user — and when
 * an action does several things, say which of them had already happened.
 */
export type TaskAction = {
  /** Unique within the list; how a press finds its action again. */
  id: string
  /**
   * What the button says — or, with an `icon`, its accessible name. Either
   * way it is what a confirmation or a failure calls the action.
   */
  label: string
  /**
   * Drawn on the button in place of the label: an emoji's character, or a
   * picture's address the app's pages can load — a Slack custom emoji, say.
   */
  icon?: TaskActionIcon
  /** Greyed out when false. Defaults to true. */
  enabled?: boolean
  /** Why it is greyed out, or what it will do: the button's tooltip. */
  hint?: string
  /**
   * Asked before it runs, in a sheet on the window, for anything that cannot
   * be taken back. Without it the action runs on the click.
   */
  confirm?: {
    message: string
    detail?: string
    /** The button that goes ahead. */
    button: string
  }
  run(): void | Promise<void>
}

/** What a `TaskAction` shows in place of its label. */
export type TaskActionIcon = { emoji: string } | { image: string }

/**
 * A kind of tab. Tabs of this type carry `extensionId.id` in their `type`; the
 * payload is the extension's own. Drawing them is the extension's job: in a
 * view of their own when `view` is given — its `ExtensionView` in a page of
 * the app's, or a web application it points the view at — or in the app's
 * window by its renderer entry otherwise.
 */
export type TabTypeContribution = {
  /** Unique within the extension; the tab's type is `extensionId.id`. */
  id: string
  label: string
  /**
   * Draws tabs of this type in a view of their own — a separate page, in a
   * process of its own — rather than in the app's window. See
   * `TabViewDeclaration` for the two kinds of view there are.
   */
  view?: TabViewDeclaration
  /**
   * What a payload has to look like. Checked whenever a tab of this type is
   * opened, by anyone — the app's windows, another extension, an agent — and
   * one that does not match is refused. Without it the payload is taken as it
   * comes.
   */
  payload?: z.ZodType<Record<string, unknown>>
  /**
   * Offers tabs of this type to agents: what one is, and when it is worth
   * opening, for a model choosing between tools. An agent opens one by
   * payload, so this only has an effect alongside `payload`, whose schema it
   * is shown — and it is shown the payload of tabs of this type it lists,
   * which should therefore say nothing it should not read.
   */
  agentDescription?: string
  /**
   * Where a pinned tab of this type comes home to, when it has an address. Asked
   * when the tab is pinned.
   */
  pinnedUrl?: (tab: Tab) => Promise<string | null>
  /**
   * What right-clicking a tab of this type's row in the sidebar offers. Asked
   * each time the menu opens, so it can depend on the tab as it is now; an
   * empty list opens no menu at all. The items run here, in the main process —
   * to reach the tab's view, post to its `ViewConnection`.
   */
  menu?: (tab: Tab) => TabMenuItem[] | Promise<TabMenuItem[]>
  /**
   * Called when whatever a tab of this type is running should stop: its task
   * has been settled, or the tab is going for good. The tab and its rows still
   * exist — a settled task can be reopened, and the tab picks up from its
   * payload — so let go of processes and connections, not of stored files.
   *
   * Not called when the extension itself is disabled or the app quits; that is
   * `onDispose`'s job, for every tab at once.
   */
  onStop?: (tab: Tab) => void
  /**
   * Called after a tab of this type is closed, or its task deleted: its rows
   * are gone, and nothing will ask for it again. `onStop` has already run, so
   * this is for what was stored for the tab — its files, its storage keys.
   */
  onClose?: (tab: Tab) => void
}

/** One row of a tab's right-click menu (see `TabTypeContribution.menu`). */
export type TabMenuItem =
  | {
      label: string
      /** Greyed out when false. Defaults to true. */
      enabled?: boolean
      click(): void | Promise<void>
    }
  | { type: 'separator' }

/**
 * How a tab type drawn in a view of its own is drawn there, and how it behaves.
 * One of two kinds:
 *
 * - **`page`** (the default): a page of the app's own, which draws the
 *   extension's `ExtensionView` for this type into itself and reaches the app
 *   through a bridge (see the SDK's view half).
 * - **`web`**: a web application, served over http(s) by a process the
 *   extension runs or by anything else — an editor's workbench, a notebook, a
 *   dev server. See `WebViewDeclaration`.
 */
export type TabViewDeclaration = PageViewDeclaration | WebViewDeclaration

/**
 * Accelerators, as Electron's menu reads them: `CmdOrCtrl+K`,
 * `CmdOrCtrl+Shift+Enter`. Cmd+W and Cmd+Q are never given away, whatever is
 * listed: a view that swallowed them would be a window that cannot be closed
 * from the keyboard.
 */
export type Accelerator = string

/** A tab drawn by the extension's own `ExtensionView`, in a page of the app's. */
export type PageViewDeclaration = {
  kind?: 'page'
  /**
   * Shortcuts the page gets before the app's menu does. Everything else the
   * menu binds (Find, Reload, Zoom, …) stays the app's.
   */
  keys?: Accelerator[]
  /**
   * Whether the page is handed the keyboard each time its tab is switched to.
   * A view that stays warm keeps its own focus while it is out of sight, but
   * the click that brought it back landed in the sidebar, and without this the
   * next keystroke goes there too. For a view that is mostly something to type
   * into — a shell — rather than something to look at.
   */
  focusOnShow?: boolean
  /**
   * Whether the page draws its own bar across its top, in the row a browser
   * tab has its address in. The app draws a bar over a view that has none when
   * the tab is one pane of a split — something has to say which pane is which,
   * and hold the way out of the split — and would draw a second over one that
   * does. A view that says so here gets no bar from the app, split or not, and
   * offers the way out itself (see `watchTabSplit` and `leaveSplit`).
   */
  drawsBar?: boolean
}

/**
 * A tab drawn by a web application the extension points its view at.
 *
 * The page is not the app's and gets nothing of the app's: no bridge, no
 * stylesheet, no API. What the app does give it is what an application needs
 * that a browser tab does not:
 *
 * - **A session of its own**, shared by every web view the extension has and
 *   kept across launches, so whatever the application stores — a sign-in, its
 *   settings, its layout — is there next time. Not a browsing profile's, and
 *   not the extension's own pages'.
 * - **Its origin to itself.** It navigates freely within the origin of the
 *   address it was given; a link anywhere else becomes a browser tab, rather
 *   than replacing the application with a page in a tab that has no address
 *   bar and no way back.
 * - **Its windows kept.** Every window it opens stays in the app, as a window
 *   of its own in the same session — sign-in flows finish by writing to storage
 *   the opener polls, which a window anywhere else could not reach.
 *
 * Its row, like any extension tab's, is the renderer entry's to draw.
 */
export type WebViewDeclaration = {
  kind: 'web'
  /**
   * Where a tab's view points: an http or https address. Asked each time a
   * view is made for the tab, which is when it is first shown and again after
   * its view was let go of, and never stored. May take as long as it needs —
   * the tab says it is starting meanwhile (see `TabView.starting`) — and may
   * throw, and the error's message is shown in the tab.
   */
  url: (tab: Tab) => Promise<string>
  /**
   * Shortcuts the page gets before the app's menu does. `'all'` gives it
   * every one the menu binds that an application would bind itself — Find,
   * Save, Reload, Zoom, New Tab and the rest — keeping only window management
   * and the plain editing commands, which reach a page anyway.
   */
  keys?: Accelerator[] | 'all'
  /** A stylesheet put into every document the view loads, as it parses. */
  stylesheet?: string
  /**
   * Leaves the view see-through behind the page, for an application that has
   * been styled onto the app's glass (see `stylesheet`). Otherwise the view
   * paints the canvas a browser would, white or dark.
   */
  transparent?: boolean
}

/**
 * A viewer for file tabs of some media types.
 *
 * A file tab is the app's own: the app keeps the file in its store, fills it
 * from a drop or a download, and draws the bar above it with the file's name
 * and the ways to hand it to the OS. What goes under that bar is the viewer's.
 * A file no running extension offers to view says it cannot be shown.
 *
 * Nothing about the file is the viewer's to decide except how it is drawn: its
 * media type was worked out when it was stored, and `mimeTypes` is matched
 * against that.
 */
export type FileViewerContribution = {
  /** Unique within the extension. */
  id: string
  /** What the viewer shows, for the settings window: "Images", "PDF documents". */
  label: string
  /**
   * The media types it draws, exactly (`application/pdf`) or by their first
   * half (`image/*`). Where two running viewers claim the same type, the one
   * whose extension the app lists first draws it.
   */
  mimeTypes: string[]
  view: FileViewDeclaration
}

/** Whether a viewer claiming `claimed` draws a file of `mimeType`. */
export function claimsMediaType(claimed: readonly string[], mimeType: string): boolean {
  // A file of no known type is claimed by nothing, however broad the claim.
  if (mimeType === '') return false
  const family = mimeType.slice(0, mimeType.indexOf('/') + 1)
  return claimed.some((type) => type === mimeType || (family !== '' && type === `${family}*`))
}

/**
 * How a file viewer draws a file. One of two kinds:
 *
 * - **`page`**: the extension's own `ExtensionView` for the viewer (see
 *   `ExtensionViews.files`), in a page of the app's, which loads the file from
 *   `storedFileUrl`. For a format the page can draw itself — a picture, a
 *   video.
 * - **`native`**: the file itself, rendered by Chromium in a view held to it.
 *   See `NativeFileViewDeclaration`.
 */
export type FileViewDeclaration = PageFileViewDeclaration | NativeFileViewDeclaration

/** A file drawn by the extension's own `ExtensionView`, in a page of the app's. */
export type PageFileViewDeclaration = {
  kind: 'page'
  /** As a page view's (see `PageViewDeclaration.keys`). */
  keys?: Accelerator[]
  /** As a page view's (see `PageViewDeclaration.focusOnShow`). */
  focusOnShow?: boolean
}

/**
 * A file Chromium renders by itself, the way it renders a page: for a format
 * only a browser engine can honestly draw (HTML), or one Chromium ships a
 * viewer for (PDF). The view cannot leave the file — a link followed out of it
 * is a tab — and runs in a session of its own, which belongs to no browsing
 * profile and holds none of their cookies.
 */
export type NativeFileViewDeclaration = {
  kind: 'native'
  /**
   * The session the file renders in.
   *
   * - **`ephemeral`**: kept in memory and gone when the app quits, the way a
   *   private window's is. For a format that runs script, which then has
   *   nothing of its own to keep.
   * - **`persisted`**: kept across launches. Chromium's own viewers need one to
   *   exist at all: in an in-memory session a PDF draws a blank page.
   */
  session: 'ephemeral' | 'persisted'
  /**
   * Lets the user choose the width the file is drawn at, between the window's
   * and a phone's: a toggle in the bar, and an edge either side to drag. For a
   * layout that answers to its width, as a page does; not for one whose width
   * was decided when it was made, as a PDF's was.
   */
  resizable?: boolean
}

/**
 * One live view of one tab: from the moment its page has loaded and asked to
 * be connected until it is destroyed or reloaded. A view that is merely out of
 * sight stays connected.
 *
 * How an extension's main half pushes to its interface. Messages are copied the
 * way `postMessage` copies them, in both directions.
 */
export type ViewConnection = {
  readonly tabId: string
  /** Sends a message to the page. Dropped once disconnected. */
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): Disposable
  /** Runs once, when the view goes. Runs straight away if it already has. */
  onDisconnect(listener: () => void): Disposable
  readonly connected: boolean
}

/** How a command run with `ctx.process.run` ended. */
export type ProcessResult = {
  /** Its exit code, or null when it was ended by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

export type ProcessOptions = {
  /** Where it runs. Defaults to the user's home folder. */
  cwd?: string
  /** How long it may take before it is killed and the call rejects. Defaults to a minute. */
  timeoutMs?: number
  /** Written to its standard input, which is then closed. */
  input?: string
}

/** What an extension is given while it is active. */
export type ExtensionContext = {
  /** The extension's own id. */
  readonly id: string
  /** The workspace. Every call is attributed to the extension. */
  readonly api: Client
  readonly storage: ExtensionStorage
  readonly secrets: ExtensionSecrets
  /**
   * A folder of the extension's own, for files that do not fit in `storage`:
   * attachments, caches, anything a process it runs writes. Created before
   * `activate` runs, and kept when the extension is disabled or updated.
   */
  readonly dataDir: string
  schedule(job: ScheduledJob): Disposable
  readonly bookmarks: {
    /**
     * Supplies bookmarks while the extension is enabled. Called whenever the
     * list is read; call `changed()` if what it returns changes.
     */
    provide(provider: () => BookmarkContribution[]): Disposable
    changed(): void
  }
  readonly taskTypes: { register(type: TaskTypeContribution): Disposable }
  readonly tabTypes: { register(type: TabTypeContribution): Disposable }
  readonly fileViewers: { register(viewer: FileViewerContribution): Disposable }
  readonly views: {
    /**
     * Runs each time a view of one of the extension's tabs connects: when the
     * tab is first shown, and again after the page is reloaded or has crashed
     * and been shown again. `tabType` is the type's own id, without the
     * extension prefix, and has to be one registered with a `page` view.
     */
    onConnect(tabType: string, listener: (connection: ViewConnection) => void): Disposable
  }
  /**
   * Methods the extension exposes (`extensions.call` in the API). How its
   * renderer half reaches its main-process half, and how other extensions reach
   * it (see `extensions` below). Anything that can call the API can call these,
   * so input arrives unvalidated: check it, and never hand a secret back.
   */
  readonly rpc: {
    handle(method: string, handler: (input: unknown) => unknown | Promise<unknown>): Disposable
  }
  /** Other extensions, as this one can reach them. */
  readonly extensions: {
    /**
     * Calls a method another extension registered with its `rpc`. Rejects when
     * that extension is disabled or has no such method, so a caller that can
     * do without it should catch rather than assume it is there.
     *
     * Both run in the main process, so what the handler throws arrives as it
     * was thrown, fields and all.
     */
    call<T = unknown>(extensionId: string, method: string, input?: unknown): Promise<T>
  }
  /**
   * Serves one of the schemes the extension declared (see `Extension.schemes`)
   * to the app's windows and to the extension's own views. Pages in browser
   * tabs do not reach it.
   */
  readonly protocols: {
    handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): Disposable
  }
  /** Opens an address in the user's default browser or the app registered for it. */
  openExternal(url: string): Promise<void>
  /**
   * Runs a command on the user's machine, found on their PATH and run without a
   * shell, and resolves with how it ended — a non-zero exit is an answer, not a
   * failure. Rejects when the command cannot be found, times out, or is not one
   * an installed extension's manifest asked for (see `ExtensionPermissions`).
   */
  readonly process: {
    run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>
  }
  /** Runs when the extension is deactivated, after its registrations are undone. */
  onDispose(dispose: () => void | Promise<void>): void
  readonly log: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
}

/**
 * A URL scheme an extension serves, declared up front: schemes have to be
 * registered before the app is ready, long before any extension activates.
 */
export type SchemeDeclaration = {
  scheme: string
  /** As Electron's `CustomScheme.privileges`. */
  privileges?: {
    standard?: boolean
    secure?: boolean
    supportFetchAPI?: boolean
    corsEnabled?: boolean
    stream?: boolean
    bypassCSP?: boolean
  }
}

export type Extension = {
  /** Lowercase letters, digits and dashes. Namespaces everything the extension contributes. */
  id: string
  name: string
  description?: string
  schemes?: SchemeDeclaration[]
  /**
   * Gives the extension a section of its own in the settings window, drawn by
   * its views' `settings` (see `ExtensionViews`). `label` names the section,
   * and defaults to the extension's name.
   */
  settings?: { label?: string }
  activate(ctx: ExtensionContext): void | Promise<void>
}

/** Declares an extension. An identity function, there for the types. */
export function defineExtension(extension: Extension): Extension {
  return extension
}
