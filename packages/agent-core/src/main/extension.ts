import {
  defineExtension,
  type Extension,
  type ExtensionContext,
  type ViewConnection
} from '@fluid/sdk'
import type { AgentProvider, AgentMethods } from '../shared'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../shared/attachments'
import { createAttachmentStore, type AttachmentStore } from './attachments'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createVisualizationStore } from './visualizations'

/** Both providers implement this boundary; views never call provider SDKs. */
export type AgentAdapter = {
  connect: (connection: ViewConnection) => void
  stop: (tabId: string) => void
  dispose: () => void
  methods: {
    [M in Exclude<keyof AgentMethods, 'visualization.load'>]: (
      input: AgentMethods[M]['input']
    ) => AgentMethods[M]['output'] | Promise<AgentMethods[M]['output']>
  }
}
export type { AttachmentStore } from './attachments'
const text = (v: unknown, label: string): string => {
  if (typeof v !== 'string') throw new Error(`Expected ${label}.`)
  return v
}
export function createAgentExtension(
  provider: AgentProvider,
  create: (ctx: ExtensionContext, files: AttachmentStore) => AgentAdapter,
  files = createAttachmentStore(provider.attachmentScheme, `${provider.id}.session`)
): Extension {
  const visuals = createVisualizationStore(`${provider.id}-visualization`)
  return defineExtension({
    id: provider.id,
    name: provider.name,
    description: `${provider.name} sessions in project tabs.`,
    schemes: [files.ATTACHMENT_SCHEME_PRIVILEGES, visuals.declaration],
    activate(ctx) {
      files.setAttachmentsRoot(ctx.dataDir)
      const adapter = create(ctx, files)
      ctx.onDispose(() => {
        adapter.dispose()
        files.setAttachmentsRoot(null)
        visuals.clear()
      })
      ctx.tabTypes.register({
        id: 'session',
        label: provider.name,
        history: { location: 'cwd', sessionId: 'sessionId' },
        view: { drawsBar: true },
        onStop: (tab) => adapter.stop(tab.id),
        onClose: (tab) => {
          adapter.stop(tab.id)
          visuals.release(tab.id)
          void files.pruneAttachments(ctx.api).catch(console.error)
        }
      })
      ctx.views.onConnect('session', adapter.connect)
      ctx.protocols.handle(provider.attachmentScheme, files.serveAttachment)
      ctx.protocols.handle(visuals.declaration.scheme, async (request) => visuals.serve(request))
      ctx.rpc.handle('visualization.load', async (raw) => {
        const input = raw as Record<string, unknown> | null
        const tab = await ctx.api.tabs.get({ id: text(input?.tabId, 'a tab') })
        if (!tab || tab.type !== `${provider.id}.session`)
          throw new Error('This session tab no longer exists.')
        const cwd = text((tab.payload as Record<string, unknown>)?.cwd, 'a session folder')
        const roots = [cwd]
        // Codex's bundled skill can write to its dedicated visualization tree.
        if (provider.id === 'codex')
          roots.push(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'visualizations'))
        return visuals.load(tab.id, text(input?.path, 'a visualization path'), roots)
      })
      void files.pruneAttachments(ctx.api).catch(console.error)
      for (const [method, handler] of Object.entries(adapter.methods)) {
        ctx.rpc.handle(method, async (raw) => {
          if (!raw || typeof raw !== 'object') throw new Error('Expected session arguments.')
          const input = raw as Record<string, unknown>
          const id = text(input.tabId, 'a tab')
          const tab = await ctx.api.tabs.get({ id })
          if (!tab || tab.type !== `${provider.id}.session`)
            throw new Error('This session tab no longer exists.')
          if (method === 'session.send') {
            text(input.text, 'a message')
            if (!Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENTS)
              throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`)
            let total = 0
            for (const rawFile of input.attachments) {
              if (!rawFile || typeof rawFile !== 'object') throw new Error('Invalid attachment.')
              const file = rawFile as Record<string, unknown>
              text(file.name, 'a file name')
              const data = text(file.data, 'file contents')
              total += data.length * 0.75
              if (total > MAX_ATTACHMENT_BYTES)
                throw new Error('Attachments must total less than 20 MB.')
              if (
                data.length % 4 !== 0 ||
                /[^A-Za-z0-9+/=]/.test(data) ||
                !/^[^=]*={0,2}$/.test(data)
              )
                throw new Error('Invalid attachment encoding.')
            }
            if (total > MAX_ATTACHMENT_BYTES)
              throw new Error('Attachments must total less than 20 MB.')
            if ((input.text as string).length > 1_000_000)
              throw new Error('This message is too long.')
            if (!(input.text as string).trim() && input.attachments.length === 0)
              throw new Error('Enter a message or attach a file.')
          }
          if (method === 'session.respond') {
            text(input.requestId, 'a request')
            if (!['once', 'always', 'deny', 'cancel'].includes(String(input.decision)))
              throw new Error('Unknown approval decision.')
          }
          if (method === 'session.answer') {
            text(input.requestId, 'a request')
            if (
              input.answers !== null &&
              (!input.answers ||
                typeof input.answers !== 'object' ||
                Array.isArray(input.answers) ||
                Object.values(input.answers).some((v) => typeof v !== 'string'))
            )
              throw new Error('Invalid answers.')
          }
          for (const [name, field] of [
            ['setModel', 'model'],
            ['setEffort', 'effort'],
            ['setMode', 'mode'],
            ['rename', 'title'],
            ['revert', 'uuid'],
            ['fork', 'uuid']
          ]) {
            if (method === `session.${name}`) text(input[field!], field!)
          }
          if (method === 'session.setMode' && !provider.modes.some((m) => m.value === input.mode))
            throw new Error('Unknown permission mode.')
          if (method === 'session.setEffort' && !provider.efforts.includes(String(input.effort)))
            throw new Error('Unknown reasoning effort.')
          if (method === 'session.revert' && typeof input.dryRun !== 'boolean')
            throw new Error('Expected a revert preview choice.')
          if (method === 'session.fork') text(input.draft, 'a draft')
          return (handler as (arg: unknown) => unknown)(input)
        })
      }
    }
  })
}
