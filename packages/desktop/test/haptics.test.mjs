import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, after } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

// Exercise the actual drag controller, including Svelte's derived validity.
const output = new URL('../out-test/', import.meta.url)
mkdirSync(output, { recursive: true })
const directory = mkdtempSync(new URL('haptics-', output))
const modulePath = `${directory}/reorder.mjs`
const source = readFileSync(
  new URL('../src/renderer/src/lib/reorder.svelte.ts', import.meta.url),
  'utf8'
)
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
}).outputText
writeFileSync(modulePath, compileModule(javascript, { generate: 'client' }).js.code)
const { reorder } = await import(modulePath)
after(() => rmSync(directory, { recursive: true, force: true }))

let pulses = 0
globalThis.window = { api: { haptics: { alignment: () => pulses++ } } }
globalThis.requestAnimationFrame = () => 0
globalThis.Node = class {}

function event(kind = 'tab') {
  return {
    dataTransfer: { types: [`application/x-fluid-${kind}`], setData: () => undefined },
    currentTarget: { contains: () => false },
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation: () => undefined,
    defaultPrevented: false
  }
}

function sidebar(item = { kind: 'tab', id: 'source' }) {
  reorder.end()
  pulses = 0
  reorder.startInSidebar(event(), 'tab', item, { section: 'tab', parentId: null, index: 1 }, [
    'tab',
    'pinned-tab'
  ])
}

function aim(index, section = 'tab', parentId = null, within = [], rowId = 'row') {
  reorder.aim(
    event(),
    { section, parentId, index },
    { kind: 'line', rowId, edge: 'top', depth: 0 },
    within
  )
}

test('sidebar ticks for changed destinations, not no-ops or two marks of one slot', () => {
  sidebar()
  aim(1)
  aim(2)
  assert.equal(pulses, 0)
  aim(3)
  aim(3, 'tab', null, [], 'other-row')
  assert.equal(pulses, 1)
  aim(0, 'pinned-tab')
  aim(0, 'tab', 'folder')
  assert.equal(pulses, 3)
  reorder.leave(event())
  assert.equal(pulses, 3)
  aim(0, 'tab', 'folder')
  assert.equal(pulses, 4)
})

test('folder descendants and unrelated external drags are silent', () => {
  sidebar({ kind: 'folder', id: 'folder' })
  aim(0, 'tab', 'child', ['folder', 'child'])
  assert.equal(pulses, 0)
  reorder.end()
  aim(3)
  assert.equal(pulses, 0)
})

test('task strip deduplicates targets and resets between drags', () => {
  reorder.end()
  pulses = 0
  for (let i = 0; i < 2; i++) {
    reorder.start(event('task'), 'task', 'source', 1)
    reorder.overRest(event('task'), 'task', 2)
    assert.equal(pulses, i)
    reorder.overRest(event('task'), 'task', 4)
    reorder.overRest(event('task'), 'task', 4)
    assert.equal(pulses, i + 1)
    reorder.end()
  }
})

test('task transfers and split targets tick once per destination', () => {
  sidebar()
  reorder.overTask(event(), 'task-a')
  reorder.overTask(event(), 'task-a')
  reorder.overTask(event(), 'task-b')
  assert.equal(pulses, 2)
  reorder.leaveTask(event(), 'task-b')
  reorder.feedbackFor('split-left')
  reorder.feedbackFor('split-left')
  reorder.feedbackFor('split-right')
  assert.equal(pulses, 4)
  reorder.end()
  reorder.feedbackFor('late-split-report')
  assert.equal(pulses, 4)
})

const mainSource = ts.transpileModule(
  readFileSync(new URL('../src/main/haptics.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText

function nativeBridge(platform, fails = false) {
  let now = 0
  let calls = 0
  let loads = 0
  const exports = {}
  runInNewContext(mainSource, {
    exports,
    process: { platform },
    performance: { now: () => now },
    console: { warn: () => undefined },
    require() {
      loads++
      if (fails) throw new Error('Unavailable')
      return { alignment: () => calls++ }
    }
  })
  return {
    pulse(time) {
      now = time
      exports.alignmentHaptic()
    },
    get calls() {
      return calls
    },
    get loads() {
      return loads
    }
  }
}

test('native bridge limits rapid feedback and loads once', () => {
  const bridge = nativeBridge('darwin')
  bridge.pulse(0)
  bridge.pulse(20)
  bridge.pulse(50)
  assert.equal(bridge.calls, 2)
  assert.equal(bridge.loads, 1)
})

test('unsupported platforms and unavailable native modules are harmless', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const bridge = nativeBridge(platform, true)
    bridge.pulse(0)
    bridge.pulse(100)
    assert.equal(bridge.calls, 0)
    assert.equal(bridge.loads, platform === 'darwin' ? 1 : 0)
  }
})
