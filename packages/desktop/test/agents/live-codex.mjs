// Opt-in integration check using the installed, signed-in Codex CLI.
// Archives its test conversations after running in a temporary directory and uses a read-only MCP tool.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loader } from './load.mjs'
const load = loader()
const { CodexTransport } = load('extensions/codex/src/main/transport.ts')
const { codexExecutable } = load('extensions/codex/src/main/cli.ts')
const { createAgentMcpBridge } = load('packages/agent-core/src/main/mcp.ts')
const directory = await mkdtemp(join(tmpdir(), 'fluid-codex-live-'))
let calls = 0
let transport
let timer
const createdThreads = []
const bridge = await createAgentMcpBridge(
  [
    {
      name: 'list_tabs',
      description: 'Return the Fluid integration check value.',
      shape: {},
      run: async () => {
        calls++
        return { content: [{ type: 'text', text: 'FLUID_MCP_OK' }] }
      }
    }
  ],
  async () => false
)
try {
  const binary = await codexExecutable()
  let finish, fail
  const completed = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  // Install a rejection handler immediately, including during initialization.
  completed.catch(() => {})
  let result = ''
  const env = { ...process.env, FLUID_CODEX_MCP_TOKEN: bridge.token }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () =>
    new CodexTransport(
      binary,
      [
        'app-server',
        '-c',
        `mcp_servers.fluid.url=${JSON.stringify(bridge.url)}`,
        '-c',
        'mcp_servers.fluid.bearer_token_env_var="FLUID_CODEX_MCP_TOKEN"'
      ],
      directory,
      env,
      (message) => {
        if (message.id !== undefined) {
          transport.reject(message.id, 'No interactive approvals in this read-only check.')
          return
        }
        if (message.method === 'item/agentMessage/delta') result += message.params.delta
        if (message.method === 'turn/completed') finish(message.params.turn)
      },
      fail
    )
  transport = launch()
  timer = setTimeout(() => fail(new Error('Live Codex turn exceeded 120 seconds.')), 120_000)
  await transport.request('initialize', {
    clientInfo: { name: 'fluid_test', version: '0.1.0' },
    capabilities: { experimentalApi: true }
  })
  transport.notify('initialized')
  const account = await transport.request('account/read', { refreshToken: false })
  assert.ok(account.account || account.requiresOpenaiAuth === false, 'Run codex login first')
  const models = await transport.request('model/list', { limit: 100 })
  assert.ok(models.data.length)
  console.log('CLI initialization, authentication and model discovery passed.')
  const thread = await transport.request('thread/start', {
    cwd: directory,
    ephemeral: false,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    developerInstructions:
      'This is an integration check. Only call the fluid list_tabs tool. Do not use other tools or read local files.'
  })
  createdThreads.push(thread.thread.id)
  await transport.request('turn/start', {
    threadId: thread.thread.id,
    input: [
      {
        type: 'text',
        text: 'Call fluid list_tabs and reply with the exact check value it returns.'
      }
    ],
    cwd: directory,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false }
  })
  const turn = await completed
  assert.equal(turn.status, 'completed', turn.error?.message)
  assert.ok(calls > 0, 'The live agent must call the authenticated Fluid MCP bridge')
  assert.match(result, /FLUID_MCP_OK/)
  console.log('Live streaming turn and authenticated Fluid MCP tool call passed.')
  const fork = await transport.request('thread/fork', {
    threadId: thread.thread.id,
    beforeTurnId: turn.id,
    cwd: directory,
    deferGoalContinuation: true
  })
  createdThreads.push(fork.thread.id)
  assert.notEqual(fork.thread.id, thread.thread.id)
  assert.ok(!fork.thread.turns.some((item) => item.id === turn.id))
  transport.close()
  transport = launch()
  await transport.request('initialize', {
    clientInfo: { name: 'fluid_test', version: '0.1.0' },
    capabilities: { experimentalApi: true }
  })
  transport.notify('initialized')
  const resumed = await transport.request('thread/resume', {
    threadId: thread.thread.id,
    cwd: directory,
    approvalPolicy: 'never',
    sandbox: 'read-only'
  })
  let turns = resumed.thread.turns
  if (resumed.thread.historyMode === 'paginated')
    turns = (
      await transport.request('thread/turns/list', {
        threadId: thread.thread.id,
        sortDirection: 'asc',
        itemsView: 'full'
      })
    ).data
  assert.ok(turns.some((item) => item.items.some((message) => message.type === 'userMessage')))
  console.log('Fork-before-turn and history resume in a fresh CLI process passed.')
} finally {
  clearTimeout(timer)
  for (const threadId of createdThreads) {
    try {
      await transport?.request('thread/archive', { threadId }, 10_000)
    } catch {
      /* Best-effort cleanup of test-only conversations. */
    }
  }
  transport?.close()
  bridge.close()
  await rm(directory, { recursive: true, force: true })
}
