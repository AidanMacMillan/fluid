import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

const root = fileURLToPath(new URL('..', import.meta.url))
let database
let postgres

// Exercise the real TypeScript API, capture and queries against a migrated,
// disposable database. No Electron window or user data is involved.
function loader() {
  const cache = new Map()
  const client = resolve(root, 'src/main/db/client.ts')
  function load(path) {
    if (path === client) return { db: () => database }
    if (cache.has(path)) return cache.get(path).exports
    const mod = { exports: {} }
    cache.set(path, mod)
    const native = createRequire(path)
    const require = (name) => {
      let target
      if (name.startsWith('.') && existsSync(resolve(dirname(path), name + '.ts'))) {
        target = resolve(dirname(path), name + '.ts')
      } else target = native.resolve(name)
      return target.endsWith('.ts') ? load(target) : native(name)
    }
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    new Function('require', 'exports', 'module', code)(require, mod.exports, mod)
    return mod.exports
  }
  return (path) => load(resolve(root, path))
}

before(async () => {
  postgres = await PGlite.create()
  database = drizzle(postgres)
  await migrate(database, { migrationsFolder: resolve(root, 'resources/migrations') })
})
after(async () => {
  await postgres?.close()
})

async function setup() {
  const load = loader()
  const { rows: projects } = await postgres.query('SELECT id FROM projects LIMIT 1')
  const taskId = randomUUID()
  const otherTask = randomUUID()
  await postgres.query(
    'INSERT INTO tasks (id, project_id, position) VALUES ($1, $3, 0), ($2, $3, 1)',
    [taskId, otherTask, projects[0].id]
  )
  const store = load('src/main/db/history.ts')
  const api = load('src/main/api/history.ts')
  const bus = load('src/main/api/bus.ts')
  const capture = load('src/main/history-capture.ts')
  const contributions = load('src/main/api/contributions.ts')
  capture.registerHistoryCapture()
  const addTab = async (type, payload, profile = null) => {
    const id = randomUUID()
    await postgres.query(
      'INSERT INTO tabs (id, task_id, type, payload, position, profile) VALUES ($1, $2, $3, $4, 0, $5)',
      [id, taskId, type, JSON.stringify(payload), profile]
    )
    return id
  }
  const getTab = load('src/main/db/tabs.ts').getTab
  const flush = () => api.historyWork(async () => {})
  return { taskId, otherTask, store, api, bus, capture, contributions, addTab, getTab, flush, load }
}

test('migration stores durable task history, isolates tasks, searches literal text and paginates', async () => {
  const h = await setup()
  const tabId = await h.addTab('browser', { url: 'https://example.com' })
  for (let i = 0; i < 3; i++)
    await h.store.insertHistory({
      taskId: h.taskId,
      tabId,
      type: 'browser',
      label: 'Web page',
      title: i === 1 ? '100%_done' : `Page ${i}`,
      visitedAt: new Date(1000 + i)
    })
  await h.store.insertHistory({
    taskId: h.otherTask,
    type: 'file',
    label: 'File',
    title: 'Other task'
  })
  assert.deepEqual(
    (await h.store.listHistory(h.taskId, '', 1, 1)).map((row) => row.title),
    ['100%_done']
  )
  assert.equal((await h.store.listHistory(h.taskId, '%_')).length, 1)
  await postgres.query('DELETE FROM tabs WHERE id = $1', [tabId])
  assert.equal(
    (await h.store.listHistory(h.taskId)).length,
    3,
    'closing a tab preserves its visits'
  )
  await h.api.remove(h.taskId)
  assert.equal((await h.store.listHistory(h.taskId)).length, 0)
  assert.equal((await h.store.listHistory(h.otherTask)).length, 1)
  await postgres.query('DELETE FROM tasks WHERE id = $1', [h.otherTask])
  assert.equal((await h.store.listHistory(h.otherTask)).length, 0, 'task deletion cascades')
})

