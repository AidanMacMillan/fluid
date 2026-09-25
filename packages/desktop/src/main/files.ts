import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { copyFile, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  clipboard,
  nativeImage,
  net,
  protocol,
  shell,
  type CustomScheme,
  type Session
} from 'electron'
import { STORED_FILE_SCHEME, storedFileUrl } from '@fluid/sdk'
import { fileListItem } from './clipboard-files'

/**
 * Files dropped onto a task are copied into the app's own store rather than
 * referenced where they came from. A reference would be the cheaper move, but
 * it makes the tab a promise the app cannot keep: the original is the user's
 * file, free to be renamed, moved into the trash, or unplugged with the volume
 * it lives on, and the tab would then point at nothing. The copy also keeps
 * every write the app might ever do — none today — inside its own directory.
 *
 * Nothing here is a general filesystem API for the renderer: the only paths it
 * can name are storage keys this module handed out.
 */

/** Everything the store holds, one directory per imported file. */
const STORE_DIRNAME = 'task-files'

/**
 * A scheme of our own for serving the store to the renderer. `file://` cannot
 * be used: the renderer is served over http:// in dev, and Chromium refuses to
 * load local resources into a page from any other origin. Named in the SDK,
 * because extensions' pages build the same addresses (see `storedFileUrl`).
 */
export const FILE_SCHEME = STORED_FILE_SCHEME

/** What the renderer gets back for an imported file. */
export type StoredFile = {
  /** Path within the store, and the only handle the renderer ever holds. */
  storageKey: string
  fileName: string
  mimeType: string
  size: number
  /** Where the file came from: a path for an import, a URL for a download. */
  sourcePath: string
  /** Small preview of the image, as a `data:` URL. Absent for everything else. */
  thumbnail?: string
}

/**
 * The longest side of a generated thumbnail, in device pixels — twice what the
 * tab strip draws, so it stays sharp on a retina display and has room to grow
 * a little without being regenerated.
 */
const THUMBNAIL_PIXELS = 64

/**
 * Past this, decoding the image to make a 64px preview costs more than the
 * preview is worth: `createFromPath` reads the whole thing into memory at full
 * size first.
 */
const MAX_THUMBNAIL_SOURCE_BYTES = 32 * 1024 * 1024

/**
 * A small preview of an imported image, or undefined when there is none to be
 * had — a file that is not an image, one too large to be worth decoding, or a
 * format `nativeImage` cannot read, SVG among them. Generated once, at import:
 * the strip then draws from the payload rather than decoding the original for
 * every row, which for a screenshot is a hundredfold difference in the pixels
 * it has to touch.
 */
function thumbnailFor(path: string, mimeType: string, size: number): string | undefined {
  if (!mimeType.startsWith('image/') || size > MAX_THUMBNAIL_SOURCE_BYTES) return undefined

  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return undefined

  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest === 0) return undefined
  // An image already smaller than the box is used as it is; scaling it up would
  // only cost bytes.
  if (longest <= THUMBNAIL_PIXELS) return image.toDataURL()

  const scale = THUMBNAIL_PIXELS / longest
  return image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'better'
    })
    .toDataURL()
}

function storeRoot(): string {
  return join(app.getPath('userData'), STORE_DIRNAME)
}

/**
 * Media types for what the built-in file viewers display, plus the handful
 * that are cheap to recognise. The viewers themselves are extensions (see
 * `FileViewerContribution`), and match on what this says; anything absent is
 * served — and shown — as unsupported, which is the honest answer rather than
 * a guess at `application/octet-stream` behaviour.
 */
const MIME_TYPES: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  // Containers Chromium will actually play. `.mkv` and `.avi` are deliberately
  // absent: naming them would promise a viewer the codecs behind them cannot
  // keep, and an empty type at least routes the file to the honest fallback.
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.ogv': 'video/ogg',
  '.webm': 'video/webm',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
}

export function mimeTypeOf(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLowerCase()] ?? ''
}

/**
 * Strips everything but the file's own name, so a crafted path cannot climb
 * out of the store, and replaces what a filesystem would rather not carry. The
 * name is cosmetic — the directory around it is what makes the key unique — so
 * a name that reduces to nothing is simply replaced.
 */
function safeFileName(sourcePath: string): string {
  const name = [...basename(sourcePath)]
    .map((char) => (char < ' ' || char === '/' || char === '\\' || char === ':' ? '_' : char))
    .join('')
    .trim()
  return name === '' || name === '.' || name === '..' ? 'file' : name.slice(0, 200)
}

