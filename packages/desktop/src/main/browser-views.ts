import {
  BrowserWindow,
  WebContentsView,
  clipboard,
  session,
  shell,
  type BaseWindow,
  type HandlerDetails,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { attachContextMenu } from './context-menu'
import { adBlocker } from './ad-blocking'
import { ADBLOCK_PRELOAD } from './adblocker'
import { fileViewer, fileViewerFor, whenContributionsChange } from './api/contributions'
import { isIsolated, mayOpenOutside } from './api/isolation-policy'
import {
  adoptExtensionView,
  adoptWebView,
  EXTENSION_VIEW_PRELOAD,
  extensionPartition,
  extensionViewUrl,
  extensionWebPartition,
  fileViewType,
  forgetWebViewUrl,
  isWebView,
  prepareExtensionSession,
  setAppFocused,
  viewTypeOf,
  webViewUrlOf
} from './extension-views'
import { getTab } from './db/tabs'
import { fileUrl, mimeTypeOf, registerFileProtocolOn } from './files'
import {
  destroyFindBar,
  hideFindBar,
  isFindBarOpen,
  moveFindBar,
  reportFindResult,
  reserveForFindBar,
  showFindBar
} from './find-bar'
import { isMiniplayerFrame } from './miniplayer-agent'
import {
  armMiniplayer,
  enterMiniplayer,
  closeMiniplayer,
  floatingOwner,
  floatingTabIds,
  forgetMiniplayer,
  leaveMiniplayer,
  onFloatingChanged,
  openMiniplayerWindow,
  popIn,
  popOut,
  poppedOutTabId
} from './miniplayer'
import type { TaskFocus } from './notifications'
import { isEphemeralProfile } from './profiles'
import { partitionFor, sameBrowsingContext, type BrowsingContext } from './browsing'
import { fetchIcon, rememberSiteIcon } from './site-icons'
import { destroySplitDrop, prepareSplitDrop } from './split-drop'
import {
  destroyZoomIndicator,
  hideZoomIndicator,
  moveZoomIndicator,
  showCopiedIndicator,
  showZoomIndicator
} from './zoom-indicator'
import { isWebAddress, type NativeFileViewDeclaration, type WebViewDeclaration } from '@fluid/sdk'

/** A rect in the host renderer's CSS pixels, relative to the window content. */
export type ViewBounds = { x: number; y: number; width: number; height: number }

/**
 * The page area as the renderer measured it, with what it needs to be carried
 * through a window resize the renderer has not caught up with yet: the size of
 * the window it was measured in, and how the rect sits in it. `fill` is a page
 * area that stretches with the window, which is almost always; `center` is a
 * document held at a width of its own in the middle of the well (see
 * BrowserSurface), which moves by half of any change and keeps its width.
 */
export type MeasuredBounds = ViewBounds & {
  viewport: { width: number; height: number }
  anchor: 'fill' | 'center'
  /**
   * How much of a change in the window's size each edge of the pane takes, as
   * a fraction of it. Left out for a pane that has the whole well to itself,
   * which is `FULL_SPAN`: the left and top edges stay where they are and the
   * others move with the window. A pane in a split takes its share instead —
   * the right half of a row moves its left edge by half of any change in
   * width, and its right edge by all of it.
   */
  span?: { left: number; right: number; top: number; bottom: number }
}

const FULL_SPAN = { left: 0, right: 1, top: 0, bottom: 1 }

/**
 * A navigation that produced no page. Electron ships Chromium's engine but not
 * Chrome's net-error pages — those live in the browser layer Electron replaces
 * — so a refused connection or a timed-out gateway commits an empty document
 * and the window simply goes blank. This is what the renderer draws in its
 * place.
 */
export type PageError = {
  /**
   * `net` for a request that never produced a response — the address would not
   * resolve, the connection was refused, the certificate was rejected. `http`
   * for a response that arrived with an error status and an empty body, which
   * is the blank half of a 502 or 504.
   */
  kind: 'net' | 'http'
  /** Chromium's net error code (negative), or the HTTP status. */
  code: number
  /** Chromium's symbolic name, or the HTTP status text. Diagnostic, not prose. */
  detail: string
  /** The address that failed, which outlives whatever the tab shows now. */
  url: string
}

/** What the host renderer needs to draw a tab's row and its browser chrome. */
export type BrowserViewState = {
  tabId: string
  url: string
  title: string
  /** The page's icon as a `data:` URL, or null while none has resolved. */
  favicon: string | null
  loading: boolean
  audible: boolean
  audioMuted: boolean
  /**
   * How far the load now running has got, 0–1, or null when nothing is
   * loading. The landmarks are real — see `loadProgress` — and there is
   * nothing between them: a load is not a download, and no one counts the
   * bytes of a page on their way in.
   */
  progress: number | null
  canGoBack: boolean
  canGoForward: boolean
  /** Set while the tab's last navigation failed; null the moment one starts. */
  error: PageError | null
}

/**
 * A page asked for a new window, and it should become a tab. The main process
 * knows which tab the asking page is, but not which task that tab belongs to,
 * so placing it is the renderer's to do.
 */
export type OpenTabRequest = {
  /** The browser tab whose page asked. Its task is where the new tab goes. */
  sourceTabId: string
  url: string
  /** Cmd-click and middle-click, which want the tab without leaving the page. */
  background: boolean
  /**
   * The browsing profile the new tab opens in. Inherited from the asking tab
   * unless the user picked one from the link's own menu, which is the rule that
   * makes profiles usable: open one page in a profile and everything you follow
   * from it stays in that profile, without being asked again.
   */
  profile: number | null
}

// The page sits directly under the chrome bar, so its top edge is a seam with
// the bar rather than an outer edge of the window: rounding it would cut two
// notches out of the address bar's underside. Electron's radius is uniform —
// a view cannot be square on top and rounded below — so the page is square all
// round, and the well it sits in is rounded only where the chrome bar is.
const CORNER_RADIUS = 0

// The host window is transparent on purpose (see src/main/index.ts), so an
// opaque view background would punch a rectangle through the glass before the
// page has painted anything. This is only what a view starts out as: the
// moment a document is ready it gets a canvas to paint on (see `paintCanvas`).
const VIEW_BACKGROUND = '#00000000'

/**
 * What a view is showing. Nearly every one is a `page` — somewhere on the web,
 * with an address bar above it and the run of the internet in front of it.
 *
 * A `file` is the other thing a `WebContentsView` is good for: one stored
 * file, rendered by the same engine, for a file viewer that asked for it to be
 * (see `NativeFileViewDeclaration`) — HTML and PDF, today, since neither is a
 * format anything else can honestly draw. Chromium is both a browser and a PDF
 * viewer, and a view needs nothing said to it to be the second — navigate one
 * to an `application/pdf` response and PDFium renders it, with the toolbar,
 * page thumbnails, find, print, text selection and accessibility Chrome has.
 * (`webPreferences.plugins` is not what turns that on. It governs plugin
 * content embedded in a page, and a top-level PDF renders with or without it.)
 *
 * A file differs from a page in the two ways that matter — it runs in a
 * session of its own, and it cannot navigate (see `lockToDocument`) — and is
 * otherwise the same view, so it keeps the canvas, the context menu, the zoom
 * and the popup handling without any of that being written twice.
 *
 * The last two are an extension's. `extension` is a page of the app's own,
 * drawing an extension's interface through a bridge (see
 * src/main/extension-views.ts). `web-app` is an application an extension
 * points a tab at — an editor's workbench, served from localhost by a process
 * the extension runs. Like a document it has a session of its own and belongs
 * to no browsing profile; unlike one it is a live application that navigates,
 * opens windows and signs into things, so it keeps the page machinery rather
 * than being locked down. What it does not keep is the browser chrome — an
 * application has no address to show — and it can take the keyboard away from
 * the app's own menu. See `extensionWebPartition` and `WebViewDeclaration`.
 */
type ViewKind = 'page' | 'file' | 'extension' | 'web-app'

/**
 * The session a file viewer's files render in, one per extension. Never the
 * app's own: a file arrives from outside — dropped in from a designer,
 * downloaded off a ticket — and an HTML one is script the app did not write.
 * Given the default session it would run against the cookies every browser tab
 * is signed in with; given this one it runs against an empty jar.
 *
 * An `ephemeral` one has no `persist:` prefix, for the same reason incognito
 * has none: Chromium keeps an unprefixed partition in memory, so whatever a
 * document stores is gone when the app is.
 *
 * A `persisted` one is for Chromium's own viewers. It renders a PDF by handing
 * the response to the viewer that ships with it, which is a built-in
 * extension, and Electron registers that extension on persisted sessions only.
 * In an in-memory partition the extension's frame is still created and the
 * navigation still reports success, but the frame that loads the file is never
 * made and the tab shows a blank white page. There is nothing to catch: no
 * failed load, no error event, no empty document. Only the pixels say so. What
 * such a session keeps is the viewer's own zoom, and nothing about the file.
 */
function fileViewPartition(
  extensionId: string,
  kept: NativeFileViewDeclaration['session']
): string {
  return kept === 'persisted' ? `persist:file-view-${extensionId}` : `file-view-${extensionId}`
}

/**
 * tab id → the file viewer drawing it natively, for every `file` view. Set
 * before the view is made, since the partition is read off it, and what lets a
 * viewer that goes take its views with it.
 */
const nativeFileViewers = new Map<string, string>()

/** The session a `file` view of `tabId` runs in, from the viewer drawing it. */
function nativeFilePartition(tabId: string): string {
  const viewerId = nativeFileViewers.get(tabId)
  const viewer = viewerId ? fileViewer(viewerId) : undefined
  if (!viewer || viewer.contribution.view.kind !== 'native') {
    throw new Error(`No native file viewer recorded for ${tabId}.`)
  }
  return fileViewPartition(viewer.extensionId, viewer.contribution.view.session)
}

/**
 * The session a view runs in. Only a `page` answers with a browsing context:
 * the others each have a session fixed by what they are, and where a page is
 * signed in is a fact about browsing rather than about a view.
 */
function partitionForKind(
  kind: ViewKind,
  context: BrowsingContext,
  tabId: string
): string | undefined {
  if (isExtensionKind(kind)) {
    const recorded = extensionTabTypes.get(tabId)
    const extensionId = recorded ? viewTypeOf(recorded)?.extensionId : undefined
    if (!extensionId) throw new Error(`No extension type recorded for ${tabId}.`)
    return kind === 'web-app' ? extensionWebPartition(extensionId) : extensionPartition(extensionId)
  }
  if (kind === 'file') return nativeFilePartition(tabId)
  return partitionFor(context.space, context.profile)
}

/**
 * The context a view gets when nothing named one: the app's own session. What
 * the three kinds that are not pages are given, since their partition comes
 * from what they are, and what a tab with no view on record falls back to.
 */
const DEFAULT_CONTEXT: BrowsingContext = { space: null, profile: null }

/**
 * What a browser paints behind a document that declares no background of its
 * own. Plenty of pages leave `html` and `body` transparent and rely on the
 * canvas underneath being there — without one they would composite against the
 * window's glass, which is not a background any page was written for.
 *
 * Two colours because that is what Chromium does: white for a document in the
 * light scheme, and its dark canvas — a near-black grey, not black — for one
 * using the dark scheme.
 */
const CANVAS_LIGHT = '#ffffff'
const CANVAS_DARK = '#121212'

/**
 * Whether the document ended up in the dark colour scheme — the same answer
 * Chromium gives itself when choosing which canvas to paint.
 *
 * The OS preference alone is not it: `prefers-color-scheme` reports what the
 * user would like, not what the page agreed to. A page is light unless it opts
 * in to dark through `color-scheme` — on the root element, or failing that the
 * `<meta name="color-scheme">` tag — and only then does the preference decide,
 * and only between the schemes the page listed.
 */
const DOCUMENT_PREFERS_DARK = `(() => {
  const root = document.documentElement
  let declared = root ? getComputedStyle(root).colorScheme : 'normal'
  if (!declared || declared === 'normal') {
    declared = document.querySelector('meta[name="color-scheme"]')?.content ?? ''
  }
  const schemes = declared.toLowerCase().split(/[\\s,]+/)
  if (!schemes.includes('dark')) return false
  if (!schemes.includes('light')) return true
  return matchMedia('(prefers-color-scheme: dark)').matches
})()`

let hostWindow: BrowserWindow | undefined

/** tab id → the view rendering it. Views outlive deselection; only closing a tab destroys one. */
const views = new Map<string, WebContentsView>()

/**
 * tab id → the browsing context its view was created in: which space, and which
 * profile within it. Held here rather than read back off the view because it is
 * needed for tabs whose view is gone, and because a partition string is not
 * something Electron hands back.
 *
 * Same lifetime as the view: a tab's context is fixed when its view is made,
 * and a tab whose project moves to another space has its view rebuilt rather
 * than repartitioned (see `attach`).
 */
const tabContexts = new Map<string, BrowsingContext>()

/**
 * tab id → what its view is showing, for the few places where an extension's
 * view has to be handled differently from a page: where a popup is placed,
 * whether the chrome hears about it, whether its address can be copied. Kept
 * here rather than read back off the view for the reason `tabContexts` is — a
 * kind is fixed when a view is created and Electron hands nothing back that
 * names it.
 */
const viewKinds = new Map<string, ViewKind>()

/** Whether a view of this kind draws one of an extension's tabs. */
function isExtensionKind(kind: ViewKind | undefined): kind is 'extension' | 'web-app' {
  return kind === 'extension' || kind === 'web-app'
}

/**
 * tab id → the extension view type its view draws (see `viewTypeOf`), for
 * every `extension` and `web-app` view: a tab type, or a file viewer's. Set
 * before the view is made, since the partition is read off it.
 */
const extensionTabTypes = new Map<string, string>()

/** How a `web-app` view's type asked to be drawn, while that type is registered. */
function webViewDeclarationOf(tabId: string): WebViewDeclaration | undefined {
  const type = extensionTabTypes.get(tabId)
  const declaration = type ? viewTypeOf(type)?.declaration : undefined
  return declaration && isWebView(declaration) ? declaration : undefined
}

/**
 * How many extension views are kept once they are out of sight, counting the
 * one on screen. Each is a renderer process of its own, which a page in a
 * browser tab also is — but a page is somewhere the user went and expects to
 * find as they left it, where an extension's view can always be drawn again
 * from the workspace and its main half. So these, unlike pages, are let go of:
 * the least recently shown first, once there are more than this.
 */
const WARM_EXTENSION_VIEWS = 3

/** Extension views by when they were last shown, the most recent last. */
const extensionViewsByRecency: string[] = []

/** Notes that `tabId` was just shown, and lets go of whichever views that leaves over the budget. */
function touchExtensionView(tabId: string): void {
  const index = extensionViewsByRecency.indexOf(tabId)
  if (index !== -1) extensionViewsByRecency.splice(index, 1)
  extensionViewsByRecency.push(tabId)

  while (extensionViewsByRecency.length > WARM_EXTENSION_VIEWS) {
    const oldest = extensionViewsByRecency.find((candidate) => !attached.has(candidate))
    if (oldest === undefined) break
    destroyBrowserView(oldest)
  }
}

// A type that goes — its extension disabled, updated or failing — takes its
// views with it. What is left of the tab is the pane's "not enabled" message,
// which the renderer draws once the type is no longer listed.
whenContributionsChange(() => {
  for (const [tabId, type] of extensionTabTypes) {
    if (!viewTypeOf(type)) destroyBrowserView(tabId)
  }
  // The same for a file drawn natively. A file whose viewer has gone is shown
  // as one nothing can draw, or is drawn by whichever viewer claims it now.
  for (const [tabId, viewerId] of nativeFileViewers) {
    if (!fileViewer(viewerId)) destroyBrowserView(tabId)
  }
})

/**
 * The windows pages opened for themselves — the sized `window.open` of a SAML
 * or OAuth flow, and anything those go on to open (see `handleWindowOpen`).
 * Tracked so that a page-level shortcut fired while one of them is in front
 * acts on that page rather than on the tab hidden behind it.
 */
const popups = new Set<BrowserWindow>()

/**
 * Per-tab favicon. `generation` counts the icon sets the tab has been told
 * about: a fetch started for one set and still in flight when the next arrives
 * is discarded rather than overwriting the newer icon with the older one.
 */
type FaviconState = { dataUrl: string | null; generation: number }

/** tab id → its favicon state. Same lifetime as the view. */
const favicons = new Map<string, FaviconState>()

/**
 * tab id → why its page is blank, for the tabs whose last navigation failed.
 * Absent for every tab that loaded something, which is nearly all of them.
 */
const errors = new Map<string, PageError>()

/**
 * tab id → how far its current load has got, for the tabs that are loading
 * something. Absent the moment a load ends, whether it arrived or failed.
 *
 * Chromium reports a page's arrival as landmarks rather than as a quantity —
 * it knows the response has committed and the document has parsed, and it
 * never knows how many bytes a page is going to be. So these are the three
 * moments a load genuinely passes through, and the fractions are only what
 * each moment is worth drawing as: far enough along to be encouraging, short
 * enough of the end that the next landmark still has somewhere to go.
 */
const loadProgress = new Map<string, number>()

/** A load has begun: the request is out, nothing has come back. */
const LOAD_STARTED = 0.1
/** The response has committed — the document arriving is the one we will get. */
const LOAD_COMMITTED = 0.45
/** The document has parsed; what is left is the subresources it asked for. */
const LOAD_PARSED = 0.8

/**
 * Landmarks only ever move the bar forward. Chromium can report them out of
 * order across a redirect — a second navigation commits while the first one's
 * document is still being parsed — and a bar that ran backwards would read as
 * the page having lost ground rather than as having gained a hop.
 */
function markProgress(tabId: string, value: number): void {
  if ((loadProgress.get(tabId) ?? 0) < value) loadProgress.set(tabId, value)
}

/**
 * Whether the response came with no document at all, which is Chrome's rule
 * for when an error status gets its own page. What the server sent is judged
 * rather than what has painted: an application's 404 is often an empty mount
 * point and a script at `did-finish-load`, its text not rendered yet or held
 * hidden until it is, and reading `innerText` then mistook it for nothing.
 * Any text in the document — a title, a script — or any element counts as
 * having sent something. The exceptions are what Chromium wraps an empty plain
 * text response in by itself: a color-scheme `<meta>` and an empty `<pre>`.
 */
const DOCUMENT_IS_EMPTY = `(() => {
  const root = document.documentElement
  if (!root) return true
  if ((root.textContent || '').trim().length > 0) return false
  for (const element of root.querySelectorAll('head *, body *')) {
    if (element.tagName === 'META' || element.tagName === 'PRE') continue
    return false
  }
  return true
})()`

/**
 * Where one attached view is drawn: the renderer's last measurement of its
 * pane, as it sent it, and that measurement carried to the window's current
 * size — which is where the view actually goes.
 */
type Placement = { measured: MeasuredBounds; bounds: ViewBounds }

/**
 * tab id → where its view sits, for every view attached to the window. One,
 * nearly always; a split draws several side by side, each in a pane the
 * renderer measured for it. Every other view keeps running detached, so going
 * back to a tab does not reload it.
 */
const attached = new Map<string, Placement>()

/**
 * The tab its task has in front — in a split, the pane the user is working in.
 * What the page shortcuts and the miniplayer mean by "the page", told by the
 * renderer (see `focusBrowserView`) because the selection is the renderer's.
 */
let focusedTabId: string | null = null

const NO_BOUNDS: ViewBounds = { x: 0, y: 0, width: 0, height: 0 }

/**
 * The attached tab the page shortcuts act on: the focused one, or the only one
 * — the renderer's word on focus can trail the view it goes with by a message,
 * and a lone page is the page whatever it says.
 */
function frontTabId(): string | null {
  if (focusedTabId !== null && attached.has(focusedTabId)) return focusedTabId
  if (attached.size !== 1) return null
  const [only] = attached.keys()
  return only
}

/** Where `tabId`'s view is drawn now, or nowhere if it is not attached. */
function boundsOf(tabId: string | null): ViewBounds {
  return (tabId !== null && attached.get(tabId)?.bounds) || NO_BOUNDS
}

/**
 * The tab the zoom pill is reporting on while it is up, which is where it is
 * drawn and what takes it down when that page leaves the screen.
 */
let zoomTabId: string | null = null

/**
 * The corner of a page the pill can have: all of its area, less whatever the
 * find bar is taking when the bar is over the same page (see
 * `reserveForFindBar`), so the two never land on top of each other.
 */
function pillArea(tabId: string | null): ViewBounds {
  const area = boundsOf(tabId)
  return tabId !== null && tabId === findTabId ? reserveForFindBar(area) : area
}

/** Carries the two overlays along with the pages they sit over. No-ops unless one is up. */
function moveOverlays(): void {
  if (findTabId !== null) moveFindBar(boundsOf(findTabId))
  moveZoomIndicator(pillArea(zoomTabId))
}

/**
 * Brings a placement up to the window's size now, from the renderer's last
 * word on it.
 *
 * The renderer measures the page area, but by the time its message lands a
 * window being dragged has moved on: the measurement is a frame or more old,
 * and a view laid out from it as sent lags the window it sits in — the
 * trailing edge of the page jitters against the window's while the user drags
 * the leading one. Carried by however much the window has changed since, it
 * lands where the renderer is about to put it anyway, and the next measurement
 * only confirms it.
 */
function rebase(placement: Placement): void {
  const window = hostWindow
  if (!window || window.isDestroyed()) return
  const { measured } = placement
  const [width, height] = window.getContentSize()
  const dw = width - measured.viewport.width
  const dh = height - measured.viewport.height
  const { left, right, top, bottom } = measured.span ?? FULL_SPAN
  const y = measured.y + top * dh
  const tall = measured.height + (bottom - top) * dh
  placement.bounds =
    measured.anchor === 'center'
      ? // Held in the middle of its pane, so it moves by half of what the
        // pane's two edges do and keeps its own width.
        { x: measured.x + ((left + right) / 2) * dw, y, width: measured.width, height: tall }
      : { x: measured.x + left * dw, y, width: measured.width + (right - left) * dw, height: tall }
}

/**
 * Lays the attached views and the overlays that follow them out again at the
 * window's current size, without waiting to hear from the renderer.
 *
 * On a window's own `resize` event, which on macOS is sent from inside the live
 * resize, before the frame at the new size is drawn: a view positioned here
 * moves in the same frame as the window's edge, which is what a native window
 * does with its own subviews.
 */
function followWindow(): void {
  for (const [tabId, placement] of attached) {
    rebase(placement)
    const view = views.get(tabId)
    if (view) applyBounds(view, placement.bounds)
  }
  // Both overlays are positioned off a page rather than off the window, so
  // they have to be carried along with it.
  moveOverlays()
}

/**
 * How wide the band down the window's left edge is that counts as the pointer
 * reaching for a sidebar that is away, in window content pixels. Zero means
 * nobody is asking, which is the state whenever the sidebar is docked.
 *
 * The band is the renderer's idea — it is the same strip the dock overlays the
 * well's leading edge with — and it has to be watched from here because the
 * page is a native view stacked above the renderer, which never sees a pointer
 * that is over it. See `watchPeekZone`.
 */
let peekZone = 0

/**
 * Whether the pointer was last seen inside that band. Only the crossings are
 * worth telling the renderer about; a move within the page reports nothing.
 */
let inPeekZone = false

/**
 * Asks to be told when the pointer is within `width` pixels of the window's
 * left edge over an attached page, and stops asking at zero.
 *
 * This is the hover the renderer cannot feel for itself. A native view takes
 * every pointer event inside its rect, so a strip of renderer laid under the
 * page is a strip nothing can reach: the pointer crossing it produces no
 * `mouseenter` anywhere in the document, and a sidebar waiting for one stays
 * away. What the page does get is Chromium's own input, and every view hands a
 * copy of it here before dispatching it (see `watchPointer`) — so the crossing
 * is read off the page's stream and handed back to the renderer as the event
 * it would have had if the page were not in the way.
 */
export function watchPeekZone(width: number): void {
  peekZone = Math.max(0, width)
  // Turning the watch off is also the pointer leaving as far as the renderer is
  // concerned: whatever it was told last must not be left standing.
  if (peekZone === 0) reportPeek(false)
}

/**
 * Notes where the pointer is against the band, and tells the renderer when that
 * answer changes. Called for every mouse move over a page, so it does as little
 * as it can when nothing is being asked of it.
 */
function reportPeek(inside: boolean): void {
  if (inside === inPeekZone) return
  inPeekZone = inside
  sendToHost('browser:peek', inside)
}

/**
 * Reads the pointer off a view's input stream, which is the one place a page's
 * pointer is visible from outside the page.
 *
 * `input-event` is a copy, not an interception: the page still gets the event,
 * so nothing here costs the page a click or a hover of its own. The coordinates
 * are the view's, in the same pixels the renderer measured its bounds in, so
 * they are carried to the window's by where the view sits. The activation band
 * stays at the window's left edge: following a page's moving edge would sweep
 * the band under a stationary pointer as the sidebar closes and reopen it.
 *
 * The one place this cannot see is a cross-origin iframe: it is a widget of its
 * own, and the pointer over it produces no event on the page around it. A site
 * framing something else against its left edge will not open the sidebar. The
 * chrome bar above the page still will, and so will the window's own edge
 * anywhere the page is not.
 */
function watchPointer(webContents: WebContents, tabId: string): void {
  webContents.on('input-event', (_event, input) => {
    if (peekZone === 0) return
    const placement = attached.get(tabId)
    if (!placement) return

    // The pointer went somewhere this view has no word on — off the window, or
    // over the sidebar once it has arrived, where the renderer can feel it
    // again and takes over from here.
    if (input.type === 'mouseLeave') {
      reportPeek(false)
      return
    }
    if (input.type !== 'mouseMove') return

    // A pointer with a button down is in the middle of something the page owns
    // — a selection being dragged out, a canvas being pushed around — and a
    // drag that happens to reach the edge is not a reach for the sidebar.
    // Reported as neither in nor out: the drag leaves the peek however it
    // found it, and the first free move after the release settles it.
    if (input.modifiers?.some((modifier) => modifier.endsWith('buttondown'))) return

    // Typed as the base event, which carries no position. The mouse kinds are
    // the ones that do, and this is one of them.
    const x = placement.bounds.x + (input as Electron.MouseInputEvent).x
    reportPeek(x >= 0 && x < peekZone)
  })
}

/**
 * Binds the manager to the window whose content area hosts the views. Called
 * once per window creation; a new window replaces the old binding and drops
 * every view, since views belong to the window they were attached to.
 */
export function registerHostWindow(window: BrowserWindow): void {
  destroyAllBrowserViews()
  hostWindow = window
  window.on('closed', () => {
    if (hostWindow === window) {
      destroyAllBrowserViews()
      hostWindow = undefined
    }
  })

  window.on('resize', followWindow)

  // The glass a tab dragged over the page area lands on, loaded now so that
  // the first drag finds it ready (see src/main/split-drop.ts).
  prepareSplitDrop()

  // The other way a page stops being on screen: the window it is in goes away
  // rather than the page. The tab is still the selected one throughout, so
  // nothing detaches and none of the paths above run — the offer has to be
  // made from here, and taken back when the window comes back.
  //
  // Only these two, and not the window losing focus. Chrome draws the line in
  // the same place, and for the same reason: glancing at another app is not
  // leaving, and a miniplayer that appeared every time it happened would be
  // one more thing to dismiss rather than one less thing to lose.
  const offer = (): void => {
    const front = frontTabId()
    if (front === null) return
    const view = views.get(front)
    if (view && !view.webContents.isDestroyed()) void enterMiniplayer(front, view.webContents)
  }
  const withdraw = (): void => {
    const front = frontTabId()
    if (front !== null) leaveMiniplayer(front)
  }

  window.on('minimize', offer)
  window.on('hide', offer)
  window.on('restore', withdraw)
  window.on('show', withdraw)

  // Whether anyone is looking, for extension views that poll: see
  // `setAppFocused`.
  setAppFocused(window.isFocused())
  window.on('focus', () => setAppFocused(true))
  window.on('blur', () => setAppFocused(false))
}

/**
 * The window browser tabs are drawn over. Null when the app is running without
 * one, which on macOS is ordinary rather than broken: closing the window does
 * not quit, and the routines carry on without it.
 *
 * For the few things that belong to that window rather than to whatever has
 * focus — the launcher above all, which is asked for by a menu accelerator that
 * can fire while a popup is in front.
 */
export function getHostWindow(): BrowserWindow | null {
  return hostWindow && !hostWindow.isDestroyed() ? hostWindow : null
}

/**
 * What bringing the window forward found: a window whose renderer is up and
 * listening, one that is still loading and cannot be told anything yet, or no
 * window at all — which on macOS is an ordinary state rather than a broken one,
 * since closing the window does not quit the app and the routines carry on
 * without it.
 */
export type HostReveal = 'ready' | 'loading' | 'none'

/**
 * Brings the app's window to the front — out of the dock, off another desktop,
 * from behind whatever the user was doing. For the moments the app is asking
 * for the user rather than the other way round: clicking a notification, so
 * far.
 *
 * What it answers with is what the caller may do next. Anything sent to a
 * window that is still loading is sent to a renderer with no listeners yet and
 * is simply lost, so that case is worth telling apart from a window that is up.
 */
export function revealHost(): HostReveal {
  if (!hostWindow || hostWindow.isDestroyed()) return 'none'

  if (hostWindow.isMinimized()) hostWindow.restore()
  hostWindow.show()
  hostWindow.focus()
  return hostWindow.webContents.isLoading() ? 'loading' : 'ready'
}

/**
 * Sends a message to the host renderer, if there is still a window to take it.
 * The one way anything in the main process talks to the renderer unprompted.
 */
export function sendToHost(channel: string, payload: unknown): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  hostWindow.webContents.send(channel, payload)
}

