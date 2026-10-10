import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    { exports, require: (id) => dependencies[id], URL }
  )
  return exports
}

const engines = load('../src/shared/search-engine.ts')
const urls = load('../src/renderer/src/lib/urls.ts', {
  '../../../shared/search-engine': engines
})

test('an unset, unknown or damaged setting means Google', () => {
  for (const value of [null, undefined, 'bing', 7, {}, { id: 'nonsense' }, { id: 'custom' }]) {
    assert.equal(engines.searchEngine(value).id, 'google')
  }
})

test('every preset searches and opens on a web address', () => {
  const ids = new Set()
  for (const preset of engines.SEARCH_ENGINE_PRESETS) {
    assert.equal(ids.has(preset.id), false, `duplicate ${preset.id}`)
    ids.add(preset.id)
    assert.equal(engines.customSearchTemplate(preset.searchUrl), preset.searchUrl)
    assert.equal(new URL(preset.homeUrl).protocol, 'https:')
    assert.equal(engines.searchEngine({ id: preset.id }).id, preset.id)
  }
})

test('a custom engine is used only while selected and valid', () => {
  const custom = [{ id: 'custom:a', name: ' Mine ', url: 'https://example.com/s?q=%s' }]
  const chosen = engines.searchEngine({ id: 'custom:a', custom })
  assert.equal(chosen.id, 'custom:a')
  assert.equal(chosen.name, 'Mine')
  assert.equal(chosen.homeUrl, 'https://example.com')
  assert.equal(engines.searchEngine({ id: 'duckduckgo', custom }).id, 'duckduckgo')
  assert.equal(
    JSON.stringify(engines.searchEngineSetting({ id: 'duckduckgo', custom })),
    JSON.stringify({
      id: 'duckduckgo',
      custom: [{ id: 'custom:a', name: 'Mine', url: custom[0].url }]
    })
  )
  const broken = [{ id: 'custom:a', name: 'x', url: 'nope' }]
  assert.equal(engines.searchEngine({ id: 'custom:a', custom: broken }).id, 'google')
})

test('several custom engines are kept, each selectable on its own', () => {
  const custom = [
    { id: 'custom:a', name: 'A', url: 'https://a.example/?q=%s' },
    { id: 'custom:b', name: 'B', url: 'https://b.example/?q=%s' }
  ]
  assert.equal(engines.searchEngineSetting({ id: 'custom:b', custom }).custom.length, 2)
  assert.equal(engines.searchEngine({ id: 'custom:b', custom }).name, 'B')
  assert.equal(engines.searchEngine({ id: 'custom:a', custom }).homeUrl, 'https://a.example')
})

test('custom engines cannot take a preset id or a taken one, and are capped', () => {
  const url = 'https://a.example/?q=%s'
  const kept = engines.searchEngineSetting({
    id: 'google',
    custom: [
      { id: 'google', name: 'Fake', url },
      { id: 'custom:a', name: 'A', url },
      { id: 'custom:a', name: 'Again', url },
      { name: 'No id', url }
    ]
  })
  assert.equal(JSON.stringify(kept.custom.map((engine) => engine.name)), '["A"]')
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `custom:${index}`, name: 'N', url }))
  assert.equal(
    engines.searchEngineSetting({ custom: many }).custom.length,
    engines.MAX_CUSTOM_ENGINES
  )
})

test('the first single-custom format is carried over', () => {
  const legacy = { id: 'custom', custom: { name: 'Test', url: 'https://example.com/%s' } }
  const setting = engines.searchEngineSetting(legacy)
  assert.equal(setting.id, 'custom')
  assert.equal(setting.custom.length, 1)
  assert.equal(engines.searchEngine(legacy).name, 'Test')
  assert.equal(engines.searchEngine({ id: 'custom', custom: null }).id, 'google')
})

test('custom templates need a web address and a placeholder', () => {
  for (const bad of [
    '',
    'https://example.com',
    'ftp://example.com/?q=%s',
    'javascript:%s',
    '%s',
    null
  ]) {
    assert.equal(engines.customSearchTemplate(bad), null, String(bad))
  }
  assert.equal(
    engines.customSearchTemplate(' http://localhost:8080/?q=%s '),
    'http://localhost:8080/?q=%s'
  )
})

test('queries are encoded, and special replacement patterns are not expanded', () => {
  const google = engines.searchEngine(null)
  assert.equal(urls.searchUrl('a b&c'), 'https://www.google.com/search?q=a%20b%26c')
  assert.equal(urls.searchUrl('$& $1'), 'https://www.google.com/search?q=%24%26%20%241')
  const duck = engines.searchEngine({ id: 'duckduckgo' })
  assert.equal(urls.resolveInput('hello world', duck), 'https://duckduckgo.com/?q=hello%20world')
  assert.equal(urls.resolveInput('example.com', duck), 'https://example.com')
  assert.equal(google.id, 'google')
})
