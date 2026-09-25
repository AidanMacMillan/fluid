import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import {
  MessageChannelMain,
  session,
  type Input,
  type MessagePortMain,
  type WebContents
} from 'electron'
import {
  isWebAddress,
  type Accelerator,
  type Disposable,
  type TabViewDeclaration,
  type ViewConnection,
  type WebViewDeclaration
} from '@fluid/sdk'
import { fileViewer, tabType, viewConnectorsFor } from './api/contributions'
import { mayReach } from './api/isolation-policy'
import { getTab } from './db/tabs'
import { registerFileProtocolOn } from './files'

/**
 * The views extension tabs are drawn in, as far as the extension is concerned.
 *
 * Laying a view out, keeping it warm and tearing it down is the same job for
 * every kind of view and stays in src/main/browser-views.ts, which makes these
 * as `extension` views. What is here is what only an extension's view has:
 *
 * - **Its page.** One page of the app's own, `extension-view.html`, loaded for
 *   every tab of every extension type. It brings the stylesheet and the bridge,
 *   and draws whatever the extension's `ExtensionView` for the tab's type draws
 *   (see src/renderer/src/extension-view.ts). The tab and its type travel in
 *   the query.
 * - **Its session.** One partition per extension, so each has its own storage,
 *   with the app's file store and the extension's own schemes served on it.
 * - **Who it is.** Every view is recorded against the extension and tab it was
 *   made for, keyed by its web contents. The bridge (see
 *   src/main/extension-view-ipc.ts) answers a call by looking the sender up
 *   here, never by anything the page says about itself.
 * - **Its connection.** A `MessageChannelMain` per page load, one end handed to
 *   the page and the other wrapped as the `ViewConnection` the extension's
 *   `ctx.views.onConnect` listeners are given.
 *
 * A page draws one of three things: a tab of one of the extension's types, a
 * file tab one of its file viewers draws (see `FileViewerContribution`), or
 * the extension's section of the settings window (see src/main/settings-views.ts).
 * Which of the first two is its *view type* — the tab type's full id, or the
 * viewer's behind `file:` — a single string because it travels as one, in the
 * page's query and the bookkeeping of src/main/browser-views.ts. A settings
 * page has no tab, and so no view type of that kind.
 *
 * All of that is for a `page` view. A `web` view — an application the extension
 * serves, drawn at an address it names (see `WebViewDeclaration`) — has none of
 * it: no page of the app's, no bridge, no connection. What it has instead is
 * here too: a session of its own, the address each tab's view is to load, and
 * the keys and stylesheet its type asked for.
 *
 * @module extension-views
 */

/** The preload every extension view gets, and the only thing it can reach the app through. */
export const EXTENSION_VIEW_PRELOAD = join(__dirname, '../preload/extension-view.js')

/** An extension's own session. Persistent, so a page's own storage survives a relaunch. */
export function extensionPartition(extensionId: string): string {
  return `persist:extension-${extensionId}`
}

/**
 * The session an extension's web views run in: one per extension, shared by
 * every one of them, and persisted — it is where the application keeps whatever
 * makes it the user's, a sign-in above all, and clearing it signs them out.
 *
 * Not the extension's own session. That one serves the app's page, the file
 * store and the extension's schemes to pages holding the bridge; an
 * application served from somewhere else has no business with any of them.
 * The dot keeps the two apart for any id: ids are letters, digits and dashes.
 */
export function extensionWebPartition(extensionId: string): string {
  return `persist:extension-${extensionId}.web`
}

/**
 * Gets an extension's session ready for its first view: the app's file store,
 * so a page can show a file tab's picture the way the app's windows do. The
 * extension's own schemes are put there by the host as it registers them.
 */
export function prepareExtensionSession(extensionId: string): void {
  registerFileProtocolOn(session.fromPartition(extensionPartition(extensionId)))
}

/** Whether a view declaration is for a web application rather than a page of the app's. */
export function isWebView(declaration: TabViewDeclaration): declaration is WebViewDeclaration {
  return declaration.kind === 'web'
}

