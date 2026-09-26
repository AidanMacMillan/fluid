import { join } from 'path'
import { BrowserWindow, shell, type Rectangle, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Settings is a window of its own rather than something the renderer draws.
 *
 * It has to be: browser tabs are native `WebContentsView`s composited above the
 * window's web contents, and nothing the renderer paints — not even a top-layer
 * `<dialog>` — can cover one. A modal drawn in the renderer could only appear by
 * taking the page down first, so opening settings made the page vanish.
 *
 * A separate window sidesteps that entirely, and is better for it: the page
 * keeps rendering underneath, and the panel's vibrancy blurs the app behind it,
 * which a CSS filter cannot do across two native surfaces.
 *
 * Not modal, for the same reason the launcher is not (see
 * src/main/launcher-window.ts): a panel held over the app is dismissed by
 * looking away, and a modal child is disabled at the OS level — the parent
 * reports `isEnabled() === false`, and even a programmatic `focus()` on it is
 * refused — so the click that means "never mind" would never reach anything.
 * Non-modal buys the blur, and blur is what closes it. Nothing is lost by
 * leaving: every setting is written the moment it is entered, so there is
 * nothing here to confirm and nothing to discard.
 */

/**
 * How much of the window it belongs to the panel takes up. The rest is the
 * margin around it — proportional rather than fixed, so the app stays visible
 * around the panel at any window size instead of the panel swallowing a small
 * window whole and rattling around inside a large one.
 */
const PARENT_FRACTION = 0.8

/**
 * The range that fraction is held to. The floor is what the panel needs to lay
 * out — a sidebar and a column of settings beside it — and wins over the margin
 * when the window is at its own minimum; the ceiling stops a full-screen window
 * from stretching a one-card panel across a whole display.
 */
const MIN_SIZE = { width: 560, height: 400 }
const MAX_SIZE = { width: 900, height: 640 }

let settingsWindow: BrowserWindow | undefined

/** Whether `window` is the settings panel. */
export function isSettingsWindow(window: BrowserWindow): boolean {
  return window === settingsWindow && !window.isDestroyed()
}

/**
 * How many native things opened from inside the panel are still on screen.
 *
 * A sheet takes key status from the window it is attached to, which reaches
 * this window as a blur like any other — and closing the panel out from under
 * a sheet would take the sheet with it. While anything is held, looking away is
 * not believed.
 */
let held = 0

/**
 * Holds the panel open for as long as something native opened from inside it is
 * up, and hands back the release. Callers have to call it, which is what the
 * `finally` around such a call in src/main/ipc.ts is for — see the project
 * picker's own hold, which is the same arrangement with callers today.
 */
export function holdSettingsWindow(): () => void {
  held += 1
  let released = false
  return () => {
    if (released) return
    released = true
    held -= 1
  }
}

/**
 * Where the panel sits for a given state of the window it belongs to: centred
 * on it, and sized off it. Centred on that window rather than on the screen —
 * it is this window's settings, and a panel that opens away from its app reads
 * as something else's.
 */
function panelBounds(parent: BrowserWindow): Rectangle {
  const area = parent.getBounds()
  const width = clamp(Math.round(area.width * PARENT_FRACTION), MIN_SIZE.width, MAX_SIZE.width)
  const height = clamp(Math.round(area.height * PARENT_FRACTION), MIN_SIZE.height, MAX_SIZE.height)

  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Closes the panel on Escape or Cmd/Ctrl+W typed into `contents`: its own page,
 * or an extension's section laid over it (see src/main/settings-views.ts),
 * which has the keyboard while it is being typed into.
 */
export function closeOnDismissKeys(window: BrowserWindow, contents: WebContents): void {
  contents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const closing = input.key === 'Escape' || ((input.meta || input.control) && input.key === 'w')
    if (closing && !window.isDestroyed()) window.close()
  })
}

export function openSettingsWindow(parent: BrowserWindow): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  const window = new BrowserWindow({
    parent,
    ...panelBounds(parent),
    show: false,
    // No frame at all rather than a hidden title bar: the panel is a nav and a
    // column of cards, and a strip of chrome above them would say nothing. It
    // is left by clicking the app behind it, by Escape, or by Cmd+W.
    frame: false,
    // Its size and place are derived from the window it belongs to, so neither
    // is the user's to change: dragging it off-centre or resizing it would only
    // be undone the next time the app window moved.
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Out of the app switcher and off the window menu: this is a panel that is
    // up while it is being used, not a window to be managed.
    skipTaskbar: true,
    ...(process.platform === 'darwin'
      ? {
          // The same material the launcher uses, and for the same reason: this
          // is held over the app rather than being more of it.
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000'
        }
      : { backgroundColor: '#18181b' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  settingsWindow = window

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell
        .openExternal(url)
        .catch((error) => console.error('Could not open settings link:', error))
    }
    return { action: 'deny' }
  })

  // Escape closes it, as a panel should, and Cmd/Ctrl+W with it. Handled here
  // rather than in the panel so it holds wherever focus happens to be — inside
  // the token field included.
  closeOnDismissKeys(window, window.webContents)

  // Looking away is how the panel is told never mind — the same gesture the
  // launcher answers to, and the reason neither of them is modal. Suspended
  // while a native sheet opened from inside the panel is up (see `held`).
  window.on('blur', () => {
    if (held > 0) return
    if (!window.isDestroyed()) window.close()
  })

  // The panel is a function of the window it belongs to, so it is recomputed
  // whenever that window changes rather than only at opening.
  const follow = (): void => {
    if (window.isDestroyed()) return
    // A window created non-resizable refuses a new size on macOS; it has to be
    // resizable for the length of the call.
    window.setResizable(true)
    window.setBounds(panelBounds(parent))
    window.setResizable(false)
  }
  parent.on('resize', follow)
  parent.on('move', follow)

  // Shown only once it has something to show: a panel that appears as an empty
  // pane and fills in afterwards looks like a stall.
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.on('closed', () => {
    // These outlive the window they were attached for otherwise, and every
    // later opening would add another pair.
    if (!parent.isDestroyed()) {
      parent.off('resize', follow)
      parent.off('move', follow)
    }
    if (settingsWindow === window) settingsWindow = undefined
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/settings.html'))
  }
}
