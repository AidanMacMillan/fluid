import { defineExtension, type ViewConnection } from '@fluid/sdk'
import { setContext } from './main/context'
import {
  channelMessagesSince,
  customEmoji,
  forgetSlackCaches,
  revokeToken,
  slackConnected,
  slackIdentity,
  threadParent,
  userDirectory
} from './main/slack'
import { slackArchiveUrl } from './main/slack-links'
import {
  SLACK_MEDIA_SCHEME,
  SLACK_MEDIA_SCHEME_PRIVILEGES,
  serveSlackMedia,
  slackMediaUrl
} from './main/slack-media'
import {
  markThreadRead,
  mentionableUsers,
  openThreadInSlack,
  readThread,
  replyToThread,
  summariseThread,
  threadEmoji,
  toggleReaction
} from './main/slack-thread'
import { cancelSlackConnect, connectSlack } from './main/oauth'
import { clearToken, setToken, tokenStatus } from './main/token'
import { isSlackThreadTab, type SlackThreadViewMessage } from './shared/tab-types'

/**
 * Slack threads as tabs: read one, react to it and reply to it, as the user.
 *
 * The token lives in the extension's own secrets, and nothing it exposes hands
 * it back. Its renderer half draws the thread (see ./views) and the launcher
 * row that opens one from a pasted link (see ./renderer). Other extensions
 * reach it through the methods in ./api.ts, which is how a routine reading
 * channels gets at Slack without holding a token of its own.
 */

