import type { WorkspaceEvent } from '@fluid/sdk'
import { join } from 'path'
import { screen, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  SIDEBAR_CLOSE_MS,
  SIDEBAR_PANEL_BLEED,
  SIDEBAR_PANEL_INSET,
  type SidebarPanelState
} from '../shared/sidebar-panel'

let view: WebContentsView | undefined
let loaded: Promise<void> | undefined
let host: BrowserWindow | undefined
let state: SidebarPanelState | undefined
let attached = false
let closing: ReturnType<typeof setTimeout> | undefined

/** A real native overlay, so pages keep their viewport, input and live rendering. */
function ensureView(): WebContentsView {
  if (view) return view
  const created = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      scrollBounce: true
    }
  })
  created.setBackgroundColor('#00000000')
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view = created
  loaded =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? created.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/sidebar.html`)
      : created.webContents.loadFile(join(__dirname, '../renderer/sidebar.html'))
  void loaded.catch((error) => console.error('Unable to load sidebar panel', error))
  return created
}

export function isSidebarPanel(contents: WebContents): boolean {
  return view?.webContents === contents
}

/** App API events are only forwarded to this trusted renderer, never page views. */
export function publishSidebarEvent(event: WorkspaceEvent): void {
  if (view && !view.webContents.isDestroyed()) view.webContents.send('api:event', event)
}

export function raiseSidebarPanel(): void {
  if (attached && view && host && !host.isDestroyed()) host.contentView.addChildView(view)
}

function position(): void {
  if (!view || !host || host.isDestroyed() || !state) return
  const { width, height } = host.getContentBounds()
  const panelWidth = Math.min(width, state.sidebarWidth + SIDEBAR_PANEL_INSET + SIDEBAR_PANEL_BLEED)
  view.setBounds({
    x: state.sidebarPosition === 'right' ? width - panelWidth : 0,
    y: Math.round(state.top),
    width: Math.round(panelWidth),
    height: Math.max(0, height - Math.round(state.top))
  })
}

function detach(): void {
  if (attached && view && host && !host.isDestroyed()) host.contentView.removeChildView(view)
  attached = false
}

export function updateSidebarPanel(window: BrowserWindow, next: SidebarPanelState): void {
  if (host !== window) {
    destroySidebarPanel()
    host = window
    window.on('resize', position)
  }
  const wasOpen = state?.open ?? false
  state = next
  // Preload while collapsed, before the first edge entry.
  if (!view && !next.collapsed) return
  const panel = ensureView()
  if (next.open) {
    clearTimeout(closing)
  } else if (!next.collapsed) {
    clearTimeout(closing)
    detach()
  } else if (wasOpen) {
    clearTimeout(closing)
    closing = setTimeout(detach, SIDEBAR_CLOSE_MS + 50)
  }
  position()
  void loaded
    ?.then(() => {
      // A pending load may outlive the window or a newer state.
      if (view !== panel || state !== next || window.isDestroyed()) return
      if (next.open && !attached) {
        window.contentView.addChildView(panel)
        attached = true
        // Attaching under a stationary pointer need not produce a DOM entry.
        // Seed hover so the page's mouseleave cannot dismiss the new panel.
        const cursor = screen.getCursorScreenPoint()
        const origin = window.getContentBounds()
        const bounds = panel.getBounds()
        const x = cursor.x - origin.x - bounds.x
        const y = cursor.y - origin.y - bounds.y
        window.webContents.send('sidebar:report', {
          kind: 'hover',
          inside: x >= 0 && y >= 0 && x < bounds.width && y < bounds.height
        })
      }
      panel.webContents.send('sidebar:state', next)
    })
    .catch(() => undefined)
}

export function destroySidebarPanel(): void {
  clearTimeout(closing)
  detach()
  if (host && !host.isDestroyed()) host.removeListener('resize', position)
  if (view && !view.webContents.isDestroyed()) view.webContents.close()
  view = undefined
  loaded = undefined
  state = undefined
  host = undefined
}