/**
 * What stands in front of a file viewer's id to make it a view type. No tab
 * type can start with it: a tab type starts with its extension's id, which is
 * letters, digits and dashes.
 */
const FILE_VIEW_TYPE_PREFIX = 'file:'

/** The view type of a page drawn by the file viewer `viewerId` (its full id). */
export function fileViewType(viewerId: string): string {
  return `${FILE_VIEW_TYPE_PREFIX}${viewerId}`
}

/**
 * What a page draws: a tab of one of an extension's types, a file for one of
 * its viewers, or its section of the settings window (whose `id` is always
 * `settings`).
 */
export type ViewSubject = { kind: 'tab' | 'file' | 'settings'; extensionId: string; id: string }

/**
 * The extension a view type belongs to, what it draws, and how it asked to be
 * drawn, if it is one drawn in a view — a tab type registered with a `view`,
 * or a `page` file viewer, by an extension that is running. Null for anything
 * else, including one whose extension has since been disabled.
 */
export function viewTypeOf(
  viewType: string
): { extensionId: string; subject: ViewSubject; declaration: TabViewDeclaration } | null {
  if (viewType.startsWith(FILE_VIEW_TYPE_PREFIX)) {
    const viewerId = viewType.slice(FILE_VIEW_TYPE_PREFIX.length)
    const viewer = fileViewer(viewerId)
    const view = viewer?.contribution.view
    if (!viewer || view?.kind !== 'page') return null
    const { extensionId } = viewer
    return {
      extensionId,
      subject: { kind: 'file', extensionId, id: viewer.contribution.id },
      declaration: { kind: 'page', keys: view.keys, focusOnShow: view.focusOnShow }
    }
  }

  const dot = viewType.indexOf('.')
  if (dot === -1) return null
  const declaration = tabType(viewType)?.view
  if (!declaration) return null
  const extensionId = viewType.slice(0, dot)
  return {
    extensionId,
    subject: { kind: 'tab', extensionId, id: viewType.slice(dot + 1) },
    declaration
  }
}

/**
 * The page for one tab. The dev server's while developing, so extension views
 * are rebuilt as they are edited like every other page; the built file after.
 */
export function extensionViewUrl(viewType: string, tabId: string): string {
  const query = new URLSearchParams({ type: viewType, tab: tabId }).toString()
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServer) return `${devServer}/extension-view.html?${query}`
  const url = pathToFileURL(join(__dirname, '../renderer/extension-view.html'))
  url.search = query
  return url.href
}

/** The page for an extension's section of the settings window. */
export function extensionSettingsUrl(extensionId: string): string {
  const query = new URLSearchParams({ settings: extensionId }).toString()
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServer) return `${devServer}/extension-view.html?${query}`
  const url = pathToFileURL(join(__dirname, '../renderer/extension-view.html'))
  url.search = query
  return url.href
}

// ---------------------------------------------------------------------------
// Who each view is
// ---------------------------------------------------------------------------

export type ExtensionViewOwner = {
  extensionId: string
  /** The tab it draws. Null for a settings page, which draws none. */
  tabId: string | null
  /** What the page draws: its view type (see `viewTypeOf`), and that type read. */
  viewType: string
  subject: ViewSubject
  webContents: WebContents
  /** The page's current connection, or null between loads. */
  connection: LiveConnection | null
}

const owners = new Map<number, ExtensionViewOwner>()

/** The extension view `webContents` is, or undefined for anything else. */
export function ownerOf(webContents: WebContents): ExtensionViewOwner | undefined {
  return owners.get(webContents.id)
}

/** Every extension view there is, on screen or kept warm. */
export function extensionViewOwners(): ExtensionViewOwner[] {
  return [...owners.values()]
}

/**
 * Records a new view against the tab it was made for, and wires up what only an
 * extension's view needs: the keys its type claims, and dropping its
 * connection whenever the page it was made with goes.
 */
