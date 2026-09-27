import type { ExtensionTab, Tab } from '@fluid/sdk'
export type AgentEffort = string
export type AgentPermissionMode = string
export type AgentTabPayload = {
  cwd: string
  sessionId?: string
  /** Attachment directories retained by a fork of another tab. */
  attachmentTabs?: string[]
  prompt?: string
  model?: string
  effort?: string
  permissionMode?: string
}
export type AgentViewState = { draft: string }
export type AgentTab = ExtensionTab<`${string}.session`, AgentTabPayload, AgentViewState>
export type AgentProvider = {
  id: string
  name: string
  askName?: string
  icon: string
  attachmentScheme: string
  defaultMode: string
  defaultEffort: string
  efforts: readonly string[]
  modes: readonly { value: string; label: string; hint: string }[]
  capabilities: { fork: boolean; fileRevert: boolean }
}
export function isAgentTab(tab: Tab, provider: AgentProvider): tab is AgentTab {
  return tab.type === `${provider.id}.session`
}
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || '/'
  )
}
