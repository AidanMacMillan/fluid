/**
 * Turning what somebody typed into somewhere to go.
 *
 * Two places take free text and have to load something: the address bar over a
 * page, and the launcher that opens a new tab. Both owe the user the same
 * answer — an address is an address, and anything else is a search — so the
 * rule lives here rather than being written twice and drifting.
 */

/** A fully spelled-out address, whatever its scheme. Taken at its word. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * A bare host with an optional port and path — `example.com`, `localhost:5173`,
 * `192.168.1.4/status`. Deliberately narrow: whatever it turns down is
 * searched for instead, which is what a browser does with it anyway.
 */
const BARE_HOST =
  /^(localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#]\S*)?$/i

/** Loopback, which a dev server answers over plain http and not TLS. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3})(:\d+)?([/?#]|$)/i

/** Where anything that is not an address goes. Same engine as `DEFAULT_BROWSER_URL`. */
const SEARCH_URL = 'https://www.google.com/search?q='

/** Whether `input` names somewhere in particular, rather than something to look up. */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  return ABSOLUTE_URL.test(text) || BARE_HOST.test(text)
}

/** A search for `query`, as the address that runs it. */
export function searchUrl(query: string): string {
  return `${SEARCH_URL}${encodeURIComponent(query.trim())}`
}

/**
 * What to load for whatever was typed or pasted in: the address itself when it
 * is one, and a search for it when it is not. Null for an empty field, which is
 * nowhere to go.
 */
export function resolveInput(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (ABSOLUTE_URL.test(text)) return text
  // https for the web, http for a dev server: `localhost:5173` over TLS is a
  // failed handshake, and it is the one address this app is typed at daily.
  if (BARE_HOST.test(text)) return `${LOOPBACK.test(text) ? 'http' : 'https'}://${text}`
  return searchUrl(text)
}

/**
 * The site an address belongs to — scheme, host and port, no path. Null for
 * anything that is not a web address, which is what the icon cache is keyed by
 * and so what it declines to answer for.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/** The address as a browser shows it: no scheme, no `www.`, no bare trailing slash. */
export function displayUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    const host = parsed.host.replace(/^www\./, '')
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return raw
  }
}