export function adoptExtensionView(
  webContents: WebContents,
  tabId: string,
  viewType: string
): void {
  const found = viewTypeOf(viewType)
  if (!found || isWebView(found.declaration)) {
    throw new Error(`${viewType} is not drawn in a page view.`)
  }

  const owner: ExtensionViewOwner = {
    extensionId: found.extensionId,
    tabId,
    viewType,
    subject: found.subject,
    webContents,
    connection: null
  }
  owners.set(webContents.id, owner)

  yieldKeysTo(webContents, found.declaration.keys ?? [])
  followLifetime(owner)
}

/**
 * Records a new view of an extension's section of the settings window. It has
 * no tab, claims no keys, and nothing in the main half follows it: the page
 * reaches the extension through `call`.
 */
export function adoptSettingsView(webContents: WebContents, extensionId: string): void {
  const owner: ExtensionViewOwner = {
    extensionId,
    tabId: null,
    viewType: `${extensionId}.settings`,
    subject: { kind: 'settings', extensionId, id: 'settings' },
    webContents,
    connection: null
  }
  owners.set(webContents.id, owner)
  followLifetime(owner)
}

function followLifetime(owner: ExtensionViewOwner): void {
  const { webContents } = owner
  // A new document is a new page, which connects again for itself; the old
  // page's connection is about something that no longer exists. A move within
  // the document is not a new page.
  webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) disconnect(owner)
  })
  webContents.on('render-process-gone', () => disconnect(owner))
  webContents.once('destroyed', () => {
    disconnect(owner)
    owners.delete(webContents.id)
  })
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

type Chord = { meta: boolean; control: boolean; shift: boolean; alt: boolean; key: string }

/**
 * Reads an accelerator the way Electron's menu does, for the few modifiers an
 * extension has any business claiming. Null for one it cannot read, and for
 * the two no view may have: a window that cannot be closed or quit from the
 * keyboard is a trap.
 */
function chordOf(accelerator: string): Chord | null {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase())
  const key = parts.pop()
  if (!key) return null

  const mac = process.platform === 'darwin'
  const chord: Chord = { meta: false, control: false, shift: false, alt: false, key }
  for (const modifier of parts) {
    if (modifier === 'cmdorctrl' || modifier === 'commandorcontrol') {
      if (mac) chord.meta = true
      else chord.control = true
    } else if (modifier === 'cmd' || modifier === 'command' || modifier === 'meta') {
      chord.meta = true
    } else if (modifier === 'ctrl' || modifier === 'control') {
      chord.control = true
    } else if (modifier === 'shift') {
      chord.shift = true
    } else if (modifier === 'alt' || modifier === 'option') {
      chord.alt = true
    } else {
      return null
    }
  }

  const primary = mac ? chord.meta : chord.control
  if (primary && (key === 'w' || key === 'q')) return null
  return chord
}

function matches(chord: Chord, input: Input): boolean {
  return (
    input.meta === chord.meta &&
    input.control === chord.control &&
    input.shift === chord.shift &&
    input.alt === chord.alt &&
    input.key.toLowerCase() === chord.key
  )
}

/**
 * The keys the application menu binds that an application in a web view should
 * have instead, when its type asks for them all.
 *
 * The menu's accelerators fire before the page sees anything, which is right
 * for a browser tab — Cmd+F is the app's find bar, Cmd+R reloads the page — and
 * wrong for an application, where the same keys are its own Find and Save and
 * the user has years of muscle memory saying so. The worst of them is Cmd+S:
 * bound here to the sidebar, in an editor it means a file that silently never
 * saves.
 *
 * Listed as the keys to give away rather than the keys to keep, because the
 * menu is the app's and its bindings are known, while the application's are
 * its user's and are not — an editor's arrive over its own settings sync and
 * can be anything.
 *
 * Two are deliberately not given away. Cmd+Q and Cmd+W are window management
 * the user expects to work in any tab of any app, and a view that swallowed
 * them would be a window that cannot be closed from the keyboard. Nor are the
 * plain editing roles — cut, copy, paste, select-all — given away: on macOS
 * those go out as first-responder actions, which is a path that reaches the
 * view's page reliably, and intercepting them would replace something that
 * works with something that might.
 */
const APPLICATION_KEYS = new Set(['t', 's', 'f', 'g', 'r', '0', '-', '=', '+'])

