import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loader, root } from './agents/load.mjs'
const load = loader()
const { AgentTranscript } = load('packages/agent-core/src/views/lib/transcript.svelte.ts')
const { appendReplay } = load('packages/agent-core/src/main/replay.ts')
const { CodexEventMapper } = load('extensions/codex/src/main/events.ts')
const { CodexTransport } = load('extensions/codex/src/main/transport.ts')
const { createAttachmentStore } = load('packages/agent-core/src/main/attachments.ts')
const core = load('packages/agent-core/src/main/index.ts')
const until = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail('Timed out waiting for test state')
}

test('streaming and replay converge, including final corrections and late tool results', () => {
  const events = [
    { type: 'user', itemId: 'u', text: 'hello' },
    { type: 'user.anchor', itemId: 'u', uuid: 'turn' },
    { type: 'text.delta', itemId: 'a', kind: 'text', delta: 'Hel' },
    { type: 'text.delta', itemId: 'a', kind: 'text', delta: 'lo' },
    { type: 'text.set', itemId: 'a', kind: 'text', text: 'Hello!' },
    { type: 'item.started', item: { id: 'tool', title: 'Run', status: 'running' } },
    { type: 'item.completed', item: { id: 'tool', title: 'Run', status: 'ok' } },
    { type: 'item.completed', item: { id: 'tool', title: 'Run', status: 'ok', output: 'Done' } },
    { type: 'turn.completed', subtype: 'success' },
    { type: 'running', running: false }
  ]
  const live = new AgentTranscript()
  live.apply(events)
  const replay = []
  appendReplay(replay, events)
  const restored = new AgentTranscript()
  restored.apply(replay)
  const stable = (t) =>
    t.entries.map((entry) =>
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'at'))
    )
  assert.deepEqual(stable(restored), stable(live))
  assert.equal(live.entries.length, 3)
  assert.equal(restored.anchorFor(1).uuid, 'turn')
  assert.equal(restored.running, false)
  restored.reset()
  restored.apply(replay)
  assert.equal(restored.entries.length, 3, 'reattach replaces its snapshot')
})

test('approval queues resolve independently; async questions survive turn completion', () => {
  const state = new AgentTranscript()
  state.apply([
    { type: 'approval.opened', approval: { requestId: 'a' } },
    { type: 'approval.opened', approval: { requestId: 'b' } },
    { type: 'approval.resolved', requestId: 'a', decision: 'once' },
    { type: 'question.opened', requestId: 'q1', questions: [] },
    { type: 'question.opened', requestId: 'q2', questions: [], responseMode: 'message' }
  ])
  assert.equal(state.approval.requestId, 'b')
  state.apply([{ type: 'turn.completed', subtype: 'success' }])
  assert.equal(state.approval, null)
  assert.equal(state.question.requestId, 'q2')
})

test('Codex restores attachment tiles and maps authoritative final text and usage', () => {
  const mapper = new CodexEventMapper((path) =>
    path.startsWith('/uploads/') ? path.slice(9) : null
  )
  const [user] = mapper.item(
    {
      type: 'userMessage',
      id: 'u',
      content: [
        {
          type: 'text',
          text: 'Review\n\nAttached files (read these paths if needed):\n/uploads/tab/a.txt'
        },
        { type: 'localImage', path: '/uploads/tab/a.png' }
      ]
    },
    true,
    't',
    true
  )
  assert.equal(user.text, 'Review')
  assert.deepEqual(
    user.attachments.map((a) => a.name),
    ['a.png', 'a.txt']
  )
  assert.equal(user.uuid, 't')
  assert.equal(
    mapper.item({ type: 'agentMessage', id: 'a', text: 'Final' }, true)[0].type,
    'text.set'
  )
  assert.equal(
    mapper.notification('thread/tokenUsage/updated', {
      tokenUsage: { last: { totalTokens: 250 }, modelContextWindow: 1000 }
    })[0].context.usedPercent,
    25
  )
})

