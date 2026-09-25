import { ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isWebAddress, type FolderPickerOptions } from '@fluid/sdk'
import { subscribe } from './api/bus'
import { hears, isIsolated, mayOpenOutside } from './api/isolation-policy'
import { ApiError } from './api/errors'
import { callApi } from './api/router'
import { getHostWindow, openLinkFromTab } from './browser-views'
import { chooseDirectory } from './directories'
import { callExtension, viewCodeFor } from './extensions/host'
import {
  connectExtensionView,
  extensionViewOwners,
  isAppFocused,
  ownerOf,
  type ExtensionViewOwner,
  type ViewSubject
} from './extension-views'
import { holdSettingsWindow, openSettingsWindow } from './settings-window'
import { settingsViewWindow } from './settings-views'

/**
 * The bridge an extension's view reaches the app through, from this side. See
 * src/preload/extension-view.ts for the other.
 *
 * Every handler starts by asking who is calling, and the answer comes from the
 * sender — the web contents the message arrived from — looked up among the
 * views made for extension tabs. A message from anything else is refused. So a
 * page can only ever act as the extension whose tab it was made for, and only
 * name that tab, whatever it puts in its arguments.
 *
 * The workspace's events go to every extension view as they go to every window
 * (see src/main/api/ipc.ts), for the page's own `api.on` and `api.watch`. An
 * extension's page is the extension's code, which already hears every event
 * through `ctx.api`.
 *
 * @module extension-view-ipc
 */

/**
 * What a page is told as it connects, alongside its end of the channel: its
 * tab, and what it draws of it — the tab, for one of the extension's own
 * types, or the file in it, for one of its file viewers. A settings page has
 * no tab. `code` is where an installed extension's view module is, which the
 * page imports; a built-in extension's views are compiled into the page.
 */
export type ExtensionViewHello = {
  tabId: string | null
  subject: ViewSubject
  appFocused: boolean
  code: { script: string; styles?: string } | null
}

function callerOf(event: IpcMainEvent | IpcMainInvokeEvent): ExtensionViewOwner {
  const owner = ownerOf(event.sender)
  if (!owner) throw new ApiError('Only an extension view can use this bridge.')
  return owner
}

export function registerExtensionViewIpc(): void {
  ipcMain.handle('extension-view:connect', (event): ExtensionViewHello => {
    const owner = callerOf(event)
    connectExtensionView(owner)
    return {
      tabId: owner.tabId,
      subject: owner.subject,
      appFocused: isAppFocused(),
      code: viewCodeFor(owner.extensionId)
    }
  })

  ipcMain.handle('extension-view:api', (event, method: string, input: unknown) => {
    const { extensionId } = callerOf(event)
    return callApi(method, input, { kind: 'extension', extensionId })
  })

  ipcMain.handle('extension-view:call', (event, method: string, input: unknown) => {
    const { extensionId } = callerOf(event)
    return callExtension(extensionId, method, input)
  })

  ipcMain.on('extension-view:openLink', (event, url: unknown) => {
    const owner = ownerOf(event.sender)
    if (!owner || typeof url !== 'string') return
    // An installed extension's page may open web pages and email, not launch
    // whatever app a scheme belongs to.
    if (isIsolated(owner.extensionId) && !mayOpenOutside(url)) return
    if (owner.tabId !== null) openLinkFromTab(owner.tabId, url)
    // The settings window has no tabs to open it in.
    else if (isWebAddress(url)) void shell.openExternal(url)
  })

  // A sheet on the window the view is drawn in: the app's, or the settings
  // panel, which is held open while the sheet is up.
  ipcMain.handle('extension-view:chooseFolder', async (event, options?: FolderPickerOptions) => {
    callerOf(event)
    const panel = settingsViewWindow(event.sender.id)
    const release = panel ? holdSettingsWindow() : () => {}
    try {
      return await chooseDirectory(panel ?? getHostWindow(), {
        title: options?.title ?? 'Choose a folder',
        buttonLabel: options?.buttonLabel
      })
    } finally {
      release()
    }
  })

  ipcMain.on('extension-view:openSettings', (event) => {
    const host = getHostWindow()
    const owner = ownerOf(event.sender)
    // A settings page is already in the settings window.
    if (owner && owner.tabId !== null && host) openSettingsWindow(host)
  })

  subscribe((event) => {
    for (const owner of extensionViewOwners()) {
      if (owner.webContents.isDestroyed() || !hears(owner.extensionId, event)) continue
      owner.webContents.send('api:event', event)
    }
  })
}
