/**
 * Whether an address is one the app will load into a page.
 *
 * Part of the SDK because every surface needs the same answer: the app's main
 * process and windows, and any extension that opens what somebody else wrote.
 *
 * This exists because addresses reach the app from places that are not the
 * user. A Slack message is written by whoever is in the channel — which for a
 * Slack Connect channel is somebody at another company — and a link in one
 * carries whatever scheme its author typed. `<file:///Users/me/.ssh/id_ed25519|see the diff>`
 * is a perfectly ordinary-looking link in Slack's wire format, and a tab that
 * loaded it would put the contents of that file on screen and into the app's
 * own session.
 *
 * So: the two schemes the web is made of, and the blank page a `window.open`
 * with no address produces. Everything else is refused, whatever asked for it.
 */
const LOADABLE_PROTOCOLS = new Set(['http:', 'https:'])

export function isWebAddress(url: string): boolean {
  // `about:blank` is what a popup opened with no address is, and it is the one
  // non-web address the app produces for itself.
  if (url === 'about:blank') return true

  try {
    return LOADABLE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    // Not an address at all, which is not an address the app will load.
    return false
  }
}

/**
 * The scheme the app serves its file store over, to its windows and to
 * extensions' pages. Its own rather than `file:`, because a page served from
 * anywhere else may not load `file:` at all, and because the only paths it can
 * name are the store's.
 */
export const STORED_FILE_SCHEME = 'fluid-file'

/**
 * Where a stored file is loaded from, by the storage key a file tab's payload
 * carries. A pure string, built the same way wherever it is needed rather than
 * asked for across a bridge. Both halves are escaped, so a name with spaces or
 * `#` in it survives the round trip.
 */
export function storedFileUrl(storageKey: string): string {
  const path = storageKey.split('/').map(encodeURIComponent).join('/')
  return `${STORED_FILE_SCHEME}://store/${path}`
}
