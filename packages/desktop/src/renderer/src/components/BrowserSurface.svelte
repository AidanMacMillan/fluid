<script lang="ts">
  import { reorder } from '../lib/reorder.svelte'
  import { tabIdsInNode } from '@fluid/sdk'
  import { layoutOf, wholePane, type DividerPlace, type SplitEdge } from '../lib/splits'
  import { tabGlyph } from '../lib/tab-glyph'
  import { views } from '../lib/views.svelte'
  import { workspace } from '../lib/workspace.svelte'
  import { extensions } from '../lib/extensions.svelte'
  import TabPane from './TabPane.svelte'

  /**
   * The page area: the tab in front, or the split it is in, drawn as panes.
   *
   * Every pane is placed in one flat keyed list rather than as nested rows and
   * columns, however deep the split's tree, so a tab that goes from having the area to itself to being one
   * half of a split keeps its pane — only where it is drawn changes. Its page
   * is a native view the pane asks for (see TabPane), and a pane built again
   * would have its view taken down and put back, which offers a playing video
   * the miniplayer on the way.
   */

  /** The room between panes, in CSS pixels: wide enough to take hold of a divider. */
  const GAP = 6

  const split = $derived(workspace.activeSplit)
  const layout = $derived(split ? layoutOf(split, GAP) : null)

  const panes = $derived.by(() => {
    const places =
      layout?.panes ?? (workspace.activeTabId ? [wholePane(workspace.activeTabId)] : [])
    return places.flatMap((place) => {
      const tab = workspace.tabs.find((candidate) => candidate.id === place.tabId)
      return tab ? [{ place, tab }] : []
    })
  })

  /** The box the panes are placed in, and every divider and drop measured against. */
  let stage = $state<HTMLElement | null>(null)
  /** Each pane's own box, by tab id, for working out which one a drag is over. */
  const paneBoxes: Record<string, HTMLElement | null> = {}

  // The main process is told when nothing is in front; each pane says so for
  // itself when it is (see TabPane).
  $effect(() => {
    if (workspace.activeTabId === null) window.api.browser.focus(null)
  })

  $effect(() =>
    window.api.browser.onExtensionGone(({ tabId, reason }) => views.gone(tabId, reason))
  )
  // Read for its changes alone: whatever was asked while it said otherwise.
  $effect(() => {
    void extensions.infos
    views.sweep()
  })
  $effect(() => window.api.browser.onPoppedOut((tabId) => (views.poppedOutTabId = tabId)))
  $effect(() => window.api.browser.onFloating((tabIds) => (views.floatingTabIds = tabIds)))

  // A click into a page — one pane of a split — is the user moving to its tab.
  $effect(() => window.api.browser.onFocused((tabId) => void workspace.focusPane(tabId)))

  // And tells each floating window what to call its tab, which is what its row
  // here says: the name and the icon are worked out in this window, from state
  // only this window has. Tracked, so a page that retitles itself while it
  // floats is renamed there too.
  $effect(() => {
    for (const id of views.floatingTabIds) {
      const tab = workspace.tabs.find((candidate) => candidate.id === id)
      if (!tab) continue
      window.api.browser.describeFloating(tab.id, {
        label: workspace.labelFor(tab),
        image: workspace.iconFor(tab),
        glyph: tabGlyph(tab)
      })
    }
  })

  /**
   * The glass over the page area while a tab is dragged from the sidebar.
   *
   * A page is a native view, and takes every drag event over it for itself —
   * the edges a tab can be split onto would be there to see and impossible to
   * reach. So while a tab is in the air the main process lays a clear view over
   * the page area, above the pages, which catches the drag and reports it here
   * (see src/main/split-drop.ts). The pages go on drawing under it untouched;
   * what the drag means is worked out here, against the panes as laid out, and
   * the glass is told what to draw back (see the effect after `preview`).
   */
  /**
   * The glass's place in the window while it is up, which is what turns the
   * page-area coordinates it reports into the window's.
   */
  let glass: DOMRect | null = null

  /**
   * The tab the last drag carried. Kept past the end of the drag on purpose:
   * the sidebar row hears its own `dragend` before the glass's report of the
   * drop has made it here through the main process, and by then the drag
   * state has already let go of the tab.
   */
  let carried: string | null = null

  /** A glass taken down a moment after the drag ends — see the effect below. */
  let lowering: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    if (reorder.tab === null || !stage) return undefined
    const api = window.api.browser
    clearTimeout(lowering)
    carried = reorder.tab
    glass = stage.getBoundingClientRect()
    api.showSplitDrop({ x: glass.left, y: glass.top, width: glass.width, height: glass.height })

    // A drag whose row is taken out of the sidebar before it lands never hears
    // its `dragend`. The pointer moving with no button down is the drag being
    // over by any account — the platform sends no pointer moves during one.
    const over = (event: PointerEvent): void => {
      if (event.buttons === 0) reorder.end()
    }
    window.addEventListener('pointermove', over)

    return () => {
      window.removeEventListener('pointermove', over)
      target = null
      // Not at once: the drag has ended as far as this window knows, but the
      // glass may still be about to report where it was let go, and a glass
      // taken away first would take the drop with it. The report taking it
      // down is the usual way; this is for a drag let go anywhere else.
      lowering = setTimeout(() => {
        glass = null
        api.hideSplitDrop()
      }, 400)
    }
  })

  // Listened to for the window's life rather than per drag, for the reason
  // `carried` is kept: the drop arrives after the drag has ended here.
  $effect(() =>
    window.api.browser.onSplitDrop((report) => {
      const rect = glass
      if (!rect) return
      if (report.kind === 'leave') {
        target = null
        reorder.feedbackFor(null)
        return
      }
      // The glass's coordinates are the page area's; everything here is laid
      // out in the window's.
      const x = rect.left + report.x
      const y = rect.top + report.y
      if (report.kind === 'over') {
        if (reorder.tab !== null) {
          target = targetAt(x, y, reorder.tab)
          reorder.feedbackFor(
            target
              ? JSON.stringify([
                  'split',
                  target.kind,
                  target.kind === 'pane' ? target.tabId : null,
                  target.edge
                ])
              : null
          )
        }
        return
      }

      const tabId = report.tabId || carried
      const landing = targetAt(x, y, tabId)
      reorder.end()
      clearTimeout(lowering)
      glass = null
      target = null
      window.api.browser.hideSplitDrop()
      if (tabId && landing) land(tabId, landing)
    })
  )

  type Target =
    { kind: 'pane'; tabId: string; edge: SplitEdge } | { kind: 'outer'; edge: SplitEdge }

  /**
   * Where letting go now would put the tab: beside one pane, on one of its
   * edges — or along an outer edge of the whole split, a row across it or a
   * column down it (see `placeAlongside`).
   */
  let target = $state<Target | null>(null)

  /** The pane under a point, as its tab and its box. */
  function paneAt(x: number, y: number): { tabId: string; rect: DOMRect } | null {
    for (const { tab } of panes) {
      const rect = paneBoxes[tab.id]?.getBoundingClientRect()
      if (rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        return { tabId: tab.id, rect }
      }
    }
    return null
  }

  /**
   * The edge of `rect` nearest the pointer. The diagonals divide a pane into
   * four, so every point of it means one edge or another — there is no dead
   * centre to let go in and have nothing happen.
   */
  function nearestEdge(rect: DOMRect, x: number, y: number): SplitEdge {
    const across = (x - rect.left) / rect.width
    const down = (y - rect.top) / rect.height
    const distances: [SplitEdge, number][] = [
      ['left', across],
      ['right', 1 - across],
      ['top', down],
      ['bottom', 1 - down]
    ]
    return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0]
  }

  /**
   * How deep the bands along the split's outer edges reach, in CSS pixels:
   * enough to aim at without taking much from the panes' own edges, which are
   * the far commoner drop. Only there while a split is on screen — a lone
   * tab's own edges already mean the same thing. Nothing marks them: aiming
   * at one shows where the tab would go, the way aiming at a pane's edge does.
   */
  const OUTER_BAND = 28

  /** The outer edge of the stage a point is within a band's reach of, if any. */
  function outerEdgeAt(x: number, y: number): SplitEdge | null {
    if (!layout || !stage) return null
    const rect = stage.getBoundingClientRect()
    const reach: [SplitEdge, number][] = [
      ['left', x - rect.left],
      ['right', rect.right - x],
      ['top', y - rect.top],
      ['bottom', rect.bottom - y]
    ]
    const [edge, distance] = reach.reduce((best, next) => (next[1] < best[1] ? next : best))
    return distance < OUTER_BAND ? edge : null
  }

  /** What letting `dragged` go at a point would do, in window coordinates. */
  function targetAt(x: number, y: number, dragged: string | null): Target | null {
    const outer = outerEdgeAt(x, y)
    if (outer) return { kind: 'outer', edge: outer }
    const hit = paneAt(x, y)
    // Onto its own pane, or with nothing else on screen to go beside: there is
    // nowhere for the tab to go that it is not already.
    if (!hit || hit.tabId === dragged) return null
    return { kind: 'pane', tabId: hit.tabId, edge: nearestEdge(hit.rect, x, y) }
  }

  function land(tabId: string, landing: Target): void {
    if (landing.kind === 'pane') {
      void workspace.splitTab(tabId, landing.tabId, landing.edge)
      return
    }
    // Any tab of the split names it, except the one on its way in.
    const anchor = panes.find(({ tab }) => tab.id !== tabId)?.tab.id
    if (anchor) void workspace.splitAlongside(tabId, anchor, landing.edge)
  }

  /** The box around some panes, relative to the stage. */
  function boxAround(
    ids: string[]
  ): { left: number; top: number; width: number; height: number } | null {
    if (!stage) return null
    const origin = stage.getBoundingClientRect()
    const rects = ids.flatMap((id) => paneBoxes[id]?.getBoundingClientRect() ?? [])
    if (rects.length === 0) return null
    const left = Math.min(...rects.map((rect) => rect.left)) - origin.left
    const top = Math.min(...rects.map((rect) => rect.top)) - origin.top
    return {
      left,
      top,
      width: Math.max(...rects.map((rect) => rect.right)) - origin.left - left,
      height: Math.max(...rects.map((rect) => rect.bottom)) - origin.top - top
    }
  }

  /**
   * What the drop would take up, relative to the stage — always half of what
   * it lands beside. On a pane, half the pane. Along an outer edge, half the
   * whole split when the split runs the other way and becomes one side of a
   * new one; half of the child at that end when it runs the same way and the
   * tab joins the end of it.
   */
  const preview = $derived.by(() => {
    if (!target || !stage) return null
    let box: ReturnType<typeof boxAround>
    if (target.kind === 'pane') {
      box = boxAround([target.tabId])
    } else if (split) {
      const along =
        split.root.direction ===
        (target.edge === 'left' || target.edge === 'right' ? 'row' : 'column')
      const children = split.root.children
      const end =
        target.edge === 'left' || target.edge === 'top'
          ? children[0]
          : children[children.length - 1]
      box = boxAround(along ? tabIdsInNode(end) : panes.map(({ tab }) => tab.id))
    } else {
      return null
    }
    if (!box) return null

    const { left, top, width, height } = box
    const half =
      target.edge === 'left'
        ? { x: left, y: top, width: width / 2, height }
        : target.edge === 'right'
          ? { x: left + width / 2, y: top, width: width / 2, height }
          : target.edge === 'top'
            ? { x: left, y: top, width, height: height / 2 }
            : { x: left, y: top + height / 2, width, height: height / 2 }
    // Held in from the edges it shares with the panes, so it reads as a place
    // inside them rather than as a second outline laid over theirs.
    const inset = 4
    return {
      x: half.x + inset,
      y: half.y + inset,
      width: Math.max(0, half.width - 2 * inset),
      height: Math.max(0, half.height - 2 * inset)
    }
  })

  // What the glass draws: where the drop would go. Relative to the stage,
  // which is where the glass sits.
  $effect(() => {
    if (reorder.tab === null) return
    window.api.browser.previewSplitDrop({ box: preview })
  })

  /**
   * The divider being dragged, while one is, with the stretch it can travel:
   * from the near edge of everything before it to the far edge of everything
   * after it, along the way it drags. That stretch stays put however the two
   * sides trade room, so it is measured once, off the panes' own boxes.
   */
  let resizing = $state<{
    place: DividerPlace
    pointerId: number
    from: number
    to: number
  } | null>(null)

  /** Stable across redraws, so the handle being dragged keeps its element. */
  function dividerKey(place: DividerPlace): string {
    return `${place.divider.path.join('.')}:${place.divider.index}`
  }

  /**
   * How far along the pair either side of the divider the pointer is, 0 to 1 —
   * the share the one before it would have if the divider were let go there.
   */
  function shareAt(event: PointerEvent): number {
    if (!resizing) return 0.5
    const { place, from, to } = resizing
    const pointer = place.direction === 'row' ? event.clientX : event.clientY
    const span = to - from - GAP
    return span > 0 ? (pointer - from - GAP / 2) / span : 0.5
  }

  function onDividerDown(event: PointerEvent, place: DividerPlace): void {
    if (event.button !== 0) return
    const row = place.direction === 'row'
    const rects = (ids: string[]): DOMRect[] =>
      ids.flatMap((id) => paneBoxes[id]?.getBoundingClientRect() ?? [])
    const before = rects(place.before)
    const after = rects(place.after)
    if (before.length === 0 || after.length === 0) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    resizing = {
      place,
      pointerId: event.pointerId,
      from: Math.min(...before.map((rect) => (row ? rect.left : rect.top))),
      to: Math.max(...after.map((rect) => (row ? rect.right : rect.bottom)))
    }
  }

  function onDividerMove(event: PointerEvent): void {
    if (!resizing || resizing.pointerId !== event.pointerId) return
    workspace.resizeSplit(resizing.place.divider, shareAt(event))
  }

  function onDividerUp(event: PointerEvent): void {
    if (!resizing || resizing.pointerId !== event.pointerId) return
    const share = shareAt(event)
    const { place } = resizing
    resizing = null
    void workspace.endSplitResize(place.divider, share)
  }

  // The leading corner is only a corner while the sidebar is out. Away, the
  // well meets the window's left edge and the curve would read as a nick out of
  // it, so it squares off — in step with the slide, not ahead of it.
  const leadingRadius = $derived(workspace.sidebarOut ? 'var(--radius-surface)' : '0px')
