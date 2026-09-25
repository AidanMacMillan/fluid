import { and, eq, inArray, isNotNull, max } from 'drizzle-orm'
import {
  sidebarNodes,
  sidebarTree,
  tabsInSidebarOrder,
  type ExtensionTabType,
  type SidebarTree,
  type TabActivity,
  type TabActivityEntry
} from '@fluid/sdk'
import { db, type Transaction } from './client'
import {
  type BrowserTabPayload,
  type FileTabPayload,
  type Tab,
  type Task,
  tabFolders,
  tabs,
  tasks
} from './schema'

type TabRow = typeof tabs.$inferSelect

/**
 * `type` and `payload` are only ever written together (see `NewTabInput`), so
 * the column pair is consistent and the narrowing is sound.
 */
const asTab = (row: TabRow): Tab => row as Tab

/**
 * Whether a new tab opens in the task's own section, which any kind of tab can
 * do. Left out, it opens as an ordinary tab: pinning is what a routine does
 * when it opens the work a task is *for*, and what the user does by dragging a
 * tab across the divider afterwards.
 */
type NewTabPin = {
  pinned?: boolean
  /**
   * The folder to open it in, at the end of what the folder holds. The caller
   * is the one to make `pinned` agree with the folder (see `open` in
   * src/main/api/tabs.ts); a tab that disagrees is drawn at the top of its own
   * section rather than in the folder.
   */
  folderId?: string | null
}

/** Forces the payload shape to match the tab type at the call site. */
export type NewTabInput =
  | (NewTabPin & {
      type: 'browser'
      payload: BrowserTabPayload
      title?: string | null
      /**
       * The address a pinned tab comes home to. Given rather than derived from
       * the payload because the two are different questions: where the tab
       * opens, and where it belongs. They only happen to agree at birth.
       *
       * Implies `pinned`, so a caller that has an address need not say both.
       */
      pinnedUrl?: string | null
      /**
       * Which browsing profile the tab's page runs in; null — and the default
       * when left out — is the default profile. Decided here at birth and never
       * afterwards: a view's partition is fixed when it is created, so moving a
       * tab between profiles means opening a new one (see `reopenInProfile` in
       * the renderer's workspace).
       */
      profile?: number | null
    })
  | (NewTabPin & { type: 'file'; payload: FileTabPayload; title?: string | null })
  | (NewTabPin & {
      /** A type an extension contributed, `extension.kind`. */
      type: ExtensionTabType
      payload: Record<string, unknown>
      title?: string | null
      /** Implies `pinned`, like a browser tab's. */
      pinnedUrl?: string | null
    })

/**
 * A task's tabs in the order the sidebar draws them: the pinned section first,
 * each folder's contents straight after it. Positions only order siblings (see
 * `tabs.position`), so this is the one order the rows can be read in that means
 * anything on its own — stepping through the column, handing focus to the next
 * row along — and so the one every caller gets.
 */
export async function listTabs(taskId: string): Promise<Tab[]> {
  const [rows, folders] = await Promise.all([
    db().select().from(tabs).where(eq(tabs.taskId, taskId)),
    db().select().from(tabFolders).where(eq(tabFolders.taskId, taskId))
  ])
  return tabsInSidebarOrder(rows, folders).map(asTab)
}

export async function getTab(id: string): Promise<Tab | undefined> {
  const [row] = await db().select().from(tabs).where(eq(tabs.id, id)).limit(1)
  return row ? asTab(row) : undefined
}

/**
 * A position that sorts after every sibling a new row could have, wherever it
 * lands: the largest the task has, tabs and folders alike, plus one. Positions
 * are only compared among siblings (see `tabs.position`), so a number past all
 * of them is past the ones that count, and nothing else has to move to make
 * room.
 */
export async function nextPosition(tx: Transaction, taskId: string): Promise<number> {
  const [[{ tab }], [{ folder }]] = await Promise.all([
    tx
      .select({ tab: max(tabs.position) })
      .from(tabs)
      .where(eq(tabs.taskId, taskId)),
    tx
      .select({ folder: max(tabFolders.position) })
      .from(tabFolders)
      .where(eq(tabFolders.taskId, taskId))
  ])
  return Math.max(tab ?? -1, folder ?? -1) + 1
}

