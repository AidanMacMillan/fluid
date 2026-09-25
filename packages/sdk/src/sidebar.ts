/**
 * A task's sidebar as the tree it is drawn as: two sections, each a list of
 * tabs and folders, and each folder a list of the same again.
 *
 * Built from the rows rather than stored as a tree, because the rows are what
 * every write touches — a tab opened, closed or moved to another task changes
 * one row and knows nothing of folders. So the building is forgiving about rows
 * that disagree: a tab whose folder has gone, or is in the other section, is
 * drawn at the top of its own section; so is a folder whose parent is missing,
 * across the divider, or somewhere in its own subtree. Nothing is ever left out.
 *
 * Generic over the rows' shapes so the main process can build one from the few
 * columns it selects inside a transaction, and the window from the records it
 * holds.
 */

import type { SidebarItem } from './api'

/** What a tab has to say for its place in the tree. */
export type SidebarTabRow = {
  id: string
  folderId: string | null
  pinned: boolean
  position: number
  createdAt: Date
}

/** What a folder has to say for its place in the tree. */
export type SidebarFolderRow = {
  id: string
  parentId: string | null
  pinned: boolean
  position: number
  createdAt: Date
}

export type SidebarNode<T extends SidebarTabRow, F extends SidebarFolderRow> =
  | { kind: 'tab'; id: string; tab: T }
  | { kind: 'folder'; id: string; folder: F; children: SidebarNode<T, F>[] }

export type SidebarTree<T extends SidebarTabRow, F extends SidebarFolderRow> = {
  pinned: SidebarNode<T, F>[]
  loose: SidebarNode<T, F>[]
}

/**
 * Siblings in order: by position, then by age, then by id — the last only so
 * that two rows written in the same instant still come out the same way twice.
 */
function bySlot(
  a: { position: number; createdAt: Date; id: string },
  b: { position: number; createdAt: Date; id: string }
): number {
  return (
    a.position - b.position ||
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export function sidebarTree<T extends SidebarTabRow, F extends SidebarFolderRow>(
  tabs: readonly T[],
  folders: readonly F[]
): SidebarTree<T, F> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))

  /** Whether a folder's parent is one it can really sit in. */
  const nests = (folder: F): boolean => {
    if (folder.parentId === null) return false
    const parent = byId.get(folder.parentId)
    return parent !== undefined && parent.pinned === folder.pinned
  }

  // A folder that cannot be reached from the top of its section — one caught in
  // a loop of parents — is lifted to the top rather than lost. Walking up from
  // each folder finds them: a walk that comes back to where it has been is one.
  const lifted = new Set<string>()
  for (const folder of folders) {
    const seen = new Set<string>([folder.id])
    let at = folder
    while (nests(at)) {
      const parent = byId.get(at.parentId as string) as F
      if (seen.has(parent.id)) {
        lifted.add(folder.id)
        break
      }
      seen.add(parent.id)
      at = parent
    }
  }

  /** The folder a row sits in, or null for the top of its section. */
  const folderOf = (folder: F): string | null =>
    nests(folder) && !lifted.has(folder.id) ? folder.parentId : null
  const tabFolderOf = (tab: T): string | null => {
    if (tab.folderId === null) return null
    const folder = byId.get(tab.folderId)
    return folder && folder.pinned === tab.pinned ? folder.id : null
  }

  type Entry = { position: number; createdAt: Date; id: string; node: () => SidebarNode<T, F> }
  const children = new Map<string, Entry[]>()
  const put = (key: string, entry: Entry): void => {
    const list = children.get(key)
    if (list) list.push(entry)
    else children.set(key, [entry])
  }
  /** Keys for the two sections' tops, which no folder id can collide with. */
  const top = (pinned: boolean): string => (pinned ? ':pinned' : ':loose')

  const build = (key: string): SidebarNode<T, F>[] =>
    (children.get(key) ?? []).sort(bySlot).map((entry) => entry.node())

  for (const folder of folders) {
    put(folderOf(folder) ?? top(folder.pinned), {
      position: folder.position,
      createdAt: folder.createdAt,
      id: folder.id,
      node: () => ({ kind: 'folder', id: folder.id, folder, children: build(folder.id) })
    })
  }
  for (const tab of tabs) {
    put(tabFolderOf(tab) ?? top(tab.pinned), {
      position: tab.position,
      createdAt: tab.createdAt,
      id: tab.id,
      node: () => ({ kind: 'tab', id: tab.id, tab })
    })
  }

  return { pinned: build(top(true)), loose: build(top(false)) }
}

