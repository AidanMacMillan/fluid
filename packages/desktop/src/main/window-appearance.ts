import { type BaseWindow, type BaseWindowConstructorOptions } from 'electron'
import { WINDOW_TRANSPARENCY_SETTING, windowTransparency } from '../shared/appearance'
import { subscribe } from './api/bus'
import { getSetting } from './db/settings'

/** The opaque canvas used on platforms without vibrancy, and when glass is disabled. */
const OPAQUE_BACKGROUND = '#18181b'
const TRANSPARENT_BACKGROUND = '#00000000'

type Vibrancy = Exclude<Parameters<BaseWindow['setVibrancy']>[0], null>

let transparency = 1
const windows = new Map<BaseWindow, Vibrancy>()

/**
 * The native appearance for an app window at construction time. Every window
 * that uses glass goes through here, so the saved preference applies before
 * its first frame instead of flashing glass and becoming opaque afterwards.
 */
export function windowAppearance(material: Vibrancy): Partial<BaseWindowConstructorOptions> {
  if (process.platform !== 'darwin' || !transparency) {
    return { backgroundColor: OPAQUE_BACKGROUND }
  }
  return {
    vibrancy: material,
    visualEffectState: 'active',
    backgroundColor: TRANSPARENT_BACKGROUND
  }
}

/** Follows preference changes for the lifetime of a window. */
export function trackWindowAppearance(window: BaseWindow, material: Vibrancy): void {
  windows.set(window, material)
  apply(window, material)
  window.once('closed', () => windows.delete(window))
}

function apply(window: BaseWindow, material: Vibrancy): void {
  if (window.isDestroyed() || process.platform !== 'darwin') return
  if (transparency) {
    window.setVibrancy(material)
    window.setBackgroundColor(TRANSPARENT_BACKGROUND)
    // Tint the content view above the native material, below all text and tabs.
    // Window opacity would also fade text, and a native background alone sits
    // behind vibrancy on BaseWindows (such as the floating miniplayer).
    window.contentView.setBackgroundColor(`rgba(24, 24, 27, ${1 - transparency})`)
  } else {
    // Put an opaque canvas in place before removing the material so no clear
    // frame can expose the desktop while an open window changes appearance.
    window.setBackgroundColor(OPAQUE_BACKGROUND)
    window.contentView.setBackgroundColor(OPAQUE_BACKGROUND)
    window.setVibrancy(null)
  }
}

/** Reads the preference before any window is made, then keeps open ones in sync. */
export async function registerWindowAppearance(): Promise<void> {
  transparency = windowTransparency(await getSetting(WINDOW_TRANSPARENCY_SETTING))
  subscribe((event) => {
    if (event.type !== 'setting.changed' || event.key !== WINDOW_TRANSPARENCY_SETTING) return
    const next = windowTransparency(event.value)
    if (next === transparency) return
    transparency = next
    for (const [window, material] of windows) apply(window, material)
  })
}