/**
 * The tab a page belongs to, or null for any other web contents — the host
 * renderer above all. Downloads arrive knowing only which contents started
 * them, and this is what turns that into the tab, and so into the task.
 */
export function tabIdForWebContents(webContents: WebContents): string | null {
  for (const [tabId, view] of views) {
    if (view.webContents.id === webContents.id) return tabId
  }
  return null
}

function publish(tabId: string, view: WebContentsView): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  // What a browser tab's chrome and row are drawn from. An extension's view is
  // not a page with an address to show, and its row is the extension's.
  if (isExtensionKind(viewKinds.get(tabId))) return
  const { navigationHistory } = view.webContents
  const state: BrowserViewState = {
    tabId,
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    favicon: favicons.get(tabId)?.dataUrl ?? null,
    // Not `isLoading()`: that is Chromium's raw loading state, which also flips
    // for a same-document commit — an SPA's `pushState` — and for a subframe
    // loading into a finished page. Chrome keeps both off its throbber (it asks
    // `ShouldShowLoadingUI`, which Electron does not expose), and so does this:
    // loading means a new document is on its way into the main frame.
    loading: loadProgress.has(tabId),
    audible: view.webContents.isCurrentlyAudible(),
    audioMuted: view.webContents.isAudioMuted(),
    progress: loadProgress.get(tabId) ?? null,
    canGoBack: navigationHistory.canGoBack(),
    canGoForward: navigationHistory.canGoForward(),
    error: errors.get(tabId) ?? null
  }
  sendToHost('browser:state', state)
}

