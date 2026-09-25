import { defineViews } from '@fluid/sdk'
import { mount } from 'svelte'
import { isTerminalTab, type TerminalTab } from '../shared/tab'
import TerminalPane from './TerminalPane.svelte'

/**
 * The terminal extension's view: a shell, drawn in a page of its own.
 *
 * A view is handed its tab once. The main half writes the shell's directory
 * into the tab as it moves, so the tab is kept current here, from the API, and
 * the pane reads each `cd` as the tab changing.
 */
export default defineViews({
  id: 'terminal',

  tabs: {
    shell: {
      mount: (target, { tab, host }) => {
        if (!isTerminalTab(tab)) return
        const props = $state<{ tab: TerminalTab; host: typeof host }>({ tab, host })
        host.api.watch('tabs.get', { id: tab.id }, (current) => {
          if (current && isTerminalTab(current)) props.tab = current
        })
        mount(TerminalPane, { target, props })
      }
    }
  }
})
