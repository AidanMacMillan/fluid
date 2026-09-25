import { asc, eq, max } from 'drizzle-orm'
import { db } from './client'
import { type BookmarkRow, bookmarks } from './schema'

export async function listBookmarks(): Promise<BookmarkRow[]> {
  return db().select().from(bookmarks).orderBy(asc(bookmarks.position), asc(bookmarks.createdAt))
}

export async function getBookmark(id: string): Promise<BookmarkRow | undefined> {
  const [row] = await db().select().from(bookmarks).where(eq(bookmarks.id, id)).limit(1)
  return row
}

export async function createBookmark(
  values: Pick<BookmarkRow, 'label' | 'url'> &
    Partial<Pick<BookmarkRow, 'icon' | 'keywords' | 'group'>>
): Promise<BookmarkRow> {
  return db().transaction(async (tx) => {
    const [{ value }] = await tx.select({ value: max(bookmarks.position) }).from(bookmarks)
    const [row] = await tx
      .insert(bookmarks)
      .values({ ...values, position: (value ?? -1) + 1 })
      .returning()
    return row
  })
}

export async function updateBookmark(
  id: string,
  changes: Partial<Pick<BookmarkRow, 'label' | 'url' | 'icon' | 'keywords' | 'group'>>
): Promise<BookmarkRow | undefined> {
  if (Object.values(changes).every((value) => value === undefined)) return getBookmark(id)
  const [row] = await db().update(bookmarks).set(changes).where(eq(bookmarks.id, id)).returning()
  return row
}

export async function deleteBookmark(id: string): Promise<void> {
  await db().delete(bookmarks).where(eq(bookmarks.id, id))
}

export async function reorderBookmarks(orderedIds: string[]): Promise<void> {
  await db().transaction(async (tx) => {
    for (const [position, id] of orderedIds.entries()) {
      await tx.update(bookmarks).set({ position }).where(eq(bookmarks.id, id))
    }
  })
}
