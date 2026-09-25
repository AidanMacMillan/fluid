import { dialog, type BrowserWindow } from 'electron'
import type { TaskAction, TaskActionIcon } from '@fluid/sdk'
import { taskType } from './api/contributions'
import { getTask } from './db/tasks'

/**
 * The buttons in a task's panel, above its pinned tabs.
 *
 * An extension's task type offers them (see `TaskTypeContribution.actions`),
 * and they run here, in the main process, the way a tab type's menu items do
 * (see src/main/tab-menu.ts). The window only ever sees what to draw — a
 * label or icon, whether it is pressable, a tooltip — and names the one pressed back
 * by id; the function that does the work never crosses the bridge.
 */

/** One button, as the window draws it. */
export type TaskActionInfo = {
  id: string
  label: string
  icon?: TaskActionIcon
  enabled: boolean
  hint?: string
}

/** How a press went. A failure's `message` is the extension's own sentence. */
export type TaskActionResult =
  { status: 'done' } | { status: 'cancelled' } | { status: 'failed'; message: string }

/** What a task's type offers it right now, or nothing for a task with no type. */
export async function listTaskActions(taskId: string): Promise<TaskActionInfo[]> {
  return (await actionsFor(taskId)).map((action) => ({
    id: action.id,
    label: action.label,
    ...(action.icon !== undefined ? { icon: action.icon } : {}),
    enabled: action.enabled ?? true,
    ...(action.hint !== undefined ? { hint: action.hint } : {})
  }))
}

/**
 * Runs one of a task's actions, asking first where it says to.
 *
 * The list is asked for afresh rather than trusted from when the panel was
 * drawn: the panel may have been sitting there while somebody else merged the
 * branch, and the fresh list is the one that knows.
 */
export async function runTaskAction(
  window: BrowserWindow | null,
  taskId: string,
  actionId: string
): Promise<TaskActionResult> {
  const action = (await actionsFor(taskId)).find((candidate) => candidate.id === actionId)
  if (!action) return { status: 'failed', message: 'That action is no longer offered.' }
  if (action.enabled === false) {
    return { status: 'failed', message: action.hint ?? `${action.label} is not available.` }
  }

  if (action.confirm && !(await confirmed(window, action.confirm))) return { status: 'cancelled' }

  try {
    await action.run()
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The task's type's actions. One that throws while building its list is
 * logged and offers nothing, as a tab type's menu does: the list is the
 * extension's, and so are its mistakes.
 */
async function actionsFor(taskId: string): Promise<TaskAction[]> {
  const task = await getTask(taskId)
  const contributed = taskType(task?.type ?? null)
  if (!task || !contributed?.actions) return []

  try {
    return await contributed.actions(task)
  } catch (error) {
    console.error(`The ${task.type} task actions failed to build:`, error)
    return []
  }
}

async function confirmed(
  window: BrowserWindow | null,
  confirm: NonNullable<TaskAction['confirm']>
): Promise<boolean> {
  const question = {
    type: 'question' as const,
    buttons: [confirm.button, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: confirm.message,
    ...(confirm.detail !== undefined ? { detail: confirm.detail } : {})
  }
  // Parented to the window that asked, so it opens as a sheet on the app — the
  // same rule resetting a profile follows.
  const { response } = window
    ? await dialog.showMessageBox(window, question)
    : await dialog.showMessageBox(question)
  return response === 0
}
