import type { ExtensionTab, Tab } from '@fluid/sdk'

/**
 * The tab type the Slack extension contributes, shared by its main and renderer
 * halves and by any other extension that opens a thread tab of its own.
 */

/** The tab type a Slack conversation is stored under. */
export const SLACK_THREAD_TAB = 'slack.thread'

/**
 * One Slack conversation, opened as a tab.
 *
 * What identifies it is the pair at the top: a channel and the `ts` of the
 * message the thread hangs off. Everything under them is a copy of something
 * Slack knows better, kept here for the same reason a browser tab keeps its
 * last page title — the sidebar has to draw a row for this tab before any
 * request has come back, and on a launch where Slack is unreachable it has to
 * draw one at all.
 */
export type SlackThreadTabPayload = {
  /** `C…` for a public channel, `G…` private, `D…` a direct message. */
  channelId: string
  /** The thread's first message's `ts`, which is the thread's id. */
  threadTs: string
  /**
   * The message the tab was opened on, when that was a reply rather than the
   * parent. The pane scrolls to it once; the thread itself is the whole thread.
   */
  focusTs?: string
  /**
   * What to call the conversation, ready to draw: `#deploys` for a channel,
   * somebody's name for a direct message.
   *
   * The label rather than the bare channel name, because the two are not the
   * same question and a row that assembles one from the other gets it wrong:
   * a direct message has no channel name at all, and prefixing a hash to the
   * person's name produces `#Aidan MacMillan`.
   */
  channelLabel?: string
  /** Who started the thread, as the row names it. */
  authorName?: string
  /** The first line or so of the opening message, for the row and the tooltip. */
  excerpt?: string
}

/**
 * A reply half written. It lives in view state rather than in the payload
 * because it is written continuously — a keystroke at a time, debounced — and
 * because losing it loses a draft rather than the tab. It is the one piece of
 * view state that is worth something, which is why it is worth storing at all:
 * a thread tab left open overnight should still have the sentence you were
 * part way through.
 */
export type SlackThreadViewState = {
  /**
   * The composer's contents as Slack would receive them, mentions already
   * encoded as `<@U024BE7LH>`. Stored in that form rather than as what the
   * composer draws so that nothing has to be re-resolved on the way back in.
   */
  draft: string
}
/**
 * What the main half says to a thread's view. Only the one thing, for now: the
 * tab's menu asking the pane to read the thread again.
 */
export type SlackThreadViewMessage = { type: 'refresh' }

export function isSlackThreadViewMessage(message: unknown): message is SlackThreadViewMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'refresh'
  )
}

export type SlackThreadTab = ExtensionTab<
  typeof SLACK_THREAD_TAB,
  SlackThreadTabPayload,
  SlackThreadViewState
>

export function isSlackThreadTab(tab: Tab): tab is SlackThreadTab {
  return tab.type === SLACK_THREAD_TAB
}
