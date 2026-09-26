import { BrowserWindow, ipcMain, type Rectangle } from 'electron'
import { listProjects } from './db/projects'
import * as projectsApi from './api/projects'
import { dismissTaskNotifications, takePendingOpenTask } from './notifications'
import { isSettingsWindow, openSettingsWindow } from './settings-window'
import { hideExtensionSettings, showExtensionSettings } from './settings-views'
import type { FolderPickerOptions } from '@fluid/sdk'
import { chooseDirectory } from './directories'
import { prepareWebView } from './extension-views'
import {
  chooseLauncherAlternative,
  chooseLauncherProfile,
  closeLauncherWindow,
  openLauncherWindow,
  holdLauncherWindow,
  resizeLauncherWindow,
  submitLauncherChoice,
  type LauncherChoice,
  type LauncherMenuItem,
  type LauncherMode
} from './launcher-window'
import {
  closeFind,
  destroyBrowserView,
  focusBrowserView,
  dismissFloating,
  goBack,
  goForward,
  hideBrowserView,
  navigate,
  popInTab,
  popOutTab,
  reload,
  returnFromFloating,
  sendToHost,
  setBrowserViewBounds,
  setFindQuery,
  showBrowserView,
  showFileView,
  showExtensionView,
  stepFind,
  toggleAudioMuted,
  watchPeekZone,
  type MeasuredBounds,
  type ViewBounds
} from './browser-views'
import {
  hideSplitDrop,
  previewSplitDrop,
  showSplitDrop,
  type SplitDropPreview,
  type SplitDropReport
} from './split-drop'
import { siteIcon } from './site-icons'
import { describeFloating, type PoppedOutTab } from './miniplayer'
import {
  clearClipboardEntries,
  deleteClipboardEntry,
  listClipboardEntries,
  resolveClipboardEntry
} from './db/clipboard'
import { setClipboardTask, type ClipboardTaskRef } from './clipboard-capture'
import {
  clipboardContext,
  closeClipboardWindow,
  openClipboardWindow,
  resizeClipboardWindow,
  restoreClipboardEntry
} from './clipboard-window'
import { cancelDownload } from './downloads'
import { resetProfile } from './profile-sessions'
import { popupSpaceMenu, spaceRows } from './spaces'
import { popupProfileMenu, type ProfilePickOptions } from './profile-menu'
import {
  popupFolderMenu,
  popupSectionMenu,
  popupTabMenu,
  type FolderMenuOptions,
  type TabMenuOptions
} from './tab-menu'
import { listTaskActions, runTaskAction } from './task-actions'
import {
  chooseNewProjectRoot,
  chooseProjectDirectory,
  popupProjectMenu,
  projectDeletion,
  projectsState
} from './projects'
import {
  closeProjectWindow,
  holdProjectWindow,
  openProjectWindow,
  projectPanel,
  resizeProjectWindow,
  submitProjectChoice,
  type ProjectChoice
} from './project-window'
import {
  copyStoredFile,
  importFile,
  openStoredFile,
  removeStoredFile,
  revealStoredFile
} from './files'

