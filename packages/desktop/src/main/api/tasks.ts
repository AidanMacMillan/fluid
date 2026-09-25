import {
  NEW_TASK_TITLE,
  normalizeSplits,
  sameSplits,
  splitContaining,
  tabIdsInSplit,
  type TabSplit,
  type Task,
  type TaskColor,
  type TaskFact,
  type TaskIcon,
  type TaskStatus
} from '@fluid/sdk'
import {
  createTask as createTaskRow,
  deleteTask as deleteTaskRow,
  getTask,
  listTasks,
  nextTaskPosition,
  reorderTasks as reorderTaskRows,
  updateTask
} from '../db/tasks'
import { listTabs, setActiveTab as setActiveTabRow } from '../db/tabs'
import { emit } from './bus'
import { ApiError, found } from './errors'
import { dismissTaskNotifications } from '../notifications'
import { clearTaskClipboard } from './teardown'

/**
 * Tasks, as the API offers them.
 *
 * The rules about what a task may be live here and nowhere else: what a new
 * one is called, and that settling and deleting stop whatever its tabs were
 * running (the stopping itself is src/main/api/teardown.ts, which reacts to the
 * events emitted here). There is deliberately no rule that a project always has
 * a task: an empty strip is a state the app draws, not one it repairs.
 */

export async function list(projectId: string, status?: TaskStatus): Promise<Task[]> {
  return listTasks(projectId, status)
}

export async function get(id: string): Promise<Task | null> {
  return (await getTask(id)) ?? null
}

export async function create(input: {
  projectId: string
  title?: string | null
  type?: string | null
  icon?: TaskIcon
  color?: TaskColor
  facts?: TaskFact[] | null
}): Promise<Task> {
  const task = await createTaskRow(
    input.projectId,
    input.title ?? NEW_TASK_TITLE,
    input.type ?? null,
    input.facts ?? null,
    { icon: input.icon, color: input.color }
  )
  emit({ type: 'task.created', task })
  return task
}

/** Writes a change to a task's row and announces it, with the row as it was. */
async function change(id: string, changes: Parameters<typeof updateTask>[1]): Promise<Task> {
  const previous = found(await getTask(id), 'task')
  const task = found(await updateTask(id, changes), 'task')
  emit({ type: 'task.updated', task, previous })
  return task
}

export async function update(input: {
  id: string
  title?: string | null
  icon?: TaskIcon
  color?: TaskColor
  facts?: TaskFact[] | null
}): Promise<Task> {
  const title = input.title === undefined ? undefined : input.title?.trim() || null
  const facts = input.facts === undefined ? undefined : input.facts?.length ? input.facts : null
  return change(input.id, { title, icon: input.icon, color: input.color, facts })
}

export async function settle(id: string): Promise<Task> {
  const task = found(await getTask(id), 'task')
  if (task.status === 'settled') return task
  return change(id, { status: 'settled' })
}

export async function reopen(id: string): Promise<Task> {
  const task = found(await getTask(id), 'task')
  if (task.status === 'open') return task
  // Back at the end of the strip, rather than wherever it sat before it was
  // settled — which may now be the middle of somebody else's order.
  return change(id, { status: 'open', position: await nextTaskPosition(task.projectId) })
}

export async function remove(id: string): Promise<void> {
  const task = await getTask(id)
  if (!task) return
  // Read before the delete: the tabs cascade away with the task, and what they
  // were running is only reachable through them.
  const tabs = await listTabs(id)
  await clearTaskClipboard(id)
  await deleteTaskRow(id)
  // A click on one of these would lead nowhere now.
  dismissTaskNotifications(id)
  emit({ type: 'task.deleted', task, tabs })
}

export async function reorder(projectId: string, ids: string[]): Promise<Task[]> {
  const tasks = await reorderTaskRows(ids)
  if (tasks.some((task) => task.projectId !== projectId)) {
    throw new ApiError('Those tasks are not all in that project.')
  }
  emit({ type: 'tasks.reordered', projectId, tasks })
  return tasks
}

