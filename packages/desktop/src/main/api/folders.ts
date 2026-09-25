import type { Tab, TabFolder } from '@fluid/sdk'
import {
  createFolder,
  deleteFolder,
  folderContents,
  getFolder,
  listFolders,
  moveFolder,
  updateFolder
} from '../db/folders'
import { getTab } from '../db/tabs'
import { getTask } from '../db/tasks'
import { emit } from './bus'
import { ApiError, found } from './errors'
import { close as closeTab, placeRow } from './tabs'
import { announcingTaskChanges } from './tasks'

/**
 * Folders in a task's sidebar, as the API offers them: being made, named,
 * folded, moved about the sidebar or to another task, and deleted.
 *
 * Moving one about the sidebar is written along with the tabs, by the same
 * whole-sidebar write a drag ends with (see `placeRow` in ./tabs.ts), since a
 * folder crossing the divider is everything inside it crossing too.
 */

export async function list(taskId: string): Promise<TabFolder[]> {
  return listFolders(taskId)
}

export async function get(id: string): Promise<TabFolder | null> {
  return (await getFolder(id)) ?? null
}

/** Moves a folder within its task's sidebar, taking everything in it along. */
export async function place(input: {
  id: string
  parentId: string | null
  pinned?: boolean
  index?: number
}): Promise<TabFolder> {
  const folder = found(await getFolder(input.id), 'folder')
  await placeRow(folder.taskId, folder.id, {
    parentId: input.parentId,
    pinned: input.pinned ?? folder.pinned,
    index: input.index
  })
  return found(await getFolder(folder.id), 'folder')
}

export async function create(input: {
  taskId: string
  name?: string
  parentId?: string | null
  pinned?: boolean
}): Promise<TabFolder> {
  found(await getTask(input.taskId), 'task')
  const parent = input.parentId ? found(await getFolder(input.parentId), 'folder') : null
  if (parent && parent.taskId !== input.taskId) {
    throw new ApiError('That folder is in another task.')
  }
  const folder = await createFolder(input.taskId, {
    name: input.name,
    parent,
    pinned: input.pinned
  })
  emit({ type: 'folder.created', folder })
  return folder
}

export async function update(input: {
  id: string
  name?: string
  collapsed?: boolean
}): Promise<TabFolder> {
  const before = found(await getFolder(input.id), 'folder')
  const folder = found(
    await updateFolder(input.id, { name: input.name, collapsed: input.collapsed }),
    'folder'
  )
  if (before.name !== folder.name || before.collapsed !== folder.collapsed) {
    emit({ type: 'folder.updated', folder })
  }
  return folder
}

/**
 * Moves a folder to another task, on the terms `tabs.move` moves a tab on:
 * only within a project, since a task in another one is a strip its own
 * project could no longer reach.
 */
export async function move(id: string, taskId: string): Promise<TabFolder> {
  const before = found(await getFolder(id), 'folder')
  const target = found(await getTask(taskId), 'task')
  const source = found(await getTask(before.taskId), 'task')
  if (target.projectId !== source.projectId) {
    throw new ApiError('A folder can only move between tasks in the same project.')
  }
  if (before.taskId === taskId) return before

  const { tabIds } = await folderContents(before)
  const { folder } = await announcingTaskChanges(
    [before.taskId, taskId],
    async () => {
      const folder = found(await moveFolder(id, taskId), 'folder')
      const tabs = await Promise.all(tabIds.map((tabId) => getTab(tabId)))
      return { folder, tabs: tabs.filter((tab): tab is Tab => tab !== undefined) }
    },
    ({ folder, tabs }) => {
      for (const tab of tabs) emit({ type: 'tab.moved', tab, fromTaskId: before.taskId })
      emit({ type: 'folder.moved', folder, fromTaskId: before.taskId })
    }
  )
  return folder
}

/**
 * Closes every tab in a folder and the folders inside it, one at a time and
 * each as `tabs.close` would — stopping what it ran, handing on focus — and
 * then deletes the folders. The tabs go first because a tab closed that way is
 * the only kind whose teardown is certain to happen.
 */
export async function remove(id: string): Promise<void> {
  const folder = await getFolder(id)
  if (!folder) return
  const { folders, tabIds } = await folderContents(folder)
  for (const tabId of tabIds) await closeTab(tabId)
  await deleteFolder(id)
  for (const gone of folders) emit({ type: 'folder.deleted', folder: gone })
}
