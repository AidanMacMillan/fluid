import { Menu, session, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { DEFAULT_SPACE_ID, partitionsOfSpace } from './browsing'
import {
  createSpace as createSpaceRow,
  deleteSpace as deleteSpaceRow,
  getSpace,
  listSpaces,
  projectCountsBySpace,
  renameSpace as renameSpaceRow,
  setProjectSpace
} from './db/spaces'
import { captureDownloadsInSpace } from './downloads'
import { PROFILES } from './profiles'
import type { Space } from './db/schema'

/**
 * Spaces: the browsing worlds projects are grouped into, and everything about
 * them that is not storage.
 *
 * What a space does is scope sessions — see src/main/browsing.ts, where a space
 * and a profile are crossed into a partition. What it looks like is a name on a
 * project row, and a submenu on that row for moving the project somewhere else.
 * There is nothing else to a space: no colour, no folder, no settings. The
 * number of them is open-ended precisely because there is so little to one.
 */

/** One space as the picker draws it. */
export type SpaceRow = {
  id: string
  name: string
  /** How many projects are in it, which is the only fact a space row carries. */
  projects: number
  /**
   * Whether this is the space everything starts in. It cannot be deleted —
   * deleted spaces send their projects here — and the app behaves in it exactly
   * as it did before spaces existed.
   */
  isDefault: boolean
}

export async function spaceRows(): Promise<SpaceRow[]> {
  const [spaces, counts] = await Promise.all([listSpaces(), projectCountsBySpace()])
  return spaces.map((space) => ({
    id: space.id,
    name: space.name,
    projects: counts.get(space.id) ?? 0,
    isDefault: space.id === DEFAULT_SPACE_ID
  }))
}

/** Makes a space. The name is the whole of it, so an empty one is refused. */
export async function createSpace(name: string): Promise<Space> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('Name the space.')

  const space = await createSpaceRow(trimmed)
  // Its sessions are six that did not exist a moment ago, and an unhooked
  // session sends its downloads to a save dialog instead of into the task.
  captureDownloadsInSpace(space.id)
  return space
}

export async function renameSpace(id: string, name: string): Promise<Space | undefined> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('Name the space.')
  return renameSpaceRow(id, trimmed)
}

/**
 * Deletes a space: its projects move to the default space, and the logins it
 * held are thrown away.
 *
 * The clear is the half that is easy to forget and impossible to do later. A
 * partition outlives the row that named it — Chromium keeps the directory, and
 * nothing in the app would ever name it again — so a space deleted without this
 * would leave every cookie it ever held on disk for good. Best effort, and
 * after the row is gone: a session that will not clear is not a reason to
 * refuse the deletion.
 */
export async function deleteSpace(id: string): Promise<void> {
  await deleteSpaceRow(id)

  const profiles = PROFILES.map((profile) => profile.id)
  await Promise.all(
    partitionsOfSpace(id, profiles).map(async (partition) => {
      const target = session.fromPartition(partition)
      // In flight before the clear is in flight against data that is about to
      // go; letting those land would write some of it straight back.
      await target.closeAllConnections()
      await target.clearData()
    })
  ).catch((error) => {
    console.error('Failed to clear a deleted space’s sessions:', error)
  })
}

/**
 * Moves a project into a space, checked rather than taken on trust: a space id
 * that names nothing would leave a project pointed at a partition the picker
 * can never show and never move it out of.
 *
 * Returns whether anything actually moved, which is what tells the caller
 * whether the project's open pages have to be rebuilt in a new session.
 */
export async function moveProjectToSpace(projectId: string, spaceId: string): Promise<boolean> {
  const space = await getSpace(spaceId)
  if (!space) return false

  await setProjectSpace(projectId, spaceId)
  return true
}

/** What a space's own row menu was asked for. */
export type SpaceMenuChoice = 'rename' | 'delete'

/**
 * The menu on a space row: rename it, or delete it.
 *
 * Native, and reporting rather than doing, for the reasons `popupProjectMenu`
 * gives — the picker's window is sized to the panel inside it, and both answers
 * are finished in the field the panel already has.
 */
export function popupSpaceMenu(
  window: BrowserWindow | null,
  space: { name: string; isDefault: boolean }
): Promise<SpaceMenuChoice | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: SpaceMenuChoice | null): void => {
      if (settled) return
      settled = true
      resolve(choice)
    }

    const menu = Menu.buildFromTemplate([
      { label: 'Rename…', click: () => settle('rename') },
      { type: 'separator' },
      {
        label: 'Delete…',
        // The default space is where deleted spaces send their projects, and
        // its id is baked into partition names. Greyed rather than left out, so
        // the menu does not change shape from one row to the next.
        enabled: !space.isDefault,
        click: () => settle('delete')
      }
    ])

    // Deferred dismissal so a click landing in the same turn wins either way
    // round — the same dance `popupProfileMenu` does, and for the same reason.
    const close = (): void => {
      setTimeout(() => settle(null), 0)
    }

    if (window && !window.isDestroyed()) menu.popup({ window, callback: close })
    else menu.popup({ callback: close })
  })
}

/**
 * The rows that move a project from one space to another, for the project menu
 * to hang under a submenu.
 *
 * `null` is the row that is not a space: making one, which is the only way a
 * space ever comes into existence. It is here rather than only in a list of its
 * own because moving a project into a space that does not exist yet is the
 * commonest reason to want another one at all.
 */
export function spaceMenuItems(
  spaces: SpaceRow[],
  current: string,
  choose: (spaceId: string | null) => void
): MenuItemConstructorOptions[] {
  return [
    ...spaces.map((space): MenuItemConstructorOptions => ({
      label: space.name,
      // A tick rather than a disabled row: the space the project is already
      // in is still a legitimate thing to choose, and choosing it is a no-op.
      type: 'checkbox',
      checked: space.id === current,
      click: () => choose(space.id)
    })),
    { type: 'separator' },
    { label: 'New Space…', click: () => choose(null) }
  ]
}

export { listSpaces }