/**
 * Takes the first of a page's advertised favicons that actually resolves, and
 * publishes it. Chromium lists them best-first, so the later entries only come
 * into play when an earlier one 404s or is not an image.
 *
 * This event, and not the navigation, is what makes a tab's icon stale.
 * Chromium announces a document's icons only when the set differs from the one
 * it last announced for this tab, so a site whose every page advertises the
 * same icon — GitHub, Gmail, Okta — fires this once and then stays silent for
 * as long as the tab remains on it. An icon dropped on navigation instead
 * would therefore never come back: no second event is coming to replace it.
 */
async function adoptFavicon(tabId: string, view: WebContentsView, urls: string[]): Promise<void> {
  const opening = favicons.get(tabId)
  if (!opening) return

  // Whatever this event supersedes is no longer what the tab is waiting on.
  const generation = (opening.generation += 1)

  /** The tab's state, while this run is still the one it is waiting on. */
  const current = (): FaviconState | undefined => {
    if (view.webContents.isDestroyed()) return undefined
    const state = favicons.get(tabId)
    return state?.generation === generation ? state : undefined
  }

  for (const url of urls) {
    const dataUrl = await fetchIcon(view.webContents.session, url)
    const state = current()
    if (!state) return

    if (!dataUrl) continue
    state.dataUrl = dataUrl
    // Kept for every other row on this site, in this task and any other: a tab
    // that has never been opened has no view to ask, and this is what it draws
    // instead (see src/main/site-icons.ts).
    rememberSiteIcon(view.webContents.getURL(), dataUrl)
    publish(tabId, view)
    return
  }

  // The page named icons and not one of them resolved, so it has none of its
  // own: the row falls back to its generic glyph rather than keeping the icon
  // of the site the tab came from.
  const state = current()
  if (state && state.dataUrl !== null) {
    state.dataUrl = null
    publish(tabId, view)
  }
}

