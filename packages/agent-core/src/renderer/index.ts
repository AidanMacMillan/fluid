import {
  defineRendererExtension,
  rules,
  when,
  type NewTab,
  type RendererExtension
} from '@fluid/sdk'
import type { Component } from 'svelte'
import { folderName, isAgentTab, type AgentProvider } from '../shared/tab'

/**
 * Where asking an agent sits for what was typed. Under the search for almost
 * everything, since what the field holds is most often something to look up —
 * but over it for a long instruction, which is a thing to hand to an agent and
 * a poor thing to search for, and far under it for what reads as a command or
 * an address, which an agent is the slowest way to deal with.
 */
const askRelevance = rules(
  when((query) => query.naturalLanguage && !query.question && query.words.length >= 6, 0.55),
  when((query) => query.naturalLanguage || query.multiline, 0.45),
  when((query) => query.url || query.path || query.shellSyntax || query.flags, 0.1),
  when((query) => query.words.length === 1, 0.2),
  () => 0.35
)
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
        relevance: askRelevance,
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
        relevance: askRelevance,
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