/** Every node, parents before their children, pinned section first. */
export function sidebarNodes<T extends SidebarTabRow, F extends SidebarFolderRow>(
  tree: SidebarTree<T, F>
): SidebarNode<T, F>[] {
  const out: SidebarNode<T, F>[] = []
  const walk = (nodes: SidebarNode<T, F>[]): void => {
    for (const node of nodes) {
      out.push(node)
      if (node.kind === 'folder') walk(node.children)
    }
  }
  walk(tree.pinned)
  walk(tree.loose)
  return out
}

/** The tabs in the order the sidebar draws them, folded or not. */
export function tabsInSidebarOrder<T extends SidebarTabRow, F extends SidebarFolderRow>(
  tabs: readonly T[],
  folders: readonly F[]
): T[] {
  return sidebarNodes(sidebarTree(tabs, folders)).flatMap((node) =>
    node.kind === 'tab' ? [node.tab] : []
  )
}

/** A folder and every folder inside it, at any depth, the folder itself first. */
export function folderSubtree<F extends SidebarFolderRow>(folders: readonly F[], id: string): F[] {
  const out: F[] = []
  const walk = (parentId: string): void => {
    const folder = folders.find((candidate) => candidate.id === parentId)
    if (!folder || out.includes(folder)) return
    out.push(folder)
    for (const child of folders) if (child.parentId === parentId) walk(child.id)
  }
  walk(id)
  return out
}

/** The tree as `tabs.arrange` takes it: every row, parents first. */
export function sidebarItems<T extends SidebarTabRow, F extends SidebarFolderRow>(
  tree: SidebarTree<T, F>
): SidebarItem[] {
  const items: SidebarItem[] = []
  const walk = (nodes: SidebarNode<T, F>[], parentId: string | null, pinned: boolean): void => {
    for (const node of nodes) {
      items.push({ kind: node.kind, id: node.id, parentId, pinned })
      if (node.kind === 'folder') walk(node.children, node.id, pinned)
    }
  }
  walk(tree.pinned, null, true)
  walk(tree.loose, null, false)
  return items
}

/**
 * Where a row is to go: a folder, or the top of a section, and a slot among
 * what is there. The section is the folder's when there is one, whatever
 * `pinned` says. Left out, the slot is the end.
 */
export type SidebarPlace = { parentId: string | null; pinned: boolean; index?: number }

/**
 * The sidebar with one row moved, as the items `tabs.arrange` writes. A folder
 * takes everything in it along, across the divider included.
 *
 * `index` is counted among the destination's children as they stand, with the
 * row still in them if it is already there — which is how a drop line between
 * two rows names its slot — and is held to the list's length.
 *
 * Null when the row is not in the tree, when the folder it is to go in is not
 * either, and for a folder sent inside itself or anything it holds, which
 * would leave the tree along with it.
 */
export function placeInSidebar<T extends SidebarTabRow, F extends SidebarFolderRow>(
  tree: SidebarTree<T, F>,
  id: string,
  place: SidebarPlace
): SidebarItem[] | null {
  type Node = SidebarNode<T, F>
  const copy = (nodes: Node[]): Node[] =>
    nodes.map((node) =>
      node.kind === 'folder' ? { ...node, children: copy(node.children) } : node
    )
  const next = { pinned: copy(tree.pinned), loose: copy(tree.loose) }

  const takeOut = (nodes: Node[]): { node: Node; from: Node[]; at: number } | null => {
    const at = nodes.findIndex((node) => node.id === id)
    if (at !== -1) return { node: nodes.splice(at, 1)[0], from: nodes, at }
    for (const node of nodes) {
      if (node.kind !== 'folder') continue
      const found = takeOut(node.children)
      if (found) return found
    }
    return null
  }
  const taken = takeOut(next.pinned) ?? takeOut(next.loose)
  if (!taken) return null

  const findList = (nodes: Node[]): Node[] | null => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue
      if (node.id === place.parentId) return node.children
      const found = findList(node.children)
      if (found) return found
    }
    return null
  }
  // Looked for after the row is out, so a folder sent into itself finds nothing.
  const target =
    place.parentId === null
      ? place.pinned
        ? next.pinned
        : next.loose
      : (findList(next.pinned) ?? findList(next.loose))
  if (!target) return null

  // Counted with the row still in its list; taking it out first moves every
  // later slot of that list up by one.
  const asked = place.index ?? Number.MAX_SAFE_INTEGER
  const index = taken.from === target && taken.at < asked ? asked - 1 : asked
  target.splice(Math.max(0, Math.min(index, target.length)), 0, taken.node)
  return sidebarItems(next)
}
