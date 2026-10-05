import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import defaultIcon from '../../resources/icon.png?asset'
import devDefaultIcon from '../../resources/icons/dev/default.png?asset'
import devBlossomIcon from '../../resources/icons/dev/blossom.png?asset'
import devFrostIcon from '../../resources/icons/dev/frost.png?asset'
import devGraphiteIcon from '../../resources/icons/dev/graphite.png?asset'
import devMidnightIcon from '../../resources/icons/dev/midnight.png?asset'
import devSpooktoberIcon from '../../resources/icons/dev/spooktober.png?asset'
import blossomIcon from '../../resources/icons/blossom.png?asset'
import frostIcon from '../../resources/icons/frost.png?asset'
import graphiteIcon from '../../resources/icons/graphite.png?asset'
import midnightIcon from '../../resources/icons/midnight.png?asset'
import spooktoberIcon from '../../resources/icons/spooktober.png?asset'

/**
 * The app icon, in the current theme's colours.
 *
 * Each theme's version is rendered from build/icon.svg by
 * scripts/theme-icons.mjs; a theme without one here — the default, or an id
 * this does not know — gets the default icon, as the stylesheet gives it the
 * default theme. On macOS it is the dock icon; on Linux, the windows' icon.
 * A run from source gets the dev versions, with "DEV" across the square.
 */
const THEME_ICONS: Record<string, string> = {
  graphite: graphiteIcon,
  midnight: midnightIcon,
  spooktober: spooktoberIcon,
  frost: frostIcon,
  blossom: blossomIcon
}

const DEV_THEME_ICONS: Record<string, string> = {
  graphite: devGraphiteIcon,
  midnight: devMidnightIcon,
  spooktober: devSpooktoberIcon,
  frost: devFrostIcon,
  blossom: devBlossomIcon
}

const fallbackIcon = is.dev ? devDefaultIcon : defaultIcon

let current = fallbackIcon

/** Whether the dock has been handed an icon, and so no longer shows the bundle's own. */
let dockSet = false

/** The current theme's icon, for a window being created. */
export function appIcon(): string {
  return current
}

export function applyAppIcon(theme: string): void {
  current = (is.dev ? DEV_THEME_ICONS : THEME_ICONS)[theme] ?? fallbackIcon

  if (process.platform === 'darwin') {
    // A packaged build's own icon is the default theme's already, and the dock
    // draws it better than any image handed over at runtime — as Liquid Glass,
    // once there is an Icon Composer version. So it is left alone until a
    // theme asks for another; dev runs as Electron.app and always needs one.
    if (!is.dev && !dockSet && current === fallbackIcon) return
    app.dock?.setIcon(current)
    dockSet = true
  } else if (process.platform === 'linux') {
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(current)
  }
}
