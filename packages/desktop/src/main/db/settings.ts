import { eq, sql } from 'drizzle-orm'
import { db } from './client'
import { settings } from './schema'

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value as T | undefined
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: sql`now()` }
    })
}

export async function deleteSetting(key: string): Promise<void> {
  await db().delete(settings).where(eq(settings.key, key))
}

export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = await db().select().from(settings)
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}