test('attachment stores are isolated and reject traversal, invalid escapes and symlinks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fluid-agent-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createAttachmentStore('codex-file', 'codex.session')
  store.setAttachmentsRoot(directory)
  const path = store.attachmentsDirectory('test-tab')
  await writeFile(join(path, 'a.png'), 'image')
  const serve = (key) => store.serveAttachment(new Request(`codex-file://attachments/${key}`))
  assert.equal((await serve('test-tab/a.png')).status, 200)
  assert.equal((await serve('%ZZ')).status, 404)
  assert.equal((await serve('test-tab/%2e%2e%2f%2e%2e%2foutside.png')).status, 404)
  await writeFile(join(directory, 'outside.png'), 'outside')
  await symlink(join(directory, 'outside.png'), join(path, 'link.png'))
  assert.equal((await serve('test-tab/link.png')).status, 404)
  assert.throws(() => store.attachmentsDirectory('../oops'))
  const other = createAttachmentStore('claude-code-file', 'claude-code.session')
  other.setAttachmentsRoot(join(directory, 'other'))
  assert.equal(other.attachmentKey(join(path, 'a.png')), null)
})

test('MCP bridge requires the per-session credential and asks before mutations', async (t) => {
  let called = 0
  let allow = false
  let asked = 0
  const bridge = await core.createAgentMcpBridge(
    [
      {
        name: 'change_something',
        description: 'test',
        shape: {},
        run: async () => {
          called++
          return { content: [{ type: 'text', text: 'done' }] }
        }
      }
    ],
    async () => {
      asked++
      return allow
    }
  )
  t.after(bridge.close)
  const send = (token, extra = {}) =>
    fetch(bridge.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        ...extra
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'change_something', arguments: {} }
      })
    })
  assert.equal((await send('wrong')).status, 401)
  assert.equal((await send(bridge.token, { Origin: 'https://example.com' })).status, 403)
  assert.equal((await (await send(bridge.token)).json()).result.isError, true)
  assert.equal(called, 0)
  allow = true
  assert.equal((await (await send(bridge.token)).json()).result.content[0].text, 'done')
  assert.equal(called, 1)
  assert.equal(asked, 2)
})

test('transport handles split UTF-8, out-of-order responses, rejection and clean close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fluid-codex-rpc-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const child = join(directory, 'child.cjs')
  await writeFile(
    child,
    `const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='first')setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:1})+'\\n'),30);
      if(m.method==='second'){
        process.stdout.write(JSON.stringify({id:m.id,result:2})+'\\n');
        const b=Buffer.from(JSON.stringify({method:'note',params:{text:'🌿'}})+'\\n');
        const at=b.indexOf(Buffer.from('🌿'))+2;process.stdout.write(b.subarray(0,at));setTimeout(()=>process.stdout.write(b.subarray(at)),5);
      }
      if(m.method==='bad')process.stdout.write(JSON.stringify({id:m.id,error:{message:'refused'}})+'\\n');
    });`
  )
  const messages = []
  const exits = []
  const transport = new CodexTransport(
    process.execPath,
    [child],
    directory,
    process.env,
    (m) => messages.push(m),
    (e) => exits.push(e)
  )
  t.after(() => transport.close())
  assert.deepEqual(
    await Promise.all([transport.request('first'), transport.request('second')]),
    [1, 2]
  )
  await until(() => messages.length)
  assert.equal(messages[0].params.text, '🌿')
  await assert.rejects(transport.request('bad'), /refused/)
  const pending = transport.request('hang')
  transport.close()
  await assert.rejects(pending, /closed/)
  assert.equal(exits.length, 0, 'intentional shutdown is not an unexpected exit')
})

test('transport timeout fails every pending call and refuses new work', async (t) => {
  const errors = []
  const transport = new CodexTransport(
    process.execPath,
    ['-e', 'process.stdin.resume()'],
    tmpdir(),
    process.env,
    () => {},
    (e) => errors.push(e)
  )
  t.after(() => transport.close())
  const first = assert.rejects(transport.request('hang', {}, 40), /did not answer/)
  const second = assert.rejects(transport.request('other'), /did not answer/)
  await Promise.all([first, second])
  assert.equal(errors.length, 1)
  await assert.rejects(transport.request('new'), /closed/)
})

