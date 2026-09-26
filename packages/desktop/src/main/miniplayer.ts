import { join } from 'path'
import { BaseWindow, BrowserWindow, screen, WebContentsView } from 'electron'
import type { BrowserWindowConstructorOptions, Rectangle, WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { MINIPLAYER_AGENT, type MiniplayerKind } from './miniplayer-agent'
import { constrainVideoResize } from './video-resize'

/**
 * The floating window a page keeps playing in once you have looked away, and
 * the tab's way back.
 *
 * Three routes into it, in the order they are tried, which is Chrome's order:
 *
 * - A call. The page registered a media session handler for
 *   `enterpictureinpicture` and is capturing a camera or a microphone, so it
 *   is told to enter, and it opens its own compact interface into the window
 *   this module then dresses. Meet's call tile, with its own mute and leave
 *   buttons, rather than a shrunken web page — the site knows what matters at
 *   that size and this app does not.
 * - A video. Nothing registered, but something is playing, so the video
 *   element itself is moved into a window of this app's making and moved back
 *   afterwards.
 * - Neither, which is most pages, and nothing happens. A page that has nothing
 *   playing has no business following you around.
 *
 * And one route the user asks for outright: `popOut`, which takes the whole
 * live view out of the window and floats it. That one is deliberate, so it
 * makes no judgement about what the page is doing.
 *
 * Only ever one at a time. Two floating windows is a window manager, which is
 * a thing the operating system already is.
 */

/** Where a miniplayer sits, and how far off the corner of the screen. */
const INSET = 24

/** What a window may be talked down to or up to, whatever size was asked for. */
const MIN_WIDTH = 240
const MAX_WIDTH = 720
const MIN_HEIGHT = 160
const MAX_HEIGHT = 520

/** The default, for a `window.open` that named no size. */
const DEFAULT_SIZE = { width: 400, height: 260 }

/**
 * A floating window of this app's making: the page in it, and the bar across
 * its top that names the tab and holds the way back (see `createBar`).
 */
type Floating = {
  window: BaseWindow
  view: WebContentsView
  bar: WebContentsView
}

type Session = {
  tabId: string
  /** The page the miniplayer belongs to, which is not the window's own. */
  page: WebContents
  /**
   * The floating window, or null when the miniplayer is Chromium's own
   * picture-in-picture rather than one of this app's windows — the fallback
   * for a video that refuses to be captured. There is nothing to place, dress
   * or destroy in that case, and the page is still owed its `leave`.
   */
  floating: Floating | null
  /**
   * Whether the page opened it of its own accord — Meet's picture-in-picture
   * button — rather than being offered one on the way off screen. Chrome keeps
   * a window like that open when the tab comes back, because nobody asked for
   * it to follow the tab; only closing it, or the way back, takes it down.
   */
  asked: boolean
}

/** The miniplayer that is up, if one is. */
let session: Session | null = null

/**
 * The tab whose page is in the middle of opening a miniplayer window, held
 * between the `window.open` being answered and the window arriving.
 *
 * Both halves happen inside the one `executeJavaScript` that asked the page to
 * enter — `window.open` blocks the page until the main process has answered it
 * — so this is never set across anything that could interleave.
 */
let opening: { tabId: string; page: WebContents } | null = null

/**
 * The page kept rendering behind a miniplayer, and whether it was throttled
 * before, so that it can be put back as it was.
 *
 * A page whose view is off screen gets no animation frames, and the site is
 * drawing its miniplayer from that page: its scripts run in the opener, not in
 * the window they draw into. Meet copies its styles across straight away and
 * puts its call tile in on the next frame, so a throttled page gets the styles
 * and never the tile — a black window, with the tab believing it is in there.
 * Chrome keeps a tab with a picture-in-picture window rendering for the same
 * reason. The page still reports itself hidden; only the throttling goes.
 */
let awake: { page: WebContents; throttled: boolean } | null = null

function keepAwake(page: WebContents): void {
  if (awake?.page === page) return
  letSleep()
  awake = { page, throttled: page.getBackgroundThrottling() }
  page.setBackgroundThrottling(false)
}

function letSleep(): void {
  const current = awake
  awake = null
  if (current && !current.page.isDestroyed()) {
    current.page.setBackgroundThrottling(current.throttled)
  }
}

/** The tab taken out of the window whole, if any, and where it went. */
let poppedOut: ({ tabId: string } & Floating) | null = null

/** A floating window's own title bar, above the page rather than over it. */
const BAR_HEIGHT = 32

/**
 * What a floating window's bar says about the tab in it: what its row in the
 * sidebar says. The main window's renderer works it out, since that is where
 * a tab's name and icon are decided (see `describeFloating`).
 */
export type PoppedOutTab = {
  label: string
  /** The site's icon or a file's preview, as a `data:` URL, when it has one. */
  image: string | null
  /** The Iconify class drawn when there is no image, or it will not decode. */
  glyph: string
}

/** The last description of each floating tab, kept for a bar still loading. */
const described = new Map<string, PoppedOutTab>()

/**
 * Told whenever the set of tabs with a floating window changes, so the main
 * window can say what each is called (see `floatingTabIds`).
 */
let floatingChanged: () => void = () => undefined

export function onFloatingChanged(listener: () => void): void {
  floatingChanged = listener
}

/** Every tab with a bar up for it: the one floating whole, and a miniplayer's. */
export function floatingTabIds(): string[] {
  const ids = new Set<string>()
  if (poppedOut) ids.add(poppedOut.tabId)
  if (session?.floating) ids.add(session.tabId)
  return [...ids]
}

/**
 * Puts the agent into a page, and keeps it there: a document is a fresh
 * `window`, so each one needs its own copy (see src/main/miniplayer-agent.ts).
 *
 * Called once per view, for the life of the view.
 */
export function armMiniplayer(tabId: string, page: WebContents): void {
  page.on('dom-ready', () => {
    void page.executeJavaScript(MINIPLAYER_AGENT, false).catch(() => undefined)
  })

  // A page that navigates away is not the page the miniplayer was opened for,
  // whatever it does next. Same-document navigation is the page moving within
  // itself — which is every click inside Meet — and leaves it alone.
  page.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return
    if (session?.tabId === tabId) closeSession()
  })
}

