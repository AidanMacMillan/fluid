import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, after } from 'node:test'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

// Exercise the actual drag controller, including Svelte's derived validity.
const output = new URL('../out-test/', import.meta.url)
mkdirSync(output, { recursive: true })
const directory = mkdtempSync(new URL('sidebar-reorder-', output))
const modulePath = `${directory}/reorder.mjs`
const source = readFileSync(
  new URL('../src/renderer/src/lib/reorder.svelte.ts', import.meta.url),
  'utf8'
)
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
}).outputText
writeFileSync(modulePath, compileModule(javascript, { generate: 'client' }).js.code)
const { reorder, moveInStrip } = await import(modulePath)
after(() => rmSync(directory, { recursive: true, force: true }))

globalThis.window = { api: { haptics: { alignment: () => {} } } }
globalThis.Node ??= class Node {}
globalThis.requestAnimationFrame = (callback) => {
  callback()
  return 0
}

function event() {
  return {
    dataTransfer: { types: ['application/x-fluid-tab'], setData: () => {} },
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
    defaultPrevented: false
  }
}

function aim(slot, within = []) {
  const over = event()
  reorder.aim(
    over,
    slot,
    { kind: 'line', rowId: 'target', edge: 'top', depth: within.length },
    within
  )
  return over
}

const origin = { section: 'tab', parentId: null, index: 1 }
const item = { kind: 'tab', id: 'source' }

test('a drag started on a hover card can reorder the host sidebar', () => {
  reorder.end()
  reorder.acceptSidebarDrag(item, 'tab', origin)
  assert.equal(reorder.kind, 'tab')
  assert.equal(reorder.carries('source', []), true)
  const slot = { section: 'tab', parentId: null, index: 3 }
  assert.equal(aim(slot).defaultPrevented, true)
  assert.equal(reorder.moves, true)
  assert.deepEqual(reorder.resolveInSidebar(event(), 'tab'), { item, slot })
  assert.equal(reorder.kind, null)
})

test('a drag marks no drop until the pointer is over a slot it could land in', () => {
  reorder.end()
  reorder.acceptSidebarDrag(item, 'tab', origin)
  assert.equal(reorder.moves, false)
  assert.equal(reorder.landsAtEnd('pinned-tab'), false)
  assert.equal(reorder.landsAtEnd('tab'), false)
  reorder.aim(
    event(),
    { section: 'pinned-tab', parentId: null, index: 0 },
    { kind: 'end', section: 'pinned-tab' },
    []
  )
  assert.equal(reorder.landsAtEnd('pinned-tab'), true)
  reorder.leave({ currentTarget: { contains: () => false }, relatedTarget: null })
  assert.equal(reorder.landsAtEnd('pinned-tab'), false)
  assert.equal(reorder.moves, false)
  reorder.end()
})

test('hover-card drags keep no-op detection and can cross pinned sections or folders', () => {
  for (const section of ['tab', 'pinned-tab']) {
    const start = { ...origin, section }
    for (const index of [start.index, start.index + 1]) {
      reorder.acceptSidebarDrag(item, section, start)
      aim({ ...start, index })
      assert.equal(reorder.resolveInSidebar(event(), section), null)
    }
    for (const slot of [
      { section: section === 'tab' ? 'pinned-tab' : 'tab', parentId: null, index: 0 },
      { section, parentId: 'folder', index: 0 }
    ]) {
      reorder.acceptSidebarDrag(item, section, start)
      assert.equal(aim(slot).defaultPrevented, true)
      assert.deepEqual(reorder.resolveInSidebar(event(), slot.section), { item, slot })
    }
  }
})

test('folder drags preserve descendant protection and clear completely on cancellation', () => {
  const folder = { kind: 'folder', id: 'folder' }
  reorder.acceptSidebarDrag(folder, 'tab', origin)
  assert.equal(reorder.carries('child', ['folder']), true)
  assert.equal(reorder.tab, null)
  const rejected = aim({ section: 'tab', parentId: 'child', index: 0 }, ['folder', 'child'])
  assert.equal(rejected.defaultPrevented, false)
  assert.equal(rejected.stopped, true)
  const slot = { section: 'tab', parentId: null, index: 4 }
  aim(slot)
  assert.deepEqual(reorder.resolveInSidebar(event(), 'tab'), { item: folder, slot })
  reorder.acceptSidebarDrag(item, 'tab', origin)
  aim(slot)
  reorder.acceptSidebarDrag(null, 'tab', null)
  assert.equal(reorder.kind, null)
  assert.equal(reorder.dimmed, null)
  assert.equal(reorder.slot, null)
  assert.equal(reorder.resolveInSidebar(event(), 'tab'), null)
})

function taskEvent() {
  return { ...event(), dataTransfer: { types: ['application/x-fluid-task'], setData: () => {} } }
}

function over(kind, index) {
  const e = {
    ...taskEvent(),
    clientX: 0,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 10 }) }
  }
  reorder.over(e, kind, index, 'x')
  return e
}

test('a task can be let go in either list of the strip, and the drop says which', () => {
  for (const [from, to] of [
    ['task', 'pinned-task'],
    ['pinned-task', 'task']
  ]) {
    reorder.end()
    reorder.start(taskEvent(), from, 'a', 1, ['pinned-task', 'task'])
    assert.equal(over(to, 0).defaultPrevented, true)
    assert.deepEqual(reorder.resolve(taskEvent(), 'task'), {
      from: { kind: from, index: 1 },
      to: { kind: to, index: 0 }
    })
  }
})

test('moving a task across the strip pins or unpins it and keeps the order elsewhere', () => {
  const pinned = ['p0', 'p1']
  const unpinned = ['u0', 'u1', 'u2']

  assert.deepEqual(
    moveInStrip(pinned, unpinned, {
      from: { kind: 'task', index: 1 },
      to: { kind: 'pinned-task', index: 1 }
    }),
    { pinned: ['p0', 'u1', 'p1'], unpinned: ['u0', 'u2'], item: 'u1', crossed: true }
  )
  assert.deepEqual(
    moveInStrip(pinned, unpinned, {
      from: { kind: 'pinned-task', index: 0 },
      to: { kind: 'task', index: 3 }
    }),
    { pinned: ['p1'], unpinned: ['u0', 'u1', 'u2', 'p0'], item: 'p0', crossed: true }
  )
  assert.deepEqual(
    moveInStrip(pinned, unpinned, {
      from: { kind: 'task', index: 0 },
      to: { kind: 'task', index: 3 }
    }),
    { pinned, unpinned: ['u1', 'u2', 'u0'], item: 'u0', crossed: false }
  )
  assert.equal(
    moveInStrip(pinned, unpinned, {
      from: { kind: 'task', index: 9 },
      to: { kind: 'task', index: 0 }
    }),
    null
  )
})
