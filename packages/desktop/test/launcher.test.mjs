import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    { exports, require: (id) => dependencies[id], ...globals }
  )
  return exports
}

const profiles = load('../src/main/profiles.ts')

function setup() {
  const panels = []
  const sent = []
  const parent = new EventEmitter()
  parent.isDestroyed = () => false
  parent.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 })
  parent.webContents = { send: (channel, choice) => sent.push({ channel, choice }) }

  class Panel extends EventEmitter {
    constructor() {
      super()
      this.webContents = new EventEmitter()
      this.destroyed = false
      panels.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    loadFile(_path, { query }) {
      this.mode = query.mode
    }
    focus() {
      this.emit('focus')
    }
    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }

  const launcher = load(
    '../src/main/launcher-window.ts',
    {
      path: { join },
      electron: {
        BrowserWindow: Panel,
        Menu: {
          buildFromTemplate: () => assert.fail('Incognito must not open an alternatives menu')
        }
      },
      '@electron-toolkit/utils': { is: { dev: false } },
      './window-appearance': { windowAppearance: () => ({}), trackWindowAppearance: () => {} },
      './profile-menu': {
        popupProfileMenu: () => assert.fail('Incognito must not offer profiles')
      },
      './profiles': profiles
    },
    { __dirname: '/test' }
  )
  return { launcher, parent, panels, sent }
}

test('incognito forces its profile for every URL selection', () => {
  for (const profile of [null, 1, 5, profiles.INCOGNITO_PROFILE_ID]) {
    const { launcher, parent, panels, sent } = setup()
    launcher.openLauncherWindow(parent, 'incognito')
    launcher.submitLauncherChoice({ kind: 'url', url: 'https://example.com', profile })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].channel, 'launcher:openTab')
    assert.equal(sent[0].choice.kind, 'url')
    assert.equal(sent[0].choice.url, 'https://example.com')
    assert.equal(sent[0].choice.profile, profiles.INCOGNITO_PROFILE_ID)
    assert.equal(panels[0].destroyed, true)
  }
})

test('incognito rejects other tab types, tasks and menus without closing the panel', async () => {
  const { launcher, parent, panels, sent } = setup()
  launcher.openLauncherWindow(parent, 'incognito')
  for (const choice of [
    { kind: 'extension-tab', tab: { type: 'terminal.session', payload: {} } },
    { kind: 'extension-alternative', entry: 'terminal.new', alternative: 'folder' },
    { kind: 'task', task: {} }
  ])
    launcher.submitLauncherChoice(choice)
  await launcher.chooseLauncherProfile('https://example.com')
  await launcher.chooseLauncherAlternative('terminal.new', [{ id: 'folder', label: 'Folder' }])
  assert.equal(sent.length, 0)
  assert.equal(panels[0].destroyed, false)
})

test('switching launcher modes reuses the panel and restores ordinary selections', () => {
  const { launcher, parent, panels, sent } = setup()
  launcher.openLauncherWindow(parent)
  launcher.openLauncherWindow(parent, 'incognito')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].mode, 'incognito')
  launcher.openLauncherWindow(parent, 'tab')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].mode, 'tab')
  const choice = { kind: 'url', url: 'https://example.com', profile: 2 }
  launcher.submitLauncherChoice(choice)
  assert.equal(sent[0].choice, choice)
})
