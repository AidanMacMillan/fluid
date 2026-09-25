import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { ViewBounds } from './browser-views'

/**
 * The zoom indicator: the pill that says what the page is scaled to, for the
 * second or so after the scale changes.
 *
 * A `WebContentsView` of its own, for the same reason the launcher is a window
 * of its own (see src/main/launcher-window.ts): a browser tab is a native view
 * composited above the host window's web contents, and nothing the renderer
 * paints can cover one. A pill drawn in the renderer would sit behind the very
 * page whose zoom it is reporting.
 *
 * It is the corner of the page area rather than a badge in the chrome bar
 * because zoom is a property of the page, and the page is where the user is
 * looking when they press the key. Chrome puts its own in the omnibox; there is
 * no room for one here, and the address is centred on the bar besides.
 *
 * The one thing it cannot do is let clicks through. Electron has no
 * pass-through for a child view — `setIgnoreMouseEvents` belongs to
 * `BrowserWindow` — so while the pill is up it takes the pointer over its own
 * rectangle. It is small, it is in a corner, and it detaches the moment it has
 * faded, which is the whole of the mitigation.
 */

/**
 * The pill itself, in the host renderer's CSS pixels. The zoom's width is
 * fixed; the other notices it carries (see `showCopiedIndicator`) each have a
 * fixed width of their own, for the same reason.
 */
const PILL = { width: 58, height: 26 } as const

/** Wide enough for "Copied URL" with the same breathing room as "100%". */
const COPIED_WIDTH = 92

/** The width of whatever the pill is saying right now. */
let pillWidth: number = PILL.width

/**
 * Room left around the pill on every side for its shadow. The view is a hard
 * rectangle — anything drawn outside it is clipped — so the shadow needs the
 * view to be bigger than the thing casting it.
 */
const SHADOW_BLEED = 8

/** How far the pill sits in from the page area's top and right edges. */
const INSET = 12

/** How long the pill stays up after the last change that put it there. */
const LINGER_MS = 1400

/** Kept in step with the transition in the pill's own stylesheet. */
const FADE_MS = 180

/**
 * The pill, as a document. A `data:` URL rather than a fourth entry in the
 * renderer build (see electron.vite.config.ts): the launcher and the settings
 * panel are interfaces, with components and a preload and messages going back;
 * this is a number in a box, and giving it a build entry would mean an IPC
 * channel and a Svelte component to carry one string.
 *
 * Nothing loads from anywhere and no script is inlined — the text and the
 * fade are driven from the main process through `run`, which is the only
 * reason this page has a `#pill` to find.
 *
 * It carries a policy of its own all the same, as the three built pages do
 * (see src/renderer/index.html). A renderer with no policy is one where `eval`
 * is allowed, and Electron says so in the console of every window in a dev
 * run. `'self'` is no use here — a `data:` URL is an opaque origin and matches
 * nothing — so the whole document is `'none'` but for the stylesheet below,
 * which is inline and needs to be named as such. It does not touch `run`:
 * `executeJavaScript` is not page script and is not subject to `script-src`.
 */
const DOCUMENT = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html {
    height: 100%;
  }

  body {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    margin: 0;
    /* The view is transparent so its corners and its shadow fall on the page
       rather than on a grey slab cut out of it. */
    background: transparent;
    cursor: default;
    -webkit-user-select: none;
  }

  #pill {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    /* Fixed rather than fitting the text: the number changes on every press,
       and a box that resized with it would twitch in the corner of the eye. */
    width: ${PILL.width}px;
    padding: 0 10px;
    white-space: nowrap;
    height: ${PILL.height}px;
    border-radius: 8px;
    /* Near-opaque zinc, the chrome's own colour. It sits on whatever the page
       happens to be, so it cannot be as thin as the glass elsewhere and still
       be read. The inner hairline and the shadow are what separate it from a
       page that happens to be dark. */
    background: rgba(24, 24, 27, 0.92);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.12),
      0 2px 8px rgba(0, 0, 0, 0.35);
    color: #f4f4f5;
    font:
      500 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
      sans-serif;
    /* Digits of one width, so 100% and 111% are the same size. */
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transform: scale(0.94);
    transition:
      opacity ${FADE_MS}ms ease,
      transform ${FADE_MS}ms ease;
  }

  #pill.on {
    opacity: 1;
    transform: scale(1);
  }

  @media (prefers-reduced-motion: reduce) {
    #pill,
    #pill.on {
      transform: none;
      transition: none;
    }
  }
