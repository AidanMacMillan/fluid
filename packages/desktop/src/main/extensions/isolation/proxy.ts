import { ipcMain, WebContentsView, type WebContents } from 'electron'
import { z } from 'zod'
import type {
  BookmarkContribution,
  Disposable,
  Extension,
  ExtensionContext,
  ExtensionManifest,
  FileViewerContribution,
  ProcessOptions,
  ProcessResult,
  Tab,
  TabMenuItem,
  TabTypeContribution,
  TaskAction,
  ViewConnection
} from '@fluid/sdk'
import { hears, hostAllowed } from '../../api/isolation-policy'
import type { Permissions } from '../installed'
import type {
  FetchRequest,
  FetchResponse,
  HostCall,
  HostReply,
  PageRequest,
  ProtocolResponse,
  RegistrationId,
  SecretSnapshot,
  TabMenuItemData,
  TaskActionData
} from './protocol'

/**
 * An installed extension's main half, run in a sandboxed page of its own and
 * held to its permissions. This is the main process's side; the page's is
 * src/renderer/src/extension-host.ts.
 *
 * The page is a hidden `WebContentsView` with Chromium's sandbox and no Node:
 * the extension's code cannot touch the disk, start a process, reach the
 * network or read another extension's anything by itself. Its one way out is
 * the bridge its preload gives it (src/preload/extension-host.ts), and every
 * request over that bridge arrives here, is checked, and is carried out on the
 * real `ExtensionContext` the host made for it — or refused.
 *
 * - **The workspace API** goes through as the extension, where the API holds
 *   an installed extension to a narrower set of methods (see
 *   api/isolation-policy.ts).
 * - **The network** is `fetch`, made here on the page's behalf, over https, to
 *   the hosts its manifest names, in a session of its own with no cookies of
 *   the user's. Redirects come back to the page, which follows them through
 *   here again, so a redirect cannot reach a host the manifest does not name.
 * - **Commands** are the ones its manifest names, found on PATH and run
 *   without a shell (see ../commands.ts).
 * - **Other extensions** are the ones its manifest names.
 * - **Its secrets** are its own, decrypted here and handed to the page as it
 *   starts, since an extension reads its secrets synchronously. It never sees
 *   another extension's, nor the vault.
 *
 * What it registers — task and tab types, bookmarks, jobs, RPC methods — is
 * registered on the real context by proxy, checked as data first, so it shows
 * up in the app like a built-in extension's; the functions stay in the page,
 * and the app calls back into it for them.
 *
 * Stopping it closes the page, which ends its process and every timer and
 * socket it had: nothing of an installed extension outlives it being turned
 * off, updated or removed.
 *
 * @module proxy
 */

export type IsolatedOptions = {
  manifest: ExtensionManifest
  permissions: Permissions
  /** The page the main half runs in, and the preload its bridge comes from. */
  pageUrl: string
  preload: string
  /** Where the page imports the extension's main half from. */
  mainUrl: string
  /** The page's session, already serving the extension's files and blocking everything else. */
  partition: string
  /** The extension's own secrets, decrypted. */
  secrets(): Record<string, SecretSnapshot>
  secretsAvailable(): boolean
  runCommand(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>
  fetch(request: FetchRequest): Promise<FetchResponse>
  /** Told when the page goes without being asked to — a crash, a hang the OS ended. */
  onCrash(reason: string): void
  devTools: boolean
}

/** How long the page has to answer, by what it is being asked. */
const TIMEOUTS = {
  load: 20_000,
  activate: 30_000,
  deactivate: 5_000,
  callback: 30_000,
  rpc: 120_000,
  action: 10 * 60_000,
  job: 30 * 60_000
}

/** The most registrations one run of an extension may hold at once. */
const MAX_REGISTRATIONS = 1_000
/** The most keys an extension may hold in its storage. */
const MAX_STORAGE_KEYS = 10_000
/** The most bookmarks an extension may supply, across all its providers. */
const MAX_BOOKMARKS = 5_000
/** How large, and how deeply nested, a payload schema may be. */
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SCHEMA_DEPTH = 24

/**
 * Checks a payload schema before it is rebuilt into one the main process runs
 * against every payload of the type, synchronously. So nothing that can make
 * that slow: no patterns — a regular expression that backtracks would stall
 * the whole app — and no references, which can recurse; and only so much of
 * it. A tab payload has no need of either.
 */
function checkPayloadSchema(schema: Record<string, unknown>): void {
  if (sizeOf(schema) > MAX_SCHEMA_BYTES) throw new Error('Its payload schema is too large.')
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error('Its payload schema is nested too deeply.')
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (
        key === 'pattern' ||
        key === 'patternProperties' ||
        key === '$ref' ||
        key === '$dynamicRef'
      ) {
        throw new Error(`Its payload schema uses ${key}, which an installed extension's may not.`)
      }
      walk(value, depth + 1)
    }
  }
  walk(schema, 0)
}
/** The most bytes a stored value, a request body or a response may be. */
const MAX_BYTES = 50 * 1024 * 1024

