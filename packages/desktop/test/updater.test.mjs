import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function setup({ packaged = true, platform = 'darwin' } = {}) {
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    getVersion: () => '1.0.0'
  })
  const dialogs = []
  const replies = []
  const timers = []
  const menu = { label: 'Check for Updates…', enabled: true }
  const calls = { checks: 0, downloads: 0, installs: 0 }
  let check = async () => ({ isUpdateAvailable: false })
  let download = async () => {
    updater.emit('update-downloaded', { version: '1.1.0' })
    return ['update.zip']
  }
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: () => {
      calls.checks++
      return check()
    },
    downloadUpdate: () => {
      calls.downloads++
      return download()
    },
    quitAndInstall: () => calls.installs++
  })
  const electron = {
    app,
    Menu: { getApplicationMenu: () => ({ getMenuItemById: () => menu }) },
    dialog: {
      showMessageBox: async (options) => {
        dialogs.push(options)
        return { response: replies.shift() ?? 1 }
      }
    }
  }
  function timer(callback, delay) {
    const handle = { callback, delay, cleared: false, unref: () => undefined }
    timers.push(handle)
    return handle
  }
  const exports = {}
  runInNewContext(source, {
    exports,
    require: (id) => {
      if (id === 'electron') return electron
      if (id === 'electron-updater') return { autoUpdater: updater }
      throw new Error(`Unexpected dependency: ${id}`)
    },
    process: { platform },
    console: { error: () => undefined },
    setTimeout: timer,
    setInterval: timer,
    clearTimeout: (handle) => (handle.cleared = true),
    clearInterval: (handle) => (handle.cleared = true)
  })
  return {
    ...exports,
    app,
    updater,
    dialogs,
    replies,
    timers,
    menu,
    calls,
    setCheck: (fn) => (check = fn),
    setDownload: (fn) => (download = fn)
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('development and non-Mac builds never contact the update feed', async () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }]) {
    const state = setup(options)
    state.registerAutoUpdater()
    await state.checkForUpdates()
    assert.equal(state.calls.checks, 0)
    assert.equal(state.timers.length, 0)
  }
})

test('startup and periodic checks are silent, registered once, and cleared at quit', async () => {
  const state = setup()
  state.registerAutoUpdater()
  state.registerAutoUpdater()
  assert.deepEqual(
    state.timers.map((timer) => timer.delay),
    [15_000, 21_600_000]
  )
  for (const timer of state.timers) {
    timer.callback()
    await settle()
  }
  assert.equal(state.calls.checks, 2)
  assert.equal(state.dialogs.length, 0)
  assert.equal(state.updater.allowPrerelease, false)
  assert.equal(state.updater.allowDowngrade, false)
  state.app.emit('before-quit')
  assert.ok(state.timers.every((timer) => timer.cleared))
})

test('a manual check reports the installed version when no update is available', async () => {
  const state = setup()
  state.registerAutoUpdater()
  await state.checkForUpdates()
  assert.match(state.dialogs[0].message, /up to date/)
  assert.match(state.dialogs[0].detail, /1\.0\.0/)
  assert.equal(state.calls.downloads, 0)
  assert.equal(state.menu.enabled, true)
})

test('downloads in the background; Later keeps working and the menu can restart', async () => {
  const state = setup()
  state.setCheck(async () => ({ isUpdateAvailable: true }))
  state.registerAutoUpdater()
  await state.checkForUpdates(false)
  await settle()
  assert.equal(state.calls.downloads, 1)
  assert.equal(state.calls.installs, 0)
  assert.equal(state.updater.autoInstallOnAppQuit, true)
  assert.match(state.dialogs[0].message, /1\.1\.0/)
  assert.match(state.menu.label, /Restart/)
  state.replies.push(0)
  await state.checkForUpdates()
  assert.equal(state.calls.installs, 1)
  assert.equal(state.calls.checks, 1)
})

test('overlapping checks cannot start duplicate downloads', async () => {
  const state = setup()
  let resolveCheck
  state.setCheck(() => new Promise((resolve) => (resolveCheck = resolve)))
  state.registerAutoUpdater()
  const pending = state.checkForUpdates(false)
  assert.equal(state.menu.enabled, false)
  await state.checkForUpdates()
  assert.equal(state.calls.checks, 1)
  resolveCheck({ isUpdateAvailable: true })
  await pending
  assert.equal(state.calls.downloads, 1)
})

test('network failures stay quiet in the background and manual checks can retry', async () => {
  const state = setup()
  state.setCheck(async () => {
    throw new Error('offline')
  })
  state.registerAutoUpdater()
  await state.checkForUpdates(false)
  assert.equal(state.dialogs.length, 0)
  await state.checkForUpdates()
  assert.equal(state.dialogs[0].type, 'error')
  assert.equal(state.menu.enabled, true)
  state.setCheck(async () => ({ isUpdateAvailable: false }))
  await state.checkForUpdates()
  assert.match(state.dialogs[1].message, /up to date/)
})

test('a failed download restores the menu and can be retried', async () => {
  const state = setup()
  state.setCheck(async () => ({ isUpdateAvailable: true }))
  state.setDownload(async () => {
    throw new Error('download interrupted')
  })
  state.registerAutoUpdater()
  await state.checkForUpdates()
  assert.equal(state.calls.installs, 0)
  assert.equal(state.menu.label, 'Check for Updates…')
  assert.equal(state.dialogs[0].type, 'error')
  state.setDownload(async () => {
    state.updater.emit('update-downloaded', { version: '1.1.0' })
    return ['update.zip']
  })
  await state.checkForUpdates()
  assert.equal(state.calls.downloads, 2)
  assert.match(state.menu.label, /Restart/)
})

test('a native verification error clears the pending update so a check can retry', async () => {
  const state = setup()
  state.setCheck(async () => ({ isUpdateAvailable: true }))
  state.registerAutoUpdater()
  await state.checkForUpdates(false)
  state.updater.emit('error', new Error('signature verification failed'))
  assert.equal(state.menu.label, 'Check for Updates…')
  await state.checkForUpdates(false)
  assert.equal(state.calls.checks, 2)
  assert.equal(state.calls.installs, 0)
})