/** The columns a row's place in the sidebar is read from. */
const placeColumns = {
  tab: {
    id: tabs.id,
    folderId: tabs.folderId,
    pinned: tabs.pinned,
    position: tabs.position,
    createdAt: tabs.createdAt
  },
  folder: {
    id: tabFolders.id,
    parentId: tabFolders.parentId,
    pinned: tabFolders.pinned,
    position: tabFolders.position,
    createdAt: tabFolders.createdAt
  }
}

type PlacedTab = { [K in keyof typeof placeColumns.tab]: (typeof tabs.$inferSelect)[K] }
type PlacedFolder = {
  [K in keyof typeof placeColumns.folder]: (typeof tabFolders.$inferSelect)[K]
}

/** A task's sidebar as it stands inside a transaction, for writes that reshape it. */
export async function sidebarWithin(
  tx: Transaction,
  taskId: string
): Promise<SidebarTree<PlacedTab, PlacedFolder>> {
  const [tabRows, folderRows] = await Promise.all([
    tx.select(placeColumns.tab).from(tabs).where(eq(tabs.taskId, taskId)),
    tx.select(placeColumns.folder).from(tabFolders).where(eq(tabFolders.taskId, taskId))
  ])
  return sidebarTree(tabRows, folderRows)
}

/** A task's tab ids in the order the sidebar draws them, inside a transaction. */
export async function drawnOrder(tx: Transaction, taskId: string): Promise<string[]> {
  return sidebarNodes(await sidebarWithin(tx, taskId)).flatMap((node) =>
    node.kind === 'tab' ? [node.id] : []
  )
}

/**
 * Rewrites every position in a task's sidebar to its row's place in the order
 * the sidebar is drawn, which keeps the numbers small and every sibling list in
 * the order it was already in. What a close or a move out leaves behind is
 * compacted this way, as the strip always has been.
 */
export async function compactSidebar(tx: Transaction, taskId: string): Promise<void> {
  const nodes = sidebarNodes(await sidebarWithin(tx, taskId))
  for (const [position, node] of nodes.entries()) {
    if (node.kind === 'tab') {
      await tx.update(tabs).set({ position }).where(eq(tabs.id, node.id))
    } else {
      await tx.update(tabFolders).set({ position }).where(eq(tabFolders.id, node.id))
    }
  }
}

/**
 * Who takes a task's focus when `leaving` leave it: the first tab still there
 * after the active one in the order the sidebar is drawn, falling back to the
 * last before it — right, then left, the way a browser does. Undefined when the
 * active tab is staying, and null when nothing is left.
 */
