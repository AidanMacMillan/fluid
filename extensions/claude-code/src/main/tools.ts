import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { scopeOf as scope, workspaceTools as definitions } from '@fluid/agent-core/main'
import { context } from './context'
import type { AgentScope } from '@fluid/agent-core/main'
export { describeScope, READ_ONLY_TOOLS } from '@fluid/agent-core/main'
export type { AgentScope as ClaudeScope } from '@fluid/agent-core/main'
export const scopeOf = (tabId: string, cwd: string): Promise<AgentScope | null> =>
  scope(context().api, tabId, cwd)
export function workspaceTools(session: AgentScope): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'fluid',
    version: '1.0.0',
    alwaysLoad: true,
    tools: definitions(context().api, session).map((t) =>
      tool(t.name, t.description, t.shape, t.run)
    )
  })
}
