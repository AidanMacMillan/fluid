import { ipcRenderer, webFrame } from 'electron'
import { DOMMonitor, type FeaturesUpdate } from '@ghostery/adblocker-content'

type Cosmetics = { active: boolean; styles: string; scripts: string[] }

// This sandboxed preload belongs only to browsing pages. It exposes no bridge
// to the page; filtering decisions and scriptlets come from the main process.
if (/^https?:$/.test(window.location.protocol)) {
  let stopped = false
  const monitor = new DOMMonitor((update) => {
    if (update.type === 'features') void apply(update)
  })

  function inject(result: Cosmetics): boolean {
    if (stopped || !result.active) return false
    if (result.styles) webFrame.insertCSS(result.styles, { cssOrigin: 'user' })
    for (const script of result.scripts) {
      // webFrame executes synchronously in the page's main world, even though
      // its API returns a Promise. Keep this before any asynchronous boundary.
      // Ghostery's compiled scriptlets contain helper declarations. Give each
      // its own scope so helpers cannot collide with the site or one another.
      void webFrame.executeJavaScript(`(() => {\n${script}\n})();`).catch(() => undefined)
    }
    return true
  }

  async function apply(features: FeaturesUpdate): Promise<boolean> {
    try {
      return inject(await ipcRenderer.invoke('adblocker:cosmetics', features))
    } catch {
      // Navigation may destroy the frame while its IPC request is in flight.
      return false
    }
  }

  const active = inject(ipcRenderer.sendSync('adblocker:cosmetics-initial'))
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      if (stopped || !active) return
      monitor.queryAll(window)
      monitor.start(window)
    },
    { once: true }
  )
  window.addEventListener(
    'unload',
    () => {
      stopped = true
      monitor.stop()
    },
    { once: true }
  )
}