/** Whether this keystroke is one an application given every key should have instead of the menu. */
function applicationClaims(input: Input): boolean {
  const modifier = process.platform === 'darwin' ? input.meta : input.control
  if (!modifier || input.alt) return false
  const key = input.key.toLowerCase()
  // Cmd+Shift+C is the app's Copy Address and worth giving away; plain Cmd+C is
  // copy, and taking that would stop the application copying anything at all.
  if (key === 'c') return input.shift
  return APPLICATION_KEYS.has(key)
}

/**
 * Hands the page the keys its type claims, for as long as one of them is being
 * pressed.
 *
 * `setIgnoreMenuShortcuts` is the one lever that does this: `before-input-event`
 * can only stop a keystroke outright — `preventDefault` there takes it from the
 * page as well as from the menu — while this redirects it. Set from inside the
 * event, which is where Electron documents it being set, and recomputed on
 * every keystroke so the menu has every other key back straight away.
 */
function yieldKeysTo(webContents: WebContents, keys: Accelerator[] | 'all'): void {
  if (keys === 'all') {
    webContents.on('before-input-event', (_event, input) => {
      webContents.setIgnoreMenuShortcuts(applicationClaims(input))
    })
    return
  }
  const chords = keys.map(chordOf).filter((chord): chord is Chord => chord !== null)
  if (chords.length === 0) return
  webContents.on('before-input-event', (_event, input) => {
    webContents.setIgnoreMenuShortcuts(
      input.type === 'keyDown' && chords.some((chord) => matches(chord, input))
    )
  })
}

// ---------------------------------------------------------------------------
// Web views
// ---------------------------------------------------------------------------

/**
 * tab id → the address its web view loads, once its type has named one (see
 * `prepareWebView`). Only ever held here, so a token an application's address
 * carries never crosses to the app's windows; and only for this run, since an
 * address is the answer of whatever serves the application now.
 */
const webViewUrls = new Map<string, string>()

/** Whether a web view can be put up: whether it has an address, or why not. */
export type WebViewReadiness = { ok: true } | { ok: false; message: string }

/**
 * Asks a tab's type where its web view should point, and keeps the answer for
 * `webViewUrlOf`. The renderer asks this before it shows the tab, and shows it
 * once the answer is yes.
 *
 * Slow when the extension has something to start — a server, say, which on
 * its first run may have to download itself — and the renderer says so in the
 * meantime. The tab is read here rather than taken from the renderer, so a
 * type is only ever asked about a tab that is really one of its own.
 */
