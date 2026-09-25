import { createClient, type ExtensionViews, type RendererHost, type ViewHost } from '@fluid/sdk'

import './assets/main.css'

import { EXTENSION_VIEWS } from './lib/extension-views'
import { reasonFrom } from './lib/ipc-error'

/**
 * The page an extension tab is drawn in when its type asks for a view of its
 * own (see src/main/extension-views.ts): one per tab, each in a process of
 * its own. A file tab an extension's file viewer draws is drawn here too, and
 * so is an extension's section of the settings window (see
 * src/main/settings-views.ts).
 *
 * The page is the app's and the drawing is the extension's. The app brings the
 * stylesheet — so the extension's components find the same theme and the same
 * `glass-*` utilities they would in a window — and the bridge, which it turns
 * into the `ViewHost` the extension is given. The extension brings the
 * `ExtensionView` for the tab's type, and whatever `mount` draws is the page.
 * A built-in extension's views are compiled into this page; an installed
 * one's are a module in its own folder, which the page imports, with a
 * stylesheet of its own laid over the app's.
 *
 * Connecting comes before drawing, so that whatever the view posts as it
 * mounts has a main half to arrive at, and whatever the main half posts the
 * moment the view connects has a listener by the time the view could have
 * added one.
 */

/** How long a view state waits for the gesture that set it to stop. As the windows'. */
const VIEW_STATE_WRITE_DELAY_MS = 250

const bridge = window.fluidView
const target = document.getElementById('view')!

/**
 * An installed extension's views, from where the main process says they are.
 * Its stylesheet goes in first and is waited for, so the view does not draw
 * unstyled and then jump.
 */
async function importViews(code: { script: string; styles?: string }): Promise<ExtensionViews> {
  // Peer-to-peer connections go round the network lock an installed
  // extension's pages are under (see src/main/extensions/isolation/sessions.ts).
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    Reflect.deleteProperty(globalThis, name)
  }
  const { styles } = code
  if (styles) {
    await new Promise<void>((resolve) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = styles
      link.onload = () => resolve()
      // Drawn unstyled rather than not at all.
      link.onerror = () => resolve()
      document.head.append(link)
    })
  }
  const module = (await import(/* @vite-ignore */ code.script)) as { default: ExtensionViews }
  return module.default
}

function fail(message: string): void {
  target.className =
    'flex h-screen items-center justify-center px-8 text-center text-xs text-ink-500'
  target.textContent = message
}

async function start(): Promise<void> {
  const hello = await bridge.connect()
  const api = createClient({ call: bridge.api, subscribe: bridge.onEvent })

  const { subject, tabId, code } = hello
  const loadViews = code ? () => importViews(code) : EXTENSION_VIEWS[subject.extensionId]

  const rendererHost: RendererHost = {
    api,
    call: <T>(method: string, input?: unknown) => bridge.call(method, input) as Promise<T>,
    openLink: (url) => bridge.openLink(url),
    setViewState: () => {},
    flushViewState: () => {},
    reasonFrom,
    openSettings: () => bridge.openSettings(),
    chooseFolder: (options) => bridge.chooseFolder(options)
  }

  if (tabId === null) {
    // The extension's section of the settings window, which scrolls as a page
    // does when it is taller than the panel.
    const views = await loadViews?.()
    if (!views?.settings) return fail(`Nothing draws ${subject.extensionId}'s settings.`)
    document.documentElement.style.overflowY = 'auto'
    target.className = 'min-h-screen px-4 pb-4 text-ink-100 text-on-glass'
    views.settings.mount(target, { host: rendererHost })
    return
  }

  const [tab, views] = await Promise.all([api.tabs.get({ id: tabId }), loadViews?.()])
  // A tab of one of the extension's types, or a file one of its viewers draws.
  const view = (subject.kind === 'file' ? views?.files : views?.tabs)?.[subject.id]

  if (!tab) return fail('This tab no longer exists.')
  if (!view) {
    const name = `${subject.extensionId}.${subject.id}`
    return fail(
      subject.kind === 'file' ? `Nothing draws ${name} files.` : `Nothing draws ${name} tabs.`
    )
  }

  // One tab, so one pending write at most.
  let pending: { viewState: unknown; timer: ReturnType<typeof setTimeout> } | null = null
  const writeViewState = (): void => {
    if (!pending) return
    clearTimeout(pending.timer)
    void api.tabs.update({ id: tabId, viewState: pending.viewState })
    pending = null
  }
  // The view can be let go of at any moment — pushed out of the warm set, or
  // its extension disabled — with nobody switching away to flush it first.
  window.addEventListener('pagehide', writeViewState)

  const host: ViewHost = {
    ...rendererHost,
    tabId,
    // Only this view's tab has view state to set; the id is there so a pane
    // written for a window works here unchanged.
    setViewState: (id, viewState) => {
      if (id !== tabId) return
      if (pending) clearTimeout(pending.timer)
      pending = { viewState, timer: setTimeout(writeViewState, VIEW_STATE_WRITE_DELAY_MS) }
    },
    flushViewState: (id) => {
      if (id === tabId) writeViewState()
    },
    post: (message) => bridge.post(message),
    onMessage: (listener) => bridge.onMessage(listener),
    pathForFile: (file) => bridge.pathForFile(file),
    appFocused: () => bridge.appFocused(),
    onAppFocusChange: (listener) => bridge.onAppFocusChange(listener)
  }

  view.mount(target, { tab, host })
}

start().catch((error: unknown) => {
  console.error('The extension view failed to start:', error)
  fail(reasonFrom(error))
})
