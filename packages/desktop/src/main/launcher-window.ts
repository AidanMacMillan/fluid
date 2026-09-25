import { join } from 'path'
import { BrowserWindow, Menu, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import { popupProfileMenu } from './profile-menu'
import type { NewTab, NewTaskTemplate } from '@fluid/sdk'

/**
 * The launcher: the panel that opens over everything when a new tab is asked
 * for, and takes either something to search for or one of the places worth
 * going in a keystroke.
 *
 * The same panel answers the question a level up, too: what a new task should
 * be (see `LauncherMode`). Blank, most of the time — which is why that is the
 * row it opens on — but an extension can offer kinds of task that start as
 * something, and this is where they are offered.
 *
 * A window of its own for the same reason settings is one (see
 * src/main/settings-window.ts): browser tabs are native `WebContentsView`s
 * composited above the window's web contents, and nothing the renderer paints
 * can cover one. A panel drawn in the renderer would sit *behind* the page it
 * is supposed to be over.
 *
 * Unlike settings it is not modal. A launcher is dismissed by looking away —
 * clicking the page behind it is how a command palette is told never mind — and
 * a modal child disables its parent at the OS level, so that click would never
 * reach anything. Non-modal buys the blur, and blur is what closes it.
 */

/**
 * Which question the panel is asking: what the new tab should be (Cmd+T), or
 * what the new task should be (Cmd+Shift+T, and the plus at the end of the
 * task strip). One window either way, since it is one field and one list; the
 * mode only decides which rows are in it.
 *
 * Or, a question about a task that already exists: which icon it wears and in
 * what colour (clicking the glyph on its tab). The same field over a grid of
 * icons rather than a list of rows, and drawn by a component of its own (see
 * IconPickerApp.svelte) — but a panel over the window for the same reasons, so
 * the same window.
 */
export type LauncherMode = 'tab' | 'task' | 'icon'

/** How wide the panel is, as a fraction of the window it opens over. */
const PARENT_FRACTION = 0.6

/**
 * The range that fraction is held to. The floor is what a row needs to read as
 * a row — an icon, a name, and an address after it — and the ceiling keeps a
 * full-screen window from stretching a search field across a whole display.
 */
const WIDTH = { min: 420, max: 640 } as const

/**
 * The panel's height while nothing has been typed: the field, and every
 * bookmark under it. The renderer measures what it actually drew and says so
 * (see `resizeLauncherWindow`), so this is only what the window opens at — but
 * it is what the window opens at *before the first paint*, so it is worth being
 * close: the field is 49px with its rule, and each bookmark row 32px in a list
 * padded by 6. Out by a little for one frame is invisible; out by a lot is a
 * panel that visibly settles the moment it appears.
 */
const OPENING_HEIGHT = 160

/**
 * The tallest the panel may get. The list is short and fixed today, so this is
 * headroom rather than a limit that is reached — but the renderer's measurement
 * is the one number here the main process does not control, and a panel taller
 * than the window it floats over is not a panel any more.
 */
const MAX_HEIGHT = 520

/**
 * Where the panel's top edge sits, as a fraction of the way down the window.
 * Not centred, though the panel reads as centred: it grows downwards as rows
 * appear and shrinks upwards as they filter out, and a panel re-centred on
 * every keystroke jitters under the cursor. Anchoring the top instead holds the
 * field still — which is where the user is looking — and puts a full list on
 * the window's middle, which is what "in the middle" means for a panel whose
 * height is the one thing about it that moves.
 */
const TOP_FRACTION = 0.32

/**
 * What the panel settled on. An address is most of what a new tab ever is, but
 * not all of it: a terminal has nowhere to go, and saying so as a kind rather
 * than a magic address keeps the two from having to be told apart by parsing.
 *
 * Deliberately nothing more than the choice itself. Which task the tab joins,
 * and where in that task's strip it lands, is the window's to decide — it is
 * the only side that knows what is selected.
 */
export type LauncherChoice =
  | {
      kind: 'url'
      url: string
      /**
       * Which browsing profile to open it in — see src/main/profiles.ts. Null
       * is the default profile, which is what every row produces unless one was
       * picked from the row's own menu.
       */
      profile: number | null
    }
  /**
   * A tab of a type an extension contributes, from one of the extension's
   * launcher entries (see `LauncherEntry` in the SDK). The entry has already
   * turned what was typed into the tab to open, so all that is left is which
   * task it opens in — which is the window's to say.
   */
  | { kind: 'extension-tab'; tab: NewTab }
  /**
   * One of an extension entry's other answers, picked from the row's menu (see
   * `LauncherAlternative` in the SDK). Named rather than already turned into a
   * tab, because the panel is gone by the time it was picked: the window it
   * opened over asks the extension for the tab itself — and any picker that
   * takes is a sheet on that window, with no panel to hold open behind it.
   * `entry` is `extensionId.entryId`.
   */
  | { kind: 'extension-alternative'; entry: string; alternative: string }
  /**
   * A new task, from the task panel: blank, named, or what one of an
   * extension's new-task entries described (see `NewTaskEntry` in the SDK).
   * Which project it joins is the window's to say, like which task a tab does.
   */
  | { kind: 'task'; task: NewTaskTemplate }

/** One item of a row's menu of other answers, as the panel names it. */
export type LauncherMenuItem = { id: string; label: string }

let launcherWindow: BrowserWindow | undefined

/** Which question the open panel is asking. */
let launcherMode: LauncherMode = 'tab'

/** The task the icon picker is choosing for; null in the other two modes. */
let launcherTaskId: string | null = null

/**
 * How many native things opened from inside the panel are still on screen.
 * While anything is held, looking away is not believed — see the blur handler.
 */
let held = 0

/**
 * Holds the panel open for as long as something native opened from inside it is
 * up, and hands back the release. Callers have to call it, which is what the
 * `finally` around the folder picker in src/main/ipc.ts is for.
 */
export function holdLauncherWindow(): () => void {
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
 * Where the panel sits over a given state of the window it belongs to: centred
 * across it, held a third of the way down it, and sized off its width. Centred
 * on that window rather than on the screen — this opens a tab in that window's
 * task, and a panel that appears away from its app reads as something else's.
 */
function panelBounds(parent: BrowserWindow, height: number): Rectangle {
  const area = parent.getBounds()
  const width = clamp(Math.round(area.width * PARENT_FRACTION), WIDTH.min, WIDTH.max)
  const capped = clamp(height, 1, Math.min(MAX_HEIGHT, area.height))

  return {
    width,
    height: capped,
    x: Math.round(area.x + (area.width - width) / 2),
    // Held inside the window even when the panel is taller than the room below
    // the anchor — a short window would otherwise hang it off the bottom edge.
    y: Math.round(area.y + clamp(area.height * TOP_FRACTION, 0, Math.max(0, area.height - capped)))
  }
}

/**
 * Opens the launcher over `parent`, or brings back the one already up. Asking
 * for it twice is not two panels: Cmd+T with the panel open is the same
 * keystroke arriving again, and focusing what is already there is the only
 * sensible answer.
 *
 * Asking the other question is a change of subject, though — Cmd+Shift+T over
 * the new-tab panel — so that one reloads the panel in the other mode. The
 * same window rather than a new one: closing a panel hands focus back to the
 * window under it, and that arriving after the replacement had been shown
 * would read as looking away from it, and close it too.
 */
export function openLauncherWindow(
  parent: BrowserWindow,
  mode: LauncherMode = 'tab',
  taskId: string | null = null
): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    // Another task's icon is a change of subject too, even in the same mode.
    if (launcherMode !== mode || launcherTaskId !== taskId) {
      launcherMode = mode
      launcherTaskId = taskId
      loadPanel(launcherWindow, mode, taskId)
    }
    launcherWindow.focus()
    return
  }

  opener = parent
  launcherMode = mode
  launcherTaskId = taskId

  const window = new BrowserWindow({
    parent,
    ...panelBounds(parent, OPENING_HEIGHT),
    show: false,
    // No frame and no title bar: the panel is a field and a list, and every
    // pixel of chrome around it would be chrome that says nothing.
    frame: false,
    // Its place and width are derived from the window it opens over, and its
    // height from what it is drawing, so neither is the user's to set.
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Out of the app switcher and off the window menu: this is a panel that is
    // up for a few seconds, not a window to be managed.
    skipTaskbar: true,
    ...(process.platform === 'darwin'
      ? {
          // The same material settings uses, and for the same reason: this is
          // held over the app rather than being more of it.
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

  launcherWindow = window

  // Escape closes it, as a palette should, and Cmd/Ctrl+W with it. Handled here
  // rather than in the panel so it holds however the field is being used — mid
  // composition, with text selected, from the list rather than the input.
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const closing = input.key === 'Escape' || ((input.meta || input.control) && input.key === 'w')
    if (closing) window.close()
  })

  // Looking away is how a launcher is told never mind. It is the whole reason
  // this window is not modal: a modal child disables its parent, so the click
  // that means "not this" would land on a window that cannot answer.
  window.on('blur', () => {
    // Unless something native opened from inside the panel is still up — see
    // `held`. A sheet takes key status from the window it is attached to, and
    // that arrives here as an ordinary blur, so believing it would close the
    // panel out from under the folder picker and take the picker with it.
    if (held > 0) return
    if (!window.isDestroyed()) window.close()
  })

  // The panel is a function of the window it opens over, so it is recomputed
  // whenever that window moves or resizes rather than only at opening.
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

  // Shown only once it has something to show. A palette that appears as an
  // empty slab and fills in afterwards reads as a stall, and this one is meant
  // to be typed into the instant it arrives.
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.on('closed', () => {
    if (!parent.isDestroyed()) {
      parent.off('resize', follow)
      parent.off('move', follow)
    }
    if (launcherWindow === window) {
      launcherWindow = undefined
      opener = undefined
      launcherTaskId = null
    }
  })

  loadPanel(window, mode, taskId)
}

/**
 * Loads the panel's page, asking `mode`'s question — about `taskId`, for the
 * icon picker. Both ride in the query rather than over IPC afterwards: the
 * panel has to draw the right rows on its first paint, which is the one it is
 * shown on.
 */
function loadPanel(window: BrowserWindow, mode: LauncherMode, taskId: string | null): void {
  const query: Record<string, string> = taskId === null ? { mode } : { mode, task: taskId }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const search = new URLSearchParams(query).toString()
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/launcher.html?${search}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/launcher.html'), { query })
  }
}

/**
 * Sizes the panel to what its renderer actually drew. The list grows and
 * shrinks as the query filters it, and the window has to follow or the panel is
 * either clipped or trailing empty glass below the last row.
 */
export function resizeLauncherWindow(height: number): void {
  const window = launcherWindow
  if (!window || window.isDestroyed() || !opener || opener.isDestroyed()) return
  if (!Number.isFinite(height)) return

  const next = panelBounds(opener, Math.round(height))
  if (next.height === window.getBounds().height) return

  window.setResizable(true)
  window.setBounds(next)
  window.setResizable(false)
}

/**
 * Hands the window the panel opened over whatever was chosen, and closes the
 * panel. The choice is all that crosses (see `LauncherChoice`).
 */
export function submitLauncherChoice(choice: LauncherChoice): void {
  const parent = opener
  closeLauncherWindow()
  if (parent && !parent.isDestroyed()) parent.webContents.send('launcher:openTab', choice)
}

/**
 * Asks which profile a row should open in, and opens it there.
 *
 * Routed through here rather than answered in the panel because the panel may
 * not survive being asked: looking away is what closes it, and a native menu
 * appearing over it can be enough to count as looking away. The window the tab
 * is going to is therefore captured before the menu opens, so the choice has
 * somewhere to go even if the panel is gone by the time it is made.
 */
export async function chooseLauncherProfile(url: string): Promise<void> {
  const parent = opener
  const panel = launcherWindow

  const choice = await popupProfileMenu(panel && !panel.isDestroyed() ? panel : (parent ?? null), {
    verb: 'open'
  })
  // Dismissed. The panel is left as it is — still open to go on typing into, or
  // already closed, which is the same "never mind" it would have meant anyway.
  if (choice?.kind !== 'profile') return

  closeLauncherWindow()
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send('launcher:openTab', {
      kind: 'url',
      url,
      profile: choice.profile
    } satisfies LauncherChoice)
  }
}

