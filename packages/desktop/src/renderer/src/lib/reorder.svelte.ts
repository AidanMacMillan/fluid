/**
 * Drag-to-reorder for the two strips, built on the platform's own drag and
 * drop rather than pointer events: the OS draws the dragged item, handles the
 * cursor, and cancels on Escape for free.
 *
 * Only one drag can be in flight at a time, so this is a module singleton
 * rather than something each list constructs. Every list reads it, and the
 * `kind` discriminator is what keeps a task from drawing drop lines in the
 * sidebar.
 *
 * The sidebar's two sections are two kinds sharing one scope: a drag that
 * starts among the pinned tabs can be let go among the loose ones and the other
 * way about, and crossing the divider is what pins a tab and unpins it (see
 * `Workspace.moveTab`). A pin is still a decision rather than an accident — the
 * drop lands where the line was drawn, the divider is a visible thing to cross,
 * and nothing moves on hover — but it is a decision made where the tabs are,
 * which is the one place the user can see what the sections hold.
 *
 * What a given drag may be let go in is named at its start rather than fixed
 * per kind, because it is not always the same answer for two rows of the same
 * list: a terminal has no address to be sent back to and so cannot be pinned,
 * and its drag says as much. The task strip is a scope of its own that nothing
 * crosses into or out of.
 *
 * Nothing reorders across the two, but a tab can be handed to a task: let go on
 * one of the strip's tasks, it moves there (see `overTask`). That is not a slot
 * in a list, so it has none of the drop-line machinery — the task under the
 * pointer lights up whole, and the drop names the tab and nothing else. A
 * folder can be handed over the same way, and everything in it goes along.
 *
 * The sidebar is a tree rather than a list — folders hold tabs and folders —
 * so a place in it is a folder and a slot among that folder's children rather
 * than an index (see `SidebarSlot`). The rows work out which slot the pointer
 * means, since only a row knows where it sits, and hand it here with what to
 * draw for it (see `aim`).
 */

export type ReorderKind = 'task' | 'tab' | 'pinned-tab'

/** The sidebar's two sections, named by the kind a drag in each one is. */
export type SidebarSection = 'pinned-tab' | 'tab'

/** What a drag in the sidebar is carrying. */
export type SidebarItemRef = { kind: 'tab' | 'folder'; id: string }

/**
 * A place in the sidebar: a section, the folder in it (null for the top of the
 * section), and the insertion slot among that folder's children, 0..length.
 */
export type SidebarSlot = { section: SidebarSection; parentId: string | null; index: number }

/**
 * What the sidebar draws for the slot a drop would land in: a line along the
 * top or bottom of a row, indented to the depth the drop lands at; a folder
 * lit whole, for a drop into it; or a line under the last row of a section, at
 * the section's own depth, for the slot past the end of it.
 */
export type SidebarMark =
  | { kind: 'line'; rowId: string; edge: 'top' | 'bottom'; depth: number }
  | { kind: 'into'; folderId: string }
  | { kind: 'end'; section: SidebarSection }

/** Which way a list runs, and therefore which axis decides before-vs-after. */
export type Axis = 'x' | 'y'

/**
 * Where a drop came from and where it landed. Both ends carry their list,
 * because for the sidebar they need not be the same one: which section the item
 * was let go in is what says whether the drop was a reorder or a pin, and only
 * the caller knows what its lists mean.
 */
export type ReorderMove = {
  /** The list the drag started in, and the item's index within it. */
  from: { kind: ReorderKind; index: number }
  /** The list it was let go in, and the insertion slot within it, 0..length. */
  to: { kind: ReorderKind; index: number }
}

/**
 * A private MIME type per list. `dataTransfer.types` is the only part of the
 * payload readable during `dragover` — the data itself is withheld until the
 * drop — so the type is what answers "is this drag mine?" for a link dragged
 * in from a page, a file from Finder, or a task dragged over the tab list.
 *
 * The sidebar's two kinds deliberately share one type: they are two halves of a
 * single strip, and a type apiece would refuse at the platform's level the very
 * drop that moves a tab between them. Which of the two a drag may actually be
 * let go in is `into`'s to answer, per drag.
 */
const MIME: Record<ReorderKind, string> = {
  task: 'application/x-fluid-task',
  tab: 'application/x-fluid-tab',
  'pinned-tab': 'application/x-fluid-tab'
}

