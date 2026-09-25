import { defineExtension } from '@fluid/sdk'
import {
  ATTACHMENT_SCHEME_PRIVILEGES,
  discardAttachments,
  pruneAttachments,
  serveAttachment,
  setAttachmentsRoot
} from './main/attachments'
import { setContext } from './main/context'
import type { ClaudeDecision } from './main/events'
import {
  answerClaude,
  claudeModels,
  connectView,
  destroyAllClaude,
  destroyClaude,
  forkClaude,
  interruptClaude,
  renameClaude,
  respondToClaude,
  revertClaude,
  sendToClaude,
  setClaudeEffort,
  setClaudeMode,
  setClaudeModel,
  setShowsThinking
} from './main/sessions'
import { ATTACHMENT_SCHEME } from './shared/attachments'
import type { ClaudeUpload } from './shared/protocol'
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODES,
  type ClaudeEffort,
  type ClaudePermissionMode
} from './shared/tab'

/**
 * Claude Code, as an extension: a session in a tab, with tools for the
 * workspace the tab sits in.
 *
 * The main half is here and in ./main — the sessions themselves, which are CLI
 * processes, and the MCP tools they are given. The view that draws a session
 * is in ./views, in a page of its own, and hears from its session over the
 * view's connection. The row and the launcher entry are in ./renderer.
 */

type Args = Record<string, unknown>

const args = (input: unknown): Args =>
  typeof input === 'object' && input !== null ? (input as Args) : {}

/** Checks an RPC argument is a string, since RPC input arrives unvalidated. */
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${name}.`)
  return value
}

const tabId = (input: unknown): string => text(args(input).tabId, 'a tab')

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Unknown ${name} "${String(value)}".`)
  return value as T
}

const DECISIONS: readonly ClaudeDecision[] = ['once', 'always', 'deny', 'cancel']

function uploads(value: unknown): ClaudeUpload[] {
  if (!Array.isArray(value)) return []
  return value.map((file) => {
    const { name, data } = args(file)
    return { name: text(name, 'a file name'), data: text(data, 'file contents') }
  })
}

function answers(value: unknown): Record<string, string> | null {
  if (value === null) return null
  const out: Record<string, string> = {}
  for (const [question, answer] of Object.entries(args(value))) {
    out[question] = text(answer, 'an answer')
  }
  return out
}

export default defineExtension({
  id: 'claude-code',
  name: 'Claude Code',
  description:
    'Claude Code sessions in tabs, which can read the task they are in, open tabs in it and leave notes on it.',
  schemes: [ATTACHMENT_SCHEME_PRIVILEGES],

  activate(ctx) {
    setContext(ctx)
    setAttachmentsRoot(ctx.dataDir)
    // Disabling the extension, or quitting: every CLI process goes, before the
    // context their sessions write their tabs through does.
    ctx.onDispose(() => {
      destroyAllClaude()
      setAttachmentsRoot(null)
      setContext(null)
    })

    ctx.tabTypes.register({
      id: 'session',
      label: 'Claude Code',
      // Drawn in a view of its own (see ./views). It claims no keys: the
      // composer sends on a plain Enter, takes a suggestion with Tab and closes
      // a picture with Escape, and the menu binds none of them. Its bar is its
      // own, with the conversation's name in it, so the app draws none over it.
      view: { drawsBar: true },
      // What stops is the CLI process. The conversation is Claude Code's own,
      // on disk, and a settled task's tab picks it up again when it is next
      // shown.
      onStop: (tab) => destroyClaude(tab.id),
      onClose: (tab) => void discardAttachments(tab.id)
    })

    ctx.views.onConnect('session', connectView)
    ctx.protocols.handle(ATTACHMENT_SCHEME, serveAttachment)

    // What no close could clear up: tabs whose task was deleted, or which went
    // while the app was not running. Nothing waits on it.
    void pruneAttachments(ctx.api)

    const rpc = ctx.rpc
    rpc.handle('session.send', (input) => {
      const { text: body, attachments } = args(input)
      sendToClaude(tabId(input), text(body, 'a message'), uploads(attachments))
    })
    rpc.handle('session.interrupt', (input) => interruptClaude(tabId(input)))
    rpc.handle('session.respond', (input) => {
      const { requestId, decision } = args(input)
      respondToClaude(
        tabId(input),
        text(requestId, 'a request'),
        oneOf(decision, DECISIONS, 'decision')
      )
    })
    rpc.handle('session.answer', (input) => {
      const { requestId, answers: picked } = args(input)
      answerClaude(tabId(input), text(requestId, 'a request'), answers(picked))
    })
    rpc.handle('session.models', (input) => claudeModels(tabId(input)))
    rpc.handle('session.setModel', (input) =>
      setClaudeModel(tabId(input), text(args(input).model, 'a model'))
    )
    rpc.handle('session.setEffort', (input) =>
      setClaudeEffort(
        tabId(input),
        oneOf<ClaudeEffort>(args(input).effort, CLAUDE_EFFORTS, 'thinking level')
      )
    )
    rpc.handle('session.setMode', (input) =>
      setClaudeMode(
        tabId(input),
        oneOf<ClaudePermissionMode>(args(input).mode, CLAUDE_MODES, 'permission mode')
      )
    )
    rpc.handle('session.rename', (input) =>
      renameClaude(tabId(input), text(args(input).title, 'a name'))
    )
    rpc.handle('session.revert', (input) => {
      const { uuid, dryRun } = args(input)
      return revertClaude(tabId(input), text(uuid, 'a turn'), dryRun === true)
    })
    rpc.handle('session.fork', (input) => {
      const { uuid, draft } = args(input)
      return forkClaude(tabId(input), text(uuid, 'a turn'), typeof draft === 'string' ? draft : '')
    })
    rpc.handle('thinking.set', (input) => setShowsThinking(args(input).show !== false))
  }
})
