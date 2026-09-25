import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CONNECT_PATH,
  LOOPBACK_PATH,
  TOKEN_PATH,
  type OAuthError,
  type TokenRequest,
  type TokenResponse
} from '../shared/oauth'
import { context } from './context'
import { setToken, type TokenStatus } from './token'

/**
 * Connecting Slack by signing in, rather than by pasting a token.
 *
 * The client secret lives in the OAuth server (`packages/app`), never here;
 * see ../shared/oauth.ts for the flow end to end. This half makes the PKCE
 * verifier and keeps it, listens on 127.0.0.1 for the browser to come back,
 * and redeems the code it brings. The token arrives in the body of an HTTPS
 * response and goes straight into the vault through `setToken`.
 */

/**
 * The OAuth server. `FLUID_APP_URL` points a development build at a local
 * `wrangler dev` instead.
 */
const DEFAULT_SERVER = 'https://fluid-app.<account>.workers.dev'

function server(): string {
  return (process.env.FLUID_APP_URL ?? DEFAULT_SERVER).replace(/\/$/, '')
}

/**
 * How long the listener waits for the browser. Long enough to sign in to
 * Slack from scratch; short enough that a tab closed halfway does not leave a
 * port open all afternoon.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

const REQUEST_TIMEOUT_MS = 15_000

/** Raised in place of a result when the flow was cancelled; see `connectSlack`. */
class Cancelled extends Error {}

/** The flow in progress, if one is: only ever one, so a second Connect replaces the first. */
let pending: { cancel: () => void } | null = null

/**
 * Signs in to Slack in the browser and stores the token that comes back.
 * Resolves with the new status, or null if the flow was cancelled — by
 * `cancelSlackConnect`, or by a newer Connect replacing it.
 */
export async function connectSlack(): Promise<TokenStatus | null> {
  pending?.cancel()

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(24).toString('base64url')

  let settle!: { resolve: (token: TokenResponse) => void; reject: (reason: unknown) => void }
  const result = new Promise<TokenResponse>((resolve, reject) => (settle = { resolve, reject }))
  // Awaited below, but not if opening the browser fails first; a rejection
  // then would otherwise surface as unhandled.
  result.catch(() => undefined)

  const listener = createServer((request, response) => {
    void answer(request, response)
  })

  /**
   * One request finishes the flow: the browser coming back with this flow's
   * state. Anything else — another path, a stale tab, a request with somebody
   * else's state — is turned away and the listener keeps waiting, so a stray
   * request cannot end a sign-in, let alone plant a token.
   */
  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== LOOPBACK_PATH) {
      return page(response, 404, 'Not found', 'There is nothing here.')
    }
    if (url.searchParams.get('state') !== state) {
      return page(
        response,
        400,
        'This sign-in is not the current one',
        'Go back to Fluid and choose Connect Slack again.'
      )
    }

    const code = url.searchParams.get('code')
    const grant = url.searchParams.get('grant')
    if (!code || !grant) {
      const declined = url.searchParams.get('error') === 'access_denied'
      page(
        response,
        400,
        declined ? 'Slack was not connected' : 'Slack could not be connected',
        'You can close this tab and go back to Fluid.'
      )
      settle.reject(
        new Error(
          declined
            ? 'Slack access was declined.'
            : 'Slack did not finish the sign-in. Try connecting again.'
        )
      )
      return
    }

    try {
      const token = await redeem({ code, grant, verifier })
      page(response, 200, 'Slack is connected', 'You can close this tab and go back to Fluid.')
      settle.resolve(token)
    } catch (error) {
      page(response, 400, 'Slack could not be connected', 'Go back to Fluid to see why.')
      settle.reject(error)
    }
  }

  // Loopback only. Bound to every interface, the listener would take a code
  // from anybody on the same network who guessed the port.
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = listener.address() as AddressInfo

  const timeout = setTimeout(
    () => settle.reject(new Error('Signing in to Slack took too long. Try connecting again.')),
    SIGN_IN_TIMEOUT_MS
  )
  const flow = { cancel: () => settle.reject(new Cancelled()) }
  pending = flow

  try {
    const start = new URL(`${server()}${CONNECT_PATH}`)
    start.searchParams.set('challenge', challenge)
    start.searchParams.set('state', state)
    start.searchParams.set('port', String(port))
    await context().openExternal(start.href)

    const token = await result
    return setToken(token.token)
  } catch (error) {
    if (error instanceof Cancelled) return null
    throw error
  } finally {
    clearTimeout(timeout)
    if (pending === flow) pending = null
    listener.close()
    listener.closeAllConnections()
  }
}

/** Stops waiting for the browser. The pending `connectSlack` resolves with null. */
export function cancelSlackConnect(): void {
  pending?.cancel()
}

async function redeem(request: TokenRequest): Promise<TokenResponse> {
  const response = await fetch(`${server()}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const body = (await response.json().catch(() => null)) as TokenResponse | OAuthError | null
  if (!response.ok || body === null || !('token' in body)) {
    const message = body !== null && 'message' in body ? body.message : null
    throw new Error(message ?? `The Slack sign-in server returned HTTP ${response.status}.`)
  }
  return body
}

/**
 * The page the browser tab is left on. Fixed strings only: nothing from the
 * request is written into it.
 */
function page(response: ServerResponse, status: number, title: string, detail: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close'
  })
  response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #52525b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #f4f4f5; --muted: #a1a1aa; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
         color: var(--fg); font: 15px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 28rem; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body>
</html>`)
}
