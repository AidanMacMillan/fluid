import { join } from 'node:path'
import { ipcMain, type CustomScheme, type Session, type WebContents } from 'electron'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { parse } from 'tldts-experimental'
import { setResponsePolicy } from './response-policy'
import { ADBLOCK_SCHEME_NAME } from '../shared/ad-blocking'

export const ADBLOCK_PRELOAD = join(__dirname, '../preload/adblocker.js')
export const ADBLOCK_SCHEME: CustomScheme = {
  scheme: ADBLOCK_SCHEME_NAME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: true
  }
}

type Features = { classes: string[]; ids: string[]; hrefs: string[] }

function featuresFrom(value: unknown): Features | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const result: Features = { classes: [], ids: [], hrefs: [] }
  for (const key of ['classes', 'ids', 'hrefs'] as const) {
    if (!Array.isArray(record[key])) return undefined
    result[key] = record[key]
      .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 2048)
      .slice(0, 1000)
  }
  return result
}

function isWebURL(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Own the Electron wiring: the upstream adapter registers process-wide IPC once per session. */
export class AdBlocker {
  engine: FiltersEngine | undefined
  private readonly pages = new Set<WebContents>()
  private readonly sessions = new WeakSet<Session>()

  constructor(private readonly enabledFor: (url: string) => boolean) {}

  private enabled(contents: WebContents, url = contents.getURL()): boolean {
    return this.pages.has(contents) && isWebURL(url) && this.enabledFor(url)
  }

  attach(contents: WebContents): void {
    if (this.pages.has(contents)) return
    this.pages.add(contents)
    contents.once('destroyed', () => this.pages.delete(contents))
    const target = contents.session
    if (this.sessions.has(target)) return
    this.sessions.add(target)
    // Chromium refuses webRequest redirects to data: URLs. Serve only resources
    // selected by the engine through a dedicated scheme instead. These trusted
    // replacements bypass page CSP without changing the page's own restrictions.
    const replacements = new Map<string, string>()
    target.protocol.handle(ADBLOCK_SCHEME.scheme, async (request) => {
      const data = replacements.get(request.url)
      if (!data) return new Response(null, { status: 404 })
      const response = await fetch(data)
      return new Response(response.body, {
        headers: {
          'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*'
        }
      })
    })

    // Only ordinary browsing sessions are attached here. Extension hosts keep
    // their restrictive onBeforeRequest handler and never enter this module.
    target.webRequest.onBeforeRequest((details, callback) => {
      const page = details.webContents
      if (!this.engine || !page || !this.enabled(page) || details.resourceType === 'mainFrame') {
        callback({})
        return
      }
      const result = this.engine.match(this.request(details))
      if (result.redirect) {
        const url = `${ADBLOCK_SCHEME.scheme}://resource/${encodeURIComponent(result.redirect.filename)}`
        replacements.set(url, result.redirect.dataUrl)
        callback({ redirectURL: url })
        return
      }
      callback({ cancel: result.match })
    })

    setResponsePolicy(target, 'adblocker', (details) => {
      const page = details.webContents
      const url = details.resourceType === 'mainFrame' ? details.url : page?.getURL()
      if (!this.engine || !page || !this.enabled(page, url)) return {}
      if (!['mainFrame', 'subFrame'].includes(details.resourceType)) return {}
      const csp = this.engine.getCSPDirectives(this.request(details))
      if (!csp) return {}
      // Separate CSP policies are intersected by Chromium. Appending avoids
      // weakening a site's policy by merging duplicate directives.
      const headers = { ...details.responseHeaders }
      const name =
        Object.keys(headers).find((key) => key.toLowerCase() === 'content-security-policy') ??
        'Content-Security-Policy'
      headers[name] = [...(headers[name] ?? []), csp]
      return { responseHeaders: headers }
    })
  }

  private request(
    details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails
  ): Request {
    const request = Request.fromRawDetails({
      url: details.url,
      sourceUrl:
        details.resourceType === 'mainFrame'
          ? details.url
          : details.referrer || details.frame?.url || details.webContents?.getURL(),
      type: details.resourceType,
      tabId: details.webContentsId,
      requestId: String(details.id)
    })
    if (request.type === 'other') request.guessTypeOfRequest()
    return request
  }

  registerIPC(): void {
    const cosmetics = (
      event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
      rawFeatures?: unknown
    ): { active: boolean; styles: string; scripts: string[] } => {
      const frame = event.senderFrame
      if (!this.engine || !frame || !this.enabled(event.sender) || !isWebURL(frame.url)) {
        return { active: false, styles: '', scripts: [] }
      }
      const features = featuresFrom(rawFeatures)
      const { hostname, domain } = parse(frame.url)
      const result = this.engine.getCosmeticsFilters({
        url: frame.url,
        hostname: hostname ?? '',
        domain: domain ?? '',
        ...features,
        getBaseRules: !features,
        getInjectionRules: !features,
        getRulesFromHostname: !features,
        getRulesFromDOM: !!features,
        getExtendedRules: false
      })
      return { active: result.active, styles: result.styles, scripts: result.scripts }
    }
    ipcMain.handle('adblocker:cosmetics', cosmetics)
    // The first lookup must finish before page scripts can read player ad data.
    // This only queries the in-memory engine; it never performs disk/network I/O.
    ipcMain.on('adblocker:cosmetics-initial', (event) => {
      try {
        event.returnValue = cosmetics(event)
      } catch (error) {
        console.warn('Could not prepare initial ad-blocking rules:', error)
        event.returnValue = { active: false, styles: '', scripts: [] }
      }
    })
  }
}
