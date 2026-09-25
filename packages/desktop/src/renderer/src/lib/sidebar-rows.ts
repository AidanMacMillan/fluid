import {
  placeInSidebar,
  type SidebarItem,
  type SidebarNode,
  type SidebarTree,
  type Tab,
  type TabFolder
} from '@fluid/sdk'
import type { SidebarItemRef, SidebarSection, SidebarSlot } from './reorder.svelte'

/**
 * The sidebar's tree as the rows it is drawn as, and the writes a drop in it
 * turns into.
 *
 * A row is one line of the column: a tab, or a folder's own header, with what
 * is in an open folder following it one step further in. A closed folder's
 * contents are not drawn — except the tabs on screen, if any are in there,
 * which stay in sight under the folder they are in: the tab in front, and the
 * rest of its split when it is in one. Hiding a tab that is on screen would
 * leave the sidebar with no row saying what that page beside it is.
 */

/** How far each folder's contents are drawn in from it, in rem. */
export const SIDEBAR_INDENT_REM = 0.75

export type Node = SidebarNode<Tab, TabFolder>
export type Tree = SidebarTree<Tab, TabFolder>

type RowPlace = {
  id: string
  /** How many folders in the row is drawn. */
  depth: number
  /** The folders it is inside, outermost first. */
  within: string[]
  /** Where it sits: its folder, or the top of its section, and its slot there. */
  slot: SidebarSlot
}

export type SidebarRow =
  | (RowPlace & {
      kind: 'tab'
      tab: Tab
      /**
       * Shown only because it is on screen and its folder is closed. Drawn
       * under that folder, where `depth` puts it; `slot` and `within` are
       * still where it really is, which may be deeper.
       */
      peek: boolean
    })
  | (RowPlace & {
      kind: 'folder'
      folder: TabFolder
      open: boolean
      /** How many things sit directly in it. */
      size: number
      /** Every tab inside it, at any depth. */
      tabs: Tab[]
    })

/** Every tab inside a list of nodes, at any depth. */
function tabsUnder(nodes: Node[]): Tab[] {
  return nodes.flatMap((node) => (node.kind === 'tab' ? [node.tab] : tabsUnder(node.children)))
}

/**
 * The tabs under a list of nodes that are on screen, in the order they are
 * drawn, each with where it really sits. What a closed folder's peek rows are
 * given, so that a drop against one lands next to its tab and not next to the
 * folder it is drawn under.
 */
function shownUnder(
  nodes: Node[],
  shown: ReadonlySet<string>,
  section: SidebarSection,
  parentId: string,
  within: string[]
): (Pick<RowPlace, 'slot' | 'within'> & { tab: Tab })[] {
  return nodes.flatMap((node, index) => {
    if (node.kind === 'tab') {
      return shown.has(node.id)
        ? [{ tab: node.tab, slot: { section, parentId, index }, within }]
        : []
    }
    return shownUnder(node.children, shown, section, node.id, [...within, node.id])
  })
}

/**
 * A section's rows, parents before children, closed folders' contents left out
 * but for the tabs in `shown` — the ones on screen.
 */
export function sidebarRows(
  nodes: Node[],
  section: SidebarSection,
  shown: ReadonlySet<string>,
  depth = 0,
  within: string[] = [],
  parentId: string | null = null
): SidebarRow[] {
  const rows: SidebarRow[] = []
  for (const [index, node] of nodes.entries()) {
    const place = { id: node.id, depth, within, slot: { section, parentId, index } }
    if (node.kind === 'tab') {
      rows.push({ ...place, kind: 'tab', tab: node.tab, peek: false })
      continue
    }

    const open = !node.folder.collapsed
    const inside = [...within, node.id]
    rows.push({
      ...place,
      kind: 'folder',
      folder: node.folder,
      open,
      size: node.children.length,
      tabs: tabsUnder(node.children)
    })
    if (open) {
      rows.push(...sidebarRows(node.children, section, shown, depth + 1, inside, node.id))
      continue
    }

    for (const peek of shownUnder(node.children, shown, section, node.id, inside)) {
      rows.push({ id: peek.tab.id, depth: depth + 1, ...peek, kind: 'tab', peek: true })
    }
  }
  return rows
}

/**
 * The tabs a row is drawn for, down the whole column in order. What stepping
 * through the tabs by keyboard walks: a tab folded out of sight is skipped, the
 * way it would be by eye.
 */
export function visibleTabs(tree: Tree, shown: ReadonlySet<string>): Tab[] {
  return [
    ...sidebarRows(tree.pinned, 'pinned-tab', shown),
    ...sidebarRows(tree.loose, 'tab', shown)
  ].flatMap((row) => (row.kind === 'tab' ? [row.tab] : []))
}

/**
 * The sidebar with one row moved to where a drag let go of it, as the items
 * `tabs.arrange` writes (see `placeInSidebar`). Null when either end is not
 * there any more — the row closed, or the folder it was aimed at deleted, from
 * under the drag.
 */
export function moveInSidebar(
  tree: Tree,
  item: SidebarItemRef,
  slot: SidebarSlot
): SidebarItem[] | null {
  return placeInSidebar(tree, item.id, {
    parentId: slot.parentId,
    pinned: slot.section === 'pinned-tab',
    index: slot.index
  })
}
