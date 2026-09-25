import { app, session, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerHostWindow, sameDocument, sendToHost } from './browser-views'
import { startClipboardCapture, stopClipboardCapture } from './clipboard-capture'
import { closeDatabase, initDatabase } from './db/client'
import { clearStaleActivity } from './db/tabs'
import { registerDownloadCapture } from './downloads'
import { registerFileProtocol } from './files'
import { registerIpcHandlers } from './ipc'
import { registerApiIpc } from './api/ipc'
import { registerExtensionViewIpc } from './extension-view-ipc'
import { registerInstalledExtensionsIpc } from './installed-extensions-ipc'
import { registerTeardown } from './api/teardown'
import { extensionSchemes, startExtensions, stopExtensions } from './extensions/host'
import { isWebAddress } from '@fluid/sdk'
import { applyPagePolicy } from './page-policy'
import { registerAppSchemes } from './schemes'
import { registerApplicationMenu } from './menu'
import { registerWindowOpener, restoreNotifications } from './notifications'
import { registerTheme } from './theme'
import { appIcon } from './app-icon'

// Keep in sync with `--spacing-titlebar` in src/renderer/src/assets/main.css.
const TITLE_BAR_HEIGHT = 40

// The renderer paints no background of its own, so this material *is* the
// window's background. 'hud' is the thinnest of the macOS materials — the most
// of the desktop shows through it. Cycle the list with Cmd+Alt+V in dev to
// compare; they run roughly thinnest to thickest.
const VIBRANCY_MATERIALS = [
  'hud',
  'fullscreen-ui',
  'under-window',
  'sidebar',
  'content',
  'under-page'
] as const satisfies readonly Parameters<BrowserWindow['setVibrancy']>[0][]

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    // Where the user last left it, size, place and all, and maximised or full
    // screen if that is how it was. The width and height below are only the
    // first launch's, and what a window restores to when the display it was on
    // has gone. The name is what Electron files the state under, so it must not
    // change, or every user's window comes back at the default once.
    name: 'main',
    windowStatePersistence: true,
    width: 900,
    height: 670,
    minWidth: 600,
    minHeight: 450,
    show: false,
    autoHideMenuBar: true,
    // Hide the OS title bar but keep the window controls, so the renderer can
    // draw its own content in that row. `titleBarOverlay` also exposes the
    // titlebar-area-* CSS env vars the renderer uses to lay out around them.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#18181b',
      symbolColor: '#e4e4e7',
      height: TITLE_BAR_HEIGHT
    },
    // Centre the 12px traffic lights in the taller bar (macOS only). The top
    // bar's leading inset is worked out from this x — see `titlebar-safe-area`
    // in src/renderer/src/assets/main.css.
    trafficLightPosition: { x: 14, y: (TITLE_BAR_HEIGHT - 12) / 2 },
    ...(process.platform === 'darwin'
      ? {
          // An NSVisualEffectView behind the web contents, which is the only
          // background the window has — nothing in the renderer paints over it.
          vibrancy: VIBRANCY_MATERIALS[0],
          // Keep the blur live even unfocused. With no tint of our own, letting
          // the material go inactive turns the whole window flat grey.
          visualEffectState: 'active' as const,
          // The window must paint nothing itself, or its opaque background
          // covers the vibrancy layer entirely.
          backgroundColor: '#00000000'
        }
      : // Elsewhere there is no blur layer at all, and a transparent window
        // would composite against nothing, so stay opaque.
        { backgroundColor: '#18181b' }),
    ...(process.platform === 'linux' ? { icon: appIcon() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      scrollBounce: true
      // No `scrollBounce` here, deliberately, and the omission is the setting:
      // Electron ships it off. Rubber-band overscroll is how a *page* says it
      // has run out, and the chrome is not a page — the sidebar and the tab
      // strip are panes of a window, and bouncing them reads as the app coming
      // loose from its own frame. Browser tabs are real pages and do ask for it
      // (see `scrollBounce` in src/main/browser-views.ts); the asymmetry is the
      // point.
    }
  })

  // Browser tabs render as native child views of this window's content view.
  registerHostWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Cmd+Alt+V swaps the vibrancy material at runtime, so the materials can be
  // compared against the same desktop instead of by restarting. Dev only: it is
  // a tool for picking the value that ships, not a feature.
  if (is.dev && process.platform === 'darwin') {
    let materialIndex = 0
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'v') return
      if (!input.meta || !input.alt) return
      materialIndex = (materialIndex + 1) % VIBRANCY_MATERIALS.length
      const material = VIBRANCY_MATERIALS[materialIndex]
      mainWindow.setVibrancy(material)
      console.log(`vibrancy: ${material}`)
    })
  }

  // Links followed inside the app's own interface: out of anything this window
  // draws.
  //
  // The window itself must never go anywhere. Everything the user reads lives
  // in a tab, and the one document this renderer holds is the app — so a link
  // that navigated it would replace the whole interface with a web page, with
  // no tab, no back button and no way home short of restarting.
  //
  // A web address becomes a tab, which is what the app is for. Anything else
  // is handed to the system, which is the only thing that knows what a
  // `mailto:` or a `zoommtg:` is for — and is also what keeps a `file:` link
  // pasted into a conversation from being loaded into the app's own session
  // (see src/main/safe-url.ts).
  const followLink = (url: string): void => {
    if (isWebAddress(url)) sendToHost('workspace:openLink', url)
    else void shell.openExternal(url)
  }

  // A plain click on a link. `will-navigate` is not emitted for the app's own
  // `loadURL`, nor for in-page anchors; what reaches here is the renderer being
  // sent somewhere else. The one navigation allowed is the interface reloading
  // itself, which is what a dev-server restart does.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (sameDocument(target, mainWindow.webContents.getURL())) return
    event.preventDefault()
    followLink(target)
  })

  // The same click with a modifier held, or a `window.open`. Both arrive here
  // rather than above, and both mean the same thing as the plain click: the
  // user wants the page, and the app has somewhere to put it.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    followLink(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The app serves the renderer over schemes of its own: its file store, and
