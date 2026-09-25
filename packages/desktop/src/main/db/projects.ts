import { asc, eq, max, ne, sql } from 'drizzle-orm'
import { db } from './client'
import { type Project, projects, tasks } from './schema'

/**
 * Every project, in the order the picker draws them: by name.
 *
 * Alphabetical rather than by `position`, which is the order they were made in.
 * A picker is a thing you look down to find a name in, and creation order is a
 * fact about the past that nobody holds in their head — the fifth project made
 * is in no way the fifth project you would look for.
 *
 * Folded with `lower`, so a project named `api` is not filed after every
 * project with a capital letter. `createdAt` only settles two projects that are
 * genuinely called the same thing.
 */
export async function listProjects(): Promise<Project[]> {
  return db()
    .select()
    .from(projects)
    .orderBy(asc(sql`lower(${projects.name})`), asc(projects.createdAt))
}

export async function getProject(id: string): Promise<Project | undefined> {
  const [project] = await db().select().from(projects).where(eq(projects.id, id)).limit(1)
  return project
}

/**
 * The project everything falls back to: the oldest one.
 *
 * Two things lean on it. Background routines file the tasks they open here,
 * because a routine runs on a timer with nobody in front of it to ask; and a
 * launch that finds no project selected — a first launch, or one where the
 * selected project has since been deleted — starts here.
 *
 * Deliberately not the first row of the picker, which is alphabetical: a
 * fallback that moved when a project was renamed would quietly change where
 * every routine files its work, and the rename would look like it had done
 * nothing at all. `position` is creation order and nothing reorders it, so this
 * answer only changes when the project it names is deleted.
 *
 * There is always one. The migration that made this table made a project with
 * it, and deleting the last project is refused (see `deleteProject`).
 */
export async function firstProject(): Promise<Project | undefined> {
  const [project] = await db()
    .select()
    .from(projects)
    .orderBy(asc(projects.position), asc(projects.createdAt))
    .limit(1)
  return project
}

/** Appends a project to the end of the picker, in the space it was made for. */
export async function createProject(
  name: string,
  root: string | null,
  spaceId: string
): Promise<Project> {
  return db().transaction(async (tx) => {
    const [{ value }] = await tx.select({ value: max(projects.position) }).from(projects)

    const [project] = await tx
      .insert(projects)
      .values({ name, root, spaceId, position: (value ?? -1) + 1 })
      .returning()
    return project
  })
}

export async function updateProject(
  id: string,
  changes: { name?: string; root?: string | null }
): Promise<Project | undefined> {
  // Nothing to write; skip the round trip rather than emitting an empty UPDATE.
  if (changes.name === undefined && changes.root === undefined) return getProject(id)

  const [project] = await db().update(projects).set(changes).where(eq(projects.id, id)).returning()
  return project
}

/** How many open tasks a project would take with it. What the delete confirmation counts. */
export async function countOpenTasks(projectId: string): Promise<number> {
  const [row] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.projectId} = ${projectId} and ${tasks.status} = 'open'`)
  return row?.value ?? 0
}

/**
 * Deletes a project along with its tasks, and their tabs, notes and clipboard
 * history — all of which cascade from the task rows.
 *
 * Refuses the last one. Every task belongs to a project and the strip is built
 * by asking a project for its tasks, so an app with none has nothing to draw
 * and no way for the user to get back to having something.
 */
export async function deleteProject(id: string): Promise<void> {
  const [{ value }] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(projects)
    .where(ne(projects.id, id))
  if (value === 0) throw new Error('This is the only project. Make another one before deleting it.')

  await db().delete(projects).where(eq(projects.id, id))
}
