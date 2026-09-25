import { BrowserWindow, ipcMain } from 'electron'
import { subscribe } from './bus'
import { callApi } from './router'

/**
 * The API over IPC, for the app's windows.
 *
 * Two channels for the whole of it: one to call any method by name, and one
 * that carries every event to every window. The preload wraps them in the
 * SDK's client, so a window uses the same typed API an extension does.
 *
 * Events go to windows only — never to the views pages are drawn in, which are
 * other people's code. Extensions' own views get them through their bridge
 * (see src/main/extension-view-ipc.ts).
 */
export function registerApiIpc(): void {
  ipcMain.handle('api:call', (_e, method: string, input: unknown) =>
    callApi(method, input, { kind: 'window' })
  )

  subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('api:event', event)
    }
  })
}
