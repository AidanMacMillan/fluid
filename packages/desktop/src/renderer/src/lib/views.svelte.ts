import type { WebViewReadiness } from '../../../main/extension-views'
import { extensions } from './extensions.svelte'

/**
 * What the main process has said about tabs' native views that is only true of
 * this run — kept per tab id, and here rather than in any one pane because a
 * split draws several panes at once and a pane is let go of whenever its tab
 * leaves the screen. Switching away and back asks nothing again, and a tab
 * whose view failed goes on saying why. The listeners that fill it are
 * BrowserSurface's.
 */
class Views {
  /**
   * What each extension tab drawn as a web application was told when it asked
   * where its view should point: that there is somewhere, or why not. Absent
   * while it is still being worked out, which is also what the placeholder
   * says.
   *
   * Asked rather than stored on the tab because it is only true of this run —
   * the address is whatever serves the application now, and may carry a token
   * of its own; the main process keeps it and this only hears whether there is
   * one.
   */
  webViews = $state<Record<string, WebViewReadiness>>({})

  /**
   * Extension tabs whose view crashed, by tab id, with the reason Chromium
   * gave. The view is already gone; the pane says so until the user asks for
   * it back, and asking is taking the tab out of here, which shows it again.
   */
  goneViews = $state<Record<string, string>>({})

  /**
   * The tab floating in a window of its own (Cmd+Shift+P), if one is. Its page
   * is in that window rather than this one, so its pane says so — the way a
   * site whose call has gone to picture-in-picture leaves a note where the
   * call was, rather than an empty frame.
   */
  poppedOutTabId = $state<string | null>(null)

  /**
   * Every tab with a floating window up — floating whole, or in a miniplayer —
   * each with a bar across its top that names it.
   */
  floatingTabIds = $state<string[]>([])

  /**
   * The tabs already asked about, answered or not, so each is asked once — and
   * the type each was asked as, for letting go of them when it goes. A record
   * of requests made, not state: nothing is drawn from it.
   */
  private asked = new Map<string, string>()

  /**
   * Asks where a web view should point for a tab that has just been looked at,
   * once.
   *
   * Can take minutes rather than seconds: the extension may be starting
   * whatever serves the application, and on its first run that may download
   * itself. Nothing here hurries that along — the pane says what is happening
   * and the answer arrives when it arrives.
   */
  prepare(tabId: string, type: string): void {
    if (this.asked.has(tabId)) return
    this.asked.set(tabId, type)
    void window.api.browser.prepareExtension(tabId, type).then((result) => {
      if (this.asked.has(tabId)) this.webViews[tabId] = result
    })
  }

  /** A view crashed and took its address with it; showing the tab again asks anew. */
  gone(tabId: string, reason: string): void {
    this.goneViews[tabId] = reason
    this.forget(tabId)
  }

  /** The user asked for a crashed view back. */
  revive(tabId: string): void {
    delete this.goneViews[tabId]
  }

  /**
   * An extension that stops takes its views, and their addresses, with it; an
   * answer kept from before would put up nothing once it is running again.
   */
  sweep(): void {
    for (const [tabId, type] of this.asked) {
      if (extensions.tabViewKind(type) !== 'web') this.forget(tabId)
    }
  }

  /** Lets go of what a web view was told, so the next showing asks again. */
  private forget(tabId: string): void {
    this.asked.delete(tabId)
    delete this.webViews[tabId]
  }
}

export const views = new Views()
