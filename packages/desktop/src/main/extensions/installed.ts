import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { app, type CustomScheme, type Session } from 'electron'
import { ADBLOCK_SCHEME_NAME } from '../../shared/ad-blocking'
import { z } from 'zod'
import {
  MANIFEST_FILENAME,
  SDK_VERSION,
  STORED_FILE_SCHEME,
  satisfiesVersion,
  type ExtensionManifest
} from '@fluid/sdk'
import { isCommandName } from './commands'

/**
 * Extensions installed into the app's data folder rather than compiled into it.
 *
 * Each is a folder under `installed-extensions/`, named after its id, holding
 * a manifest (see `ExtensionManifest` in the SDK) and the built files it names:
 * a browser ES module for its main half, and optionally one for its views with
 * a stylesheet beside it.
 *
 * A folder is never read piecemeal. It is read whole into a *snapshot* — every
 * file, in memory, with a digest over all of them — and everything after that
 * works from the snapshot: the manifest is parsed out of it, the user approves
 * its digest (see ./approvals.ts), and its files are served to the extension's
 * pages out of memory rather than off the disk. So what the user approved is
 * exactly what runs, however the folder changes afterwards; a change is caught
 * the next time it is read, as a digest that no longer matches.
 *
 * A folder that cannot be loaded is not skipped in silence. It becomes a
 * problem: listed with the extensions like any other, with the reason where
 * the settings window shows an extension's error. That covers a folder that
 * cannot be read (a link, a special file, too large), a manifest that does not
 * parse, an id taken by a built-in extension or another folder, a scheme
 * somebody else declared, and an extension built against another SDK.
 *
 * @module installed
 */

/**
 * The scheme an installed extension's pages load its built files over:
 * `fluid-extension://<id>/<path>`. Each extension's own sessions serve its own
 * snapshot and nobody else's (see `serveSnapshot`).
 */
export const INSTALLED_SCHEME = 'fluid-extension'

export const INSTALLED_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: INSTALLED_SCHEME,
  // Standard and secure so the address has a host and a module can be loaded
  // from it; CORS because the page importing it is the app's, on another origin.
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}

/**
 * Where installed extensions live. Not `extensions/`: on a case-insensitive
 * disk that is Chromium's `Extensions`, which it keeps in the same directory.
 */
export function installedExtensionsDir(): string {
  return join(app.getPath('userData'), 'installed-extensions')
}

/** A folder read whole: its files by path (always `/`-separated), and a digest over them all. */
export type Snapshot = {
  digest: string
  files: ReadonlyMap<string, Buffer>
  bytes: number
}

/** An installed extension's folder, as read. */
export type Installed = { manifest: ExtensionManifest; dir: string; snapshot: Snapshot }

/** A folder that could not be loaded, and why. */
export type InstallProblem = { id: string; name: string; version?: string; reason: string }

const ID = /^[a-z0-9-]+$/

/** The most a folder may hold. Well past any extension, and short of a folder picked by mistake. */
const MAX_FILES = 2_000
const MAX_BYTES = 100 * 1024 * 1024

/**
 * Files the OS writes into any folder it has shown — Finder's view settings,
 * Explorer's thumbnails. Left out of the snapshot, so opening the folder does
 * not read as the extension having changed. Dotfiles are left out for the same
 * reason; none of these is ever served, so leaving them out costs nothing.
 */
const IGNORED_NAMES = new Set(['Thumbs.db', 'desktop.ini'])

/** Why a folder cannot be an extension, with as much of its manifest as could be read. */
export class FolderProblem extends Error {
  constructor(
    message: string,
    readonly manifest?: Partial<ExtensionManifest>
  ) {
    super(message)
  }
}

/**
 * Reads a folder whole. Refuses a symbolic link or anything that is not a
 * plain file or folder — a link could point the snapshot at a file outside the
 * folder, which is not what the user picked — and a folder past the limits.
 */