/**
 * What to do when a page calls `window.open` or follows a `target=_blank`
 * link. Three answers, because these are three different things arriving as
 * one event:
 *
 * - A scheme the app cannot render — `mailto:`, `zoommtg:`, `spotify:` — belongs
 *   to the OS, as it always did.
 * - A sized `window.open`, or one with no address at all, is a real popup, and
 *   whatever opened it is generally holding on to it: SAML and OAuth flows poll
 *   `popup.closed` or listen for a `postMessage` back, and a blank popup is one
 *   its opener means to write into. All of that needs a live `window.opener`,
 *   which a tab does not have. Those stay windows.
 * - Everything else is ordinary navigation that asked to land somewhere else —
 *   an Okta dashboard tile, a link set to open in a new tab — and it becomes a
 *   tab here. These used to go to the user's real browser, which dropped them
 *   into a profile holding none of the session they had just signed in to.
 */
function handleWindowOpen(
  tabId: string,
  host: BrowserWindow,
  { url, disposition, frameName, features }: HandlerDetails
): WindowOpenHandlerResponse {
  // An installed extension's view gets no windows of its own: a web page it
  // opens is a tab, and anything else goes out only if it is a web page or
  // email (see `mayOpenOutside`).
  const installed = isInstalledTab(tabId)
  if (!isWebAddress(url)) {
    if (!installed || mayOpenOutside(url)) void shell.openExternal(url)
    return { action: 'deny' }
  }
  if (installed) {
    openLinkFrom(tabId)(url, null)
    return { action: 'deny' }
  }

  // An extension's page opens no windows of its own: it has its main half and
  // the API for anything it needs done, and a popup in its session would be a
  // page with the bridge's session and none of its rules. A link it opens is a
  // tab.
  if (viewKinds.get(tabId) === 'extension') {
    openLinkFrom(tabId)(url, null)
    return { action: 'deny' }
  }

  // The miniplayer's window, which is a `window.open` only because a page with
  // no preload has no other way to reach this process (see
  // src/main/miniplayer-agent.ts). Answered before anything is read off the
  // address, because it is not really about one: it is `about:blank`, and
  // what it means is in the name.
  if (isMiniplayerFrame(frameName)) {
    const page = views.get(tabId)?.webContents
    if (!page || page.isDestroyed()) return { action: 'deny' }
    return {
      action: 'allow',
      // The size the page asked for travels as `window.open` features, which
      // is what `requestWindow({ width, height })` becomes on the way here.
      createWindow: (options) => openMiniplayerWindow(tabId, page, host, features, options)
    }
  }

  const context = tabContexts.get(tabId) ?? DEFAULT_CONTEXT

  // An application's own windows, which are nearly always a sign-in. These
  // must stay inside the app and inside the application's session, whatever
  // disposition it asked for: an editor like VS Code finishes an OAuth round
  // trip by having the callback page write to `localStorage` and having the
  // workbench poll for it, and `localStorage` is per-session. Sent to the
  // system browser — which is where an ordinary `deny` plus `openExternal`
  // would put it — the result would be written somewhere the workbench will
  // never look, and sign-in would hang for ever without reporting anything.
  //
  // A new tab is no good either: a tab is a row in a task, and this is a window
  // the application is waiting on rather than somewhere the user asked to go.
  if (viewKinds.get(tabId) === 'web-app') {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: '#18181b',
        parent: host,
        webPreferences: { partition: partitionForKind('web-app', context, tabId) }
      }
    }
  }

  // A blank address is a window its opener fills in itself, and Chromium hands
  // it over under whichever disposition it likes: `new-window` for a sized
  // `window.open('about:blank', ...)`, `foreground-tab` for an unsized one, and
  // `other` for `documentPictureInPicture.requestWindow`, which comes through
  // this handler with nothing but the address to identify it by. So the address
  // is read alongside the disposition rather than left to it. A tab is the
  // wrong answer to all three: the opener writes through the handle it got
  // back, and a tab is a row the renderer opens, which no handle reaches — and
  // a blank row at that, with no address bar to type a way out of.
  if (disposition === 'new-window' || url === 'about:blank') {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        // Opaque, unlike the host window: a popup has no vibrancy layer behind
        // it, and a transparent one would composite against nothing.
        backgroundColor: '#18181b',
        // The popup belongs to the window whose page opened it — it stays with
        // that window and closes with it, rather than being left behind in the
        // app switcher once the page waiting on it is gone.
        parent: host,
        // Chromium already opens a child window in its opener's partition, so
        // this is saying out loud what would happen anyway. It is worth saying:
        // a popup that landed in the default session would be a sign-in screen
        // that authenticates the wrong account, and the failure would look like
        // the flow simply not working.
        webPreferences: {
          partition: partitionFor(context.space, context.profile),
          preload: ADBLOCK_PRELOAD
        }
      }
    }
  }

  sendToHost('browser:openTab', {
    sourceTabId: tabId,
    url,
    background: disposition === 'background-tab',
    // The profile only: the space is the project's, and the tab this opens is
    // in the same project by construction.
    profile: context.profile
  } satisfies OpenTabRequest)
  return { action: 'deny' }
}

/**
 * Takes the user back to the tab a miniplayer is playing: the window comes
 * forward, the miniplayer comes down, and the renderer is told where to land.
 *
 * The task is looked up rather than remembered. A miniplayer knows the tab it
 * belongs to and nothing else, while the strip is arranged by task — and the
 * whole point of the button is that the user is somewhere else entirely by the
 * time they press it, quite possibly in another task.
 *
 * The popped-out tab is put back on screen by the renderer rather than from
 * here: it may be one pane of a split, which only the renderer can measure, and
 * the news that it is home is what re-runs the pane that shows it (see
 * `publishPoppedOut`) — whether or not the selection that follows moves.
 */
async function returnFromMiniplayer(tabId: string): Promise<void> {
  closeMiniplayer(tabId)

  if (poppedOutTabId() === tabId && popIn()) publishPoppedOut()

  revealHost()

  const tab = await getTab(tabId)
  if (!tab) return
  sendToHost('miniplayer:revealTab', { taskId: tab.taskId, tabId } satisfies TaskFocus)
}

/**
 * Gives a popup the same handling its opener has: a context menu, and an
 * answer of its own for whatever it goes on to open. A consent screen that
 * opens a second one is ordinary in these flows, and without this the nested
 * window would fall back to Electron's default — a bare window with no menu
 * that reports to nobody.
 */
function adoptPopup(tabId: string, host: BrowserWindow, popup: BrowserWindow): void {
  if (viewKinds.get(tabId) === 'page') adBlocker.attach(popup.webContents)
  // A popup shares its opener's session and, often, its host: left on the
  // default, zooming the popup would zoom the tab that opened it too.
  popup.webContents.setZoomMode('isolated')
  attachContextMenu(popup.webContents, popup, openLinkFrom(tabId))
  popup.webContents.setWindowOpenHandler((details) => handleWindowOpen(tabId, host, details))
  popup.webContents.on('did-create-window', (nested) => adoptPopup(tabId, host, nested))
  popups.add(popup)
  popup.on('closed', () => popups.delete(popup))
}

/**
 * What the page's context menu calls when a link is opened in a named profile.
 * The menu chooses; placing the tab is the renderer's, exactly as it is for a
 * link the page itself asked to open (see `handleWindowOpen`).
 *
 * Passed in rather than imported by the menu so that the dependency runs one
 * way: this module knows about the menu, and the menu knows only that it was
 * handed something to call.
 */
/**
 * A link an extension's view asked to follow: a tab for a web address, the app
 * registered for one of its own (`zoommtg://…`), and nothing at all for a local
 * file or a script.
 */
export function openLinkFromTab(tabId: string, url: string): void {
  if (isWebAddress(url)) {
    openLinkFrom(tabId)(url, null)
    return
  }
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return
  }
  if (['file:', 'javascript:', 'data:', 'vbscript:', 'about:'].includes(scheme)) return
  void shell.openExternal(url)
}

function openLinkFrom(tabId: string): (url: string, profile: number | null) => void {
  return (url, profile) => {
    sendToHost('browser:openTab', {
      sourceTabId: tabId,
      url,
      background: false,
      profile
    } satisfies OpenTabRequest)
  }
}

/**
 * Gives `view` the canvas colour its document would have had in a browser, once
 * that document is ready to be asked which scheme it is in. Until then the view
 * stays transparent, so a tab still loading shows the glass rather than a slab
 * of white that is about to be painted over anyway.
 */
function paintCanvas(view: WebContentsView): void {
  const { webContents } = view
  void webContents
    .executeJavaScript(DOCUMENT_PREFERS_DARK, true)
    .then((dark: boolean) => {
      // The check is asynchronous: the tab may have started loading something
      // else while it ran, and that navigation has already reset the canvas.
      if (webContents.isDestroyed()) return
      view.setBackgroundColor(dark ? CANVAS_DARK : CANVAS_LIGHT)
    })
    // A page that navigated away mid-check, or one that refuses to run script
    // at all, simply keeps the transparent canvas it started with.
    .catch(() => undefined)
}

/**
 * Holds a document view on the one file it was opened for.
 *
 * A stored document is a tab that *is* a file, not a tab that happens to be
 * showing one: following a link out of it would leave the tab pointing at the
 * web while its row still named the file, with no address bar to say otherwise
 * and no way back. So a link goes where a link from any page goes — a tab of
 * its own, opened by the renderer — and the document stays put.
 *
 * Movement within the file is not navigation in this sense and is left alone:
 * an `#anchor` in a table of contents is the document scrolling itself.
 *
 * Nearly everything caught here is a click — a link in an email preview, which
 * is the whole point of the redirect. A document that sends itself somewhere
 * unprompted, by `meta refresh` or by script, is treated the same way: the
 * event carries no note of who started it, and a tab appearing is a far better
 * failure than the preview quietly becoming a web page.
 */
