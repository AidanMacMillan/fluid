import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/sidebar-panel.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup() {
  const panels = []
  const children = []
  const timers = new Map()
  let finishLoading
  class WebContentsView {
    constructor() {
      panels.push(this)
      this.messages = []
      this.webContents = Object.assign(new EventEmitter(), {
        loadFile: () =>
          new Promise((resolve) => {
            finishLoading = resolve
          }),
        send: (...args) => this.messages.push(args),
        isDestroyed: () => false,
        close: () => {
          this.closed = true
        },
        setWindowOpenHandler: () => {}
      })
    }
    setBackgroundColor(color) {
      this.background = color
    }
    setVisible(value) {
      this.visible = value
    }
    setBounds(bounds) {
      this.bounds = { ...bounds }
    }
    getBounds() {
      return this.bounds
    }
  }
  const host = Object.assign(new EventEmitter(), {
    size: { width: 1000, height: 700 },
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, ...host.size }),
    webContents: { send: () => {} },
    contentView: {
      addChildView: (view) => {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
        children.push(view)
      },
      removeChildView: (view) => {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
      }
    }
  })
  const exports = {}
  runInNewContext(compiled, {
    exports,
    __dirname: '/test',
    console,
    process: { env: {} },
    setTimeout: (callback) => {
      const id = {}
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    require: (id) =>
      ({
        electron: { WebContentsView, screen: { getCursorScreenPoint: () => ({ x: 3, y: 100 }) } },
        path: { join: (...parts) => parts.join('/') },
        '@electron-toolkit/utils': { is: { dev: false } },
        '../shared/sidebar-panel': {
          SIDEBAR_CLOSE_MS: 200,
          SIDEBAR_PANEL_BLEED: 12,
          SIDEBAR_PANEL_INSET: 6
        }
      })[id]
  })
  const state = {
    sidebarWidth: 224,
    sidebarPosition: 'left',
    top: 40,
    open: false,
    collapsed: true
  }
  return {
    api: exports,
    panels,
    children,
    host,
    update: (patch = {}) => exports.updateSidebarPanel(host, { ...state, ...patch }),
    loaded: async () => {
      finishLoading()
      await Promise.resolve()
      await Promise.resolve()
    },
    flush: () => {
      for (const callback of timers.values()) callback()
      timers.clear()
    }
  }
}

test('peek overlays a live page without changing its bounds, on either edge', async () => {
  const app = setup()
  const page = { bounds: { x: 0, y: 76, width: 1000, height: 624 } }
  app.children.push(page)
  app.update()
  assert.deepEqual(app.children, [page], 'preloading does not cover the page')
  await app.loaded()
  app.update({ open: true })
  await Promise.resolve()
  const panel = app.panels[0]
  assert.deepEqual(app.children, [page, panel])
  assert.equal(panel.background, '#00000000')
  assert.deepEqual(panel.bounds, { x: 0, y: 40, width: 242, height: 660 })
  app.update({ open: true, sidebarPosition: 'right', sidebarWidth: 300 })
  assert.deepEqual(panel.bounds, { x: 682, y: 40, width: 318, height: 660 })
  app.host.size = { width: 1200, height: 800 }
  app.host.emit('resize')
  assert.deepEqual(panel.bounds, { x: 882, y: 40, width: 318, height: 760 })
  assert.deepEqual(page.bounds, { x: 0, y: 76, width: 1000, height: 624 })
})

test('HTML fullscreen hides the hover panel even when an open request is pending', async () => {
  const app = setup()
  app.update({ open: true })
  app.api.suppressSidebarPanel(true)
  await app.loaded()
  const panel = app.panels[0]
  assert.equal(panel.visible, false)
  app.update({ open: true })
  app.api.raiseSidebarPanel()
  await Promise.resolve()
  assert.equal(panel.visible, false)
  app.api.suppressSidebarPanel(false)
  assert.equal(panel.visible, true)
})

test('closing waits for the slide, reopening cancels detach, docking removes the overlay', async () => {
  const app = setup()
  app.update({ open: true })
  await app.loaded()
  app.update()
  assert.equal(app.children.length, 1)
  app.update({ open: true })
  app.flush()
  assert.equal(app.children.length, 1)
  app.update()
  app.flush()
  assert.equal(app.children.length, 0)
  app.update({ open: true })
  await Promise.resolve()
  app.update({ collapsed: false })
  assert.equal(app.children.length, 0)
})

test('a late load cannot reopen a closed panel or resurrect a destroyed window', async () => {
  const app = setup()
  app.update({ open: true })
  app.update()
  await app.loaded()
  assert.equal(app.children.length, 0)
  assert.equal(app.panels[0].messages.at(-1)[1].open, false)
  app.api.destroySidebarPanel()
  assert.equal(app.panels[0].closed, true)
  assert.equal(app.host.listenerCount('resize'), 0)

  const pending = setup()
  pending.update({ open: true })
  pending.api.destroySidebarPanel()
  await pending.loaded()
  assert.equal(pending.children.length, 0)
  assert.deepEqual(pending.panels[0].messages, [])
})

test('newly attached tabs and split-drop glass remain beneath the visible panel', async () => {
  const app = setup()
  app.update({ open: true })
  await app.loaded()
  const page = {}
  app.children.push(page)
  app.api.raiseSidebarPanel()
  assert.deepEqual(app.children, [page, app.panels[0]])
  assert.equal(app.api.isSidebarPanel(app.panels[0].webContents), true)
  assert.equal(app.api.isSidebarPanel({}), false)
})