function adapterHarness({ history = [], prompt, getTab, payload = {}, requestHook } = {}) {
  const processes = []
  const sent = []
  let tab = {
    id: 'test-tab',
    taskId: 'task',
    type: 'codex.session',
    title: null,
    payload: {
      cwd: '/project',
      ...(history.length ? { sessionId: 'thread' } : {}),
      ...(prompt ? { prompt } : {}),
      ...payload
    }
  }
  class FakeTransport {
    constructor(binary, args, cwd, env, receive, exited) {
      Object.assign(this, { receive, exited, cwd, args, env, calls: [], responses: [] })
      processes.push(this)
    }
    async request(method, params) {
      this.calls.push({ method, params })
      if (requestHook) {
        const result = await requestHook(method, params)
        if (result !== undefined) return result
      }
      if (this.handler) {
        const result = await this.handler(method, params)
        if (result !== undefined) return result
      }
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'thread', turns: history }, model: 'model' }
      if (method === 'model/list')
        return {
          data: [
            {
              id: 'model',
              model: 'model',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              defaultReasoningEffort: 'high'
            }
          ]
        }
      if (method === 'turn/start') {
        this.receive({
          method: 'turn/started',
          params: { threadId: 'thread', turn: { id: 'turn' } }
        })
        return { turn: { id: 'turn' } }
      }
      if (method === 'turn/interrupt')
        this.receive({
          method: 'turn/completed',
          params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } }
        })
      return {}
    }
    notify() {
      /* Initialization notification. */
    }
    respond(id, result) {
      this.responses.push({ id, result })
    }
    reject(id, error) {
      this.responses.push({ id, error })
    }
    close() {
      this.closed = true
    }
  }
  const create = loader({
    [join(root, 'extensions/codex/src/main/transport.ts')]: {
      ...load('extensions/codex/src/main/transport.ts'),
      CodexTransport: FakeTransport
    },
    [join(root, 'extensions/codex/src/main/cli.ts')]: { codexExecutable: async () => '/codex' },
    '@fluid/agent-core/main': {
      ...core,
      scopeOf: async () => null,
      createAgentMcpBridge: async () => ({
        url: 'http://127.0.0.1/mcp',
        token: 'test',
        close() {
          /* No socket in this test double. */
        }
      })
    }
  })('extensions/codex/src/main/sessions.ts').createCodexAdapter
  const storage = new Map()
  const ctx = {
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value)
    },
    api: {
      tabs: {
        get: async () => (getTab ? getTab(tab) : tab),
        update: async (patch) => {
          tab = { ...tab, ...patch }
          return tab
        },
        setActivity: async () => {}
      }
    }
  }
  const adapter = create(ctx, { attachmentKey: () => null })
  let attach
  const connection = {
    tabId: tab.id,
    connected: true,
    post: (message) => sent.push(message),
    onMessage: (handler) => {
      attach = handler
    },
    onDisconnect: () => {}
  }
  adapter.connect(connection)
  return {
    adapter,
    ctx,
    processes,
    sent,
    attach: () => attach({ type: 'attach' }),
    tab: () => tab,
    events: () => sent.flatMap((m) => (m.type === 'snapshot' ? m.replay : (m.events ?? [])))
  }
}

test('Codex opens in project cwd, streams, cancels, resumes and rejects stale approvals', async (t) => {
  const h = adapterHarness()
  t.after(() => h.adapter.dispose())
  h.attach()
  await until(() => h.sent.some((m) => m.type === 'snapshot'))
  let process = h.processes[0]
  assert.equal(process.cwd, '/project')
  assert.equal(h.tab().payload.sessionId, 'thread')
  await h.adapter.methods['session.send']({ tabId: 'test-tab', text: 'hello', attachments: [] })
  const turn = process.calls.find((c) => c.method === 'turn/start')
  assert.deepEqual(turn.params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: ['/project'],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  })
  process.receive({
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', command: 'echo hello' }
  })
  await until(() => h.events().some((e) => e.type === 'approval.opened'))
  const stale = h.events().find((e) => e.type === 'approval.opened').approval.requestId
  await h.adapter.methods['session.interrupt']({ tabId: 'test-tab' })
  process.exited(new Error('simulated crash'))
  const previous = h.sent.filter((m) => m.type === 'snapshot').length
  h.attach()
  await until(() => h.sent.filter((m) => m.type === 'snapshot').length > previous)
  process = h.processes[1]
  assert.ok(process.calls.some((c) => c.method === 'thread/resume'))
  process.receive({
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', command: 'echo new' }
  })
  assert.throws(
    () =>
      h.adapter.methods['session.respond']({
        tabId: 'test-tab',
        requestId: stale,
        decision: 'once'
      }),
    /no longer pending/
  )
  assert.equal(process.responses.length, 0)
})

