import {
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { profileMenuItems } from './profile-menu'

const sourceWindows = new Set<BrowserWindow>()

/** What the menu calls to open a link somewhere other than where it was found. */
export type OpenLink = (url: string, profile: number | null) => void

/**
 * The right-click menu for a page. Chromium's own menu is built in Chrome's UI
 * layer rather than in the `content` module Electron embeds, so a
 * `WebContentsView` has no context menu whatsoever until the app draws one —
 * right-clicking a page does nothing at all. This is that menu.
 */
export function attachContextMenu(
  webContents: WebContents,
  window: BrowserWindow,
  openLink: OpenLink
): void {
  webContents.on('context-menu', (_event, params) => {
    const template = sectioned([
      linkItems(params, openLink),
      mediaItems(webContents, params),
      editItems(webContents, params),
      navigationItems(webContents),
      pageItems(webContents, window),
      developerItems(webContents, window, params, openLink)
    ])
    if (template.length === 0) return

    // Deliberately no `x`/`y`: the coordinates in `params` are relative to the
    // view, while `popup` measures from the window's top-left, and the view
    // sits below the chrome bar and right of the sidebar. Passing them through
    // would open the menu that far off the pointer. Left out, it opens at the
    // cursor, which is where it was going anyway.
    Menu.buildFromTemplate(template).popup({ window })
  })
}

/** Joins the sections that have anything in them, with a separator between each pair. */
function sectioned(sections: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) =>
      index === 0 ? section : [{ type: 'separator' } as MenuItemConstructorOptions, ...section]
    )
}

/**
 * Whether the app can fetch a URL on the page's behalf. `downloadURL` goes
 * through the network stack, which cannot resolve a `blob:` or `data:` URL
 * belonging to some other renderer — offering to save one would produce a menu
 * item that silently does nothing. A `blob:` download the *page* starts is
 * unaffected: those bytes come from the page's own renderer, and they reach
 * the store like any other download.
 */
function isFetchable(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function linkItems(params: ContextMenuParams, openLink: OpenLink): MenuItemConstructorOptions[] {
  const url = params.linkURL
  if (!url) return []

  return [
    ...(isFetchable(url)
      ? [
          { label: 'Open Link in New Tab', click: (): void => openLink(url, null) },
          {
            // The one place a link's profile can be named outright. Everything
            // else about a link — a plain click, a Cmd-click, a `target=_blank`
            // — keeps the profile of the page it was found on.
            label: 'Open Link in Profile',
            submenu: profileMenuItems({ verb: 'open' }, (choice) => {
              if (choice.kind === 'profile') openLink(url, choice.profile)
            })
          }
        ]
      : []),
    { label: 'Copy Link Address', click: () => clipboard.writeText(url) }
  ]
}

/** What each kind of media is called in the menu. Anything absent gets no media section. */
const MEDIA_NOUNS: Partial<Record<ContextMenuParams['mediaType'], string>> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio'
}

function mediaItems(
  webContents: WebContents,
  params: ContextMenuParams
): MenuItemConstructorOptions[] {
  const noun = MEDIA_NOUNS[params.mediaType]
  const url = params.srcURL
  if (!noun || !url) return []

  const items: MenuItemConstructorOptions[] = []

  if (isFetchable(url)) {
    items.push(
      { label: `Open ${noun} in Browser`, click: () => void shell.openExternal(url) },
      { label: `Save ${noun} to Task`, click: () => webContents.downloadURL(url) }
    )
  }

  if (params.mediaType === 'image') {
    // The decoded picture rather than its address, so it can be pasted into
    // something that takes an image. Addressed by point because that is how
    // Chromium identifies which image was under the pointer.
    items.push({ label: 'Copy Image', click: () => webContents.copyImageAt(params.x, params.y) })
  }

  // Always offered, even for a `data:` URL the two items above skip: it is only
  // ever text going onto the clipboard.
  items.push({ label: `Copy ${noun} Address`, click: () => clipboard.writeText(url) })

  return items
}

/**
 * Cut/copy/paste, driven by what Chromium says the focused element will
 * actually accept. Each one calls the page directly rather than using a menu
 * `role`: a role acts on whatever has focus, and what has focus here is a
 * native child view rather than the window's own web contents.
 */
