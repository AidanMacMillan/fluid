import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  BrowserViewState,
  MeasuredBounds,
  OpenTabRequest,
  ViewBounds
} from '../main/browser-views'
import type { SplitDropPreview, SplitDropReport } from '../main/split-drop'
import type { DownloadEvent } from '../main/downloads'
import type { StoredFile } from '../main/files'
import type { FindResult } from '../main/find-bar'
import type { PoppedOutTab } from '../main/miniplayer'
import type { LauncherChoice, LauncherMenuItem, LauncherMode } from '../main/launcher-window'
import type { ProjectChoice } from '../main/project-window'
import type { Project, Space } from '../main/db/schema'
import type { ProjectMenuChoice, ProjectsState } from '../main/projects'
import type { SpaceMenuChoice, SpaceRow } from '../main/spaces'
import type { ClipboardTaskRef } from '../main/clipboard-capture'
import type { ClipboardContext } from '../main/clipboard-window'
import type { WebViewReadiness } from '../main/extension-views'
import type { InstallResult } from '../main/installed-extensions-ipc'
import type { FolderPickerOptions } from '@fluid/sdk'
import type { ShortcutNavigation } from '../main/menu'
import type { ProfileChoice, ProfilePickOptions } from '../main/profile-menu'
import type {
  FolderMenuChoice,
  FolderMenuOptions,
  SectionMenuChoice,
  TabMenuChoice,
  TabMenuOptions
} from '../main/tab-menu'
import type { TaskActionInfo, TaskActionResult } from '../main/task-actions'
import type { TaskFocus } from '../main/notifications'
import type { ClipboardEntry } from '../main/db/schema'
import type { MethodName, WorkspaceEvent } from '@fluid/sdk'

/**
 * The workspace API, as two channels: a call by method name, and every event.
 * `window.fluid` is the raw bridge; the renderer wraps it in the SDK's typed
 * client (see src/renderer/src/lib/api.ts), so a window uses the same API an
 * extension does.
 */
