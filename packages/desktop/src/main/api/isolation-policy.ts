import { getTab } from '../db/tabs'
import { ApiError } from './errors'

/**
 * What an installed extension may do with the workspace API.
 *
 * A built-in extension is the app's own code and may call anything. An
 * installed one runs sandboxed (see src/main/extensions/isolation), and the API
 * is the widest door out of that sandbox, so it is narrowed here — for its
 * main half and its views alike, since both call through `callApi` as the
 * extension.
 *
 * It keeps the workspace: tasks, tabs, notes, folders, bookmarks, projects and
 * spaces, which is what the user is told when they install it. What it loses
 * is anything that reaches past the workspace, or past its own permissions:
 *
 * - **The disk.** `files.import` copies any file on disk into the file store.
 * - **Other extensions.** Calling one, or opening or rewriting one of its tabs,
 *   is acting through it: a terminal tab runs a command, a Claude Code tab
 *   runs an agent. Only the extensions its manifest names (see
 *   `ExtensionPermissions.extensions`) — and its own.
 * - **The app.** Its settings (which include which extensions are on, and
 *   which it does not hear change either),
 *   turning extensions on and off, wiping a browser profile, pointing a
 *   project at another folder, and deleting a project or a space outright.
 *
 * @module isolation-policy
 */

/** What each installed extension may reach, by its id: other extensions, and hosts. */
const isolated = new Map<string, { extensions: ReadonlySet<string>; hosts: readonly string[] }>()

/** Holds an installed extension to this policy, from when it is listed until it is removed. */
export function isolate(
  extensionId: string,
  permissions: { extensions: readonly string[]; hosts: readonly string[] }
): void {
  isolated.set(extensionId, {
    extensions: new Set([extensionId, ...permissions.extensions]),
    hosts: [...permissions.hosts]
  })
}

/** Whether `hostname` is one of `patterns`: an exact name, or `*.` and a domain for its subdomains. */
export function hostAllowed(patterns: readonly string[], hostname: string): boolean {
  const name = hostname.toLowerCase()
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern
  )
}

/**
 * Whether an installed extension may point something at `url` — a fetch, a web
 * view: https, on the default port, to a host its manifest names. True for
 * anything that is not an installed extension.
 */
export function mayReach(extensionId: string, url: string): boolean {
  const found = isolated.get(extensionId)
  if (!found) return true
  try {
    const target = new URL(url)
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      !target.port &&
      hostAllowed(found.hosts, target.hostname)
    )
  } catch {
    return false
  }
}

/**
 * Whether a workspace event is one an installed extension hears. A setting
 * changing is the app's business — it may not read settings — so it does not.
 */
export function hears(extensionId: string, event: { type: string }): boolean {
  return !isolated.has(extensionId) || event.type !== 'setting.changed'
}

export function release(extensionId: string): void {
  isolated.delete(extensionId)
}

/** Whether an extension is an installed one, held to this policy. */
export function isIsolated(extensionId: string): boolean {
  return isolated.has(extensionId)
}

/**
 * Whether a page of an installed extension's may hand `url` to the OS: web
 * pages and email only. Any other scheme is whichever app registered it, and
 * launching apps is not something an installed extension was allowed.
 */
export function mayOpenOutside(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** Methods no installed extension may call at all. */
const REFUSED = new Set([
  'files.import',
  'settings.get',
  'settings.set',
  'settings.delete',
  'settings.all',
  'extensions.setEnabled',
  'profiles.reset',
  'projects.setRoot',
  'projects.delete',
  'spaces.delete'
])

/** The extension a namespaced type (`slack.thread`) belongs to, or null for a core type. */
function ownerOfType(type: string): string | null {
  const dot = type.indexOf('.')
  return dot === -1 ? null : type.slice(0, dot)
}

/**
 * Throws when an installed extension may not make this call. `input` is the
 * parsed input. A no-op for anything that is not an installed extension.
 */
export async function checkIsolatedCall(
  extensionId: string,
  method: string,
  input: unknown
): Promise<void> {
  const reachable = isolated.get(extensionId)
  if (!reachable) return

  const refuse = (what: string): never => {
    throw new ApiError(`${extensionId} is an installed extension, and may not ${what}.`)
  }
  const reach = (other: string, what: string): void => {
    if (!reachable.extensions.has(other)) {
      refuse(`${what} ${other} — its manifest does not ask for the ${other} extension`)
    }
  }

  if (REFUSED.has(method)) refuse(`call ${method}`)

  const args = (input ?? {}) as Record<string, unknown>
  if (method === 'extensions.call') {
    reach(String(args.extensionId), 'call')
  } else if (method === 'tabs.open') {
    const tab = args.tab as { type?: string } | undefined
    const owner = tab?.type ? ownerOfType(tab.type) : null
    if (owner) reach(owner, 'open a tab of')
  } else if (
    method === 'tabs.update' &&
    (args.payload !== undefined || args.viewState !== undefined)
  ) {
    // A tab's view state is its draft, its scroll, its half-typed prompt:
    // writing another extension's is acting through it as surely as its payload.
    const tab = await getTab(String(args.id))
    const owner = tab ? ownerOfType(tab.type) : null
    if (owner) reach(owner, 'rewrite a tab of')
  }
}
