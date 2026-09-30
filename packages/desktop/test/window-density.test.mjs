import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const exports = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    { exports, require: (id) => dependencies[id], ...globals }
  )
  return exports
}

const appearance = load('../src/shared/appearance.ts')

test('density preserves intermediate values and safely restores old or invalid preferences', () => {
  for (const value of [null, undefined, '1.3', NaN, Infinity, {}, false]) {
    assert.equal(appearance.uiDensity(value), 1)
  }
  assert.equal(appearance.uiDensity(1.234567), 1.234567)
  assert.equal(appearance.uiDensity(-1), 0.85)
  assert.equal(appearance.uiDensity(10), 1.3)
  assert.equal(appearance.titleBarHeight(1), 40)
  for (const density of [0.85, 1, 1.017, 1.3, 1.6]) {
    const { x, y } = appearance.trafficLightPosition(density)
    assert.equal(x, 14)
    assert.ok(Math.abs(y + 6 - appearance.titleBarHeight(density) / 2) <= 0.5)
  }
})

test('slider maps Compact, Tight and Medium to the ends and midpoint without a kink', () => {
  const { densityFromSlider: from, densityToSlider: to } = appearance
  assert.equal(from(0), 0.85)
  assert.equal(from(0.5), 1)
  assert.equal(from(1), 1.3)
  assert.equal(to(1), 0.5)
  assert.equal(to(1.6), 1, 'old Spacious preferences land at the new maximum')
  let previous = from(0)
  for (let i = 1; i <= 100; i++) {
    const position = i / 100
    const density = from(position)
    assert.ok(density > previous)
    assert.ok(Math.abs(to(density) - position) < 1e-12)
    previous = density
  }
  const delta = 1e-5
  const leftSlope = (from(0.5) - from(0.5 - delta)) / delta
  const rightSlope = (from(0.5 + delta) - from(0.5)) / delta
  assert.ok(Math.abs(leftSlope - rightSlope) < 1e-4)
})

async function setup(platform) {
  const ipcMain = new EventEmitter()
  let listener
  const density = load(
    '../src/main/window-density.ts',
    {
      electron: { ipcMain },
      '../shared/appearance': appearance,
      './api/bus': { subscribe: (callback) => (listener = callback) },
      './db/settings': { getSetting: async () => 1.3 }
    },
    { process: { platform } }
  )
  await density.registerWindowDensity()
  const changes = []
  const window = new EventEmitter()
  window.isDestroyed = () => false
  window.setWindowButtonPosition = (position) => changes.push({ kind: 'buttons', ...position })
  window.setTitleBarOverlay = (overlay) => changes.push({ kind: 'overlay', ...overlay })
  density.trackWindowDensity(window)
  return {
    density,
    ipcMain,
    window,
    changes,
    change: (value, key = appearance.UI_DENSITY_SETTING) =>
      listener({ type: 'setting.changed', key, value })
  }
}

test('Mac main windows follow live density, reset and fullscreen without changing width', async () => {
  const app = await setup('darwin')
  assert.equal(app.density.currentWindowDensity(), 1.3)
  const event = {}
  app.ipcMain.emit('appearance:density', event)
  assert.equal(event.returnValue, 1.3)
  app.change(false, 'appearance.windowTransparency')
  assert.equal(app.changes.length, 0)
  app.change(1.6)
  assert.deepEqual(app.changes.at(-1), { kind: 'buttons', x: 14, y: 20 })
  app.window.emit('leave-full-screen')
  assert.equal(app.changes.length, 2)
  app.change(null)
  assert.equal(app.density.currentWindowDensity(), 1)
  assert.deepEqual(app.changes.at(-1), { kind: 'buttons', x: 14, y: 14 })
  app.window.emit('closed')
  app.change(0.85)
  assert.equal(app.changes.length, 3)
})

test('other platforms resize their native overlay with the browser title bar', async () => {
  for (const platform of ['win32', 'linux']) {
    const app = await setup(platform)
    app.change(0.85)
    assert.deepEqual(app.changes, [{ kind: 'overlay', height: 34 }])
    app.change(1.6)
    assert.deepEqual(app.changes.at(-1), { kind: 'overlay', height: 52 })
  }
})
