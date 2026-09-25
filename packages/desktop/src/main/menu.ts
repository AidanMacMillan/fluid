import { app, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  copyAddress,
  findAgain,
  focusedPage,
  getHostWindow,
  openFind,
  popOutAttachedTab,
  resetZoom,
  sendToHost,
  zoomIn,
  zoomOut
} from './browser-views'
import { openLauncherWindow } from './launcher-window'
import { openClipboardWindow } from './clipboard-window'
import { openProjectWindow } from './project-window'
import { checkForUpdates, UPDATE_MENU_ID } from './updater'

/**
 * The application menu.
 *
 * It is here for its accelerators rather than for the menu bar. Electron's
 * default menu binds Cmd+R to reloading the focused *window*, and this window
 * is the app itself: browser tabs are native `WebContentsView`s composited over
 * it, so a window reload threw the whole interface away and rebuilt it from the
 * database while the pages carried on rendering behind it. What the user meant
 * by Cmd+R was always the page.
 *
 * So every item that acts on a page goes through `focusedPage`, which answers
 * with the page actually in front — the selected browser tab, or a popup the
 * page opened — or with nothing at all. Nothing is the right answer on a file
 * tab, on an empty task and in the settings panel: the shortcut is a page's,
 * and there is no page.
 */

/**
 * A menu item that acts on whatever page is in front, and does nothing when
 * none is. Deliberately never disabled: which page is in front changes with
 * focus and with every navigation, and a menu that only recomputes itself when
 * it is opened would grey these out at the wrong moments.
 */
function pageItem(
  label: string,
  accelerator: string,
  act: (page: WebContents) => void
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => {
      const page = focusedPage(window)
      if (page) act(page)
    }
  }
}

/**
 * Cmd+T. The launcher opens over the app's own window rather than over whatever
 * has focus: the accelerator fires app-wide, and it can just as easily arrive
 * while a page's popup is in front — a new tab belongs to the window with the
 * tasks in it either way.
 *
 * Nothing happens when that window is blocked by the settings panel. A modal
 * child disables its parent at the OS level, and a launcher over a window that
 * cannot answer it would be a panel whose choice goes nowhere.
 */
function openLauncher(): void {
  const host = getHostWindow()
  if (host && host.isEnabled()) openLauncherWindow(host)
}

/**
 * Cmd+Shift+T. Not a task outright, for the reason Cmd+T is not a tab: what the
 * new task should be is a question, and the launcher asks it — blank, on the
 * row it opens with, so Cmd+Shift+T and Enter is still one blank task. It
 * opens over the window with the strip in it, and not while that window is
 * blocked by the settings panel, for the reasons `openLauncher` gives.
 */
function openTaskLauncher(): void {
  const host = getHostWindow()
  if (host && host.isEnabled()) openLauncherWindow(host, 'task')
}

/**
 * Cmd+Shift+V. The clipboard panel opens over the app's own window rather than
 * over whatever has focus, for the reason the launcher does: the accelerator
 * fires app-wide and can arrive while a page's popup is in front, and the
 * history it shows belongs to a task in that window either way.
 *
 * It is told no task. Which one it shows is already known in the main process,
 * pushed there by the renderer as the selection changes (see
 * `setClipboardTask`), and the panel simply does nothing if nothing is selected.
 *
 * On the key, see the item in the Edit menu below.
 */
function openClipboard(): void {
  const host = getHostWindow()
  if (host && host.isEnabled()) openClipboardWindow(host)
}

/**
 * Cmd+P. The same picker the project button in the top bar opens, hung under
 * that button. It opens over the app's own window and not while that window is
 * blocked by the settings panel, for the reasons `openLauncher` gives.
 */
function openProjects(): void {
  const host = getHostWindow()
  if (host && host.isEnabled()) openProjectWindow(host)
}

/**
 * Cmd+S. The sidebar is the renderer's own chrome — its collapsed state lives
 * in the workspace store and is persisted with the rest of the window's — so
 * the accelerator can only ask for it. It goes to the window with the tasks in
 * it rather than to whatever has focus, for the same reason the launcher does:
 * the key fires app-wide, and it can arrive while a browser tab's native view
 * or a page's popup is in front, none of which have a sidebar of their own.
 *
 * Nothing happens while that window is blocked by the settings panel — a modal
 * child disables its parent, and moving the chrome behind it is not something
 * the user could see the result of.
 */
function toggleSidebar(): void {
  const host = getHostWindow()
  if (host && host.isEnabled()) sendToHost('sidebar:toggle', undefined)
}

/**
 * Where a navigation shortcut wants to go. The menu only says which move was
 * asked for; which task or tab that lands on is the renderer's to work out,
 * since the strip and the sidebar are its state (see `Workspace.navigate`).
 */
