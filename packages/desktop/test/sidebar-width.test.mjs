import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/shared/sidebar-width.ts', import.meta.url), 'utf8')
const exports = {}
runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText,
  { exports }
)
const { SIDEBAR_WIDTH: widths, clampSidebarWidth: snap } = exports

test('dragging in either direction never leaves the sidebar in the unreadable gap', () => {
  const halfway = (widths.icons + widths.min) / 2
  for (const values of [
    Array.from({ length: 500 }, (_, i) => i),
    Array.from({ length: 500 }, (_, i) => 499 - i)
  ]) {
    for (const width of values) {
      const result = snap(width)
      assert.ok(result === widths.icons || (result >= widths.min && result <= widths.max))
      assert.equal(snap(result), result, 'persisted widths survive restoration')
    }
  }
  assert.equal(snap(halfway - 1), widths.icons)
  assert.equal(snap(halfway), widths.min)
  assert.equal(snap(240), 240)
})

test('collapsed peeks always resize as full sidebars', () => {
  for (const width of [0, widths.icons, 111, widths.min])
    assert.equal(snap(width, false), widths.min)
  assert.equal(snap(240, false), 240)
  assert.equal(snap(999, false), widths.max)
})

test('invalid saved values recover to a usable default', () => {
  for (const width of [NaN, Infinity, -Infinity]) assert.equal(snap(width), widths.default)
})
