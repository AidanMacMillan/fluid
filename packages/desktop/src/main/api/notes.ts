import type { TaskNote } from '@fluid/sdk'
import {
  addTaskNote,
  deleteTaskNote,
  getTaskNote,
  listTaskNotes,
  updateTaskNote
} from '../db/task-notes'
import { getTask } from '../db/tasks'
import { emit } from './bus'
import { found } from './errors'

export async function list(taskId: string): Promise<TaskNote[]> {
  return listTaskNotes(taskId)
}

export async function get(id: string): Promise<TaskNote | null> {
  return (await getTaskNote(id)) ?? null
}

export async function add(taskId: string, body: string): Promise<TaskNote> {
  found(await getTask(taskId), 'task')
  const note = await addTaskNote(taskId, body)
  emit({ type: 'note.created', note })
  return note
}

export async function update(id: string, body: string): Promise<TaskNote> {
  const note = found(await updateTaskNote(id, body), 'note')
  emit({ type: 'note.updated', note })
  return note
}

export async function remove(id: string): Promise<void> {
  const note = await getTaskNote(id)
  if (!note) return
  await deleteTaskNote(id)
  emit({ type: 'note.deleted', note })
}