/** A place in the store for a file not yet written, and the key it will answer to. */
export type StorageSlot = {
  storageKey: string
  /** The name the file will be stored under, once `safeFileName` has had it. */
  fileName: string
  /** Absolute path to write to. Never crosses the bridge. */
  path: string
}

/**
 * Reserves a directory in the store for one file. The per-file directory is
 * what keeps two files of the same name apart, and what makes discarding one a
 * single recursive delete.
 *
 * Synchronous on purpose. A download has to be given its path before the
 * `will-download` handler returns — Electron resolves the destination the
 * moment that stack unwinds — so a caller that had to await this would get the
 * save dialog it was trying to avoid.
 */
export function reserveStorage(fileName: string): StorageSlot {
  const safe = safeFileName(fileName)
  const directory = randomUUID()
  mkdirSync(join(storeRoot(), directory), { recursive: true })

  return {
    storageKey: `${directory}/${safe}`,
    fileName: safe,
    path: join(storeRoot(), directory, safe)
  }
}

/**
 * Describes a file already sitting in the store. Both ways in end here: an
 * import copies the file and then describes the copy, a download writes
 * straight into the slot and describes what landed. The description is read
 * from the app's own copy, which is the one a tab is about.
 */
export async function describeStoredFile(storageKey: string, origin: string): Promise<StoredFile> {
  const resolved = resolveStored(storageKey)
  if (!resolved) throw new Error(`Not a storage key: ${storageKey}`)

  const info = await stat(resolved)
  const fileName = basename(resolved)
  const mimeType = mimeTypeOf(fileName)

  return {
    storageKey,
    fileName,
    mimeType,
    size: info.size,
    sourcePath: origin,
    thumbnail: thumbnailFor(resolved, mimeType, info.size)
  }
}

/** Copies a file into the store and describes the copy. */
export async function importFile(sourcePath: string): Promise<StoredFile> {
  const info = await stat(sourcePath)
  if (!info.isFile()) {
    throw new Error(`Not a file: ${sourcePath}`)
  }

  const slot = reserveStorage(sourcePath)
  await copyFile(sourcePath, slot.path)

  return describeStoredFile(slot.storageKey, sourcePath)
}

/**
 * Resolves a storage key to the file it names, or null if the key does not
 * describe a file inside the store. Every path that reaches the filesystem
 * from the renderer goes through here.
 */
function resolveStored(storageKey: string, root = storeRoot()): string | null {
  if (storageKey === '' || storageKey.includes('\x00')) return null

  const resolved = normalize(join(root, storageKey))
  // `..` in the key would otherwise resolve to a real path outside the store,
  // which is the whole reason the renderer never sends absolute paths.
  return resolved.startsWith(root + sep) ? resolved : null
}

/**
 * Which directory a `fluid-file://` URL is asking about, from its host: the
 * store, and nothing else. Anything else is refused rather than defaulted, so a
 * typo cannot quietly resolve against the store.
 */
function rootFor(host: string): string | null {
  return host === 'store' ? storeRoot() : null
}

/** Discards an imported file, along with the directory holding it. */
export async function removeStoredFile(storageKey: string): Promise<void> {
  const resolved = resolveStored(storageKey)
  if (!resolved) return
  // The key is `<uuid>/<name>`, and the directory exists only for this file, so
  // removing the pair is removing the import.
  await rm(join(resolved, '..'), { recursive: true, force: true })
}

/**
 * The bytes of a stored file, or null when the key names nothing.
 *
 * The one read here that hands content back rather than a description or a URL.
 * It exists for putting a copied image back on the clipboard (see
 * `restoreClipboardEntry` in src/main/clipboard-window.ts), which needs the
 * actual picture and cannot get it over a scheme the pasteboard has never heard
 * of. Nothing crosses the bridge: the renderer names the entry, and the main
 * process is what reads and writes it.
 */
export async function storedFileBytes(storageKey: string): Promise<Buffer | null> {
  const resolved = resolveStored(storageKey)
  if (!resolved) return null
  try {
    return await readFile(resolved)
  } catch {
    // The row outlived its file — a store emptied by hand, a failed write. The
    // caller has a text form to fall back on, so this is not worth throwing.
    return null
  }
}

/** Opens the file in whatever the OS considers its default application. */
export async function openStoredFile(storageKey: string): Promise<void> {
  const resolved = resolveStored(storageKey)
  if (!resolved) return
  await shell.openPath(resolved)
}