export type ShortcutNavigation =
  /** Cmd+1..9: the task at that place in the strip, counting from one. */
  | { kind: 'task-index'; index: number }
  /** Cmd+Option+Left/Right: one task along the strip, wrapping at either end. */
  | { kind: 'task-step'; delta: 1 | -1 }
  /** Cmd+Option+Up/Down: one tab along the sidebar, wrapping at either end. */
  | { kind: 'tab-step'; delta: 1 | -1 }

/**
 * A menu item that asks the window with the tasks in it to move somewhere else
 * within them. Like the launcher and the sidebar toggle, the accelerator fires
 * app-wide and the state it acts on lives in the renderer, so the item can only
 * pass the request along.
 *
 * Unlike those two it answers only a *focused* host window. What it moves is
 * where the user is, so it has no business moving it out from under a window
 * they are working in — and the launcher is the case that would actually bite:
 * the task it is adding a tab to is read when its choice comes back, so a task
 * switched underneath it would redirect the tab. Comparing windows rules the
 * launcher, the settings panel and a page's popup out at once, the last two for
 * the reason `toggleSidebar` checks `isEnabled`: a modal child holds the focus
 * its parent cannot have.
 *
 * The chords themselves stay clear of the text fields inside that window.
 * Cmd+Option is unbound in a macOS field, where a bare Cmd+arrow is line-start
 * and line-end; a menu takes its key equivalent before the field ever sees it,
 * so the plain form would have cost the app's own composers and address bar
 * those keys. Digits are not editing keys at all and need no such care.
 */
function navigationItem(
  label: string,
  accelerator: string,
  navigation: ShortcutNavigation,
  visible = true
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    visible,
    click: (_item, window) => {
      const host = getHostWindow()
      if (!host || window !== host) return
      sendToHost('shortcuts:navigate', navigation)
    }
  }
}

/**
 * Installs the menu. Called once, after `app.whenReady`; the items themselves
 * hold no state, so nothing has to be rebuilt as tabs and windows come and go.
 */
