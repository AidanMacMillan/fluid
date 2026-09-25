import { join } from 'path'
import { WebContentsView, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ViewBounds } from './browser-views'

/**
 * A clear pane of glass laid over the page area while a tab is dragged from
 * the sidebar, to catch the drag.
 *
 * The pages under it are native views, and a native view takes every drag
 * event inside its rect for its own page: the drop targets the window draws for
 * splitting would be under them and out of reach. This is a view too — stacked
 * above the pages, transparent, and only there for the length of the drag — so
 * the drag lands here instead, and the pages go on drawing underneath it
 * exactly as they were, live.
 *
 * It knows nothing about splits. It reports where the drag is and where it was
 * let go (see `SplitDropReport`), the window works out what that means from
 * the panes it laid out, and tells it what to draw back (see
 * `SplitDropPreview`). Its page is a renderer build with the shared preload,
 * the way the find bar's is.
 */

/** What the glass reports, in its own coordinates — which is to say the page area's. */
export type SplitDropReport =
  | { kind: 'over'; x: number; y: number }
  | { kind: 'leave' }
  /** `tabId` is the dragged tab as the drag itself names it, when it does. */
  | { kind: 'drop'; x: number; y: number; tabId: string | null }

/** What the glass draws, in its own coordinates. */
export type SplitDropPreview = {
  /** The room the tab would take if let go now, or null for nowhere. */
  box: ViewBounds | null
}

let view: WebContentsView | undefined
let loaded: Promise<void> | undefined

/**
 * The glass, made once and kept. Made ahead of the first drag (see
 * `prepareSplitDrop`) rather than at it: a drag starts the moment the pointer
 * moves, and a page still loading when it reaches the page area would catch
 * nothing.
 */
function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view

  const created = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // Clear, or it would be a slab over every page for as long as the drag lasts.
  created.setBackgroundColor('#00000000')

  view = created
  loaded = (
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? created.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/split-drop.html`)
      : created.webContents.loadFile(join(__dirname, '../renderer/split-drop.html'))
  ).catch(() => undefined)

  return created
}

/** Loads the glass so the first drag finds it ready. */
export function prepareSplitDrop(): void {
  ensureView()
}

/**
 * Lays the glass over `bounds`, above every page. Added again even when it is
 * already up, because being added is what puts a view on top — and a page
 * attached since would otherwise be drawn over it.
 */
export function showSplitDrop(window: BrowserWindow, bounds: ViewBounds): void {
  if (window.isDestroyed()) return
  const glass = ensureView()
  send({ box: null })
  window.contentView.addChildView(glass)
  glass.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  })
}

/** Takes the glass away, the drag being over one way or another. */
export function hideSplitDrop(window: BrowserWindow): void {
  if (!view || window.isDestroyed()) return
  window.contentView.removeChildView(view)
}

/** What the glass should draw now. */
export function previewSplitDrop(preview: SplitDropPreview): void {
  send(preview)
}

function send(preview: SplitDropPreview): void {
  const glass = view
  if (!glass || !loaded) return
  void loaded.then(() => {
    if (!glass.webContents.isDestroyed()) glass.webContents.send('split-drop:preview', preview)
  })
}

/** Throws the glass away with the window it was a child of. */
export function destroySplitDrop(): void {
  if (view && !view.webContents.isDestroyed()) view.webContents.close()
  view = undefined
  loaded = undefined
}
