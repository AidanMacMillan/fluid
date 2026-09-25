import { session, type Session } from 'electron'
import { listSiteIcons, putSiteIcon } from './db/site-icons'
import { partitionFor } from './browsing'

/**
 * What a site's icon is, for the rows drawn before its page is.
 *
 * A tab with a live view reports its own icon and needs nothing from here (see
 * `adoptFavicon` in browser-views). This is for the rest of the sidebar: pinned
 * tabs restored on launch, and released pinned tabs — rows that stand for a
 * page nobody has opened yet, and that would otherwise show a generic glyph
 * until the click that made the icon pointless.
 *
 * Two halves. Every icon a view resolves is remembered here, keyed by origin,
 * so the common case costs nothing: a site you have open in one task is a site
 * every other task already knows the icon of. What that cannot reach — a tab
 * pinned to a site this app has never loaded — is fetched directly, without a
 * view, the way a browser would if it were only after the icon.
 */

/** Icon bytes past this are not an icon, whichever path fetched them. */
const MAX_ICON_BYTES = 128 * 1024

/**
 * How much of a page's markup is read looking for the icons it advertises.
 * `<link>` elements belong in the head, and a head this far in is a page doing
 * something other than what this is looking for.
 */
const MAX_MARKUP_BYTES = 256 * 1024

/**
 * How long "this site has no icon" stands before the site is asked again. A
 * miss is worth remembering — otherwise every launch re-fetches the same page
 * to be told the same nothing — but it is not worth remembering for ever: a
 * site that gains an icon should get one here eventually.
 */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Nothing here waits on a slow site: the row it would fill has a glyph already. */
const REQUEST_TIMEOUT_MS = 8_000

/** origin → what is known about its icon. The table, in memory. */
const known = new Map<string, { dataUrl: string | null; fetchedAt: Date }>()

/** The read that fills `known`, so that concurrent callers share one. */
let loading: Promise<void> | undefined

/** origin → a discovery already in flight, so two rows asking make one fetch. */
const discovering = new Map<string, Promise<string | null>>()

// Servers hand out favicon.ico as `application/octet-stream`, `text/plain`, or
// with no type at all often enough that the URL has to be believed when the
// header cannot be.
const EXTENSION_IMAGE_TYPES: Record<string, string> = {
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif'
}

function imageTypeFor(url: string, contentType: string | null): string | undefined {
  const declared = contentType?.split(';')[0].trim().toLowerCase()
  if (declared?.startsWith('image/')) return declared
  const extension = new URL(url).pathname.split('.').pop()?.toLowerCase()
  return extension ? EXTENSION_IMAGE_TYPES[extension] : undefined
}

/**
 * Reads one icon and inlines it. The renderer may not load remote images — its
 * CSP allows `'self'` and `data:` only, which is what keeps a page from pinging
 * a tracker every time the sidebar redraws — so the bytes come across as data.
 * The fetch goes through the session that will open the site, so an icon behind
 * a login or on an intranet arrives for the same reason the page would.
 */
export async function fetchIcon(browsing: Session, url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return url
  if (!/^https?:/i.test(url)) return null

  try {
    const response = await browsing.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) return null

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES) return null

    const type = imageTypeFor(url, response.headers.get('content-type'))
    if (!type) return null

    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    // An icon that will not load is not worth reporting: the row falls back to
    // its generic glyph, which is what it showed a moment ago anyway.
    return null
  }
}

/** The origin `url` belongs to, or null for anything that is not a web address. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

async function loadKnown(): Promise<void> {
  loading ??= listSiteIcons()
    .then((rows) => {
      for (const row of rows) {
        // Anything a live view has reported in the meantime is newer than the
        // table, and the table is only ever a record of what views reported.
        if (!known.has(row.origin)) {
          known.set(row.origin, { dataUrl: row.dataUrl, fetchedAt: row.fetchedAt })
        }
      }
    })
    .catch((error) => {
      // A cache that cannot be read is a cache that is empty: every row falls
      // back to its glyph, and the next icon a view reports starts it again.
      console.error('Failed to read remembered site icons:', error)
    })
  return loading
}

/**
 * Remembers what a page's icon turned out to be, so that a tab which has never
 * been opened can be drawn with it. Called for every icon a view resolves,
 * which is what keeps this filled without anything having to go looking.
 *
 * Misses are recorded too — as null — but only by the discovery below: a view
 * reporting no icon means this page has none, while the site's front door may
 * well have one, and that is the icon a pinned row wants.
 */
export function rememberSiteIcon(pageUrl: string, dataUrl: string): void {
  const origin = originOf(pageUrl)
  if (!origin) return
  if (known.get(origin)?.dataUrl === dataUrl) return

  known.set(origin, { dataUrl, fetchedAt: new Date() })
  void putSiteIcon(origin, dataUrl).catch((error) => {
    console.error('Failed to remember a site icon:', error)
  })
}

