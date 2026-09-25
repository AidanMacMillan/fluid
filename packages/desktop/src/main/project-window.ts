import { join } from 'path'
import { BrowserWindow, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ProjectsState } from './projects'

/**
 * The project picker: the panel that opens from the top right of the bar and
 * says which body of work the app is in.
 *
 * A window of its own, frameless and vibrant and dismissed by looking away, for
 * every reason the launcher is one (see src/main/launcher-window.ts) — browser
 * tabs are native `WebContentsView`s composited above the window's web
 * contents, so a panel drawn in the renderer would sit behind the page it is
 * meant to be over.
 *
 * It is deliberately the same panel as the launcher to look at: a field, a list
 * of rows, and a second step for the rows that need something typed. Choosing a
 * project and choosing a tab are the same gesture a level apart, and the
 * picker teaches nothing new by looking different.
 *
 * Unlike the launcher it is anchored rather than centred — see `panelBounds`.
 */

/** How wide the panel is, as a fraction of the window it opens over. */
const PARENT_FRACTION = 0.34

/**
 * The range that fraction is held to. The floor is what a row needs to read as
 * a row — a name with its folder after it — and the ceiling keeps a full-screen
 * window from stretching a short list across a display.
 */
const WIDTH = { min: 320, max: 460 } as const

/**
 * What the panel opens at, before its renderer has measured itself: the field,
 * and a few rows under it. Out by a little for one frame is invisible; out by a
 * lot visibly settles.
 */
const OPENING_HEIGHT = 220

/** The tallest the panel may get, past which the list scrolls. */
const MAX_HEIGHT = 480

/**
 * The window's own title bar, which is the app's top bar — keep in step with
 * `TITLE_BAR_HEIGHT` in src/main/index.ts. The panel hangs off the bar, so it
 * has to know where the bar ends.
 */
const TITLE_BAR = 40

/** How far below that bar the panel hangs, in pixels. */
const DROP = 4

/**
 * How far in from the window's trailing edge the panel sits, in pixels. The
 * button that opens it is inboard of the settings gear, and the panel reads as
 * belonging to that button rather than to the corner.
 */
const INSET = 8

/** What the panel settled on. */
export type ProjectChoice = { kind: 'select'; id: string }

let projectWindow: BrowserWindow | undefined

/**
 * How many native things opened from inside the panel are still on screen.
 * While anything is held, looking away is not believed — see the blur handler.
 */
let held = 0

/**
 * Holds the panel open for as long as something native opened from inside it is
 * up — the folder picker, and the row menu — and hands back the release.
 * Callers have to call it, which is what the `finally`s in src/main/ipc.ts are
 * for.
 */
export function holdProjectWindow(): () => void {
  held += 1
  let released = false
  return () => {
    if (released) return
    released = true
    held -= 1
  }
}

/** The window the panel was opened over, and the one its choice goes back to. */
let opener: BrowserWindow | undefined

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Where the panel sits: hung under the top right of the window it belongs to,
 * where the button that opens it is.
 *
 * Anchored to that corner rather than centred like the launcher, because the
 * two panels answer differently-sized questions. A launcher is the whole of
 * what you are doing for the next second and earns the middle of the window; a
 * project picker is a control in the bar, and a menu that opens away from its
 * control is a menu you have to find.
 */
function panelBounds(parent: BrowserWindow, height: number): Rectangle {
  const area = parent.getBounds()
  const width = clamp(Math.round(area.width * PARENT_FRACTION), WIDTH.min, WIDTH.max)
  const capped = clamp(height, 1, Math.min(MAX_HEIGHT, area.height))

  return {
    width,
    height: capped,
    // Held inside the window: a narrow window would otherwise put the panel
    // half off its own leading edge.
    x: Math.round(area.x + Math.max(0, area.width - width - INSET)),
    y: Math.round(area.y + Math.min(TITLE_BAR + DROP, Math.max(0, area.height - capped)))
  }
}

/**
 * Opens the picker over `parent`, or brings back the one already up. Asking
 * twice is not two panels — the button can be clicked again while it is open,
 * and focusing what is there is the only sensible answer.
 */
export function openProjectWindow(parent: BrowserWindow): void {
  if (projectWindow && !projectWindow.isDestroyed()) {
    projectWindow.focus()
    return
  }

  opener = parent

  const window = new BrowserWindow({
    parent,
    ...panelBounds(parent, OPENING_HEIGHT),
    show: false,
    frame: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...(process.platform === 'darwin'
      ? {
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

  projectWindow = window

  // Escape closes it, and Cmd/Ctrl+W with it. Handled here rather than in the
  // panel so it holds however the field is being used.
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const closing = input.key === 'Escape' || ((input.meta || input.control) && input.key === 'w')
    if (closing) window.close()
  })

  // Looking away is how a panel like this is told never mind — unless something
  // native opened from inside it is still up, which arrives here as an ordinary
  // blur and would otherwise close the panel out from under the folder picker.
  window.on('blur', () => {
    if (held > 0) return
    if (!window.isDestroyed()) window.close()
  })

  const follow = (): void => {
    if (window.isDestroyed()) return
    // A window created non-resizable refuses a new size on macOS; it has to be
    // resizable for the length of the call.
    window.setResizable(true)
    window.setBounds(panelBounds(parent, window.getBounds().height))
    window.setResizable(false)
  }
  parent.on('resize', follow)
  parent.on('move', follow)

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.on('closed', () => {
    if (!parent.isDestroyed()) {
      parent.off('resize', follow)
      parent.off('move', follow)
    }
    if (projectWindow === window) {
      projectWindow = undefined
      opener = undefined
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/project.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/project.html'))
  }
}

/** The panel, for a native menu or dialog that should be parented to it. */
export function projectPanel(): BrowserWindow | null {
  return projectWindow && !projectWindow.isDestroyed() ? projectWindow : (opener ?? null)
}

/** Sizes the panel to what its renderer actually drew, as the launcher's does. */
export function resizeProjectWindow(height: number): void {
  const window = projectWindow
  if (!window || window.isDestroyed() || !opener || opener.isDestroyed()) return
  if (!Number.isFinite(height)) return

  const next = panelBounds(opener, Math.round(height))
  if (next.height === window.getBounds().height) return

  window.setResizable(true)
  window.setBounds(next)
  window.setResizable(false)
}

/**
 * Hands the window the panel opened over the project that was chosen, and
 * closes the panel. The window is the one that knows what to do with it: the
 * strip it draws is that project's tasks.
 */
export function submitProjectChoice(choice: ProjectChoice): void {
  const parent = opener
  closeProjectWindow()
  if (parent && !parent.isDestroyed()) parent.webContents.send('project:selected', choice)
}

/**
 * Tells the window that the projects themselves have changed — one renamed,
 * repointed or deleted — without moving it anywhere. The panel stays open: the
 * user is still in the picker, looking at the list they just changed.
 *
 * A deletion may well move the window all the same, but that is the window's
 * decision, not this one's: it is the side that knows whether the project that
 * went is the one it is drawing.
 */
export function announceProjectsChanged(state: ProjectsState): void {
  if (opener && !opener.isDestroyed()) opener.webContents.send('project:changed', state)
}

/** Closes the panel. A no-op if it is already gone. */
export function closeProjectWindow(): void {
  if (projectWindow && !projectWindow.isDestroyed()) projectWindow.close()
}
