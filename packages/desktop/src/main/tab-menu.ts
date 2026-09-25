import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { NEW_TASK_TITLE, splitContaining, type Tab, type TabMenuItem } from '@fluid/sdk'
import { tabType } from './api/contributions'
import { folderContents, getFolder } from './db/folders'
import { getTab } from './db/tabs'
import { getTask, listTasks } from './db/tasks'
import { profileMenuItems, type ProfileChoice } from './profile-menu'

/**
 * The right-click menu on a tab's row in the sidebar.
 *
 * Native, and popped from here, for the reason src/main/profile-menu.ts gives:
 * the row sits beside the tab's own page, and a menu drawn in the renderer's
 * document would slide underneath it.
 *
 * A browser tab's menu is the app's. An extension's tab gets whatever its type
 * offers (see `TabTypeContribution.menu`). Every tab, whatever its type, ends
 * with the tasks it could be moved to — and a tab in a split, with the way out
 * of it — and then a new folder, which a right-click anywhere in the sidebar
 * offers.
 *
 * A folder's row has a menu of its own, and so does the sidebar's empty ground,
 * which only makes folders (see `popupFolderMenu` and `popupSectionMenu`).
 */

export type TabMenuOptions = {
  /** The tab whose row was right-clicked. */
  tabId: string
}

/**
 * What the user settled on. Nothing is done here: every choice is about a tab
 * the renderer owns, so this module's job ends at reporting which one it was.
 * An extension's items run here instead, and answer null.
 */
export type TabMenuChoice =
  | { kind: 'duplicate' }
  | { kind: 'float' }
  | { kind: 'move'; taskId: string }
  | { kind: 'unsplit' }
  | { kind: 'new-folder' }
  | ProfileChoice

/**
 * Pops the menu at the cursor and answers what was chosen, or null if it was
 * dismissed — deferred a turn on close for the same reason `popupProfileMenu`
 * gives, so a click that lands alongside the close still wins.
 */
export async function popupTabMenu(
  window: BrowserWindow | null,
  options: TabMenuOptions
): Promise<TabMenuChoice | null> {
  const tab = await getTab(options.tabId)
  if (!tab) return null

  const own = tab.type === 'browser' ? null : await extensionItems(tab)
  const destinations = await otherTasks(tab.taskId)
  const split = splitContaining((await getTask(tab.taskId))?.splits ?? [], tab.id)

  return popup<TabMenuChoice>(window, (settle) => {
    const head = own ?? browserItems(tab.profile, settle)
    const divider: MenuItemConstructorOptions[] = head.length > 0 ? [{ type: 'separator' }] : []
    // The tab stays where it is in the sidebar; only the split lets go of it.
    const unsplit: MenuItemConstructorOptions[] = split
      ? [{ label: 'Remove from Split', click: () => settle({ kind: 'unsplit' }) }]
      : []
    return [
      ...head,
      ...divider,
      ...unsplit,
      moveItem(destinations, settle),
      { type: 'separator' },
      newFolderItem(settle)
    ]
  })
}

export type FolderMenuOptions = {
  /** The folder whose row was right-clicked. */
  folderId: string
}

/** What was chosen from a folder's menu. As with a tab's, the renderer acts on it. */
export type FolderMenuChoice =
  | { kind: 'new-folder' }
  | { kind: 'rename' }
  | { kind: 'move'; taskId: string }
  | { kind: 'delete' }

/**
 * The right-click menu on a folder's row: a folder inside it, a new name, the
 * tasks it could be moved to, and deleting it.
 *
 * Deleting closes every tab inside, which the item says in so many words when
 * there are any — a folder that looked empty from its row could be holding a
 * shell halfway through something.
 */
export async function popupFolderMenu(
  window: BrowserWindow | null,
  options: FolderMenuOptions
): Promise<FolderMenuChoice | null> {
  const folder = await getFolder(options.folderId)
  if (!folder) return null

  const destinations = await otherTasks(folder.taskId)
  const { tabIds } = await folderContents(folder)
  const count = tabIds.length

  return popup<FolderMenuChoice>(window, (settle) => [
    newFolderItem(settle),
    { label: 'Rename Folder', click: () => settle({ kind: 'rename' }) },
    { type: 'separator' },
    moveItem(destinations, settle),
    { type: 'separator' },
    {
      label:
        count === 0
          ? 'Delete Folder'
          : `Delete Folder and ${count === 1 ? 'Its Tab' : `Its ${count} Tabs`}`,
      click: () => settle({ kind: 'delete' })
    }
  ])
}