function lockToDocument(
  webContents: WebContents,
  tabId: string,
  documentUrl: string,
  /** An installed extension's page, which may send the OS web pages and email only. */
  installed = false
): void {
  // `will-navigate` is not emitted for the app's own `loadURL`, so the first
  // load is never caught by this — only something the document itself does.
  webContents.on('will-navigate', (event, target) => {
    if (sameDocument(target, documentUrl)) return
    event.preventDefault()
    // `about:blank` is an address the app will load (see src/main/safe-url.ts)
    // but not one to open anything for: nothing here is waiting on a handle, so
    // both answers below are wrong — a blank row in the task, or the user's
    // browser launched at an empty page. The document simply stays put.
    if (target === 'about:blank') return
    // A document has no profile of its own to pass on: it is not a login, and
    // a link out of one opens where an ordinary tab opens.
    if (isWebAddress(target)) openLinkFrom(tabId)(target, null)
    else if (!installed || mayOpenOutside(target)) void shell.openExternal(target)
  })
}

/**
 * Keeps a view on the site it was opened on, and turns a link out of it into a
 * tab.
 *
 * An extension's web view is the one page in the app that is neither a
 * document nor somewhere the user is browsing: it is an application, and a
 * link followed out of it — a URL in a README preview, an editor extension's
 * welcome page — would replace the application with a web page in a tab that
 * has no address bar and no way back. What the tab records is only what its
 * type needs to find the application again, so what is lost is the whole
 * session in it.
 *
 * Looser than `lockToDocument` on purpose. An application navigates itself for
 * its own reasons — reloading the window, signing in — and a lock that pinned
 * it to one address would break those. Its own origin is therefore its to move
 * around in; everything else becomes a tab, which is where a link the user
 * followed wanted to go anyway.
 */
function lockToOrigin(
  webContents: WebContents,
  tabId: string,
  homeUrl: string,
  /** An installed extension's application, which may send the OS web pages and email only. */
  installed = false
): void {
  webContents.on('will-navigate', (event, target) => {
    if (sameOrigin(target, homeUrl)) return
    event.preventDefault()
    if (isWebAddress(target)) openLinkFrom(tabId)(target, null)
    else if (!installed || mayOpenOutside(target)) void shell.openExternal(target)
  })
}

/** Whether a tab of an extension's type belongs to an installed extension. */
function isInstalledTab(tabId: string): boolean {
  const type = extensionTabTypes.get(tabId)
  return type !== undefined && isIsolated(type.slice(0, type.indexOf('.')))
}

/** Whether two addresses are served by the same site. False for either unparsable. */
function sameOrigin(target: string, homeUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(homeUrl).origin
  } catch {
    return false
  }
}

/** Whether `target` is the same resource as `documentUrl`, fragment aside. */
export function sameDocument(target: string, documentUrl: string): boolean {
  try {
    const a = new URL(target)
    const b = new URL(documentUrl)
    a.hash = ''
    b.hash = ''
    return a.href === b.href
  } catch {
    return false
  }
}

function createView(
  tabId: string,
  url: string,
  context: BrowsingContext,
  window: BrowserWindow,
  kind: ViewKind
): WebContentsView {
  const partition = partitionForKind(kind, context, tabId)
  // Files are served the store over a session that has never been asked to
  // serve it, so the handler is put there before the first one loads. A no-op
  // on every file after that.
  if (kind === 'file' && partition) registerFileProtocolOn(session.fromPartition(partition))

  const view = new WebContentsView({
    webPreferences: {
      // Web pages get only the sandboxed ad-blocking preload, with no bridge
      // exposed to page scripts, and no Node access.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Rubber-band overscroll, the way every other macOS app scrolls. Off by
      // default in Electron, and ignored on other platforms.
      scrollBounce: true,
      // Which login this page is. Undefined for the default profile, which
      // leaves the view on the app's own session — where every tab ran before
      // profiles existed, and where nearly every tab still runs. A document is
      // not a login at all and gets the empty session instead, and an
      // extension's views have sessions of their own.
      partition,
      // The bridge, and the only extra an extension's page gets over any other
      // page: still sandboxed, still isolated, still no node.
      ...(kind === 'extension' ? { preload: EXTENSION_VIEW_PRELOAD } : {}),
      ...(kind === 'page' ? { preload: ADBLOCK_PRELOAD } : {})
    }
  })

  view.setBackgroundColor(VIEW_BACKGROUND)
  view.setBorderRadius(CORNER_RADIUS)

  const { webContents } = view
  if (kind === 'page') adBlocker.attach(webContents)

  // Zoom belongs to the tab, not the site. Chromium's default shares one level
  // between every page on a host in the same session, so zooming a page in one
  // task would quietly zoom that site in every other task on the same profile —
  // and the pill, which only speaks for the page in front, would never say so.
  // Set once: the mode holds across navigations.
  webContents.setZoomMode('isolated')

  /**
   * The error status of the response now loading, held between the navigation
   * that reported it and the load finishing, which is when the document it
   * produced can be looked at.
   */
  let pendingStatus: { code: number; detail: string } | null = null

  // The canvas the document is painted on: transparent while a new one is on
  // its way, then whichever colour that document's colour scheme calls for.
  // A same-document navigation is the page moving within itself, so it keeps
  // the canvas it is already painted on.
  webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return
    view.setBackgroundColor(VIEW_BACKGROUND)
  })
  // `dom-ready`, not `did-finish-load`: the blocking stylesheets are in by
  // then, so `color-scheme` is settled, and the page has not yet had time to
  // paint against the wrong canvas while its images finish arriving.
  //
  // An application its extension has made see-through gets no canvas at all.
  // A canvas is what a page composites against when it declares no background
  // of its own, and such an application has been told to declare none —
  // painting one behind it would put back, a layer lower, exactly the slab its
  // stylesheet takes out.
  const seeThrough = kind === 'web-app' && webViewDeclarationOf(tabId)?.transparent === true
  webContents.on('dom-ready', () => {
    // An extension's page is the app's own and declares no background on
    // purpose: the glass is the well's.
    if (kind === 'extension' || seeThrough) return
    paintCanvas(view)
  })

  // A page has no right-click menu of its own; this gives it one.
  attachContextMenu(webContents, window, openLinkFrom(tabId))

  // Every view reports the pointer, not only the attached one: a detached view
  // gets no input, so the check costs nothing, and the view that is on screen
  // is always one that was wired up when it was made.
  watchPointer(webContents, tabId)

  // A click into one pane of a split is the user moving to that tab, and the
  // renderer never sees it: the view takes every pointer event inside its own
  // rect. The keyboard arriving is the one sign of it that reaches this side.
  webContents.on('focus', () => {
    if (!attached.has(tabId) || focusedTabId === tabId) return
    focusedTabId = tabId
    sendToHost('browser:focused', tabId)
  })

  // `window.open` and target=_blank: a tab for navigation, a real window for a
  // popup something is waiting on, the OS for anything it cannot render.
  webContents.setWindowOpenHandler((details) => handleWindowOpen(tabId, window, details))
  // Never a miniplayer: those are windows of the miniplayer's own making, which
  // Electron does not announce here (see `openMiniplayerWindow`).
  webContents.on('did-create-window', (popup) => adoptPopup(tabId, window, popup))

  // The page's half of the miniplayer, put in on every document this tab
  // loads. Arming a tab is not opening anything: nothing floats until the tab
  // is hidden with something playing in it. Not an extension's view, which is
  // an interface rather than something playing.
  if (kind !== 'extension') armMiniplayer(tabId, webContents)

  // The count the find bar reports. The bar is drawn over the page rather than
  // in it (see src/main/find-bar.ts), so it has no way to see this for itself.
  // Wired on every view rather than only on the searched one — a view gets the
  // event whether anyone is listening or not, and the relay drops anything from
  // a tab the bar is not on.
  webContents.on('found-in-page', (_event, found) => {
    if (findTabId !== tabId) return
    reportFindResult({ matches: found.matches, active: found.activeMatchOrdinal })
  })

  // Every signal that changes what the sidebar row or the browser chrome shows.
  // Listed one by one because `on` is overloaded per event name and will not
  // take a union.
  const republish = (): void => publish(tabId, view)
  webContents.on('audio-state-changed', republish)
  // A new document starting is the one moment the last failure stops being
  // true: the page area goes back to the live view, blank while it loads,
  // exactly as it does for a navigation that is going to succeed. Keyed off the
  // navigation rather than `did-start-loading`, which also fires for a page
  // moving within itself (see `publish`) — and a route change in an app that
  // never leaves its document is no load to draw.
  webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return
    errors.delete(tabId)
    pendingStatus = null
    loadProgress.set(tabId, LOAD_STARTED)
    republish()
  })
  webContents.on('did-stop-loading', () => {
    loadProgress.delete(tabId)
    republish()
  })
  // The last landmark: the document has parsed, and only its subresources are
  // still arriving. A listener of its own rather than a line in the canvas's
  // `dom-ready` above, so the three landmarks sit with the other things that
  // republish, where what they add up to can be read at once.
  webContents.on('dom-ready', () => {
    markProgress(tabId, LOAD_PARSED)
    republish()
  })
  webContents.on('page-title-updated', republish)
  // The icon deliberately survives a navigation: `page-favicon-updated` is what
  // retires it (see `adoptFavicon`), and that event does not fire again while a
  // tab stays on one site. Clearing here would leave every page after a site's
  // first wearing the generic glyph for good.
  // Also where an error status is caught: `did-navigate` is the only event that
  // reports one (see the `did-finish-load` handler below, which acts on it).
  webContents.on('did-navigate', (_event, _navigatedUrl, statusCode, statusText) => {
    pendingStatus = statusCode >= 400 ? { code: statusCode, detail: statusText } : null
    markProgress(tabId, LOAD_COMMITTED)
    // The document the bar was searching has been replaced, so its matches are
    // about a page that no longer exists — and Chromium has already dropped
    // them. A bar left up over the new page would be offering to step through
    // nothing while reporting a count from the last one. The focus is not
    // taken back: the page is loading, and it is where the user already is.
    if (findTabId === tabId) endFind(false)
    republish()
  })
  // Same document, so the icon still stands.
  webContents.on('did-navigate-in-page', republish)
  webContents.on('page-favicon-updated', (_event, urls) => {
    void adoptFavicon(tabId, view, urls)
  })
  // A failed navigation leaves the history unchanged but still ends a load, and
  // it is the only one of these that `did-stop-loading` can miss on a redirect.
  // It is also where the blank page comes from: nothing was ever committed, so
  // the record of what went wrong has to be kept here to have anything to show.
  webContents.on('did-fail-load', (_event, code, detail, failedUrl, isMainFrame) => {
    // A subframe that will not load is the page's problem, not the tab's — an
    // ad iframe blocked by the network is no reason to replace the article
    // around it. ERR_ABORTED is not a failure at all: it is what a navigation
    // the user replaced, or one that turned out to be a download, reports.
    if (isMainFrame && code !== -3) {
      errors.set(tabId, { kind: 'net', code, detail, url: failedUrl || url })
    }
    // Nothing more is coming for this document, whoever it belonged to. The
    // bar is the renderer's to end — it is the one that knows a failed load
    // should be dropped rather than filled.
    loadProgress.delete(tabId)
    republish()
  })

  // The other blank page: a response that did arrive, with a status saying it
  // carries nothing. Most servers send a body with their 404s and 502s, and
  // that body is the page — Chrome shows it, and so does this. Only when the
  // document turns out to be empty is there nothing to show but the status.
  webContents.on('did-finish-load', () => {
    const status = pendingStatus
    pendingStatus = null
    if (!status) return

    void webContents
      .executeJavaScript(DOCUMENT_IS_EMPTY, true)
      .then((empty: boolean) => {
        // The check is asynchronous, so the tab may have moved on while it ran;
        // a later navigation clearing `pendingStatus` is not enough to stop a
        // result already in flight from landing on the page that replaced it.
        if (!empty || webContents.isDestroyed() || webContents.isLoading()) return
        errors.set(tabId, {
          kind: 'http',
          code: status.code,
          detail: status.detail,
          url: webContents.getURL()
        })
        republish()
      })
      .catch(() => undefined)
  })

  // Registered before the first navigation starts, so no favicon event can
  // arrive with nowhere to put it.
  favicons.set(tabId, { dataUrl: null, generation: 0 })
  // Before the first navigation for the same reason: a link followed out of
  // this page inherits the profile, and that lookup must not come up empty.
  tabContexts.set(tabId, context)
  // Before it too, and for a sharper version of the same reason: the window
  // handler asks what kind this is, and an application may sign in through a
  // window it opens on load.
  viewKinds.set(tabId, kind)

  // Either of an extension's kinds. A page that crashes is let go of rather
  // than left as a blank rectangle over the pane. The renderer says what
  // happened and offers it back, and showing it again makes a new view — a
  // crashed one cannot be reused.
  if (isExtensionKind(kind)) {
    webContents.on('render-process-gone', (_event, details) => {
      sendToHost('extension-view:gone', { tabId, reason: details.reason })
      setImmediate(() => destroyBrowserView(tabId))
    })
  }

  if (kind === 'web-app') {
    const declaration = webViewDeclarationOf(tabId)
    if (!declaration) throw new Error(`No web view type recorded for ${tabId}.`)
    adoptWebView(webContents, declaration)
    lockToOrigin(webContents, tabId, url, isInstalledTab(tabId))
    // No peer-to-peer traffic, which goes round the session's network lock.
    if (isInstalledTab(tabId)) webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    load(webContents, url)
  } else if (kind === 'extension') {
    const type = extensionTabTypes.get(tabId)
    if (!type) throw new Error(`No extension type recorded for ${tabId}.`)
    adoptExtensionView(webContents, tabId, type)
    // Held on its one page: everything it draws, it draws there, and a link
    // followed out of it becomes a tab like a link out of a document does.
    lockToDocument(webContents, tabId, url, isInstalledTab(tabId))
    if (isInstalledTab(tabId)) webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // Straight to `loadURL`, for the reason a stored file goes there: the
    // address was built here, and in a built app it is a `file:` one, which
    // `load` would refuse.
    void webContents.loadURL(url).catch(() => undefined)
  } else if (kind === 'file') {
    lockToDocument(webContents, tabId, url)
    // Straight to `loadURL`, around the check `load` makes: that check is for
    // addresses the app did not write, and this one was built here from a
    // storage key the store resolved (see `showFileView`). `fluid-file:` is
    // not a scheme anything else may name.
    void webContents.loadURL(url).catch(() => undefined)
  } else {
    load(webContents, url)
  }

  views.set(tabId, view)
  return view
}

