import type { ExtensionTab, Tab } from '@fluid/sdk'

/**
 * The one tab type the extension contributes, shared by both halves.
 *
 * @module tab
 */

/** The tab type a folder open in VS Code is stored under. */
export const VSCODE_TAB = 'vscode.editor'

/**
 * One folder, open in VS Code.
 *
 * The editor is the real one rather than anything resembling it: a server built
 * from the user's own VS Code install serves its web workbench over localhost,
 * and the tab is a view pointed at that (see ../main/server.ts). So a tab is
 * identified by the folder alone — the server is shared by every one of them,
 * and which folder a window opened on is the whole of what makes two windows
 * different.
 *
 * Nothing else is stored, and that is the point: settings, keybindings, the
 * theme and the extensions all arrive over Settings Sync from the user's own
 * account, and the workbench keeps its own layout, open editors and scroll
 * positions in the view's browser storage. A field here saying what the theme
 * is would be a second, worse copy of something the editor already knows.
 */
export type VscodeTabPayload = {
  /**
   * Absolute path of the folder the editor opened on. What the row is named
   * after — by its last segment, the way a terminal's is — and what the address
   * the view loads is built from on every launch.
   */
  folderPath: string
}

export type VscodeTab = ExtensionTab<typeof VSCODE_TAB, VscodeTabPayload, null>

export function isVscodeTab(tab: Tab): tab is VscodeTab {
  return tab.type === VSCODE_TAB
}

/** The last part of a path, which is what the folder is called. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name === '' ? '/' : name
}