// ---------------------------------------------------------------------------
// Checking what the page sends
// ---------------------------------------------------------------------------

const idPart = z.string().regex(/^[a-z0-9-]+$/)
const label = z.string().trim().min(1).max(200)
const keys = z.array(z.string().max(60)).max(40)

/** An address a page of the app's may show or open: a web page, or a picture inline. */
const webAddress = z
  .string()
  .max(8_192)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'must be an http or https address')

const pictureAddress = z
  .string()
  .max(2 * 1024 * 1024)
  .refine((value) => {
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/.test(value)) return true
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an https address or an inline picture')

const bookmarkSchema = z
  .object({
    id: z.string().min(1).max(200),
    label,
    url: webAddress,
    icon: pictureAddress.refine((icon) => icon.length <= 256 * 1024, 'is too large').optional(),
    keywords: z.array(z.string().max(100)).max(50).optional(),
    group: z.string().max(100).optional(),
    searchOnly: z.boolean().optional()
  })
  .strict()

const bookmarksSchema = z.array(bookmarkSchema).max(MAX_BOOKMARKS)

const fileViewerSchema = z
  .object({
    id: idPart,
    label,
    mimeTypes: z
      .array(z.string().regex(/^[a-z0-9.+-]+\/([a-z0-9.+-]+|\*)$/))
      .min(1)
      .max(100),
    view: z.union([
      z.object({
        kind: z.literal('page'),
        keys: keys.optional(),
        focusOnShow: z.boolean().optional()
      }),
      z.object({
        kind: z.literal('native'),
        session: z.enum(['ephemeral', 'persisted']),
        resizable: z.boolean().optional()
      })
    ])
  })
  .strict()

const registrationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('taskType'),
    id: z.number().int(),
    type: z
      .object({
        id: idPart,
        label,
        description: z.string().max(1_000).optional(),
        hasActions: z.boolean()
      })
      .strict()
  }),
  z.object({
    kind: z.literal('tabType'),
    id: z.number().int(),
    type: z
      .object({
        id: idPart,
        label,
        agentDescription: z.string().max(4_000).optional(),
        payloadSchema: z.record(z.string(), z.unknown()).optional(),
        view: z
          .union([
            z.object({
              kind: z.literal('page'),
              keys: keys.optional(),
              focusOnShow: z.boolean().optional(),
              drawsBar: z.boolean().optional()
            }),
            z.object({
              kind: z.literal('web'),
              keys: z.union([keys, z.literal('all')]).optional(),
              stylesheet: z
                .string()
                .max(1024 * 1024)
                .optional(),
              transparent: z.boolean().optional()
            })
          ])
          .optional(),
        hasPinnedUrl: z.boolean(),
        hasMenu: z.boolean(),
        hasOnStop: z.boolean(),
        hasOnClose: z.boolean()
      })
      .strict()
  }),
  z.object({ kind: z.literal('fileViewer'), id: z.number().int(), viewer: fileViewerSchema }),
  z.object({ kind: z.literal('bookmarks'), id: z.number().int(), bookmarks: bookmarksSchema }),
  z.object({ kind: z.literal('viewConnector'), id: z.number().int(), tabType: idPart }),
  z.object({ kind: z.literal('rpc'), id: z.number().int(), method: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('protocol'), id: z.number().int(), scheme: z.string().min(1) }),
  z.object({
    kind: z.literal('schedule'),
    id: z.number().int(),
    job: z.object({
      id: z.string().min(1).max(200),
      // Once a second at the most: a job is a background chore, not a loop.
      intervalMs: z
        .number()
        .int()
        .min(1_000)
        .max(7 * 24 * 60 * 60_000),
      initialDelayMs: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60_000)
        .optional()
    })
  })
])

const taskActionsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(200),
        label,
        icon: z
          .union([
            z.object({ emoji: z.string().min(1).max(32) }).strict(),
            z.object({ image: pictureAddress }).strict()
          ])
          .optional(),
        enabled: z.boolean().optional(),
        hint: z.string().max(1_000).optional(),
        confirm: z
          .object({
            message: z.string().min(1).max(1_000),
            detail: z.string().max(4_000).optional(),
            button: z.string().min(1).max(60)
          })
          .strict()
          .optional()
      })
      .strict()
  )
  .max(50)

const menuSchema = z.object({
  token: z.number().int(),
  items: z
    .array(
      z.union([
        z.object({ type: z.literal('separator') }).strict(),
        z.object({ label, enabled: z.boolean().optional() }).strict()
      ])
    )
    .max(100)
})

const protocolResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  statusText: z.string().max(200),
  headers: z.array(z.tuple([z.string().max(200), z.string().max(16_384)])).max(200),
  body: z.instanceof(Uint8Array).nullable()
})

const activatedSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  settings: z
    .object({ label: z.string().min(1).max(60).optional() })
    .strict()
    .optional()
})

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

// ---------------------------------------------------------------------------
// Talking to the page
// ---------------------------------------------------------------------------

class Page {
  private seq = 0
  private closed: string | null = null
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(
    readonly webContents: WebContents,
    private readonly name: string
  ) {}

