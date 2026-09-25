import { context } from './context'

/**
 * The user's Slack token, in the extension's own secrets (encrypted with the OS
 * keychain by the app). Only this module reads it.
 *
 * A *user* token, not a bot one: everything the extension does in Slack it does
 * as the user — reading the channels they are in, reacting, replying — and a bot
 * token cannot do any of that as them. See the note at the top of slack.ts.
 */
const SECRET = 'userToken'

/** What the settings card draws. Never the token. */
export type TokenStatus = {
  /**
   * Whether this computer can store a credential securely at all. False means
   * there is no point offering the field: saving would be refused.
   */
  available: boolean
  /** Whether a token is stored. */
  configured: boolean
  /** When it was last saved, ISO 8601, or null when none is stored. */
  updatedAt: string | null
}

export function tokenStatus(): TokenStatus {
  return context().secrets.status(SECRET)
}

/**
 * Stores the token. The shape is not checked beyond being non-empty: only Slack
 * can say whether a token is good, and rejecting one that does not look the way
 * today's tokens look would be a guess that ages badly.
 */
export function setToken(token: string): TokenStatus {
  const trimmed = token.trim()
  if (trimmed === '') throw new Error('Enter a user OAuth token.')
  context().secrets.set(SECRET, trimmed)
  return tokenStatus()
}

export function clearToken(): TokenStatus {
  context().secrets.delete(SECRET)
  return tokenStatus()
}

/**
 * The token, for code calling Slack on the user's behalf. The one door out of
 * the vault, and it opens into the main process only: there is no RPC method
 * that hands a stored token back.
 */
export function getToken(): string | undefined {
  return context().secrets.get(SECRET) ?? undefined
}
