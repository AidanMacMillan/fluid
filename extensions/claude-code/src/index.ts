import { createAgentExtension } from '@fluid/agent-core/main'
import { claudeProvider } from './shared/provider'
import * as files from './main/attachments'
import { setContext } from './main/context'
import * as sessions from './main/sessions'
import type { ClaudeEffort, ClaudePermissionMode } from './shared/tab'
export default createAgentExtension(
  claudeProvider,
  (ctx) => {
    setContext(ctx)
    return {
      connect: sessions.connectView,
      stop: sessions.destroyClaude,
      dispose: () => {
        sessions.destroyAllClaude()
        setContext(null)
      },
      methods: {
        'session.send': (i) => sessions.sendToClaude(i.tabId, i.text, i.attachments),
        'session.interrupt': (i) => sessions.interruptClaude(i.tabId),
        'session.respond': (i) => sessions.respondToClaude(i.tabId, i.requestId, i.decision),
        'session.answer': (i) => sessions.answerClaude(i.tabId, i.requestId, i.answers),
        'session.models': (i) => sessions.claudeModels(i.tabId),
        'session.setModel': (i) => sessions.setClaudeModel(i.tabId, i.model),
        'session.setEffort': (i) => sessions.setClaudeEffort(i.tabId, i.effort as ClaudeEffort),
        'session.setMode': (i) => sessions.setClaudeMode(i.tabId, i.mode as ClaudePermissionMode),
        'session.rename': (i) => sessions.renameClaude(i.tabId, i.title),
        'session.revert': (i) => sessions.revertClaude(i.tabId, i.uuid, i.dryRun),
        'session.fork': (i) => sessions.forkClaude(i.tabId, i.uuid, i.draft)
      }
    }
  },
  files
)
