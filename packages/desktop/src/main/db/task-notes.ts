import { asc, eq } from 'drizzle-orm'
import { db } from './client'
import { type TaskNote, taskNotes } from './schema'

export async function listTaskNotes(taskId: string): Promise<TaskNote[]> {
  return db()
    .select()
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .orderBy(asc(taskNotes.createdAt))
}

export async function getTaskNote(id: string): Promise<TaskNote | undefined> {
  const [note] = await db().select().from(taskNotes).where(eq(taskNotes.id, id)).limit(1)
  return note
}

/** Appends a note to a task. Fails if the task does not exist (FK). */
export async function addTaskNote(taskId: string, body: string): Promise<TaskNote> {
  const [note] = await db().insert(taskNotes).values({ taskId, body }).returning()
  return note
}

export async function updateTaskNote(id: string, body: string): Promise<TaskNote | undefined> {
  const [note] = await db().update(taskNotes).set({ body }).where(eq(taskNotes.id, id)).returning()
  return note
}

export async function deleteTaskNote(id: string): Promise<void> {
  await db().delete(taskNotes).where(eq(taskNotes.id, id))
}
