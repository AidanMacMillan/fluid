import {
  normalizeSplits,
  splitContaining,
  tabIdsInNode,
  type SplitBranch,
  type SplitDirection,
  type SplitNode,
  type SplitPane,
  type TabSplit
} from '@fluid/sdk'

/**
 * What a split does, as pure functions over a task's splits: a tab dropped on
 * the edge of a pane or of the whole split, a tab taken out, a divider dragged.
 * Every one answers with the whole list, tidied (see `normalizeSplits`), for
 * the workspace to write — and where each pane goes on screen, for the surface
 * to draw it there.
 */

/** Which edge a tab was let go on. */
export type SplitEdge = 'left' | 'right' | 'top' | 'bottom'

/** Which way the things either side of `edge` run: side by side, or stacked. */
export function directionOf(edge: SplitEdge): SplitDirection {
  return edge === 'left' || edge === 'right' ? 'row' : 'column'
}

/** Whether something let go on `edge` goes before what it was dropped on. */
function leads(edge: SplitEdge): boolean {
  return edge === 'left' || edge === 'top'
}

function pane(tabId: string, size: number): SplitPane {
  return { kind: 'pane', tabId, size }
}

/**
 * `node` rebuilt with `change` applied to every branch on the way down, deepest
 * first — how an edit is made to one place in the tree without touching the
 * rest.
 */
function mapBranches(node: SplitNode, change: (branch: SplitBranch) => SplitBranch): SplitNode {
  if (node.kind === 'pane') return node
  return change({ ...node, children: node.children.map((child) => mapBranches(child, change)) })
}

/** `node` and a new pane side by side the way `edge` says, halving what `node` had. */
function pairWith(node: SplitNode, tabId: string, edge: SplitEdge): SplitBranch {
  const pair = [{ ...node, size: 0.5 }, pane(tabId, 0.5)]
  if (leads(edge)) pair.reverse()
  return { kind: 'branch', direction: directionOf(edge), size: node.size, children: pair }
}

/**
 * Puts `tabId` beside the pane of `targetId`, on the edge it was let go on,
 * taking half of what that pane had. Out of whatever split it was in first —
 * its own included, so a tab can be moved about within the split on screen.
 *
 * A pane in no split makes one of the two of them. A pane in a branch that
 * already runs the way the edge does gets its new neighbour beside it there —
 * a third column in a row of two. One in a branch running the other way is
 * split in two where it stands, which is how a column comes to be divided.
 */
export function placeBeside(
  splits: readonly TabSplit[],
  tabId: string,
  targetId: string,
  edge: SplitEdge
): TabSplit[] {
  if (tabId === targetId) return [...splits]

  const rest = removeFromSplits(splits, tabId)
  const split = splitContaining(rest, targetId)

  if (!split) {
    const root = pairWith(pane(targetId, 1), tabId, edge)
    return normalizeSplits([...rest, { id: crypto.randomUUID(), root }])
  }

  const direction = directionOf(edge)
  const root = mapBranches(split.root, (branch) => {
    const index = branch.children.findIndex(
      (child) => child.kind === 'pane' && child.tabId === targetId
    )
    if (index === -1) return branch
    const target = branch.children[index]

    if (branch.direction !== direction) {
      const children = [...branch.children]
      children[index] = pairWith(target, tabId, edge)
      return { ...branch, children }
    }

    const half = target.size / 2
    const children = branch.children.map((child, at) =>
      at === index ? { ...child, size: half } : child
    )
    children.splice(leads(edge) ? index : index + 1, 0, pane(tabId, half))
    return { ...branch, children }
  }) as SplitBranch

  return normalizeSplits(
    rest.map((candidate) => (candidate.id === split.id ? { ...split, root } : candidate))
  )
}

/**
 * Puts `tabId` along one outer edge of the split `anchorId` is in: a row the
 * full width of the split across its top or bottom, or a column its full
 * height down one side.
 *
 * Running the same way as the split, that is one more child at its end, taking
 * half of the one it lands beside. Running the other way, the whole split
 * becomes one half of a new one — which is the only way to put something above
 * a row that is already split, and is how a split gets deeper than a row of
 * columns.
 *
 * Named by a tab in it rather than by its id, because taking the dragged tab
 * out first may have remade the split around what is left.
 */
export function placeAlongside(
  splits: readonly TabSplit[],
  tabId: string,
  anchorId: string,
  edge: SplitEdge
): TabSplit[] {
  const rest = removeFromSplits(splits, tabId)
  const split = splitContaining(rest, anchorId)
  if (!split) return placeBeside(splits, tabId, anchorId, edge)

  const direction = directionOf(edge)
  let root: SplitBranch

  if (split.root.direction === direction) {
    const children = [...split.root.children]
    const at = leads(edge) ? 0 : children.length - 1
    const half = children[at].size / 2
    children[at] = { ...children[at], size: half }
    children.splice(leads(edge) ? 0 : children.length, 0, pane(tabId, half))
    root = { ...split.root, children }
  } else {
    root = pairWith(split.root, tabId, edge)
  }

  return normalizeSplits(
    rest.map((candidate) => (candidate.id === split.id ? { ...split, root } : candidate))
  )
}