// whatever the extensions declare. Chromium only accepts the declaration before
// `ready`, so it happens at module scope rather than alongside the handlers
// below — and only once, which is why it is one call (see ./schemes.ts).
registerAppSchemes()

// A second instance would open the same PGlite data directory as the first,
// interleaving writes from two separate clusters until neither pg_control nor
// the WAL matches and the directory will not open at all. Only one may run.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) return
  if (existing.isMinimized()) existing.restore()
  existing.focus()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.aidanmacmillan.fluid')

  // Open and migrate the local database before the first window exists, so the
  // renderer can never query it mid-migration.
  try {
    await initDatabase()
    await clearStaleActivity()
  } catch (error) {
    // Without a database there is nothing worth showing, and a bare window
    // would look like the app simply hung.
    console.error('Failed to open the local database:', error)
    dialog.showErrorBox(
      'Could not open the local database',
      error instanceof Error ? error.message : String(error)
    )
    app.exit(1)
    return
  }
  // Before the first window, whose preload asks for the theme to paint in.
  await registerTheme()
  registerFileProtocol()
  // Before the first window, whose page may draw from any of those schemes and
  // is only allowed to once its policy names them (see ./page-policy.ts).
  applyPagePolicy(
    session.defaultSession,
    'index.html',
    extensionSchemes().map((declared) => declared.scheme)
  )
  // Awaited: it opens a session per profile per space, and it reads the spaces
  // out of the database to know which. A download that beat it would go to a
  // save dialog rather than into its task.
  await registerDownloadCapture()
  registerIpcHandlers()
  // The API: every window reaches it over these two channels, and whatever a
  // tab was running is stopped once the API says the tab is gone.
  registerApiIpc()
  registerExtensionViewIpc()
  registerInstalledExtensionsIpc()
  registerTeardown()
  // Replaces Electron's default menu, whose Cmd+R reloaded this window — the
  // app's own interface — rather than the page the user was looking at.
  registerApplicationMenu()
  // Clicking a notification has to reach a window, and on macOS the app may be
  // running without one — closing the window does not quit. This is how the
  // notifications get one back; it must be in place before any is posted.
  registerWindowOpener(createWindow)
  // Banners a previous run left in Notification Centre, made clickable again.
  // Not awaited: nothing else waits on it, and a failure costs only that.
  void restoreNotifications().catch((error) => {
    console.error('Failed to restore notifications:', error)
  })
  // Extensions, which bring background jobs and tab types of their own, and
  // need both the database and the API in place.
  await startExtensions()
  // Sampling the clipboard, so that what gets copied while a task is in front
  // is kept with the task. It needs the database — a copy is a row — and it
  // does nothing at all while no window of the app's has focus, so starting it
  // here costs an idle timer until the first window appears.
  startClipboardCapture()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Flush PGlite's WASM filesystem to disk before the process goes away. Quitting
// is deferred one tick for the close; `app.exit` does not re-emit `will-quit`.
let shuttingDown = false
app.on('will-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  // Before the database goes: an extension's job waking up to find it closed
  // would log a failure on the way out for no reason. Not awaited — quitting is
  // already under way, and an extension slow to let go should not hold it up.
  // This is also what ends any processes an extension holds — the terminal
  // extension's shells above all — which are children of this one rather than
  // of the tabs they belong to, and would otherwise be left running under
  // launchd with nothing attached to them.
  void stopExtensions()
  // Before the database goes, for the same reason: a tick waking up to find it
  // closed would file nothing and log a failure on the way out.
  stopClipboardCapture()
  closeDatabase()
    .catch((error) => console.error('Failed to close database cleanly:', error))
    .finally(() => app.exit(0))
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
