import { z } from 'zod'
import type { Client } from './client'
import type { Tab, Task } from './models'

/**
 * Tabs drawn side by side in a task's page area.
 *
 * A split is a tree of rows and columns. Each branch runs its children one
 * way — `row` side by side, `column` one above the other — and every child is
 * a pane holding one tab, or a branch running the other way. Branches always
 * alternate: a row directly inside a row is the same picture as one longer row,
 * and is stored as that (see `normalizeSplits`).
 *
 * A split belongs to its task, and the tabs in it stay where they are in the
 * sidebar: a split is a way of looking at some of a task's tabs together, not
 * a container they are moved into. A task can hold several, each drawn when
 * one of its tabs is the one selected, and a tab is in one of them at most.
 *
 * Every node's `size` is its share of its parent along the parent's direction,
 * and the shares of one branch's children sum to 1. The root's is always 1.
 */

/** Which way a branch runs its children: `row` side by side, `column` one above the other. */
export type SplitDirection = 'row' | 'column'

export type SplitPane = { kind: 'pane'; tabId: string; size: number }

export type SplitBranch = {
  kind: 'branch'
  direction: SplitDirection
  size: number
  children: SplitNode[]
}

export type SplitNode = SplitPane | SplitBranch

export type TabSplit = {
  /** Stable for the split's life, so a window can tell one split from the next. */
  id: string
  root: SplitBranch
}

const size = z.number().finite()

const splitPaneSchema = z.object({ kind: z.literal('pane'), tabId: z.string().min(1), size })

const splitBranchSchema: z.ZodType<SplitBranch> = z.lazy(() =>
  z.object({
    kind: z.literal('branch'),
    direction: z.enum(['row', 'column']),
    size,
    children: z.array(z.union([splitPaneSchema, splitBranchSchema]))
  })
)

export const tabSplitSchema = z.object({ id: z.string().min(1), root: splitBranchSchema })

/** The tabs a node draws, in reading order. */
export function tabIdsInNode(node: SplitNode): string[] {
  return node.kind === 'pane' ? [node.tabId] : node.children.flatMap(tabIdsInNode)
}

/** The tabs a split draws, in reading order. */
export function tabIdsInSplit(split: TabSplit): string[] {
  return tabIdsInNode(split.root)
}

/** The split `tabId` is drawn in, if it is in one. */
export function splitContaining(
  splits: readonly TabSplit[],
  tabId: string | null
): TabSplit | undefined {
  if (tabId === null) return undefined
  return splits.find((split) => tabIdsInSplit(split).includes(tabId))
}

/** The other way from `direction`. */
export function crossDirection(direction: SplitDirection): SplitDirection {
  return direction === 'row' ? 'column' : 'row'
}

/**
 * Puts splits into the one shape they are allowed to be in, however they were
 * written: every tab in one split at most and once in it, no empty branches,
 * no branch of a single child, no branch directly inside one running the same
 * way, no split of a single tab, and shares that sum to 1 in every branch.
 *
 * `keep` says which tabs may be drawn at all — the task's own, when the split
 * is being checked against the database — and a pane naming any other tab is
 * dropped along with whatever that leaves empty. What is left closes up the
 * way the eye expects: a branch down to one child is replaced by that child,
 * and a branch that then finds itself inside one running its way is merged
 * into it, its children taking its share between them.
 *
 * Anything not in the shape at all — splits written before they were trees —
 * is dropped rather than guessed at.
 */
export function normalizeSplits(
  splits: readonly TabSplit[],
  keep: (tabId: string) => boolean = () => true
): TabSplit[] {
  const seen = new Set<string>()

  const tidy = (node: SplitNode): SplitNode | null => {
    if (node.kind === 'pane') {
      if (seen.has(node.tabId) || !keep(node.tabId)) return null
      seen.add(node.tabId)
      return { kind: 'pane', tabId: node.tabId, size: node.size }
    }

    const children: SplitNode[] = []
    for (const child of shares(node.children)) {
      const kept = tidy(child)
      if (!kept) continue
      if (kept.kind === 'branch' && kept.direction === node.direction) {
        // The same way as this one: its children are this branch's, in its
        // place, sharing out what it had.
        for (const grandchild of kept.children) {
          children.push({ ...grandchild, size: grandchild.size * kept.size })
        }
      } else {
        children.push(kept)
      }
    }

    if (children.length === 0) return null
    if (children.length === 1) return { ...children[0], size: node.size }
    return {
      kind: 'branch',
      direction: node.direction,
      size: node.size,
      children: shares(children)
    }
  }

  const result: TabSplit[] = []
  for (const split of splits) {
    if (split?.root?.kind !== 'branch') continue
    const root = tidy({ ...split.root, size: 1 })
    if (root?.kind === 'branch') result.push({ id: split.id, root: { ...root, size: 1 } })
  }
  return result
}

/**
 * Sizes scaled to sum to 1. A size that is not a positive number — written by
 * hand, or by something that lost track — takes an even share instead of
 * collapsing its pane to nothing.
 */
function shares<T extends { size: number }>(items: T[]): T[] {
  const even = 1 / items.length
  const sized = items.map((item) => ({
    ...item,
    size: Number.isFinite(item.size) && item.size > 0 ? item.size : even
  }))
  const total = sized.reduce((sum, item) => sum + item.size, 0)
  return sized.map((item) => ({ ...item, size: item.size / total }))
}

/** Whether two lists of splits draw the same thing. */
export function sameSplits(a: readonly TabSplit[], b: readonly TabSplit[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A task's splits with `tabId` taken out, and — when it was the tab in front —
 * the neighbour that takes over, so the rest of its split stays on screen.
 * Null for a tab in no split. What the app's own button on a pane writes, and
 * `leaveSplit` for a view drawing its own.
 */
export function leavingSplit(
  task: Pick<Task, 'splits' | 'activeTabId'>,
  tabId: string
): { splits: TabSplit[]; activeTabId?: string } | null {
  const split = splitContaining(task.splits, tabId)
  if (!split) return null
  const splits = normalizeSplits(task.splits, (candidate) => candidate !== tabId)
  if (task.activeTabId !== tabId) return { splits }
  const order = tabIdsInSplit(split)
  const at = order.indexOf(tabId)
  return { splits, activeTabId: order[at + 1] ?? order[at - 1] }
}

/**
 * Tells a view whether its tab is in a split, now and whenever that changes —
 * for a view that draws its own bar (see `PageViewDeclaration.drawsBar`) to
 * offer the way out in it. A view is only ever on screen as a pane of a split
 * when its tab is in one, so this is also whether it is being drawn as one.
 * Returns what stops listening.
 */
export function watchTabSplit(
  api: Client,
  tab: Pick<Tab, 'id' | 'taskId'>,
  listener: (inSplit: boolean) => void
): () => void {
  return api.watch('tasks.get', { id: tab.taskId }, (task) =>
    listener(task !== null && splitContaining(task.splits, tab.id) !== undefined)
  )
}

/** Takes a tab out of its split, the way the app's button on a pane does. */
export async function leaveSplit(api: Client, tab: Pick<Tab, 'id' | 'taskId'>): Promise<void> {
  const task = await api.tasks.get({ id: tab.taskId })
  const leaving = task && leavingSplit(task, tab.id)
  if (task && leaving) await api.tasks.setSplits({ id: task.id, ...leaving })
}