/**
 * Offers the miniplayer to a tab that is leaving the screen, and reports what
 * it took. The page decides: this end knows a tab was hidden, and only the
 * page knows whether anything is playing in it.
 *
 * `isCurrentlyAudible` is passed along because it answers from out here a
 * question the page cannot always answer from in there: a call joined with the
 * camera and microphone off is capturing nothing, and is still a call.
 */
export async function enterMiniplayer(tabId: string, page: WebContents): Promise<MiniplayerKind> {
  if (page.isDestroyed() || session || poppedOut) return 'none'

  const request = { audible: page.isCurrentlyAudible() }
  opening = { tabId, page }
  // Before the page is asked, not once it has answered: the frame it is about
  // to ask for is requested inside the handler this runs.
  keepAwake(page)
  try {
    // Run as a user gesture. Nobody clicked anything — the user looked away,
    // which is the opposite — but both of the things the page is about to try
    // are gated on one: a popup without a gesture can be blocked, and
    // `requestPictureInPicture` refuses outright. Chrome grants its own
    // automatic entry the same exemption, for the same reason.
    const kind = (await page.executeJavaScript(
      `window.__fluidMiniplayer` +
        `? window.__fluidMiniplayer.enter('contentoccluded', ${JSON.stringify(request)})` +
        `: 'none'`,
      true
    )) as MiniplayerKind

    // A window of this app's own has already been adopted by now, inside the
    // call above. Anything else that entered did so without one — Chromium's
    // picture-in-picture — and still has to be remembered, or nothing would
    // ever ask the page to come out of it.
    if (kind !== 'none' && !session) session = { tabId, page, floating: null, asked: false }
    if (!session) letSleep()
    return kind
  } catch {
    // A page that was torn down mid-question, or one that refused the script.
    // Either way there is no miniplayer, which is the ordinary answer here.
    if (!session) letSleep()
    return 'none'
  } finally {
    opening = null
  }
}

/**
 * Takes the miniplayer back down, for a tab that is on screen again — unless
 * the page opened it itself, in which case it outlasts the tab coming back
 * (see `Session.asked`). The page is told first and the window is only
 * insisted upon afterwards: closing the window is how a site learns it is out
 * of the miniplayer — Meet and the rest listen for `pagehide` on the window
 * they were handed — and a window pulled out from under it would leave its
 * interface in a window that no longer exists.
 */
export function leaveMiniplayer(tabId: string): void {
  if (session?.tabId !== tabId || session.asked) return
  closeSession()
}

/**
 * The same, whoever opened it: the user asked for the tab back, or for the
 * whole tab to float instead, and either way the miniplayer is over.
 */
export function closeMiniplayer(tabId: string): void {
  if (session?.tabId === tabId) closeSession()
}

