import { z } from 'zod'
import {
  createClient,
  type BookmarkContribution,
  type Disposable,
  type Extension,
  type ExtensionContext,
  type ScheduledJob,
  type TabMenuItem,
  type TabTypeContribution,
  type TaskTypeContribution,
  type ViewConnection,
  type WorkspaceEvent
} from '@fluid/sdk'
import type {
  ActivateContext,
  FetchResponse,
  HostCall,
  PageRequest,
  ProtocolResponse,
  Registration,
  RegistrationId,
  SecretSnapshot,
  TabMenuItemData,
  TaskActionData
} from '../../main/extensions/isolation/protocol'

/**
 * The page an installed extension's main half runs in: hidden, sandboxed, and
 * with no Node. See src/main/extensions/isolation/proxy.ts for the other side.
 *
 * This page is the app's, and builds the `ExtensionContext` the extension is
 * given out of requests to the main process, then imports the extension's
 * module and activates it. Every capability is a request; the main process
 * decides whether to carry it out. Nothing here is a security boundary — the
 * extension's code runs in this same realm and could make the requests itself
 * — which is why every check is on the other side.
 *
 * `fetch` is replaced before the extension is imported, with one that asks the
 * main process to make the request (the page's own network is blocked). It
 * follows redirects itself, so each hop is checked against the extension's
 * hosts.
 */

const bridge = window.fluidHost
const request = (message: PageRequest): Promise<unknown> => bridge.request(message)

let nextRegistration: RegistrationId = 0
/** Each registration's contribution, for the main process's calls back into it. */
const contributions = new Map<RegistrationId, unknown>()
/** Registrations made while activating and still on their way, which activation waits for. */
let pending: Promise<unknown>[] | null = null
const eventListeners = new Set<(event: WorkspaceEvent) => void>()
const disposers: (() => void | Promise<void>)[] = []
const bookmarkProviders = new Map<RegistrationId, () => BookmarkContribution[]>()
const connections = new Map<
  number,
  {
    connection: ViewConnection
    messages: Set<(message: unknown) => void>
    gone: Set<() => void>
    connected: boolean
  }
>()
const menus = new Map<number, TabMenuItem[]>()
let nextMenu = 0

/** Sends a registration, and holds activation until it has been accepted. */
function register(registration: Registration, contribution: unknown): Disposable {
  contributions.set(registration.id, contribution)
  const sent = request({ type: 'register', registration })
  pending?.push(sent)
  sent.catch((error: unknown) => console.error('A registration was refused:', error))
  return {
    dispose: () => {
      contributions.delete(registration.id)
      bookmarkProviders.delete(registration.id)
      void sent.then(() => request({ type: 'dispose', id: registration.id })).catch(() => undefined)
    }
  }
}

function contribution<T>(id: RegistrationId): T {
  const found = contributions.get(id)
  if (!found) throw new Error(`Registration ${id} is gone.`)
  return found as T
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NULL_BODY = new Set([101, 204, 205, 304])

async function isolatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const original = new Request(input, init)
  if (original.signal.aborted) throw original.signal.reason
  let url = original.url
  let method = original.method
  let body: Uint8Array | null =
    method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await original.arrayBuffer())
  const headers = [...original.headers]

  for (let hops = 0; ; hops++) {
    const answer = (await request({
      type: 'net.fetch',
      request: { url, method, headers, body }
    })) as FetchResponse
    if (original.signal.aborted) throw original.signal.reason

    const location = answer.headers.find(([name]) => name.toLowerCase() === 'location')?.[1]
    if (REDIRECTS.has(answer.status) && location && original.redirect !== 'manual') {
      if (original.redirect === 'error') throw new TypeError(`${url} redirected.`)
      if (hops >= 20) throw new TypeError(`${original.url} redirected too many times.`)
      url = new URL(location, url).href
      if (
        answer.status === 303 ||
        ((answer.status === 301 || answer.status === 302) && method === 'POST')
      ) {
        method = 'GET'
        body = null
      }
      continue
    }
    return new Response(NULL_BODY.has(answer.status) ? null : (answer.body as BodyInit), {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers
    })
  }
}

