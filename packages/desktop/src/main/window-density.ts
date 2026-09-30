import { ipcMain, type BrowserWindow } from 'electron'
import {
  UI_DENSITY_SETTING,
  uiDensity,
  titleBarHeight,
  trafficLightPosition
} from '../shared/appearance'
import { subscribe } from './api/bus'
import { getSetting } from './db/settings'

let current = uiDensity(null)
const windows = new Set<BrowserWindow>()

export function currentWindowDensity(): number {
  return current
}

function apply(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (process.platform === 'darwin') {
    window.setWindowButtonPosition(trafficLightPosition(current))
  } else {
    window.setTitleBarOverlay({ height: titleBarHeight(current) })
  }
}

/** Only main browser windows join; panels and floating content keep their layout. */
export function trackWindowDensity(window: BrowserWindow): void {
  windows.add(window)
  // AppKit may restore its button placement when leaving fullscreen.
  window.on('leave-full-screen', () => apply(window))
  window.once('closed', () => windows.delete(window))
}

/** Load before creating windows so native controls and the first renderer frame agree. */
export async function registerWindowDensity(): Promise<void> {
  current = uiDensity(await getSetting(UI_DENSITY_SETTING))
  ipcMain.on('appearance:density', (event) => {
    event.returnValue = current
  })
  subscribe((event) => {
    if (event.type !== 'setting.changed' || event.key !== UI_DENSITY_SETTING) return
    current = uiDensity(event.value)
    for (const window of windows) apply(window)
  })
}