  call<T>(call: HostCall, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed))
    const seq = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`${this.name} did not answer in time.`))
      }, timeoutMs)
      this.pending.set(seq, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.webContents.send('extension-host:call', { seq, call })
    })
  }

  /** Tells the page something without waiting for an answer. */
  notify(call: HostCall): void {
    if (this.closed || this.webContents.isDestroyed()) return
    this.webContents.send('extension-host:call', { seq: 0, call })
  }

  settle(reply: HostReply): void {
    const waiting = this.pending.get(reply.seq)
    if (!waiting) return
    this.pending.delete(reply.seq)
    clearTimeout(waiting.timer)
    if (reply.ok) waiting.resolve(reply.value)
    else
      waiting.reject(
        Object.assign(new Error(String(reply.error?.message ?? 'It failed.')), {
          code: reply.error?.code
        })
      )
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = reason
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

/** Every running extension host page, by its web contents. */
const bridges = new Map<number, Bridge>()

/**
 * Every running host page's view. Held here because nothing else holds it: the
 * view is never added to a window, and a view nobody references is collected,
 * taking its page with it — silently, with no crash to report.
 */
const views = new Map<number, WebContentsView>()

let listening = false

/**
 * The two channels every host page talks over. The sender is how a message is
 * known to be from a host page, and which one: never anything it says.
 */
function listen(): void {
  if (listening) return
  listening = true
  ipcMain.handle('extension-host:request', async (event, request: unknown) => {
    const bridge = bridges.get(event.sender.id)
    if (!bridge)
      return { ok: false, error: { message: 'Only an extension host page can ask this.' } }
    try {
      return { ok: true, value: await bridge.handle(request) }
    } catch (error) {
      const failure = error as { message?: unknown; code?: unknown }
      return {
        ok: false,
        error: {
          message: String(failure?.message ?? error),
          ...(typeof failure?.code === 'string' || typeof failure?.code === 'number'
            ? { code: failure.code }
            : {})
        }
      }
    }
  })
  ipcMain.on('extension-host:reply', (event, reply: unknown) => {
    const bridge = bridges.get(event.sender.id)
    const parsed = z
      .object({
        seq: z.number().int(),
        ok: z.boolean(),
        value: z.unknown().optional(),
        error: z.unknown().optional()
      })
      .safeParse(reply)
    if (bridge && parsed.success) bridge.page.settle(parsed.data as HostReply)
  })
}

// ---------------------------------------------------------------------------
// One running extension
// ---------------------------------------------------------------------------

class Bridge {
  private readonly registrations = new Map<RegistrationId, Disposable>()
  private readonly bookmarks = new Map<RegistrationId, BookmarkContribution[]>()
  private readonly connections = new Map<number, ViewConnection>()
  private nextConnection = 0
  /** How many keys its storage holds, once asked; kept up to date as it writes. */
  private storageKeys: Set<string> | null = null
  private markReady: () => void = () => {}
  readonly ready = new Promise<void>((resolve) => (this.markReady = resolve))

  constructor(
    readonly page: Page,
    private readonly ctx: ExtensionContext,
    private readonly options: IsolatedOptions
  ) {}

  private get label(): string {
    return this.options.manifest.name
  }

  /** Lets go of everything the page registered. The host disposes them too; this is for a page that went early. */
  dispose(): void {
    for (const registration of this.registrations.values()) {
      try {
        registration.dispose()
      } catch {
        // Already undone by the host.
      }
    }
    this.registrations.clear()
    this.bookmarks.clear()
    this.connections.clear()
  }

  async handle(raw: unknown): Promise<unknown> {
    const request = z.object({ type: z.string() }).passthrough().parse(raw) as PageRequest
    const { ctx, options } = this
    const { permissions } = options

    switch (request.type) {
      case 'ready':
        this.markReady()
        return undefined

      case 'api.call': {
        const { method, input } = z
          .object({ method: z.string().max(200), input: z.unknown().optional() })
          .parse(request)
        return ctx.api.call(method as never, input as never)
      }

      case 'storage.get':
        return ctx.storage.get(z.object({ key: z.string().max(1_000) }).parse(request).key)
      case 'storage.set': {
        const { key, value } = z
          .object({ key: z.string().max(1_000), value: z.unknown().optional() })
          .parse(request)
        if (sizeOf(value) > MAX_BYTES) throw new Error('That value is too large to store.')
        this.storageKeys ??= new Set(await ctx.storage.keys())
        if (!this.storageKeys.has(key) && this.storageKeys.size >= MAX_STORAGE_KEYS) {
          throw new Error(`${this.label} already holds as many stored values as it may.`)
        }
        await ctx.storage.set(key, value)
        this.storageKeys.add(key)
        return undefined
      }
      case 'storage.delete': {
        const { key } = z.object({ key: z.string().max(1_000) }).parse(request)
        await ctx.storage.delete(key)
        this.storageKeys?.delete(key)
        return undefined
      }
      case 'storage.keys':
        return ctx.storage.keys(
          z.object({ prefix: z.string().max(1_000).optional() }).parse(request).prefix
        )

      case 'secrets.set': {
        const { name, value } = z
          .object({
            name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
            value: z.string().min(1).max(65_536)
          })
          .parse(request)
        ctx.secrets.set(name, value)
        return { value, updatedAt: ctx.secrets.status(name).updatedAt ?? new Date().toISOString() }
      }
      case 'secrets.delete': {
        const { name } = z.object({ name: z.string().max(100) }).parse(request)
        ctx.secrets.delete(name)
        return undefined
      }

      case 'register':
        return this.register(
          registrationSchema.parse((request as { registration: unknown }).registration)
        )
      case 'dispose': {
        const { id } = z.object({ id: z.number().int() }).parse(request)
        this.registrations.get(id)?.dispose()
        this.registrations.delete(id)
        this.bookmarks.delete(id)
        return undefined
      }

      case 'bookmarks.set': {
        const { id, bookmarks } = z
          .object({ id: z.number().int(), bookmarks: bookmarksSchema })
          .parse(request)
        if (!this.bookmarks.has(id)) return undefined
        this.checkBookmarkTotal(id, bookmarks.length)
        this.bookmarks.set(id, bookmarks)
        return undefined
      }
      case 'bookmarks.changed':
        ctx.bookmarks.changed()
        return undefined

      case 'extensions.call': {
        const { extensionId, method, input } = z
          .object({
            extensionId: idPart,
            method: z.string().max(200),
            input: z.unknown().optional()
          })
          .parse(request)
        if (extensionId !== ctx.id && !permissions.extensions.includes(extensionId)) {
          throw new Error(
            `${this.label} may not call the ${extensionId} extension: its manifest does not ask to.`
          )
        }
        return ctx.extensions.call(extensionId, method, input)
      }

      case 'openExternal': {
        const { url } = z.object({ url: z.string().max(8_192) }).parse(request)
        let protocol: string
        try {
          protocol = new URL(url).protocol
        } catch {
          throw new Error(`${url} is not an address.`)
        }
        if (!['http:', 'https:', 'mailto:'].includes(protocol)) {
          throw new Error(`${this.label} may only open web pages and email addresses.`)
        }
        return ctx.openExternal(url)
      }

      case 'process.run': {
        const {
          command,
          args,
          options: runOptions
        } = z
          .object({
            command: z.string().max(200),
            args: z.array(z.string().max(100_000)).max(1_000),
            options: z
              .object({
                cwd: z.string().max(4_096).optional(),
                timeoutMs: z.number().int().min(1).max(TIMEOUTS.action).optional(),
                input: z
                  .string()
                  .max(10 * 1024 * 1024)
                  .optional()
              })
              .strict()
              .optional()
          })
          .parse(request)
        if (!permissions.commands.includes(command)) {
          throw Object.assign(
            new Error(`${this.label} may not run ${command}: its manifest does not ask to.`),
            { code: 'EACCES' }
          )
        }
        return options.runCommand(command, args, runOptions)
      }

      case 'net.fetch': {
        const { request: fetchRequest } = z
          .object({
            request: z.object({
              url: z.string().max(16_384),
              method: z.string().regex(/^[A-Z]{1,16}$/),
              headers: z.array(z.tuple([z.string().max(200), z.string().max(16_384)])).max(200),
              body: z.instanceof(Uint8Array).nullable()
            })
          })
          .parse(request)
        let url: URL
        try {
          url = new URL(fetchRequest.url)
        } catch {
          throw new TypeError(`${fetchRequest.url} is not an address.`)
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.port) {
          throw new TypeError(`${this.label} may only fetch https addresses on the default port.`)
        }
        if (!hostAllowed(permissions.hosts, url.hostname)) {
          throw new TypeError(
            `${this.label} may not reach ${url.hostname}: its manifest does not ask to.`
          )
        }
        if ((fetchRequest.body?.byteLength ?? 0) > MAX_BYTES) {
          throw new TypeError('That request is too large to send.')
        }
        return options.fetch({
          ...fetchRequest,
          headers: fetchRequest.headers as [string, string][],
          body: fetchRequest.body ?? null,
          url: url.href
        })
      }

      case 'view.post': {
        const { connectionId, message } = z
          .object({ connectionId: z.number().int(), message: z.unknown().optional() })
          .parse(request)
        this.connections.get(connectionId)?.post(message)
        return undefined
      }

      case 'log': {
        const { level, args } = z
          .object({ level: z.enum(['info', 'warn', 'error']), args: z.array(z.unknown()).max(50) })
          .parse(request)
        ctx.log[level](...args)
        return undefined
      }

      default:
        throw new Error(`There is no ${String((request as { type: unknown }).type)} request.`)
    }
  }

  /** Throws when `count` more bookmarks from `id` would take it past the most it may supply. */
  private checkBookmarkTotal(id: RegistrationId, count: number): void {
    let total = count
    for (const [other, list] of this.bookmarks) if (other !== id) total += list.length
    if (total > MAX_BOOKMARKS) {
      throw new Error(`${this.label} supplies more than ${MAX_BOOKMARKS} bookmarks.`)
    }
  }

  private register(registration: z.infer<typeof registrationSchema>): void {
    if (this.registrations.size >= MAX_REGISTRATIONS) {
      throw new Error(`${this.label} has registered more than it may hold at once.`)
    }
    if (this.registrations.has(registration.id)) {
      throw new Error(`Registration ${registration.id} is already in use.`)
    }
    const { ctx, page } = this
    const id = registration.id
    let disposable: Disposable

    switch (registration.kind) {
      case 'taskType': {
        const { type } = registration
        disposable = ctx.taskTypes.register({
          id: type.id,
          label: type.label,
          description: type.description,
          actions: type.hasActions
            ? async (task) => {
                const actions = taskActionsSchema.parse(
                  await page.call<TaskActionData[]>(
                    { type: 'taskType.actions', registration: id, task },
                    TIMEOUTS.callback
                  )
                )
                return actions.map((action): TaskAction => ({
                  ...action,
                  run: () =>
                    page.call<void>(
                      { type: 'taskType.run', registration: id, task, actionId: action.id },
                      TIMEOUTS.action
                    )
                }))
              }
            : undefined
        })
        break
      }

      case 'tabType': {
        const { type } = registration
        let payload: TabTypeContribution['payload']
        if (type.payloadSchema) {
          checkPayloadSchema(type.payloadSchema)
          try {
            payload = z.fromJSONSchema(
              type.payloadSchema as never
            ) as TabTypeContribution['payload']
          } catch (error) {
            throw new Error(`The ${type.id} tab's payload schema cannot be read: ${String(error)}`)
          }
        }
        const view: TabTypeContribution['view'] =
          type.view?.kind === 'web'
            ? {
                kind: 'web',
                keys: type.view.keys,
                stylesheet: type.view.stylesheet,
                transparent: type.view.transparent,
                url: (tab) =>
                  page.call<string>({ type: 'tabType.url', registration: id, tab }, TIMEOUTS.rpc)
              }
            : type.view
              ? {
                  kind: 'page',
                  keys: type.view.keys,
                  focusOnShow: type.view.focusOnShow,
                  drawsBar: type.view.drawsBar
                }
              : undefined
        const fireAndForget = (kind: 'tabType.onStop' | 'tabType.onClose') => (tab: Tab) => {
          page
            .call<void>({ type: kind, registration: id, tab }, TIMEOUTS.callback)
            .catch((error) => ctx.log.warn(`${kind} failed:`, error))
        }
        disposable = ctx.tabTypes.register({
          id: type.id,
          label: type.label,
          agentDescription: type.agentDescription,
          payload,
          view,
          pinnedUrl: type.hasPinnedUrl
            ? async (tab) => {
                const url = await page.call<unknown>(
                  { type: 'tabType.pinnedUrl', registration: id, tab },
                  TIMEOUTS.callback
                )
                return url === null ? null : webAddress.parse(url)
              }
            : undefined,
          menu: type.hasMenu
            ? async (tab) => {
                const { token, items } = menuSchema.parse(
                  await page.call<{ token: number; items: TabMenuItemData[] }>(
                    { type: 'tabType.menu', registration: id, tab },
                    TIMEOUTS.callback
                  )
                )
                return items.map((item, index): TabMenuItem =>
                  'type' in item
                    ? item
                    : {
                        ...item,
                        click: () =>
                          page.call<void>(
                            { type: 'tabType.menuClick', token, index },
                            TIMEOUTS.action
                          )
                      }
                )
              }
            : undefined,
          onStop: type.hasOnStop ? fireAndForget('tabType.onStop') : undefined,
          onClose: type.hasOnClose ? fireAndForget('tabType.onClose') : undefined
        })
        break
      }

      case 'fileViewer':
        disposable = ctx.fileViewers.register(registration.viewer as FileViewerContribution)
        break

      case 'bookmarks': {
        this.checkBookmarkTotal(id, registration.bookmarks.length)
        this.bookmarks.set(id, registration.bookmarks)
        disposable = ctx.bookmarks.provide(() => this.bookmarks.get(id) ?? [])
        break
      }

      case 'viewConnector':
        disposable = ctx.views.onConnect(registration.tabType, (connection) => {
          const connectionId = ++this.nextConnection
          this.connections.set(connectionId, connection)
          page.notify({
            type: 'view.connect',
            registration: id,
            connectionId,
            tabId: connection.tabId
          })
          const messages = connection.onMessage((message) =>
            page.notify({ type: 'view.message', connectionId, message })
          )
          connection.onDisconnect(() => {
            messages.dispose()
            this.connections.delete(connectionId)
            page.notify({ type: 'view.disconnect', connectionId })
          })
        })
        break

      case 'rpc':
        disposable = ctx.rpc.handle(registration.method, (input) =>
          page.call({ type: 'rpc', registration: id, input }, TIMEOUTS.rpc)
        )
        break

      case 'protocol':
        disposable = ctx.protocols.handle(registration.scheme, async (request) => {
          const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null
          if ((body?.byteLength ?? 0) > MAX_BYTES) return new Response(null, { status: 413 })
          const answer = protocolResponseSchema.parse(
            await page.call<ProtocolResponse>(
              {
                type: 'protocol',
                registration: id,
                request: {
                  url: request.url,
                  method: request.method,
                  headers: [...request.headers],
                  body
                }
              },
              TIMEOUTS.rpc
            )
          )
          return new Response(answer.body as BodyInit | null, {
            status: answer.status,
            statusText: answer.statusText,
            headers: answer.headers as [string, string][]
          })
        })
        break

      case 'schedule':
        disposable = ctx.schedule({
          ...registration.job,
          run: () => page.call<void>({ type: 'job.run', registration: id }, TIMEOUTS.job)
        })
        break
    }

    this.registrations.set(id, disposable)
  }
}

/**
 * An installed extension as the host runs it: an `Extension` whose activation
 * starts its page and whose context is the page's, by proxy. Its name,
 * description and settings are the manifest's until it has started, and then
 * whatever its code says.
 */
export function isolatedExtension(options: IsolatedOptions): Extension {
  listen()
  const { manifest } = options

  const extension: Extension = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    schemes: manifest.schemes ?? [],

    async activate(ctx) {
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webviewTag: false,
          partition: options.partition,
          preload: options.preload,
          // It is never on screen, and its timers are its jobs.
          backgroundThrottling: false,
          spellcheck: false,
          devTools: options.devTools,
          navigateOnDragDrop: false
        }
      })
      const { webContents } = view
      // Peer-to-peer traffic goes round the session's network lock; the page
      // has no constructor for it either.
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      const pageId = webContents.id
      const page = new Page(webContents, manifest.name)
      const bridge = new Bridge(page, ctx, options)
      bridges.set(pageId, bridge)
      views.set(pageId, view)

      let stopping = false
      const stop = (reason: string): void => {
        page.close(reason)
        bridges.delete(pageId)
        views.delete(pageId)
        bridge.dispose()
        if (!webContents.isDestroyed()) webContents.close()
      }
      ctx.onDispose(async () => {
        stopping = true
        try {
          await page.call<void>({ type: 'deactivate' }, TIMEOUTS.deactivate)
        } catch {
          // It is going regardless; closing the page ends whatever it left running.
        }
        stop(`${manifest.name} was stopped.`)
      })

      webContents.on('render-process-gone', (_event, details) => {
        if (stopping) return
        stopping = true
        stop(`${manifest.name} stopped unexpectedly.`)
        options.onCrash(`Its process ended (${details.reason}).`)
      })
      // Anything else that takes the page away without being asked to.
      webContents.once('destroyed', () => {
        if (stopping) return
        stopping = true
        stop(`${manifest.name} stopped unexpectedly.`)
        options.onCrash('Its page was closed.')
      })
      // What the page logs is the extension's, and lands with its other logs.
      webContents.on('console-message', (event) => {
        const { level, message } = event as unknown as { level: string; message: string }
        if (level === 'error') ctx.log.error(message)
        else if (level === 'warning') ctx.log.warn(message)
        else ctx.log.info(message)
      })
      webContents.on('will-navigate', (event) => event.preventDefault())
      webContents.on('will-redirect', (event) => event.preventDefault())
      webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const unsubscribe = ctx.api.onAny((event) => {
        if (hears(manifest.id, event)) page.notify({ type: 'api.event', event })
      })
      ctx.onDispose(unsubscribe)

      const loaded = webContents.loadURL(options.pageUrl)
      await withTimeout(
        Promise.all([loaded, bridge.ready]),
        TIMEOUTS.load,
        `${manifest.name}'s page did not load.`
      )

      const activated = activatedSchema.parse(
        (await page.call(
          {
            type: 'activate',
            context: {
              id: manifest.id,
              mainUrl: options.mainUrl,
              dataDir: ctx.dataDir,
              secretsAvailable: options.secretsAvailable(),
              secrets: options.secrets()
            }
          },
          TIMEOUTS.activate
        )) ?? {}
      )
      extension.name = activated.name ?? manifest.name
      extension.description = activated.description ?? manifest.description
      extension.settings = activated.settings
    }
  }
  return extension
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