/**
 * Sends a page to an address, if it is one this app will load at all.
 *
 * The check is here rather than only at the places addresses come from, because
 * this is the one door they all go through — and the addresses that matter are
 * the ones nobody in this app wrote. A chat message, a page's `window.open`, a
 * link in a document: all of them can name `file:///…`, and a view that loaded
 * one would read the user's disk into a tab. See src/main/safe-url.ts.
 *
 * Refusals are logged rather than surfaced. Nothing legitimate reaches here
 * with a scheme like that, so a message in the interface would only ever be
 * describing an attack to the person being attacked.
 */
function load(webContents: WebContents, url: string): void {
  if (!isWebAddress(url)) {
    console.warn(`Refusing to load "${url.slice(0, 120)}": not a web address.`)
    return
  }
  // Rejects for an address replaced before it finished loading as readily as
  // for one that failed, and a page that failed has already said so in itself.
  void webContents.loadURL(url).catch(() => undefined)
}

/**
 * Positions an attached view. Native views take integers, and the measured
 * rect is in the renderer's CSS pixels, so every edge lands on a whole pixel
 * one way or the other.
 *
 * The top edge is the one where that choice shows. It is a seam with the chrome
 * bar rather than with the window, and the bar's hairline sits in its own last
 * pixel row right above it (see `pane-bar-edge`): a view rounded half a pixel
 * up would draw over that row and take the line with it. So the top rounds down
 * into the page area, never up into the bar, and the bottom is held where it
 * was rather than being carried along by the height. The other edges are seams
 * with the window itself, where a pixel either way is invisible.
 */
function applyBounds(view: WebContentsView, bounds: ViewBounds): void {
  const top = Math.ceil(bounds.y)
  const bottom = Math.round(bounds.y + bounds.height)
  view.setBounds({
    x: Math.round(bounds.x),
    y: top,
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, bottom - top)
  })
}

/**
 * Draws `tabId`'s view over its pane of the content area, creating it on first
 * use. Every pane the renderer draws asks for its own, so a split is several of
 * these at once; the views of the tabs not on screen keep running detached, so
 * switching back to one does not reload it.
 *
 * `space` and `profile` together say which login the page is, and are read only
 * on that first call: a view's partition is fixed when it is created — there is
 * no `setPartition`. Every later call for the same tab normally passes a
 * context that is already true of it; the one time it does not is a project
 * moved to another space, and `attach` answers that by rebuilding the view.
 */
export function showBrowserView(
  tabId: string,
  url: string,
  space: string | null,
  profile: number | null,
  next?: MeasuredBounds
): void {
  attach(tabId, url, { space, profile }, 'page', next)
}

/**
 * The same, for a file tab: drawn by whichever running extension's file viewer
 * claims the file's type (see `FileViewerContribution`). A `native` viewer's
 * view renders the file itself rather than an address, and is held on it (see
 * `lockToDocument`); a `page` viewer's is an extension view like any other.
 * With no viewer the pane is left to say the file cannot be shown.
 *
 * The renderer names the file by its storage key and never by a URL — the
 * address is built here, from a key the store is about to resolve, so nothing
 * that crosses the bridge can name a file outside the store or a scheme other
 * than this one.
 */
export function showFileView(tabId: string, storageKey: string, next?: MeasuredBounds): void {
  // Which viewer this is, decided here from the name the store gave the file
  // rather than taken from the renderer: it picks the session the file renders
  // in, and that is not a choice to accept over the bridge.
  const viewer = fileViewerFor(mimeTypeOf(storageKey))
  if (!viewer) {
    hideBrowserView(tabId)
    return
  }
  if (viewer.contribution.view.kind === 'page') {
    showExtensionView(tabId, fileViewType(viewer.fullId), next)
    return
  }
  // A view made for another viewer is in that viewer's session, which is not
  // this one's to render in.
  const recorded = nativeFileViewers.get(tabId)
  if (recorded !== undefined && recorded !== viewer.fullId) destroyBrowserView(tabId)
  nativeFileViewers.set(tabId, viewer.fullId)
  attach(tabId, fileUrl(storageKey), DEFAULT_CONTEXT, 'file', next)
}

/**
 * The same, for a tab of an extension type drawn in a view of its own (see
 * src/main/extension-views.ts). The renderer names the type as well as the
 * tab, and is believed only as far as the type goes: one that is not a
 * registered view type — its extension disabled a moment ago, say — hides the
 * pane instead, and the renderer's own placeholder shows through.
 */
export function showExtensionView(tabId: string, type: string, next?: MeasuredBounds): void {
  const viewType = viewTypeOf(type)
  const recorded = extensionTabTypes.get(tabId)
  if (!viewType || (recorded !== undefined && recorded !== type)) {
    hideBrowserView(tabId)
    return
  }

  // An application, at the address its type named for this tab. None yet is
  // the renderer showing it before asking (see `prepareWebView`), or after its
  // view went and took the answer with it; either way there is nothing to put
  // up, and the pane behind says so.
  if (isWebView(viewType.declaration)) {
    const url = views.has(tabId) ? undefined : webViewUrlOf(tabId)
    if (!views.has(tabId) && url === undefined) {
      hideBrowserView(tabId)
      return
    }
    extensionTabTypes.set(tabId, type)
    // Not counted against the warm views: an application is not the app's own
    // page, redrawn from the workspace in a moment, but something with a
    // session of its own in it — open files, a half-typed search — that a
    // reload would throw away.
    attach(tabId, url ?? '', DEFAULT_CONTEXT, 'web-app', next)
    return
  }

  if (recorded === undefined) {
    extensionTabTypes.set(tabId, type)
    prepareExtensionSession(viewType.extensionId)
  }
  // Read before attaching: the renderer re-sends `show` on every resize, and
  // only the tab arriving on screen is a reason to move the keyboard. Only the
  // focused pane's, too: a split coming up takes its other panes with it, and
  // one of them taking the keyboard would take the selection along (see the
  // `focus` listener in `createView`).
  const arriving = !attached.has(tabId)
  attach(tabId, extensionViewUrl(type, tabId), DEFAULT_CONTEXT, 'extension', next)
  touchExtensionView(tabId)
  if (arriving && viewType.declaration.focusOnShow && frontTabId() === tabId) {
    views.get(tabId)?.webContents.focus()
  }
}

/**
 * Draws `tabId`'s view over its pane, creating it on first use. What every
 * `show` entry point comes down to; the kind is only read on that first call,
 * since it is fixed for a view's life along with the session it implies.
 */
