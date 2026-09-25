import { defineViews } from '@fluid/sdk'
import { mount } from 'svelte'
import SlackThreadPane from '../renderer/components/SlackThreadPane.svelte'
import SlackSettings from '../renderer/settings/SlackSettings.svelte'
import { isSlackThreadTab, type SlackThreadTab } from '../shared/tab-types'

/**
 * The Slack extension's views: what it draws in pages of its own rather than
 * in the app's window. The thread tab, and its section of the settings window,
 * which connects Slack.
 *
 * A view is handed its tab once. The pane was written for a window, where the
 * tab it is given moves as the workspace does — a summary written back into
 * the payload, a title — so the tab is kept current here, from the API, and
 * the pane is none the wiser.
 */
export default defineViews({
  id: 'slack',

  settings: {
    mount: (target, { host }) => {
      mount(SlackSettings, { target, props: { host } })
    }
  },

  tabs: {
    thread: {
      mount: (target, { tab, host }) => {
        if (!isSlackThreadTab(tab)) return
        // The page is this view's alone, so it can scroll the way a page does:
        // the thread rubber-bands at either end.
        // The app's stylesheet stops the page scrolling at all, which a window
        // wants and this view does not; an inline style on the root is what
        // outranks it, whatever order the CSS loads in.
        for (const element of [document.documentElement, document.body]) {
          element.style.overflow = 'auto'
          element.style.overscrollBehavior = 'auto'
        }
        const props = $state<{ tab: SlackThreadTab; host: typeof host }>({ tab, host })
        host.api.watch('tabs.get', { id: tab.id }, (current) => {
          if (current && isSlackThreadTab(current)) props.tab = current
        })
        mount(SlackThreadPane, { target, props })
      }
    }
  }
})