</style>
<div id="pill"></div>`

const DOCUMENT_URL = `data:text/html;charset=utf-8,${encodeURIComponent(DOCUMENT)}`

/** The view, made on the first zoom of a session and kept from then on. */
let view: WebContentsView | undefined

/**
 * The load of `DOCUMENT_URL`. Everything drawn into the pill waits on this:
 * the first zoom arrives before the page it writes into exists.
 */
let loaded: Promise<unknown> | undefined

/** The window the view is currently a child of, or undefined while detached. */
let attachedTo: BrowserWindow | undefined

let lingerTimer: NodeJS.Timeout | undefined
let fadeTimer: NodeJS.Timeout | undefined

function clearTimers(): void {
  if (lingerTimer) clearTimeout(lingerTimer)
  if (fadeTimer) clearTimeout(fadeTimer)
  lingerTimer = undefined
  fadeTimer = undefined
}

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view

  const created = new WebContentsView({
    webPreferences: {
      // It renders one string from this process and talks to nothing, so it
      // gets no preload and no node, exactly as a page does.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  // Without this the view is an opaque rectangle punched through the page.
  created.setBackgroundColor('#00000000')

  view = created
  loaded = created.webContents.loadURL(DOCUMENT_URL).catch(() => undefined)
  return created
}

/**
 * Runs a statement in the pill's document once it has one. Swallowing the
 * rejection is deliberate: the view can be torn down between a timer being set
 * and its script arriving, and a pill that missed its fade is not worth a log
 * line.
 */
function run(script: string): void {
  const { webContents } = ensureView()
  void loaded
    ?.then(() => (webContents.isDestroyed() ? undefined : webContents.executeJavaScript(script)))
    .catch(() => undefined)
}

function paint(text: string, width: number): void {
  // The class goes on in the next frame rather than in this one. On the first
  // zoom of a session the element has only just been laid out, and a class
  // added in the same frame as the first style computation has nothing to
  // transition from — the pill would appear at full strength instead of rising.
  run(
    `(() => {
      const pill = document.getElementById('pill')
      pill.textContent = ${JSON.stringify(text)}
      pill.style.width = ${JSON.stringify(`${width}px`)}
      requestAnimationFrame(() => pill.classList.add('on'))
    })()`
  )
}

function fade(): void {
  run(`document.getElementById('pill').classList.remove('on')`)
}

function detach(): void {
  if (!view || !attachedTo) return
  if (!attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
  attachedTo = undefined
}

/**
 * Where the pill goes for a given page area: in from its top-right corner, with
 * the view around it grown by the shadow's bleed on every side.
 *
 * Held inside the area's left edge for the pane too narrow to inset into, which
 * is a real state rather than a hypothetical one — the sidebar can be dragged
 * most of the way across the window.
 */
function pillBounds(area: ViewBounds): Rectangle {
  const width = pillWidth + SHADOW_BLEED * 2
  const height = PILL.height + SHADOW_BLEED * 2

  return {
    width,
    height,
    x: Math.round(Math.max(area.x, area.x + area.width - INSET - pillWidth - SHADOW_BLEED)),
    y: Math.round(area.y + INSET - SHADOW_BLEED)
  }
}

/**
 * Puts the pill over `area` saying `percent`, and starts its clock. Called
 * again for every step of a held key, which is one pill that keeps up rather
 * than a queue of them: the text is rewritten and the clock starts over.
 */
export function showZoomIndicator(window: BrowserWindow, area: ViewBounds, percent: number): void {
  show(window, area, `${percent}%`, PILL.width)
}

/**
 * The same pill, confirming Copy Address. The shortcut otherwise does its work
 * out of sight — the clipboard has no face — and this is the one place over the
 * page that already means "that key did something".
 */
export function showCopiedIndicator(window: BrowserWindow, area: ViewBounds): void {
  show(window, area, 'Copied URL', COPIED_WIDTH)
}

function show(window: BrowserWindow, area: ViewBounds, text: string, width: number): void {
  if (window.isDestroyed()) return
  // No page area is a tab with no page — the pill would land on the chrome.
  if (area.width <= 0 || area.height <= 0) return

  clearTimers()

  pillWidth = width
  const indicator = ensureView()
  indicator.setBounds(pillBounds(area))

  // A child view's place in the stack is the order it was added in, so this
  // relies on nothing being added above it while it is up. Nothing is: the page
  // underneath is only ever re-added on a tab switch, and a tab switch hides
  // the pill (see `hideBrowserView`).
  if (attachedTo !== window) {
    detach()
    window.contentView.addChildView(indicator)
    attachedTo = window
  }

  paint(text, width)

  lingerTimer = setTimeout(() => {
    fade()
    // Detached only once it has faded out, rather than at the same moment:
    // pulling the view mid-transition would cut the pill off rather than let it
    // go. Detached at all because a view that is merely invisible still takes
    // the pointer over its own rectangle.
    fadeTimer = setTimeout(detach, FADE_MS)
  }, LINGER_MS)
}

/**
 * Follows the page area while the pill is up — a window resize, the sidebar
 * sliding out. A no-op the rest of the time, which is nearly always.
 */
export function moveZoomIndicator(area: ViewBounds): void {
  if (!view || !attachedTo) return
  if (area.width <= 0 || area.height <= 0) return
  view.setBounds(pillBounds(area))
}

/**
 * Takes the pill down now, without the fade. For the page it was reporting on
 * going away: a pill that lingered through a tab switch would be telling the
 * user the new page's zoom, and be wrong about it.
 */
export function hideZoomIndicator(): void {
  clearTimers()
  if (!attachedTo) return
  // Off-screen already, so this is not seen — but the class has to come off
  // all the same, or the next zoom finds the pill still marked visible and
  // appears at full strength instead of rising into place.
  fade()
  detach()
}

/** Discards the view. The window it was a child of is going, or already gone. */
export function destroyZoomIndicator(): void {
  clearTimers()
  detach()
  if (view && !view.webContents.isDestroyed()) view.webContents.close()
  view = undefined
  loaded = undefined
}
