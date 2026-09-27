import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loader } from './agents/load.mjs'
const load = loader()
const noop = () => undefined
const { agentContent, parseVisualization } = load(
  'packages/agent-core/src/shared/visualizations.ts'
)
const { readVisualization, createVisualizationStore } = load(
  'packages/agent-core/src/main/visualizations.ts'
)
const marker =
  'visualize{"path":"/work/dog-breed-explorer.html","mode":"wide","title":"Interactive dog breed explorer"}'

test('Codex and Fluid references normalize to the same visual between prose blocks', () => {
  const visual = {
    path: '/work/dog-breed-explorer.html',
    mode: 'wide',
    title: 'Interactive dog breed explorer'
  }
  const fluid = '```fluid-visualization\n' + JSON.stringify(visual) + '\n```'
  const expected = [
    { kind: 'markdown', source: 'Before\n' },
    { kind: 'visualization', visualization: visual },
    { kind: 'markdown', source: 'After' }
  ]
  assert.deepEqual(agentContent(`Before\n${marker}\nAfter`), expected)
  assert.deepEqual(agentContent(`Before\n${fluid}\nAfter`), expected)
  assert.equal(agentContent(`${marker}\n${marker}`).length, 2)
})

test('split streaming markers stay hidden until complete; completed and replayed text agree', () => {
  for (let i = 1; i < marker.length; i++) {
    assert.deepEqual(agentContent(`Before\n${marker.slice(0, i)}`, true), [
      { kind: 'markdown', source: 'Before\n' }
    ])
  }
  assert.deepEqual(agentContent(marker, true), agentContent(marker, false))
  assert.deepEqual(agentContent('```fluid-visualization\n{"path":', true), [])
  assert.equal(agentContent('visualizebroken', false)[0].kind, 'markdown')
})

test('examples, quoted references, malformed metadata and arbitrary URLs remain readable prose', () => {
  for (const source of [
    `\`\`\`text\n${marker}\n\`\`\``,
    `~~~\n${marker}\n~~~`,
    `> ${marker}`,
    `Use ${marker} here`,
    `    ${marker}`,
    'visualize{"path":"https://example.com/evil.html"}',
    'visualize{"path":"/work/file.txt"}',
    'visualizeno json',
    '```fluid-visualization\n{"path":"relative.html"}\n```'
  ])
    assert.deepEqual(agentContent(source), [{ kind: 'markdown', source }])
  for (const value of [
    null,
    [],
    { path: '/a.html', mode: 'fullscreen' },
    { path: '/a.html', title: 1 }
  ])
    assert.equal(parseVisualization(value), null)
})

test('loader bounds size, file type and canonical roots; tokens expose only loaded HTML', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fluid-visualization-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project')
  await mkdir(root)
  const path = join(root, 'chart.html')
  await writeFile(path, '<button onclick="this.textContent=42">Test</button>')
  const outside = join(directory, 'outside.html')
  await writeFile(outside, 'private')
  await symlink(outside, join(root, 'escape.html'))
  await assert.rejects(readVisualization(outside, [root]), /inside/)
  await assert.rejects(readVisualization(join(root, 'escape.html'), [root]), /inside/)
  await assert.rejects(readVisualization(join(root, '..', 'outside.html'), [root]), /inside/)
  await assert.rejects(readVisualization(join(root, 'missing.html'), [root]))
  await assert.rejects(readVisualization(root, [root]))
  await writeFile(join(root, 'large.html'), 'a'.repeat(1_000_001))
  await assert.rejects(readVisualization(join(root, 'large.html'), [root]), /under 1 MB/)
  const store = createVisualizationStore('codex-visualization')
  const url = await store.load('tab', path, [root])
  const response = store.serve(new Request(url))
  assert.equal(response.status, 200)
  assert.match(await response.text(), /onclick="this.textContent=42"/)
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/)
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/)
  assert.doesNotMatch(
    response.headers.get('content-security-policy'),
    /allow-same-origin|unsafe-eval/
  )
  assert.equal(store.serve(new Request('codex-visualization://preview/not-a-token')).status, 404)
  assert.equal(store.serve(new Request(url + '?file=' + path)).status, 404)
  assert.equal(store.serve(new Request(url, { method: 'POST' })).status, 404)
  await store.load('tab', path, [root])
  assert.equal(
    store.serve(new Request(url)).status,
    200,
    'a second mounted preview must not invalidate the first'
  )
  store.release('tab')
  assert.equal(store.serve(new Request(url)).status, 404)
})

test('both extensions register a validated shared visualization RPC and scheme', async () => {
  const { createAgentExtension } = load('packages/agent-core/src/main/extension.ts')
  for (const id of ['codex', 'claude-code']) {
    const handlers = new Map()
    const extension = createAgentExtension(
      { id, name: id, attachmentScheme: `${id}-file` },
      () => ({ dispose: noop, stop: noop, connect: noop, methods: {} })
    )
    assert.ok(extension.schemes.some((s) => s.scheme === `${id}-visualization`))
    const disposers = []
    await extension.activate({
      dataDir: '/unused',
      onDispose: (fn) => disposers.push(fn),
      api: {
        tabs: { get: async () => ({ type: 'other.session' }) },
        projects: { list: async () => [] }
      },
      rpc: { handle: (name, fn) => handlers.set(name, fn) },
      tabTypes: { register: noop },
      views: { onConnect: noop },
      protocols: { handle: noop }
    })
    await assert.rejects(
      handlers.get('visualization.load')({ tabId: 'other', path: '/a.html' }),
      /no longer exists/
    )
    await assert.rejects(handlers.get('visualization.load')(null), /Expected a tab/)
    disposers.forEach((dispose) => dispose())
  }
})
