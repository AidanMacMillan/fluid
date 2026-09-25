import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Credentials the user hands the app — API keys, bot tokens — kept out of the
 * database and out of anything the renderer can read.
 *
 * `safeStorage` is Electron's front for the platform's own credential store:
 * the Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux. It
 * encrypts and decrypts with a key only this user (and, on macOS, only this
 * signed application) can obtain — so what lands on disk here is ciphertext
 * that another account, or a copy of the file taken elsewhere, cannot read.
 *
 * The plaintext never leaves the main process: the renderer can say what a
 * secret is and whether one exists, and that is the whole of its access.
 */

/** Ciphertext only. Sits beside the database in the per-user data directory. */
const VAULT_FILENAME = 'secrets.json'

/**
 * A secret's name in the vault. Every secret belongs to an extension and is
 * stored as `extensionId:name` (see `extensionSecretName`), so one extension
 * can never read another's.
 */
export type SecretName = `${string}:${string}`

export function extensionSecretName(extensionId: string, name: string): SecretName {
  return `${extensionId}:${name}`
}

type VaultEntry = {
  /** `safeStorage` ciphertext, base64 — the only form the secret takes at rest. */
  ciphertext: string
  updatedAt: string
}

type Vault = Partial<Record<SecretName, VaultEntry>>

/** Whether this machine can encrypt at all. See `setSecret` for why it matters. */
export function isSecretStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** What a secret exists as, for a caller that must not see the secret itself. */
export type SecretStatus = {
  configured: boolean
  /** When it was last written, ISO 8601, or null when there is nothing stored. */
  updatedAt: string | null
}

/**
 * Configured means readable. A secret that no longer decrypts is reported as
 * absent, so the settings that show it ask for it again rather than claiming a
 * connection that every caller will find empty.
 */
export function secretStatus(name: SecretName): SecretStatus {
  const entry = readVault()[name]
  if (!entry || decrypt(name, entry) === undefined) return { configured: false, updatedAt: null }
  return { configured: true, updatedAt: entry.updatedAt }
}

/**
 * The plaintext secret, or undefined when there is none to be had. Decryption
 * fails when the stored blob was written under another key — another user or
 * machine, a restored backup, a profile copied from a build with another name
 * — and there is nothing to do about that but treat the secret as absent and
 * let the user enter it again, which overwrites it.
 */
export function getSecret(name: SecretName): string | undefined {
  const entry = readVault()[name]
  return entry ? decrypt(name, entry) : undefined
}

/**
 * Ciphertexts already reported as unreadable. Background jobs ask for their
 * secret on every tick, and one failure is worth one line in the log, not one a
 * minute until the user gets round to entering it again.
 */
const reportedUnreadable = new Set<string>()

function decrypt(name: SecretName, entry: VaultEntry): string | undefined {
  try {
    return safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64'))
  } catch (error) {
    if (!reportedUnreadable.has(entry.ciphertext)) {
      reportedUnreadable.add(entry.ciphertext)
      console.error(`Could not decrypt the stored secret "${name}":`, error)
    }
    return undefined
  }
}

/**
 * Stores a secret, encrypted. Refuses rather than falls back when the platform
 * has no credential store — a Linux session with no keyring running, say.
 * Writing the token in the clear instead would be a silent downgrade of the
 * one thing this module exists to provide.
 */
export function setSecret(name: SecretName, value: string): void {
  if (!isSecretStorageAvailable()) {
    throw new Error('Secure storage is unavailable on this computer, so the key was not saved.')
  }
  if (value === '') throw new Error('Nothing to store.')

  const vault = readVault()
  vault[name] = {
    ciphertext: safeStorage.encryptString(value).toString('base64'),
    updatedAt: new Date().toISOString()
  }
  writeVault(vault)
}

/**
 * Every secret one extension holds, decrypted, by the name it gave it. For an
 * installed extension's sandboxed page (see extensions/isolation), which reads
 * its secrets synchronously like any extension and so is handed its own — and
 * only its own — as it starts.
 */
export function extensionSecrets(
  extensionId: string
): Record<string, { value: string; updatedAt: string }> {
  const prefix = `${extensionId}:`
  const found: Record<string, { value: string; updatedAt: string }> = {}
  for (const [name, entry] of Object.entries(readVault()) as [SecretName, VaultEntry][]) {
    if (!name.startsWith(prefix)) continue
    const value = decrypt(name, entry)
    if (value !== undefined)
      found[name.slice(prefix.length)] = { value, updatedAt: entry.updatedAt }
  }
  return found
}

/** Deletes every secret one extension holds. For an installed extension being removed. */
export function deleteExtensionSecrets(extensionId: string): void {
  const vault = readVault()
  const prefix = `${extensionId}:`
  let changed = false
  for (const name of Object.keys(vault) as SecretName[]) {
    if (!name.startsWith(prefix)) continue
    delete vault[name]
    changed = true
  }
  if (changed) writeVault(vault)
}

export function deleteSecret(name: SecretName): void {
  const vault = readVault()
  if (vault[name] === undefined) return
  delete vault[name]
  writeVault(vault)
}

function vaultPath(): string {
  return join(app.getPath('userData'), VAULT_FILENAME)
}

function readVault(): Vault {
  try {
    const parsed: unknown = JSON.parse(readFileSync(vaultPath(), 'utf8'))
    // A hand-edited or truncated file is worth nothing here: the entries it
    // holds are unreadable ciphertext either way.
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Vault
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Could not read the secret vault; treating it as empty:', error)
    }
    return {}
  }
}

/**
 * Writes the whole vault at once, through a temporary file: a crash partway
 * through a direct write would leave unparseable JSON where the user's saved
 * keys used to be, and a rename either happens or does not.
 */
function writeVault(vault: Vault): void {
  const path = vaultPath()
  const temporary = `${path}.tmp`

  try {
    // 0600 at creation, so the file is never briefly world-readable. The mode
    // is advisory on Windows, where the userData directory's ACL is the real
    // boundary.
    writeFileSync(temporary, JSON.stringify(vault, null, 2), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
