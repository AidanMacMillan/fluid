import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FolderPickerOptions, MethodName, WorkspaceEvent } from '@fluid/sdk'
import type { ExtensionViewHello } from '../main/extension-view-ipc'

/**
 * The bridge an extension's view gets, and nothing else: no `window.api`, none
 * of the channels the app's own windows use. The page is sandboxed, so this
 * preload can reach `electron`'s renderer modules and no others — which is why
 * it imports nothing but types from the app or the SDK, and why the page
 * builds the SDK's client itself on top of `call` and `onEvent` (see
 * src/renderer/src/extension-view.ts).
 *
 * The page's end of its connection is held here rather than handed over:
 * a port cannot cross the context bridge, and wrapping it keeps the page to
 * posting and listening.
 */

let port: MessagePort | null = null
const messageListeners = new Set<(message: unknown) => void>()
/**
 * What arrived before anything was listening. A main half can post the moment
 * the view connects, which is before the page has loaded its extension's code
 * and mounted anything to hear it; those messages wait here for the first
 * listener rather than being dropped.
 */
let early: unknown[] = []
const focusListeners = new Set<(focused: boolean) => void>()
let appFocused = false

/** The page's end of the channel, which arrives just ahead of the answer to `connect`. */
const portArrived = new Promise<void>((resolve) => {
  ipcRenderer.on('extension-view:port', (event) => {
    port?.close()
    port = event.ports[0] ?? null
    if (port) {
      port.onmessage = ({ data }) => {
        if (messageListeners.size === 0) early.push(data)
        for (const listener of [...messageListeners]) listener(data)
      }
      port.start()
    }
    resolve()
  })
})

/**
 * The theme, on the document before the page draws — the same few lines as the
 * windows' preload (see src/preload/index.ts), which this one cannot share.
 */
function applyTheme(theme: string): void {
  const root = document.documentElement
  if (root) root.dataset.theme = theme
  else document.addEventListener('DOMContentLoaded', () => applyTheme(theme), { once: true })
}

applyTheme(ipcRenderer.sendSync('theme:current') as string)
ipcRenderer.on('theme:changed', (_e, theme: string) => applyTheme(theme))

ipcRenderer.on('extension-view:app-focus', (_event, focused: boolean) => {
  appFocused = focused
  for (const listener of [...focusListeners]) listener(focused)
})

const bridge = {
  /** Connects the page, once it is ready to hear from its main half. */
  connect: async (): Promise<ExtensionViewHello> => {
    const hello = (await ipcRenderer.invoke('extension-view:connect')) as ExtensionViewHello
    await portArrived
    appFocused = hello.appFocused
    return hello
  },

  /** The workspace API, as the extension. */
  api: (method: MethodName, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('extension-view:api', method, input),
  onEvent: (listener: (event: WorkspaceEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: WorkspaceEvent): void => listener(event)
    ipcRenderer.on('api:event', handler)
    return () => ipcRenderer.off('api:event', handler)
  },

  /** One of the extension's own `ctx.rpc` methods. */
  call: (method: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('extension-view:call', method, input),

  post: (message: unknown): void => port?.postMessage(message),
  onMessage: (listener: (message: unknown) => void): (() => void) => {
    messageListeners.add(listener)
    const held = early
    early = []
    for (const message of held) listener(message)
    return () => messageListeners.delete(listener)
  },

  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  openLink: (url: string): void => ipcRenderer.send('extension-view:openLink', url),
  openSettings: (): void => ipcRenderer.send('extension-view:openSettings'),
  chooseFolder: (options?: FolderPickerOptions): Promise<string | null> =>
    ipcRenderer.invoke('extension-view:chooseFolder', options),

  appFocused: (): boolean => appFocused,
  onAppFocusChange: (listener: (focused: boolean) => void): (() => void) => {
    focusListeners.add(listener)
    return () => focusListeners.delete(listener)
  }
}

export type ExtensionViewBridge = typeof bridge

contextBridge.exposeInMainWorld('fluidView', bridge)
