import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { holdSettingsWindow, isSettingsWindow } from './settings-window'

/**
 * Whether Fluid is the app the system opens web links with, and asking for it
 * to be — for the settings panel's General section.
 *
 * Only the panel may use these: changing the default browser is the user's
 * decision, and the system asks them to confirm it besides.
 *
 * @module default-browser
 */

/** The two schemes that make an app the default browser. */
const SCHEMES = ['http', 'https'] as const

/** What the panel shows. */
export type DefaultBrowserStatus = {
  /**
   * Whether this build can be made the default. Not an unpackaged run, whose
   * executable is Electron's own rather than Fluid's (see the `http` and
   * `https` declarations in electron-builder.yml, which a dev build lacks), and
   * not Windows, where the installer does not yet register the app as a browser.
   */
  supported: boolean
  /** Whether Fluid is the default for both schemes. */
  isDefault: boolean
  /** The app that is, when it is not Fluid and the system will say. */
  currentApp: string | null
}

function supported(): boolean {
  return app.isPackaged && process.platform !== 'win32'
}

function status(): DefaultBrowserStatus {
  const isDefault = SCHEMES.every((scheme) => app.isDefaultProtocolClient(scheme))
  return {
    supported: supported(),
    isDefault,
    currentApp: isDefault ? null : app.getApplicationNameForProtocol('https') || null
  }
}

/**
 * How long to wait for the system's confirmation to appear, and how long to
 * leave the panel held once it has.
 */
const CONFIRMATION_APPEARS_MS = 3_000
const CONFIRMATION_ANSWERED_MS = 120_000

/**
 * Holds the panel open while the system asks the user to confirm. That prompt
 * takes key status from the panel — which reaches it as a blur, and a blur
 * closes it (see `holdSettingsWindow`) — and, unlike a sheet this app puts up,
 * there is no call to wrap: it is shown some moments after the request returns.
 *
 * So the hold runs until the panel has lost focus and regained it, which is the
 * prompt being answered, or until the prompt plainly never came.
 */
function holdForConfirmation(window: BrowserWindow): void {
  const release = holdSettingsWindow()
  let timer: ReturnType<typeof setTimeout>

  const done = (): void => {
    clearTimeout(timer)
    window.off('blur', blurred)
    window.off('focus', done)
    window.off('closed', done)
    release()
  }
  const blurred = (): void => {
    // It appeared; wait for it to be answered.
    clearTimeout(timer)
    timer = setTimeout(done, CONFIRMATION_ANSWERED_MS)
    window.once('focus', done)
  }

  window.once('blur', blurred)
  window.once('closed', done)
  timer = setTimeout(done, CONFIRMATION_APPEARS_MS)
}

function panelOf(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || !isSettingsWindow(window) || window.webContents !== event.sender) {
    throw new Error('Only the settings panel can change the default browser.')
  }
  return window
}

export function registerDefaultBrowserIpc(): void {
  ipcMain.handle('defaultBrowser:status', (event): DefaultBrowserStatus => {
    panelOf(event)
    return status()
  })

  ipcMain.handle('defaultBrowser:set', (event): DefaultBrowserStatus => {
    const panel = panelOf(event)
    if (!supported()) throw new Error('This build of Fluid cannot be made the default browser.')

    holdForConfirmation(panel)
    for (const scheme of SCHEMES) {
      if (!app.setAsDefaultProtocolClient(scheme)) {
        throw new Error('The system would not let Fluid become the default browser.')
      }
    }
    return status()
  })
}
