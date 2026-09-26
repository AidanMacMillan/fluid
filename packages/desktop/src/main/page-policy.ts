import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import type { Session } from 'electron'
import { FILE_SCHEME } from './files'
import { setResponsePolicy } from './response-policy'

/**
 * The content security policy of the two pages that draw what extensions
 * serve: the main window, and the page every extension view is loaded into.
 *
 * Every other page of the app states its policy in a meta tag, because what it
 * may load is fixed. These two cannot. A scheme absent from a directive is
 * blocked outright, however the page came by the URL, and which schemes there
 * are depends on the extensions installed (see `Extension.schemes`). A meta tag
 * is written before any of that is known and cannot be widened afterwards — a
 * second policy only ever narrows the first — so these pages carry none, and
 * the policy arrives as a response header instead, added here as the page
 * loads. That holds for the dev server's pages and the built `file:` ones
 * alike.
 *
 * Each scheme is named in `media-src` as well as `img-src`. Without it a video
 * falls back to `default-src` and is refused, and the refusal surfaces on the
 * media element as "Media load rejected by URL safety check", which says
 * nothing about CSP — worth knowing before going looking in a protocol handler.
 *
 * @module page-policy
 */

/** The pages whose policy is assembled here rather than written in them. */
export type PolicedPage = 'index.html' | 'extension-view.html' | 'extension-host.html'

/**
 * Gives `page`, wherever it loads in `target`, a policy that lets it draw from
 * the app's file store and from `schemes`, and run code and styles from
 * `codeOrigins` — an installed extension's own folder, for its views (see
 * src/main/extensions/installed.ts). Header policies share Electron's single
 * listener through response-policy.
 */
export function applyPagePolicy(
  target: Session,
  page: PolicedPage,
  schemes: readonly string[],
  codeOrigins: readonly string[] = []
): void {
  const policy = policyFor(page, [FILE_SCHEME, ...schemes], codeOrigins)
  setResponsePolicy(target, 'app-page', (details) => {
    if (
      !details.url.startsWith(`${rendererRoot()}/`) ||
      details.resourceType !== 'mainFrame' ||
      pageOf(details.url) !== page
    ) {
      return {}
    }
    return {
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] }
    }
  })
}

function policyFor(
  page: PolicedPage,
  schemes: readonly string[],
  codeOrigins: readonly string[]
): string {
  const sources = schemes.map((scheme) => `${scheme}:`).join(' ')
  const code = codeOrigins.join(' ')
  // The page an installed extension's main half runs in draws nothing, so it
  // is allowed nothing a page draws with: no frames, no workers, no plugins,
  // and nowhere to post a form or rebase its links to.
  if (page === 'extension-host.html') {
    return [
      "default-src 'self'",
      `script-src 'self' ${code}`,
      // Its fetch is made by the main process; it needs no connection of its own.
      "connect-src 'none'",
      "style-src 'self'",
      "img-src 'self' data:",
      "frame-src 'none'",
      "child-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')
  }
  const directives = [
    "default-src 'self'",
    `script-src 'self' ${code}`,
    `style-src 'self' 'unsafe-inline' ${code}`,
    `font-src 'self' data: ${code}`,
    `img-src 'self' data: ${sources} ${code}`,
    `media-src 'self' ${sources}`
  ]
  // An installed extension's views (the only pages given code origins) reach
  // their own files, the file store and their schemes, and frame nothing.
  if (codeOrigins.length > 0) {
    directives.push(
      `connect-src ${code} ${sources}`,
      "frame-src 'none'",
      "child-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    )
  }
  return directives.join('; ')
}

/** Where the app's pages are served from: the dev server, or the built folder. */
export function rendererRoot(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServer) return devServer.replace(/\/$/, '')
  return pathToFileURL(join(__dirname, '../renderer')).href
}

/** The page a URL names. The dev server answers the main window at its root. */
function pageOf(url: string): string {
  const name = new URL(url).pathname.split('/').pop()
  return name === '' || name === undefined ? 'index.html' : name
}