function attach(
  tabId: string,
  url: string,
  context: BrowsingContext,
  kind: ViewKind,
  next?: MeasuredBounds
): void {
  const window = hostWindow
  if (!window || window.isDestroyed()) return

  // A tab floating whole stays floating until it is asked back (see
  // `returnFromMiniplayer`): the renderer draws a placeholder in its place
  // rather than showing it, and a `show` that races the news of it floating —
  // the renderer re-sends one on every resize — must not quietly pull it home.
  if (poppedOutTabId() === tabId) return

  // A tab on its way back to the screen is done with its miniplayer. Before the
  // switch below rather than after, so that the tab being left has a free
  // miniplayer to take if it wants one.
  leaveMiniplayer(tabId)

  // The view on record is in a session the tab is no longer in: its project has
  // been moved to another space. A partition cannot be changed under a live
  // view — there is no `setPartition` — so the page goes and is built again in
  // the session it now belongs to, which is the honest answer: a page kept from
  // the space it just left would be signed in as somebody this space has never
  // been. After the miniplayer is dealt with, so nothing is left floating over
  // a view that has gone.
  const live = tabContexts.get(tabId)
  if (live && !sameBrowsingContext(live, context)) destroyBrowserView(tabId)

  // The renderer measures a pane before it asks for the view in it, so this is
  // only ever a message that arrived without its rect — with nowhere to put the
  // view, it is left where it is.
  const measured = next ?? attached.get(tabId)?.measured
  if (!measured) return

  const view = views.get(tabId) ?? createView(tabId, url, context, window, kind)

  let placement = attached.get(tabId)
  if (placement) {
    placement.measured = measured
  } else {
    placement = { measured, bounds: NO_BOUNDS }
    attached.set(tabId, placement)
    window.contentView.addChildView(view)
  }
  rebase(placement)
  applyBounds(view, placement.bounds)
  // The renderer re-sends `show` for every resize as well as for every tab
  // change, so this is the path a sidebar drag actually takes.
  moveOverlays()
  publish(tabId, view)
}

/**
 * Detaches a tab's view without destroying it, so its page keeps its state —
 * and offers the page the miniplayer on the way out, which is what makes a
 * call or a video follow the user instead of being left behind running in a
 * window nobody can see.
 *
 * Every way a page leaves the screen comes through here — another tab, another
 * task, a terminal or file tab taking the pane, a split closing — so the offer
 * is made once, here, rather than at each of those.
 */
export function hideBrowserView(tabId: string): void {
  detachView(tabId, true)
}

/**
 * The same, for the ways out that are not the user looking away: the tab being
 * taken out of the window whole (see `popOutTab`), where a miniplayer would be
 * a second answer to a question already answered, and teardown, where there is
 * nothing to float.
 */
function detachView(tabId: string, offerMiniplayer: boolean): void {
  // Before the early return, not after it: the pill belongs to the page it was
  // reporting on, and this is every way a page leaves the screen — a tab
  // switch, a file or terminal tab taking the pane, a failed navigation handing
  // it to the error page. Zoom is per-page, so a pill that outlived any of
  // those would be reporting a number that is no longer about anything shown.
  if (zoomTabId === tabId) {
    hideZoomIndicator()
    zoomTabId = null
  }
  // And the find bar with it, for the same reason and every one of the same
  // ways out: a search belongs to one page, so a bar that outlived the page
  // under it would be offering to step through matches in a document that is
  // no longer on screen. Without the focus being handed back — the page it
  // would go back to is the one being detached.
  if (findTabId === tabId) endFind(false)
  // The view that was reporting the pointer may be leaving the screen without
  // ever reporting it gone, so the last thing it said has to be taken back
  // here. Whatever replaces it — another page, or a pane the renderer draws
  // itself — starts the question over.
  reportPeek(false)
  if (!attached.delete(tabId)) return
  const view = views.get(tabId)
  if (view && hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.contentView.removeChildView(view)
  }

  // After the view is off screen, not before: entering means opening a window
  // and moving things into it, and the page should be doing that from behind
  // rather than in front of the user.
  if (offerMiniplayer && view && !view.webContents.isDestroyed()) {
    void enterMiniplayer(tabId, view.webContents)
  }
}

/**
 * Floats a whole tab on the user's say-so — page and all, still live, still
 * the same page.
 *
 * The answer for everything the automatic paths cannot help: a site with no
 * video element and no media session handler, a dashboard somebody wants kept
 * in a corner, a call this app failed to recognise as one. It asks the page
 * nothing, because the user has already answered the only question there was.
 */
export function popOutTab(tabId: string): void {
  const window = hostWindow
  const view = views.get(tabId)
  if (!window || window.isDestroyed() || !view) return
  if (poppedOutTabId() === tabId) return

  // Whatever this tab was already doing in a floating window, it is not doing
  // it now: the two are different answers to the same question, and only one
  // of them can have the page.
  closeMiniplayer(tabId)
  if (attached.has(tabId)) detachView(tabId, false)
  popOut(tabId, view, window)
  publishPoppedOut()
}

/**
 * Brings a popped-out tab home, from the placeholder the renderer draws in its
 * place. The same way back as the button on the floating window itself.
 */
export function popInTab(tabId: string): void {
  if (poppedOutTabId() === tabId) void returnFromMiniplayer(tabId)
}

/**
 * The same, from a floating window's own button, which is only ever about the
 * tab in it — floating whole, or in its miniplayer.
 */
export function returnFromFloating(sender: WebContents): void {
  const owner = floatingOwner(sender)
  if (owner) void returnFromMiniplayer(owner.tabId)
}

/**
 * A floating window's close button: the window goes, and the tab is left where
 * it is rather than gone to — the main window is not brought forward and no
 * tab is selected, since the user closing it is done with it rather than
 * asking to be taken to it. A tab floating whole goes back into the main
 * window, and if it happens to be the tab on screen, the renderer's own re-run
 * on hearing it is home shows it again. A miniplayer just closes, and what was
 * playing in it goes on playing in the tab.
 */
export function dismissFloating(sender: WebContents): void {
  const owner = floatingOwner(sender)
  if (owner?.kind === 'tab' && popIn()) publishPoppedOut()
  if (owner?.kind === 'miniplayer') closeMiniplayer(owner.tabId)
}

/**
 * Tells the renderer which tab is floating whole, if any, so it can say so in
 * the tab's place rather than leave an empty well where the page used to be.
 */
function publishPoppedOut(): void {
  sendToHost('browser:poppedOut', poppedOutTabId())
}

// And which tabs have a floating window of either kind, which is what the
// renderer describes to their bars.
onFloatingChanged(() => sendToHost('browser:floating', floatingTabIds()))

/**
 * The same for whichever page is on screen, which is what a menu item can ask
 * for: the menu knows about pages and windows, and tabs are this module's.
 * Nothing happens when the pane is holding something that is not a page.
 */
export function popOutAttachedTab(): void {
  const front = frontTabId()
  if (front !== null) popOutTab(front)
}

/** Re-lays-out one attached view, from a new measurement of its pane. */
export function setBrowserViewBounds(tabId: string, next: MeasuredBounds): void {
  const placement = attached.get(tabId)
  if (!placement) return
  placement.measured = next
  followWindow()
}

/**
 * Which attached tab is the one in front: the renderer's selection, which in a
 * split is the pane the user is working in. Null when the task has none.
 */
export function focusBrowserView(tabId: string | null): void {
  focusedTabId = tabId
}

/**
 * Navigation for the chrome the renderer draws above the page. All three are
 * no-ops for a tab with no view yet: the buttons can only be clicked while the
 * tab they belong to is on screen, but the messages are fire-and-forget.
 */
export function goBack(tabId: string): void {
  views.get(tabId)?.webContents.navigationHistory.goBack()
}

export function goForward(tabId: string): void {
  views.get(tabId)?.webContents.navigationHistory.goForward()
}

export function reload(tabId: string): void {
  views.get(tabId)?.webContents.reload()
}

/** Mutes only this tab, including when its page is in the background. */
export function toggleAudioMuted(tabId: string): void {
  const view = views.get(tabId)
  if (!view || view.webContents.isDestroyed()) return
  view.webContents.setAudioMuted(!view.webContents.isAudioMuted())
  // Muting need not change whether the page is emitting audio.
  publish(tabId, view)
}

/**
 * Sends a tab's page to an address typed into the chrome's address bar. The
 * rejection is swallowed rather than reported: `loadURL` rejects for an address
 * replaced before it finished loading as readily as for one that failed, and a
 * page that failed has already said so in the page itself.
 */
export function navigate(tabId: string, url: string): void {
  const view = views.get(tabId)
  if (view) load(view.webContents, url)
}

/**
 * The page a page-level shortcut acts on, given the window that has focus: the
 * browser tab drawn over the main window, or a popup's own page. Null for
 * anything else — the settings panel, and a task whose selected tab holds a
 * file rather than a page — which is what makes those shortcuts do nothing
 * rather than act on a page the user is not looking at.
 */
export function focusedPage(window: BaseWindow | undefined): WebContents | null {
  // `BaseWindow` rather than `BrowserWindow`: this is called with whatever the
  // application menu was clicked under, and that is how Electron types it.
  if (!window || window.isDestroyed()) return null

  if (window === hostWindow) {
    // The pane with the keyboard, when the user has clicked into one; failing
    // that, the one in front.
    for (const tabId of attached.keys()) {
      const page = views.get(tabId)?.webContents
      if (page && !page.isDestroyed() && page.isFocused()) return page
    }
    const front = frontTabId()
    const view = front === null ? undefined : views.get(front)
    return view && !view.webContents.isDestroyed() ? view.webContents : null
  }

  if (window instanceof BrowserWindow && popups.has(window)) return window.webContents
  return null
}

/**
 * The tab `page` is, but only while it is drawn in the window's page area.
 * Null for a popup's page and for a page whose tab is in the background — which
 * is what keeps the two things drawn in the corner of a page, the zoom pill and
 * the find bar, from ever being put up for a page that is not under them.
 */
function attachedPageTab(page: WebContents): string | null {
  for (const tabId of attached.keys()) {
    if (views.get(tabId)?.webContents.id === page.id) return tabId
  }
  return null
}

/** The tab whose page the find bar is searching, or null while it is closed. */
let findTabId: string | null = null

/**
 * What the bar is looking for.
 *
 * Held here rather than in the bar itself for the two things that reach past
 * it: Find Next off the menu, which can arrive with the bar closed and has to
 * have something to step through, and reopening, which puts back what was last
 * searched for the way every browser does. The bar's field is a view of this
 * rather than the other way round.
 */
let findQuery = ''

/** The page the bar is searching, or null if it is closed or that page is gone. */
function findPage(): WebContents | null {
  if (findTabId === null) return null
  const view = views.get(findTabId)
  return view && !view.webContents.isDestroyed() ? view.webContents : null
}

/**
 * Hands the query to Chromium. `fresh` is a search being started rather than
 * one being stepped through.
 *
 * It maps to Electron's `findNext`, which is named for the question the caller
 * is asking rather than for what the flag does, and reads exactly the wrong way
 * round: `findNext: true` *begins* a find session, and false continues the one
 * already open. Sent the wrong way round it does not fail — it goes quiet. A
 * continuation of a session that was never started produces no `found-in-page`
 * at all, so the bar keeps the count it was already showing and reports that
 * nothing was found.
 */
function runFind(text: string, forward: boolean, fresh: boolean): void {
  findPage()?.findInPage(text, { forward, findNext: fresh })
}