export function snapshotFolder(root: string): Snapshot {
  const files = new Map<string, Buffer>()
  let bytes = 0

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED_NAMES.has(entry.name)) continue
      const path = join(dir, entry.name)
      const inner = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new FolderProblem(`It contains a link, ${inner}.`)
      if (stat.isDirectory()) {
        walk(path, inner)
        continue
      }
      if (!stat.isFile()) throw new FolderProblem(`It contains ${inner}, which is not a file.`)
      if (files.size >= MAX_FILES) throw new FolderProblem(`It holds more than ${MAX_FILES} files.`)
      bytes += stat.size
      if (bytes > MAX_BYTES) throw new FolderProblem('It is larger than an extension can be.')
      files.set(inner, readFileSync(path))
    }
  }
  walk(root, '')

  const digest = createHash('sha256')
  for (const path of [...files.keys()].sort()) {
    const file = createHash('sha256').update(files.get(path)!).digest('hex')
    digest.update(`${path}\0${file}\n`)
  }
  return { digest: digest.digest('hex'), files, bytes }
}

/** A path inside the folder: relative, `/`-separated, and not climbing out of it. */
const innerPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    { message: 'must be a path inside the folder' }
  )

const host = z
  .string()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a host name, or *. and a domain')

const manifestSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  version: z.string().min(1).max(40),
  sdk: z.string().min(1),
  main: innerPath,
  views: z.object({ script: innerPath, styles: innerPath.optional() }).optional(),
  schemes: z
    .array(
      z.object({
        scheme: z.string().regex(/^[a-z][a-z0-9+.-]*$/),
        // No `bypassCSP`: a scheme is registered for every page, the app's
        // own windows included, and one that bypassed their policy would be a
        // way for an extension's server to run script in them.
        privileges: z
          .object({
            standard: z.boolean().optional(),
            secure: z.boolean().optional(),
            supportFetchAPI: z.boolean().optional(),
            corsEnabled: z.boolean().optional(),
            stream: z.boolean().optional()
          })
          .strict()
          .optional()
      })
    )
    .optional(),
  permissions: z
    .object({
      hosts: z.array(host).optional(),
      commands: z
        .array(z.string().refine(isCommandName, 'must be a command name, not a path'))
        .optional(),
      extensions: z.array(z.string().regex(ID)).optional()
    })
    .strict()
    .optional()
})

/**
 * Schemes no installed extension may declare, whatever its id: the web's and
 * the browser's own, and the app's. A scheme is registered for every page in
 * the app, and a handler for one of these would be serving pages the app loads
 * for itself. The rule that a scheme starts with the extension's id already
 * keeps nearly all of them out; this is for an id chosen to get round it.
 */
const RESERVED_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'ftp',
  'ws',
  'wss',
  'data',
  'blob',
  'javascript',
  'about',
  'mailto',
  'chrome',
  'chrome-extension',
  'chrome-error',
  'chrome-untrusted',
  'devtools',
  'filesystem',
  'view-source',
  'app'
])

/** An extension's permissions with nothing left out, for code that checks them. */
export type Permissions = { hosts: string[]; commands: string[]; extensions: string[] }

export function permissionsOf(manifest: ExtensionManifest): Permissions {
  const { hosts = [], commands = [], extensions = [] } = manifest.permissions ?? {}
  return {
    hosts: [...new Set(hosts)],
    commands: [...new Set(commands)],
    extensions: [...new Set(extensions)]
  }
}

/**
 * Reads the manifest out of a snapshot and checks what can be checked of an
 * extension without knowing where it will be installed: that the manifest is
 * valid, that it was built for this app's SDK, and that the files it names are
 * in the snapshot.
 */
export function manifestOf(snapshot: Snapshot): ExtensionManifest {
  const file = snapshot.files.get(MANIFEST_FILENAME)
  if (!file) throw new FolderProblem(`It has no ${MANIFEST_FILENAME}, so it is not an extension.`)
  let raw: unknown
  try {
    raw = JSON.parse(file.toString('utf8'))
  } catch (error) {
    throw new FolderProblem(`Its ${MANIFEST_FILENAME} could not be read: ${messageOf(error)}`)
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || 'the manifest'
    throw new FolderProblem(
      `Its ${MANIFEST_FILENAME} is not valid: ${where} ${issue?.message ?? ''}`.trim()
    )
  }
  const manifest = parsed.data
  const badScheme = (manifest.schemes ?? []).find(
    ({ scheme }) => !scheme.startsWith(`${manifest.id}-`) || RESERVED_SCHEMES.has(scheme)
  )
  if (badScheme) {
    throw new FolderProblem(
      `It declares the ${badScheme.scheme}: scheme. An installed extension's schemes start with its id and a dash, like ${manifest.id}-media.`,
      manifest
    )
  }
  if (!satisfiesVersion(manifest.sdk)) {
    throw new FolderProblem(
      `It was built for SDK ${manifest.sdk}, and this version of the app has SDK ${SDK_VERSION}.`,
      manifest
    )
  }
  const missing = [manifest.main, manifest.views?.script, manifest.views?.styles].find(
    (path) => path !== undefined && !snapshot.files.has(path)
  )
  if (missing) {
    throw new FolderProblem(`Its manifest names ${missing}, which is not in its folder.`, manifest)
  }
  return manifest
}

