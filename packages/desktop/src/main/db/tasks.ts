import { and, asc, eq, inArray, max } from 'drizzle-orm'
import { db } from './client'
import type { TabSplit, TaskColor, TaskIcon } from '@fluid/sdk'
import { type Task, type TaskFact, type TaskStatus, type TaskType, tasks } from './schema'

/**
 * One project's tasks. The project is not optional: the strip shows a single
 * project's work at a time, so a list that spanned them all would be a strip
 * of everything the user has ever had open.
 */
export async function listTasks(projectId: string, status?: TaskStatus): Promise<Task[]> {
  return db()
    .select()
    .from(tasks)
    .where(
      status
        ? and(eq(tasks.projectId, projectId), eq(tasks.status, status))
        : eq(tasks.projectId, projectId)
    )
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
}

export async function getTask(id: string): Promise<Task | undefined> {
  const [task] = await db().select().from(tasks).where(eq(tasks.id, id)).limit(1)
  return task
}

/**
 * Appends a task to the end of a project's strip, the way `createTab` appends a
 * tab.
 *
 * The type, the icon and the facts are settled here and not after, for the
 * same reason: they say what the task is, so nothing that draws the task should
 * ever see it without them. A row that arrives typed and then gains its facts a moment
 * later is a sidebar that redraws in front of the user for no reason anybody
 * watching could explain. Tasks the user opens themselves have neither, which
 * is the ordinary case.
 */
export async function createTask(
  projectId: string,
  title?: string | null,
  type?: TaskType | null,
  facts?: TaskFact[] | null,
  look?: { icon?: TaskIcon; color?: TaskColor }
): Promise<Task> {
  return db().transaction(async (tx) => {
    // The end of *this* project's strip: positions are per project, since each
    // project's strip is ordered and drawn on its own.
    const [{ value }] = await tx
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))

    const [task] = await tx
      .insert(tasks)
      .values({
        projectId,
        title: title ?? null,
        type: type ?? null,
        // Left out rather than defaulted here, so the column's default is the
        // one place that says what a task wears when nobody chose.
        icon: look?.icon,
        color: look?.color,
        // Empty is the same as absent: a panel with nothing in it should not be
        // drawn, and null is what the rest of the app already reads as nothing.
        facts: facts != null && facts.length > 0 ? facts : null,
        position: (value ?? -1) + 1
      })
      .returning()
    return task
  })
}

/** The position one past the end of a project's strip. */
export async function nextTaskPosition(projectId: string): Promise<number> {
  const [{ value }] = await db()
    .select({ value: max(tasks.position) })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
  return (value ?? -1) + 1
}

/**
 * Rewrites the strip so positions run 0..n-1 with no gaps. Ids missing from
 * `orderedIds` — settled tasks, which the strip never shows — keep whatever
 * position they had; positions are not unique, so an overlap is harmless, and
 * the tasks the caller listed still sort among themselves in the given order.
 */
export async function reorderTasks(orderedIds: string[]): Promise<Task[]> {
  // `inArray` cannot be built from an empty list, and there is nothing to write.
  if (orderedIds.length === 0) return []

  await db().transaction(async (tx) => {
    for (const [position, id] of orderedIds.entries()) {
      await tx.update(tasks).set({ position }).where(eq(tasks.id, id))
    }
  })

  return db()
    .select()
    .from(tasks)
    .where(inArray(tasks.id, orderedIds))
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
}

export async function updateTask(
  id: string,
  changes: {
    title?: string | null
    icon?: TaskIcon
    color?: TaskColor
    status?: TaskStatus
    facts?: TaskFact[] | null
    splits?: TabSplit[]
    position?: number
  }
): Promise<Task | undefined> {
  // Nothing to write; skip the round trip rather than emitting an empty UPDATE.
  if (Object.values(changes).every((value) => value === undefined)) {
    return getTask(id)
  }

  const [task] = await db().update(tasks).set(changes).where(eq(tasks.id, id)).returning()
  return task
}

/** Deletes a task along with its notes and tabs (both cascade). */
export async function deleteTask(id: string): Promise<void> {
  await db().delete(tasks).where(eq(tasks.id, id))
}