test('stopping during tab lookup cannot resurrect a process', async (t) => {
  let release
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const h = adapterHarness({
    getTab: async (tab) => {
      await wait
      return tab
    }
  })
  t.after(() => h.adapter.dispose())
  h.attach()
  h.adapter.stop('test-tab')
  release()
  await until(() => h.sent.some((m) => m.type === 'failure'))
  assert.equal(h.processes.length, 0)
  h.attach()
  await until(() => h.sent.some((m) => m.type === 'snapshot'))
  assert.equal(h.processes.length, 1)
})

test('rejected turns roll back the optimistic message; an accepted turn is never retried for a metadata error', async (t) => {
  const h = adapterHarness()
  t.after(() => h.adapter.dispose())
  h.attach()
  await until(() => h.processes.length && h.sent.some((m) => m.type === 'snapshot'))
  h.processes[0].handler = async (method) => {
    if (method === 'turn/start') throw new Error('invalid model')
  }
  await assert.rejects(
    h.adapter.methods['session.send']({ tabId: 'test-tab', text: 'retry me', attachments: [] }),
    /invalid model/
  )
  await until(() => h.events().some((e) => e.type === 'user.removed'))
  h.attach()
  await delay(20)
  const last = h.sent.filter((m) => m.type === 'snapshot').at(-1)
  assert.ok(!last.replay.some((e) => e.type === 'user'))
  assert.equal(last.running, false)
  h.processes[0].handler = null
  h.ctx.api.tabs.update = async () => {
    throw new Error('metadata unavailable')
  }
  await h.adapter.methods['session.send']({ tabId: 'test-tab', text: 'accepted', attachments: [] })
  await until(() =>
    h.events().some((e) => e.type === 'notice' && e.message.includes('message was sent'))
  )
  assert.equal(h.processes[0].calls.filter((c) => c.method === 'turn/start').length, 2)
})

test('simultaneous views share one Codex process and both receive an authoritative snapshot', async (t) => {
  const h = adapterHarness()
  t.after(() => h.adapter.dispose())
  let attach
  const received = []
  h.adapter.connect({
    tabId: 'test-tab',
    connected: true,
    onMessage: (fn) => {
      attach = fn
    },
    post: (m) => received.push(m),
    onDisconnect: () => {}
  })
  h.attach()
  attach({ type: 'attach' })
  await until(
    () => h.sent.some((m) => m.type === 'snapshot') && received.some((m) => m.type === 'snapshot')
  )
  assert.equal(h.processes.length, 1)
  assert.deepEqual(
    received.find((m) => m.type === 'snapshot'),
    h.sent.find((m) => m.type === 'snapshot')
  )
})

test('both launchers create sessions in the current project folder', async () => {
  const { createAgentRenderer } = load('packages/agent-core/src/renderer/index.ts')
  const host = { api: { projects: { workingDirectory: async () => '/work/current-project' } } }
  for (const id of ['claude-code', 'codex']) {
    const renderer = createAgentRenderer({ id, name: id, icon: 'test' })
    assert.deepEqual(await renderer.launcher[0].open(host), {
      type: `${id}.session`,
      title: null,
      payload: { cwd: '/work/current-project' }
    })
    const task = await renderer.newTask[0].open('Review the changes', host)
    assert.equal(task.tabs[0].payload.prompt, 'Review the changes')
    assert.equal(task.tabs[0].payload.cwd, '/work/current-project')
  }
})

test('Claude history retains checkpoint IDs for fork and file-revert actions', () => {
  const { makeClaudeStream } = load('extensions/claude-code/src/main/events.ts')
  const stream = makeClaudeStream({ includeUserTurns: true })
  const events = stream.read({
    type: 'user',
    uuid: 'checkpoint',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'Change this function' }
  })
  assert.equal(events.find((e) => e.type === 'user').uuid, 'checkpoint')
})

