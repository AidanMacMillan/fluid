<script lang="ts">
  import { tick } from 'svelte'
  import Sidebar from './components/Sidebar.svelte'
  import ResizeHandle from './components/ResizeHandle.svelte'
  import { SIDEBAR_WIDTH, workspace } from './lib/workspace.svelte'
  import { extensions, provideWindowActions } from './lib/extensions.svelte'
  import { reorder } from './lib/reorder.svelte'
  import {
    SIDEBAR_OPEN_MS,
    SIDEBAR_CLOSE_MS,
    SIDEBAR_PANEL_BLEED,
    SIDEBAR_PANEL_INSET
  } from '../../shared/sidebar-panel'

  let open = $state(false)
  let density = $state(1)
  let generation = 0
  const right = $derived(workspace.sidebarPosition === 'right')

  extensions.start()
  provideWindowActions({
    openLink: (url) => void workspace.openLink(url),
    setViewState: (id, state) => workspace.setViewState(id, state),
    flushViewState: (id) => workspace.flushViewState(id)
  })

  $effect(() =>
    window.api.sidebar.onPanelState(async (state) => {
      const current = ++generation
      const show = state.open
      Object.assign(workspace, {
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        tasks: state.tasks,
        tabs: state.tabs,
        folders: state.folders,
        activeTaskId: state.activeTaskId,
        pages: state.pages,
        downloads: state.downloads,
        sidebarWidth: state.sidebarWidth,
        sidebarPosition: state.sidebarPosition
      })
      density = state.density
      // Let the initial offscreen position paint before the first reveal.
      if (show && !open) {
        await tick()
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (generation === current) open = true
          })
        )
      } else open = show
    })
  )

  $effect(() => {
    const id = reorder.dimmed
    window.api.sidebar.reportPanel({
      kind: 'drag',
      item:
        id === null
          ? null
          : {
              kind: workspace.folders.some((folder) => folder.id === id) ? 'folder' : 'tab',
              id
            },
      section: reorder.kind === 'pinned-tab' ? 'pinned-tab' : 'tab'
    })
  })

  function resize(width: number, commit: boolean): void {
    workspace.sidebarWidth = width
    window.api.sidebar.reportPanel({ kind: 'resize', width, commit })
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') window.api.sidebar.reportPanel({ kind: 'close' })
  }}
/>

<div
  role="presentation"
  class="absolute inset-0"
  onmouseenter={() => window.api.sidebar.reportPanel({ kind: 'hover', inside: true })}
  onmouseleave={() => window.api.sidebar.reportPanel({ kind: 'hover', inside: false })}
>
  <div
    class="sidebar-panel absolute text-ink-100 text-on-glass"
    class:right
    class:open
    style:width="{workspace.sidebarWidth}px"
    style:--chrome-density={density}
    style:--panel-bleed="{SIDEBAR_PANEL_BLEED}px"
    style:--panel-inset="{SIDEBAR_PANEL_INSET}px"
    style:--panel-duration="{open ? SIDEBAR_OPEN_MS : SIDEBAR_CLOSE_MS}ms"
    inert={!open}
  >
    <div class="h-full overflow-hidden rounded-xl glass-popover"><Sidebar /></div>
    <ResizeHandle
      label="Resize sidebar"
      class="absolute inset-y-3 z-10 w-2 {right ? '-left-1' : '-right-1'}"
      factor={right ? -1 : 1}
      width={workspace.sidebarWidth}
      min={SIDEBAR_WIDTH.min}
      max={SIDEBAR_WIDTH.max}
      onresize={(width) => resize(width, false)}
      oncommit={(width) => resize(width, true)}
    />
  </div>
</div>

<style>
  .sidebar-panel {
    inset-block: var(--panel-inset);
    left: var(--panel-inset);
    border-radius: 0.75rem;
    box-shadow:
      0 3px 10px #0005,
      inset 0 0 0 1px #ffffff18;
    opacity: 0;
    transform: translateX(calc(-100% - var(--panel-bleed)));
    transition:
      transform var(--panel-duration) var(--ease-glide),
      opacity var(--panel-duration) var(--ease-glide);
  }
  .sidebar-panel.right {
    left: auto;
    right: var(--panel-inset);
    transform: translateX(calc(100% + var(--panel-bleed)));
  }
  .sidebar-panel.open {
    opacity: 1;
    transform: translateX(0);
  }
  @media (prefers-reduced-motion: reduce) {
    .sidebar-panel {
      transition: none;
    }
  }
</style>