/**
 * The session a browsing context's pages — and so its icons — are fetched in.
 *
 * The context and not just the profile, because an icon is often behind a
 * login: an internal tool serves its mark to a signed-in session and a redirect
 * to everyone else, and the session that is signed in is the one the tab is
 * actually in.
 */
function sessionFor(space: string | null, profile: number | null): Session {
  const partition = partitionFor(space, profile)
  return partition ? session.fromPartition(partition) : session.defaultSession
}

/**
 * The `href`s of the icons a document advertises, best-guess-first.
 *
 * Read with a regex rather than a parser because the question is small and the
 * input is a head: what is wanted is the `<link>` elements whose `rel` mentions
 * an icon, in the order the page lists them, with `apple-touch-icon` after the
 * rest — it is a fallback here, being a large square meant for a home screen
 * rather than a 16-pixel mark.
 */
function advertisedIcons(markup: string, base: string): string[] {
  const preferred: string[] = []
  const fallback: string[] = []

  for (const [tag] of markup.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, 'rel')?.toLowerCase()
    if (!rel?.includes('icon')) continue

    const href = attribute(tag, 'href')
    if (!href) continue

    try {
      // Relative hrefs are the common case — `/favicon.ico`, `../icon.png` —
      // and are resolved against the page they were found on.
      const resolved = new URL(href, base).toString()
      ;(rel.includes('apple-touch-icon') ? fallback : preferred).push(resolved)
    } catch {
      continue
    }
  }

  return [...preferred, ...fallback]
}

/** One attribute off a tag, quoted or not. Undefined when the tag has no such attribute. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match?.[2] ?? match?.[3] ?? match?.[4]
}

/** The document's head, or as much of it as `MAX_MARKUP_BYTES` allows. */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let markup = ''
  try {
    while (markup.length < MAX_MARKUP_BYTES) {
      const { done, value } = await reader.read()
      if (done) break

      markup += decoder.decode(value, { stream: true })
      // The rest of the document is a page, and icons are not declared in one.
      const end = markup.indexOf('</head>')
      if (end !== -1) return markup.slice(0, end)
    }
  } catch {
    // Whatever arrived before the stream broke is still worth reading.
  } finally {
    void reader.cancel().catch(() => {})
  }

  return markup
}

/**
 * Finds a site's icon without opening it in a view: the page is fetched, the
 * icons it advertises are tried in turn, and `/favicon.ico` is the last resort
 * — which is the whole of the convention, and is what a great many sites still
 * rely on rather than declaring anything.
 */
async function discover(
  url: string,
  origin: string,
  space: string | null,
  profile: number | null
): Promise<string | null> {
  const browsing = sessionFor(space, profile)
  const candidates: string[] = []

  try {
    const response = await browsing.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.ok && (response.headers.get('content-type') ?? '').includes('html')) {
      // Against the address the response came from, not the one asked for: a
      // redirect to a login page moves what a relative href means.
      candidates.push(...advertisedIcons(await readHead(response), response.url || url))
    }
  } catch {
    // A site that will not answer still gets the guess below, which is a
    // different request and sometimes the one that works.
  }

  candidates.push(`${origin}/favicon.ico`)

  for (const candidate of candidates) {
    const dataUrl = await fetchIcon(browsing, candidate)
    if (dataUrl) return dataUrl
  }
  return null
}

/**
 * The icon to draw for a site, from the cache when it is there and by going and
 * looking when it is not. Null when the site has none, or when nothing could be
 * reached — either way the row keeps its glyph.
 *
 * `space` and `profile` name the browsing context the tab would open in, and
 * decide only which session the fetch goes through. The answer is stored by
 * origin alone: a site's icon is a fact about the site, not about who is signed
 * in to it or which space they are in.
 */
export async function siteIcon(
  url: string,
  space: string | null,
  profile: number | null
): Promise<string | null> {
  const origin = originOf(url)
  if (!origin) return null

  await loadKnown()

  const remembered = known.get(origin)
  if (remembered) {
    if (remembered.dataUrl !== null) return remembered.dataUrl
    if (Date.now() - remembered.fetchedAt.getTime() < MISS_TTL_MS) return null
  }

  const started = discovering.get(origin)
  if (started) return started

  const run = discover(url, origin, space, profile)
    .then((dataUrl) => {
      known.set(origin, { dataUrl, fetchedAt: new Date() })
      void putSiteIcon(origin, dataUrl).catch((error) => {
        console.error('Failed to remember a site icon:', error)
      })
      return dataUrl
    })
    .finally(() => {
      discovering.delete(origin)
    })

  discovering.set(origin, run)
  return run
}
