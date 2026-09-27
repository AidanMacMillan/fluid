import { defineViews, type ExtensionViews } from '@fluid/sdk'
import { mount } from 'svelte'
import { isAgentTab, type AgentProvider, type AgentTab } from '../shared/tab'
import AgentPane from './components/AgentPane.svelte'
export function createAgentViews(provider: AgentProvider): ExtensionViews {
  return defineViews({
    id: provider.id,
    tabs: {
      session: {
        mount: (target, { tab, host }) => {
          if (!isAgentTab(tab, provider)) return
          const props = $state<{ tab: AgentTab; host: typeof host; provider: AgentProvider }>({
            tab,
            host,
            provider
          })
          host.api.watch('tabs.get', { id: tab.id }, (current) => {
            if (current && isAgentTab(current, provider)) props.tab = current
          })
          mount(AgentPane, { target, props })
        }
      }
    }
  })
}
