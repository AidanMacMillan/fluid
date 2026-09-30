import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm'
import type { HistoryEntry } from '@fluid/sdk'
import { db } from './client'
import { historyEntries, siteIcons } from './schema'

export type NewHistoryEntry = typeof historyEntries.$inferInsert

export async function listHistory(
  taskId: string,
  query = '',
  limit = 100,
  offset = 0
): Promise<HistoryEntry[]> {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
  const entries = await db()
    .select()
    .from(historyEntries)
    .where(
      and(
        eq(historyEntries.taskId, taskId),
        query
          ? or(
              ...[
                historyEntries.title,
                historyEntries.label,
                historyEntries.type,
                historyEntries.location,
                historyEntries.sessionId
              ].map((column) => ilike(column, pattern))
            )
          : undefined
      )
    )
    .orderBy(desc(historyEntries.visitedAt), desc(historyEntries.id))
    .limit(limit)
    .offset(offset)

  const originOf = (entry: HistoryEntry): string | null => {
    if (entry.type !== 'browser' || !entry.location) return null
    try {
      const url = new URL(entry.location)
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null
    } catch {
      return null
    }
  }
  const origins = [...new Set(entries.map(originOf).filter((origin) => origin !== null))]
  if (origins.length === 0) return entries
  // History only reads remembered icons; opening it must not revisit old sites.
  const icons = await db().select().from(siteIcons).where(inArray(siteIcons.origin, origins))
  const byOrigin = new Map(icons.map((icon) => [icon.origin, icon.dataUrl]))
  return entries.map((entry) => {
    const favicon = byOrigin.get(originOf(entry) ?? '')
    return favicon ? { ...entry, favicon } : entry
  })
}

export async function insertHistory(input: NewHistoryEntry): Promise<HistoryEntry> {
  const [entry] = await db().insert(historyEntries).values(input).returning()
  return entry
}

export async function updateHistory(
  id: string,
  taskId: string,
  changes: Partial<Pick<HistoryEntry, 'title' | 'location' | 'sessionId' | 'metadata'>>
): Promise<void> {
  await db()
    .update(historyEntries)
    .set(changes)
    .where(and(eq(historyEntries.id, id), eq(historyEntries.taskId, taskId)))
}

export async function deleteHistory(taskId: string, id?: string): Promise<void> {
  await db()
    .delete(historyEntries)
    .where(and(eq(historyEntries.taskId, taskId), id ? eq(historyEntries.id, id) : undefined))
}