test('browser navigations retain each URL; late titles update only the matching visit', async () => {
  const h = await setup()
  const id = await h.addTab('browser', { url: 'https://example.com' }, 2)
  h.capture.visitPage(id, 'https://example.com/one')
  h.capture.updatePageTitle(id, 'https://example.com/one', 'First page')
  h.capture.visitPage(id, 'https://example.com/two')
  h.capture.updatePageTitle(id, 'https://example.com/one', 'Stale title')
  h.capture.updatePageTitle(id, 'https://example.com/two', 'Second page')
  h.capture.visitTab(id)
  await h.flush()
  const entries = await h.store.listHistory(h.taskId)
  assert.equal(entries.length, 2, 'tab focus does not duplicate page visits')
  assert.equal(entries.find((e) => e.location.endsWith('/one')).title, 'First page')
  assert.equal(entries.find((e) => e.location.endsWith('/two')).title, 'Second page')
  assert.equal(entries[0].metadata.profile, 2)
})

test('incognito and internal browser addresses do not enter persistent history', async () => {
  const h = await setup()
  const id = await h.addTab('browser', { url: 'https://example.com' }, 6)
  const normal = await h.addTab('browser', { url: 'about:blank' })
  h.capture.visitPage(id, 'https://example.com/private')
  h.capture.visitPage(normal, 'about:blank')
  h.capture.visitPage(normal, 'fluid-extension://internal')
  await h.flush()
  assert.equal((await h.store.listHistory(h.taskId)).length, 0)
})

test('file, terminal and editor selections record visits without copying commands', async () => {
  const h = await setup()
  h.contributions.registerTabType('terminal', {
    id: 'shell',
    label: 'Terminal',
    history: { location: 'cwd' }
  })
  h.contributions.registerTabType('vscode', {
    id: 'editor',
    label: 'VS Code',
    history: { location: 'folderPath' }
  })
  const file = await h.addTab('file', {
    storageKey: 'copy.pdf',
    fileName: 'Report.pdf',
    sourcePath: '/docs/Report.pdf',
    mimeType: 'application/pdf',
    size: 32
  })
  const terminal = await h.addTab('terminal.shell', {
    cwd: '/project',
    command: 'secret command',
    run: 'one-time'
  })
  const editor = await h.addTab('vscode.editor', { folderPath: '/project' })
  h.capture.visitTab(file)
  h.capture.visitTab(file)
  h.capture.visitTab(terminal)
  h.capture.visitTab(editor)
  h.capture.visitTab(file)
  await h.flush()
  const entries = await h.store.listHistory(h.taskId)
  assert.equal(entries.length, 4)
  assert.equal(entries.filter((e) => e.type === 'file').length, 2)
  assert.equal(entries.find((e) => e.type === 'terminal.shell').location, '/project')
  assert.equal(entries.find((e) => e.type === 'vscode.editor').location, '/project')
  assert.ok(!JSON.stringify(entries).includes('secret command'))
})

test('agent visits acquire their session ID and preserve old sessions and original task', async () => {
  const h = await setup()
  for (const provider of ['claude-code', 'codex']) {
    h.contributions.registerTabType(provider, {
      id: 'session',
      label: provider,
      history: { location: 'cwd', sessionId: 'sessionId' }
    })
    const id = await h.addTab(`${provider}.session`, { cwd: '/project', prompt: 'private prompt' })
    h.capture.visitTab(id)
    await h.flush()
    const tab = await h.getTab(id)
    h.bus.emit({
      type: 'tab.updated',
      tab: { ...tab, title: 'Conversation', payload: { cwd: '/project', sessionId: 'session-1' } }
    })
    await h.flush()
    let entries = (await h.store.listHistory(h.taskId)).filter((e) => e.tabId === id)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, 'session-1')
    h.bus.emit({
      type: 'tab.updated',
      tab: { ...tab, payload: { cwd: '/project', sessionId: 'session-2' } }
    })
    await h.flush()
    entries = (await h.store.listHistory(h.taskId)).filter((e) => e.tabId === id)
    assert.deepEqual(entries.map((e) => e.sessionId).sort(), ['session-1', 'session-2'])
    assert.ok(!JSON.stringify(entries).includes('private prompt'))
    h.bus.emit({ type: 'tab.moved', tab: { ...tab, taskId: h.otherTask }, fromTaskId: h.taskId })
    h.bus.emit({ type: 'tab.updated', tab: { ...tab, taskId: h.otherTask, title: 'Moved' } })
    await h.flush()
    assert.equal((await h.store.listHistory(h.otherTask)).length, 0)
  }
})