class Reorder {
  /** The list being dragged from, or null when no drag of ours is in flight. */
  kind = $state<ReorderKind | null>(null)
  /**
   * The lists this drag may be let go in. Not derived from `kind`, because two
   * rows of one list can differ: every tab can join the loose ones, and only a
   * tab with an address to come home to can join the pinned ones.
   *
   * Deliberately not reactive: it is read while answering drag events and never
   * while drawing, and what it would redraw is the very thing `offered` exists
   * to hold back a frame.
   */
  private into: readonly ReorderKind[] = []
  /**
   * The same answer a frame later, for the lists that show a drag they could
   * take. Held back for the reason `dimmed` is: nothing a list draws for a drag
   * is worth touching in the moment the platform is still setting that drag up,
   * and a frame is all it takes to be clear of it. A drop target can only be
   * reached long after.
   *
   * What a list may draw with it is a colour, never a size. A column that grew
   * while a drag began would shift every row under the pointer, and a drag
   * whose source is disturbed then is abandoned outright — so the sidebar keeps
   * its empty pinned section in the layout at all times and only paints it (see
   * `pin-seam`), which is also what keeps the list from jittering.
   */
  private offered = $state<readonly ReorderKind[]>([])
  /**
   * The list the pointer is over now, which for a drag that can cross is not
   * always the one it started in. This is what decides where the drop line is
   * drawn — the line belongs to the list the drop would land in.
   */
  target = $state<ReorderKind | null>(null)
  /** Index the dragged item started at, within the list it started in. */
  from = $state(-1)
  /** Insertion index under the pointer, 0..length; -1 while over nothing. */
  to = $state(-1)
  /** The dragged item's id, but only once it is safe to dim it — see `start`. */
  dimmed = $state<string | null>(null)
  /**
   * The tab being dragged, once it is safe to change anything for it — see
   * `start`. What the page area watches to lay the glass over its pages that
   * catches the drag for splitting (see BrowserSurface).
   */
  tab = $state<string | null>(null)
  /**
   * The task a tab drag is over, which letting go would move the tab into. Null
   * while the drag is anywhere else, and for every drag that is not a tab's.
   */
  intoTask = $state<string | null>(null)

  /** What a sidebar drag is carrying, or null for any other drag. */
  private carrying: SidebarItemRef | null = null
  /** Where the carried item sits, for telling a real move from a no-op. */
  private origin = $state<SidebarSlot | null>(null)
  /** Where in the sidebar letting go would land it, while the pointer is over a place. */
  slot = $state<SidebarSlot | null>(null)
  /** What the sidebar draws for `slot`. */
  mark = $state<SidebarMark | null>(null)

  /**
   * Whether the drop would actually move anything. Landing back in the item's
   * own slot — on either side of it — is a no-op, and a drop line there would
   * promise a change that will not happen. That is within one list; every slot
   * of another list is a change, because the item is leaving the one it is in.
   * In the sidebar the list is the folder, or the top of the section.
   */
  moves = $derived.by(() => {
    if (this.origin !== null) {
      const { origin, slot } = this
      return (
        slot !== null &&
        (slot.section !== origin.section ||
          slot.parentId !== origin.parentId ||
          (slot.index !== origin.index && slot.index !== origin.index + 1))
      )
    }
    return (
      this.to !== -1 &&
      (this.target !== this.kind || (this.to !== this.from && this.to !== this.from + 1))
    )
  })

  /**
   * Begins a drag. Goes on the item's own draggable element. `into` is the
   * lists this particular item may be let go in, its own included; left out, it
   * is the list it came from and nowhere else.
   */
  start(
    event: DragEvent,
    kind: ReorderKind,
    id: string,
    index: number,
    into: readonly ReorderKind[] = [kind]
  ): void {
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    // Nothing ever reads this back — the type alone carries the meaning — but a
    // transfer with no data at all is not a drag as far as the platform is
    // concerned, and Firefox refuses to start one.
    event.dataTransfer.setData(MIME[kind], id)

    this.kind = kind
    this.into = into
    this.carrying = null
    this.origin = null
    this.intoTask = null
    this.target = null
    this.from = index
    this.to = -1
    // Everything the drag changes on screen waits a frame. The browser
    // snapshots the element for the drag image once this handler returns, so
    // dimming the source now would make the thing under the cursor a ghost of a
    // ghost — and disturbing the layout around it now loses the drag altogether
    // (see `offered`).
    requestAnimationFrame(() => {
      if (this.kind !== kind) return
      this.dimmed = id
      this.offered = into
      // Only a tab can be split: the page area lays its glass for a tab alone.
      if ((kind === 'tab' || kind === 'pinned-tab') && this.carrying?.kind !== 'folder') {
        this.tab = id
      }
    })
  }

  /**
   * Begins a drag in the sidebar, of a tab or a folder. `origin` is where it
   * sits, and `into` the sections it may be let go in.
   */
  startInSidebar(
    event: DragEvent,
    section: SidebarSection,
    item: SidebarItemRef,
    origin: SidebarSlot,
    into: readonly SidebarSection[]
  ): void {
    this.start(event, section, item.id, -1, into)
    this.carrying = item
    this.origin = origin
    this.slot = null
    this.mark = null
  }

