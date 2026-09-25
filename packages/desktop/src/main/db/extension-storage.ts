import { and, eq, like, sql } from 'drizzle-orm'
import { db } from './client'
import { extensionStorage } from './schema'

export async function getExtensionValue(extensionId: string, key: string): Promise<unknown> {
  const [row] = await db()
    .select({ value: extensionStorage.value })
    .from(extensionStorage)
    .where(and(eq(extensionStorage.extensionId, extensionId), eq(extensionStorage.key, key)))
    .limit(1)
  return row?.value
}

export async function setExtensionValue(
  extensionId: string,
  key: string,
  value: unknown
): Promise<void> {
  await db()
    .insert(extensionStorage)
    .values({ extensionId, key, value })
    .onConflictDoUpdate({
      target: [extensionStorage.extensionId, extensionStorage.key],
      set: { value, updatedAt: sql`now()` }
    })
}

export async function deleteExtensionValue(extensionId: string, key: string): Promise<void> {
  await db()
    .delete(extensionStorage)
    .where(and(eq(extensionStorage.extensionId, extensionId), eq(extensionStorage.key, key)))
}

export async function extensionKeys(extensionId: string, prefix = ''): Promise<string[]> {
  // `like` with the prefix's own wildcards escaped, so a key containing `%` or
  // `_` matches only itself.
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = await db()
    .select({ key: extensionStorage.key })
    .from(extensionStorage)
    .where(and(eq(extensionStorage.extensionId, extensionId), like(extensionStorage.key, pattern)))
  return rows.map((row) => row.key)
}

/** Deletes everything an extension stored. For an installed extension being removed. */
export async function deleteExtensionStorage(extensionId: string): Promise<void> {
  await db().delete(extensionStorage).where(eq(extensionStorage.extensionId, extensionId))
}