// Deliberately a named surface rather than a generic "run this SQL" channel:
// the renderer only gets the operations it actually needs.
export function registerIpcHandlers(): void {
  // Browser views
  //
  // These do not touch the database: the renderer owns tab records, the main
  // process owns the native views that render them.
  ipcMain.on(
    'browser:show',
    (
      _e,
      tabId: string,
      url: string,
      space: string | null,
      profile: number | null,
      bounds?: MeasuredBounds
    ) => showBrowserView(tabId, url, space, profile, bounds)
  )
  ipcMain.on('browser:showFile', (_e, tabId: string, storageKey: string, bounds?: MeasuredBounds) =>
    showFileView(tabId, storageKey, bounds)
  )
  ipcMain.on('browser:showExtension', (_e, tabId: string, type: string, bounds?: MeasuredBounds) =>
    showExtensionView(tabId, type, bounds)
  )
  // Asked before an extension's web view is first shown: its type works out
  // the address, which can mean starting whatever serves it. The answer is
  // whether there is one, never the address itself (see `prepareWebView`).
  ipcMain.handle('browser:prepareExtension', (_e, tabId: string, type: string) =>
    prepareWebView(tabId, type)
  )
  ipcMain.on('browser:hide', (_e, tabId: string) => hideBrowserView(tabId))
  ipcMain.on('browser:focus', (_e, tabId: string | null) => focusBrowserView(tabId))
  // The glass over the page area while a tab is dragged (see
  // src/main/split-drop.ts): put up and taken down by the main window, drawn on
  // at its word, and reporting back to it.
  ipcMain.on('split-drop:show', (e, bounds: ViewBounds) => {
    const window = BrowserWindow.fromWebContents(e.sender)
    if (window) showSplitDrop(window, bounds)
  })
  ipcMain.on('split-drop:hide', (e) => {
    const window = BrowserWindow.fromWebContents(e.sender)
    if (window) hideSplitDrop(window)
  })
  ipcMain.on('split-drop:preview', (_e, preview: SplitDropPreview) => previewSplitDrop(preview))
  ipcMain.on('split-drop:report', (_e, report: SplitDropReport) =>
    sendToHost('split-drop:report', report)
  )
  ipcMain.on('browser:popOut', (_e, tabId: string) => popOutTab(tabId))
  ipcMain.on('browser:popIn', (_e, tabId: string) => popInTab(tabId))
  ipcMain.on('browser:describeFloating', (_e, tabId: string, tab: PoppedOutTab) =>
    describeFloating(tabId, tab)
  )
  ipcMain.on('popout:back', (e) => returnFromFloating(e.sender))
  ipcMain.on('popout:dismiss', (e) => dismissFloating(e.sender))
  ipcMain.on('browser:setBounds', (_e, tabId: string, bounds: MeasuredBounds) =>
    setBrowserViewBounds(tabId, bounds)
  )
  ipcMain.on('browser:watchPeekZone', (_e, width: number) => watchPeekZone(width))
  ipcMain.on('browser:destroy', (_e, tabId: string) => destroyBrowserView(tabId))
  ipcMain.on('browser:goBack', (_e, tabId: string) => goBack(tabId))
  ipcMain.on('browser:goForward', (_e, tabId: string) => goForward(tabId))
  ipcMain.on('browser:reload', (_e, tabId: string) => reload(tabId))
  ipcMain.on('browser:toggleAudioMuted', (_e, tabId: string) => toggleAudioMuted(tabId))
  ipcMain.on('browser:navigate', (_e, tabId: string, url: string) => navigate(tabId, url))

  // The one browser channel that does touch storage, because what it answers is
  // not about a view: a pinned tab has no view until it is clicked, and this is
  // where its row gets an icon from in the meantime (see src/main/site-icons.ts).
  ipcMain.handle(
    'browser:siteIcon',
    (_e, url: string, space: string | null, profile: number | null) => siteIcon(url, space, profile)
  )

  // Profiles
  //
  // The renderer decides which profile a tab opens in and stores it on the tab;
  // the only thing it cannot do for itself is empty one, because the data lives
  // in a session rather than in the database.
  ipcMain.handle('profiles:reset', (event, space: string | null, profile: number) =>
    resetProfile(space, profile, BrowserWindow.fromWebContents(event.sender))
  )
  // Native, because neither window can draw a menu of its own that would be
  // seen: see src/main/profile-menu.ts.
  ipcMain.handle('profiles:pick', (event, options: ProfilePickOptions) =>
    popupProfileMenu(BrowserWindow.fromWebContents(event.sender), options)
  )
  // The same again for a tab's row in the sidebar: a browser tab's menu carries
  // the profile rows as a submenu, and an extension's tab carries whatever its
  // type offers. See src/main/tab-menu.ts.
  ipcMain.handle('tabs:menu', (event, options: TabMenuOptions) =>
    popupTabMenu(BrowserWindow.fromWebContents(event.sender), options)
  )
  // A folder's row, and the sidebar's empty ground, for the same reason.
  ipcMain.handle('folders:menu', (event, options: FolderMenuOptions) =>
    popupFolderMenu(BrowserWindow.fromWebContents(event.sender), options)
  )
  ipcMain.handle('sidebar:menu', (event) =>
    popupSectionMenu(BrowserWindow.fromWebContents(event.sender))
  )
  // And the buttons in a task's panel, which run here for the same reason an
  // extension's menu items do. See src/main/task-actions.ts.
  ipcMain.handle('tasks:actions', (_event, taskId: string) => listTaskActions(taskId))
  ipcMain.handle('tasks:runAction', (event, taskId: string, actionId: string) =>
    runTaskAction(BrowserWindow.fromWebContents(event.sender), taskId, actionId)
  )

  // Files
  //
  // The renderer never names a path of its own: it hands over what the OS gave
  // it for a dropped file, and gets back storage keys it can only use here.
  // One unreadable file — a path that vanished between the drop and the copy,
  // a volume that went away — does not cancel the rest of the drop.
  ipcMain.handle('files:import', async (_e, sourcePaths: string[]) => {
    const results = await Promise.allSettled(sourcePaths.map((path) => importFile(path)))
    for (const result of results) {
      if (result.status === 'rejected') console.error('Failed to import a file:', result.reason)
    }
    return results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  })
  ipcMain.handle('files:remove', (_e, storageKey: string) => removeStoredFile(storageKey))
  ipcMain.handle('files:open', (_e, storageKey: string) => openStoredFile(storageKey))
  ipcMain.on('files:reveal', (_e, storageKey: string) => revealStoredFile(storageKey))
  ipcMain.handle('files:copy', (_e, storageKey: string) => copyStoredFile(storageKey))
  // Closing the tab a download was filling is the one way to call it off.
  ipcMain.on('files:cancelDownload', (_e, downloadId: string) => cancelDownload(downloadId))

  // Projects
  //
  // Which body of work the app is in, and what its folder is — the preference
  // that used to say where new terminals start, now a row per project (see
  // src/main/projects.ts). The picker is a window of its own, so most of these
  // are called from it rather than from the main window.
  // What the picker draws: the projects with the space each is in and whether
  // its folder is still there, and the spaces with their counts. A view built
  // for the picker rather than an API read; every change goes through the API
  // (see src/main/api/projects.ts) and is answered with this, redrawn.
  ipcMain.handle('projects:state', () => projectsState())
  ipcMain.handle('projects:setActive', async (_e, id: string) => {
    await projectsApi.setActive(id)
    return projectsState()
  })
  ipcMain.handle('projects:create', (_e, name: string, root: string | null) =>
    projectsApi.create({ name, root })
  )
  ipcMain.handle('projects:setSpace', async (_e, id: string, spaceId: string) => {
    await projectsApi.setSpace(id, spaceId)
    return projectsState()
  })
  ipcMain.handle('projects:rename', async (_e, id: string, name: string) => {
    await projectsApi.rename(id, name)
    return projectsState()
  })
  ipcMain.handle('projects:clearRoot', async (_e, id: string) => {
    await projectsApi.setRoot(id, null)
    return projectsState()
  })
  ipcMain.handle('projects:deletion', (_e, id: string) => projectDeletion(id))
  ipcMain.handle('projects:delete', async (_e, id: string, confirmation: string) => {
    await projectsApi.remove(id, confirmation)
    return projectsState()
  })

  // The three natives the picker opens from inside itself. Each one holds the
  // panel open for as long as it is up: the picker is dismissed by looking
  // away, and a sheet or a menu taking key status arrives here as exactly that
  // blur — so without the hold, opening the folder picker would close the panel
  // waiting for its answer.
  ipcMain.handle('projects:chooseNewRoot', async (_e, name: string) => {
    const release = holdProjectWindow()
    try {
      return await chooseNewProjectRoot(projectPanel(), name)
    } finally {
      release()
    }
  })
  ipcMain.handle('projects:chooseRoot', async (_e, id: string) => {
    const release = holdProjectWindow()
    try {
      const root = await chooseProjectDirectory(projectPanel(), id)
      if (root !== null) await projectsApi.setRoot(id, root)
    } finally {
      release()
    }
    return projectsState()
  })
  ipcMain.handle('projects:menu', async (_e, id: string) => {
    const release = holdProjectWindow()
    try {
      const [projects, spaces] = await Promise.all([listProjects(), spaceRows()])
      const project = projects.find((candidate) => candidate.id === id)
      if (!project) return null
      return await popupProjectMenu(
        projectPanel(),
        {
          name: project.name,
          last: projects.length === 1,
          spaceId: project.spaceId,
          root: project.root
        },
        spaces
      )
    } finally {
      release()
    }
  })

  // Spaces
  //
  // The browsing worlds projects are grouped into (see src/main/spaces.ts).
  // Called from the picker, which is where they are made and named, and where
  // every project is told which one it is in.
  ipcMain.handle('spaces:list', () => spaceRows())
  ipcMain.handle('spaces:create', (_e, name: string) => projectsApi.createSpaceNamed(name))
  ipcMain.handle('spaces:rename', async (_e, id: string, name: string) => {
    await projectsApi.renameSpaceTo(id, name)
    return projectsState()
  })
  ipcMain.handle('spaces:delete', async (_e, id: string) => {
    await projectsApi.removeSpace(id)
    return projectsState()
  })
  ipcMain.handle('spaces:menu', async (_e, id: string) => {
    const release = holdProjectWindow()
    try {
      const space = (await spaceRows()).find((candidate) => candidate.id === id)
      if (!space) return null
      return await popupSpaceMenu(projectPanel(), space)
    } finally {
      release()
    }
  })

  // The picker window itself, opened the way the launcher is and answering the
  // same way: what it settles on goes to the window it opened over.
  ipcMain.on('projectWindow:open', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) openProjectWindow(window)
  })
  ipcMain.on('projectWindow:submit', (_e, choice: ProjectChoice) => submitProjectChoice(choice))
  ipcMain.on('projectWindow:resize', (_e, height: number) => resizeProjectWindow(height))
  ipcMain.on('projectWindow:close', () => closeProjectWindow())

  // The OS folder picker, for extension code running in a window (see
  // `RendererHost.chooseFolder`). Held open like the terminal's picker, and for
  // the same reason: asked from the launcher it opens as a sheet on the panel,
  // and the blur that gives would otherwise dismiss the panel out from under
  // it. Holding costs nothing when the panel is not what asked.
  ipcMain.handle('dialog:chooseFolder', async (event, options?: FolderPickerOptions) => {
    const release = holdLauncherWindow()
    try {
      return await chooseDirectory(BrowserWindow.fromWebContents(event.sender), {
        title: options?.title ?? 'Choose a folder',
        buttonLabel: options?.buttonLabel
      })
    } finally {
      release()
    }
  })

  // Notifications
  //
  // Asked once per window, as it loads: a notification clicked while the app
  // had no window is what made this one, and the request has been waiting for
  // somebody to be listening. Every other window gets null and moves on.
  ipcMain.handle('notifications:takePendingOpenTask', () => takePendingOpenTask())

  // Settings window
  //
  // The opener is whichever window asked, rather than a registered one: the
  // panel belongs to the window it was opened from, and that is the window it
  // centres on and is dismissed by clicking back onto.
  //
  // Opening is the whole of the traffic. Closing is the panel's own business —
  // Escape, Cmd+W, or looking away, all answered in the main process.
  ipcMain.on('settingsWindow:open', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent) openSettingsWindow(parent)
  })

  // An extension's section of the panel, which the extension draws in a view
  // of its own laid over the space the panel measured for it (see
  // src/main/settings-views.ts). Only the panel itself may ask.
  ipcMain.on('settingsWindow:showExtension', (event, extensionId: unknown, bounds: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isSettingsWindow(window) || typeof extensionId !== 'string') return
    if (!isRectangle(bounds)) return
    showExtensionSettings(window, extensionId, bounds)
  })
  ipcMain.on('settingsWindow:hideExtension', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && isSettingsWindow(window)) hideExtensionSettings()
  })

  // Launcher
  //
  // Opened over whichever window asked, like settings — but what it produces
  // goes back the other way: the panel names an address, and the window it
  // opened over turns that into a tab in whatever task is selected there.
  ipcMain.on('launcher:open', (event, mode: LauncherMode | undefined) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent) openLauncherWindow(parent, mode === 'task' ? 'task' : 'tab')
  })
  // The same panel asking about a task that exists: which icon it wears. What
  // it settles on is written straight through the API, so nothing comes back.
  ipcMain.on('launcher:pickIcon', (event, taskId: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent && typeof taskId === 'string' && taskId !== '') {
      openLauncherWindow(parent, 'icon', taskId)
    }
  })
  ipcMain.on('launcher:close', () => closeLauncherWindow())
  ipcMain.on('launcher:resize', (_e, height: number) => resizeLauncherWindow(height))
  ipcMain.on('launcher:submit', (_e, choice: LauncherChoice) => submitLauncherChoice(choice))
  // The panel asks; the answer is routed here rather than back to the panel,
  // which may not outlive the question (see `chooseLauncherProfile`).
  ipcMain.on('launcher:openInProfile', (_e, url: string) => void chooseLauncherProfile(url))
  // A row's other answers, for the same reason and with the same shape: the
  // menu is native and can close the panel, so what was chosen goes to the
  // window the panel opened over rather than back to the panel.
  ipcMain.on(
    'launcher:chooseAlternative',
    (_e, entry: string, alternatives: LauncherMenuItem[]) =>
      void chooseLauncherAlternative(entry, alternatives)
  )

  // Clipboard
  //
  // The history is written from the main process — capturing is a timer there,
  // and a copy has to be filed whether or not a renderer happens to be paying
  // attention (see src/main/clipboard-capture.ts). What crosses here is the
  // reading of it, plus the two things only a renderer can do: say which task is
  // in front, and run the sanitiser, which needs a DOM the main process has not
  // got.
  ipcMain.on('clipboard:setTask', (_e, task: ClipboardTaskRef | null) => {
    setClipboardTask(task)
    // The same message is the one place the main process hears that the user
    // has gone to a task, which is when its notifications stop being news.
    if (task) dismissTaskNotifications(task.id)
  })
  ipcMain.handle('clipboard:list', (_e, taskId: string) => listClipboardEntries(taskId))
  ipcMain.handle('clipboard:resolve', (_e, id: string, safeHtml: string | null) =>
    resolveClipboardEntry(id, safeHtml)
  )
  // Putting an entry back is the panel's whole purpose, and it is a main-process
  // act: the pasteboard is not something a renderer can write, and the picture
  // for an image entry lives in the file store rather than anywhere the panel
  // could reach.
  ipcMain.handle('clipboard:restore', (_e, id: string) => restoreClipboardEntry(id))
  // Both of these name files as well as rows, so the unlinking happens here
  // rather than being handed back to the panel to do — the store is the main
  // process's, and a row whose delete committed must not depend on a renderer
  // still being around to finish the job.
  ipcMain.handle('clipboard:delete', async (_e, id: string) => {
    for (const key of await deleteClipboardEntry(id)) await removeStoredFile(key)
  })
  ipcMain.handle('clipboard:clear', async (_e, taskId: string) => {
    for (const key of await clearClipboardEntries(taskId)) await removeStoredFile(key)
  })

  // Clipboard panel
  //
  // Opened over whichever window asked, like the launcher — but it is told
  // nothing at the door: which task it shows is already known in main, pushed
  // there by `clipboard:setTask` above, and the panel asks for it once it loads.
  ipcMain.on('clipboardWindow:open', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent) openClipboardWindow(parent)
  })
  ipcMain.on('clipboardWindow:close', () => closeClipboardWindow())
  ipcMain.on('clipboardWindow:resize', (_e, height: number) => resizeClipboardWindow(height))
  ipcMain.handle('clipboardWindow:context', () => clipboardContext())

  // Find
  //
  // One way only: the bar is a view drawn over the page (see
  // src/main/find-bar.ts) and has no access to the page it is searching, so
  // everything it does is a message, and the count it draws comes back to it on
  // a channel of its own rather than as an answer to any of these.
  //
  // Opening is not among them. Cmd+F is a menu accelerator, like every other
  // shortcut that acts on a page (see src/main/menu.ts), so the bar is never
  // the thing that asks for itself.
  ipcMain.on('find:query', (_e, text: string) => setFindQuery(text))
  ipcMain.on('find:step', (_e, forward: boolean) => stepFind(forward))
  ipcMain.on('find:close', () => closeFind())
}

function isRectangle(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
}
