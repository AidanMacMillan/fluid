import { join } from 'path'
import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { ViewBounds } from './browser-views'

/**
 * The find bar: the strip that opens in the corner of the page on Cmd+F, takes
 * what to look for, and steps through the matches.
 *
 * A `WebContentsView` of its own, for the reason the zoom pill is one (see
 * src/main/zoom-indicator.ts): a browser tab is a native view composited above
 * the host window's web contents, and nothing the renderer paints can cover
 * one. A bar drawn in the renderer would sit behind the very page it is
 * searching.
 *
 * Unlike the pill it is an interface rather than a number in a box — a field to
 * type into, three buttons, and a count coming back — so it is a page of the
 * renderer build with the shared preload behind it, the way the launcher and
 * the settings panel are (see electron.vite.config.ts). The pill's `data:` URL
 * was worth it for one string; a field would mean rebuilding text input,
 * hover states and focus by hand in a document with no bundler behind it.
 *
 * What it is not is a window. The launcher is one because it is dismissed by
 * looking away and needs a blur to hear that; this is dismissed by Escape and
 * by its own close button, and stays up while the page behind it is clicked,
 * scrolled and read — which is exactly the behaviour a child window would have
 * to fight, on top of carrying its own shadow and following the host window
 * move for move.
 *
 * It sits in the page's top-right corner rather than under the address bar,
 * where Chrome and Safari put theirs, because that bar is the renderer's and
 * this is not: a strip drawn to read as part of the chrome but composited over
 * the page would part company with it by a pixel on every resize. In the
 * corner it reads as what it is — something held over the page — and it is the
 * corner the zoom pill already uses for the same reason.
 *
 * The one thing it cannot do, again like the pill, is let clicks through:
 * Electron has no pass-through for a child view. While the bar is up it takes
 * the pointer over its own rectangle, which is why closing it detaches it
 * rather than merely hiding it.
 */

/** What the bar knows about the search, and all it is ever told. */
export type FindResult = {
  /** How many times the query occurs in the page. */
  matches: number
  /** Which of those is the current one, counting from one. Zero for none. */
  active: number
}

/** The bar itself, in the host renderer's CSS pixels. Kept in step with FindApp. */
const BAR = { width: 340, height: 36 } as const

/**
 * Room left around the bar on every side for its shadow. The view is a hard
 * rectangle — anything drawn outside it is clipped — so the shadow needs the
 * view to be bigger than the thing casting it. Kept tight because every pixel
 * of it is transparent and still swallows clicks meant for the page.
 */
const SHADOW_BLEED = 10

/** How far the bar sits in from the page area's top and right edges. */
const INSET = 12

/** The gap left under the bar for anything else that wants the same corner. */
const GAP = 8

/**
 * The view, made on the first Cmd+F of a session and kept from then on. Kept
 * because the first open is the one that pays for the load, and a bar that is
 * typed into the instant it appears cannot afford to pay it twice.
 */
let view: WebContentsView | undefined

/** The load of the bar's page. Everything sent to it waits on this. */
let loaded: Promise<unknown> | undefined

/** The window the view is currently a child of, or undefined while detached. */
let attachedTo: BrowserWindow | undefined

/** Whether the bar is up. Read by `reserveForFindBar`, which runs either way. */
let open = false

/**
 * What the bar's own outs call — Escape and the close button. Held here rather
 * than passed along with each message because Escape is caught in this module
 * (see `ensureView`) and has no other way back to the page being searched.
 */