async function focusAfter(
  tx: Transaction,
  taskId: string,
  leaving: ReadonlySet<string>
): Promise<string | null | undefined> {
  const [task] = await tx
    .select({ activeTabId: tasks.activeTabId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const active = task?.activeTabId ?? null
  if (active === null || !leaving.has(active)) return undefined

  const order = await drawnOrder(tx, taskId)
  const at = order.indexOf(active)
  return (
    order.slice(at + 1).find((id) => !leaving.has(id)) ??
    order
      .slice(0, Math.max(at, 0))
      .reverse()
      .find((id) => !leaving.has(id)) ??
    null
  )
}

/**
 * Hands a task's focus on when tabs are about to leave it, if one of them held
 * it (see `focusAfter`). Called before they go, while the order they were drawn
 * in can still be read.
 */
export async function handFocusOn(
  tx: Transaction,
  taskId: string,
  leaving: ReadonlySet<string>
): Promise<void> {
  const next = await focusAfter(tx, taskId, leaving)
  if (next !== undefined) {
    await tx.update(tasks).set({ activeTabId: next }).where(eq(tasks.id, taskId))
  }
}

/**
 * Makes `tabId` a task's active tab if it has none, which is what keeps a task
 * with tabs always having one — the adoption `createTab` and `moveTab` make.
 */
export async function adoptIfUnfocused(
  tx: Transaction,
  taskId: string,
  tabId: string
): Promise<void> {
  const [task] = await tx
    .select({ activeTabId: tasks.activeTabId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (task && task.activeTabId === null) {
    await tx.update(tasks).set({ activeTabId: tabId }).where(eq(tasks.id, taskId))
  }
}

/**
 * Appends a tab to the end of the section it belongs to, at the top level of
 * it rather than in any folder. If the task had no active tab — i.e. this is
 * its first — the new tab takes focus, so a task that has tabs always has an
 * active one.
 */
export async function createTab(taskId: string, input: NewTabInput): Promise<Tab> {
  const pinnedUrl = 'pinnedUrl' in input ? (input.pinnedUrl ?? null) : null
  const profile = input.type === 'browser' ? (input.profile ?? null) : null
  // An address implies the section, so the callers that open a task's own work
  // at a known address need not say both. The reverse does not hold: three of
  // the five kinds can be pinned with no address at all.
  const pinned = input.pinned ?? pinnedUrl !== null

  return db().transaction(async (tx) => {
    const position = await nextPosition(tx, taskId)

    const [row] = await tx
      .insert(tabs)
      .values({
        taskId,
        folderId: input.folderId ?? null,
        type: input.type,
        title: input.title ?? null,
        payload: input.payload,
        pinned,
        pinnedUrl,
        profile,
        position
      })
      .returning()

    await adoptIfUnfocused(tx, taskId, row.id)
    return asTab(row)
  })
}

/**
 * Moves a tab into the other section, and — for the kinds that have one — sets
 * or clears the address it comes home to.
 *
 * It lands at the end of the top of the section it moves into, out of whatever
 * folder it was in: a folder is in one section, and a tab that has left it for
 * the other can no longer be inside it. That is where a tab of that kind would
 * have been born (see `createTab`), which is the only answer that does not
 * depend on where the tab happened to be sitting before.
 *
 * A caller that knows where the tab should actually land — a drag, which ends
 * over a particular slot — writes the whole sidebar instead (see
 * `arrangeSidebar`). The placement here is what makes the call correct on its
 * own.
 */
export async function updateTabPin(
  id: string,
  changes: { pinned: boolean; pinnedUrl?: string | null }
): Promise<Tab | undefined> {
  const { pinned } = changes

  return db().transaction(async (tx) => {
    const [existing] = await tx.select().from(tabs).where(eq(tabs.id, id)).limit(1)
    if (!existing) return undefined

    // The address can change without the section doing — a pinned tab pinned
    // again is being re-homed to wherever it has got to — so only the move is
    // skipped, not the write.
    const moves = existing.pinned !== pinned
    const placement = moves
      ? { folderId: null, position: await nextPosition(tx, existing.taskId) }
      : {}
    const [row] = await tx
      .update(tabs)
      .set(
        changes.pinnedUrl === undefined
          ? { pinned, ...placement }
          : { pinned, pinnedUrl: changes.pinnedUrl, ...placement }
      )
      .where(eq(tabs.id, id))
      .returning()

    if (!moves) return asTab(row)
    // Compacting renumbers the row just written, so it is read again after.
    await compactSidebar(tx, existing.taskId)
    const [placed] = await tx.select().from(tabs).where(eq(tabs.id, id)).limit(1)
    return asTab(placed)
  })
}

export async function updateTab(
  id: string,
  changes: { title?: string | null; payload?: Record<string, unknown>; viewState?: unknown }
): Promise<Tab | undefined> {
  if (
    changes.title === undefined &&
    changes.payload === undefined &&
    changes.viewState === undefined
  ) {
    return getTab(id)
  }

  const [row] = await db().update(tabs).set(changes).where(eq(tabs.id, id)).returning()
  return row ? asTab(row) : undefined
}

export async function setTabActivity(
  id: string,
  activity: TabActivity | null
): Promise<Tab | undefined> {
  const [row] = await db().update(tabs).set({ activity }).where(eq(tabs.id, id)).returning()
  return row ? asTab(row) : undefined
}

/**
 * Takes `done` off a tab, and nothing else: a tab that has since started more
 * work is left saying so. Undefined when there was no `done` to take.
 */
export async function clearTabDone(id: string): Promise<Tab | undefined> {
  const [row] = await db()
    .update(tabs)
    .set({ activity: null })
    .where(and(eq(tabs.id, id), eq(tabs.activity, 'done')))
    .returning()
  return row ? asTab(row) : undefined
}

/** Every tab in a project's open tasks that has something to report. */
export async function listTabActivity(projectId: string): Promise<TabActivityEntry[]> {
  const rows = await db()
    .select({ tabId: tabs.id, taskId: tabs.taskId, activity: tabs.activity })
    .from(tabs)
    .innerJoin(tasks, eq(tasks.id, tabs.taskId))
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'open'), isNotNull(tabs.activity)))
  return rows as TabActivityEntry[]
}

/**
 * Takes `working` and `waiting` off every tab, on the way up. Whatever was
 * working, or waiting on the user, went with the last run of the app; a tab
 * that still said so would say it forever. Nothing is announced, because
 * nothing is listening yet.
 */
export async function clearStaleActivity(): Promise<void> {
  await db()
    .update(tabs)
    .set({ activity: null })
    .where(inArray(tabs.activity, ['working', 'waiting']))
}

/**
 * Focuses a tab. The single-column foreign key cannot express "and it must
 * belong to this task", so membership is checked here; passing another task's
 * tab id is an error rather than a silent cross-task focus.
 */
export async function setActiveTab(
  taskId: string,
  tabId: string | null
): Promise<Task | undefined> {
  if (tabId !== null) {
    const [owned] = await db()
      .select({ id: tabs.id })
      .from(tabs)
      .where(and(eq(tabs.id, tabId), eq(tabs.taskId, taskId)))
      .limit(1)

    if (!owned) {
      throw new Error(`Tab ${tabId} does not belong to task ${taskId}`)
    }
  }

  const [task] = await db()
    .update(tasks)
    .set({ activeTabId: tabId })
    .where(eq(tasks.id, taskId))
    .returning()
  return task
}

/**
 * Puts a task's tabs in the order `orderedIds` gives, each staying in the
 * folder and section it is in: among the tabs sharing one, the order changes,
 * and the slots they fill between the folders there do not. Tabs left out keep
 * their order after the ones given; ids the task does not own are ignored.
 *
 * The flat order a caller that knows nothing of folders can ask for. Moving a
 * tab into a folder, out of one or across the divider is `arrangeSidebar`.
 */
export async function reorderTabs(taskId: string, orderedIds: string[]): Promise<Tab[]> {
  await db().transaction(async (tx) => {
    const rank = new Map(orderedIds.map((id, index) => [id, index]))
    const rankOf = (id: string): number => rank.get(id) ?? Number.MAX_SAFE_INTEGER
    const tree = await sidebarWithin(tx, taskId)

    let position = 0
    const write = async (nodes: typeof tree.pinned): Promise<void> => {
      const tabsHere = nodes
        .filter((node) => node.kind === 'tab')
        // Stable, so the tabs left out keep the order they were in.
        .sort((a, b) => rankOf(a.id) - rankOf(b.id))
      let next = 0
      for (const node of nodes) {
        const placed = node.kind === 'tab' ? tabsHere[next++] : node
        if (placed.kind === 'tab') {
          await tx.update(tabs).set({ position: position++ }).where(eq(tabs.id, placed.id))
        } else {
          await tx
            .update(tabFolders)
            .set({ position: position++ })
            .where(eq(tabFolders.id, placed.id))
          await write(placed.children)
        }
      }
    }
    await write(tree.pinned)
    await write(tree.loose)
  })

  return listTabs(taskId)
}

/** One row of a sidebar written whole, as `arrangeSidebar` takes it. */
export type ArrangedRow =
  | { kind: 'tab'; id: string; folderId: string | null; pinned: boolean; pinnedUrl?: string | null }
  | { kind: 'folder'; id: string; parentId: string | null; pinned: boolean }

/**
 * Writes a task's sidebar whole: each row's place is its index in `rows`, and
 * its folder and section are what the row says. Rows the task does not hold are
 * skipped, which is what keeps an id from another task from being moved in by
 * naming it here. The caller is the one that checks the shape makes sense (see
 * `arrange` in src/main/api/tabs.ts).
 *
 * `pinnedUrl` is written only where it is given, which is for the tabs whose
 * section changed: an address is set on the way into the pinned section and
 * cleared on the way out, and for every other tab left as it was.
 */
export async function arrangeSidebar(taskId: string, rows: ArrangedRow[]): Promise<void> {
  await db().transaction(async (tx) => {
    for (const [position, row] of rows.entries()) {
      if (row.kind === 'tab') {
        await tx
          .update(tabs)
          .set({
            position,
            folderId: row.folderId,
            pinned: row.pinned,
            ...(row.pinnedUrl === undefined ? {} : { pinnedUrl: row.pinnedUrl })
          })
          .where(and(eq(tabs.id, row.id), eq(tabs.taskId, taskId)))
      } else {
        await tx
          .update(tabFolders)
          .set({ position, parentId: row.parentId, pinned: row.pinned })
          .where(and(eq(tabFolders.id, row.id), eq(tabFolders.taskId, taskId)))
      }
    }
  })
}

/**
 * Moves a tab to another task, keeping the section it was in and leaving any
 * folder it was in behind.
 *
 * The one thing a tab could not do until now. A task is a frame around some
 * work, and what is inside the frame is a judgement that gets revised: a page
 * opened while answering one question turns out to be the whole of another, and
 * before this the only way to say so was to close it and open it again
 * somewhere else — which for a page is merely tedious and for a shell or a
 * conversation is destroying the thing and starting over.
 *
 * Both tasks are left as `closeTab` and `createTab` would have left them. The
 * strip it leaves is compacted and, if the tab held that task's focus, focus is
 * handed to the next tab down falling back to the one above. The strip it joins
 * takes it at the foot of the top of its own section (see `nextPosition`), and
 * adopts it as its active tab if it had none.
 *
 * Says nothing about which tasks may exchange tabs. A tab moved into a task in
 * another project would be a page in a strip that its own project could no
 * longer reach; the callers are what forbid it (see `move` in
 * src/main/api/tabs.ts), because the rule is about what a *caller* may do and
 * not about what the row can hold.
 */
export async function moveTab(id: string, taskId: string): Promise<Tab | undefined> {
  return db().transaction(async (tx) => {
    const [moving] = await tx.select().from(tabs).where(eq(tabs.id, id)).limit(1)
    if (!moving) return undefined
    // Already there. Not an error, and not worth a write: the strip would be
    // rewritten to exactly what it already says.
    if (moving.taskId === taskId) return asTab(moving)

    await handFocusOn(tx, moving.taskId, new Set([id]))

    // Out of any folder: the folder stays with the task it was made in.
    const position = await nextPosition(tx, taskId)
    const [row] = await tx
      .update(tabs)
      .set({ taskId, folderId: null, position })
      .where(eq(tabs.id, id))
      .returning()

    await compactSidebar(tx, moving.taskId)
    await adoptIfUnfocused(tx, taskId, id)
    return asTab(row)
  })
}

/**
 * Closes a tab, compacts the remaining positions, and — if the closed tab held
 * focus — hands it to the next tab down the sidebar, falling back to the one
 * above, the way a browser does. The foreign key's `set null` is only the
 * backstop for deletes that do not come through here.
 */
export async function closeTab(id: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [closing] = await tx
      .select({ taskId: tabs.taskId })
      .from(tabs)
      .where(eq(tabs.id, id))
      .limit(1)
    if (!closing) return

    await handFocusOn(tx, closing.taskId, new Set([id]))
    await tx.delete(tabs).where(eq(tabs.id, id))
    await compactSidebar(tx, closing.taskId)
  })
}