test('clearing waits for pending visits and later title changes cannot restore entries', async () => {
  const h = await setup()
  const id = await h.addTab('browser', { url: 'https://example.com' })
  h.capture.visitPage(id, 'https://example.com')
  await h.api.remove(h.taskId)
  h.capture.updatePageTitle(id, 'https://example.com', 'Late title')
  await h.flush()
  assert.equal((await h.store.listHistory(h.taskId)).length, 0)
})

test('extension records are attributed by the host and validate type and task references', async () => {
  const h = await setup()
  const id = await h.addTab('file', { fileName: 'x' })
  const input = {
    taskId: h.taskId,
    tabId: id,
    type: 'sample.action',
    label: 'Sample',
    title: 'Opened item',
    metadata: { itemId: 'abc' }
  }
  const entry = await h.api.record(input, 'sample')
  assert.equal(entry.extensionId, 'sample')
  assert.equal(entry.metadata.itemId, 'abc')
  await assert.rejects(h.api.record({ ...input, type: 'other.action' }, 'sample'), /extension ID/)
  await assert.rejects(
    h.api.record({ ...input, taskId: h.otherTask }, 'sample'),
    /not in that task/
  )
  await h.api.remove(h.otherTask, entry.id)
  assert.equal((await h.store.listHistory(h.taskId)).length, 1, 'deleting by ID stays task-scoped')
  await assert.rejects(
    h.api.record({ ...input, metadata: { large: 'x'.repeat(66000) } }, 'sample'),
    /64 KB/
  )
})

test('moving a selected tab records its next visit in the destination without moving earlier history', async () => {
  const h = await setup()
  const id = await h.addTab('terminal.shell', { cwd: '/project' })
  h.capture.visitTab(id, h.taskId)
  await h.flush()
  await postgres.query('UPDATE tabs SET task_id = $1 WHERE id = $2', [h.otherTask, id])
  h.capture.visitTab(id, h.otherTask)
  await h.flush()
  assert.equal((await h.store.listHistory(h.taskId)).length, 1)
  assert.equal((await h.store.listHistory(h.otherTask)).length, 1)
})

test('closed browser visits use cached icons for their original origin', async () => {
  const h = await setup()
  const icons = h.load('src/main/db/site-icons.ts')
  const favicon = 'data:image/png;base64,aGlzdG9yeQ=='
  await icons.putSiteIcon('https://history-icons.example', favicon)
  const tabId = await h.addTab('browser', { url: 'https://history-icons.example/article' })
  await h.store.insertHistory({
    taskId: h.taskId,
    tabId,
    type: 'browser',
    label: 'Web page',
    title: 'Remembered page',
    location: 'https://history-icons.example/article'
  })
  await h.store.insertHistory({
    taskId: h.taskId,
    type: 'browser',
    label: 'Web page',
    title: 'No icon',
    location: 'https://uncached-history.example/'
  })
  await postgres.query('DELETE FROM tabs WHERE id = $1', [tabId])
  const entries = await h.api.list({ taskId: h.taskId, query: '', limit: 100, offset: 0 })
  assert.equal(entries.find((entry) => entry.title === 'Remembered page').favicon, favicon)
  assert.equal(entries.find((entry) => entry.title === 'No icon').favicon, undefined)
})

test('file visits retain thumbnails after their tabs close', async () => {
  const h = await setup()
  const thumbnail = 'data:image/png;base64,cHJldmlldw=='
  const tabId = await h.addTab('file', {
    storageKey: 'example.png',
    fileName: 'example.png',
    mimeType: 'image/png',
    size: 123,
    thumbnail
  })
  h.capture.visitTab(tabId, h.taskId)
  await h.flush()
  await postgres.query('DELETE FROM tabs WHERE id = $1', [tabId])
  const [entry] = await h.store.listHistory(h.taskId)
  assert.equal(entry.metadata.thumbnail, thumbnail)
  assert.equal(entry.metadata.mimeType, 'image/png')
})

