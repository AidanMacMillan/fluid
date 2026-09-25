import type { ExtensionContext } from '@fluid/sdk'
import type { ChannelHistory, SlackIdentity, SlackMessage, SlackUser } from './main/slack'

/**
 * The Slack extension as other extensions use it: a typed client over the
 * `rpc` methods it exposes, the thread tab they can open, and the shapes both
 * hand back.
 *
 * Only types and pure helpers live here, so importing this pulls in nothing
 * that talks to Slack. Every call goes through the app to the running Slack
 * extension, which holds the token; the caller never sees it.
 */

export type {
  ChannelHistory,
  SlackIdentity,
  SlackMessage,
  SlackReaction,
  SlackUser
} from './main/slack'
export {
  isSlackThreadTab,
  SLACK_THREAD_TAB,
  type SlackThreadTab,
  type SlackThreadTabPayload
} from './shared/tab-types'

export const SLACK_EXTENSION_ID = 'slack'

/** What the Slack extension offers another extension. */
export type SlackService = {
  /**
   * Whether a token is stored. False, rather than a rejection, when the Slack
   * extension is disabled: either way there is nobody to ask.
   */
  connected(): Promise<boolean>
  /** Who the token belongs to. Cached by the extension for the life of the process. */
  identity(): Promise<SlackIdentity>
  /** Messages posted to a conversation after `after`, oldest first. */
  history(channelId: string, after: string): Promise<ChannelHistory>
  /** The message a thread hangs off, or undefined when the thread is gone. */
  threadParent(channelId: string, threadTs: string): Promise<SlackMessage | undefined>
  /** Everyone in the workspace, by id. Cached by the extension for hours. */
  directory(): Promise<Record<string, SlackUser>>
  /**
   * A picture on Slack's hosts as a URL the app's pages can load: an avatar
   * from `directory`, say. Slack's own hosts are not loadable from there.
   */
  mediaUrl(url: string): Promise<string>
  /**
   * One of the workspace's custom emoji as a picture the app's pages can load,
   * or null when there is none by that name. `name` carries no colons. Standard
   * emoji are not Slack's to serve, so they always come back null.
   */
  emojiUrl(name: string): Promise<string | null>
  /** A thread's address in Slack, for a tab's `pinnedUrl`. */
  permalink(channelId: string, threadTs: string): Promise<string>
  /**
   * Puts one of the user's reactions on a message. `name` carries no colons,
   * the way Slack's API spells it. Rejects with Slack's `already_reacted` when
   * the user had already put it there, which a caller that only wants it on
   * can treat as done.
   */
  react(channelId: string, messageTs: string, name: string): Promise<void>
}

/** A client for the Slack extension, reached through `ctx.extensions`. */
export function slackService(extensions: ExtensionContext['extensions']): SlackService {
  const call = <T>(method: string, input?: unknown): Promise<T> =>
    extensions.call<T>(SLACK_EXTENSION_ID, method, input)
  return {
    connected: () => call<boolean>('connected').catch(() => false),
    identity: () => call('identity'),
    history: (channelId, after) => call('history', { channelId, after }),
    threadParent: (channelId, threadTs) => call('threadParent', { channelId, threadTs }),
    directory: () => call('directory'),
    mediaUrl: (url) => call('mediaUrl', { url }),
    emojiUrl: (name) => call('emojiUrl', { name }),
    permalink: (channelId, threadTs) => call('permalink', { channelId, threadTs }),
    react: (channelId, messageTs, name) => call('react', { channelId, messageTs, name, on: true })
  }
}

/**
 * The code Slack refused a call with — `not_in_channel`, `ratelimited` — when
 * that is why it failed. Read off the error rather than tested with
 * `instanceof`, since the class is the Slack extension's and not the caller's.
 */
export function slackErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'SlackError') return undefined
  const { code } = error as Error & { code?: unknown }
  return typeof code === 'string' ? code : undefined
}

/**
 * A moment as Slack writes timestamps: whole seconds, then six decimal places.
 *
 * Slack's own `ts` values are message ids as much as times, and no message will
 * ever carry one of these. As a bound, though, it is only ever compared against
 * them, and that comparison is numeric — so a wall-clock reading is a perfectly
 * good place to start reading a channel from.
 */
export function slackTimestamp(epochMs: number): string {
  return (epochMs / 1000).toFixed(6)
}
