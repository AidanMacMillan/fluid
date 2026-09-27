import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { ExtensionContext, ViewConnection, TabActivity } from '@fluid/sdk'
import type {
  AgentEvent,
  AgentModel,
  AgentTabPayload,
  AgentUpload,
  AgentDecision,
  AgentQuestion,
  AgentToView
} from '@fluid/agent-core'
import { imageTypeFor, supportsFile } from '@fluid/agent-core'
import {
  appendReplay,
  createAgentMcpBridge,
  scopeOf,
  describeScope,
  workspaceTools,
  type AgentAdapter,
  type AttachmentStore,
  type AgentTool
} from '@fluid/agent-core/main'
import { codexProvider } from '../shared/provider'
import { codexExecutable } from './cli'
import { CodexTransport, object, array, string, type RpcId, type RpcMessage } from './transport'
import { CodexEventMapper, questionsFrom, usageEvents } from './events'

type CodexPayload = AgentTabPayload & { resolvedQuestions?: string[]; resumePending?: boolean }
type Pending = {
  kind: 'approval' | 'question'
  rpcId?: RpcId
  method: string
  params: Record<string, unknown>
  questions?: AgentQuestion[]
  settle?: (allow: boolean) => void
  busy?: boolean
}
type Session = {
  tabId: string
  generation: string
  payload: CodexPayload
  ready: Promise<void>
  transport?: CodexTransport
  bridge?: Awaited<ReturnType<typeof createAgentMcpBridge>>
  mapper: CodexEventMapper
  threadId: string
  turnId: string | null
  running: boolean
  stopped: boolean
  exit: string | null
  replay: AgentEvent[]
  outgoing: AgentEvent[]
  flush?: ReturnType<typeof setTimeout>
  views: Set<ViewConnection>
  pending: Map<string, Pending>
  models: AgentModel[]
  currentModel: string
  queue: Promise<unknown>
  writes: Promise<unknown>
  activity: Promise<unknown>
  optimisticId?: string
  initial: boolean
  buffered: RpcMessage[]
  sessionAllows: Set<string>
}
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const policy = (mode: string | undefined): { approvalPolicy: string; sandbox: string } =>
  mode === 'full'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : {
        approvalPolicy: 'on-request',
        sandbox: mode === 'read-only' ? 'read-only' : 'workspace-write'
      }

