import { asc, eq, max, sql } from 'drizzle-orm'
import { DEFAULT_SPACE_ID } from '../browsing'
import { db } from './client'
import { projects, spaces, type Space } from './schema'

/**
 * The spaces table, as rows. What a space *means* — which sessions it scopes,
 * what happens to a project moved into one — is src/main/spaces.ts and
 * src/main/browsing.ts; this is only the storage.
 */

/** Every space, in the order the picker draws them. */
export async function listSpaces(): Promise<Space[]> {
  return db().select().from(spaces).orderBy(asc(spaces.position), asc(spaces.createdAt))
}

export async function getSpace(id: string): Promise<Space | undefined> {
  const [space] = await db().select().from(spaces).where(eq(spaces.id, id)).limit(1)
  return space
}

/** How many projects each space holds, keyed by space id. What the rows count. */
export async function projectCountsBySpace(): Promise<Map<string, number>> {
  const rows = await db()
    .select({ spaceId: projects.spaceId, value: sql<number>`count(*)::int` })
    .from(projects)
    .groupBy(projects.spaceId)
  return new Map(rows.map((row) => [row.spaceId, row.value]))
}

/** Appends a space to the end of the picker. */
export async function createSpace(name: string): Promise<Space> {
  return db().transaction(async (tx) => {
    const [{ value }] = await tx.select({ value: max(spaces.position) }).from(spaces)

    const [space] = await tx
      .insert(spaces)
      .values({ name, position: (value ?? -1) + 1 })
      .returning()
    return space
  })
}

export async function renameSpace(id: string, name: string): Promise<Space | undefined> {
  const [space] = await db().update(spaces).set({ name }).where(eq(spaces.id, id)).returning()
  return space
}

/**
 * Deletes a space, after moving everything in it back to the default space.
 *
 * Moving rather than deleting, because a space is a browsing context and not a
 * container of work: the projects in it are real, with tasks and tabs and
 * history under them, and nobody tidying up their spaces means to throw those
 * away. What they lose is the isolation — which is the thing being deleted.
 *
 * The default space itself cannot go. It is where deleted spaces send their
 * projects, and its id is baked into partition names.
 */
export async function deleteSpace(id: string): Promise<void> {
  if (id === DEFAULT_SPACE_ID) throw new Error('The default space cannot be deleted.')

  await db().transaction(async (tx) => {
    await tx.update(projects).set({ spaceId: DEFAULT_SPACE_ID }).where(eq(projects.spaceId, id))
    await tx.delete(spaces).where(eq(spaces.id, id))
  })
}

/** Moves a project into a space. The project's tasks, tabs and folder are untouched. */
export async function setProjectSpace(projectId: string, spaceId: string): Promise<void> {
  await db().update(projects).set({ spaceId }).where(eq(projects.id, projectId))
}
