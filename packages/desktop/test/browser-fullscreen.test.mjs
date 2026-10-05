import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/browser-views.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const noop = () => {}
const pane = (patch = {}) => ({
  x: 220,
  y: 80,
  width: 780,
  height: 620,
  viewport: { width: 1000, height: 700 },
  anchor: 'fill',
  ...patch
})

function setup() {
  const views = []
  const children = []
  const messages = []
  const miniplayerOffers = []
  let sidebarSuppressed = false
  class WebContentsView {
    constructor() {
      views.push(this)
      this.scripts = []
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        setZoomMode: noop,
        setVisualZoomLevelLimits: noop,
        setWindowOpenHandler: noop,
        loadURL: async () => {},
        executeJavaScript: async (script) => this.scripts.push(script),
        getURL: () => 'https://example.com',
        getTitle: () => 'Example',
        isCurrentlyAudible: () => false,
        isAudioMuted: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        focus: () => this.webContents.emit('focus'),
        close: () => this.webContents.emit('destroyed')
      })
    }
    setBounds(bounds) {
      this.bounds = { ...bounds }
    }
    setVisible(value) {
      this.visible = value
    }
    setBackgroundColor(color) {
      this.background = color
    }
    setBorderRadius(radius) {
      this.radius = radius
    }
  }
  const host = Object.assign(new EventEmitter(), {
    size: [1000, 700],
    visible: true,
    minimized: false,
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => host.visible,
    isMinimized: () => host.minimized,
    getContentSize: () => host.size,
    getContentBounds: () => ({ width: host.size[0], height: host.size[1] }),
    webContents: { send: (...args) => messages.push(args) },
    contentView: {
      addChildView(view) {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
        children.push(view)
      },
      removeChildView(view) {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
      }
    }
  })
  const dependencies = {
    electron: { WebContentsView },
    './history-capture': {},
    './sidebar-panel': {
      destroySidebarPanel: noop,
      raiseSidebarPanel: noop,
      suppressSidebarPanel: (value) => {
        sidebarSuppressed = value
      }
    },
    './context-menu': { attachContextMenu: noop },
    './ad-blocking': { adBlocker: { attach: noop } },
    './adblocker': {},
    './api/contributions': { whenContributionsChange: noop },
    './api/isolation-policy': {},
    './extension-views': { setAppFocused: noop, forgetWebViewUrl: noop },
    './db/tabs': {},
    './files': {},
    './find-bar': { destroyFindBar: noop, isFindBarOpen: () => false },
    './miniplayer-agent': {},
    './miniplayer': {
      onFloatingChanged: noop,
      armMiniplayer: noop,
      leaveMiniplayer: noop,
      enterMiniplayer: async (tabId) => miniplayerOffers.push(tabId),
      forgetMiniplayer: noop,
      poppedOutTabId: () => null
    },
    './profiles': { isEphemeralProfile: () => false },
    './browsing': { partitionFor: noop, sameBrowsingContext: () => true },
    './site-icons': {},
    './split-drop': { destroySplitDrop: noop, prepareSplitDrop: noop },
    './zoom-indicator': {
      destroyZoomIndicator: noop,
      hideZoomIndicator: noop,
      moveZoomIndicator: noop
    },
    '@fluid/sdk': { isWebAddress: () => true }
  }
  const api = {}
  runInNewContext(compiled, {
    exports: api,
    console,
    setImmediate,
    require: (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`)
      return dependencies[id]
    }
  })
  api.registerHostWindow(host)
  return {
    api,
    host,
    views,
    children,
    messages,
    miniplayerOffers,
    get sidebarSuppressed() {
      return sidebarSuppressed
    },
    show(id, bounds = pane()) {
      api.showBrowserView(id, 'https://example.com', null, null, bounds)
      return views.at(-1)
    }
  }
}

test('HTML fullscreen fills the window through native resizing and renderer measurements', () => {
  const app = setup()
  const view = app.show('video')
  view.webContents.emit('enter-html-full-screen')
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 700 })
  assert.equal(app.sidebarSuppressed, true)
  app.host.size = [1600, 900]
  app.host.emit('resize')
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1600, height: 900 })
  const updated = pane({ x: 300, width: 1300, height: 820, viewport: { width: 1600, height: 900 } })
  app.api.setBrowserViewBounds('video', updated)
  app.show('video', updated)
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1600, height: 900 })
  view.webContents.emit('leave-html-full-screen')
  assert.deepEqual(view.bounds, { x: 300, y: 80, width: 1300, height: 820 })
  assert.equal(app.sidebarSuppressed, false)
})

test('split siblings and newly attached panes stay hidden until fullscreen exits', () => {
  const app = setup()
  const left = app.show('left', pane({ width: 390 }))
  const right = app.show('right', pane({ x: 610, width: 390 }))
  left.webContents.emit('enter-html-full-screen')
  assert.equal(left.visible, true)
  assert.equal(right.visible, false)
  const third = app.show('third')
  assert.equal(third.visible, false)
  right.webContents.emit('leave-html-full-screen')
  assert.deepEqual(left.bounds, { x: 0, y: 0, width: 1000, height: 700 })
  left.webContents.emit('leave-html-full-screen')
  assert.deepEqual(left.bounds, { x: 220, y: 80, width: 390, height: 620 })
  assert.equal(right.visible, true)
  assert.equal(third.visible, true)
})

test('switching, closing and crashes release the fullscreen layout', () => {
  for (const action of ['hide', 'close', 'crash']) {
    const app = setup()
    const video = app.show('video')
    const sibling = app.show('sibling')
    video.webContents.emit('enter-html-full-screen')
    if (action === 'hide') app.api.hideBrowserView('video')
    if (action === 'close') app.api.destroyBrowserView('video')
    if (action === 'crash') video.webContents.emit('render-process-gone')
    assert.equal(sibling.visible, true, action)
    assert.equal(app.sidebarSuppressed, false, action)
    if (action !== 'crash') assert.match(video.scripts[0], /document.exitFullscreen/)
    if (action === 'hide') {
      app.show('video')
      assert.deepEqual(video.bounds, { x: 220, y: 80, width: 780, height: 620 })
    }
  }
})

test('native fullscreen preserves app chrome; HTML fullscreen suppresses sidebar peeking', () => {
  const app = setup()
  const video = app.show('video')
  app.host.emit('enter-full-screen')
  assert.deepEqual(video.bounds, { x: 220, y: 80, width: 780, height: 620 })
  video.webContents.emit('enter-html-full-screen')
  app.api.watchPeekZone(10)
  video.webContents.emit('input-event', {}, { type: 'mouseMove', x: 0 })
  assert.equal(
    app.messages.some(([channel, value]) => channel === 'browser:peek' && value),
    false
  )
  video.webContents.emit('leave-html-full-screen')
  assert.deepEqual(video.bounds, { x: 220, y: 80, width: 780, height: 620 })
})

test('fullscreen occlusion never offers a miniplayer for a window that remains visible', () => {
  const app = setup()
  const video = app.show('video')
  // Native occlusion can arrive before or after the HTML fullscreen event.
  app.host.emit('hide')
  video.webContents.emit('enter-html-full-screen')
  app.host.emit('hide')
  app.host.emit('enter-full-screen')
  app.host.emit('show')
  app.host.emit('hide')
  video.webContents.emit('leave-html-full-screen')
  app.host.emit('hide')
  app.host.emit('leave-full-screen')
  app.host.emit('show')
  assert.deepEqual(app.miniplayerOffers, [])
})

test('genuinely hiding or minimizing a fullscreen window still offers the miniplayer', () => {
  for (const event of ['hide', 'minimize']) {
    const app = setup()
    const video = app.show('video')
    video.webContents.emit('enter-html-full-screen')
    if (event === 'hide') app.host.visible = false
    else app.host.minimized = true
    app.host.emit(event)
    assert.deepEqual(app.miniplayerOffers, ['video'], event)
  }
})

test('switching away from a fullscreen tab still offers the miniplayer', () => {
  const app = setup()
  const video = app.show('video')
  video.webContents.emit('enter-html-full-screen')
  app.api.hideBrowserView('video')
  assert.deepEqual(app.miniplayerOffers, ['video'])
})