/**
 * Replaces a task's splits with a tidied copy of `splits`: only tabs the task
 * holds, each in one split at most, and no split of fewer than two (see
 * `normalizeSplits`) — and moves it to `activeTabId` in the same breath, when
 * one is given. Announced once, and only when something changed.
 */
export async function setSplits(
  id: string,
  splits: TabSplit[],
  activeTabId?: string
): Promise<Task> {
  const previous = found(await getTask(id), 'task')
  const owned = new Set((await listTabs(id)).map((tab) => tab.id))
  if (activeTabId !== undefined && !owned.has(activeTabId)) {
    throw new ApiError('That tab is not in that task.')
  }
  const tidy = normalizeSplits(splits, (tabId) => owned.has(tabId))
  const focus = activeTabId !== undefined && activeTabId !== previous.activeTabId
  if (sameSplits(previous.splits, tidy) && !focus) return previous

  if (!sameSplits(previous.splits, tidy)) await updateTask(id, { splits: tidy })
  if (focus) await setActiveTabRow(id, activeTabId)
  const task = found(await getTask(id), 'task')
  emit({ type: 'task.updated', task, previous })
  return task
}

export async function setActiveTab(id: string, tabId: string | null): Promise<Task> {
  const previous = found(await getTask(id), 'task')
  if (previous.activeTabId === tabId) return previous
  const task = found(await setActiveTabRow(id, tabId), 'task')
  emit({ type: 'task.updated', task, previous })
  return task
}

/**
 * Runs a write that may move a task's active tab as a side effect — opening a
 * task's first tab adopts it, closing or moving the active one hands focus on —
 * and announces what changed: first whatever `announce` says the write itself
 * was, then the task rows it moved.
 *
 * In that order so that a subscriber hearing about a tab still sees the tasks
 * as they were: a window deciding whether the tab that moved was the one on
 * screen needs to know which tab that was before the move.
 */
export async function announcingTaskChanges<T>(
  taskIds: string[],
  write: () => Promise<T>,
  announce: (result: T) => void
): Promise<T> {
  const ids = [...new Set(taskIds)]
  const before = await Promise.all(ids.map((id) => getTask(id)))
  const result = await write()
  for (const previous of before) if (previous) await settleSplits(previous)
  const after = await Promise.all(ids.map((id) => getTask(id)))
  announce(result)
  before.forEach((previous, index) => {
    const task = after[index]
    if (
      previous &&
      task &&
      (task.activeTabId !== previous.activeTabId || !sameSplits(task.splits, previous.splits))
    ) {
      emit({ type: 'task.updated', task, previous })
    }
  })
  return result
}

/**
 * Catches a task's splits up with a tab having left it — closed, or moved to
 * another task — given the task as it was before.
 *
 * The tab comes out of whichever split it was in, which may leave that split
 * with one tab and so no split at all. And if it was the tab in front, focus
 * stays with the rest of its split rather than going to whichever row was next
 * in the strip: those are what the user was looking at alongside it, and the
 * split staying up is what says the tab went rather than the view changing.
 */
async function settleSplits(previous: Task): Promise<void> {
  if (previous.splits.length === 0) return
  const owned = new Set((await listTabs(previous.id)).map((tab) => tab.id))
  const splits = normalizeSplits(previous.splits, (tabId) => owned.has(tabId))
  if (!sameSplits(splits, previous.splits)) await updateTask(previous.id, { splits })

  const active = previous.activeTabId
  if (active === null || owned.has(active)) return
  const was = splitContaining(previous.splits, active)
  if (!was) return
  const order = tabIdsInSplit(was)
  const at = order.indexOf(active)
  const sibling =
    order.slice(at + 1).find((tabId) => owned.has(tabId)) ??
    order
      .slice(0, at)
      .reverse()
      .find((tabId) => owned.has(tabId))
  if (sibling) await setActiveTabRow(previous.id, sibling)
}
