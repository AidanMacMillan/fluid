import { join } from 'path'
import { pathToFileURL } from 'url'
import { ipcMain, webContents, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getSetting } from './db/settings'
import { subscribe } from './api/bus'
import { applyAppIcon } from './app-icon'

/**
 * Which theme the app is drawn in.
 *
 * The choice is an ordinary setting, written through the API like any other
 * (see the Themes section of src/renderer/src/SettingsApp.svelte). What this
 * adds is getting it onto every page before that page paints: a window or an
 * extension view that loaded in the default theme and then switched would
 * flash on every opening, and the launcher and settings panels open a lot. So
 * each preload asks for the theme synchronously and stamps it on the document
 * before anything draws (see `applyTheme` in src/preload/index.ts), and every
 * change is pushed to every page of the app's own — its windows, the views it
 * composites over them (the find bar, the split preview) and extension views,
 * but never the pages browser tabs are drawn in.
 *
 * The id is opaque here. What a theme looks like is the stylesheet's business
 * (src/renderer/src/assets/themes.css), and an id it does not know is simply
 * the default theme.
 */

export const THEME_SETTING_KEY = 'appearance.theme'
const DEFAULT_THEME = 'default'

let current = DEFAULT_THEME

function themeFrom(value: unknown): string {
  return typeof value === 'string' && value ? value : DEFAULT_THEME
}

/**
 * Whether a page is one of the app's own renderer pages. Told by where it was
 * loaded from rather than by keeping a list, because several of them are views
 * rather than windows, and a list would be one more thing each of those had to
 * remember to join.
 */
function isAppPage(contents: WebContents): boolean {
  const url = contents.getURL()
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServer) return url.startsWith(devServer)
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer/')).href)
}

function broadcast(theme: string): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isAppPage(contents)) contents.send('theme:changed', theme)
  }
}

/** Reads the saved theme and starts following it. Needs the database; before the first window. */
export async function registerTheme(): Promise<void> {
  current = themeFrom(await getSetting(THEME_SETTING_KEY))
  applyAppIcon(current)

  ipcMain.on('theme:current', (event) => {
    event.returnValue = current
  })

  subscribe((event) => {
    if (event.type !== 'setting.changed' || event.key !== THEME_SETTING_KEY) return
    const next = themeFrom(event.value)
    if (next === current) return
    current = next
    broadcast(next)
    applyAppIcon(next)
  })
}
