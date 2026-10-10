import { app } from 'electron'
import { isWebAddress } from '@fluid/sdk'
import { revealHost, sendToHost } from './browser-views'

/**
 * Web addresses handed to the app by the rest of the system, which is what
 * being a default browser means: a link clicked in Mail or Slack, `open` from a
 * terminal, or a choice made in the "Open with" menu.
 *
 * They are opened the way a link followed inside the app is — as a new tab in
 * the task that is selected (see `workspace.openLink`) — so all this module
 * does is get the address to a renderer that is able to act on it.
 */

/**
 * How to make a window when the app has none. Registered by the app at startup,
 * for the reason `registerWindowOpener` is (see ./notifications.ts).
 */
let openWindow: (() => void) | null = null

/**
 * Addresses that arrived with no window up to take them — the launch the link
 * itself caused, a window that is still loading, or a window closed on macOS.
 * Kept until the renderer asks, which it does as it finishes loading: the one
 * moment it is certain to be listening.
 */
const pending: string[] = []

/**
 * Starts listening. Called at module scope rather than once the app is ready,
 * because macOS delivers the link that launched the app before `ready` and an
 * `open-url` listener added after it would never hear it.
 */
export function registerExternalLinks(open: () => void): void {
  openWindow = open

  app.on('open-url', (event, url) => {
    // Claims the event, so the system does not consider it unhandled.
    event.preventDefault()
    openExternalLinks([url])
  })

  // A launch with an address on the command line: the other platforms' way of
  // being the default browser. macOS never passes them here.
  openExternalLinks(linksIn(process.argv))
}

/**
 * The web addresses among a command line's arguments. Anything else on it —
 * the executable, Electron's switches, a path — is not an address and is left
 * alone, so this can be given `argv` as it is.
 */
export function linksIn(argv: readonly string[]): string[] {
  return argv.filter(isWebAddress)
}

/**
 * Takes the user to each address. Anything that is not a web address is
 * dropped: what other applications hand over is not the user's own, and this
 * is the same refusal every other way in makes (see `isWebAddress`).
 */
export function openExternalLinks(urls: readonly string[]): void {
  const links = urls.filter(isWebAddress)
  if (links.length === 0) return

  // Before `ready` there is no window to make or to find. The one the app
  // creates as it starts will collect these.
  if (!app.isReady()) {
    pending.push(...links)
    return
  }

  switch (revealHost()) {
    case 'ready':
      for (const link of links) sendToHost('workspace:openLink', link)
      return
    case 'loading':
      pending.push(...links)
      return
    case 'none':
      pending.push(...links)
      openWindow?.()
  }
}

/** Takes the addresses that arrived before this window could hear them. */
export function takePendingLinks(): string[] {
  return pending.splice(0)
}