/** The same, for a tab being closed: there is no page left to tell. */
export function forgetMiniplayer(tabId: string): void {
  if (session?.tabId === tabId) closeSession()
  if (poppedOut?.tabId === tabId) discardPopOut()
}

function closeSession(): void {
  const current = session
  session = null
  if (!current) return
  letSleep()

  if (!current.page.isDestroyed()) {
    void current.page
      .executeJavaScript(`window.__fluidMiniplayer && window.__fluidMiniplayer.leave()`, false)
      .catch(() => undefined)
  }
  // Belt and braces: the page closes its own window above, and this is for the
  // page that could not be asked.
  if (current.floating) {
    if (!current.floating.window.isDestroyed()) current.floating.window.destroy()
    described.delete(current.tabId)
    floatingChanged()
  }
}

/**
 * Builds the window for one, in place of the one `window.open` would have
 * made (see `createWindow` in `handleWindowOpen`), and takes charge of it.
 * Returns the page's half, which is what Electron puts the popup's document
 * in.
 *
 * A window of this app's making rather than Electron's, so that the bar can go
 * above the page rather than over it: a window Electron makes for a popup is
 * all page, with no room in it for anything else, and a bar laid over the top
 * of a call tile covers the site's own controls.
 *
 * The size the page asked for is honoured within reason — a site knows the
 * shape of what it is about to draw — and the corner is this app's to choose.
 */
export function openMiniplayerWindow(
  tabId: string,
  page: WebContents,
  host: BrowserWindow,
  features: string,
  options: BrowserWindowConstructorOptions
): WebContents {
  const { width, height, aspectRatio } = sizeFromFeatures(features)
  const area = screen.getDisplayMatching(host.getBounds()).workArea
  const total = height + BAR_HEIGHT

  // The contents Chromium has already made for the popup, which is where the
  // page's `window.open` handle points. Not in Electron's types, but always
  // passed to `createWindow`.
  const { webContents } = options as BrowserWindowConstructorOptions & {
    webContents?: WebContents
  }
  const view = new WebContentsView({ webContents, webPreferences: options.webPreferences })
  // Opaque: what goes in it is a video or a call, and both paint every pixel.
  view.setBackgroundColor('#000000')

  const floating = createFloating(tabId, view, {
    width,
    height: total,
    x: Math.round(area.x + area.width - width - INSET),
    y: Math.round(area.y + area.height - total - INSET)
  })
  if (aspectRatio) {
    constrainVideoResize(floating.window, aspectRatio, BAR_HEIGHT, {
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT
    })
  }
  adoptMiniplayerWindow(tabId, page, floating)
  return view.webContents
}

/** Makes a miniplayer window the tab's miniplayer, whoever asked for it. */
function adoptMiniplayerWindow(tabId: string, page: WebContents, floating: Floating): void {
  const { window, view, bar } = floating

  // Offered, when it arrives while this app is asking the page to enter or in
  // place of a window that was offered: a site may ask for its window again
  // while it has one, and gets a new window in place of the old (see
  // `requestWindow` in src/main/miniplayer-agent.ts). Anything else is the
  // page asking on its own, from a click in it.
  const offered = opening?.tabId === tabId || (session?.tabId === tabId && !session.asked)

  // Only ever one. Another tab's miniplayer gives way to the one just asked
  // for, the way Chrome's does: the newest request is the one the user made.
  if (session && session.tabId !== tabId) closeSession()

  // In place of the tab's previous window, if it had one. The page closes
  // that one itself; this is for a page that did not get round to it. Its
  // `closed` handler below finds itself no longer the session's and leaves the
  // page alone, which is right — the page has already moved on to this one.
  const previous = session?.floating?.window
  session = { tabId, page, floating, asked: !offered }
  if (previous && previous !== window && !previous.isDestroyed()) previous.destroy()
  // For as long as it is up, whichever way it came: an asked-for one starts
  // with the tab on screen, and is there for the moment it no longer is.
  keepAwake(page)
  floatingChanged()

  // The page closing its window — which is how a site leaves on its own, and
  // what `leave` asks it to do — takes this window with it. Electron would do
  // that for a window of its own making; this one is only holding the page.
  view.webContents.once('destroyed', () => {
    if (!window.isDestroyed()) window.destroy()
  })

  window.once('closed', () => {
    // And the other way round: a window closed out from under the page closes
    // the page's half too, which the page hears as its window going away.
    if (!view.webContents.isDestroyed()) view.webContents.close()
    if (!bar.webContents.isDestroyed()) bar.webContents.close()
    if (session?.floating?.window !== window) return
    const { page } = session
    session = null
    described.delete(tabId)
    letSleep()
    floatingChanged()
    // Closed by the user rather than by this app, so the page still believes
    // it is in a miniplayer: whatever it moved out has to be moved back.
    if (!page.isDestroyed()) {
      void page
        .executeJavaScript(`window.__fluidMiniplayer && window.__fluidMiniplayer.cleanup()`, false)
        .catch(() => undefined)
    }
  })
}