test('timeline groups local calendar days newest first, including DST and year boundaries', () => {
  const load = loader()
  const { historyDays, historyLocation } = load('src/renderer/src/lib/history-presentation.ts')
  const previousTimezone = process.env.TZ
  process.env.TZ = 'America/Toronto'
  try {
    const entries = [
      { id: 'old', visitedAt: new Date('2026-03-07T22:00:00-05:00') },
      { id: 'today', visitedAt: new Date('2026-03-09T00:05:00-04:00') },
      { id: 'late', visitedAt: new Date('2026-03-08T23:55:00-04:00') },
      { id: 'early', visitedAt: new Date('2026-03-08T00:05:00-05:00') }
    ]
    const groups = historyDays(entries, new Date('2026-03-09T00:10:00-04:00').getTime())
    assert.deepEqual(
      groups.map((day) => day.key),
      ['2026-03-09', '2026-03-08', '2026-03-07']
    )
    assert.deepEqual(
      groups.map((day) => day.label),
      ['Today', 'Yesterday', '']
    )
    assert.deepEqual(
      groups[1].visits.map(({ entry }) => entry.id),
      ['late', 'early']
    )
    assert.deepEqual(
      groups.flatMap((day) => day.visits.map(({ index }) => index)),
      [0, 1, 2, 3]
    )
    assert.equal(entries[0].id, 'old', 'grouping does not mutate source entries')
    const [yearEnd] = historyDays(
      [{ visitedAt: new Date('2025-12-31T23:50:00-05:00') }],
      new Date('2026-01-01T00:10:00-05:00').getTime()
    )
    assert.equal(yearEnd.label, 'Yesterday')
    assert.equal(yearEnd.key, '2025-12-31')
    assert.deepEqual(historyDays([], Date.now()), [])
    assert.equal(
      historyLocation({ type: 'browser', location: 'https://www.example.com/article' }),
      'example.com'
    )
    assert.equal(historyLocation({ type: 'browser', location: 'invalid URL' }), 'invalid URL')
    assert.equal(
      historyLocation({ type: 'terminal.shell', location: '/work/project' }),
      '/work/project'
    )
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

test('history reuses available icons from other visits on the same site', () => {
  const { historyFavicon } = loader()('src/renderer/src/lib/history-presentation.ts')
  const favicon = 'data:image/png;base64,aWNvbg=='
  const cached = 'data:image/png;base64,Y2FjaGU='
  const entry = { type: 'browser', location: 'https://github.com/old/page', tabId: 'closed' }
  const tab = {
    type: 'browser',
    id: 'open',
    payload: { url: 'https://github.com/new/page', favicon }
  }
  assert.equal(historyFavicon(entry, [tab]), favicon)
  assert.equal(historyFavicon({ ...entry, favicon: cached }, [tab]), cached)
  assert.equal(historyFavicon({ ...entry, favicon: cached }, [tab], [cached]), favicon)
  assert.equal(historyFavicon(entry, [tab], [favicon]), null)
  assert.equal(historyFavicon({ ...entry, favicon: cached }, [tab], [cached, favicon]), null)
  assert.equal(
    historyFavicon(entry, [{ ...tab, payload: { ...tab.payload, favicon: undefined } }]),
    null
  )
  assert.equal(historyFavicon({ ...entry, location: 'https://different.example/' }, [tab]), null)
  assert.equal(historyFavicon({ ...entry, location: 'not a URL' }, [tab]), null)
  assert.equal(historyFavicon({ ...entry, location: 'about:blank' }, [tab]), null)
  assert.equal(historyFavicon({ ...entry, type: 'file' }, [tab]), null)
  assert.equal(
    historyFavicon(entry, [
      { ...tab, payload: { ...tab.payload, favicon: 'https://remote.example/icon.png' } }
    ]),
    null
  )
})
