import { defineRendererExtension, type RendererExtension, type NewTab } from '@fluid/sdk'
import type { Component } from 'svelte'
import { folderName, isAgentTab, type AgentProvider } from '../shared/tab'
export function createAgentRenderer(provider: AgentProvider): RendererExtension<Component<never>> {
  const type = `${provider.id}.session` as const
  return defineRendererExtension<Component<never>>({
    id: provider.id,
    tabs: {
      session: {
        icon: provider.icon,
        label: (tab) => (isAgentTab(tab, provider) ? folderName(tab.payload.cwd) : null),
        tooltip: (tab) => (isAgentTab(tab, provider) ? tab.payload.cwd : null)
      }
    },
    launcher: [
      {
        id: 'session',
        supportsMultiline: false,
        label: provider.name,
        icon: provider.icon,
        keywords: ['ai', 'agent', 'assistant', 'chat'],
        open: async (host): Promise<NewTab> => ({
          type,
          title: null,
          payload: { cwd: await host.api.projects.workingDirectory({}) }
        })
      },
      {
        id: 'ask',
        supportsMultiline: true,
        label: `Ask ${provider.askName ?? provider.name}`,
        icon: provider.icon,
        typed: true,
        open: async (text, host): Promise<NewTab> => ({
          type,
          title: null,
          payload: { cwd: await host.api.projects.workingDirectory({}), prompt: text }
        })
      }
    ],
    newTask: [
      {
        id: 'ask',
        supportsMultiline: true,
        label: `Ask ${provider.askName ?? provider.name}`,
        icon: provider.icon,
        typed: true,
        open: async (text, host) => ({
          title: text.split(/[\r\n]/)[0],
          tabs: [
            {
              type,
              title: null,
              payload: { cwd: await host.api.projects.workingDirectory({}), prompt: text }
            }
          ]
        })
      }
    ]
  })
}
