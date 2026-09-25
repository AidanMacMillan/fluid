import { sql } from 'drizzle-orm'
import { db } from './client'
import { siteIcons } from './schema'

/** One remembered site icon, as the cache above it holds it. */
export type StoredSiteIcon = {
  origin: string
  /** Null for a site that was asked and has no icon of its own. */
  dataUrl: string | null
  fetchedAt: Date
}

/**
 * Every remembered icon. Read once at first use and kept in memory from there
 * (see src/main/site-icons.ts): the table is one row per site the app has ever
 * opened, which is tens of rows, and the sidebar asks for icons a row at a time
 * while it is drawing.
 */
export async function listSiteIcons(): Promise<StoredSiteIcon[]> {
  return db().select().from(siteIcons)
}

/** Records what a site's icon turned out to be, replacing whatever was known. */
export async function putSiteIcon(origin: string, dataUrl: string | null): Promise<void> {
  await db()
    .insert(siteIcons)
    .values({ origin, dataUrl })
    .onConflictDoUpdate({
      target: siteIcons.origin,
      set: { dataUrl, fetchedAt: sql`now()` }
    })
}
