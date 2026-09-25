import { join } from 'path'
import { BrowserWindow, ClipboardItem, clipboard, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'node:fs'
import { clipboardTask, forgetClipboardChange } from './clipboard-capture'
import { fileListItem } from './clipboard-files'
import { getClipboardEntry } from './db/clipboard'
import { storedFileBytes } from './files'

/**
 * The clipboard panel: everything copied while this task was in front, newest
 * first, opened from the foot of the sidebar or with Cmd+Shift+V.
 *
 * A window of its own for the reason the launcher is one (see
 * src/main/launcher-window.ts): browser tabs are native `WebContentsView`s
 * composited above the window's web contents, so a panel drawn in the renderer
 * would sit *behind* the page it is meant to be over. Everything else about it
 * follows the launcher too — frameless, vibrant, dismissed by looking away, and
 * sized to whatever its renderer actually drew.
 *
 * It is wider and taller than the launcher because its rows carry content
 * rather than choices: a line of what was copied, or a picture of it, where the
 * launcher's rows carry a name and an address.
 */

/** How wide the panel is, as a fraction of the window it opens over. */
const PARENT_FRACTION = 0.62

/**
 * The range that fraction is held to. The floor is what a row of copied text
 * needs before it is all ellipsis; the ceiling stops a full-screen window from
 * turning the panel into a second window rather than something held over one.
 */
const WIDTH = { min: 460, max: 720 } as const

/**
 * What the panel opens at, before its renderer has measured itself: the field,
 * and enough rows under it to read as a list rather than as a box that is still
 * loading. Out by a little for one frame is invisible; out by a lot visibly
 * settles.
 */
const OPENING_HEIGHT = 360

/**
 * The tallest the panel may get. Higher than the launcher's, because this list
 * is genuinely long — a task at its cap holds two hundred entries — and the
 * point of the panel is to scan back through them.
 */
const MAX_HEIGHT = 620

/**
 * Where the panel's top edge sits, as a fraction of the way down the window.
 * Higher than the launcher's, for the same reason it is taller: the list is the
 * substance here rather than something offered under a field, so it is given
 * the room to run down the window instead of being centred in it.
 */
const TOP_FRACTION = 0.16

/** What the panel is looking at. Asked for by the panel as it loads. */
export type ClipboardContext = {
  taskId: string
  /** What to call it in the panel's header. Null for an untitled task. */
  taskTitle: string | null
}

let clipboardWindow: BrowserWindow | undefined

/** The window the panel was opened over, and the one it is dismissed back to. */
let opener: BrowserWindow | undefined

/**
 * Which task the panel that is up is showing. Captured when the panel opens
 * rather than read live, so that a task switched underneath it — by a keyboard
 * shortcut that reached the window behind — does not swap the list out from
 * under somebody reading it.
 */
let context: ClipboardContext | undefined

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Where the panel sits over a given state of the window it belongs to. */
function panelBounds(parent: BrowserWindow, height: number): Rectangle {
  const area = parent.getBounds()
  const width = clamp(Math.round(area.width * PARENT_FRACTION), WIDTH.min, WIDTH.max)
  const capped = clamp(height, 1, Math.min(MAX_HEIGHT, area.height))

  return {
    width,
    height: capped,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + clamp(area.height * TOP_FRACTION, 0, Math.max(0, area.height - capped)))
  }
}

/** What the panel asks for as it loads, having been told nothing at creation. */
export function clipboardContext(): ClipboardContext | null {
  return context ?? null
}

/**
 * Opens the panel over `parent`, or brings back the one already up — asking for
 * it twice is the same keystroke arriving again, and focusing what is there is
 * the only sensible answer.
 *
 * Which task it shows is not a parameter. Both ways in mean the same thing —
 * the task the user is looking at — and that is already known here, pushed from
 * the renderer as it changes (see `setClipboardTask`). A parameter would be a
 * second copy of it, free to disagree with the one the capture is filing
 * against, which is the one disagreement this feature cannot survive.
 *
 * Does nothing at all when there is no task, which is a workspace still
 * loading: a panel onto nothing has nothing to draw.
 */