/**
 * Floats a whole live tab: the view leaves the window it was in and becomes
 * the contents of a small one, still running, still the same page.
 *
 * The fallback for everything the two automatic paths cannot help — a site
 * with no video element and no handler — and the only one the user asks for
 * outright, which is why it applies no test to the page at all.
 */
export function popOut(tabId: string, view: WebContentsView, host: BrowserWindow): void {
  if (poppedOut?.tabId === tabId) return

  // Only ever one floating window, and the newest ask is the one the user
  // meant: whatever was floating before goes home and this takes its place —
  // where the user had moved it to and at the size they had left it, since
  // that is where they have already decided a floating window belongs. The
  // tab that was floating is let go of without being shown: which tab is on
  // screen is the browser's business, and it is the one being floated now.
  // A miniplayer for another tab's call or video gives way the same.
  const previous = poppedOut
  const place = previous && !previous.window.isDestroyed() ? previous.window.getBounds() : null
  if (previous) {
    poppedOut = null
    described.delete(previous.tabId)
    releaseWindow(previous)
  }
  if (session) closeSession()

  const area = screen.getDisplayMatching(host.getBounds()).workArea
  const width = place?.width ?? DEFAULT_SIZE.width
  const height = place?.height ?? DEFAULT_SIZE.height + BAR_HEIGHT
  poppedOut = {
    tabId,
    ...createFloating(tabId, view, {
      width,
      height,
      x: place?.x ?? Math.round(area.x + area.width - width - INSET),
      y: place?.y ?? Math.round(area.y + area.height - height - INSET)
    })
  }
  floatingChanged()
}

/**
 * A frameless window above everything, with the bar across its top and `view`
 * filling the rest.
 */
function createFloating(tabId: string, view: WebContentsView, bounds: Rectangle): Floating {
  const window = new BaseWindow({
    ...bounds,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // No `parent`, unlike an ordinary popup. A parented window sinks with the
    // window it belongs to, and this one exists precisely for the moments that
    // window is not what the user is looking at.
    //
    // The main window's glass, which is what the bar is drawn on. What floats
    // under it can be any tab at all, and an extension's page declares no
    // background of its own on purpose — over an opaque window that has
    // nothing clearing it between frames, every frame it draws is left smeared
    // over the last. A miniplayer's page brings its own black.
    ...(process.platform === 'darwin'
      ? {
          vibrancy: 'hud' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000'
        }
      : { backgroundColor: '#18181b' })
  })
  // Above full-screen apps and on whichever space the user is on, which is the
  // difference between a floating window and one that is merely on top: the
  // tab was left behind to go and do something else, and that something else
  // is often a full-screen editor on another space.
  window.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  const bar = createBar(tabId)
  window.contentView.addChildView(view)
  window.contentView.addChildView(bar)
  const layout = (): void => {
    if (window.isDestroyed()) return
    const [nextWidth, nextHeight] = window.getContentSize()
    bar.setBounds({ x: 0, y: 0, width: nextWidth, height: BAR_HEIGHT })
    view.setBounds({ x: 0, y: BAR_HEIGHT, width: nextWidth, height: nextHeight - BAR_HEIGHT })
  }
  layout()
  window.on('resize', layout)

  return { window, view, bar }
}

/**
 * A floating window's title bar: the tab's icon and name, the way back, the
 * way out, and the one part of a frameless window the user can take hold of.
 *
 * A view of its own rather than something put into the page. A popped-out tab
 * can be anything, an extension's page included, and a miniplayer is a site's
 * own document, governed by the site's rules; and whatever a page keeps along
 * its top edge — which is where nearly every page keeps its own buttons —
 * would sit under a bar laid over it. One of the app's own pages, like the find
 * bar, because the tab's icon may be one of the app's glyphs, which only the
 * app's stylesheet can draw.
 */