/**
 * Takes a tab out of whichever split it is in. The panes around it grow into
 * its room, and a split left with one tab is no split at all.
 */
export function removeFromSplits(splits: readonly TabSplit[], tabId: string): TabSplit[] {
  return normalizeSplits(splits, (candidate) => candidate !== tabId)
}

/**
 * Where a divider sits: in the branch reached by following `path` from the
 * split's root — each step the index of a child — between its children
 * `index` and `index + 1`.
 */
export type SplitDivider = { splitId: string; path: number[]; index: number }

/** The smallest share a divider can squeeze a pane to. */
const MIN_SHARE = 0.1

/**
 * Moves a divider to `share` — how far along the pair either side of it it
 * now sits, 0 to 1. Only those two change size, between them keeping the room
 * they had, so dragging one divider never moves another.
 */
export function moveDivider(
  splits: readonly TabSplit[],
  divider: SplitDivider,
  share: number
): TabSplit[] {
  const resize = (branch: SplitBranch, path: number[]): SplitBranch => {
    if (path.length > 0) {
      const [step, ...deeper] = path
      const child = branch.children[step]
      if (child?.kind !== 'branch') return branch
      const children = [...branch.children]
      children[step] = resize(child, deeper)
      return { ...branch, children }
    }
    const a = branch.children[divider.index]
    const b = branch.children[divider.index + 1]
    if (!a || !b) return branch
    const pair = a.size + b.size
    const clamped = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share))
    const children = [...branch.children]
    children[divider.index] = { ...a, size: pair * clamped }
    children[divider.index + 1] = { ...b, size: pair * (1 - clamped) }
    return { ...branch, children }
  }

  return splits.map((split) =>
    split.id === divider.splitId ? { ...split, root: resize(split.root, divider.path) } : split
  )
}

/**
 * Where something sits along one axis of the page area, two ways at once: as
 * CSS lengths the surface can place it with, gaps between panes and all; and
 * as the fractions of a change in the window's size its two edges take, which
 * is what the main process carries a page through a resize with (see
 * `MeasuredBounds.span`). The gaps are fixed pixels, so they take none of it.
 */
export type AxisPlace = { start: string; size: string; from: number; to: number }

/** One pane of a split, where the surface draws it. */
export type PanePlace = { tabId: string; x: AxisPlace; y: AxisPlace }

/** A divider, where the surface draws its handle, and which tabs are on either side. */
export type DividerPlace = {
  divider: SplitDivider
  /** Which way the things either side of it run, and so which way it drags. */
  direction: SplitDirection
  /** Its box: the gap just ahead of the child after it, across the whole branch. */
  x: AxisPlace
  y: AxisPlace
  /** The tabs in the children before and after it, whose boxes bound its drag. */
  before: string[]
  after: string[]
}

const WHOLE: AxisPlace = { start: '0px', size: '100%', from: 0, to: 1 }

/**
 * Where each pane of a split is drawn, and each of its dividers, with `gap`
 * pixels between neighbours. Every branch shares out its own box, less the gaps
 * between its children, by their sizes — so the CSS nests the way the tree
 * does.
 */
export function layoutOf(
  split: TabSplit,
  gap: number
): { panes: PanePlace[]; dividers: DividerPlace[] } {
  const panes: PanePlace[] = []
  const dividers: DividerPlace[] = []

  const walk = (node: SplitNode, x: AxisPlace, y: AxisPlace, path: number[]): void => {
    if (node.kind === 'pane') {
      panes.push({ tabId: node.tabId, x, y })
      return
    }

    const row = node.direction === 'row'
    const along = row ? x : y
    const room = `(${along.size} - ${(node.children.length - 1) * gap}px)`
    let share = 0

    node.children.forEach((child, index) => {
      const place: AxisPlace = {
        start: `calc(${along.start} + ${room} * ${share} + ${index * gap}px)`,
        size: `calc(${room} * ${child.size})`,
        from: along.from + (along.to - along.from) * share,
        to: along.from + (along.to - along.from) * (share + child.size)
      }

      if (index > 0) {
        const handle: AxisPlace = {
          start: `calc(${place.start} - ${gap}px)`,
          size: `${gap}px`,
          from: place.from,
          to: place.from
        }
        dividers.push({
          divider: { splitId: split.id, path, index: index - 1 },
          direction: node.direction,
          x: row ? handle : x,
          y: row ? y : handle,
          before: tabIdsInNode(node.children[index - 1]),
          after: tabIdsInNode(child)
        })
      }

      walk(child, row ? place : x, row ? y : place, [...path, index])
      share += child.size
    })
  }

  walk(split.root, WHOLE, WHOLE, [])
  return { panes, dividers }
}

/** The one pane of a tab that has the page area to itself. */
export function wholePane(tabId: string): PanePlace {
  return { tabId, x: WHOLE, y: WHOLE }
}