function editItems(
  webContents: WebContents,
  params: ContextMenuParams
): MenuItemConstructorOptions[] {
  const { editFlags, isEditable, selectionText } = params

  if (!isEditable) {
    // Nothing to edit, so the selection — if there is one — can only be copied.
    return selectionText.trim() === '' ? [] : [{ label: 'Copy', click: () => webContents.copy() }]
  }

  return [
    { label: 'Cut', enabled: editFlags.canCut, click: () => webContents.cut() },
    { label: 'Copy', enabled: editFlags.canCopy, click: () => webContents.copy() },
    { label: 'Paste', enabled: editFlags.canPaste, click: () => webContents.paste() },
    {
      label: 'Paste and Match Style',
      enabled: editFlags.canPaste,
      click: () => webContents.pasteAndMatchStyle()
    },
    { label: 'Select All', enabled: editFlags.canSelectAll, click: () => webContents.selectAll() }
  ]
}

/**
 * The same three moves the chrome bar draws, for the times the pointer is
 * already on the page. Last rather than first: when the menu was opened on
 * something in particular, that thing's items belong under the pointer.
 */
function navigationItems(webContents: WebContents): MenuItemConstructorOptions[] {
  const { navigationHistory } = webContents

  return [
    {
      label: 'Back',
      enabled: navigationHistory.canGoBack(),
      click: () => navigationHistory.goBack()
    },
    {
      label: 'Forward',
      enabled: navigationHistory.canGoForward(),
      click: () => navigationHistory.goForward()
    },
    { label: 'Reload', click: () => webContents.reload() }
  ]
}

function reportPageError(window: BrowserWindow, message: string, error: unknown): void {
  if (window.isDestroyed()) return
  void dialog.showMessageBox(window, {
    type: 'error',
    message,
    detail: error instanceof Error ? error.message : String(error)
  })
}

async function savePage(webContents: WebContents, window: BrowserWindow): Promise<void> {
  const url = webContents.getURL()
  const name = (webContents.getTitle() || 'page')
    // Control characters are invalid in filenames, just like path separators.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 160)
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save Page As',
      defaultPath: `${name}.html`,
      filters: [{ name: 'Webpage, Complete', extensions: ['html', 'htm'] }]
    })
    if (canceled || !filePath || webContents.isDestroyed()) return
    if (webContents.getURL() !== url) {
      throw new Error('The page changed while the save dialog was open. Please try again.')
    }
    await webContents.savePage(filePath, 'HTMLComplete')
  } catch (error) {
    reportPageError(window, 'Could not save the page', error)
  }
}

function pageItems(webContents: WebContents, window: BrowserWindow): MenuItemConstructorOptions[] {
  return [
    { label: 'Save As…', click: () => void savePage(webContents, window) },
    {
      label: 'Print…',
      click: () => {
        // Electron's direct print API rejects on macOS when no printers are
        // configured, before showing the dialog (electron/electron#36897).
        // The page's native print command still opens it, including Save as PDF.
        // An isolated world avoids calling a site's replacement for window.print.
        void webContents
          .executeJavaScriptInIsolatedWorld(1, [{ code: 'window.print()' }], true)
          .catch((error) => reportPageError(window, 'Could not open the print dialog', error))
      }
    }
  ]
}

/** Keep source in the page's session, without widening the URLs normal tabs accept. */
function viewPageSource(webContents: WebContents, window: BrowserWindow, openLink: OpenLink): void {
  const url = webContents.getURL()
  const source = new BrowserWindow({
    parent: window,
    width: 1000,
    height: 750,
    title: 'Page Source',
    autoHideMenuBar: true,
    webPreferences: {
      session: webContents.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  sourceWindows.add(source)
  source.on('closed', () => sourceWindows.delete(source))
  const followLink = (target: string): void => {
    if (isFetchable(target)) openLink(target, null)
  }
  source.webContents.on('will-navigate', (event, target) => {
    event.preventDefault()
    followLink(target)
  })
  source.webContents.setWindowOpenHandler(({ url: target }) => {
    followLink(target)
    return { action: 'deny' }
  })
  void source.loadURL(`view-source:${url}`).catch((error) => {
    if (source.isDestroyed()) return
    source.close()
    reportPageError(window, 'Could not view page source', error)
  })
}

function developerItems(
  webContents: WebContents,
  window: BrowserWindow,
  params: ContextMenuParams,
  openLink: OpenLink
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'View Page Source',
      click: () => viewPageSource(webContents, window, openLink)
    },
    {
      label: 'Inspect',
      click: () => {
        webContents.openDevTools({ mode: 'detach' })
        webContents.inspectElement(params.x, params.y)
      }
    }
  ]
}
