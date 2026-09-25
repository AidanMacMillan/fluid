import type { SchemeDeclaration } from './extension'

/**
 * Installed extensions: the file that says what one is, what it needs, and the
 * version of the contract it was built against.
 *
 * A built-in extension is compiled into the app and always agrees with it. An
 * installed one was built somewhere else, against whichever SDK it had then,
 * and is loaded from a folder the app did not write. So it carries a manifest
 * saying which SDK versions it works with, and the app refuses one that does
 * not name the SDK it has.
 *
 * An installed extension is also not trusted the way the app's own code is.
 * Its main half runs in a sandboxed page of its own, with no Node and no disk,
 * and reaches anything beyond the workspace API only through what its
 * manifest's `permissions` ask for — which the user sees, and agrees to, when
 * they install it. So its bundle targets the browser, not Node.
 */

/**
 * The SDK's own version: what an installed extension's `sdk` range is checked
 * against. Kept in step with this package's `version`. Raise the minor for a
 * change an extension built earlier would break on, while the major is 0.
 */
export const SDK_VERSION = '0.2.0'

/** What the manifest at the root of an installed extension's folder is called. */
export const MANIFEST_FILENAME = 'fluid-extension.json'

/**
 * What an installed extension may do beyond the workspace API, its own storage
 * and secrets, and its own views. Everything here is shown to the user before
 * they install it, and nothing that is not here is allowed.
 */
export type ExtensionPermissions = {
  /**
   * The hosts its main half may `fetch` from, over https only: exact names
   * (`api.app.shortcut.com`) or a wildcard for subdomains (`*.example.com`).
   */
  hosts?: string[]
  /**
   * The commands it may run with `ctx.process.run`, by name — found on the
   * user's PATH, run without a shell.
   */
  commands?: string[]
  /** The extensions whose `rpc` methods it may call with `ctx.extensions.call`. */
  extensions?: string[]
}

/** The manifest of an installed extension. Paths are relative to its folder. */
export type ExtensionManifest = {
  /** The same id as the extension's main half. Also the name of its folder. */
  id: string
  name: string
  description?: string
  /** The extension's own version, for the settings window. */
  version: string
  /** The SDK versions it works with: `^0.1.0`, `~0.1.0` or an exact version. */
  sdk: string
  /** Its main half: an ES module whose default export is its `Extension`. */
  main: string
  /** Its view half: an ES module whose default export is its `ExtensionViews`. */
  views?: {
    script: string
    /** A stylesheet loaded into each of its views, after the app's own. */
    styles?: string
  }
  /**
   * The schemes it serves. Stated here as well as on its `Extension`, because
   * schemes are registered before the app is ready, before its code is loaded.
   */
  schemes?: SchemeDeclaration[]
  /** What it may do beyond its own data and the workspace API. */
  permissions?: ExtensionPermissions
}

type Version = [major: number, minor: number, patch: number]

function parseVersion(text: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Whether `version` is in `range`: `^x.y.z` and `~x.y.z` as npm reads them, or
 * one exact version. False for a range it cannot read, so a manifest nobody
 * can check is refused rather than trusted.
 */
export function satisfiesVersion(range: string, version: string = SDK_VERSION): boolean {
  const have = parseVersion(version)
  const trimmed = range.trim()
  const operator = trimmed[0] === '^' || trimmed[0] === '~' ? trimmed[0] : ''
  const floor = parseVersion(trimmed.slice(operator.length))
  if (!have || !floor) return false
  if (compare(have, floor) < 0) return false

  if (operator === '') return compare(have, floor) === 0
  if (operator === '~') return have[0] === floor[0] && have[1] === floor[1]
  // A caret allows what the leftmost non-zero part says is compatible.
  if (floor[0] > 0) return have[0] === floor[0]
  if (floor[1] > 0) return have[0] === 0 && have[1] === floor[1]
  return compare(have, floor) === 0
}
