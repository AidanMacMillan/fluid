import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { net, session, type Session } from 'electron'
import { hostAllowed } from '../../api/isolation-policy'
import { FILE_SCHEME } from '../../files'
import { applyPagePolicy, rendererRoot } from '../../page-policy'
import { installedOrigin, serveSnapshot } from '../installed'
import type { FetchRequest, FetchResponse } from './protocol'

/**
 * The sessions an installed extension's pages run in, and what each may load.
 *
 * Three per extension, none of them shared with anything of the user's:
 *
 * - **Its host page's** (in memory): where its main half runs. It loads the
 *   app's page, and the extension's own files out of its approved snapshot,
 *   and nothing else — the network is blocked outright, since the extension's
 *   `fetch` is made by the main process on its behalf.
 * - **Its views'** (the extension partition every extension's views use): the
 *   app's page, its own files, the app's file store and the schemes it serves.
 * - **Its network's** (in memory): the one its `fetch` goes out on. No cookies
 *   of the user's browsing reach it, and nothing it collects reaches them.
 *
 * Every permission prompt a page could raise — notifications, the camera, the
 * clipboard — is refused without asking in all of them.
 *
 * @module sessions
 */

export const hostPartition = (id: string): string => `extension-${id}.host`
const netPartition = (id: string): string => `extension-${id}.net`

/** The page an installed extension's main half runs in. */
export function extensionHostUrl(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServer) return `${devServer}/extension-host.html`
  return pathToFileURL(join(__dirname, '../renderer/extension-host.html')).href
}

/** The preload that gives the host page its bridge. */
export const EXTENSION_HOST_PRELOAD = join(__dirname, '../preload/extension-host.js')

/**
 * The folders the dev server may serve an installed extension's pages from
 * outside the renderer: the app's own package, the SDK the page is built on,
 * and the dependencies. The dev server would serve any file in the workspace
 * — `/@fs/` and a `?raw` import read one as a string — and an installed
 * extension's page is no place for the workspace's files.
 */
const DEV_SOURCE_ROOTS = ['desktop', 'sdk']
  .map((name) => resolve(__dirname, '../../..', name))
  .concat(resolve(__dirname, '../../../../node_modules'))

/** Whether `url` is the app's own page or one of its assets, from the dev server or the built folder. */
function isAppPage(url: string): boolean {
  const root = rendererRoot()
  try {
    const served = new URL(root)
    // The built app's pages, from its own folder.
    if (served.protocol === 'file:') return url.startsWith(`${root}/`)
    // The dev server's, and the socket its module reloading talks back over.
    const target = new URL(url)
    if (target.host !== served.host || !['http:', 'ws:'].includes(target.protocol)) {
      return false
    }
    // An import that turns a file into a string, rather than running it.
    if (/[?&](raw|url|inline)\b/.test(target.search)) return false
    if (!target.pathname.startsWith('/@fs/')) return true
    const file = resolve(decodeURIComponent(target.pathname.slice('/@fs'.length)))
    return DEV_SOURCE_ROOTS.some((dir) => file.startsWith(`${dir}/`))
  } catch {
    return false
  }
}

/** Lets a session load only what `allowed` says, and ask for no permission at all. */
function lock(target: Session, allowed: (url: string) => boolean): void {
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(allowed(details.url) || details.url.startsWith('devtools:')) })
  })
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
}

const prepared = new Set<string>()

/** Gets an installed extension's host page's session ready, once per run. */
export function prepareHostSession(id: string): void {
  const key = `host:${id}`
  if (prepared.has(key)) return
  prepared.add(key)
  const target = session.fromPartition(hostPartition(id))
  const origin = installedOrigin(id)
  serveSnapshot(target, id)
  applyPagePolicy(target, 'extension-host.html', [], [origin])
  lock(target, (url) => isAppPage(url) || url.startsWith(`${origin}/`))
}

