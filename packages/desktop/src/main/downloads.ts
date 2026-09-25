import { randomUUID } from 'node:crypto'
import { session, type DownloadItem, type Session } from 'electron'
import { sendToHost, tabIdForWebContents } from './browser-views'
import {
  describeStoredFile,
  mimeTypeOf,
  removeStoredFile,
  reserveStorage,
  type StoredFile
} from './files'
import { PROFILES } from './profiles'
import { partitionFor } from './browsing'
import { listSpaces } from './db/spaces'

/**
 * Downloads a browser tab starts do not go to the user's Downloads folder.
 * They are written straight into the app's own file store — the same store a
 * dropped file lands in — and the renderer opens a file tab for each one the
 * moment it begins, so the download is visible in the task it belongs to while
 * it is still arriving rather than appearing once it is over.
 *
 * The reasoning is the one the store was built on (see src/main/files.ts): a
 * task is meant to hold the things the work is about, and a file that went to
 * Downloads would be a file the task cannot point at. Nothing here touches the
 * Downloads folder, and nothing is left behind if the download does not finish.
 */

/** A download has begun, and the renderer should open a tab to hold it. */
export type DownloadStarted = {
  downloadId: string
  /** The browser tab that asked for it. Its task is where the file goes. */
  sourceTabId: string
  /**
   * The file as it is expected to land. Everything here is the server's word
   * for it — the size above all — and it is replaced wholesale by what
   * actually arrived when the download finishes.
   */
  file: StoredFile
  /** Bytes the server promised, or 0 when it would not say. */
  totalBytes: number
}

/** How far along a download is. Sent no faster than `PROGRESS_INTERVAL_MS`. */
export type DownloadProgress = {
  downloadId: string
  receivedBytes: number
  /** Still 0 for a server that never names a length. */
  totalBytes: number
  paused: boolean
}

/** A download has stopped, one way or the other. */
export type DownloadFinished = {
  downloadId: string
  /** The file as it landed, or null if it never did. */
  file: StoredFile | null
}

/** One channel, so the renderer subscribes once and switches on the phase. */
export type DownloadEvent =
  | ({ phase: 'started' } & DownloadStarted)
  | ({ phase: 'progress' } & DownloadProgress)
  | ({ phase: 'finished' } & DownloadFinished)

/**
 * The fastest the renderer hears about progress. `updated` fires per network
 * chunk, which on a fast connection is far more often than a two-pixel bar can
 * show — and every one of them costs an IPC hop and a re-render.
 */
const PROGRESS_INTERVAL_MS = 100

/** Downloads still running, so closing the tab holding one can stop it. */
const items = new Map<string, DownloadItem>()

/** The sessions already listened to, so hooking one twice is harmless. */
const captured = new Set<Session>()

/**
 * Starts capturing one session's downloads.
 *
 * A download belongs to the session that started it, so this has to be done
 * once per browsing context — every space crossed with every profile — rather
 * than once for the app; see src/main/browsing.ts. Every session it is not called for keeps Electron's
 * default behaviour, which is to ask the user where to put the file: not a
 * crash, and not anything the renderer could notice, which is exactly why the
 * bookkeeping is here rather than at each call site.
 */
function captureDownloadsFor(target: Session): void {
  if (captured.has(target)) return
  captured.add(target)

  target.on('will-download', (_event, item, webContents) => {
    const sourceTabId = tabIdForWebContents(webContents)
    // A download from anywhere but a page — the host renderer itself, in
    // practice — has no task to belong to, and is left to Electron, which asks
    // the user where to put it.
    if (sourceTabId === null) return

    capture(sourceTabId, item)
  })
}

/**
 * Starts capturing downloads for every session a tab can run in: the app's own,
 * and one per profile in every space. Called once, after the database is open
 * and before the first window exists.
 *
 * The sessions are opened here rather than when a tab first asks for one. A
 * `Session` costs very little until a page actually uses it, and opening them
 * up front is what lets this be a single call with no lazy path to get wrong —
 * a session created later and never hooked would send its downloads to a save
 * dialog instead of into the task.
 *
 * Spaces are the one thing that can arrive after this has run, which is why
 * `captureDownloadsInSpace` exists and why making a space calls it.
 */
