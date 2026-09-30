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

test('transparency restores old toggles and clamps numeric preferences', () => {
  assert.equal(appearance.windowTransparency(false), 0)
  for (const value of [true, null, undefined, '0.5', NaN, Infinity, {}]) {
    assert.equal(appearance.windowTransparency(value), 1)
  }
  for (const value of [0, 0.01, 0.37, 0.99, 1]) {
    assert.equal(appearance.windowTransparency(value), value)
  }
  assert.equal(appearance.windowTransparency(-1), 0)
  assert.equal(appearance.windowTransparency(2), 1)
})

async function setup(value, platform = 'darwin') {
  let listener
  const api = load(
    '../src/main/window-appearance.ts',
    {
      '../shared/appearance': appearance,
      './api/bus': { subscribe: (callback) => (listener = callback) },
      './db/settings': { getSetting: async () => value }
    },
    { process: { platform } }
  )
  await api.registerWindowAppearance()
  function addWindow(material = 'hud') {
    const window = new EventEmitter()
    const changes = []
    window.isDestroyed = () => false
    window.setVibrancy = (value) => changes.push(['vibrancy', value])
    window.setBackgroundColor = (value) => changes.push(['background', value])
    window.contentView = {
      setBackgroundColor: (value) => changes.push(['tint', value])
    }
    api.trackWindowAppearance(window, material)
    return { window, changes }
  }
  return {
    api,
    addWindow,
    change: (value, key = appearance.WINDOW_TRANSPARENCY_SETTING) =>
      listener({ type: 'setting.changed', key, value })
  }
}

test('saved intensity applies before showing a window, including opaque startup', async () => {
  for (const value of [0, 0.5, 1]) {
    const app = await setup(value)
    const options = app.api.windowAppearance('hud')
    assert.equal(options.backgroundColor, value === 0 ? '#18181b' : '#00000000')
    assert.equal(options.vibrancy, value === 0 ? undefined : 'hud')
    const { changes } = app.addWindow()
    assert.ok(
      changes.some(
        ([kind, color]) =>
          kind === 'tint' && color === (value === 0 ? '#18181b' : `rgba(24, 24, 27, ${1 - value})`)
      )
    )
  }
})

test('live slider changes update all windows and fully opaque removes native glass', async () => {
  const app = await setup(1)
  const main = app.addWindow('hud')
  const panel = app.addWindow('under-window')
  main.changes.length = panel.changes.length = 0
  app.change(0.5)
  assert.deepEqual(main.changes, [
    ['vibrancy', 'hud'],
    ['background', '#00000000'],
    ['tint', 'rgba(24, 24, 27, 0.5)']
  ])
  assert.equal(panel.changes[0][1], 'under-window')
  main.changes.length = 0
  app.change(0)
  assert.deepEqual(main.changes, [
    ['background', '#18181b'],
    ['tint', '#18181b'],
    ['vibrancy', null]
  ])
  main.changes.length = 0
  app.change(1)
  assert.deepEqual(main.changes, [
    ['vibrancy', 'hud'],
    ['background', '#00000000'],
    ['tint', 'rgba(24, 24, 27, 0)']
  ])
  main.changes.length = 0
  app.change(1)
  app.change(0, 'appearance.uiDensity')
  assert.equal(main.changes.length, 0)
  main.window.emit('closed')
  panel.window.isDestroyed = () => true
  panel.changes.length = 0
  app.change(0.25)
  assert.equal(main.changes.length, 0)
  assert.equal(panel.changes.length, 0)
})

test('platforms without vibrancy retain their opaque background', async () => {
  for (const platform of ['win32', 'linux']) {
    const app = await setup(0.5, platform)
    assert.equal(app.api.windowAppearance('hud').backgroundColor, '#18181b')
    const { changes } = app.addWindow()
    app.change(0)
    app.change(1)
    assert.equal(changes.length, 0)
  }
})