/**
 * Gets an installed extension's views' session ready, once per run: its files
 * from its snapshot, and nothing it may not load. The page policy on it is
 * applied as the extension activates, like any extension's.
 */
export function prepareViewSession(target: Session, id: string, schemes: readonly string[]): void {
  const key = `views:${id}`
  if (prepared.has(key)) return
  prepared.add(key)
  const origin = installedOrigin(id)
  serveSnapshot(target, id)
  const prefixes = [`${origin}/`, `${FILE_SCHEME}:`, ...schemes.map((scheme) => `${scheme}:`)]
  lock(
    target,
    (url) =>
      isAppPage(url) ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      prefixes.some((prefix) => url.startsWith(prefix))
  )
}

/**
 * Gets an installed extension's web views' session ready, once per run (see
 * `WebViewDeclaration`): it reaches the hosts its manifest names, over https,
 * and nothing else, and refuses every permission prompt. The address a web
 * view opens at is held to the same hosts (see `prepareWebView`).
 */
export function prepareWebSession(target: Session, id: string, hosts: readonly string[]): void {
  const key = `web:${id}`
  if (prepared.has(key)) return
  prepared.add(key)
  lock(
    target,
    (url) => url.startsWith('data:') || url.startsWith('blob:') || mayReachHost(hosts, url)
  )
}

function mayReachHost(hosts: readonly string[], url: string): boolean {
  try {
    const target = new URL(url)
    return (
      (target.protocol === 'https:' || target.protocol === 'wss:') &&
      !target.port &&
      hostAllowed(hosts, target.hostname)
    )
  } catch {
    return false
  }
}

/** The most a response may be before it is refused rather than buffered. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024

/** How long a request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 120_000

/** Headers the network stack sets itself, which a request may not. */
const MANAGED_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'cookie2',
  'trailer',
  'te',
  'expect'
])

/**
 * Makes a request for an installed extension, on its network session, with no
 * cookies of its own sent or kept. The caller has already checked the address
 * against its hosts. A redirect is not followed: it comes back as the 3xx it
 * was, so the page can ask for the next hop — and that hop is checked too.
 *
 * On `net.request` rather than `session.fetch`, which fails a redirect it was
 * told not to follow instead of answering with it.
 */
export function fetchFor(id: string, request: FetchRequest): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = net.request({
      url: request.url,
      method: request.method,
      session: session.fromPartition(netPartition(id)),
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      cache: 'no-store'
    })
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      outgoing.abort()
      finish(() => reject(new TypeError(`${request.url} did not answer in time.`)))
    }, REQUEST_TIMEOUT_MS)

    for (const [name, value] of request.headers) {
      if (MANAGED_HEADERS.has(name.toLowerCase())) continue
      try {
        outgoing.setHeader(name, value)
      } catch {
        // One the network stack will not let a request set; it is left out.
      }
    }

    outgoing.on('redirect', (status, _method, location, headers) => {
      outgoing.abort()
      finish(() =>
        resolve({
          url: request.url,
          status,
          statusText: '',
          headers: [
            ...Object.entries(headers).flatMap(([name, values]) =>
              name.toLowerCase() === 'location'
                ? []
                : values.map((value): [string, string] => [name, value])
            ),
            ['location', location]
          ],
          body: new Uint8Array()
        })
      )
    })

    outgoing.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          outgoing.abort()
          finish(() => reject(new TypeError('That response is too large to receive.')))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () =>
        finish(() =>
          resolve({
            url: request.url,
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: Object.entries(response.headers).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((one): [string, string] => [
                name,
                String(one)
              ])
            ),
            body: new Uint8Array(Buffer.concat(chunks))
          })
        )
      )
      response.on('error', (error: Error) => finish(() => reject(new TypeError(error.message))))
    })

    outgoing.on('error', (error) => finish(() => reject(new TypeError(error.message))))
    if (request.body && request.body.byteLength > 0) outgoing.write(Buffer.from(request.body))
    outgoing.end()
  })
}