export async function registerDownloadCapture(): Promise<void> {
  captureDownloadsFor(session.defaultSession)
  for (const space of await listSpaces()) captureDownloadsInSpace(space.id)
}

/**
 * The same, for one space's sessions. Called for every space at startup and
 * again the moment another is made — a space nobody has hooked is a space whose
 * every download goes to a save dialog.
 */
export function captureDownloadsInSpace(spaceId: string): void {
  for (const profile of PROFILES) {
    const partition = partitionFor(spaceId, profile.id)
    if (partition) captureDownloadsFor(session.fromPartition(partition))
  }
  // The space's default profile, which is a session of its own everywhere but
  // in the default space — where it is the app's own, hooked above.
  const fallback = partitionFor(spaceId, null)
  if (fallback) captureDownloadsFor(session.fromPartition(fallback))
}

/**
 * Stops a download. Called when the tab it was filling is closed; the `done`
 * that follows reports it as cancelled, which is what clears up after it.
 */
export function cancelDownload(downloadId: string): void {
  items.get(downloadId)?.cancel()
}

/**
 * Points one download at the store and narrates it to the renderer.
 *
 * The first two statements have to run before the `will-download` handler
 * returns: Electron resolves the destination as soon as that stack unwinds,
 * and a save path set any later is ignored in favour of the save dialog. That
 * is what makes `reserveStorage` synchronous.
 */
function capture(sourceTabId: string, item: DownloadItem): void {
  const slot = reserveStorage(item.getFilename())
  item.setSavePath(slot.path)

  const downloadId = randomUUID()
  items.set(downloadId, item)

  // Read now rather than in a later handler: an interrupted item does not
  // promise to still describe where it was going.
  const url = item.getURL()
  const totalBytes = item.getTotalBytes()

  send({
    phase: 'started',
    downloadId,
    sourceTabId,
    totalBytes,
    file: {
      storageKey: slot.storageKey,
      fileName: slot.fileName,
      // From the name rather than from `getMimeType`: the name is what the file
      // is stored under, and the viewer the tab ends up with is chosen the same
      // way for a download as for a dropped file.
      mimeType: mimeTypeOf(slot.fileName),
      size: totalBytes,
      sourcePath: url
    }
  })

  let lastSent = 0
  item.on('updated', () => {
    const now = Date.now()
    if (now - lastSent < PROGRESS_INTERVAL_MS) return
    lastSent = now

    send({
      phase: 'progress',
      downloadId,
      receivedBytes: item.getReceivedBytes(),
      // Asked again every time: a server that would not name a length up front
      // sometimes does once the body is under way.
      totalBytes: item.getTotalBytes(),
      paused: item.isPaused()
    })
  })

  item.once('done', (_event, state) => {
    items.delete(downloadId)

    if (state !== 'completed') {
      // Cancelled, interrupted, or failed. The directory holds a partial file
      // or nothing at all, and either way no tab should be left pointing at it.
      void removeStoredFile(slot.storageKey)
      send({ phase: 'finished', downloadId, file: null })
      return
    }

    void deliver(downloadId, slot.storageKey, url)
  })
}

/**
 * Describes what landed and hands it over. Only now are the real size, and a
 * preview of it, knowable — up to here the tab has been drawing the server's
 * promise.
 */
async function deliver(downloadId: string, storageKey: string, url: string): Promise<void> {
  try {
    send({ phase: 'finished', downloadId, file: await describeStoredFile(storageKey, url) })
  } catch (error) {
    // The bytes arrived but could not be described — the store was emptied
    // underneath us, or the disk went away. The tab has nothing to show, so it
    // is told the download failed and the slot goes.
    console.error('Failed to take in a download:', error)
    void removeStoredFile(storageKey)
    send({ phase: 'finished', downloadId, file: null })
  }
}

function send(event: DownloadEvent): void {
  sendToHost('files:download', event)
}
