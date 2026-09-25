import { asc, eq, inArray } from 'drizzle-orm'
import { NEW_FOLDER_NAME, folderSubtree, type TabFolder } from '@fluid/sdk'
import { db } from './client'
import { tabFolders, tabs } from './schema'
import { adoptIfUnfocused, compactSidebar, drawnOrder, handFocusOn, nextPosition } from './tabs'

/**
 * The folders in a task's sidebar (see `tabFolders` in schema.ts).
 *
 * What is here is only ever a folder's own row and the rows inside it. Where
 * the sidebar says a tab or folder sits is written whole by `arrangeSidebar`
 * in tabs.ts, since a drag can move a folder and everything in it across the
 * divider at once, and that is one write rather than one per row.
 */

export async function listFolders(taskId: string): Promise<TabFolder[]> {
  return db()
    .select()
    .from(tabFolders)
    .where(eq(tabFolders.taskId, taskId))
    .orderBy(asc(tabFolders.position), asc(tabFolders.createdAt))
}

export async function getFolder(id: string): Promise<TabFolder | undefined> {
  const [row] = await db().select().from(tabFolders).where(eq(tabFolders.id, id)).limit(1)
  return row
}

/**
 * Makes a folder at the end of wherever it goes: the top of a section, or the
 * inside of `parent` — whose section it takes, since what is in a folder is in
 * the folder's section.
 */
export async function createFolder(
  taskId: string,
  input: { name?: string; parent?: TabFolder | null; pinned?: boolean }
): Promise<TabFolder> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(tabFolders)
      .values({
        taskId,
        parentId: input.parent?.id ?? null,
        name: input.name ?? NEW_FOLDER_NAME,
        pinned: input.parent?.pinned ?? input.pinned ?? false,
        position: await nextPosition(tx, taskId)
      })
      .returning()
    return row
  })
}

export async function updateFolder(
  id: string,
  changes: { name?: string; collapsed?: boolean }
): Promise<TabFolder | undefined> {
  if (changes.name === undefined && changes.collapsed === undefined) return getFolder(id)
  const [row] = await db().update(tabFolders).set(changes).where(eq(tabFolders.id, id)).returning()
  return row
}

/**
 * Every folder inside a folder, itself included, and every tab they hold. What
 * deleting or moving one carries with it.
 */
export async function folderContents(
  folder: TabFolder
): Promise<{ folders: TabFolder[]; tabIds: string[] }> {
  const folders = folderSubtree(await listFolders(folder.taskId), folder.id)
  const held =
    folders.length === 0
      ? []
      : await db()
          .select({ id: tabs.id })
          .from(tabs)
          .where(
            inArray(
              tabs.folderId,
              folders.map((candidate) => candidate.id)
            )
          )
  return { folders, tabIds: held.map((tab) => tab.id) }
}

/**
 * Deletes a folder row, taking the folders inside it along (see `parentId`).
 * The tabs they held are the caller's to close first, which is what stops what
 * they were running; any still here are dropped to the top of their section.
 */
export async function deleteFolder(id: string): Promise<void> {
  const folder = await getFolder(id)
  if (!folder) return
  await db().transaction(async (tx) => {
    await tx.delete(tabFolders).where(eq(tabFolders.id, id))
    await compactSidebar(tx, folder.taskId)
  })
}

/**
 * Moves a folder, and everything in it, to another task: to the end of the
 * top of that task's unpinned tabs, with every tab inside unpinned on the way.
 *
 * Unpinned for the reason a tab moved on its own is (see `moveTabToTask` in
 * the renderer's workspace): a pin says the address belongs to this task, and
 * something moved out of it has been judged to belong to another.
 *
 * Both tasks are left as `moveTab` leaves them — focus handed on if it was on a
 * tab that went, and the task joined adopting one if it had none.
 */
export async function moveFolder(id: string, taskId: string): Promise<TabFolder | undefined> {
  const folder = await getFolder(id)
  if (!folder) return undefined
  if (folder.taskId === taskId) return folder
  const { folders, tabIds } = await folderContents(folder)
  const folderIds = folders.map((candidate) => candidate.id)

  return db().transaction(async (tx) => {
    await handFocusOn(tx, folder.taskId, new Set(tabIds))

    const position = await nextPosition(tx, taskId)
    // The rest keep their parents and positions: they are only ever compared
    // among their siblings, and those all came along too.
    await tx
      .update(tabFolders)
      .set({ taskId, pinned: false })
      .where(inArray(tabFolders.id, folderIds))
    const [row] = await tx
      .update(tabFolders)
      .set({ parentId: null, position })
      .where(eq(tabFolders.id, id))
      .returning()

    if (tabIds.length > 0) {
      await tx
        .update(tabs)
        .set({ taskId, pinned: false, pinnedUrl: null })
        .where(inArray(tabs.id, tabIds))
    }

    await compactSidebar(tx, folder.taskId)
    await compactSidebar(tx, taskId)
    const moved = new Set(tabIds)
    const first = (await drawnOrder(tx, taskId)).find((tabId) => moved.has(tabId))
    if (first) await adoptIfUnfocused(tx, taskId, first)
    return row
  })
}
