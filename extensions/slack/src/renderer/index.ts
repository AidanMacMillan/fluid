import {
  defineRendererExtension,
  type NewTab,
  type NewTaskTemplate,
  type RendererHost
} from '@fluid/sdk'
import type { Component } from 'svelte'
import { parseSlackMessageUrl, type SlackMessageRef } from '../main/slack-links'
import type { ThreadSummary } from '../main/slack-thread'
import { isSlackThreadTab, SLACK_THREAD_TAB, type SlackThreadTabPayload } from '../shared/tab-types'

/**
 * The Slack extension's half in the app's windows: how a thread tab's row
 * reads, and the launcher rows that open one from a pasted link — as a tab, or
 * as a new task about it. The thread itself, and the settings section that
 * connects Slack, are drawn in views of their own; see ../views.
 */

/** What a thread tab holds, for a thread Slack may or may not have described yet. */
function threadPayload(ref: SlackMessageRef, summary: ThreadSummary | null): SlackThreadTabPayload {
  return {
    channelId: ref.channelId,
    threadTs: ref.threadTs,
    // Only worth storing when it points somewhere other than the thread's own
    // first message, which is the only case the pane does anything with it.
    ...(ref.messageTs !== ref.threadTs ? { focusTs: ref.messageTs } : {}),
    ...(summary
      ? {
          channelLabel: summary.channelLabel,
          authorName: summary.authorName,
          excerpt: summary.excerpt
        }
      : {})
  }
}

/**
 * The thread a link points at, as a tab named before it is made rather than
 * after: the row would otherwise read `Slack thread` until the pane had
 * loaded, and on a launch with no network it would read that for ever. A
 * summary that cannot be had is not a reason to refuse the tab.
 */
async function threadTab(
  ref: SlackMessageRef,
  host: RendererHost
): Promise<{ tab: NewTab; summary: ThreadSummary | null }> {
  const summary = await host
    .call<ThreadSummary | null>('summarise', { channelId: ref.channelId, threadTs: ref.threadTs })
    .catch((error: unknown) => {
      console.warn('Could not name the Slack thread being opened:', error)
      return null
    })
  return {
    tab: { type: SLACK_THREAD_TAB, title: null, payload: threadPayload(ref, summary) },
    summary
  }
}

const PROMPT = {
  placeholder: 'Paste a Slack message link',
  rejection: 'That is not a link to a Slack message.'
}

export default defineRendererExtension<Component<never>>({
  id: 'slack',

  tabs: {
    thread: {
      icon: 'icon-[logos--slack-icon]',
      // The channel is what tells one thread from another at a glance, and the
      // person who started it is what tells two threads in the same channel
      // apart. Before either is known the excerpt beats nothing, and the
      // channel id is the last resort.
      label: (tab) => {
        if (!isSlackThreadTab(tab)) return null
        const { channelLabel, authorName, excerpt, channelId } = tab.payload
        if (channelLabel && authorName) return `${channelLabel} — ${authorName}`
        return channelLabel || authorName || excerpt || channelId
      },
      tooltip: (tab) => (isSlackThreadTab(tab) ? (tab.payload.excerpt ?? null) : null)
    }
  },

  launcher: [
    {
      id: 'thread',
      label: 'Slack thread',
      icon: 'icon-[logos--slack-icon]',
      // A pasted link opens a thread without this row ever being touched, which
      // is the quick path. The row is here for everybody who has not discovered
      // that — a thing the panel can do is not a thing it does until it is listed.
      keywords: ['message', 'conversation', 'reply', 'dm', 'channel', 'discussion'],
      prompt: PROMPT,
      parse: (text) => parseSlackMessageUrl(text),
      open: async (value, host): Promise<NewTab> =>
        (await threadTab(value as SlackMessageRef, host)).tab
    }
  ],

  newTask: [
    {
      id: 'thread',
      label: 'Slack thread',
      icon: 'icon-[logos--slack-icon]',
      keywords: ['message', 'conversation', 'reply', 'dm', 'channel', 'discussion'],
      // The same link, pasted into the new-task panel, starts a task on the
      // thread — named after what it says, which is what the work is about,
      // and failing that after where it was said.
      prompt: PROMPT,
      parse: (text) => parseSlackMessageUrl(text),
      open: async (value, host): Promise<NewTaskTemplate> => {
        const { tab, summary } = await threadTab(value as SlackMessageRef, host)
        const title = summary?.excerpt || summary?.channelLabel
        return { ...(title ? { title } : {}), tabs: [tab] }
      }
    }
  ]
})
