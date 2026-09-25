import { shell, WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import { isWebAddress } from '@fluid/sdk'
import { isIsolated } from './api/isolation-policy'
import {
  adoptSettingsView,
  EXTENSION_VIEW_PRELOAD,
  extensionPartition,
  extensionSettingsUrl,
  prepareExtensionSession
} from './extension-views'
import { hasSettings } from './extensions/host'
import { closeOnDismissKeys } from './settings-window'

/**
 * An extension's section of the settings window, drawn by the extension.
 *
 * The settings window draws its own sections. An extension's section is a
 * page of the extension's, in the page every extension view is drawn in (see
 * src/renderer/src/extension-view.ts), because the settings window cannot draw
 * an installed extension's components itself: they were compiled against a
 * copy of Svelte of their own, and mounting them in the window's would split
 * one component tree across two runtimes.
 *
 * So the page is a native view laid over the part of the window the section's
 * content would take up, which the window measures and sends (see
 * `settingsWindow.showExtension` in the preload). One at a time: switching
 * sections takes the last one down, and so does closing the window.
 *
 * @module settings-views
 */

type Shown = { window: BrowserWindow; extensionId: string; view: WebContentsView }

let shown: Shown | null = null

function destroy(target: Shown): void {
  if (!target.window.isDestroyed()) target.window.contentView.removeChildView(target.view)
  if (!target.view.webContents.isDestroyed()) target.view.webContents.close()
  if (shown === target) shown = null
}

function create(window: BrowserWindow, extensionId: string): Shown {
  prepareExtensionSession(extensionId)
  const view = new WebContentsView({
    webPreferences: {
      // The same page, and the same limits, as an extension's tab gets.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: extensionPartition(extensionId),
      preload: EXTENSION_VIEW_PRELOAD
    }
  })
  // The panel's glass shows through: the section is drawn on it, as the
  // window's own sections are.
  view.setBackgroundColor('#00000000')

  const { webContents } = view
  // Peer-to-peer traffic goes round an installed extension's network lock.
  if (isIsolated(extensionId)) webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  adoptSettingsView(webContents, extensionId)
  closeOnDismissKeys(window, webContents)

  const url = extensionSettingsUrl(extensionId)
  // Held on its one page. A link out of it opens in the user's browser: the
  // settings window has no tabs to open one in.
  webContents.on('will-navigate', (event, target) => {
    if (target === url) return
    event.preventDefault()
    if (isWebAddress(target)) void shell.openExternal(target)
  })
  webContents.setWindowOpenHandler(({ url: target }) => {
    if (isWebAddress(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })

  window.contentView.addChildView(view)
  window.once('closed', () => {
    if (shown?.view === view) destroy(shown)
  })
  void webContents.loadURL(url).catch(() => undefined)

  return { window, extensionId, view }
}

/**
 * Shows `extensionId`'s section in `window`, over `bounds`. Called again with
 * new bounds whenever the space for it changes size.
 */
export function showExtensionSettings(
  window: BrowserWindow,
  extensionId: string,
  bounds: Rectangle
): void {
  if (!hasSettings(extensionId)) {
    hideExtensionSettings()
    return
  }
  if (shown && (shown.window !== window || shown.extensionId !== extensionId)) destroy(shown)
  shown ??= create(window, extensionId)
  shown.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  })
}

/** Takes down whatever extension section is showing. */
export function hideExtensionSettings(): void {
  if (shown) destroy(shown)
}

/** The window an extension's settings page is drawn in, if `webContents` is one. */
export function settingsViewWindow(webContentsId: number): BrowserWindow | null {
  return shown && shown.view.webContents.id === webContentsId && !shown.window.isDestroyed()
    ? shown.window
    : null
}
