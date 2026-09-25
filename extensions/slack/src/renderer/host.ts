import type { RendererHost } from '@fluid/sdk'
import type { ThreadSummary, ThreadUser, ThreadView } from '../main/slack-thread'
import type { TokenStatus } from '../main/token'

/**
 * The window this half of the extension runs in, as the app hands it over.
 *
 * Every component the app draws for the extension is given the host as a prop;
 * the outermost ones hand it here so the rest — and the helpers below — can
 * reach it without threading it through every component in between.
 */
let current: RendererHost | null = null

export function setHost(host: RendererHost): void {
  current = host
}

export function host(): RendererHost {
  if (!current) throw new Error('The Slack extension has not been given its host yet.')
  return current
}

export const reasonFrom = (error: unknown): string => host().reasonFrom(error)

/**
 * The extension's own main-process methods, typed. Everything here is a call to
 * one of the `ctx.rpc` handlers registered in ../index.ts.
 */
export const slackApi = {
  connected: (): Promise<boolean> => host().call('connected'),
  thread: (channelId: string, threadTs: string): Promise<ThreadView> =>
    host().call('thread', { channelId, threadTs }),
  summarise: (channelId: string, threadTs: string): Promise<ThreadSummary | null> =>
    host().call('summarise', { channelId, threadTs }),
  users: (): Promise<ThreadUser[]> => host().call('users'),
  emoji: (): Promise<Record<string, string>> => host().call('emoji'),
  react: (channelId: string, messageTs: string, name: string, on: boolean): Promise<void> =>
    host().call('react', { channelId, messageTs, name, on }),
  reply: (channelId: string, threadTs: string, body: string): Promise<void> =>
    host().call('reply', { channelId, threadTs, body }),
  markRead: (channelId: string, messageTs: string): Promise<void> =>
    host().call('markRead', { channelId, messageTs })
}

export const tokenApi = {
  status: (): Promise<TokenStatus> => host().call('token.status'),
  set: (token: string): Promise<TokenStatus> => host().call('token.set', token),
  clear: (): Promise<TokenStatus> => host().call('token.clear'),
  /** Null when the sign-in was cancelled. */
  connect: (): Promise<TokenStatus | null> => host().call('oauth.connect'),
  cancel: (): Promise<void> => host().call('oauth.cancel')
}
