import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/miniplayer.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const noop = () => {}

function setup() {
  const windows = []
  const activations = []
  const host = { getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }) }
  const focus = { window: host }
  class BaseWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.contentView = { addChildView: noop, removeChildView: noop }
      windows.push(this)
      if (options.show !== false) this.show()
    }
    show() {
      this.visible = true
      focus.window = this
      activations.push(this)
    }
    showInactive() {
      this.visible = true
    }
    isDestroyed() {
      return !!this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    getContentSize() {
      return [this.options.width, this.options.height]
    }
    setAlwaysOnTop = noop
    setVisibleOnAllWorkspaces = noop
  }
  class WebContentsView {
    constructor() {
      let destroyed = false
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed,
        loadFile: async () => {},
        close: () => {
          destroyed = true
          this.webContents.emit('destroyed')
        }
      })
    }
    setBackgroundColor = noop
    setBounds = noop
  }
  const dependencies = {
    path: { join: (...parts) => parts.join('/') },
    electron: {
      BaseWindow,
      WebContentsView,
      screen: { getDisplayMatching: () => ({ workArea: host.getBounds() }) }
    },
    '@electron-toolkit/utils': { is: { dev: false } },
    './window-appearance': { windowAppearance: () => ({}), trackWindowAppearance: noop },
    './miniplayer-agent': {},
    './video-resize': { constrainVideoResize: noop }
  }
  const api = {}
  runInNewContext(compiled, {
    exports: api,
    __dirname: '/test',
    process: { platform: 'darwin', env: {} },
    require: (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`)
      return dependencies[id]
    }
  })
  const page = {
    isDestroyed: () => false,
    isCurrentlyAudible: () => true,
    getBackgroundThrottling: () => true,
    setBackgroundThrottling: noop,
    executeJavaScript: async () => 'none'
  }
  return {
    api,
    page,
    host,
    windows,
    activations,
    get focused() {
      return focus.window
    },
    open: () => api.openMiniplayerWindow('video', page, host, 'width=400,height=260', {}),
    popOut: () => api.popOut('video', new WebContentsView(), host)
  }
}

test('automatic entry shows the player without ever activating it', async () => {
  const app = setup()
  app.page.executeJavaScript = async () => {
    app.open()
    return 'video'
  }
  await app.api.enterMiniplayer('video', app.page)
  assert.equal(app.windows[0].visible, true)
  assert.equal(app.focused, app.host)
  assert.deepEqual(app.activations, [])
  assert.notEqual(app.windows[0].options.focusable, false)
})

test('a site replacing an automatic player also preserves focus after entry finishes', async () => {
  const app = setup()
  app.page.executeJavaScript = async () => {
    app.open()
    return 'handler'
  }
  await app.api.enterMiniplayer('video', app.page)
  app.open()
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.windows[1].visible, true)
  assert.equal(app.focused, app.host)
  assert.deepEqual(app.activations, [])
})

test('a manual whole-tab pop-out still activates its window', () => {
  const app = setup()
  app.popOut()
  assert.equal(app.windows[0].visible, true)
  assert.equal(app.focused, app.windows[0])
  assert.equal(app.api.poppedOutTabId(), 'video')
})

test('a player explicitly requested by the page still activates its window', () => {
  const app = setup()
  app.open()
  assert.equal(app.focused, app.windows[0])
})