type Scan = { installed: Installed[]; problems: InstallProblem[] }

let scanned: Scan | null = null

/**
 * Which extension each scheme was registered for as the app started: the
 * built-in ones', and those of the installed extensions that were read then.
 * A scheme can only be registered then, so an extension installed later can
 * serve only what is here and already its own.
 */
const schemeOwners = new Map<string, string>()

/**
 * Reads every installed extension's folder, once per run, and sorts them into
 * those that can be loaded and those that cannot. `taken` is what the built-in
 * extensions already use, which an installed one may not reuse. Whether each
 * one is approved is a question for later (see ./approvals.ts): this runs
 * before the app is ready, to register schemes, and approvals are in the vault.
 */
export function scanInstalled(taken: { ids: string[]; schemes: string[] }): Scan {
  if (scanned) return scanned
  const scan: Scan = { installed: [], problems: [] }
  scanned = scan

  for (const scheme of [
    ...taken.schemes,
    INSTALLED_SCHEME,
    STORED_FILE_SCHEME,
    ADBLOCK_SCHEME_NAME
  ]) {
    schemeOwners.set(scheme, '')
  }

  const root = installedExtensionsDir()
  if (!existsSync(root)) return scan

  const ids = new Set(taken.ids)

  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !IGNORED_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort()

  for (const folder of folders) {
    const dir = join(root, folder)
    const problem = (reason: string, manifest?: Partial<ExtensionManifest>): void => {
      scan.problems.push({
        id: manifest?.id && ID.test(manifest.id) ? manifest.id : folder,
        name: manifest?.name ?? folder,
        version: manifest?.version,
        reason
      })
    }

    let snapshot: Snapshot
    let manifest: ExtensionManifest
    try {
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
        throw new FolderProblem('It is not a folder.')
      }
      snapshot = snapshotFolder(dir)
      manifest = manifestOf(snapshot)
    } catch (error) {
      problem(messageOf(error), error instanceof FolderProblem ? error.manifest : undefined)
      continue
    }

    if (manifest.id !== folder) {
      problem(`Its folder is ${folder}, but its manifest says it is ${manifest.id}.`, manifest)
      continue
    }
    if (ids.has(manifest.id)) {
      problem(`Another extension is already called ${manifest.id}.`, manifest)
      continue
    }
    const clash = (manifest.schemes ?? []).find((declared) => schemeOwners.has(declared.scheme))
    if (clash) {
      problem(`It declares the ${clash.scheme}: scheme, which is already taken.`, manifest)
      continue
    }

    ids.add(manifest.id)
    for (const declared of manifest.schemes ?? []) schemeOwners.set(declared.scheme, manifest.id)
    scan.installed.push({ manifest, dir, snapshot })
  }

  return scan
}

/**
 * A folder the user picked to install, read whole and checked. The snapshot is
 * what the user is asked about and what is written into place, so a folder
 * that changes while the question is up changes nothing that is installed.
 */
export type Candidate = { manifest: ExtensionManifest; source: string; snapshot: Snapshot }

/**
 * Reads a folder the user picked to install. It can be the built extension
 * itself, or the package it was built in, whose `dist/` holds it. Throws the
 * reason it cannot be installed, worded for the user.
 */
export function readCandidate(folder: string): Candidate {
  const source = existsSync(join(folder, MANIFEST_FILENAME))
    ? folder
    : existsSync(join(folder, 'dist', MANIFEST_FILENAME))
      ? join(folder, 'dist')
      : null
  if (!source) {
    throw new Error(`That folder has no ${MANIFEST_FILENAME}, so it is not a built extension.`)
  }
  const installed = resolve(installedExtensionsDir())
  const picked = resolve(source)
  if (picked === installed || picked.startsWith(`${installed}${sep}`)) {
    throw new Error('That folder is one the app installed; choose the one it was built in.')
  }
  const snapshot = snapshotFolder(source)
  return { manifest: manifestOf(snapshot), source, snapshot }
}