/** Checks an RPC argument is a string, since RPC input arrives unvalidated. */
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Expected ${name}.`)
  return value
}

type Args = Record<string, unknown>

const args = (input: unknown): Args =>
  typeof input === 'object' && input !== null ? (input as Args) : {}

export default defineExtension({
  id: 'slack',
  name: 'Slack',
  description: 'Read and reply to Slack threads in tabs, as you.',
  schemes: [SLACK_MEDIA_SCHEME_PRIVILEGES],

  // A section of the settings window, drawn by ../views: connecting Slack.
  settings: {},

  activate(ctx) {
    setContext(ctx)
    ctx.onDispose(() => {
      forgetSlackCaches()
      setContext(null)
    })

    // Every thread view that is up, by tab, so the tab's menu can reach the
    // pane it belongs to. Usually one; more than one only while a view is
    // being replaced.
    const views = new Map<string, Set<ViewConnection>>()
    ctx.views.onConnect('thread', (connection) => {
      const open = views.get(connection.tabId) ?? new Set()
      open.add(connection)
      views.set(connection.tabId, open)
      connection.onDisconnect(() => {
        open.delete(connection)
        if (open.size === 0 && views.get(connection.tabId) === open) views.delete(connection.tabId)
      })
    })

    ctx.tabTypes.register({
      id: 'thread',
      label: 'Slack thread',
      // Drawn in a view of its own (see ./views). It claims no keys: the
      // composer sends on a plain Enter, which the menu never binds.
      view: {},
      // The thread's permalink. A thread cannot wander, but a link to it found
      // in a page should lead to the tab the task already has.
      pinnedUrl: async (tab) => {
        if (!isSlackThreadTab(tab)) return null
        const identity = await slackIdentity()
        return slackArchiveUrl(identity.url, {
          channelId: tab.payload.channelId,
          threadTs: tab.payload.threadTs
        })
      },
      // Where the pane's bar used to be. Refresh only means something while the
      // thread is drawn: a tab that has not been shown yet reads it fresh anyway.
      menu: (tab) => {
        if (!isSlackThreadTab(tab)) return []
        const { channelId, threadTs, focusTs } = tab.payload
        const open = views.get(tab.id)
        return [
          {
            label: 'Refresh',
            enabled: open !== undefined,
            click: () => {
              const message: SlackThreadViewMessage = { type: 'refresh' }
              for (const connection of open ?? []) connection.post(message)
            }
          },
          { label: 'Open in Slack', click: () => openThreadInSlack(channelId, threadTs, focusTs) }
        ]
      }
    })

    ctx.protocols.handle(SLACK_MEDIA_SCHEME, serveSlackMedia)

    const rpc = ctx.rpc

    // What the extension's own interface asks of it. The renderer never sees a
    // token, a Slack URL or a raw API response: a thread arrives assembled for
    // drawing, with every picture pointed at the extension's own scheme.
    rpc.handle('thread', (input) => {
      const { channelId, threadTs } = args(input)
      return readThread(text(channelId, 'a channel'), text(threadTs, 'a thread'))
    })
    rpc.handle('summarise', (input) => {
      const { channelId, threadTs } = args(input)
      return summariseThread(text(channelId, 'a channel'), text(threadTs, 'a thread'))
    })
    rpc.handle('users', () => mentionableUsers())
    rpc.handle('emoji', () => threadEmoji())
    rpc.handle('react', (input) => {
      const { channelId, messageTs, name, on } = args(input)
      return toggleReaction(
        text(channelId, 'a channel'),
        text(messageTs, 'a message'),
        text(name, 'an emoji'),
        on === true
      )
    })
    rpc.handle('reply', (input) => {
      const { channelId, threadTs, body } = args(input)
      return replyToThread(
        text(channelId, 'a channel'),
        text(threadTs, 'a thread'),
        text(body, 'a reply')
      )
    })
    rpc.handle('markRead', (input) => {
      const { channelId, messageTs } = args(input)
      return markThreadRead(text(channelId, 'a channel'), text(messageTs, 'a message'))
    })

    // The token goes one way only: the settings card can write one (pasted, or
    // by signing in) and ask whether one exists, and there is deliberately no
    // method that hands a stored token back. Slack's caches describe the old
    // token either way; keeping them would leave the extension believing it is
    // whoever it was before.
    rpc.handle('token.status', () => tokenStatus())
    rpc.handle('token.set', (input) => {
      const status = setToken(text(input, 'a token'))
      forgetSlackCaches()
      return status
    })
    rpc.handle('token.clear', async () => {
      await revokeToken()
      const status = clearToken()
      forgetSlackCaches()
      return status
    })
    // Signing in instead of pasting: resolves once the browser has come back
    // and the token is stored, or with null when the sign-in was cancelled.
    rpc.handle('oauth.connect', async () => {
      const status = await connectSlack()
      if (status !== null) forgetSlackCaches()
      return status
    })
    rpc.handle('oauth.cancel', () => cancelSlackConnect())

    // What other extensions ask of it; see ./api.ts, which is the typed side
    // of these. Raw Slack shapes are fine here, since the callers are main
    // process code that has always read them.
    rpc.handle('connected', () => slackConnected())
    rpc.handle('identity', () => slackIdentity())
    rpc.handle('history', (input) => {
      const { channelId, after } = args(input)
      return channelMessagesSince(text(channelId, 'a channel'), text(after, 'a timestamp'))
    })
    rpc.handle('threadParent', (input) => {
      const { channelId, threadTs } = args(input)
      return threadParent(text(channelId, 'a channel'), text(threadTs, 'a thread'))
    })
    rpc.handle('directory', () => userDirectory())
    rpc.handle('mediaUrl', (input) => slackMediaUrl(text(args(input).url, 'a URL')))
    rpc.handle('emojiUrl', async (input) => {
      const url = (await customEmoji())[text(args(input).name, 'an emoji')]
      return url !== undefined ? slackMediaUrl(url) : null
    })
    rpc.handle('permalink', async (input) => {
      const { channelId, threadTs } = args(input)
      const identity = await slackIdentity()
      return slackArchiveUrl(identity.url, {
        channelId: text(channelId, 'a channel'),
        threadTs: text(threadTs, 'a thread')
      })
    })
  }
})