globalThis.fetch = isolatedFetch

/**
 * Peer-to-peer connections go round the session's network lock, so there are
 * none: the constructors are gone before the extension's code arrives.
 */
function withoutPeerConnections(): void {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    Reflect.deleteProperty(globalThis, name)
  }
}

withoutPeerConnections()

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

function contextFor(context: ActivateContext): ExtensionContext {
  const secrets = new Map<string, SecretSnapshot>(Object.entries(context.secrets))

  const api = createClient({
    call: (method, input) => request({ type: 'api.call', method, input }),
    subscribe: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    }
  })

  const log =
    (level: 'info' | 'warn' | 'error') =>
    (...args: unknown[]): void => {
      void request({ type: 'log', level, args: args.map(loggable) }).catch(() => undefined)
    }

  return {
    id: context.id,
    api,

    storage: {
      get: async <T>(key: string) => (await request({ type: 'storage.get', key })) as T | undefined,
      set: async (key, value) => void (await request({ type: 'storage.set', key, value })),
      delete: async (key) => void (await request({ type: 'storage.delete', key })),
      keys: async (prefix) => (await request({ type: 'storage.keys', prefix })) as string[]
    },

    // Read synchronously, as every extension reads them: the page holds its
    // own, and writes go to the vault behind it.
    secrets: {
      get: (name) => secrets.get(name)?.value ?? null,
      has: (name) => secrets.has(name),
      set: (name, value) => {
        if (!context.secretsAvailable) {
          throw new Error(
            'Secure storage is unavailable on this computer, so the key was not saved.'
          )
        }
        const before = secrets.get(name)
        secrets.set(name, { value, updatedAt: new Date().toISOString() })
        request({ type: 'secrets.set', name, value })
          .then((stored) => secrets.set(name, stored as SecretSnapshot))
          .catch((error: unknown) => {
            if (before) secrets.set(name, before)
            else secrets.delete(name)
            console.error(`Could not store ${name}:`, error)
          })
      },
      delete: (name) => {
        secrets.delete(name)
        void request({ type: 'secrets.delete', name }).catch((error: unknown) =>
          console.error(`Could not delete ${name}:`, error)
        )
      },
      status: (name) => ({
        available: context.secretsAvailable,
        configured: secrets.has(name),
        updatedAt: secrets.get(name)?.updatedAt ?? null
      })
    },

    dataDir: context.dataDir,

    schedule: (job: ScheduledJob) => {
      const id = ++nextRegistration
      return register(
        {
          kind: 'schedule',
          id,
          job: { id: job.id, intervalMs: job.intervalMs, initialDelayMs: job.initialDelayMs }
        },
        job
      )
    },

    bookmarks: {
      provide: (provider) => {
        const id = ++nextRegistration
        bookmarkProviders.set(id, provider)
        return register({ kind: 'bookmarks', id, bookmarks: provider() }, provider)
      },
      changed: () => {
        void Promise.all(
          [...bookmarkProviders].map(([id, provider]) =>
            request({ type: 'bookmarks.set', id, bookmarks: provider() })
          )
        )
          .then(() => request({ type: 'bookmarks.changed' }))
          .catch((error: unknown) => console.error('Could not update bookmarks:', error))
      }
    },

    taskTypes: {
      register: (type: TaskTypeContribution) => {
        const id = ++nextRegistration
        return register(
          {
            kind: 'taskType',
            id,
            type: {
              id: type.id,
              label: type.label,
              description: type.description,
              hasActions: type.actions !== undefined
            }
          },
          type
        )
      }
    },

    tabTypes: {
      register: (type: TabTypeContribution) => {
        const id = ++nextRegistration
        const view = type.view
        return register(
          {
            kind: 'tabType',
            id,
            type: {
              id: type.id,
              label: type.label,
              agentDescription: type.agentDescription,
              // Checked in the main process, which cannot run a zod schema made
              // here: it gets the schema as JSON Schema and rebuilds it.
              payloadSchema: type.payload
                ? (z.toJSONSchema(type.payload) as Record<string, unknown>)
                : undefined,
              view: !view
                ? undefined
                : view.kind === 'web'
                  ? {
                      kind: 'web',
                      keys: view.keys,
                      stylesheet: view.stylesheet,
                      transparent: view.transparent
                    }
                  : {
                      kind: 'page',
                      keys: view.keys,
                      focusOnShow: view.focusOnShow,
                      drawsBar: view.drawsBar
                    },
              hasPinnedUrl: type.pinnedUrl !== undefined,
              hasMenu: type.menu !== undefined,
              hasOnStop: type.onStop !== undefined,
              hasOnClose: type.onClose !== undefined
            }
          },
          type
        )
      }
    },

    fileViewers: {
      register: (viewer) => {
        const id = ++nextRegistration
        return register({ kind: 'fileViewer', id, viewer }, viewer)
      }
    },

    views: {
      onConnect: (tabType, listener) => {
        const id = ++nextRegistration
        return register({ kind: 'viewConnector', id, tabType }, listener)
      }
    },

    rpc: {
      handle: (method, handler) => {
        const id = ++nextRegistration
        return register({ kind: 'rpc', id, method }, handler)
      }
    },

    extensions: {
      call: async <T>(extensionId: string, method: string, input?: unknown) =>
        (await request({ type: 'extensions.call', extensionId, method, input })) as T
    },

    protocols: {
      handle: (scheme, handler) => {
        const id = ++nextRegistration
        return register({ kind: 'protocol', id, scheme }, handler)
      }
    },

    openExternal: async (url) => void (await request({ type: 'openExternal', url })),

    process: {
      run: async (command, args, options) =>
        (await request({ type: 'process.run', command, args, options })) as Awaited<
          ReturnType<ExtensionContext['process']['run']>
        >
    },

    onDispose: (dispose) => {
      disposers.push(dispose)
    },

    log: { info: log('info'), warn: log('warn'), error: log('error') }
  }
}