test('shared Fluid tools refuse other projects and cannot close their own session', async () => {
  let reads = 0
  let closes = 0
  const api = {
    tasks: {
      get: async ({ id }) => ({ id, projectId: id === 'foreign' ? 'other-project' : 'project' })
    },
    tabs: {
      get: async ({ id }) => ({ id, taskId: 'task' }),
      list: async () => {
        reads++
        return []
      },
      close: async () => {
        closes++
      }
    }
  }
  const tools = core.workspaceTools(api, {
    tabId: 'test-tab',
    projectId: 'project',
    projectName: 'Project',
    projectRoot: '/project',
    cwd: '/project',
    agentTabTypes: []
  })
  const list = tools.find((t) => t.name === 'list_tabs')
  assert.equal((await list.run({ task_id: 'foreign' })).isError, true)
  assert.equal(reads, 0)
  await list.run({})
  assert.equal(reads, 1)
  assert.equal(
    (await tools.find((t) => t.name === 'close_tab').run({ tab_id: 'test-tab' })).isError,
    true
  )
  assert.equal(closes, 0)
})

test('asynchronous answers are stored so a dismissed question stays dismissed after reconnect', async (t) => {
  const history = [
    {
      id: 'old-turn',
      status: 'completed',
      items: [
        {
          type: 'agentMessage',
          id: 'question-item',
          text: 'Which path?',
          delivery: 'async',
          questions: [{ id: 'q', question: 'Which path?', options: [] }]
        }
      ]
    }
  ]
  const h = adapterHarness({ history })
  t.after(() => h.adapter.dispose())
  h.attach()
  await until(() => h.sent.some((m) => m.type === 'snapshot'))
  const id = h.events().find((e) => e.type === 'question.opened').requestId
  await h.adapter.methods['session.answer']({ tabId: 'test-tab', requestId: id, answers: null })
  assert.ok(h.tab().payload.resolvedQuestions.includes(id))
  h.adapter.stop('test-tab')
  const count = h.sent.filter((m) => m.type === 'snapshot').length
  h.attach()
  await until(() => h.sent.filter((m) => m.type === 'snapshot').length > count)
  assert.ok(
    !h.sent
      .filter((m) => m.type === 'snapshot')
      .at(-1)
      .replay.some((e) => e.type === 'question.opened')
  )
})

test('closing a parent keeps its attachments while a fork still references them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fluid-agent-fork-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createAttachmentStore('codex-file', 'codex.session')
  store.setAttachmentsRoot(directory)
  const parent = store.attachmentsDirectory('parent')
  await writeFile(join(parent, 'a.png'), 'image')
  let tabs = [{ id: 'child', type: 'codex.session', payload: { attachmentTabs: ['parent'] } }]
  const api = {
    projects: { list: async () => [{ id: 'project' }] },
    tasks: { list: async () => [{ id: 'task' }] },
    tabs: { list: async () => tabs }
  }
  await store.pruneAttachments(api)
  await access(join(parent, 'a.png'))
  tabs = []
  await store.pruneAttachments(api)
  await assert.rejects(access(parent), { code: 'ENOENT' })
})

test('an unused Codex tab recovers from its unmaterialized rollout on restart', async (t) => {
  const h = adapterHarness({
    requestHook: async (method) => {
      if (method === 'thread/resume') throw new Error('no rollout found for thread id thread')
    }
  })
  t.after(() => h.adapter.dispose())
  h.attach()
  await until(() => h.sent.some((m) => m.type === 'snapshot'))
  assert.equal(h.tab().payload.resumePending, true)
  h.adapter.stop('test-tab')
  const count = h.sent.filter((m) => m.type === 'snapshot').length
  h.attach()
  await until(() => h.sent.filter((m) => m.type === 'snapshot').length > count)
  assert.ok(h.processes[1].calls.some((c) => c.method === 'thread/start'))
  await h.adapter.methods['session.send']({
    tabId: 'test-tab',
    text: 'first message',
    attachments: []
  })
  assert.equal(h.tab().payload.resumePending, false)
})

test('a missing established Codex conversation never silently becomes a new one', async (t) => {
  const h = adapterHarness({
    payload: { sessionId: 'saved', resumePending: false },
    requestHook: async (method) => {
      if (method === 'thread/resume') throw new Error('no rollout found for thread id saved')
    }
  })
  t.after(() => h.adapter.dispose())
  h.attach()
  await until(() => h.sent.some((m) => m.type === 'failure'))
  assert.ok(!h.processes[0].calls.some((c) => c.method === 'thread/start'))
})
