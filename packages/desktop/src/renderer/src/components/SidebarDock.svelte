<script lang="ts">
  import { SIDEBAR_WIDTH, workspace } from '../lib/workspace.svelte'
  import ResizeHandle from './ResizeHandle.svelte'
  import Sidebar from './Sidebar.svelte'
  import { reorder } from '../lib/reorder.svelte'
  import { sidebarRows } from '../lib/sidebar-rows'
  import { titleBarHeight } from '../../../shared/appearance'
  import {
    SIDEBAR_OPEN_MS,
    SIDEBAR_CLOSE_MS,
    type SidebarHover
  } from '../../../shared/sidebar-panel'

  const { density }: { density: number } = $props()

  /**
   * Allows the edge strip to hand the pointer to the native panel before its
   * hover report arrives. Leaving the panel itself bypasses this delay.
   */
  const HIDE_DELAY_MS = 220

  /**
   * How wide the strip the pointer aims at to bring the sidebar back is. It
   * takes no width in the layout — a collapsed dock leaves the well flush
   * against the window's sidebar edge — so the strip overlays the well's own
   * leading edge instead.
   *
   * Only the part of it the renderer draws is a pointer target in the ordinary
   * way. A page is a native view stacked above the renderer and takes every
   * pointer event inside its rect, so over a page the strip is an element
   * nothing can reach — which is most of its height, and the part the pointer
   * actually arrives at. The main process watches the same band on the page's
   * own input and reports the crossings (see the `onPeek` effect below), so the
   * one width describes both halves and they behave alike.
   */
  const PEEK_STRIP_WIDTH = 8

  /**
   * How long the sidebar takes to arrive and to leave. Leaving is the quicker
   * of the two on purpose: a panel on its way out has nothing left to show, and
   * holding the same pace both ways makes it feel reluctant to go.
   */
  const OPEN_MS = SIDEBAR_OPEN_MS
  const CLOSE_MS = SIDEBAR_CLOSE_MS

  let dock = $state<HTMLElement | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let panelHovered = false
  let panelDragging = false
  let wasOpen = false
  let reopenAfter = 0

  const right = $derived(workspace.sidebarPosition === 'right')
  const collapsed = $derived(workspace.sidebarCollapsed)
  const open = $derived(!collapsed)
  // The mounted dock keeps its row layout while sliding in or out. Visibility
  // controls interaction, not whether its icons acquire labels mid-animation.
  const compact = $derived(workspace.sidebarWidth === SIDEBAR_WIDTH.icons)
  let expandedWidth: number = SIDEBAR_WIDTH.default

  function toggleIconOnly(): void {
    if (compact) workspace.endSidebarResize(expandedWidth)
    else {
      expandedWidth = workspace.sidebarWidth
      workspace.endSidebarResize(SIDEBAR_WIDTH.icons)
    }
  }

  const railActive = $derived(open && compact)
  let hover = $state<SidebarHover | null>(null)
  let sourceHovered = false
  const visibleRows = $derived([
    ...sidebarRows(workspace.sidebar.pinned, 'pinned-tab', workspace.onScreenTabIds),
    ...sidebarRows(workspace.sidebar.loose, 'tab', workspace.onScreenTabIds)
  ])
  const card = $derived(
    railActive &&
      !workspace.sidebarResizing &&
      hover &&
      visibleRows.some((row) => row.id === hover.id)
      ? hover
      : null
  )

  function hoverItem(item: SidebarHover | null): void {
    // Keep a native drag's source mounted in place; passing another icon must
    // not replace its card or cover the row that should receive the drop.
    if (reorder.kind !== null) return
    sourceHovered = item !== null
    if (item) hover = item
    else hideCard()
  }

  function hideCard(): void {
    if (!sourceHovered && !panelHovered && !panelDragging) hover = null
  }

  // Cards belong to a particular layout and task; never leave one at an old row position.
  $effect(() => {
    void workspace.activeTaskId
    void workspace.sidebarPosition
    void workspace.sidebarResizing
    void compact
    void open
    void density
    hover = null
    panelHovered = false
    sourceHovered = false
  })

  /**
   * What the dock is animating towards. The width lives here rather than on the
   * sidebar so one transition carries both halves of the motion: the dock's
   * inner edge is also the content well's adjacent edge, so the well slides over in
   * the same breath the sidebar slides out.
   */
  const width = $derived(open ? workspace.sidebarWidth : 0)

  /**
   * A resize drag is the pointer steering the width directly, so there is
   * nothing to animate towards — easing it would just put the edge behind the
   * cursor. Zero duration rather than a second code path: the drag ends and the
   * next open or close eases again.
   */
  const duration = $derived(workspace.sidebarResizing ? 0 : open ? OPEN_MS : CLOSE_MS)

  function show(): void {
    if (!collapsed || performance.now() < reopenAfter) return
    clearTimeout(timer)
    workspace.sidebarPeeking = true
  }

  // Entering the dock only keeps an existing peek alive. The shrinking dock
  // can move under the pointer, but only the edge strip should start a peek.
  function keepOpen(): void {
    if (workspace.sidebarPeeking) clearTimeout(timer)
  }

  function hide(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // Two things outlast the grace period. A resize drag holds the peek open,
      // because pulling the sidebar out from under the handle would strand the
      // drag with nothing left to end it; and a pointer still on the dock has
      // not really left — during a drag it never reports leaving at all. Both
      // wait another round rather than cancelling, so the peek still ends once
      // neither is true.
      if (workspace.sidebarResizing || panelHovered || panelDragging || dock?.matches(':hover')) {
        hide()
        return
      }
      workspace.sidebarPeeking = false
    }, HIDE_DELAY_MS)
  }

  function hideImmediately(): void {
    clearTimeout(timer)
    // Finish an active gesture before taking its source out from under it.
    if (workspace.sidebarResizing || panelDragging) return
    workspace.sidebarPeeking = false
  }

  // Docking the sidebar ends any peek still in flight, so the next collapse
  // starts from the strip rather than from a sidebar nothing is hovering.
  $effect(() => {
    if (!collapsed) {
      workspace.sidebarPeeking = false
      panelHovered = false
      panelDragging = false
    }
  })

  // Let a close finish before accepting another edge entry. Ignored entries
  // are not queued: a pointer left on the strip must leave and enter again.
  // Run before DOM updates, which can themselves produce hover crossings.
  $effect.pre(() => {
    const visible = workspace.sidebarOut
    if (wasOpen && !visible) {
      clearTimeout(timer)
      reopenAfter = performance.now() + CLOSE_MS
    }
    wasOpen = visible
  })

  /**
   * The strip's other half: the band of the page the main process watches on
   * the app's behalf, asked for only while the sidebar is away and given up
   * the moment it is docked, so a page reports nothing nobody is waiting for.
   */
  $effect(() => {
    window.api.browser.watchPeekZone(collapsed ? PEEK_STRIP_WIDTH : 0, workspace.sidebarPosition)
    return () => window.api.browser.watchPeekZone(0)
  })

  /**
   * What comes back: the pointer crossing into that band and out of it, handled
   * as the `mouseenter` and `mouseleave` the strip would have had. Leaving in
   * particular goes through the same grace period, which is what keeps the peek
   * up through the hand-off — the native panel arrives over the page and
   * reports its own hover as the page reports the pointer leaving.
   */
  $effect(() => window.api.browser.onPeek((inside) => (inside ? show() : hide())))

  // The native panel shares the host's current task and live tab state. Only
  // docking changes this component's layout width; peeking never touches it.
  $effect(() => {
    window.api.sidebar.updatePanel(
      $state.snapshot({
        projects: workspace.projects,
        activeProjectId: workspace.activeProjectId,
        tasks: workspace.tasks,
        tabs: workspace.tabs,
        folders: workspace.folders,
        activeTaskId: workspace.activeTaskId,
        pages: workspace.pages,
        downloads: workspace.downloads,
        sidebarWidth:
          collapsed && workspace.sidebarWidth === SIDEBAR_WIDTH.icons
            ? SIDEBAR_WIDTH.default
            : workspace.sidebarWidth,
        railWidth: railActive ? workspace.sidebarWidth : undefined,
        hover: card,
        sidebarPosition: workspace.sidebarPosition,
        open: (collapsed && workspace.sidebarPeeking) || card !== null,
        collapsed,
        density,
        top: titleBarHeight(density)
      })
    )
  })

  $effect(() =>
    window.api.sidebar.onPanelReport((report) => {
      if (railActive && report.kind === 'hover') {
        panelHovered = report.inside
        if (report.inside) {
          // The overlay now owns the pointer, including the original icon's area.
          sourceHovered = false
        } else hideCard()
      } else if (report.kind === 'hover') {
        panelHovered = report.inside
        if (report.inside) keepOpen()
        else hideImmediately()
      } else if (report.kind === 'resize') {
        if (report.commit) {
          workspace.endSidebarResize(report.width)
          if (!panelHovered) hideImmediately()
        } else workspace.resizeSidebar(report.width)
      } else if (report.kind === 'drag') {
        const wasDragging = panelDragging
        panelDragging = report.item !== null
        reorder.acceptSidebarDrag(report.item, report.section, report.origin)
        if (wasDragging && !panelDragging && !panelHovered) {
          if (railActive) hideCard()
          else hideImmediately()
        }
      } else {
        panelHovered = false
        workspace.sidebarPeeking = false
        hover = null
      }
    })
  )

  $effect(() => () => {
    clearTimeout(timer)
  })
