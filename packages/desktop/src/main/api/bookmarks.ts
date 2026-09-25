import type { Bookmark } from '@fluid/sdk'
import {
  createBookmark,
  deleteBookmark,
  getBookmark,
  listBookmarks,
  reorderBookmarks,
  updateBookmark
} from '../db/bookmarks'
import type { BookmarkRow } from '../db/schema'
import { emit } from './bus'
import { contributedBookmarks } from './contributions'
import { ApiError, found } from './errors'

/**
 * Bookmarks: the user's own, stored, followed by whatever enabled extensions
 * supply right now. An extension's are never written down (see
 * src/main/api/contributions.ts), so they cannot be edited here — they change
 * when the extension does.
 */

function fromRow(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    icon: row.icon ?? undefined,
    keywords: row.keywords ?? undefined,
    group: row.group ?? undefined,
    source: { kind: 'user' }
  }
}

export async function list(): Promise<Bookmark[]> {
  const own = (await listBookmarks()).map(fromRow)
  const contributed = contributedBookmarks().map(({ extensionId, ...bookmark }): Bookmark => ({
    ...bookmark,
    id: `${extensionId}.${bookmark.id}`,
    source: { kind: 'extension', extensionId }
  }))
  return [...own, ...contributed]
}

/** Refuses an id that names an extension's bookmark, which are not the user's to change. */
async function own(id: string): Promise<BookmarkRow> {
  if (id.includes('.')) {
    throw new ApiError('That bookmark comes from an extension, so it cannot be changed here.')
  }
  return found(await getBookmark(id), 'bookmark')
}

export async function create(input: {
  label: string
  url: string
  icon?: string
  keywords?: string[]
  group?: string
}): Promise<Bookmark> {
  const row = await createBookmark(input)
  emit({ type: 'bookmarks.changed' })
  return fromRow(row)
}

export async function update(input: {
  id: string
  label?: string
  url?: string
  icon?: string
  keywords?: string[]
  group?: string
}): Promise<Bookmark> {
  await own(input.id)
  const { id, ...changes } = input
  const row = found(await updateBookmark(id, changes), 'bookmark')
  emit({ type: 'bookmarks.changed' })
  return fromRow(row)
}

export async function remove(id: string): Promise<void> {
  await own(id)
  await deleteBookmark(id)
  emit({ type: 'bookmarks.changed' })
}

/** Reorders the user's own bookmarks. Extension ids in the list are ignored. */
export async function reorder(ids: string[]): Promise<Bookmark[]> {
  await reorderBookmarks(ids.filter((id) => !id.includes('.')))
  emit({ type: 'bookmarks.changed' })
  return list()
}