/**
 * Whether a candidate can start in this run, rather than after a relaunch: it
 * declares no scheme that was not registered for it as the app started.
 */
export function startsWithoutRelaunch({ manifest }: { manifest: ExtensionManifest }): boolean {
  return (manifest.schemes ?? []).every(({ scheme }) => schemeOwners.get(scheme) === manifest.id)
}

/** A scheme the candidate declares that another extension already has, if any. */
export function takenScheme({ manifest }: { manifest: ExtensionManifest }): string | null {
  const clash = (manifest.schemes ?? []).find(({ scheme }) => {
    const owner = schemeOwners.get(scheme)
    return owner !== undefined && owner !== manifest.id
  })
  return clash?.scheme ?? null
}

/**
 * Writes a candidate's snapshot into its folder, replacing whatever was there.
 * Written beside the old folder first and swapped in after, so a write that
 * fails halfway leaves the old version whole.
 */
export function writeIntoPlace({ manifest, snapshot }: Candidate): Installed {
  const root = installedExtensionsDir()
  mkdirSync(root, { recursive: true })
  const dir = join(root, manifest.id)
  const stamp = `${Date.now()}-${process.pid}`
  const incoming = join(root, `.incoming-${manifest.id}-${stamp}`)
  const outgoing = join(root, `.outgoing-${manifest.id}-${stamp}`)
  try {
    for (const [path, content] of snapshot.files) {
      const target = join(incoming, ...path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, { flag: 'wx' })
    }
    if (existsSync(dir)) renameSync(dir, outgoing)
    try {
      renameSync(incoming, dir)
    } catch (error) {
      // Put the old version back rather than leave no version at all.
      if (existsSync(outgoing) && !existsSync(dir)) renameSync(outgoing, dir)
      throw error
    }
    rmSync(outgoing, { recursive: true, force: true })
  } finally {
    rmSync(incoming, { recursive: true, force: true })
  }
  return { manifest, dir, snapshot }
}

/** Deletes an installed extension's folder. Its storage, secrets and data folder stay. */
export function removeFolder(id: string): void {
  if (!ID.test(id)) return
  rmSync(join(installedExtensionsDir(), id), { recursive: true, force: true })
}

/** Where an installed extension's folder is, whether or not it exists. */
export function folderFor(id: string): string {
  return join(installedExtensionsDir(), id)
}

/** Where an installed extension's pages load its built files from. */
export function installedOrigin(id: string): string {
  return `${INSTALLED_SCHEME}://${id}`
}

/** The address of one of an installed extension's files. */
export function installedFileUrl(id: string, path: string): string {
  return `${installedOrigin(id)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** The addresses of an installed extension's view module and its stylesheet. */
export function installedViewCode(
  installed: Installed
): { script: string; styles?: string } | null {
  const { views, id } = installed.manifest
  if (!views) return null
  return {
    script: installedFileUrl(id, views.script),
    ...(views.styles ? { styles: installedFileUrl(id, views.styles) } : {})
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/** Each installed extension's snapshot as it is now served, by id. Replaced on an update. */
const served = new Map<string, Snapshot>()

/** Serves `snapshot` as `id`'s files, from now on, on every session that serves them. */
export function publishSnapshot(id: string, snapshot: Snapshot): void {
  served.set(id, snapshot)
}

export function withdrawSnapshot(id: string): void {
  served.delete(id)
}

/**
 * Serves an installed extension's files on one of its own sessions, out of the
 * snapshot that was approved. Only its own, and only under its own host:
 * another extension's pages are in other sessions, where this handler is not.
 */
export function serveSnapshot(target: Session, id: string): void {
  if (target.protocol.isProtocolHandled(INSTALLED_SCHEME)) return
  target.protocol.handle(INSTALLED_SCHEME, (request) => {
    const notFound = (): Response => new Response('Not found', { status: 404 })
    let url: URL
    let path: string
    try {
      url = new URL(request.url)
      path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
    } catch {
      return notFound()
    }
    const snapshot = served.get(id)
    const file = url.host === id && snapshot ? snapshot.files.get(path) : undefined
    if (!file) return notFound()
    return new Response(new Uint8Array(file), {
      headers: {
        'Content-Type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        // The page importing it is the app's own, on another origin.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