export function registerApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              {
                id: UPDATE_MENU_ID,
                label: 'Check for Updates…',
                enabled: app.isPackaged,
                click: () => void checkForUpdates()
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        // Not a tab outright: what the new tab should be is a question, and the
        // launcher is where it is asked (see src/main/launcher-window.ts). The
        // sidebar's own new-tab row opens the same panel.
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: openLauncher },
        // The task the tabs go in. Shifted form of New Tab's key, since the
        // two are the same move a level apart — and like it, a panel that asks
        // what the task should be. The top bar's plus button opens the same one.
        { label: 'New Task', accelerator: 'CmdOrCtrl+Shift+T', click: openTaskLauncher },
        // The project the tasks belong to. The top bar's project button opens
        // the same picker.
        { label: 'Switch Project…', accelerator: 'CmdOrCtrl+P', click: openProjects },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? ([{ role: 'close' }] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'quit' }] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Edit',
      // Spelled out rather than taken as `role: 'editMenu'`, for the reason the
      // View menu is: the role's submenu is fixed, and Find has to go in it.
      // Every item the role would have given is still here, and still a role —
      // cut, copy, paste and select-all especially, because on macOS a role
      // goes out as a first-responder action, which is what reaches a native
      // view's page as readily as it reaches the app's own fields. A handler
      // here would only ever find the host renderer.
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin'
          ? ([{ role: 'pasteAndMatchStyle' }] satisfies MenuItemConstructorOptions[])
          : []),
        // Not a paste of its own: it opens the panel that asks which of the
        // things copied in this task to put back on the clipboard, and the
        // paste after that is an ordinary one.
        // Not a paste of its own: it opens the panel that asks which of the
        // things copied in this task to put back on the clipboard, and the
        // paste after that is an ordinary one. Hence the shifted form of paste,
        // and hence its place in this menu rather than beside the other panel
        // in File.
        //
        // It does not collide with `pasteAndMatchStyle` above, which reads like
        // it should own this key and does not: Electron gives that role
        // Cmd+Option+Shift+V on macOS, leaving the plain shifted form free.
        { label: 'Clipboard History…', accelerator: 'CmdOrCtrl+Shift+V', click: openClipboard },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        // Find is a page's, like Reload and Zoom, so it goes through
        // `focusedPage` and does nothing on a file tab or an empty task.
        //
        // A `WebContentsView` has no find bar of its own for the same reason it
        // has no zoom shortcuts and no right-click menu: those live in Chrome's
        // own UI layer rather than in the `content` module Electron embeds.
        // What it does have is the machinery underneath — `findInPage` is
        // Chromium's, highlighting and all — so only the bar itself had to be
        // built (see src/main/find-bar.ts).
        pageItem('Find…', 'CmdOrCtrl+F', openFind),
        // The two that step without going near the bar. They open it if it is
        // closed rather than scrolling the page behind the user's back — see
        // `findAgain`.
        pageItem('Find Next', 'CmdOrCtrl+G', (page) => findAgain(page, true)),
        pageItem('Find Previous', 'CmdOrCtrl+Shift+G', (page) => findAgain(page, false)),
        ...(process.platform === 'darwin'
          ? ([
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
              }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        // First in the menu, where Safari and Chrome both keep it: the one item
        // here that acts on the app's own frame rather than on a page.
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: toggleSidebar },
        { type: 'separator' },
        pageItem('Reload', 'CmdOrCtrl+R', (page) => page.reload()),
        // The same fix as Reload's, for the same reason: the default menu's
        // Cmd+Shift+R reloaded the window too.
        pageItem('Force Reload', 'CmdOrCtrl+Shift+R', (page) => page.reloadIgnoringCache()),
        pageItem('Copy Address', 'CmdOrCtrl+Shift+C', copyAddress),
        // The deliberate half of the miniplayer. A call or a video floats on
        // its own when its tab is hidden — the page decides, because only the
        // page knows what it is playing (see src/main/miniplayer.ts) — while
        // this floats the tab whole, whatever is in it, because the user said
        // so rather than because anything was detected.
        {
          label: 'Float This Tab',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: popOutAttachedTab
        },
        { type: 'separator' },
        // Zoom came free with Electron's default `viewMenu` role, and replacing
        // that menu took it away with it. It cannot simply be let through to
        // the page instead: Chromium's zoom shortcuts live in Chrome's own UI
        // layer rather than in the `content` module Electron embeds, so a
        // `WebContentsView` has none of its own — the same reason
        // `attachContextMenu` has to draw a right-click menu by hand.
        //
        // The roles are no use here either. They act on the focused *window*,
        // which is the app's own interface, so Cmd+Plus on a browser tab used
        // to scale the sidebar and the chrome bar around a page that stayed
        // exactly as it was. Through `focusedPage` it scales the page, and
        // because every tab is its own web contents, each keeps its own level.
        //
        // The scaling itself lives in browser-views, with the pill that reports
        // it (see src/main/zoom-indicator.ts): what a zoom is worth showing over
        // is the page area of the host window, and that module is the one that
        // knows where it is and which page is in it.
        pageItem('Zoom In', 'CmdOrCtrl+Plus', zoomIn),
        // Plus is a shifted key on most layouts, and Cmd+= is what people
        // actually press for it. An item carries one accelerator, so binding
        // both means a second item; hidden, it still answers its key
        // equivalent without showing the menu the same entry twice.
        { ...pageItem('Zoom In', 'CmdOrCtrl+=', zoomIn), visible: false },
        pageItem('Zoom Out', 'CmdOrCtrl+-', zoomOut),
        pageItem('Actual Size', 'CmdOrCtrl+0', resetZoom),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Dev only, like the context menu's Inspect Element: a tool, not a
        // feature. `watchWindowShortcuts` blocks the key form in production,
        // and an item that outlived it would be the one way back in.
        ...(is.dev ? ([{ role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[]) : [])
      ]
    },
    {
      label: 'History',
      submenu: [
        pageItem('Back', 'CmdOrCtrl+[', (page) => page.navigationHistory.goBack()),
        pageItem('Forward', 'CmdOrCtrl+]', (page) => page.navigationHistory.goForward())
      ]
    },
    {
      label: 'Go',
      submenu: [
        // Along the task strip, in the direction the strip runs. Both wrap:
        // with a handful of tasks open, stepping past the end is nearly always
        // a reach for the other end rather than a request to stop.
        navigationItem('Previous Task', 'CmdOrCtrl+Alt+Left', { kind: 'task-step', delta: -1 }),
        navigationItem('Next Task', 'CmdOrCtrl+Alt+Right', { kind: 'task-step', delta: 1 }),
        { type: 'separator' },
        // Down the sidebar, which is the direction its tabs run. Up is towards
        // the top of the list — the pinned tabs — and wraps round to the bottom.
        navigationItem('Previous Tab', 'CmdOrCtrl+Alt+Up', { kind: 'tab-step', delta: -1 }),
        navigationItem('Next Tab', 'CmdOrCtrl+Alt+Down', { kind: 'tab-step', delta: 1 }),
        { type: 'separator' },
        // Cmd+1..9 by position in the strip, which is what the numbers mean in
        // every browser — and on the plain Cmd rather than the arrows' Cmd+Option,
        // since a digit is the one chord here a user would guess unprompted. It
        // leaves Cmd+Option+1..9 free for the sidebar, should indexing a tab by
        // position ever be wanted too. Hidden rather than listed, the same way the second
        // Zoom In item is: nine more rows would be the longest thing in the menu
        // and the least worth reading, and a hidden item still answers its key
        // equivalent. Cmd+9 is the ninth task and nothing else — browsers make
        // it the *last* tab, but a task strip is short enough that the two
        // would usually be the same key doing two different things.
        ...Array.from({ length: 9 }, (_value, offset) =>
          navigationItem(
            `Task ${offset + 1}`,
            `CmdOrCtrl+${offset + 1}`,
            { kind: 'task-index', index: offset },
            false
          )
        )
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
