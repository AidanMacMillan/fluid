import { deleteSecret, getSecret, isSecretStorageAvailable, setSecret } from '../secrets'

/**
 * Which installed extensions the user has approved, and exactly which files.
 *
 * The folder installed extensions live in is one any program running as the
 * user can write to, and so can an agent working in the app. Finding a folder
 * there is therefore no reason to run it. An installed extension runs only
 * when the user has approved it — by installing it through the settings
 * window, or by approving a folder the app found — and an approval is for the
 * digest of its files as they were then (see `Snapshot` in ./installed.ts).
 * A changed file is a new digest, and waits for the user again.
 *
 * Approvals are kept in the secret vault, encrypted with the OS keychain's key,
 * because that is the one place on disk another program cannot write for the
 * app: forging an approval would take the key, and on macOS the keychain only
 * hands that key to the app itself. Each names its extension as well as the
 * digest, so one extension's approval cannot be moved onto another.
 *
 * Where the computer has no keychain the app can use, approvals last only as
 * long as the app runs, and the user is asked again the next time.
 *
 * @module approvals
 */

type Approval = { id: string; digest: string; approvedAt: string }

/** `@` is not allowed in an extension id, so no extension's own secrets can be one of these. */
const nameFor = (id: string): `${string}:${string}` => `@approval:${id}`

/** Approvals made while no keychain was available, for this run only. */
const inMemory = new Map<string, Approval>()

function stored(id: string): Approval | undefined {
  if (!isSecretStorageAvailable()) return inMemory.get(id)
  const raw = getSecret(nameFor(id))
  if (!raw) return undefined
  try {
    const approval = JSON.parse(raw) as Partial<Approval>
    return approval.id === id && typeof approval.digest === 'string'
      ? (approval as Approval)
      : undefined
  } catch {
    return undefined
  }
}

/** Whether the user approved exactly these files for this extension. */
export function isApproved(id: string, digest: string): boolean {
  return stored(id)?.digest === digest
}

/** Whether the user ever approved this extension, whatever its files were then. */
export function wasApproved(id: string): boolean {
  return stored(id) !== undefined
}

/** Records the user's approval of these files for this extension, replacing any before. */
export function approve(id: string, digest: string): void {
  const approval: Approval = { id, digest, approvedAt: new Date().toISOString() }
  if (!isSecretStorageAvailable()) {
    inMemory.set(id, approval)
    return
  }
  setSecret(nameFor(id), JSON.stringify(approval))
}

export function forget(id: string): void {
  inMemory.delete(id)
  if (isSecretStorageAvailable()) deleteSecret(nameFor(id))
}

/** Whether approvals outlast this run of the app. */
export function approvalsPersist(): boolean {
  return isSecretStorageAvailable()
}