  /**
   * Tracks the pointer over a place in the sidebar, which the row under it has
   * worked out: the slot a drop there lands in, what to draw for it, and every
   * folder that slot is inside — so that a folder is never let go inside
   * itself, or inside anything it holds. That drop is refused outright rather
   * than handed on to the list around the row, which would take it as the end
   * of the section.
   */
  aim(event: DragEvent, slot: SidebarSlot, mark: SidebarMark, within: readonly string[]): void {
    if (!this.accepts(event, slot.section)) return
    const carrying = this.carrying
    if (carrying?.kind === 'folder' && within.includes(carrying.id)) {
      event.stopPropagation()
      this.target = null
      this.slot = null
      this.mark = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    this.target = slot.section
    this.slot = slot
    this.mark = mark
  }

  /**
   * A sidebar section's own `dragover`, for the ground past its last row: the
   * slot past the end of the top of the section. `length` is how many things
   * sit at the top of it, folders counting once whatever they hold.
   */
  overSectionEnd(event: DragEvent, section: SidebarSection, length: number): void {
    if (event.defaultPrevented) return
    this.aim(event, { section, parentId: null, index: length }, { kind: 'end', section }, [])
  }

  /**
   * Resolves a drop in the sidebar into what was carried and where it landed,
   * or null when it changes nothing. Ends the drag either way. As with
   * `resolve`, where it landed is the slot last aimed at rather than wherever
   * the drop event fired.
   */
  resolveInSidebar(
    event: DragEvent,
    section: SidebarSection
  ): { item: SidebarItemRef; slot: SidebarSlot } | null {
    if (!this.accepts(event, section)) return null
    event.preventDefault()
    const move =
      this.moves && this.carrying !== null && this.slot !== null
        ? { item: this.carrying, slot: this.slot }
        : null
    this.end()
    return move
  }

  /** The line a row draws for the drop in flight, if it is this row's to draw. */
  lineOn(rowId: string): Extract<SidebarMark, { kind: 'line' }> | null {
    const mark = this.mark
    return this.moves && mark?.kind === 'line' && mark.rowId === rowId ? mark : null
  }

  /** Whether a drop would land inside this folder, which it is lit whole for. */
  landsIn(folderId: string): boolean {
    const mark = this.mark
    return this.moves && mark?.kind === 'into' && mark.folderId === folderId
  }

  /** Whether a drop would land past the end of this section. */
  landsAtEnd(section: SidebarSection): boolean {
    const mark = this.mark
    return this.moves && mark?.kind === 'end' && mark.section === section
  }

  /**
   * Whether a row is dimmed for being carried: the item itself, or anything in
   * a folder being carried, which is going wherever the folder goes.
   */
  carries(id: string, within: readonly string[]): boolean {
    const dimmed = this.dimmed
    return dimmed !== null && (dimmed === id || within.includes(dimmed))
  }

  /**
   * Whether the drag in flight could be let go in this list. What a list reads
   * to show that it would take the drag: the sidebar's pinned section is empty
   * for most tasks, and an empty section that said nothing would be a place
   * nobody could know to drop a tab.
   */
  canDropIn(kind: ReorderKind): boolean {
    return this.offered.includes(kind)
  }

  /**
   * Tracks the pointer across one item. The midpoint along `axis` decides
   * whether the drop lands before or after it.
   */
  over(event: DragEvent, kind: ReorderKind, index: number, axis: Axis): void {
    if (!this.accepts(event, kind)) return
    // Claiming the event is what makes the element a drop target at all;
    // without it the browser refuses the drop and no `drop` ever fires.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const past =
      axis === 'x'
        ? event.clientX > rect.left + rect.width / 2
        : event.clientY > rect.top + rect.height / 2

    this.target = kind
    this.to = past ? index + 1 : index
  }

  /**
   * The container's own `dragover`, for the empty space past the last item.
   * Items handle their own area first and this bubbles afterwards, so an
   * already-claimed event is left alone.
   */
  overRest(event: DragEvent, kind: ReorderKind, length: number): void {
    if (event.defaultPrevented) return
    if (!this.accepts(event, kind)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

    this.target = kind
    this.to = length
  }

  /**
   * Keeps a drag of ours alive over ground that belongs to no list — the seam
   * between the sidebar's two sections above all, and the panel above them.
   *
   * The platform only delivers a drop to an element that claimed the drag as it
   * passed over, so without this a drop on the gap would be refused outright
   * and the line drawn just above it would come to nothing. The pending slot is
   * left exactly as it was, which is what makes the gap behave as the edge of
   * whichever list the pointer last crossed — and what keeps the line from
   * blinking out in the middle of a drag between the two.
   */
  overGap(event: DragEvent, kinds: readonly ReorderKind[]): void {
    if (event.defaultPrevented) return
    if (!kinds.some((kind) => this.accepts(event, kind))) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }

  /**
   * Tracks a tab or folder drag over one of the strip's tasks. Goes on the
   * task's own box, and is left out for the task the tab is already in — the
   * sidebar only ever shows the selected task's tabs, so that is the selected
   * task.
   *
   * Whatever line the sidebar was drawing goes: the drop would land here, not
   * in the slot the pointer last crossed on its way out of the column.
   */
  overTask(event: DragEvent, taskId: string): void {
    if (!this.carryingFromSidebar(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

    this.intoTask = taskId
    this.target = null
    this.to = -1
  }

  /** Lets a task go dark again once a tab drag has really left its box. */
  leaveTask(event: DragEvent, taskId: string): void {
    if (this.intoTask !== taskId) return
    const box = event.currentTarget as HTMLElement
    if (event.relatedTarget instanceof Node && box.contains(event.relatedTarget)) return
    this.intoTask = null
  }

  /**
   * The tab or folder let go on a task, to be moved into it, or null when the
   * drop was not one of the sidebar's. Ends the drag either way, since the row
   * it started from is about to leave the sidebar and take its `dragend` with
   * it.
   */
  dropOnTask(event: DragEvent, taskId: string): SidebarItemRef | null {
    if (!this.carryingFromSidebar(event) || this.intoTask !== taskId) return null
    event.preventDefault()
    const item = this.carrying
    this.end()
    return item
  }

  /** Drops the pending line when the pointer leaves the container for good. */
  leave(event: DragEvent): void {
    const container = event.currentTarget as HTMLElement
    // `dragleave` also fires when crossing between children; only a
    // relatedTarget outside the container means the drag has really left.
    if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return
    this.target = null
    this.to = -1
    this.slot = null
    this.mark = null
  }

  /**
   * Resolves a drop into both its ends, or null when the drop changes nothing.
   * Ends the drag either way. `kind` is the list claiming the drop, which is
   * only what the drag is checked against — where it actually landed is read
   * off the pointer, so a drop on the seam between two lists lands in the one
   * the line was last drawn in.
   */
  resolve(event: DragEvent, kind: ReorderKind): ReorderMove | null {
    if (!this.accepts(event, kind)) return null
    event.preventDefault()

    const move =
      this.moves && this.kind !== null && this.target !== null
        ? {
            from: { kind: this.kind, index: this.from },
            to: { kind: this.target, index: this.to }
          }
        : null
    this.end()
    return move
  }

  /**
   * Resolves a drop into the reordered list, or null when the drop changes
   * nothing. For a list nothing can cross into, where both ends of the move are
   * the same list and the caller only wants the result.
   */
  drop<T>(event: DragEvent, kind: ReorderKind, items: readonly T[]): T[] | null {
    const move = this.resolve(event, kind)
    return move ? moveTo(items, move.from.index, move.to.index) : null
  }

  /** Clears the drag. Also the `dragend` handler: it fires even on a cancel. */
  end(): void {
    this.kind = null
    this.intoTask = null
    this.into = []
    this.offered = []
    this.target = null
    this.from = -1
    this.to = -1
    this.dimmed = null
    this.tab = null
    this.carrying = null
    this.origin = null
    this.slot = null
    this.mark = null
  }

  /** Whether a drop line belongs immediately before slot `index` of `kind`. */
  lineAt(kind: ReorderKind, index: number): boolean {
    return this.target === kind && this.moves && this.to === index
  }

  /** Whether the drag in flight is one of the sidebar's rows, from either section. */
  private carryingFromSidebar(event: DragEvent): boolean {
    return (
      this.carrying !== null &&
      (this.kind === 'tab' || this.kind === 'pinned-tab') &&
      (event.dataTransfer?.types.includes(MIME.tab) ?? false)
    )
  }

  private accepts(event: DragEvent, kind: ReorderKind): boolean {
    return this.into.includes(kind) && (event.dataTransfer?.types.includes(MIME[kind]) ?? false)
  }
}

/**
 * Moves `from` to insertion slot `to`. The slot is counted against the list as
 * it stands now, so removing the item first shifts every later slot down by
 * one — hence the adjustment.
 *
 * Exported for the sidebar, whose two sections are one list in two halves: it
 * joins them, moves within the join, and splits the answer back at the divider.
 */
export function moveTo<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, item)
  return next
}

export const reorder = new Reorder()