const fluid = {
  call: (method: MethodName, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('api:call', method, input),
  onEvent: (listener: (event: WorkspaceEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: WorkspaceEvent): void => listener(event)
    ipcRenderer.on('api:event', handler)
    return () => ipcRenderer.off('api:event', handler)
  }
}

export type FluidBridge = typeof fluid

/**
 * The theme, stamped on the document before the page draws anything (see
 * src/main/theme.ts). Asked for synchronously because this is the one moment
 * that is early enough: a page that painted in the default theme and then
 * switched would flash every time a panel opened. The stylesheet does the
 * rest — `data-theme` on the root is all a theme is to the page.
 *
 * Written out again in src/preload/extension-view.ts rather than shared: the
 * two preloads must never share a chunk (see electron.vite.config.ts).
 */
function applyTheme(theme: string): void {
  const root = document.documentElement
  if (root) root.dataset.theme = theme
  else document.addEventListener('DOMContentLoaded', () => applyTheme(theme), { once: true })
}

applyTheme(ipcRenderer.sendSync('theme:current') as string)
ipcRenderer.on('theme:changed', (_e, theme: string) => applyTheme(theme))

// Custom APIs for renderer
const api = {
  /**
   * Projects: which body of work the app is in, and where its folder is.
   *
   * Most of these are called from the picker rather than from the main window,
   * which is a window of its own for the reason the launcher is (see
   * src/main/project-window.ts). The three that open something native hold that
   * panel open for as long as it is up.
   */
  projects: {
    /** Everything the picker and the bar need: the rows, the selection, home. */
    state: (): Promise<ProjectsState> => ipcRenderer.invoke('projects:state'),
    /** Moves the app to a project. Told to the main process, not asked of it. */
    setActive: (id: string): Promise<Project | undefined> =>
      ipcRenderer.invoke('projects:setActive', id),
    /**
     * Makes a project and moves to it. Rejects when the name is empty or the
     * folder names nothing, with a message meant to be shown.
     */
    create: (name: string, root: string | null): Promise<Project> =>
      ipcRenderer.invoke('projects:create', name, root),
    rename: (id: string, name: string): Promise<ProjectsState> =>
      ipcRenderer.invoke('projects:rename', id, name),
    /** Moves a project into a space, which is to say into another set of logins. */
    setSpace: (id: string, spaceId: string): Promise<ProjectsState> =>
      ipcRenderer.invoke('projects:setSpace', id, spaceId),
    /** What a deletion would take with it, for the confirmation to say. */
    deletion: (id: string): Promise<{ name: string; tasks: number } | null> =>
      ipcRenderer.invoke('projects:deletion', id),
    /**
     * Deletes a project, its tasks, and everything under them. The name has to
     * be passed back exactly; the main process refuses the call otherwise,
     * which is what makes the picker's typed confirmation mean something.
     */
    remove: (id: string, confirmation: string): Promise<ProjectsState> =>
      ipcRenderer.invoke('projects:delete', id, confirmation),
    /** The folder for a project being made. Null when the picker was cancelled. */
    chooseNewRoot: (name: string): Promise<string | null> =>
      ipcRenderer.invoke('projects:chooseNewRoot', name),
    /** Points an existing project somewhere else. Unchanged if cancelled. */
    chooseRoot: (id: string): Promise<ProjectsState> =>
      ipcRenderer.invoke('projects:chooseRoot', id),
    /** Takes a project's folder away, so work in it starts in home. */
    clearRoot: (id: string): Promise<ProjectsState> => ipcRenderer.invoke('projects:clearRoot', id),
    /** The native row menu. Null when it was dismissed. */
    menu: (id: string): Promise<ProjectMenuChoice | null> =>
      ipcRenderer.invoke('projects:menu', id),
    /** Opens the picker over this window. */
    open: (): void => ipcRenderer.send('projectWindow:open'),
    /** The picker's own answer, on its way back to the window that asked. */
    submit: (choice: ProjectChoice): void => ipcRenderer.send('projectWindow:submit', choice),
    /** The picker telling the window how tall it actually drew itself. */
    resize: (height: number): void => ipcRenderer.send('projectWindow:resize', height),
    close: (): void => ipcRenderer.send('projectWindow:close'),
    /**
     * The project the picker settled on. Returns an unsubscribe, like
     * `browser.onState`.
     */
    onSelected: (listener: (choice: ProjectChoice) => void): (() => void) => {
      const handler = (_e: unknown, choice: ProjectChoice): void => listener(choice)
      ipcRenderer.on('project:selected', handler)
      return () => ipcRenderer.off('project:selected', handler)
    }
  },
  /**
   * Spaces: the browsing worlds projects are grouped into (see
   * src/main/spaces.ts). Called from the picker, which is the only place they
   * are made, named and assigned.
   *
   * Every one of these answers with the projects state rather than with spaces
   * alone: a space's name is drawn on every project row in it, and deleting one
   * moves its projects, so the panel needs the whole picture back either way.
   */
  spaces: {
    list: (): Promise<SpaceRow[]> => ipcRenderer.invoke('spaces:list'),
    /** Makes a space. Rejects on an empty name, with a message meant to be shown. */
    create: (name: string): Promise<Space> => ipcRenderer.invoke('spaces:create', name),
    rename: (id: string, name: string): Promise<ProjectsState> =>
      ipcRenderer.invoke('spaces:rename', id, name),
    /**
     * Deletes a space. Its projects move to the default space and the logins it
     * held are thrown away; the default space itself cannot go.
     */
    remove: (id: string): Promise<ProjectsState> => ipcRenderer.invoke('spaces:delete', id),
    /** Takes a project's folder away, so work in it starts in home. */
    clearRoot: (id: string): Promise<ProjectsState> => ipcRenderer.invoke('projects:clearRoot', id),
    /** The native row menu. Null when it was dismissed. */
    menu: (id: string): Promise<SpaceMenuChoice | null> => ipcRenderer.invoke('spaces:menu', id)
  },
  browser: {
    /**
     * Draws `tabId`'s page over the content area, creating the view on first
     * call. `space` and `profile` together are which login the page runs as (see
     * src/main/browsing.ts), and are read only on that first call — a view's
     * partition cannot be changed once it exists, so a tab whose project has
     * moved to another space gets a new view rather than a repartitioned one.
     */
    show: (
      tabId: string,
      url: string,
      space: string | null,
      profile: number | null,
      bounds?: MeasuredBounds
    ): void => ipcRenderer.send('browser:show', tabId, url, space, profile, bounds),
    /**
     * The same, for a file tab: drawn by whichever file viewer claims the
     * file's type, either a page of its extension's or a view rendering the
     * stored file itself, in a session of its own, that cannot be navigated
     * off it. The file is named by its storage key — the viewer and the
     * address are the main process's to decide.
     */
    showFile: (tabId: string, storageKey: string, bounds?: MeasuredBounds): void =>
      ipcRenderer.send('browser:showFile', tabId, storageKey, bounds),
    /**
     * The same, for a tab of an extension type drawn in a view of its own. The
     * type is named so the main process can refuse one that is not a view type;
     * the page is its to choose.
     */
    showExtension: (tabId: string, type: string, bounds?: MeasuredBounds): void =>
      ipcRenderer.send('browser:showExtension', tabId, type, bounds),
    /**
     * For a tab of an extension type drawn as a web application: asks its type
     * where the view should point, which may mean starting whatever serves it,
     * and answers whether there is anywhere — or why not. `showExtension` puts
     * nothing up for such a tab until this has said yes. The address itself
     * stays in the main process.
     */
    prepareExtension: (tabId: string, type: string): Promise<WebViewReadiness> =>
      ipcRenderer.invoke('browser:prepareExtension', tabId, type),
    /**
     * Detaches a tab's page without discarding it. Every pane asks for its own
     * view, so a split has several up at once and each goes on its own.
     */
    hide: (tabId: string): void => ipcRenderer.send('browser:hide', tabId),
    setBounds: (tabId: string, bounds: MeasuredBounds): void =>
      ipcRenderer.send('browser:setBounds', tabId, bounds),
    /**
     * Which of the pages on screen is the one in front — the selected tab, and
     * in a split the pane being worked in — for the page shortcuts, the find
     * bar and the miniplayer to mean.
     */
    focus: (tabId: string | null): void => ipcRenderer.send('browser:focus', tabId),
    /**
     * Lays a clear pane of glass over `bounds` — the page area — for a tab
     * dragged from the sidebar, and takes it away again. A page takes every
     * drag event over it, so the drop targets for splitting are the glass's to
     * catch (see src/main/split-drop.ts); it reports back through
     * `onSplitDrop`, and draws what `previewSplitDrop` tells it to.
     */
    showSplitDrop: (bounds: ViewBounds): void => ipcRenderer.send('split-drop:show', bounds),
    hideSplitDrop: (): void => ipcRenderer.send('split-drop:hide'),
    previewSplitDrop: (preview: SplitDropPreview): void =>
      ipcRenderer.send('split-drop:preview', preview),
    onSplitDrop: (listener: (report: SplitDropReport) => void): (() => void) => {
      const handler = (_e: unknown, report: SplitDropReport): void => listener(report)
      ipcRenderer.on('split-drop:report', handler)
      return () => ipcRenderer.off('split-drop:report', handler)
    },
    /**
     * The user clicked into one of the pages on screen — a pane of a split,
     * which this document never sees a click on. Returns an unsubscribe.
     */
    onFocused: (listener: (tabId: string) => void): (() => void) => {
      const handler = (_e: unknown, tabId: string): void => listener(tabId)
      ipcRenderer.on('browser:focused', handler)
      return () => ipcRenderer.off('browser:focused', handler)
    },
    /**
     * Asks to be told when the pointer comes within `width` pixels of the
     * page's leading edge, and stops asking at zero.
     *
     * The hover the renderer cannot feel for itself: a page is a native view
     * stacked above it, so a pointer inside the page's rect reaches no element
     * in this document at all. The main process reads the crossing off the
     * page's own input and sends it back through `onPeek`.
     */
    watchPeekZone: (width: number): void => ipcRenderer.send('browser:watchPeekZone', width),
    /** Discards a closed tab's page for good. */
    destroy: (tabId: string): void => ipcRenderer.send('browser:destroy', tabId),
    /** Navigation for the chrome drawn above the page. */
    goBack: (tabId: string): void => ipcRenderer.send('browser:goBack', tabId),
    goForward: (tabId: string): void => ipcRenderer.send('browser:goForward', tabId),
    reload: (tabId: string): void => ipcRenderer.send('browser:reload', tabId),
    /** Sends a tab's page to an address typed into the chrome's address bar. */
    navigate: (tabId: string, url: string): void =>
      ipcRenderer.send('browser:navigate', tabId, url),
    /**
     * The icon to draw for a site, for a tab that has no view yet — a pinned
     * tab restored on launch above all. Answered from what other tabs have
     * already loaded when it can be, and by fetching the site's icon on its own
     * when it cannot. Null for a site with no icon, or none that could be
     * reached: the row keeps its glyph either way.
     */
    siteIcon: (url: string, space: string | null, profile: number | null): Promise<string | null> =>
      ipcRenderer.invoke('browser:siteIcon', url, space, profile),
    /** Title/url/loading updates for whichever tab produced them. Returns an unsubscribe. */
    onState: (listener: (state: BrowserViewState) => void): (() => void) => {
      const handler = (_e: unknown, state: BrowserViewState): void => listener(state)
      ipcRenderer.on('browser:state', handler)
      return () => ipcRenderer.off('browser:state', handler)
    },
    /**
     * A page asking to open somewhere else — `window.open`, or a link set to
     * open in a new tab. The main process names the tab that asked; the task it
     * belongs to is the renderer's to look up, the same way a download's is.
     * Returns an unsubscribe, like `browser.onState`.
     */
    onOpenTab: (listener: (request: OpenTabRequest) => void): (() => void) => {
      const handler = (_e: unknown, request: OpenTabRequest): void => listener(request)
      ipcRenderer.on('browser:openTab', handler)
      return () => ipcRenderer.off('browser:openTab', handler)
    },
    /**
     * The pointer entering and leaving the band asked for by `watchPeekZone`,
     * as `true` and `false` — the `mouseenter` and `mouseleave` a strip of
     * renderer under the page would have had. Only the crossings arrive, not
     * every move. Returns an unsubscribe, like `browser.onState`.
     */
    onPeek: (listener: (inside: boolean) => void): (() => void) => {
      const handler = (_e: unknown, inside: boolean): void => listener(inside)
      ipcRenderer.on('browser:peek', handler)
      return () => ipcRenderer.off('browser:peek', handler)
    },
    /**
     * Floats a tab whole in a window of its own, as Cmd+Shift+P does for the
     * one on screen. Does nothing for a tab whose page has not been opened yet.
     */
    popOut: (tabId: string): void => ipcRenderer.send('browser:popOut', tabId),
    /**
     * Pops the right-click menu for a tab's row, at the cursor, and answers
     * what was chosen — or null if it was dismissed, or the choice was one of
     * an extension's items, which run in the main process. Native for the same
     * reason as `profiles.pick`.
     */
    tabMenu: (options: TabMenuOptions): Promise<TabMenuChoice | null> =>
      ipcRenderer.invoke('tabs:menu', options),
    /** The same for a folder's row in the sidebar. */
    folderMenu: (options: FolderMenuOptions): Promise<FolderMenuChoice | null> =>
      ipcRenderer.invoke('folders:menu', options),
    /** And for the sidebar's empty ground, which only offers a new folder. */
    sectionMenu: (): Promise<SectionMenuChoice | null> => ipcRenderer.invoke('sidebar:menu'),
    /** Brings a tab floating in its own window (Cmd+Shift+P) back into this one. */
    popIn: (tabId: string): void => ipcRenderer.send('browser:popIn', tabId),
    /**
     * What a floating window's bar should say about its tab — floating whole,
     * or in its miniplayer: the row's name and icon, which this window is the
     * one to work out. Sent again whenever they change.
     */
    describeFloating: (tabId: string, tab: PoppedOutTab): void =>
      ipcRenderer.send('browser:describeFloating', tabId, tab),
    /**
     * Which tabs have a floating window with a bar to describe them to, again
     * whenever that changes. Returns an unsubscribe, like `browser.onState`.
     */
    onFloating: (listener: (tabIds: string[]) => void): (() => void) => {
      const handler = (_e: unknown, tabIds: string[]): void => listener(tabIds)
      ipcRenderer.on('browser:floating', handler)
      return () => ipcRenderer.off('browser:floating', handler)
    },
    /**
     * Which tab is floating in a window of its own, or null once none is. The
     * tab's page is not in this window while it floats, so its place is the
     * renderer's to fill. Returns an unsubscribe, like `browser.onState`.
     */
    onPoppedOut: (listener: (tabId: string | null) => void): (() => void) => {
      const handler = (_e: unknown, tabId: string | null): void => listener(tabId)
      ipcRenderer.on('browser:poppedOut', handler)
      return () => ipcRenderer.off('browser:poppedOut', handler)
    },
    /**
     * An extension tab's view whose page crashed, and has been let go of.
     * Showing the tab again makes a new one. Returns an unsubscribe.
     */
    onExtensionGone: (
      listener: (gone: { tabId: string; reason: string }) => void
    ): (() => void) => {
      const handler = (_e: unknown, gone: { tabId: string; reason: string }): void => listener(gone)
      ipcRenderer.on('extension-view:gone', handler)
      return () => ipcRenderer.off('extension-view:gone', handler)
    }
  },
  files: {
    /**
     * The path the OS gave a dropped `File`. The renderer cannot ask a File for
     * its path itself — Electron removed `File.path` — and this is the sanctioned
     * replacement; it reads what the drag already handed over and invents nothing.
     */
    pathFor: (file: File): string => webUtils.getPathForFile(file),
    /** Copies files into the app's own store and describes the copies. */
    import: (sourcePaths: string[]): Promise<StoredFile[]> =>
      ipcRenderer.invoke('files:import', sourcePaths),
    /** Discards a stored copy. Only ever called for a file tab being closed. */
    remove: (storageKey: string): Promise<void> => ipcRenderer.invoke('files:remove', storageKey),
    /** Hands the stored copy to the OS's default application for it. */
    open: (storageKey: string): Promise<void> => ipcRenderer.invoke('files:open', storageKey),
    reveal: (storageKey: string): void => ipcRenderer.send('files:reveal', storageKey),
    /** Puts the stored copy on the clipboard as a file, to paste somewhere else. */
    copy: (storageKey: string): Promise<void> => ipcRenderer.invoke('files:copy', storageKey),
    /** Calls off a download, for a tab being closed while it was still arriving. */
    cancelDownload: (downloadId: string): void =>
      ipcRenderer.send('files:cancelDownload', downloadId),
    /**
     * The life of every download a page starts: begun, progressing, over. The
     * main process says which browser tab each came from; the task it belongs
     * to is the renderer's to look up. Returns an unsubscribe, like
     * `browser.onState`.
     */
    onDownload: (listener: (event: DownloadEvent) => void): (() => void) => {
      const handler = (_e: unknown, event: DownloadEvent): void => listener(event)
      ipcRenderer.on('files:download', handler)
      return () => ipcRenderer.off('files:download', handler)
    }
  },
  tasks: {
    /**
     * The buttons an extension offers for a task, for the panel above its
     * pinned tabs. Empty for a task with no type, or a type that offers none.
     */
    actions: (taskId: string): Promise<TaskActionInfo[]> =>
      ipcRenderer.invoke('tasks:actions', taskId),
    /**
     * Presses one. Resolves once it has run — or been declined, where it asks
     * first — and never rejects for the action's own failure, which comes back
     * as a result to show.
     */
    runAction: (taskId: string, actionId: string): Promise<TaskActionResult> =>
      ipcRenderer.invoke('tasks:runAction', taskId, actionId)
  },
  workspace: {
    /**
     * A link followed inside the app's own interface — out of an extension's
     * pane, or out of anything else this window draws. The navigation it would have
     * been was refused in the main process, because it would have replaced the
     * whole interface; this is what happens instead. Returns an unsubscribe,
     * like `browser.onState`.
     */
    onOpenLink: (listener: (url: string) => void): (() => void) => {
      const handler = (_e: unknown, url: string): void => listener(url)
      ipcRenderer.on('workspace:openLink', handler)
      return () => ipcRenderer.off('workspace:openLink', handler)
    }
  },
  shortcuts: {
    /**
     * Cmd+1..9 and the Cmd+Option+arrow chords, from the application menu — the
     * moves between tasks and tabs. Here for the reason `sidebar.onToggle` is:
     * a browser tab's native view holds the keyboard whenever a page is in
     * front, so the window whose state these move would never see the key.
     * Returns an unsubscribe, like `browser.onState`.
     */
    onNavigate: (listener: (navigation: ShortcutNavigation) => void): (() => void) => {
      const handler = (_e: unknown, navigation: ShortcutNavigation): void => listener(navigation)
      ipcRenderer.on('shortcuts:navigate', handler)
      return () => ipcRenderer.off('shortcuts:navigate', handler)
    }
  },
  sidebar: {
    /**
     * Cmd+S, from the application menu. The sidebar's state belongs to the
     * renderer, so main asks rather than tells; the accelerator exists at all
     * because a browser tab's native view holds the keyboard and nothing this
     * window listens for would ever see the key. Returns an unsubscribe, like
     * `browser.onState`.
     */
    onToggle: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('sidebar:toggle', handler)
      return () => ipcRenderer.off('sidebar:toggle', handler)
    }
  },
  miniplayer: {
    /**
     * The button on a miniplayer, which asks for the tab playing in it back.
     * The task comes along because the user is very often somewhere else
     * entirely by then — that is what a miniplayer is for — and the window has
     * already been brought forward by the time this arrives. Returns an
     * unsubscribe, like `browser.onState`.
     */
    onRevealTab: (listener: (focus: TaskFocus) => void): (() => void) => {
      const handler = (_e: unknown, focus: TaskFocus): void => listener(focus)
      ipcRenderer.on('miniplayer:revealTab', handler)
      return () => ipcRenderer.off('miniplayer:revealTab', handler)
    }
  },
  popout: {
    /** From a floating window's bar: go back to the tab, in the main window. */
    back: (): void => ipcRenderer.send('popout:back'),
    /**
     * From a floating window's bar: close the window without going to the tab.
     * A tab floating whole is put back in the main window; a miniplayer just
     * closes.
     */
    dismiss: (): void => ipcRenderer.send('popout:dismiss'),
    /**
     * For a floating window's bar: the name and icon of the tab in it, again
     * whenever they change. Returns an unsubscribe, like `browser.onState`.
     */
    onTab: (listener: (tab: PoppedOutTab) => void): (() => void) => {
      const handler = (_e: unknown, tab: PoppedOutTab): void => listener(tab)
      ipcRenderer.on('popout:tab', handler)
      return () => ipcRenderer.off('popout:tab', handler)
    }
  },
  notifications: {
    /**
     * A click this window was not up to hear — it is the click that made the
     * window. Asked once, while the workspace loads; null every other time.
     */
    takePendingOpenTask: (): Promise<TaskFocus | null> =>
      ipcRenderer.invoke('notifications:takePendingOpenTask')
  },
  dialog: {
    /** The OS folder picker, over the window that asks. Null when it was dismissed. */
    chooseFolder: (options?: FolderPickerOptions): Promise<string | null> =>
      ipcRenderer.invoke('dialog:chooseFolder', options)
  },
  launcher: {
    /**
     * Opens the launcher over this window — the panel that asks what the new
     * tab should be, or with `'task'`, what the new task should be. A window of
     * its own, because nothing the renderer paints can cover a browser tab's
     * native view (see src/main/launcher-window.ts).
     */
    open: (mode?: LauncherMode): void => ipcRenderer.send('launcher:open', mode),
    /**
     * Opens the same panel over this window to choose a task's icon and its
     * colour (see IconPickerApp.svelte). The panel writes the choice itself,
     * through the API, so the window hears about it as a `task.updated`.
     */
    pickIcon: (taskId: string): void => ipcRenderer.send('launcher:pickIcon', taskId),
    /** Escape and Cmd+W are handled in main; this is for the panel's own outs. */
    close: (): void => ipcRenderer.send('launcher:close'),
    /**
     * From the panel: what it settled on. The panel closes, and the window it
     * opened over is handed the choice to open a tab for.
     */
    submit: (choice: LauncherChoice): void => ipcRenderer.send('launcher:submit', choice),
    /**
     * From the panel: this row, but ask which profile first. The panel does not
     * hear back — the main process pops the menu and opens the tab itself, so
     * that the answer survives the panel being dismissed while the menu is up.
     */
    openInProfile: (url: string): void => ipcRenderer.send('launcher:openInProfile', url),
    /**
     * From the panel: an extension's row, but one of its other answers (see
     * `LauncherAlternative` in the SDK). The main process pops the menu, for
     * the reason `openInProfile` does not hear back either, and hands what was
     * picked to the window the panel opened over.
     */
    chooseAlternative: (entry: string, alternatives: LauncherMenuItem[]): void =>
      ipcRenderer.send('launcher:chooseAlternative', entry, alternatives),
    /** From the panel: how tall it actually drew, so the window can match it. */
    resize: (height: number): void => ipcRenderer.send('launcher:resize', height),
    /**
     * For the main window: what the launcher settled on, to be opened as a tab
     * in whichever task is selected — or, from the task panel, as a new task.
     * Returns an unsubscribe, like `browser.onState`.
     */
    onOpenTab: (listener: (choice: LauncherChoice) => void): (() => void) => {
      const handler = (_e: unknown, choice: LauncherChoice): void => listener(choice)
      ipcRenderer.on('launcher:openTab', handler)
      return () => ipcRenderer.off('launcher:openTab', handler)
    }
  },
  clipboard: {
    /**
     * Which task is in front, and what it is called. Pushed as it changes
     * rather than asked for, because the main process is where copies are
     * filed and it has no other way to know: the selected task is the window's
     * own state and is not written down anywhere.
     */
    setTask: (task: ClipboardTaskRef | null): void => ipcRenderer.send('clipboard:setTask', task),
    /** Everything copied while `taskId` was in front, newest first. */
    list: (taskId: string): Promise<ClipboardEntry[]> =>
      ipcRenderer.invoke('clipboard:list', taskId),
    /**
     * From the panel: what the sanitiser made of a rich entry's markup, or null
     * when it made nothing worth drawing. Asked once per entry, ever — capture
     * happens in the main process, which has no DOM to run the sanitiser with,
     * so the first panel to see an entry is what settles this.
     */
    resolve: (id: string, safeHtml: string | null): Promise<void> =>
      ipcRenderer.invoke('clipboard:resolve', id, safeHtml),
    /**
     * Puts an entry back on the clipboard — every representation of it at once,
     * so pasting afterwards behaves as though the original copy had just
     * happened — and closes the panel.
     */
    restore: (id: string): Promise<void> => ipcRenderer.invoke('clipboard:restore', id),
    /** Forgets one entry, and unlinks the picture behind it if it had one. */
    delete: (id: string): Promise<void> => ipcRenderer.invoke('clipboard:delete', id),
    /** The same, for a whole task's history. */
    clear: (taskId: string): Promise<void> => ipcRenderer.invoke('clipboard:clear', taskId)
  },
  clipboardWindow: {
    /**
     * Opens the clipboard panel over this window. A window of its own for the
     * reason the launcher is one: nothing the renderer paints can cover a
     * browser tab's native view (see src/main/clipboard-window.ts).
     *
     * Takes no task. Which one the panel shows is already known in main, from
     * `clipboard.setTask` above, and a second copy passed here would be free to
     * disagree with the one copies are being filed against.
     */
    open: (): void => ipcRenderer.send('clipboardWindow:open'),
    /** Escape and Cmd+W are handled in main; this is for the panel's own outs. */
    close: (): void => ipcRenderer.send('clipboardWindow:close'),
    /** From the panel: how tall it actually drew, so the window can match it. */
    resize: (height: number): void => ipcRenderer.send('clipboardWindow:resize', height),
    /**
     * For the panel, as it loads: which task it is showing. Asked rather than
     * handed over at creation, the same way a notification's pending task is —
     * the window is made before its renderer exists to be told anything.
     */
    context: (): Promise<ClipboardContext | null> => ipcRenderer.invoke('clipboardWindow:context')
  },
  splitDrop: {
    /** From the glass over the page area: where the drag is, or where it landed. */
    report: (report: SplitDropReport): void => ipcRenderer.send('split-drop:report', report),
    /** What the main window says the glass should draw. Returns an unsubscribe. */
    onPreview: (listener: (preview: SplitDropPreview) => void): (() => void) => {
      const handler = (_e: unknown, preview: SplitDropPreview): void => listener(preview)
      ipcRenderer.on('split-drop:preview', handler)
      return () => ipcRenderer.off('split-drop:preview', handler)
    }
  },
  find: {
    /**
     * From the bar: what to look for. Sent on every keystroke — Chromium is
     * built to be asked this often, and asking as the user types is what makes
     * the highlighting follow the field rather than trail it.
     */
    query: (text: string): void => ipcRenderer.send('find:query', text),
    /**
     * From the bar: the next match, or the one before it. The query is not
     * sent again — main holds it, because Find Next off the menu has to work
     * with the bar closed (see src/main/browser-views.ts).
     */
    step: (forward: boolean): void => ipcRenderer.send('find:step', forward),
    /** From the bar's close button. Escape is caught in main, as the launcher's is. */
    close: (): void => ipcRenderer.send('find:close'),
    /**
     * For the bar: it is being opened, with whatever was last searched for.
     * The field takes it and selects it, so a second Cmd+F is "search for
     * something else" rather than a keystroke that does nothing.
     */
    onOpen: (listener: (state: { query: string }) => void): (() => void) => {
      const handler = (_e: unknown, state: { query: string }): void => listener(state)
      ipcRenderer.on('find:open', handler)
      return () => ipcRenderer.off('find:open', handler)
    },
    /**
     * For the bar: how many matches there are and which one is current. It
     * cannot see the page it is drawn over, so this is the only way it knows.
     * Returns an unsubscribe, like `browser.onState`.
     */
    onResult: (listener: (result: FindResult) => void): (() => void) => {
      const handler = (_e: unknown, result: FindResult): void => listener(result)
      ipcRenderer.on('find:result', handler)
      return () => ipcRenderer.off('find:result', handler)
    }
  },
  profiles: {
    /**
     * Pops the menu that picks a browsing profile, at the cursor, and answers
     * what was chosen — or null if it was dismissed. Native rather than drawn
     * by the caller: a browser tab's view sits above anything a renderer
     * paints, and the launcher's window is no bigger than its own panel.
     */
    pick: (options: ProfilePickOptions): Promise<ProfileChoice | null> =>
      ipcRenderer.invoke('profiles:pick', options),
    /**
     * Empties one browsing profile: signs it out of everything and clears what
     * it has stored. Asks the user first, and answers whether they went through
     * with it — in this space only; the same profile elsewhere is untouched.
     * Tabs open in it are reloaded, signed out.
     */
    reset: (space: string | null, profile: number): Promise<boolean> =>
      ipcRenderer.invoke('profiles:reset', space, profile)
  },
  settingsWindow: {
    /**
     * Opens the settings panel — a window of its own, over the window that
     * asked. There is no counterpart: the panel is dismissed by clicking away,
     * Escape or Cmd+W, all of which the main process answers itself.
     */
    open: (): void => ipcRenderer.send('settingsWindow:open'),
    /**
     * Lays an extension's section — a page of the extension's own — over
     * `bounds` in the panel, the space the section's content takes up. Sent
     * again whenever that space changes. Only the panel may send it.
     */
    showExtension: (
      extensionId: string,
      bounds: { x: number; y: number; width: number; height: number }
    ): void => ipcRenderer.send('settingsWindow:showExtension', extensionId, bounds),
    /** Takes the extension's section down again. */
    hideExtension: (): void => ipcRenderer.send('settingsWindow:hideExtension')
  },

  /**
   * Installed extensions, for the settings panel's Extensions section: only the
   * panel may use these (see src/main/installed-extensions-ipc.ts). Installing
   * and removing ask the user first, in a sheet on the panel.
   */
  installedExtensions: {
    /** Picks a built extension's folder and installs it, or replaces the one with its id. */
    install: (): Promise<InstallResult> => ipcRenderer.invoke('installedExtensions:install'),
    /**
     * Asks the user to approve an installed extension that is waiting for it —
     * one found in the data folder, or one whose files changed — and starts it.
     */
    approve: (id: string): Promise<InstallResult> =>
      ipcRenderer.invoke('installedExtensions:approve', id),
    /** Removes an installed extension. False when the user decided against it. */
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('installedExtensions:remove', id),
    /** Shows an installed extension's folder in the file manager. */
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('installedExtensions:reveal', id),
    /** Opens the folder installed extensions live in. */
    openFolder: (): Promise<void> => ipcRenderer.invoke('installedExtensions:openFolder'),
    /** Relaunches the app. False while developing, where the dev server has to be restarted. */
    relaunch: (): Promise<boolean> => ipcRenderer.invoke('installedExtensions:relaunch')
  }
}

export type Api = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('fluid', fluid)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.fluid = fluid
}