/**
 * A row's other answers: the same kind of tab, somewhere other than where
 * taking the row opens it (see `LauncherAlternative` in the SDK).
 *
 * Asked for by right-clicking the row, and answered here for the reason
 * `chooseLauncherProfile` gives — the panel may not outlive the question. A
 * native menu over it can be enough to count as looking away. So what was
 * chosen goes to the window the panel opened over, and the panel is closed:
 * whatever the alternative goes on to ask — a folder, say — is asked there.
 */
export async function chooseLauncherAlternative(
  entry: string,
  alternatives: LauncherMenuItem[]
): Promise<void> {
  // Captured before anything opens over the panel: the panel closing clears
  // `opener`, and this is where the tab has to end up.
  const parent = opener

  const alternative = await popupAlternativesMenu(alternatives)
  if (alternative === null) return

  closeLauncherWindow()
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send('launcher:openTab', {
      kind: 'extension-alternative',
      entry,
      alternative
    } satisfies LauncherChoice)
  }
}

/**
 * Pops that menu and answers which item was taken, or null for none.
 * Dismissal and a choice are told apart the way `popupProfileMenu` tells them
 * apart, and for the same reason: which of the click and the close runs first
 * is not something Electron promises, so the close is deferred a turn and a
 * click in that turn wins.
 */
function popupAlternativesMenu(alternatives: LauncherMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    if (alternatives.length === 0) {
      resolve(null)
      return
    }
    let settled = false
    const settle = (id: string | null): void => {
      if (settled) return
      settled = true
      resolve(id)
    }

    const menu = Menu.buildFromTemplate(
      alternatives.map(({ id, label }) => ({ label, click: () => settle(id) }))
    )

    // No `x`/`y`, like every other menu here: left out, it opens at the cursor,
    // which is the row that was right-clicked.
    const window = frontWindow(opener)
    if (window) menu.popup({ window, callback: () => setTimeout(() => settle(null), 0) })
    else menu.popup({ callback: () => setTimeout(() => settle(null), 0) })
  })
}

/**
 * The window a sheet should hang off: the panel while it is still up, and the
 * window it opened over once it is not. Recomputed at each step rather than
 * captured, because the step before may well have been what closed the panel.
 */
function frontWindow(parent: BrowserWindow | undefined): BrowserWindow | null {
  if (launcherWindow && !launcherWindow.isDestroyed()) return launcherWindow
  return parent && !parent.isDestroyed() ? parent : null
}

/** Closes the panel. A no-op if it is already gone. */
export function closeLauncherWindow(): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close()
}
