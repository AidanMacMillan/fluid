import type { SchemeDeclaration } from '@fluid/sdk'
import { getToken } from './token'

/**
 * Serving Slack's pictures to the renderer.
 *
 * Two things stand between an `<img src>` and a Slack avatar. The renderer's
 * content security policy allows images from `self`, `data:` and the app's own
 * schemes and nothing else (see src/renderer/index.html) — and a file on
 * `files.slack.com` needs the user's token in an `Authorization` header, which
 * an image element cannot send and which has no business being in the renderer
 * to begin with.
 *
 * So pictures go the same way dropped files do: over a scheme of the app's own,
 * fetched by the main process, which is the only side that holds the token.
 *
 * Nothing is cached to disk. Every URL Slack hands out is either immutable or
 * signed, so the response simply says how long Chromium may keep it and the
 * browser cache does the rest.
 */

/**
 * The scheme. A second one rather than reusing `fluid-file:`, because the two
 * are different promises: that one serves bytes the app has taken a copy of and
 * owns, this one proxies somebody else's server on demand.
 */
export const SLACK_MEDIA_SCHEME = 'slack-media'

/**
 * Hosts this will fetch from, matched on the suffix so that subdomains are
 * covered. The allowlist is the whole of the security here: without it the
 * renderer could name any URL in the world and have the main process fetch it —
 * with the user's Slack token attached, for anything that looked close enough.
 */
const ALLOWED_HOST_SUFFIXES = ['.slack.com', '.slack-edge.com', '.slack-imgs.com']

/**
 * Hosts the token is actually sent to. The CDNs serve avatars and emoji without
 * authentication, and a credential handed to a host that does not need it is a
 * credential handed out for no reason.
 */
const AUTHENTICATED_HOST_SUFFIXES = ['.slack.com']

/** How long Chromium may reuse a fetched picture. Slack's asset URLs are content-addressed. */
const CACHE_SECONDS = 7 * 24 * 60 * 60

/** A picture that takes longer than this is not one worth waiting on. */
const REQUEST_TIMEOUT_MS = 20_000

function hostAllowed(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase()
  return suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

/**
 * The URL the renderer loads a Slack picture from. The original is carried in
 * the path, base64url encoded — opaque enough that nothing is tempted to parse
 * it, and safe in a URL without further escaping.
 *
 * Mirrored by `slackMediaUrl` in the renderer, which builds these without a
 * round trip. Keep the two in step.
 */
export function slackMediaUrl(url: string): string {
  return `${SLACK_MEDIA_SCHEME}://media/${Buffer.from(url, 'utf8').toString('base64url')}`
}

/**
 * What this scheme needs to be granted. Registered by src/main/schemes.ts
 * together with the file store's, because Electron takes one such declaration
 * for the whole process.
 */
export const SLACK_MEDIA_SCHEME_PRIVILEGES: SchemeDeclaration = {
  scheme: SLACK_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

/** Serves Slack's pictures over `slack-media://`. Called once the app is ready. */
export async function serveSlackMedia(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url)
  const encoded = decodeURIComponent(pathname).replace(/^\//, '')

  let target: URL
  try {
    target = new URL(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return new Response('Not found', { status: 404 })
  }

  // Both halves matter: a `http:` URL to an allowed host would downgrade the
  // fetch, and an allowed-looking host on another scheme is not Slack at all.
  if (target.protocol !== 'https:' || !hostAllowed(target.hostname, ALLOWED_HOST_SUFFIXES)) {
    return new Response('Refused', { status: 403 })
  }

  const headers: Record<string, string> = {}
  if (hostAllowed(target.hostname, AUTHENTICATED_HOST_SUFFIXES)) {
    const token = getToken()
    if (token === undefined) return new Response('Slack is not connected', { status: 401 })
    headers.Authorization = `Bearer ${token}`
  }

  // Range requests are passed straight through rather than interpreted the
  // way the file store interprets them: the far end is a real HTTP server
  // that answers them properly, so there is nothing to reconstruct.
  const range = request.headers.get('Range')
  if (range) headers.Range = range

  let response: Response
  try {
    response = await fetch(target.toString(), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    console.warn(`Could not fetch Slack media from ${target.hostname}:`, error)
    return new Response('Upstream failed', { status: 502 })
  }

  const out = new Headers()
  // Copied one by one rather than wholesale: Slack sets cookies and its own
  // caching rules on these responses, and neither belongs in the renderer.
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(name)
    if (value !== null) out.set(name, value)
  }
  // Only a successful body is worth keeping; an error page cached for a week
  // would outlive whatever caused it.
  if (response.ok) out.set('Cache-Control', `private, max-age=${CACHE_SECONDS}, immutable`)

  return new Response(response.body, { status: response.status, headers: out })
}