function createBar(tabId: string): WebContentsView {
  const bar = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  bar.setBackgroundColor('#00000000')

  // Whatever arrived while it was loading.
  bar.webContents.on('did-finish-load', () => {
    const tab = described.get(tabId)
    if (tab) bar.webContents.send('popout:tab', tab)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void bar.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/popout.html`)
  } else {
    void bar.webContents.loadFile(join(__dirname, '../renderer/popout.html'))
  }
  return bar
}

/**
 * Tells a floating window's bar what the tab in it is called and looks like,
 * from the main window's renderer — again whenever that changes, since a page
 * goes on retitling itself while it floats. Ignored for any tab with no bar
 * up, which is a description that crossed the window closing.
 */
export function describeFloating(tabId: string, tab: PoppedOutTab): void {
  const bars: WebContentsView[] = []
  if (poppedOut?.tabId === tabId) bars.push(poppedOut.bar)
  if (session?.tabId === tabId && session.floating) bars.push(session.floating.bar)
  if (bars.length === 0) return
  described.set(tabId, tab)
  for (const { webContents } of bars) {
    if (!webContents.isDestroyed() && !webContents.isLoading()) webContents.send('popout:tab', tab)
  }
}

/**
 * Which floating window a bar belongs to, for the bar's buttons: a tab
 * floating whole, or a tab's miniplayer. Null for anything that is not a bar.
 */
export function floatingOwner(
  sender: WebContents
): { kind: 'tab' | 'miniplayer'; tabId: string } | null {
  if (poppedOut?.bar.webContents === sender) return { kind: 'tab', tabId: poppedOut.tabId }
  if (session?.floating?.bar.webContents === sender) {
    return { kind: 'miniplayer', tabId: session.tabId }
  }
  return null
}

/**
 * Hands a popped-out tab back, and says which it was. The view is returned
 * rather than reattached: which window a view belongs in, and whether this one
 * is even the tab on screen any more, is the browser's business rather than
 * the miniplayer's.
 */
export function popIn(): { tabId: string; view: WebContentsView } | null {
  const current = poppedOut
  if (!current) return null
  poppedOut = null

  described.delete(current.tabId)
  releaseWindow(current)
  floatingChanged()
  return { tabId: current.tabId, view: current.view }
}

/** The tab that is floating whole, if any. */
export function poppedOutTabId(): string | null {
  return poppedOut?.tabId ?? null
}

/** Throws away the window around a popped-out tab that is being closed. */
function discardPopOut(): void {
  const current = poppedOut
  poppedOut = null
  if (!current) return
  described.delete(current.tabId)
  releaseWindow(current)
  floatingChanged()
}

/**
 * Takes the page back out of a popped-out window and throws the rest away. The
 * page is lifted out first so the window does not take it down with it; the
 * bar is the window's own and goes with it.
 */
function releaseWindow({ view, bar, window }: Floating): void {
  if (!window.isDestroyed()) {
    window.contentView.removeChildView(view)
    window.destroy()
  }
  if (!bar.webContents.isDestroyed()) bar.webContents.close()
}

/**
 * The size out of a `window.open`'s features string, which is where the size a
 * page asked for arrives: `documentPictureInPicture.requestWindow({width,
 * height})` becomes `width=360,height=240` by the time it reaches here (see
 * the polyfill in src/main/miniplayer-agent.ts).
 */
function sizeFromFeatures(features: string): {
  width: number
  height: number
  aspectRatio: number | null
} {
  const asked = new Map<string, number>()
  for (const entry of features.split(',')) {
    const [name, value] = entry.split('=')
    const size =
      name?.trim() === 'fluid-video-aspect-ratio' ? Number(value) : Number.parseInt(value ?? '', 10)
    if (name && Number.isFinite(size)) asked.set(name.trim(), size)
  }

  const ratio = asked.get('fluid-video-aspect-ratio')
  const aspectRatio = ratio !== undefined && ratio > 0 ? ratio : null
  let width = clamp(Math.round(asked.get('width') ?? DEFAULT_SIZE.width), MIN_WIDTH, MAX_WIDTH)
  let height = clamp(Math.round(asked.get('height') ?? DEFAULT_SIZE.height), MIN_HEIGHT, MAX_HEIGHT)
  if (aspectRatio) {
    // Match the first frame to the picture ratio used during user resizing.
    // For very tall or wide videos, fitting within the maximum size takes
    // precedence over the usual minimums so the picture is never letterboxed.
    height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, width / aspectRatio))
    width = Math.min(MAX_WIDTH, height * aspectRatio)
    height = width / aspectRatio
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    aspectRatio
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