/** What was chosen from the sidebar's own menu: there is only the one thing. */
export type SectionMenuChoice = { kind: 'new-folder' }

/**
 * The right-click menu on the sidebar's ground between and below the rows.
 * Which section the folder goes in is the renderer's to say, since it is the
 * one that knows where the click was.
 */
export async function popupSectionMenu(
  window: BrowserWindow | null
): Promise<SectionMenuChoice | null> {
  return popup<SectionMenuChoice>(window, (settle) => [newFolderItem(settle)])
}

function newFolderItem(
  settle: (choice: { kind: 'new-folder' }) => void
): MenuItemConstructorOptions {
  return { label: 'New Folder', click: () => settle({ kind: 'new-folder' }) }
}

/**
 * The open tasks a tab could be moved to: the others in its own project. Never
 * one in another project — its strip is one the tab's own project could no
 * longer reach, which is why `move` in src/main/api/tabs.ts refuses it too.
 */
async function otherTasks(taskId: string): Promise<{ id: string; label: string }[]> {
  const task = await getTask(taskId)
  if (!task) return []
  const open = await listTasks(task.projectId, 'open')
  return open
    .filter((candidate) => candidate.id !== taskId)
    .map((candidate) => ({ id: candidate.id, label: candidate.title ?? NEW_TASK_TITLE }))
}

/**
 * Shown, and greyed out, when the task is the project's only one: the row is
 * where the user will look for it, and an absent row says less than one that
 * cannot be used yet.
 */
function moveItem(
  destinations: { id: string; label: string }[],
  settle: (choice: { kind: 'move'; taskId: string }) => void
): MenuItemConstructorOptions {
  if (destinations.length === 0) return { label: 'Move to Task', enabled: false }
  return {
    label: 'Move to Task',
    submenu: destinations.map((task) => ({
      label: task.label,
      click: () => settle({ kind: 'move', taskId: task.id })
    }))
  }
}

function browserItems(
  profile: number | null,
  settle: (choice: TabMenuChoice) => void
): MenuItemConstructorOptions[] {
  return [
    { label: 'Duplicate Tab', click: () => settle({ kind: 'duplicate' }) },
    {
      // The same as the View menu's item, shortcut and all. Shown here but
      // not registered: the application menu already owns the accelerator.
      label: 'Float This Tab',
      accelerator: 'CmdOrCtrl+Shift+P',
      registerAccelerator: false,
      click: () => settle({ kind: 'float' })
    },
    { type: 'separator' },
    {
      label: 'Reopen in Profile',
      submenu: profileMenuItems({ verb: 'reopen', current: profile, allowReset: true }, settle)
    }
  ]
}

/**
 * What the tab's type offers, as menu rows. A type that throws while building
 * its menu, or from an item, is logged rather than let loose on the main
 * process: the menu is the extension's, and its mistakes should be too.
 */
async function extensionItems(tab: Tab): Promise<MenuItemConstructorOptions[]> {
  const contributed = tab.type.includes('.') ? tabType(tab.type) : undefined
  if (!contributed?.menu) return []

  let items: TabMenuItem[]
  try {
    items = await contributed.menu(tab)
  } catch (error) {
    console.error(`The ${tab.type} tab menu failed to build:`, error)
    return []
  }

  return items.map((item): MenuItemConstructorOptions => {
    if ('type' in item) return { type: 'separator' }
    return {
      label: item.label,
      enabled: item.enabled ?? true,
      click: () => {
        Promise.resolve()
          .then(() => item.click())
          .catch((error) => console.error(`${tab.type}: "${item.label}" failed:`, error))
      }
    }
  })
}

function popup<T>(
  window: BrowserWindow | null,
  build: (settle: (choice: T | null) => void) => MenuItemConstructorOptions[]
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: T | null): void => {
      if (settled) return
      settled = true
      resolve(choice)
    }

    const menu = Menu.buildFromTemplate(build(settle))

    const close = (): void => {
      setTimeout(() => settle(null), 0)
    }

    // No `x`/`y`, as in `popupProfileMenu`: left out, the menu opens at the cursor.
    if (window && !window.isDestroyed()) menu.popup({ window, callback: close })
    else menu.popup({ callback: close })
  })
}
