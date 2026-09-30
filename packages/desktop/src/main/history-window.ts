import { join } from 'node:path'
import { BrowserWindow, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import { clipboardTask } from './clipboard-capture'
import { trackWindowAppearance, windowAppearance } from './window-appearance'

export type HistoryContext = { taskId: string; taskTitle: string | null }
let panel: BrowserWindow | undefined
let opener: BrowserWindow | undefined
let context: HistoryContext | null = null

function bounds(parent: BrowserWindow, height: number): Rectangle {
  const area = parent.getBounds()
  const width = Math.min(area.width, Math.min(780, Math.max(460, Math.round(area.width * 0.68))))
  height = Math.min(Math.max(1, height), 620, area.height)
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.min(area.height * 0.16, area.height - height))
  }
}

export function historyContext(): HistoryContext | null {
  return context
}

export function openHistoryWindow(parent: BrowserWindow): void {
  if (panel && !panel.isDestroyed()) {
    panel.focus()
    return
  }
  const task = clipboardTask()
  if (!task) return
  context = { taskId: task.id, taskTitle: task.title }
  opener = parent
  const window = new BrowserWindow({
    parent,
    ...bounds(parent, 400),
    show: false,
    frame: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...windowAppearance('under-window'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      scrollBounce: true
    }
  })
  panel = window
  trackWindowAppearance(window, 'under-window')
  window.webContents.on('before-input-event', (_event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'Escape' || ((input.meta || input.control) && input.key === 'w'))
    )
      window.close()
  })
  window.on('blur', () => {
    if (!window.isDestroyed()) window.close()
  })
  const follow = (): void => resizeHistoryWindow(window.getBounds().height)
  parent.on('resize', follow)
  parent.on('move', follow)
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  window.on('closed', () => {
    parent.off('resize', follow)
    parent.off('move', follow)
    if (panel === window) {
      panel = undefined
      opener = undefined
      context = null
    }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/history.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/history.html'))
  }
}

export function resizeHistoryWindow(height: number): void {
  if (!panel || panel.isDestroyed() || !opener || opener.isDestroyed() || !Number.isFinite(height))
    return
  panel.setResizable(true)
  panel.setBounds(bounds(opener, Math.round(height)))
  panel.setResizable(false)
}
export function closeHistoryWindow(): void {
  if (panel && !panel.isDestroyed()) panel.close()
}