/**
 * Puts the app's copy on the clipboard as a file, so it pastes into Finder,
 * Explorer or a mail as the file itself — and into anything else as its path.
 *
 * Not told to the clipboard capture as the app's own write, deliberately: a
 * file copied out of a tab is a copy the user made while in the task, and the
 * history should have it like any other.
 */
export async function copyStoredFile(storageKey: string): Promise<void> {
  const resolved = resolveStored(storageKey)
  if (!resolved) return
  await clipboard.write([fileListItem([resolved])])
}

/** Reveals the app's copy in Finder/Explorer. */
export function revealStoredFile(storageKey: string): void {
  const resolved = resolveStored(storageKey)
  if (!resolved) return
  shell.showItemInFolder(resolved)
}

/** The URL the renderer loads a stored file from. */
export function fileUrl(storageKey: string): string {
  return storedFileUrl(storageKey)
}

/**
 * What this scheme needs to be granted, for src/main/schemes.ts to register
 * along with every other scheme the app serves — Electron accepts one such
 * declaration per process, so no module may make its own.
 *
 * Without `standard` the URLs have no path semantics, and without `stream` a
 * media element cannot seek within one.
 */
export const FILE_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: FILE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

/**
 * The byte range a request asked for, clamped to the file, or null when it
 * asked for the whole thing. `unsatisfiable` is the one case that has to be
 * told apart from "no range": it gets a 416 rather than the file.
 */
type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parses a single-range `Range` header. Multi-range requests — a comma in the
 * spec — are answered with the whole file instead, which is allowed and which
 * no media element asks for.
 */
function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  // `bytes=-500` is the last 500 bytes, not a range starting at zero.
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  // An open-ended `bytes=0-` runs to the end, which is what a media element
  // opens with to discover how long the file is.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  return end < start ? 'unsatisfiable' : { start, end }
}

/**
 * Answers one `fluid-file://` request, whichever session it arrived on.
 *
 * Range requests are answered in full rather than passed through: `net.fetch`
 * honours a `Range` header on a `file://` URL — it returns exactly the bytes
 * asked for — but reports the result as a plain `200` with no `Content-Range`
 * and no `Accept-Ranges`. A media element reading that concludes the resource
 * cannot be seeked within, so a video plays from the start and the seek bar
 * does nothing. The metadata is therefore written here, from the size `stat`
 * already had to read.
 */
async function serveStoredFile(request: Request): Promise<Response> {
  const { hostname, pathname } = new URL(request.url)
  const root = rootFor(hostname)
  if (!root) return new Response('Not found', { status: 404 })
  const storageKey = decodeURIComponent(pathname).replace(/^\//, '')
  const resolved = resolveStored(storageKey, root)
  if (!resolved) return new Response('Not found', { status: 404 })

  let size: number
  try {
    const info = await stat(resolved)
    if (!info.isFile()) return new Response('Not found', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const range = parseRange(request.headers.get('Range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    })
  }

  const url = pathToFileURL(resolved).toString()
  // Normalised to an absolute `start-end` before it is forwarded: a suffix or
  // open-ended range is this module's to interpret, not the file loader's.
  const response = await net.fetch(
    url,
    range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : undefined
  )

  const headers = new Headers(response.headers)
  const mimeType = mimeTypeOf(resolved)
  if (mimeType) headers.set('Content-Type', mimeType)
  // Says the file can be seeked within at all — without it a media element
  // does not bother asking for a range in the first place.
  headers.set('Accept-Ranges', 'bytes')

  if (!range) {
    headers.set('Content-Length', String(size))
    return new Response(response.body, { status: response.status, headers })
  }

  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(response.body, { status: 206, headers })
}

/**
 * Serves the store over `fluid-file://` on the app's own session. Called once
 * the app is ready; it is what lets the renderer draw a stored image or play a
 * stored video.
 */
export function registerFileProtocol(): void {
  protocol.handle(FILE_SCHEME, serveStoredFile)
}

/**
 * The same, for a session of its own. A stored HTML file is rendered in a page
 * of its own rather than by the renderer (see src/main/browser-views.ts), and a
 * page runs in whichever session its partition names — where `protocol.handle`
 * above has registered nothing, since that call only ever covers the default
 * one. Without this the document loads into a page that cannot fetch it.
 *
 * Registering twice on one session throws, so this answers whether it did the
 * work; the caller registers on first use and never again.
 */
export function registerFileProtocolOn(session: Session): void {
  if (session.protocol.isProtocolHandled(FILE_SCHEME)) return
  session.protocol.handle(FILE_SCHEME, serveStoredFile)
}