</script>

<svelte:window
  onresize={() => (hover = null)}
  onkeydown={(event) => {
    if (event.key === 'Escape') hover = null
  }}
/>

<!-- The dock carries the sidebar and the pointer target both, so moving from
     one to the other crosses no gap and the peek survives the trip. Collapsed,
     it has no width at all: the well runs to the window's sidebar edge, and the
     strip below reaches back over it. -->
<div
  role="presentation"
  bind:this={dock}
  class="relative flex shrink-0 transition-[width] duration-(--panel-duration) ease-glide motion-reduce:transition-none"
  style:width="{width}px"
  style:--panel-duration="{duration}ms"
  onmouseenter={collapsed ? keepOpen : undefined}
  onmouseleave={collapsed ? hide : undefined}
>
  <!-- The sidebar stays mounted whether it is out or away, so the motion has
       something to carry: mounting it on the way in would pop the whole tab
       list into place at full opacity before the width had moved. Clipping is
       what hides it instead — its own layer, because the resize handle
       deliberately hangs past the dock's edge and must not be clipped with it. -->
  <div class="absolute inset-0 overflow-hidden">
    <!-- Anchored to the dock's inner edge, so the whole
         sidebar travels with the seam instead of being revealed in place while
         the content well slides away from it. The fade covers the last few
         pixels, where the panel would otherwise leave a sliver of
         tab row showing in the collapsed strip. -->
    <div
      class="absolute inset-y-0 {right
        ? 'left-0'
        : 'right-0'} transition-opacity duration-(--panel-duration) ease-glide motion-reduce:transition-none"
      class:opacity-0={!open}
      style:width="{workspace.sidebarWidth}px"
      inert={!open}
    >
      <Sidebar
        {compact}
        coveredId={card?.id}
        onhover={hoverItem}
        ondismiss={() => (hover = null)}
      />
    </div>
  </div>

  {#if collapsed}
    <!-- The pointer target for a sidebar that is away. It overlays the well's
         leading edge rather than reserving a strip of its own, so nothing sits
         between the well and the window's edge while the sidebar is gone —
         which is also why it needs the z-index the resize handle needs: the
         well comes later in the tree and would otherwise be painted over it. -->
    <div
      aria-hidden="true"
      class="absolute inset-y-0 z-10 {right ? 'right-0' : 'left-0'}"
      style:width="{PEEK_STRIP_WIDTH}px"
      onmouseenter={show}
      onmouseleave={hide}
    ></div>
  {/if}

  {#if open}
    <!-- Absolute rather than a column of its own: the content well starts
         where the dock ends, and a flex item here would push it over by however
         much the handle needs to be easy to hit. Straddling the seam instead
         costs the layout nothing — the half that reaches over the well is
         covered by the native page view, so the sidebar half is what the
         pointer finds. -->
    <ResizeHandle
      label="Resize sidebar"
      class="absolute inset-y-0 z-10 w-2 {right ? '-left-1' : '-right-1'}"
      factor={right ? -1 : 1}
      width={workspace.sidebarWidth}
      min={SIDEBAR_WIDTH.icons}
      snapMin={SIDEBAR_WIDTH.min}
      max={SIDEBAR_WIDTH.max}
      onresize={(width) => workspace.resizeSidebar(width)}
      oncommit={(width) => workspace.endSidebarResize(width)}
      onactivate={toggleIconOnly}
    />
  {/if}
</div>
