import { mkdirSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import type { Client, SchemeDeclaration } from '@fluid/sdk'
import { ATTACHMENT_SCHEME } from '../shared/attachments'
import { CLAUDE_TAB } from '../shared/tab'
import { imageTypeFor } from '../shared/files'

/**
 * Where files dropped into a session are kept, one directory per tab, and the
 * scheme the view loads them back over.
 *
 * Files are put on disk and named in the turn rather than carried inside it:
 * the model reads them with the tool it already has, at a path it is allowed to
 * reach, and no part of the conversation has to carry an image inline. One
 * directory per tab so closing a tab has something to clear up, and a leaf of
 * its own so granting it grants nothing else.
 *
 * They are not task files: nothing lists them, and no tab is opened on one. A
 * file here can still become one, but only by being handed to `open_file` (see
 * ./tools.ts), which imports it into the app's store the way a drop does. That
 * is the whole of the crossing, and it is one-way on purpose: the tab is about
 * the store's copy, so it outlives both the session and whatever the session
 * does to the original afterwards.
 *
 * @module attachments
 */

let root: string | null = null

/** Set once, as the extension activates: `<dataDir>/attachments`. */
export function setAttachmentsRoot(dataDir: string | null): void {
  root = dataDir === null ? null : join(dataDir, 'attachments')
}

export function attachmentsRoot(): string {
  if (!root) throw new Error('The Claude Code extension is not active.')
  return root
}

/**
 * The id as a directory name, or nothing.
 *
 * The id arrives from a view and is joined into a path that gets written to and
 * removed, which is the shape a path traversal takes; ids are UUIDs, so
 * anything that is not one is either a bug or an attempt, and neither is worth
 * touching a directory over.
 */
function safeTabId(tabId: string): string | null {
  return /^[A-Za-z0-9-]{1,64}$/.test(tabId) ? tabId : null
}

/** A tab's own directory, made if it is not there yet. */
export function attachmentsDirectory(tabId: string): string {
  const id = safeTabId(tabId)
  if (!id) throw new Error(`${tabId} is not a tab id.`)
  const path = join(attachmentsRoot(), id)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Throws away what was dropped into a tab's session, for a tab that has been
 * closed.
 *
 * Separate from ending the session because the two are asked for at different
 * times: a session is also ended when its task is settled, and a settled task's
 * tabs are still there to be opened again — so ending the session is not on its
 * own a reason to lose what the conversation was about.
 */
export async function discardAttachments(tabId: string): Promise<void> {
  const id = safeTabId(tabId)
  if (!id) return
  await rm(join(attachmentsRoot(), id), { recursive: true, force: true })
}

/**
 * Every session tab there is, in every task of every project, open or settled.
 *
 * Walked rather than asked for, because the API has no query for tabs by type
 * and this is the one thing that would want it: once per launch, and off the
 * critical path. A failure anywhere throws, so a partial answer never reaches
 * the sweep below.
 */
async function liveTabIds(api: Client): Promise<Set<string>> {
  const live = new Set<string>()
  for (const project of await api.projects.list({})) {
    for (const task of await api.tasks.list({ projectId: project.id })) {
      for (const tab of await api.tabs.list({ taskId: task.id })) {
        if (tab.type === CLAUDE_TAB) live.add(tab.id)
      }
    }
  }
  return live
}

/**
 * Throws away the attachments of tabs that no longer exist.
 *
 * Run once as the extension starts. Closing a tab is not a tab's only way to
 * go — its task can be deleted, and the app can be killed between the two — so
 * sweeping the directory against the tabs that remain catches what no hook on a
 * close can.
 */
export async function pruneAttachments(api: Client): Promise<void> {
  let live: Set<string>
  try {
    live = await liveTabIds(api)
  } catch {
    // Deleting on a guess is the one outcome worth avoiding here: every
    // directory removed is a conversation's attachments removed with it. An
    // unreadable tab list is a reason to sweep nothing.
    return
  }
  const from = attachmentsRoot()
  let entries: string[]
  try {
    entries = await readdir(from)
  } catch {
    // No directory yet, which is every launch before the first attachment.
    return
  }
  await Promise.all(
    entries
      .filter((entry) => !live.has(entry))
      .map((entry) => rm(join(from, entry), { recursive: true, force: true }))
  )
}

/**
 * Where an attachment named in an old turn was, relative to the root.
 *
 * The app kept these in a folder of its own, `claude-attachments`, before
 * sessions were an extension's, and moved that folder here when they became
 * one (see `adoptClaudeAttachments` in the app). The transcripts on disk still
 * name the old paths, so a turn read back from one is recognised by the old
 * folder's name as well as by the new root.
 */
const LEGACY_ROOT = /^(?:[A-Za-z]:)?[/\\].*[/\\]claude-attachments[/\\](.+)$/

/** The key of an attachment path, relative to the root, or null for any other line. */
export function attachmentKey(path: string): string | null {
  const current = attachmentsRoot() + sep
  if (path.startsWith(current)) return path.slice(current.length)
  return LEGACY_ROOT.exec(path)?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Serving them
// ---------------------------------------------------------------------------

export const ATTACHMENT_SCHEME_PRIVILEGES: SchemeDeclaration = {
  scheme: ATTACHMENT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}

/**
 * Answers a request on the scheme. Only images, and only from inside the root:
 * the one thing a view draws from here is the thumbnail of a picture that was
 * attached, and `..` in a key must not reach anything else on the disk.
 */
export async function serveAttachment(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.host !== 'attachments') return new Response(null, { status: 404 })

  const key = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const base = attachmentsRoot()
  const path = normalize(join(base, key))
  const type = imageTypeFor(path)
  if (key === '' || key.includes('\x00') || !path.startsWith(base + sep) || !type) {
    return new Response(null, { status: 404 })
  }
  try {
    return new Response(await readFile(path), {
      headers: { 'content-type': type, 'cache-control': 'private, max-age=31536000' }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}
