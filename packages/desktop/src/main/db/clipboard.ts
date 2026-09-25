import { and, desc, eq, notInArray } from 'drizzle-orm'
import { db, type Transaction } from './client'
import { type ClipboardEntry, type NewClipboardEntry, clipboardEntries } from './schema'

/**
 * How many entries a task keeps. Old ones fall off the end rather than being
 * kept for ever: a clipboard history is a working surface, and the thing you
 * are reaching back for is nearly always within the last few minutes of it. The
 * cap is what stops a long-lived task from growing the database — and, through
 * the images, the file store — without bound.
 *
 * Generous enough that reaching it is a day's work rather than an afternoon's,
 * because falling off the end is not recoverable and a cap that bites is worse
 * than one that never does.
 */
export const CLIPBOARD_LIMIT = 200

/** Newest first, which is the order the panel draws and the only one it wants. */
export async function listClipboardEntries(taskId: string): Promise<ClipboardEntry[]> {
  return db()
    .select()
    .from(clipboardEntries)
    .where(eq(clipboardEntries.taskId, taskId))
    .orderBy(desc(clipboardEntries.createdAt), desc(clipboardEntries.id))
}

export async function getClipboardEntry(id: string): Promise<ClipboardEntry | undefined> {
  const [entry] = await db()
    .select()
    .from(clipboardEntries)
    .where(eq(clipboardEntries.id, id))
    .limit(1)
  return entry
}

/**
 * What an operation left behind in the file store. Every entry-removing call
 * answers with one of these rather than deleting the files itself: the store is
 * src/main/files.ts's, and a database module that reached into it would be the
 * one place where a failed unlink could roll back a committed delete.
 *
 * Empty for the overwhelmingly common case — text keeps nothing on disk.
 */
export type OrphanedImages = string[]

/**
 * Drops everything past the cap for one task and answers with the images that
 * went with them.
 *
 * Expressed as "keep the newest N, delete the rest" rather than as an offset
 * delete, because the two are not the same statement once a second insert can
 * land between reading the offset and deleting from it, and only the first is
 * safe to run twice.
 */
async function trim(tx: Transaction, taskId: string): Promise<OrphanedImages> {
  const keep = await tx
    .select({ id: clipboardEntries.id })
    .from(clipboardEntries)
    .where(eq(clipboardEntries.taskId, taskId))
    .orderBy(desc(clipboardEntries.createdAt), desc(clipboardEntries.id))
    .limit(CLIPBOARD_LIMIT)

  // The overwhelmingly common case, and the one that keeps `notInArray` from
  // ever being handed an empty list: a task below the cap has nothing past it.
  if (keep.length < CLIPBOARD_LIMIT) return []

  const dropped = await tx
    .delete(clipboardEntries)
    .where(
      and(
        eq(clipboardEntries.taskId, taskId),
        notInArray(
          clipboardEntries.id,
          keep.map((row) => row.id)
        )
      )
    )
    .returning({ storageKey: clipboardEntries.storageKey })

  return storageKeys(dropped)
}

/** The keys among a set of deleted rows that actually named a file. */
function storageKeys(rows: { storageKey: string | null }[]): OrphanedImages {
  return rows.flatMap((row) => (row.storageKey ? [row.storageKey] : []))
}

/** An entry, and whatever its insertion pushed off the end of the task. */
export type RecordedClipboardEntry = {
  entry: ClipboardEntry
  orphaned: OrphanedImages
}

/**
 * Appends one copy to a task's history and trims the task back to the cap.
 *
 * Both halves in one transaction so that a history is never momentarily over
 * its cap, and so that a failure leaves neither the row nor the trim: the
 * caller unlinks the images it is handed, and it must not be handed files that
 * belong to rows still in the table.
 */
export async function recordClipboardEntry(
  entry: NewClipboardEntry
): Promise<RecordedClipboardEntry> {
  return db().transaction(async (tx) => {
    const [row] = await tx.insert(clipboardEntries).values(entry).returning()
    return { entry: row, orphaned: await trim(tx, entry.taskId) }
  })
}

/**
 * Settles what a rich entry looks like, once a renderer has run the sanitiser
 * over it — which the capture could not, having no DOM to do it with.
 *
 * Two outcomes, and the row says which by what it ends up being. Markup worth
 * drawing is stored, and the entry stays rich. Nothing worth drawing means the
 * markup said no more than the text did — a copy out of a plain field carries a
 * `<meta charset>` and little else — so the entry is relabelled as the plain
 * text it turned out to be. Either way the question is asked once: a rich entry
 * with no `safeHtml` is one nothing has looked at yet, and after this there are
 * none.
 *
 * `html` and `rtf` are untouched by all of this. What an entry *renders* as is
 * not what it *pastes* as, and relabelling the first must not quietly change
 * the second.
 */
export async function resolveClipboardEntry(id: string, safeHtml: string | null): Promise<void> {
  await db()
    .update(clipboardEntries)
    .set(safeHtml === null ? { kind: 'text' } : { safeHtml })
    .where(eq(clipboardEntries.id, id))
}

/** Forgets one entry, and names the image it held if it held one. */
export async function deleteClipboardEntry(id: string): Promise<OrphanedImages> {
  return storageKeys(
    await db()
      .delete(clipboardEntries)
      .where(eq(clipboardEntries.id, id))
      .returning({ storageKey: clipboardEntries.storageKey })
  )
}

/** Forgets a whole task's history, and names every image it held. */
export async function clearClipboardEntries(taskId: string): Promise<OrphanedImages> {
  return storageKeys(
    await db()
      .delete(clipboardEntries)
      .where(eq(clipboardEntries.taskId, taskId))
      .returning({ storageKey: clipboardEntries.storageKey })
  )
}
