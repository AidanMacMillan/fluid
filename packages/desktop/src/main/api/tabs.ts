import { z } from 'zod'
import {
  placeInSidebar,
  sidebarTree,
  type SidebarArrangement,
  type SidebarItem,
  type Tab,
  type TabActivity,
  type TabActivityEntry,
  type TabFolder,
  type ValidNewTab
} from '@fluid/sdk'
import { getFolder, listFolders } from '../db/folders'
import {
  arrangeSidebar,
  clearTabDone,
  closeTab,
  createTab,
  getTab,
  listTabActivity,
  listTabs,
  moveTab,
  reorderTabs,
  setTabActivity,
  updateTab,
  updateTabPin,
  type ArrangedRow,
  type NewTabInput
} from '../db/tabs'
import { getTask } from '../db/tasks'
import { emit } from './bus'
import { tabType } from './contributions'
import { ApiError, found } from './errors'
import { announcingTaskChanges } from './tasks'

/**
 * Tabs, as the API offers them.
 *
 * Opening a tab never moves the user: it lands in its task and waits to be
 * looked at, even when it is the task's first tab and so becomes the one the
 * task opens on. Taking the user somewhere is `ui.reveal`, and only that.
 *
 * Closing a tab stops whatever it was running. The stopping is
 * src/main/api/teardown.ts, reacting to `tab.closed`.
 */

export async function list(taskId: string): Promise<Tab[]> {
  return listTabs(taskId)
}

export async function get(id: string): Promise<Tab | null> {
  return (await getTab(id)) ?? null
}

/**
 * An extension tab's payload, as its type says it has to look (see
 * `TabTypeContribution.payload`). The core types' payloads are checked by the
 * API's own schema before they get here; an extension's are only known once
 * its type is looked up, which is why this is a second step.
 */
function checkedPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const contributed = tabType(type)
  if (!contributed) throw new ApiError(`No installed extension draws ${type} tabs.`)
  if (!contributed.payload) return payload
  const parsed = contributed.payload.safeParse(payload)
  if (!parsed.success) {
    throw new ApiError(`Not a ${contributed.label} tab: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/**
 * Opens a tab, in a folder if one is named. A tab opened in a folder is in the
 * folder's section — and one opened in a pinned folder without an address of
 * its own is given the one `setPinned` would have given it, so that it is
 * pinned on the same terms as a tab dragged in there.
 */
export async function open(taskId: string, input: ValidNewTab): Promise<Tab> {
  found(await getTask(taskId), 'task')
  const folder = input.folderId ? await folderIn(taskId, input.folderId) : null
  const checked = input.type.includes('.')
    ? { ...input, payload: checkedPayload(input.type, input.payload) }
    : input
  const tab = (folder ? { ...checked, pinned: folder.pinned } : checked) as NewTabInput
  return announcingTaskChanges(
    [taskId],
    async () => {
      const created = await createTab(taskId, tab)
      if (!folder?.pinned || created.pinnedUrl !== null) return created
      const pinnedUrl = await pinAddressFor(created)
      if (pinnedUrl === null) return created
      return found(await updateTabPin(created.id, { pinned: true, pinnedUrl }), 'tab')
    },
    (tab) => emit({ type: 'tab.created', tab })
  )
}

/** A folder in a task, or a refusal in the caller's terms. */
async function folderIn(taskId: string, folderId: string): Promise<TabFolder> {
  const folder = found(await getFolder(folderId), 'folder')
  if (folder.taskId !== taskId) throw new ApiError('That folder is in another task.')
  return folder
}

/** A task's sidebar as it stands, as the tree it is drawn as. */
export async function sidebarOf(taskId: string): Promise<ReturnType<typeof sidebarTree>> {
  const [tabs, folders] = await Promise.all([listTabs(taskId), listFolders(taskId)])
  return sidebarTree(tabs, folders)
}

/**
 * Moves a tab or folder within its task's sidebar (see `tabs.place` and
 * `folders.place`): works out the sidebar with the row moved, and writes it
 * whole, so the move is pinned and unpinned by the same code a drag is.
 */
export async function placeRow(
  taskId: string,
  id: string,
  place: { parentId: string | null; pinned: boolean; index?: number }
): Promise<void> {
  // The section follows the folder, so a caller moving a row into one need
  // not say which section that is.
  const pinned = place.parentId ? (await folderIn(taskId, place.parentId)).pinned : place.pinned
  const items = placeInSidebar(await sidebarOf(taskId), id, { ...place, pinned })
  if (!items) throw new ApiError('A folder cannot go inside itself, or inside anything it holds.')
  await arrange(taskId, items)
}

export async function place(input: {
  id: string
  folderId: string | null
  pinned?: boolean
  index?: number
}): Promise<Tab> {
  const tab = found(await getTab(input.id), 'tab')
  await placeRow(tab.taskId, tab.id, {
    parentId: input.folderId,
    pinned: input.pinned ?? tab.pinned,
    index: input.index
  })
  return found(await getTab(tab.id), 'tab')
}

export async function update(input: {
  id: string
  title?: string | null
  payload?: Record<string, unknown>
  viewState?: unknown
}): Promise<Tab> {
  let payload = input.payload
  if (payload !== undefined) {
    // Only against a type that is registered: rewriting the payload of a tab
    // whose extension is not running is not this check's to refuse.
    const { type } = found(await getTab(input.id), 'tab')
    if (type.includes('.') && tabType(type)) payload = checkedPayload(type, payload)
  }
  const tab = found(
    await updateTab(input.id, {
      title: input.title,
      payload,
      viewState: input.viewState
    }),
    'tab'
  )
  emit({ type: 'tab.updated', tab })
  return tab
}

export async function move(id: string, taskId: string): Promise<Tab> {
  const before = found(await getTab(id), 'tab')
  const target = found(await getTask(taskId), 'task')
  const source = found(await getTask(before.taskId), 'task')
  if (target.projectId !== source.projectId) {
    throw new ApiError('A tab can only move between tasks in the same project.')
  }
  if (before.taskId === taskId) return before

  return announcingTaskChanges(
    [before.taskId, taskId],
    async () => found(await moveTab(id, taskId), 'tab'),
    (tab) => emit({ type: 'tab.moved', tab, fromTaskId: before.taskId })
  )
}

/**
 * The address a pinned tab comes home to. A browser tab's is the page it is on
 * when it is pinned; an extension's tab has one if its type says so.
 */
async function pinAddressFor(tab: Tab): Promise<string | null> {
  if (tab.type === 'browser') return tab.payload.url
  const contributed = tab.type.includes('.') ? tabType(tab.type) : undefined
  if (!contributed?.pinnedUrl) return null
  return contributed.pinnedUrl(tab).catch(() => null)
}

export async function setPinned(id: string, pinned: boolean): Promise<Tab> {
  const current = found(await getTab(id), 'tab')
  const tab = found(
    await updateTabPin(
      id,
      pinned
        ? { pinned: true, pinnedUrl: await pinAddressFor(current) }
        : { pinned: false, pinnedUrl: null }
    ),
    'tab'
  )
  if (current.pinned !== tab.pinned || current.pinnedUrl !== tab.pinnedUrl) {
    emit({ type: 'tab.updated', tab })
  }
  return tab
}

/**
 * Announced only when it changes: a terminal reports every command it starts,
 * and a tab that already says so is not news.
 */
export async function setActivity(id: string, activity: TabActivity | null): Promise<Tab> {
  const current = found(await getTab(id), 'tab')
  if (current.activity === activity) return current
  const tab = found(await setTabActivity(id, activity), 'tab')
  emit({ type: 'tab.updated', tab })
  return tab
}

/**
 * One conditional write rather than a read and a `setActivity`, so that work
 * which starts again in between is not wiped by the user having looked.
 */
export async function markSeen(id: string): Promise<Tab> {
  const tab = await clearTabDone(id)
  if (!tab) return found(await getTab(id), 'tab')
  emit({ type: 'tab.updated', tab })
  return tab
}

export async function activity(projectId: string): Promise<TabActivityEntry[]> {
  return listTabActivity(projectId)
}

export async function reorder(taskId: string, ids: string[]): Promise<Tab[]> {
  const tabs = await reorderTabs(taskId, ids)
  emit({ type: 'tabs.reordered', taskId, tabs, folders: await listFolders(taskId) })
  return tabs
}

/**
 * Writes a task's sidebar whole, as a drag in it leaves it (see `tabs.arrange`
 * in the SDK).
 *
 * The shape is checked here rather than trusted: a row's folder has to be one
 * already listed, which is also what makes a loop of folders impossible to ask
 * for, and whatever is in a folder takes the folder's section whatever the row
 * says — so a folder dragged across the divider brings its tabs with it even
 * from a caller that only thought to flip the folder.
 *
 * A tab that changes section gets or loses its address the way `setPinned`
 * gives and takes one. Each tab whose row changed is announced, and then the
 * sidebar as a whole.
 */
export async function arrange(taskId: string, items: SidebarItem[]): Promise<SidebarArrangement> {
  found(await getTask(taskId), 'task')
  const [before, folders] = await Promise.all([listTabs(taskId), listFolders(taskId)])
  const tabsById = new Map(before.map((tab) => [tab.id, tab]))
  const folderIds = new Set(folders.map((folder) => folder.id))

  /** Each folder listed so far, and the section it went in. */
  const listed = new Map<string, boolean>()
  const rows: ArrangedRow[] = []
  for (const item of items) {
    let pinned = item.pinned
    if (item.parentId !== null) {
      const section = listed.get(item.parentId)
      if (section === undefined) {
        throw new ApiError('A folder has to be listed before what is in it.')
      }
      pinned = section
    }

    if (item.kind === 'folder') {
      if (!folderIds.has(item.id)) continue
      listed.set(item.id, pinned)
      rows.push({ kind: 'folder', id: item.id, parentId: item.parentId, pinned })
      continue
    }

    const tab = tabsById.get(item.id)
    if (!tab) continue
    const pinnedUrl = tab.pinned === pinned ? undefined : pinned ? await pinAddressFor(tab) : null
    rows.push({ kind: 'tab', id: tab.id, folderId: item.parentId, pinned, pinnedUrl })
  }

  await arrangeSidebar(taskId, rows)

  const [tabs, after] = await Promise.all([listTabs(taskId), listFolders(taskId)])
  for (const tab of tabs) {
    const was = tabsById.get(tab.id)
    if (
      was &&
      (was.folderId !== tab.folderId ||
        was.pinned !== tab.pinned ||
        was.pinnedUrl !== tab.pinnedUrl)
    ) {
      emit({ type: 'tab.updated', tab })
    }
  }
  emit({ type: 'tabs.reordered', taskId, tabs, folders: after })
  return { tabs, folders: after }
}

export async function close(id: string): Promise<void> {
  const tab = await getTab(id)
  if (!tab) return
  await announcingTaskChanges(
    [tab.taskId],
    () => closeTab(id),
    () => emit({ type: 'tab.closed', tab })
  )
}