/**
 * Opens the find bar over the page in front, or brings the keyboard back to a
 * bar already open with its query selected — which is what a second Cmd+F
 * means, in this and in every other browser: search for something else.
 *
 * Here rather than in the menu that calls it for the reason `applyZoom` is (see
 * above): the bar is drawn over the page area of the host window, and this is
 * the module that knows where that area is and which page is in it. The menu
 * knows only that it has a page.
 */
export function openFind(page: WebContents): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  const tabId = attachedPageTab(page)
  if (tabId === null) return

  // Whether the search has to be started rather than merely shown again: a bar
  // that was closed, or one that was open over some other tab, is not already
  // highlighting this page.
  const running = isFindBarOpen() && findTabId === tabId
  findTabId = tabId

  showFindBar(hostWindow, boundsOf(tabId), findQuery, closeFind)
  // The pill is positioned off the area the bar leaves (see `pillArea`), so
  // one still up has to be moved out from under a bar that has just opened
  // over it.
  moveZoomIndicator(pillArea(zoomTabId))

  // The query survives a bar being closed and survives moving between tabs, so
  // an opening bar is rarely empty — and a field with text in it that has
  // highlighted nothing is a bar that looks broken.
  if (!running && findQuery !== '') runFind(findQuery, true, true)
}

/**
 * A new query from the field. Every keystroke arrives here, which is what makes
 * the highlighting live: Chromium is built to be asked this often, and the
 * count comes back on `found-in-page` as it walks the page.
 */
export function setFindQuery(text: string): void {
  findQuery = text
  const page = findPage()
  if (!page) return

  // An empty field is not a search for nothing, it is the search being taken
  // off the page. Chromium sends nothing back for one either, so the count has
  // to be cleared by hand or the bar would go on showing the last one.
  if (text === '') {
    page.stopFindInPage('clearSelection')
    reportFindResult({ matches: 0, active: 0 })
    return
  }

  // Every keystroke starts the search over rather than stepping on from where
  // the last one stopped: the query has changed, so the matches have, and the
  // count goes back to the first of them — which is what typing into a find
  // field looks like in every browser.
  runFind(text, true, true)
}

/** Next match, or the one before it: Enter, the bar's two arrows, and Cmd+G. */
export function stepFind(forward: boolean): void {
  if (findQuery === '') return
  runFind(findQuery, forward, false)
}

/**
 * Find Next and Find Previous off the menu, which unlike the bar's own arrows
 * can arrive with no bar up at all — Cmd+G is a page shortcut like Cmd+R.
 *
 * It opens the bar rather than stepping behind it: a page that scrolls to a
 * match with nothing on screen to say what was matched is a page that appears
 * to move on its own.
 */
export function findAgain(page: WebContents, forward: boolean): void {
  const running = isFindBarOpen() && findTabId === attachedPageTab(page)
  openFind(page)
  // A search that had to be started has already landed on its first match,
  // which is the next one from where the user was standing; stepping again
  // here would skip it.
  if (running) stepFind(forward)
}

/**
 * Takes the bar down and the highlighting with it. The query itself survives —
 * looking for the same thing again, here or on the next page, is the ordinary
 * case, and it is what the next Cmd+F opens onto.
 *
 * `restoreFocus` is false for every way the page itself is leaving: the
 * keyboard would be handed back to a view that is being detached, or to a page
 * that is already loading something else.
 */
function endFind(restoreFocus: boolean): void {
  if (!isFindBarOpen()) return
  const page = findPage()

  hideFindBar()
  findTabId = null

  if (page) {
    // `clearSelection` rather than `keepSelection`: the highlighting is the
    // search made visible, and a page left marked up after the thing doing the
    // marking has gone is one the user has no way to clean up.
    page.stopFindInPage('clearSelection')
    if (restoreFocus) page.focus()
  }

  // The pill sits where it does because of what the bar was taking up, so the
  // corner it goes back to has to be given back to it.
  moveZoomIndicator(pillArea(zoomTabId))
}

/** The bar's own outs: Escape, and the close button on its right. */
export function closeFind(): void {
  endFind(true)
}

/**
 * Zoom, in `zoomLevel`'s units, where a level of n means a factor of 1.2^n.
 * The step is Chromium's, and the bounds are the ends of its own range, which
 * `setZoomLevel` itself does not enforce.
 */
const ZOOM_STEP = 0.5
const MIN_ZOOM_LEVEL = -7.5
const MAX_ZOOM_LEVEL = 8.5

/**
 * Scales the page in front, and says so.
 *
 * Here rather than in the menu that calls it because of the second half: the
 * pill is drawn over the page area of the host window (see
 * src/main/zoom-indicator.ts), and this is the module that knows which page is
 * in that area and where the area is. The menu knows only that it has a page.
 */
function applyZoom(page: WebContents, level: number): void {
  page.setZoomLevel(level)

  if (!hostWindow || hostWindow.isDestroyed()) return
  // Only for the page actually in the window's page area. The same shortcut
  // scales a popup's page while that popup is in front (see `focusedPage`), and
  // there is no corner of that window for the pill to appear in — reporting it
  // over the tab behind would put the number on the wrong page.
  const tabId = attachedPageTab(page)
  if (tabId === null) return

  // 1.2^level is Chromium's own conversion, and the reason the steps land on
  // 110%, 120%, 131% rather than on Chrome's rounder ladder: Chrome picks from
  // a table of factors, this steps the level by a constant.
  zoomTabId = tabId
  showZoomIndicator(hostWindow, pillArea(tabId), Math.round(1.2 ** level * 100))
}

/**
 * Puts the address of the page in front on the clipboard, scheme and all, and
 * says so with the zoom's pill. Here rather than in the menu for the reason
 * `applyZoom` is: the pill needs the page area, and only for the attached tab.
 */
export function copyAddress(page: WebContents): void {
  // An extension's view has an address, but it is the app's page for drawing
  // the tab, or an application's that may carry its token, and not anything
  // the user could go to.
  const tabId = tabIdForWebContents(page)
  if (tabId !== null && isExtensionKind(viewKinds.get(tabId))) return
  const url = page.getURL()
  // Between a tab being created and its first load there is no address to take.
  if (!url) return
  clipboard.writeText(url)

  if (!hostWindow || hostWindow.isDestroyed()) return
  const attachedTab = attachedPageTab(page)
  if (attachedTab === null) return
  zoomTabId = attachedTab
  showCopiedIndicator(hostWindow, pillArea(attachedTab))
}

/** One step larger, held at the top of Chromium's range. */
export function zoomIn(page: WebContents): void {
  applyZoom(page, Math.min(MAX_ZOOM_LEVEL, page.getZoomLevel() + ZOOM_STEP))
}

/** One step smaller, held at the bottom of it. */
export function zoomOut(page: WebContents): void {
  applyZoom(page, Math.max(MIN_ZOOM_LEVEL, page.getZoomLevel() - ZOOM_STEP))
}

/** Back to 100%. Reported like the others: 100% is news when you were at 150%. */
export function resetZoom(page: WebContents): void {
  applyZoom(page, 0)
}

/**
 * Reloads every live view running in one browsing context. For the moment that
 * session is emptied: the pages themselves are untouched by a session being
 * cleared, so without this a tab goes on showing a signed-in screen backed by
 * nothing.
 */
export function reloadViewsIn(context: BrowsingContext): void {
  for (const [tabId, view] of views) {
    const live = tabContexts.get(tabId)
    if (!live || !sameBrowsingContext(live, context)) continue
    if (!view.webContents.isDestroyed()) view.webContents.reload()
  }
}

/**
 * Empties an ephemeral profile once nothing is using it any more.
 *
 * This is what makes incognito incognito rather than merely unsaved: the
 * session is held in memory, so quitting would clear it either way, but a
 * profile that kept its login for the rest of a week-long run of the app would
 * be incognito in name only. The moment the last view in it goes, so does
 * everything it held.
 *
 * Counted in views rather than in tab rows on purpose. A tab that has never
 * been opened has no page and has put nothing in the session, and a tab kept in
 * the background still has its view — so this fires when the last page actually
 * using the profile is torn down, which is the thing the user just did.
 */
function discardEphemeralProfile(context: BrowsingContext): void {
  if (!isEphemeralProfile(context.profile)) return
  if (contextInUse(context)) return

  const partition = partitionFor(context.space, context.profile)
  if (!partition) return

  const target = session.fromPartition(partition)
  // In flight before the clear is in flight against data that is about to go.
  // The session object itself outlives this — Electron has no way to destroy
  // one — and stays usable, listeners included, for whenever the profile is
  // next opened.
  void target.closeAllConnections().then(() => {
    // Asked again, because none of this is instant and the profile can be
    // opened again while it runs. Closing the last incognito tab and starting
    // another one straight away is an ordinary thing to do, and without this
    // the clear would land on the new tab and take the login it had just been
    // given — which would look like the sign-in silently failing.
    if (contextInUse(context)) return undefined
    return target.clearData()
  })
}

/**
 * Whether any live view is running in this browsing context. Per context rather
 * than per profile: incognito in one space is not incognito in another, and a
 * tab still open in one of them is no reason to keep the other's session.
 */
function contextInUse(context: BrowsingContext): boolean {
  for (const live of tabContexts.values()) {
    if (sameBrowsingContext(live, context)) return true
  }
  return false
}

/** Tears down the view for a closed tab. Its page is gone for good. */
export function destroyBrowserView(tabId: string): void {
  // Whatever the next view is made from, it asks for afresh.
  forgetWebViewUrl(tabId)
  const view = views.get(tabId)
  if (!view) return
  // `detachView(false)`: a tab being closed is not a tab being looked away
  // from, and a miniplayer for a page that is about to stop existing would be
  // a window onto nothing.
  if (attached.has(tabId)) detachView(tabId, false)
  const floating = poppedOutTabId() === tabId
  forgetMiniplayer(tabId)
  if (floating) publishPoppedOut()
  const context = tabContexts.get(tabId) ?? DEFAULT_CONTEXT

  views.delete(tabId)
  favicons.delete(tabId)
  errors.delete(tabId)
  loadProgress.delete(tabId)
  tabContexts.delete(tabId)
  viewKinds.delete(tabId)
  extensionTabTypes.delete(tabId)
  nativeFileViewers.delete(tabId)
  const warm = extensionViewsByRecency.indexOf(tabId)
  if (warm !== -1) extensionViewsByRecency.splice(warm, 1)
  view.webContents.close()

  // After the bookkeeping, so the view being closed is no longer counted as one
  // of the context's own.
  discardEphemeralProfile(context)
}

export function destroyAllBrowserViews(): void {
  for (const tabId of [...views.keys()]) destroyBrowserView(tabId)
  // Children of the same window the views were children of, so they go when
  // those do — on the window closing, and on a new one replacing it.
  destroyZoomIndicator()
  destroyFindBar()
  destroySplitDrop()
}
