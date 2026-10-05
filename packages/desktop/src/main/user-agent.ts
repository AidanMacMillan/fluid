import { app } from 'electron'

/**
 * The product tokens a browser UA is expected to carry. Anything else — the
 * `Electron/…` Electron adds, the `<app name>/<version>` it adds after it — is
 * what makes a site treat the browser as an embedded shell rather than a
 * browser: some block it outright, and others serve a degraded page.
 */
const BROWSER_TOKENS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari'])

/**
 * What stock Chrome would send for the same Chromium, from the UA Electron
 * built.
 *
 * Two changes: the tokens above that are not a browser's are dropped, and the
 * Chrome version is reduced to its major (`152.0.0.0`), which is what Chrome
 * itself sends since UA reduction. The rest of the string — the frozen
 * `10_15_7` macOS version included — is already Chrome's.
 *
 * Arc, Brave and Vivaldi all send exactly this, and Vivaldi's own token was
 * dropped for breaking sites. The fuller version is in Client Hints, not here.
 */
export function chromeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/ ([^\s/()]+)\/\S+/g, (token, name: string) => (BROWSER_TOKENS.has(name) ? token : ''))
    .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0')
}

/**
 * Makes every page the app loads send a Chrome UA. A fallback rather than a
 * per-session override: it is read when a session is created, so it covers the
 * default session, incognito, and every profile's partition without each one
 * having to be told. It therefore has to run before the first of them exists —
 * module scope in the entry point, not `ready`.
 */
export function registerUserAgent(): void {
  app.userAgentFallback = chromeUserAgent(app.userAgentFallback)
}