</script>

<main
  class="relative flex min-h-0 flex-1 flex-col overflow-hidden glass-well"
  style:--well-radius-leading={leadingRadius}
>
  <div bind:this={stage} class="relative min-h-0 flex-1">
    {#each panes as pane (pane.tab.id)}
      <div
        bind:this={paneBoxes[pane.tab.id]}
        class="absolute flex flex-col"
        style:left={pane.place.x.start}
        style:width={pane.place.x.size}
        style:top={pane.place.y.start}
        style:height={pane.place.y.size}
      >
        <TabPane
          tab={pane.tab}
          place={pane.place}
          focused={pane.tab.id === workspace.activeTabId}
          split={panes.length > 1}
        />
      </div>
    {/each}

    {#if layout}
      <!-- In the gaps between panes, where the renderer can still be reached:
           a page takes every pointer event inside its own rect, so a handle
           over one would be a handle nothing can take hold of. -->
      {#each layout.dividers as place (dividerKey(place))}
        <div
          role="separator"
          aria-orientation={place.direction === 'row' ? 'vertical' : 'horizontal'}
          class="group/divider absolute z-10 flex split-divider items-center justify-center
                 {place.direction === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'}"
          class:active={resizing !== null && dividerKey(resizing.place) === dividerKey(place)}
          style:left={place.x.start}
          style:width={place.x.size}
          style:top={place.y.start}
          style:height={place.y.size}
          onpointerdown={(event) => onDividerDown(event, place)}
          onpointermove={onDividerMove}
          onpointerup={onDividerUp}
          onpointercancel={onDividerUp}
        >
          <span
            class="split-divider-line pointer-events-none
                   {place.direction === 'row' ? 'h-full w-px' : 'h-px w-full'}"
          ></span>
        </div>
      {/each}
    {/if}

    {#if panes.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-3 text-ink-500">
        <span class="icon-[ph--compass] text-3xl" aria-hidden="true"></span>
        <p class="text-xs">No tab open in this task.</p>
        <button
          type="button"
          onclick={() => window.api.launcher.open()}
          class="rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300 hover:text-ink-50"
        >
          New tab
        </button>
      </div>
    {/if}
  </div>
</main>
