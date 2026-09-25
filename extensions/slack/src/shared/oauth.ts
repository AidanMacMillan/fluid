/**
 * The contract between the extension and the OAuth server in `packages/app`,
 * which is the only place Slack's client secret lives.
 *
 * Pure, with no imports, because both sides read it: the extension's main
 * process builds these requests and the Worker checks them, and a rule stated
 * twice is a rule that drifts.
 *
 * The flow, end to end:
 *
 * 1. The extension makes a PKCE verifier, a `state`, and a loopback listener on
 *    127.0.0.1, then opens `CONNECT_PATH` in the browser with the verifier's
 *    challenge, the state and the listener's port.
 * 2. The Worker signs those into a ticket and sends the browser to Slack.
 * 3. Slack sends the browser back to the Worker's `CALLBACK_PATH`. The Worker
 *    checks the ticket, signs a grant binding Slack's code to the challenge,
 *    and redirects to the loopback listener with the code, the state and the
 *    grant.
 * 4. The extension checks the state and posts the code, the grant and the
 *    verifier to `TOKEN_PATH`. The Worker checks the grant covers that code and
 *    that the verifier hashes to its challenge, and only then redeems the code
 *    with Slack.
 *
 * So a code caught anywhere on the way is useless without the verifier, which
 * never leaves the machine that started the flow, and the token only ever
 * travels in the body of an HTTPS response to that machine.
 */

/** Where the browser is sent to start. */
export const CONNECT_PATH = '/slack/connect'
/** Where Slack sends the browser back to. Registered as the app's redirect URL. */
export const CALLBACK_PATH = '/slack/callback'
/** Where the extension redeems a code for a token. */
export const TOKEN_PATH = '/slack/token'
/** The path the loopback listener answers on. */
export const LOOPBACK_PATH = '/callback'

/**
 * A PKCE code challenge: the unpadded base64url SHA-256 of the verifier, which
 * is always 43 characters.
 */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** A PKCE code verifier, as RFC 7636 allows it. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

/**
 * The extension's own `state`. Opaque to the Worker, which only carries it
 * back; bounded so a ticket cannot be made to carry anything else.
 */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * The ports a loopback listener may be on. Only the port crosses to the
 * Worker, never a host: the Worker always redirects to 127.0.0.1, so it cannot
 * be talked into handing a code to anywhere else.
 */
export const MIN_LOOPBACK_PORT = 1024
export const MAX_LOOPBACK_PORT = 65535

/** What the extension posts to `TOKEN_PATH`, as JSON. */
export type TokenRequest = {
  code: string
  grant: string
  verifier: string
}

/** What `TOKEN_PATH` answers with when the code was redeemed. */
export type TokenResponse = {
  /** The user token, `xoxp-…`. */
  token: string
  /** The user scopes Slack granted, which can be fewer than were asked for. */
  scopes: string[]
  userId: string
  team: { id: string; name: string | null }
}

/**
 * What `TOKEN_PATH` answers with when it would not, and what the loopback
 * listener is sent in place of a code when Slack did not give one.
 * `error` is a short machine-readable reason, such as `access_denied`.
 */
export type OAuthError = { error: string; message: string }

export function isValidLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_LOOPBACK_PORT && port <= MAX_LOOPBACK_PORT
}