export function openClipboardWindow(parent: BrowserWindow): void {
  const task = clipboardTask()
  if (!task) return

  context = { taskId: task.id, taskTitle: task.title }

  if (clipboardWindow && !clipboardWindow.isDestroyed()) {
    clipboardWindow.focus()
    return
  }

  opener = parent

  const window = new BrowserWindow({
    parent,
    ...panelBounds(parent, OPENING_HEIGHT),
    show: false,
    frame: false,
    // Its place and size follow the window it opens over and the list it is
    // drawing, so neither is the user's to set.
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

  clipboardWindow = window

  // Escape closes it, and Cmd/Ctrl+W with it — handled here rather than in the
  // panel so it holds wherever focus is inside it, the filter field included.
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const closing = input.key === 'Escape' || ((input.meta || input.control) && input.key === 'w')
    if (closing) window.close()
  })

  // Looking away is how a panel like this is told never mind, which is the
  // whole reason it is not modal: a modal child disables its parent, so the
  // click that means "not this" would land on a window that cannot answer.
  window.on('blur', () => {
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
    if (clipboardWindow === window) {
      clipboardWindow = undefined
      opener = undefined
      context = undefined
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/clipboard.html`)
  } else {
    window.loadFile(join(__dirname, '../renderer/clipboard.html'))
  }
}

/** Sizes the panel to what its renderer actually drew, as the launcher does. */
export function resizeClipboardWindow(height: number): void {
  const window = clipboardWindow
  if (!window || window.isDestroyed() || !opener || opener.isDestroyed()) return
  if (!Number.isFinite(height)) return

  const next = panelBounds(opener, Math.round(height))
  if (next.height === window.getBounds().height) return

  window.setResizable(true)
  window.setBounds(next)
  window.setResizable(false)
}

export function closeClipboardWindow(): void {
  if (clipboardWindow && !clipboardWindow.isDestroyed()) clipboardWindow.close()
}

/**
 * Puts an entry back on the clipboard and closes the panel.
 *
 * Every representation goes back at once — the plain text, the markup exactly
 * as it was copied, the RTF, the picture — so that pasting after a restore
 * behaves as though the original copy had just happened. That is the whole
 * reason the raw markup is stored beside the sanitised copy the panel draws:
 * what is safe to render and what is right to paste are different questions,
 * and only one of them is answered here.
 *
 * The capture baseline is moved on afterwards, or the app's own write would
 * come back around on the next tick as a fresh copy and duplicate the entry it
 * just restored.
 */
export async function restoreClipboardEntry(id: string): Promise<void> {
  const entry = await getClipboardEntry(id)
  if (!entry) return

  if (entry.kind === 'files') {
    // Only the files still there. A path that has gone would paste as nothing
    // in a file manager, and if none are left, writing would only erase what
    // the user has on the clipboard now — the same rule as the empty payload
    // below.
    const paths = entry.text.split('\n').filter((path) => existsSync(path))
    if (paths.length === 0) return
    await clipboard.write([fileListItem(paths)])
    await forgetClipboardChange()
    closeClipboardWindow()
    return
  }

  const image = entry.storageKey ? await storedFileBytes(entry.storageKey) : null

  const payload = {
    ...(entry.text === '' ? {} : { 'text/plain': entry.text }),
    ...(entry.html ? { 'text/html': entry.html } : {}),
    ...(entry.rtf ? { 'text/rtf': entry.rtf } : {}),
    ...(image ? { 'image/png': new Blob([new Uint8Array(image)], { type: 'image/png' }) } : {})
  }

  // An entry with nothing left in it — one whose content was too large to keep,
  // or whose picture has gone from the store. `write` replaces the pasteboard
  // wholesale, so handing it an empty payload would not restore nothing, it
  // would *erase* whatever the user had. The panel disables these rows, but this
  // is the side that must not be talked into it.
  if (Object.keys(payload).length === 0) return

  // Everything the entry has in the one call, for the same reason: a second
  // write would drop what the first put there.
  await clipboard.write([new ClipboardItem(payload)])

  await forgetClipboardChange()
  closeClipboardWindow()
}