export function createCodexAdapter(ctx: ExtensionContext, files: AttachmentStore): AgentAdapter {
  const sessions = new Map<string, Session>()
  const generations = new Map<string, symbol>()
  let disposed = false
  const post = (s: Session, message: AgentToView): void => {
    for (const view of s.views) view.post(message)
  }
  const flush = (s: Session): void => {
    clearTimeout(s.flush)
    s.flush = undefined
    if (s.outgoing.length) {
      const events = s.outgoing
      s.outgoing = []
      post(s, { type: 'events', events })
    }
  }
  const record = (s: Session, events: AgentEvent[]): void => {
    if (s.stopped || !events.length) return
    appendReplay(s.replay, events)
    s.outgoing.push(...events)
    s.flush ??= setTimeout(() => flush(s), 16)
  }
  const activity = (s: Session, value: TabActivity | null): void => {
    s.activity = s.activity
      .then(async () => {
        if (!s.stopped) await ctx.api.tabs.setActivity({ id: s.tabId, activity: value })
      })
      .catch((error) => console.error('Codex tab activity:', reason(error)))
  }
  const mark = (s: Session): void =>
    activity(
      s,
      s.running
        ? [...s.pending.values()].some((p) => p.method !== 'async')
          ? 'waiting'
          : 'working'
        : 'done'
    )
  const running = (s: Session, value: boolean): void => {
    s.running = value
    record(s, [{ type: 'running', running: value }])
    mark(s)
  }
  const update = (s: Session, change: Partial<CodexPayload>, title?: string): Promise<void> => {
    const work = s.writes.then(async () => {
      if (s.stopped) return
      const tab = await ctx.api.tabs.get({ id: s.tabId })
      if (!tab || tab.type !== 'codex.session') throw new Error('This Codex tab no longer exists.')
      s.payload = { ...s.payload, ...change }
      await ctx.api.tabs.update({
        id: s.tabId,
        payload: s.payload,
        ...(title !== undefined ? { title } : {})
      })
    })
    s.writes = work.catch(() => {})
    return work
  }
  const clearPending = (s: Session, includeAsync = false): void => {
    for (const [id, pending] of s.pending) {
      if (!includeAsync && pending.method === 'async') continue
      s.pending.delete(id)
      pending.settle?.(false)
      record(s, [
        pending.kind === 'approval'
          ? { type: 'approval.resolved', requestId: id, decision: 'cancel' }
          : { type: 'question.resolved', requestId: id }
      ])
    }
  }
  const failed = (s: Session, error: unknown): void => {
    if (s.stopped || s.exit) return
    s.exit = reason(error)
    s.running = false
    clearPending(s, true)
    record(s, [{ type: 'running', running: false }])
    flush(s)
    s.bridge?.close()
    s.transport?.close()
    activity(s, null)
    post(s, { type: 'exit', error: s.exit })
  }
  const stop = (tabId: string): void => {
    generations.delete(tabId)
    const s = sessions.get(tabId)
    if (!s) return
    sessions.delete(tabId)
    clearPending(s, true)
    s.stopped = true
    clearTimeout(s.flush)
    s.bridge?.close()
    s.transport?.close()
    s.views.clear()
  }
  const request = async (s: Session, method: string, params: unknown = {}): Promise<unknown> => {
    if (!s.transport || s.stopped || s.exit)
      throw new Error(s.exit || 'The Codex session is not connected.')
    return s.transport.request(method, params)
  }
  const emitPending = (s: Session, id: string, p: Pending): void => {
    if (p.kind === 'question')
      record(s, [
        {
          type: 'question.opened',
          requestId: id,
          questions: p.questions ?? [],
          responseMode: p.method === 'async' ? 'message' : 'blocking'
        }
      ])
    else {
      const available = array(p.params.availableDecisions)
      const allowAlways =
        p.method === 'fluid' ||
        p.method === 'item/permissions/requestApproval' ||
        ((!available.length || available.includes('acceptForSession')) &&
          !p.method.startsWith('mcpServer/'))
      record(s, [
        {
          type: 'approval.opened',
          approval: {
            requestId: id,
            toolUseId: string(p.params.itemId) || id,
            toolName: p.method,
            kind: p.method.includes('command')
              ? 'command'
              : p.method.includes('file')
                ? 'file-change'
                : 'tool',
            title:
              string(p.params.title) ||
              `Codex requests ${p.method.includes('command') ? 'permission to run a command' : p.method.includes('file') ? 'permission to change files' : 'additional access'}`,
            input: p.params,
            description:
              string(p.params.reason) ||
              string(p.params.message) ||
              (p.params.permissions ? JSON.stringify(p.params.permissions, null, 2) : undefined),
            allowAlways,
            defaultToNo: true
          }
        }
      ])
    }
    mark(s)
  }
  const receive = (s: Session, message: RpcMessage): void => {
    if (s.stopped || s.exit) return
    if (s.initial) {
      s.buffered.push(message)
      return
    }
    const p = object(message.params)
    const method = message.method ?? ''
    if (p.threadId && p.threadId !== s.threadId) return
    if (message.id !== undefined) {
      const id = `${s.generation}:${String(message.id)}`
      let pending: Pending
      if (method === 'item/tool/requestUserInput')
        pending = {
          kind: 'question',
          rpcId: message.id,
          method,
          params: p,
          questions: questionsFrom(p.questions)
        }
      else if (
        [
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval'
        ].includes(method)
      )
        pending = { kind: 'approval', rpcId: message.id, method, params: p }
      else if (method === 'mcpServer/elicitation/request') {
        // Do not silently accept forms or auth URLs that this MVP cannot render.
        s.transport?.respond(message.id, { action: 'decline', content: null })
        record(s, [
          {
            type: 'notice',
            level: 'warning',
            message:
              'An MCP server requested a form or sign-in that this view does not support. Configure that server in Codex CLI, then retry.'
          }
        ])
        return
      } else {
        s.transport?.reject(message.id, `Fluid does not support ${method}.`)
        return
      }
      s.pending.set(id, pending)
      emitPending(s, id, pending)
      return
    }
    if (method === 'serverRequest/resolved') {
      const id = `${s.generation}:${String(p.requestId)}`
      const pending = s.pending.get(id)
      if (pending) {
        s.pending.delete(id)
        record(s, [
          pending.kind === 'approval'
            ? { type: 'approval.resolved', requestId: id, decision: 'cancel' }
            : { type: 'question.resolved', requestId: id }
        ])
        mark(s)
      }
      return
    }
    if (method === 'turn/started') {
      s.turnId = string(object(p.turn).id)
      if (s.optimisticId)
        record(s, [{ type: 'user.anchor', itemId: s.optimisticId, uuid: s.turnId }])
      running(s, true)
    }
    if (method === 'turn/completed') {
      const turn = object(p.turn)
      if (s.turnId && string(turn.id) !== s.turnId) return
      clearPending(s)
      s.turnId = null
      s.optimisticId = undefined
      const status = string(turn.status)
      record(s, [
        {
          type: 'turn.completed',
          subtype: status === 'completed' ? 'success' : status || 'success'
        }
      ])
      const error = string(object(turn.error).message)
      if (error) record(s, [{ type: 'notice', level: 'error', message: error }])
      running(s, false)
    }
    const events = s.mapper.notification(method, p)
    for (const event of events) {
      if (event.type === 'question.opened')
        s.pending.set(event.requestId, {
          kind: 'question',
          method: 'async',
          params: {},
          questions: event.questions
        })
      if (event.type === 'title') void update(s, {}, event.title).catch((error) => failed(s, error))
    }
    record(s, events)
  }
  const authorize = (
    s: Session,
    tool: AgentTool,
    input: Record<string, unknown>
  ): Promise<boolean> => {
    if (s.stopped || s.exit) return Promise.resolve(false)
    if (s.payload.permissionMode === 'full' || s.sessionAllows.has(tool.name))
      return Promise.resolve(true)
    const id = `fluid:${randomUUID()}`
    return new Promise((resolve) => {
      const p: Pending = {
        kind: 'approval',
        method: 'fluid',
        params: {
          ...input,
          title: `Codex wants to ${tool.name.replaceAll('_', ' ')} in Fluid`,
          tool: tool.name,
          reason: JSON.stringify(input, null, 2)
        },
        settle: resolve
      }
      s.pending.set(id, p)
      emitPending(s, id, p)
    })
  }
  const modelList = async (s: Session): Promise<AgentModel[]> => {
    const list: AgentModel[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const response = object(
        await request(s, 'model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
      )
      for (const raw of array(response.data)) {
        const m = object(raw)
        const id = string(m.model) || string(m.id)
        if (!id) continue
        const efforts = array(m.supportedReasoningEfforts)
          .map((e) => string(object(e).reasoningEffort))
          .filter(Boolean)
        list.push({
          id,
          resolved: id,
          label: string(m.displayName) || id,
          description: string(m.description),
          supportsEffort: efforts.length > 0,
          efforts,
          defaultEffort: string(m.defaultReasoningEffort) || undefined
        })
      }
      cursor = string(response.nextCursor) || undefined
      if (cursor && seen.has(cursor))
        throw new Error('Codex returned a repeated model-list cursor.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return list
  }
  const restore = async (s: Session, thread: Record<string, unknown>): Promise<void> => {
    let turns = array(thread.turns)
    if (thread.historyMode === 'paginated') {
      turns = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = object(
          await request(s, 'thread/turns/list', {
            threadId: s.threadId,
            sortDirection: 'asc',
            limit: 100,
            itemsView: 'full',
            ...(cursor ? { cursor } : {})
          })
        )
        turns.push(...array(page.data))
        cursor = string(page.nextCursor) || undefined
        if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeated history cursor.')
        if (cursor) seen.add(cursor)
      } while (cursor)
    }
    for (const raw of turns) {
      const turn = object(raw)
      for (const item of array(turn.items))
        record(
          s,
          s.mapper
            .item(item, true, string(turn.id), true)
            .filter(
              (e) =>
                e.type !== 'question.opened' || !s.payload.resolvedQuestions?.includes(e.requestId)
            )
        )
      record(s, [
        { type: 'turn.completed', subtype: turn.status === 'failed' ? 'failed' : 'success' }
      ])
    }
    // Resolve old asynchronous questions through explicit user action; their
    // answers are messages, not dead RPC callbacks from a previous process.
    for (const event of s.replay)
      if (event.type === 'question.opened' && event.responseMode === 'message')
        s.pending.set(event.requestId, {
          kind: 'question',
          method: 'async',
          params: {},
          questions: event.questions
        })
  }
  const start = async (s: Session): Promise<void> => {
    const binary = await codexExecutable()
    if (s.stopped || disposed) return
    const scope = await scopeOf(ctx.api, s.tabId, s.payload.cwd)
    if (s.stopped || disposed) return
    s.bridge = await createAgentMcpBridge(
      scope ? workspaceTools(ctx.api, scope) : [],
      (tool, input) => authorize(s, tool, input)
    )
    if (s.stopped || disposed) {
      s.bridge.close()
      return
    }
    const args = [
      'app-server',
      '-c',
      `mcp_servers.fluid.url=${JSON.stringify(s.bridge.url)}`,
      '-c',
      'mcp_servers.fluid.bearer_token_env_var="FLUID_CODEX_MCP_TOKEN"'
    ]
    const environment: NodeJS.ProcessEnv = { ...process.env, FLUID_CODEX_MCP_TOKEN: s.bridge.token }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.NODE_OPTIONS
    s.transport = new CodexTransport(
      binary,
      args,
      s.payload.cwd,
      environment,
      (message) => receive(s, message),
      (error) => failed(s, error)
    )
    await request(s, 'initialize', {
      clientInfo: { name: 'fluid', title: 'Fluid', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    })
    s.transport.notify('initialized')
    const account = object(await request(s, 'account/read', { refreshToken: false }))
    if (!account.account && account.requiresOpenaiAuth !== false)
      throw new Error('Codex is not signed in. Run “codex login” in Terminal, then click Retry.')
    const params = {
      cwd: s.payload.cwd,
      approvalsReviewer: 'user',
      ...policy(s.payload.permissionMode),
      ...(s.payload.model ? { model: s.payload.model } : {}),
      developerInstructions: [
        "You are running inside a Fluid project tab. Use the fluid MCP tools for Fluid tasks and tabs; never access Fluid's database directly.",
        ...(scope ? describeScope(scope) : [])
      ].join('\n')
    }
    let resumed = Boolean(s.payload.sessionId)
    let result: Record<string, unknown>
    try {
      result = object(
        await request(s, resumed ? 'thread/resume' : 'thread/start', {
          ...params,
          ...(resumed ? { threadId: s.payload.sessionId } : {})
        })
      )
    } catch (error) {
      // thread/start allocates an ID before Codex creates its rollout file.
      // Only a known, not-yet-materialized conversation may become a new one.
      if (
        !resumed ||
        !s.payload.resumePending ||
        !reason(error).includes('no rollout found for thread id')
      )
        throw error
      resumed = false
      result = object(await request(s, 'thread/start', params))
    }
    const thread = object(result.thread)
    s.threadId = string(thread.id)
    if (!s.threadId) throw new Error('Codex did not return a conversation ID.')
    s.currentModel = string(result.model) || s.payload.model || ''
    if (resumed) await restore(s, thread)
    await update(s, {
      sessionId: s.threadId,
      resumePending: !resumed,
      ...(!s.payload.effort && string(result.reasoningEffort)
        ? { effort: string(result.reasoningEffort) }
        : {})
    })
    record(s, [
      {
        type: 'session',
        sessionId: s.threadId,
        model: s.currentModel,
        cwd: s.payload.cwd,
        permissionMode: s.payload.permissionMode ?? codexProvider.defaultMode,
        slashCommands: [],
        version: '',
        apiKeySource: object(account.account).type === 'apiKey' ? 'Codex API key' : 'none'
      }
    ])
    if (typeof thread.name === 'string' && thread.name) {
      record(s, [{ type: 'title', title: thread.name }])
      await update(s, {}, thread.name)
    }
    s.initial = false
    for (const message of s.buffered.splice(0)) receive(s, message)
    // A new view receives an authoritative state even if history ended mid-turn.
    if (!s.turnId) running(s, false)
    s.models = await modelList(s)
    try {
      record(s, usageEvents(await request(s, 'account/rateLimits/read')))
    } catch (error) {
      if (s.exit) throw error
    }
    if (s.payload.prompt && !s.replay.some((e) => e.type === 'user'))
      await send(s, s.payload.prompt, [])
    else if (s.payload.prompt) await update(s, { prompt: undefined })
  }
  const open = async (tabId: string): Promise<Session> => {
    let s = sessions.get(tabId)
    if (s?.exit) {
      stop(tabId)
      s = undefined
    }
    if (!s) {
      const generation = generations.get(tabId) ?? Symbol(tabId)
      generations.set(tabId, generation)
      const tab = await ctx.api.tabs.get({ id: tabId })
      if (generations.get(tabId) !== generation) throw new Error('This session was stopped.')
      if (disposed || !tab || tab.type !== 'codex.session')
        throw new Error('This Codex tab no longer exists.')
      // The tab read can race a second view's attach.
      s = sessions.get(tabId)
      if (!s) {
        s = {
          tabId,
          generation: randomUUID(),
          payload: tab.payload as CodexPayload,
          ready: Promise.resolve(),
          mapper: new CodexEventMapper(files.attachmentKey),
          threadId: '',
          turnId: null,
          running: false,
          stopped: false,
          exit: null,
          replay: [],
          outgoing: [],
          views: new Set(),
          pending: new Map(),
          models: [],
          currentModel: '',
          queue: Promise.resolve(),
          writes: Promise.resolve(),
          activity: Promise.resolve(),
          initial: true,
          buffered: [],
          sessionAllows: new Set()
        }
        sessions.set(tabId, s)
        const created = s
        s.ready = start(s).catch((error) => {
          failed(created, error)
          throw error
        })
      }
    }
    await s.ready
    if (s.stopped || s.exit) throw new Error(s.exit || 'This session was stopped.')
    return s
  }
  const requireSession = (tabId: string): Session => {
    const s = sessions.get(tabId)
    if (!s || s.stopped || s.exit || s.initial)
      throw new Error(s?.exit || 'Reconnect the Codex tab before sending.')
    return s
  }
  const serial = <T>(s: Session, work: () => Promise<T>): Promise<T> => {
    const result = s.queue.then(() => {
      if (s.stopped || s.exit) throw new Error(s.exit || 'This session was stopped.')
      return work()
    })
    s.queue = result.catch(() => {})
    return result
  }
  const send = async (s: Session, text: string, uploads: AgentUpload[]): Promise<void> => {
    if (s.running) throw new Error('Wait for Codex to finish, or stop the current turn.')
    const input: Record<string, unknown>[] = []
    const saved: { name: string; key: string }[] = []
    const paths: string[] = []
    for (const upload of uploads) {
      if (!supportsFile(upload.name)) throw new Error(`Unsupported attachment: ${upload.name}`)
      const name = basename(upload.name).replace(/[/\\]/g, '-').slice(0, 120) || 'attachment'
      const directory = join(files.attachmentsDirectory(s.tabId), randomUUID())
      await mkdir(directory, { recursive: true })
      const path = join(directory, name)
      await writeFile(path, Buffer.from(upload.data, 'base64'), { flag: 'wx' })
      const key = files.attachmentKey(path)
      if (key) saved.push({ name, key })
      if (imageTypeFor(name)) input.push({ type: 'localImage', path })
      else paths.push(path)
    }
    const body = paths.length
      ? `${text}\n\nAttached files (read these paths if needed):\n${paths.join('\n')}`
      : text
    if (body.trim()) input.unshift({ type: 'text', text: body })
    const id = randomUUID()
    s.optimisticId = id
    record(s, [{ type: 'user', itemId: id, text, ...(saved.length ? { attachments: saved } : {}) }])
    running(s, true)
    try {
      const permissions = policy(s.payload.permissionMode)
      const sandboxPolicy =
        permissions.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : permissions.sandbox === 'read-only'
            ? { type: 'readOnly', networkAccess: false }
            : {
                type: 'workspaceWrite',
                writableRoots: [s.payload.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false
              }
      const response = object(
        await request(s, 'turn/start', {
          threadId: s.threadId,
          input,
          cwd: s.payload.cwd,
          approvalPolicy: permissions.approvalPolicy,
          sandboxPolicy,
          ...(s.payload.model ? { model: s.payload.model } : {}),
          ...(s.payload.effort ? { effort: s.payload.effort } : {})
        })
      )
      const turnId = string(object(response.turn).id)
      if (s.running && turnId) s.turnId = turnId
      if (turnId) record(s, [{ type: 'user.anchor', itemId: id, uuid: turnId }])
    } catch (error) {
      if (!s.exit && !s.turnId) record(s, [{ type: 'user.removed', itemId: id }])
      running(s, false)
      throw error
    }
    // Once turn/start succeeds, a metadata failure must not restore the draft
    // and invite submission of the same prompt twice.
    try {
      if (s.payload.prompt || s.payload.resumePending)
        await update(s, { prompt: undefined, resumePending: false })
      const tab = await ctx.api.tabs.get({ id: s.tabId })
      if (tab && !tab.title) await update(s, {}, text.trim().slice(0, 70) || 'Attached files')
    } catch (error) {
      record(s, [
        {
          type: 'notice',
          level: 'warning',
          message: `The message was sent, but tab details could not be saved: ${reason(error)}`
        }
      ])
    }
  }
  const respond = (s: Session, id: string, decision: AgentDecision): void => {
    const p = s.pending.get(id)
    if (!p || p.kind !== 'approval') throw new Error('This approval is no longer pending.')
    if (p.method === 'fluid') {
      if (decision === 'always') s.sessionAllows.add(string(p.params.tool))
      p.settle?.(decision === 'once' || decision === 'always')
    } else if (p.rpcId !== undefined) {
      if (p.method === 'item/permissions/requestApproval')
        s.transport!.respond(p.rpcId, {
          permissions:
            decision === 'once' || decision === 'always'
              ? Object.fromEntries(
                  Object.entries(object(p.params.permissions)).filter(([, value]) => value != null)
                )
              : {},
          scope: decision === 'always' ? 'session' : 'turn'
        })
      else {
        const native = {
          once: 'accept',
          always: 'acceptForSession',
          deny: 'decline',
          cancel: 'cancel'
        }[decision]
        const available = array(p.params.availableDecisions)
        if (available.length && !available.includes(native))
          throw new Error('That approval choice is not offered by Codex.')
        s.transport!.respond(p.rpcId, { decision: native })
      }
    }
    s.pending.delete(id)
    record(s, [{ type: 'approval.resolved', requestId: id, decision }])
    mark(s)
  }
  const answer = async (
    s: Session,
    id: string,
    answers: Record<string, string> | null
  ): Promise<void> => {
    const p = s.pending.get(id)
    if (!p || p.kind !== 'question' || p.busy)
      throw new Error('This question is no longer available.')
    p.busy = true
    try {
      if (p.method === 'async') {
        if (answers) {
          const text = (p.questions ?? [])
            .map((q) => `${q.question}\n${answers[q.id ?? q.question] ?? ''}`)
            .join('\n\n')
          if (s.running && s.turnId) {
            await request(s, 'turn/steer', {
              threadId: s.threadId,
              expectedTurnId: s.turnId,
              input: [{ type: 'text', text }]
            })
            record(s, [{ type: 'user', itemId: randomUUID(), text, uuid: s.turnId }])
          } else await serial(s, () => send(s, text, []))
        }
      } else if (p.rpcId !== undefined) {
        const response: Record<string, { answers: string[] }> = {}
        for (const q of p.questions ?? []) {
          const key = q.id ?? q.question
          response[key] = { answers: answers?.[key] ? [answers[key]!] : [] }
        }
        s.transport!.respond(p.rpcId, { answers: response })
      }
      if (p.method === 'async')
        await update(s, {
          resolvedQuestions: [...new Set([...(s.payload.resolvedQuestions ?? []), id])]
        }).catch((error) =>
          record(s, [
            {
              type: 'notice',
              level: 'warning',
              message: `The answer was handled, but its saved status could not be updated: ${reason(error)}`
            }
          ])
        )
      s.pending.delete(id)
      record(s, [{ type: 'question.resolved', requestId: id }])
      mark(s)
    } finally {
      p.busy = false
    }
  }
  return {
    connect(connection) {
      let attaching = false
      connection.onMessage((raw) => {
        if (object(raw).type !== 'attach' || attaching) return
        attaching = true
        void open(connection.tabId)
          .then((s) => {
            if (!connection.connected) return
            flush(s)
            connection.post({
              type: 'snapshot',
              replay: [...s.replay],
              exit: s.exit ? { error: s.exit } : null,
              running: s.running
            } satisfies AgentToView)
            s.views.add(connection)
            connection.onDisconnect(() => s.views.delete(connection))
          })
          .catch((error) => {
            if (connection.connected) connection.post({ type: 'failure', message: reason(error) })
          })
          .finally(() => {
            attaching = false
          })
      })
    },
    stop,
    dispose() {
      disposed = true
      for (const id of sessions.keys()) stop(id)
    },
    methods: {
      'session.send': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, () => send(s, i.text, i.attachments))
      },
      'session.interrupt': async (i) => {
        const s = requireSession(i.tabId)
        if (!s.running) return
        // A turn/start acknowledgement may still be in flight. Queue cancellation
        // after it, but never queue an approval response behind a running turn.
        await serial(s, async () => {
          if (s.turnId && s.running)
            await request(s, 'turn/interrupt', { threadId: s.threadId, turnId: s.turnId })
        })
      },
      'session.respond': (i) => respond(requireSession(i.tabId), i.requestId, i.decision),
      'session.answer': (i) => answer(requireSession(i.tabId), i.requestId, i.answers),
      'session.models': (i) => requireSession(i.tabId).models,
      'session.setModel': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, async () => {
          const model = s.models.find((m) => m.id === i.model)
          if (!model) throw new Error('This Codex model is unavailable.')
          await update(s, {
            model: i.model,
            ...(s.payload.effort && !model.efforts?.includes(s.payload.effort)
              ? { effort: model.defaultEffort }
              : {})
          })
        })
      },
      'session.setEffort': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, async () => {
          const model = s.models.find((m) => m.id === (s.payload.model || s.currentModel))
          if (!model?.efforts?.includes(i.effort))
            throw new Error('This model does not support that reasoning effort.')
          await update(s, { effort: i.effort })
        })
      },
      'session.setMode': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, async () => {
          if (s.running) throw new Error('Stop the current turn before changing permissions.')
          s.sessionAllows.clear()
          await update(s, { permissionMode: i.mode })
        })
      },
      'session.rename': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, async () => {
          const title = i.title.trim()
          if (!title) throw new Error('Enter a conversation name.')
          await request(s, 'thread/name/set', { threadId: s.threadId, name: title })
          await update(s, {}, title)
          record(s, [{ type: 'title', title }])
        })
      },
      'session.revert': () => ({
        ok: false,
        error: 'Codex file checkpoints are not available in shared project folders.'
      }),
      'session.fork': (i) => {
        const s = requireSession(i.tabId)
        return serial(s, async () => {
          if (s.running) return 'Stop the current turn before forking.'
          const response = object(
            await request(s, 'thread/fork', {
              threadId: s.threadId,
              beforeTurnId: i.uuid,
              deferGoalContinuation: true,
              cwd: s.payload.cwd
            })
          )
          const id = string(object(response.thread).id)
          if (!id) throw new Error('Codex did not return the forked conversation.')
          const tab = await ctx.api.tabs.get({ id: s.tabId })
          if (!tab || s.stopped) throw new Error('This tab no longer exists.')
          const branch = await ctx.api.tabs.open({
            taskId: tab.taskId,
            tab: {
              type: 'codex.session',
              title: null,
              payload: {
                ...s.payload,
                sessionId: id,
                prompt: undefined,
                attachmentTabs: [...new Set([...(s.payload.attachmentTabs ?? []), s.tabId])]
              }
            }
          })
          await ctx.api.tabs.update({ id: branch.id, viewState: { draft: i.draft } })
          await ctx.api.ui.reveal({ taskId: tab.taskId, tabId: branch.id })
          return null
        })
      }
    }
  }
}