export async function prepareWebView(tabId: string, fullType: string): Promise<WebViewReadiness> {
  const found = viewTypeOf(fullType)
  const declaration = found?.declaration
  if (!found || !declaration || !isWebView(declaration)) {
    return { ok: false, message: 'This tab belongs to an extension that is not enabled.' }
  }
  const tab = await getTab(tabId)
  if (!tab || tab.type !== fullType) return { ok: false, message: 'This tab no longer exists.' }

  let url: string
  try {
    url = await declaration.url(tab)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  // An address an extension wrote, but loaded into a view all the same, and a
  // view that loaded `file:` would read the disk into a tab. An installed
  // extension's has to be on a host its manifest names, like its fetches:
  // the address is where it could otherwise carry what it knows to.
  if (!isWebAddress(url) || !mayReach(found.extensionId, url)) {
    return { ok: false, message: 'The extension named somewhere a tab cannot show.' }
  }
  webViewUrls.set(tabId, url)
  return { ok: true }
}

/** The address a tab's web view loads, once `prepareWebView` has found one. */
export function webViewUrlOf(tabId: string): string | undefined {
  return webViewUrls.get(tabId)
}

/**
 * Lets go of a tab's address, when its view goes: the next view made for it
 * asks again, and gets whatever is true by then.
 */
export function forgetWebViewUrl(tabId: string): void {
  webViewUrls.delete(tabId)
}

/**
 * Wires up what a web view's type asked for: the keys it gets before the menu,
 * and the stylesheet put into each of its documents.
 *
 * On every `dom-ready` rather than once, because a stylesheet inserted this way
 * belongs to the document it was inserted into: an application reloading
 * itself — which an editor does on its own, for a settings change it cannot
 * apply live and on the way back from signing in — produces a new document,
 * and one that would otherwise come back without it.
 */
export function adoptWebView(webContents: WebContents, declaration: WebViewDeclaration): void {
  yieldKeysTo(webContents, declaration.keys ?? [])
  const { stylesheet } = declaration
  if (stylesheet) {
    webContents.on('dom-ready', () => {
      // Rejects for a view torn down between the event and the insert, which is
      // a tab closed while it was still loading and not a failure to report.
      void webContents.insertCSS(stylesheet).catch(() => undefined)
    })
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

type LiveConnection = { connection: ViewConnection; close: () => void }

function liveConnection(tabId: string, port: MessagePortMain): LiveConnection {
  const messageListeners = new Set<(message: unknown) => void>()
  const disconnectListeners = new Set<() => void>()
  let connected = true

  port.on('message', ({ data }) => {
    for (const listener of [...messageListeners]) {
      try {
        listener(data)
      } catch (error) {
        console.error(`A view message listener for ${tabId} failed:`, error)
      }
    }
  })

  const close = (): void => {
    if (!connected) return
    connected = false
    port.close()
    const listeners = [...disconnectListeners]
    messageListeners.clear()
    disconnectListeners.clear()
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error(`A view disconnect listener for ${tabId} failed:`, error)
      }
    }
  }
  port.on('close', close)
  port.start()

  const connection: ViewConnection = {
    tabId,
    get connected() {
      return connected
    },
    post: (message) => {
      if (connected) port.postMessage(message)
    },
    onMessage: (listener): Disposable => {
      if (connected) messageListeners.add(listener)
      return { dispose: () => messageListeners.delete(listener) }
    },
    onDisconnect: (listener): Disposable => {
      if (!connected) {
        listener()
        return { dispose: () => {} }
      }
      disconnectListeners.add(listener)
      return { dispose: () => disconnectListeners.delete(listener) }
    }
  }

  return { connection, close }
}

function disconnect(owner: ExtensionViewOwner): void {
  const live = owner.connection
  owner.connection = null
  live?.close()
}

/**
 * Connects a page that has just loaded: hands it its end of a fresh channel and
 * tells the extension. A page that asks twice gets a new channel and the old
 * one is closed, which is what a page reloaded under the same view looks like.
 */
export function connectExtensionView(owner: ExtensionViewOwner): void {
  disconnect(owner)
  const { port1, port2 } = new MessageChannelMain()
  if (owner.tabId === null) {
    // A settings page. The page still waits for its end of a channel, but
    // nothing is at the other one: there is no tab for a main half to follow.
    owner.webContents.postMessage('extension-view:port', null, [port2])
    port1.close()
    return
  }
  const live = liveConnection(owner.tabId, port1)
  owner.connection = live
  owner.webContents.postMessage('extension-view:port', null, [port2])

  // Only a tab type's views have anyone to tell: `onConnect` names tab types,
  // and a file viewer's page is the file and nothing its main half follows.
  const listeners = owner.subject.kind === 'tab' ? viewConnectorsFor(owner.viewType) : []
  for (const listener of listeners) {
    try {
      listener(live.connection)
    } catch (error) {
      console.error(`[${owner.extensionId}] failed to take a view of ${owner.tabId}:`, error)
    }
  }
}

// ---------------------------------------------------------------------------
// Whether the app is in front
// ---------------------------------------------------------------------------

let appFocused = false

/**
 * Tells every view whether the app's window is the one in front. A view only
 * has focus while it has the keyboard, so `window` focus inside one stops at
 * the first click on the sidebar; a page that means "is anyone looking" asks
 * this instead (see `ViewHost.appFocused`).
 */
export function setAppFocused(focused: boolean): void {
  if (focused === appFocused) return
  appFocused = focused
  for (const owner of owners.values()) {
    if (!owner.webContents.isDestroyed()) {
      owner.webContents.send('extension-view:app-focus', focused)
    }
  }
}

export function isAppFocused(): boolean {
  return appFocused
}
