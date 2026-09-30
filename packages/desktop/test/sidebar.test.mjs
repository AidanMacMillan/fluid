import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Run the native pointer watcher with page input and window geometry supplied
// by the test, without starting Electron or opening the user's database.
const source = readFileSync(new URL('../src/main/browser-views.ts', import.meta.url), 'utf8')
const watcher = ts.transpileModule(
  source.slice(
    source.indexOf('let peekZone ='),
    source.indexOf('export function registerHostWindow')
  ),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText

function setup() {
  const reports = []
  const placement = { bounds: { x: 0 } }
  let windowWidth = 1000
  let listener
  const context = {
    exports: {},
    fullscreenTabId: null,
    attached: new Map([['tab', placement]]),
    hostWindow: {
      isDestroyed: () => false,
      getContentBounds: () => ({ width: windowWidth })
    },
    sendToHost: (_channel, inside) => reports.push(inside)
  }
  runInNewContext(watcher, context)
  context.watchPointer({ on: (_event, callback) => (listener = callback) }, 'tab')
  return {
    reports,
    placement,
    watch: context.exports.watchPeekZone,
    fullscreen: (tabId) => (context.fullscreenTabId = tabId),
    resize: (width) => (windowWidth = width),
    move: (x, modifiers = []) => listener(null, { type: 'mouseMove', x, modifiers }),
    leave: () => listener(null, { type: 'mouseLeave' })
  }
}

test('left sidebar watches only the fixed left edge and reports crossings', () => {
  const app = setup()
  app.watch(8, 'left')
  app.move(-1)
  app.move(8)
  app.move(999)
  assert.deepEqual(app.reports, [])
  app.move(0)
  app.move(7)
  app.move(8)
  assert.deepEqual(app.reports, [true, false])
  // Sliding the page over must not move the activation band with it.
  app.placement.bounds.x = 224
  app.move(0)
  assert.deepEqual(app.reports, [true, false])
})

test('right sidebar uses the window edge across split panes and window resizes', () => {
  const app = setup()
  app.watch(8, 'right')
  app.placement.bounds.x = 500
  app.move(0)
  app.move(491)
  assert.deepEqual(app.reports, [])
  app.move(492)
  app.move(499)
  app.move(500)
  assert.deepEqual(app.reports, [true, false])
  app.resize(1200)
  app.move(499)
  app.move(699)
  app.leave()
  assert.deepEqual(app.reports, [true, false, true, false])
})

test('switching sides and docking clear the previous hover; page drags do not peek', () => {
  const app = setup()
  app.watch(8, 'left')
  app.move(0)
  app.watch(8, 'right')
  app.move(0)
  app.move(999, ['leftbuttondown'])
  assert.deepEqual(app.reports, [true, false])
  app.move(999)
  app.watch(0, 'right')
  app.move(999)
  assert.deepEqual(app.reports, [true, false, true, false])
})

test('HTML fullscreen suppresses edge peeks until the tab leaves fullscreen', () => {
  const app = setup()
  app.watch(8, 'left')
  app.fullscreen('tab')
  app.move(0)
  assert.deepEqual(app.reports, [])
  app.fullscreen(null)
  app.move(0)
  assert.deepEqual(app.reports, [true])
})