/** What survives a trip over IPC, of whatever was logged. */
function loggable(value: unknown): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return structuredClone(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Answering the main process
// ---------------------------------------------------------------------------

async function activate(context: ActivateContext): Promise<unknown> {
  const ctx = contextFor(context)
  pending = []
  const module = (await import(/* @vite-ignore */ context.mainUrl)) as { default?: unknown }
  const extension = module.default as Partial<Extension> | undefined
  if (!extension || typeof extension !== 'object' || typeof extension.activate !== 'function') {
    throw new Error('Its main module does not export an extension as its default.')
  }
  if (extension.id !== context.id) {
    throw new Error(`Its main module is the extension ${String(extension.id)}, not ${context.id}.`)
  }
  await extension.activate(ctx)
  // Everything it registered while activating has been accepted, or this fails.
  const registered = pending
  pending = null
  await Promise.all(registered)
  return {
    name: typeof extension.name === 'string' ? extension.name : undefined,
    description: typeof extension.description === 'string' ? extension.description : undefined,
    settings: extension.settings ? { label: extension.settings.label } : undefined
  }
}

async function deactivate(): Promise<void> {
  for (const dispose of disposers.splice(0)) {
    try {
      await dispose()
    } catch (error) {
      console.error('Shutting down failed:', error)
    }
  }
}

function connectionFor(connectionId: number, tabId: string): ViewConnection {
  const entry = {
    messages: new Set<(message: unknown) => void>(),
    gone: new Set<() => void>(),
    connected: true,
    connection: null as unknown as ViewConnection
  }
  entry.connection = {
    tabId,
    get connected() {
      return entry.connected
    },
    post: (message) => {
      if (entry.connected) void request({ type: 'view.post', connectionId, message })
    },
    onMessage: (listener) => {
      if (entry.connected) entry.messages.add(listener)
      return { dispose: () => entry.messages.delete(listener) }
    },
    onDisconnect: (listener) => {
      if (!entry.connected) {
        listener()
        return { dispose: () => {} }
      }
      entry.gone.add(listener)
      return { dispose: () => entry.gone.delete(listener) }
    }
  }
  connections.set(connectionId, entry)
  return entry.connection
}

async function answer(call: HostCall): Promise<unknown> {
  switch (call.type) {
    case 'activate':
      return activate(call.context)
    case 'deactivate':
      return deactivate()

    case 'taskType.actions': {
      const type = contribution<TaskTypeContribution>(call.registration)
      const actions = (await type.actions?.(call.task)) ?? []
      return actions.map(({ id, label, icon, enabled, hint, confirm }): TaskActionData => ({
        id,
        label,
        ...(icon ? { icon } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(confirm ? { confirm } : {})
      }))
    }
    case 'taskType.run': {
      // Asked afresh, as the app does, so a button that stopped making sense
      // since the panel was drawn does not run on a stale promise.
      const type = contribution<TaskTypeContribution>(call.registration)
      const action = ((await type.actions?.(call.task)) ?? []).find(
        ({ id }) => id === call.actionId
      )
      if (!action) throw new Error('That button is no longer there.')
      return action.run()
    }

    case 'tabType.pinnedUrl':
      return (
        (await contribution<TabTypeContribution>(call.registration).pinnedUrl?.(call.tab)) ?? null
      )
    case 'tabType.menu': {
      const items =
        (await contribution<TabTypeContribution>(call.registration).menu?.(call.tab)) ?? []
      const token = ++nextMenu
      menus.set(token, items)
      // Only the last few menus can still be clicked; an older one has closed.
      for (const old of menus.keys()) if (old <= token - 8) menus.delete(old)
      return {
        token,
        items: items.map((item): TabMenuItemData =>
          'type' in item ? { type: 'separator' } : { label: item.label, enabled: item.enabled }
        )
      }
    }
    case 'tabType.menuClick': {
      const item = menus.get(call.token)?.[call.index]
      menus.delete(call.token)
      if (!item || 'type' in item) throw new Error('That menu has closed.')
      return item.click()
    }
    case 'tabType.onStop':
      return contribution<TabTypeContribution>(call.registration).onStop?.(call.tab)
    case 'tabType.onClose':
      return contribution<TabTypeContribution>(call.registration).onClose?.(call.tab)
    case 'tabType.url': {
      const view = contribution<TabTypeContribution>(call.registration).view
      if (view?.kind !== 'web') throw new Error('That tab has no web view.')
      return view.url(call.tab)
    }

    case 'rpc':
      return contribution<(input: unknown) => unknown>(call.registration)(call.input)

    case 'protocol': {
      const handler = contribution<(request: Request) => Response | Promise<Response>>(
        call.registration
      )
      const { url, method, headers, body } = call.request
      const response = await handler(
        new Request(url, { method, headers, body: body as BodyInit | null })
      )
      const answer: ProtocolResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body: response.body ? new Uint8Array(await response.arrayBuffer()) : null
      }
      return answer
    }

    case 'job.run':
      return contribution<ScheduledJob>(call.registration).run()

    case 'view.connect': {
      const listener = contribution<(connection: ViewConnection) => void>(call.registration)
      listener(connectionFor(call.connectionId, call.tabId))
      return undefined
    }
    case 'view.message': {
      for (const listener of [...(connections.get(call.connectionId)?.messages ?? [])]) {
        try {
          listener(call.message)
        } catch (error) {
          console.error('A view message listener failed:', error)
        }
      }
      return undefined
    }
    case 'view.disconnect': {
      const entry = connections.get(call.connectionId)
      if (!entry) return undefined
      connections.delete(call.connectionId)
      entry.connected = false
      entry.messages.clear()
      for (const listener of [...entry.gone]) listener()
      return undefined
    }

    case 'api.event':
      for (const listener of [...eventListeners]) {
        try {
          listener(call.event)
        } catch (error) {
          console.error('A workspace event listener failed:', error)
        }
      }
      return undefined
  }
}

bridge.onCall(answer)
void request({ type: 'ready' })
