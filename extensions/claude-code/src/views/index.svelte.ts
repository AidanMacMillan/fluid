import { defineViews } from '@fluid/sdk'
import { mount } from 'svelte'
import { isClaudeTab, type ClaudeTab } from '../shared/tab'
import ClaudePane from './components/ClaudePane.svelte'

/**
 * The Claude Code extension's view: a session, drawn in a page of its own.
 *
 * A view is handed its tab once. The session writes back into the tab as it
 * goes — which conversation it is, how its controls are set, what it is
 * called — so the tab is kept current here, from the API, and the pane reads
 * each of those as the tab changing.
 */
export default defineViews({
  id: 'claude-code',

  tabs: {
    session: {
      mount: (target, { tab, host }) => {
        if (!isClaudeTab(tab)) return
        const props = $state<{ tab: ClaudeTab; host: typeof host }>({ tab, host })
        host.api.watch('tabs.get', { id: tab.id }, (current) => {
          if (current && isClaudeTab(current)) props.tab = current
        })
        mount(ClaudePane, { target, props })
      }
    }
  }
})