let closeHandler: (() => void) | undefined

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view

  const created = new WebContentsView({
    webPreferences: {
      // The same preload the launcher and the settings panel get, and so the
      // same `window.api`. The bar uses one corner of it (see `find` there).
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // Escape, wherever the bar's focus happens to be. Caught on the view's own
  // contents rather than inside the page it loads, for the reason the launcher
  // catches its own (see src/main/launcher-window.ts): it has to hold however
  // the field is being used — mid composition, with text selected, from a
  // button rather than from the input.
  created.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    closeHandler?.()
  })

  // Without this the view is an opaque rectangle punched through the page: the
  // bar is a rounded strip inside a larger transparent rect, and both the
  // corners and the shadow fall on whatever the page happens to be.
  created.setBackgroundColor('#00000000')

  view = created
  loaded =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? created.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/find.html`)
      : created.webContents.loadFile(join(__dirname, '../renderer/find.html'))
  loaded = loaded.catch(() => undefined)

  return created
}

/**
 * Sends the bar a message once it has a page to receive one. Swallowing the
 * rejection is deliberate: the view can be torn down between a result arriving
 * and its message landing, and a count that missed its bar is not worth a log
 * line.
 */
function send(channel: string, payload: unknown): void {
  const { webContents } = ensureView()
  void loaded
    ?.then(() => {
      if (!webContents.isDestroyed()) webContents.send(channel, payload)
    })
    .catch(() => undefined)
}

/**
 * Where the bar goes for a given page area: in from its top-right corner, with
 * the view around it grown by the shadow's bleed on every side.
 *
 * Held inside the area's left edge for the pane too narrow to inset into, which
 * is a real state rather than a hypothetical one — the sidebar can be dragged
 * most of the way across the window.
 */
function barBounds(area: ViewBounds): Rectangle {
  return {
    width: BAR.width + SHADOW_BLEED * 2,
    height: BAR.height + SHADOW_BLEED * 2,
    x: Math.round(Math.max(area.x, area.x + area.width - INSET - BAR.width - SHADOW_BLEED)),
    y: Math.round(area.y + INSET - SHADOW_BLEED)
  }
}

/**
 * The page area with the strip the bar occupies taken off the top, for whatever
 * else wants that corner — today the zoom pill, which is positioned off the
 * area it is given and so drops below the bar without having to know it exists
 * (see src/main/zoom-indicator.ts). The area unchanged while the bar is closed,
 * which is nearly always.
 */
export function reserveForFindBar(area: ViewBounds): ViewBounds {
  if (!open) return area
  const reserved = BAR.height + GAP
  return { ...area, y: area.y + reserved, height: Math.max(0, area.height - reserved) }
}

/** Whether the bar is currently up. */
export function isFindBarOpen(): boolean {
  return open
}

/**
 * Puts the bar over `area` and gives it the keyboard, with `query` in its field
 * and selected — so a second Cmd+F over an open bar is "search for something
 * else" rather than a keystroke that does nothing, which is what Chrome and
 * Safari both do with it.
 *
 * `onClose` is how the bar's own outs — Escape, the close button — get back to
 * the module that owns the page being searched. Held rather than passed through
 * every call because Escape is caught here (see below) and has no other way
 * back.
 */
export function showFindBar(
  window: BrowserWindow,
  area: ViewBounds,
  query: string,
  onClose: () => void
): void {
  if (window.isDestroyed()) return
  // No page area is a tab with no page — the bar would land on the chrome.
  if (area.width <= 0 || area.height <= 0) return

  const bar = ensureView()
  bar.setBounds(barBounds(area))

  // A child view's place in the stack is the order it was added in, so a bar
  // that is already attached is already on top: re-adding it is both needless
  // and a way to lose the focus it has.
  if (attachedTo !== window) {
    detach()
    window.contentView.addChildView(bar)
    attachedTo = window
  }

  // Before the message rather than after it: `reserveForFindBar` is read by
  // whatever the caller moves next, and it answers off this flag.
  open = true
  closeHandler = onClose

  send('find:open', { query } satisfies { query: string })
  // The view has to hold the keyboard for the field inside it to get a
  // keystroke; the field focuses itself when the message above lands. Both are
  // needed — the page had the keyboard until this moment.
  void loaded?.then(() => {
    if (open && !bar.webContents.isDestroyed()) bar.webContents.focus()
  })
}

/**
 * Follows the page area while the bar is up — a window resize, the sidebar
 * sliding out. A no-op the rest of the time.
 */
export function moveFindBar(area: ViewBounds): void {
  if (!open || !view || !attachedTo) return
  if (area.width <= 0 || area.height <= 0) return
  view.setBounds(barBounds(area))
}

/** The count, on its way from the page to the field that asked for it. */
export function reportFindResult(result: FindResult): void {
  if (!open) return
  send('find:result', result)
}

/**
 * Takes the bar down. Detached rather than merely hidden, because a view that
 * is invisible still takes the pointer over its own rectangle — and this one
 * covers the corner of the page.
 */
export function hideFindBar(): void {
  open = false
  closeHandler = undefined
  detach()
}

function detach(): void {
  if (!view || !attachedTo) return
  if (!attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
  attachedTo = undefined
}

/** Discards the view. The window it was a child of is going, or already gone. */
export function destroyFindBar(): void {
  hideFindBar()
  if (view && !view.webContents.isDestroyed()) view.webContents.close()
  view = undefined
  loaded = undefined
}
