<script lang="ts">
  import { taskIcon } from '@fluid/sdk'
  import { filesFrom, hasLeft, isFileDrag } from '../lib/file-drop'
  import { reorder, type SidebarSection } from '../lib/reorder.svelte'
  import { moveInSidebar, sidebarRows } from '../lib/sidebar-rows'
  import { NEW_TASK_TITLE, workspace } from '../lib/workspace.svelte'
  import { extensions } from '../lib/extensions.svelte'
  import { TASK_COLOR_TEXT } from '../lib/task-colors'
  import { taskActions } from '../lib/task-actions.svelte'
  import SidebarFolder from './SidebarFolder.svelte'
  import SidebarTab from './SidebarTab.svelte'
  import TaskFacts from './TaskFacts.svelte'

  /** Whether a file dragged in from outside is currently over the list. */
  let receiving = $state(false)

  /**
   * What sits at the top of each section — tabs and folders, a folder counting
   * once whatever it holds — and the rows each is drawn as, open folders'
   * contents following them.
   */
  const pinned = $derived(workspace.sidebar.pinned)
  const loose = $derived(workspace.sidebar.loose)
  const pinnedRows = $derived(sidebarRows(pinned, 'pinned-tab', workspace.onScreenTabIds))
  const looseRows = $derived(sidebarRows(loose, 'tab', workspace.onScreenTabIds))
  /** Null for the ordinary case of a task that is only ever itself. */
  const type = $derived(extensions.taskType(workspace.activeTask?.type ?? null) ?? null)
  /** The task's own glyph, which a typed task's heading wears beside its type. */
  const activeIcon = $derived(taskIcon(workspace.activeTask?.icon))
  const activeIconColor = $derived(TASK_COLOR_TEXT[workspace.activeTask?.color ?? 'grey'])

  /**
   * What is known about this task's work, for the panel above the pinned tabs.
   * Empty for every task the user opened themselves — see `TaskFact`.
   */
  const facts = $derived(workspace.activeTask?.facts ?? [])

  /**
   * The buttons the task's type offers, for the same panel. Asked for each time
   * a typed task comes to the front, since what they offer depends on the world
   * outside the app — a branch somebody else merged in the meantime should not
   * still be offering to merge. A task the user opened has no type, and nobody
   * to offer it anything.
   *
   * Asked again when the type itself turns up, too. At launch the window draws
   * the task it left in front before the extensions have finished activating,
   * and asked then, the main process has no type to ask and answers with no
   * buttons — an answer nothing would otherwise revisit until the user moved
   * away from the task and back.
   */
  const activeTaskId = $derived(workspace.activeTask?.id ?? null)
  const activeTaskTyped = $derived(workspace.activeTask?.type != null)
  const activeTypeRegistered = $derived(type !== null)
  $effect(() => {
    if (activeTaskId !== null && activeTaskTyped && activeTypeRegistered) {
      void taskActions.load(activeTaskId)
    }
  })
  const actions = $derived(activeTaskTyped ? taskActions.for(activeTaskId) : null)

  /**
   * Whether the seam below the pinned section is standing in for that section.
   * Most tasks the user opens themselves have nothing pinned, and a section
   * with no rows has nothing to aim a drop at — so when it is empty the seam is
   * the section, and a tab let go there is pinned.
   *
   * The seam is in the layout either way, drawn or not. Nothing about a drag
   * may change the size of anything in this column: a list that grew a row when
   * a drag began would shift every row under the pointer, and the platform
   * abandons a drag whose source is disturbed while the gesture is still being
   * set up — which is to say the tabs that could be pinned would be the ones
   * that could no longer be dragged.
   */
  const seamIsSection = $derived(pinned.length === 0)
  /** Whether a drag that could be pinned is in flight, for the seam to say so. */
  const offering = $derived(reorder.canDropIn('pinned-tab'))
  /** Whether letting go now would land in the pinned section. */
  const aiming = $derived(reorder.target === 'pinned-tab' && reorder.moves)

  /**
   * A file dragged in from outside is about the sidebar as a whole rather than
   * either section — it becomes a tab, and a file tab cannot be pinned — so the
   * column answers it and the two lists never see it. The app's own drags are
   * reorders, which the lists answer for themselves; what is left for the
   * column is the ground between them.
   */
  function onDragOver(event: DragEvent): void {
    if (isFileDrag(event)) {
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      receiving = true
      return
    }
    // The column claims what its two lists do not: the seam between them, and
    // the panel above them. Both are ground a drag from one section to the
    // other passes over, and ground nothing claims is ground a drop is refused
    // on (see `overGap`).
    reorder.overGap(event, ['pinned-tab', 'tab'])
  }

  /**
   * Cleared when the pointer leaves the column rather than when it leaves one
   * of the two lists: crossing the divider leaves a list every time, and a drop
   * line that blinked out there would flicker exactly where a drag between the
   * sections has to pass.
   */
  function onDragLeave(event: DragEvent): void {
    if (hasLeft(event, event.currentTarget)) receiving = false
    reorder.leave(event)
  }

  function onDrop(event: DragEvent): void {
    if (isFileDrag(event)) {
      event.preventDefault()
      receiving = false
      void workspace.createFileTabs(filesFrom(event))
      return
    }
    // A drop on the seam, or anywhere else in the column that is not a list.
    // A list claims its own drops and this never sees them; what the pointer
    // was last over is where the line was drawn, and so where this lands.
    if (event.defaultPrevented || !reorder.target) return
    onReorderDrop(event, reorder.target as SidebarSection)
  }

  /**
   * Commits a drag that ended in one of the two sections.
   *
   * The two sections are one tree, so the drop is the tree with the row taken
   * out of where it was and put in the slot it was let go over — which may be
   * in the other section, and that is what pins it or unpins it, along with
   * everything inside it if it is a folder. The whole sidebar is written in one
   * go (see `arrangeSidebar`), since a folder crossing the divider is every row
   * inside it crossing too.
   */
  function onReorderDrop(event: DragEvent, section: SidebarSection): void {
    const move = reorder.resolveInSidebar(event, section)
    if (!move) return
    const items = moveInSidebar(workspace.sidebar, move.item, move.slot)
    if (items) void workspace.arrangeSidebar(items)
  }

  /** The New tab row inserts before every loose tab or folder. */
  function onNewTabDragOver(event: DragEvent): void {
    const first = looseRows[0]
    reorder.aim(
      event,
      { section: 'tab', parentId: null, index: 0 },
      first
        ? { kind: 'line', rowId: first.id, edge: 'top', depth: 0 }
        : { kind: 'end', section: 'tab' },
      []
    )
  }

  /**
   * The right-click menu on a section's ground — anywhere in it that is not a
   * row, which has a menu of its own. The one thing it offers is a new folder,
   * at the end of the top of the section that was clicked in.
   */
  async function openSectionMenu(event: MouseEvent, pinnedSection: boolean): Promise<void> {
    if (event.defaultPrevented) return
    event.preventDefault()
    const choice = await window.api.browser.sectionMenu()
    if (choice?.kind === 'new-folder') {
      await workspace.createFolder({ pinned: pinnedSection, parentId: null })
    }
  }
</script>

<!-- No background of its own: the sidebar is a column of controls floating on
     the window's glass, separated from the content well by space alone. It
     fills whatever the dock gives it — the width is the dock's to animate. -->
<nav
  aria-label="Tabs in this task"
  class="flex h-full w-full flex-col gap-1 py-2 pr-1 pl-2 select-none"
>
  <!-- The head of the sidebar: what kind of work this is, and then which work.
       The type is named in words rather than left to its glyph because it is
       the question a task is opened with — am I reading a diff, going and using
       this on preprod, or putting my name to a master pull request — and the
       three are worth very different amounts of the next ten minutes.

       An untyped task draws the name alone, which keeps this row the height of
       the chrome bar next door and the first tab level with the top of the page
       beside it. A typed task spends a second line on the type, and a name long
       enough to wrap spends more again: knowing what is being asked, and the
       whole of what it is about, are each worth more here than that alignment.
       -->
  <!-- Above the pinned tabs, so a right-click on it is a right-click in the
       pinned section: the one way to make a pinned folder in a task that has
       nothing pinned yet, where the section itself is only a seam. -->
  <div
    class="flex flex-col gap-0.5 pt-1.5 pr-2 pb-1 pl-2"
    role="presentation"
    oncontextmenu={(event) => void openSectionMenu(event, true)}
  >
    {#if type}
      <!-- Brighter than the name below it: the name answers which piece of work
           this is, and this answers what the work is, which is what decides
           whether any of it is happening now.

           The glyph is the task's own icon, in its own colour — the one its tab
           wears (see TaskTab) — and decorative here: the words beside it are the
           label, and a screen reader that read both would say it twice. -->
      <div class="flex items-center gap-1 text-[0.6875rem] leading-4 font-semibold text-ink-300">
        <span class="{activeIcon.className} shrink-0 text-xs {activeIconColor}" aria-hidden="true"
        ></span>
        <span class="truncate">{type.label}</span>
      </div>
    {/if}
    <!-- Wrapped rather than truncated, over as many lines as the name takes.
         `wrap-anywhere` because a task named after a Shortcut story can carry
         an unbroken run of slug or URL, which would otherwise reach past the
         sidebar's edge with nowhere to break.

         An untyped task wears its glyph here instead, since there is no type
         line above for it to sit on — held to the first line of a name that
         wraps, the way a list bullet is, rather than centred on the block. -->
    <div class="flex items-start gap-1">
      {#if workspace.activeTask && !type}
        <span class="flex h-4 shrink-0 items-center" aria-hidden="true">
          <span class="{activeIcon.className} text-xs {activeIconColor}"></span>
        </span>
      {/if}
      <span class="min-w-0 text-[0.6875rem] leading-4 font-semibold wrap-anywhere text-ink-500"
        >{workspace.activeTask ? (workspace.activeTask.title ?? NEW_TASK_TITLE) : 'Tabs'}</span
      >
    </div>
  </div>

  <!-- Two lists, one column: the tabs the task is *for* above, and whatever was
       opened along the way below. They scroll together, because they are one
       sidebar rather than two panes — a task with a dozen loose tabs should push
       its pinned ones off the top the same way any other list scrolls. -->
  <div
    class="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain drop-zone"
    class:receiving
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <!-- Above the tabs because it is read before them: the panel says who is
         waiting and whose team they are on, and those are what decide whether
         to open any of this now. Inside the scroller with everything else,
         rather than pinned over the top of it — a sidebar is one column, and a
         task with a dozen loose tabs should be able to push all of this off the
         top the way any other list scrolls. -->
    {#if activeTaskId !== null && (facts.length > 0 || (actions?.actions.length ?? 0) > 0)}
      <TaskFacts
        {facts}
        actions={actions?.actions ?? []}
        running={actions?.running ?? null}
        error={actions?.error ?? null}
        onRun={(actionId) => void taskActions.run(activeTaskId, actionId)}
      />
    {/if}

    {#if pinned.length > 0}
      <!-- Sized to its contents: the pinned tabs are a fixed set, and the space
           left over belongs to the list that grows. -->
      <ul
        aria-label="Pinned tabs"
        class="flex shrink-0 flex-col gap-0.5"
        ondragover={(event) => reorder.overSectionEnd(event, 'pinned-tab', pinned.length)}
        ondrop={(event) => onReorderDrop(event, 'pinned-tab')}
        oncontextmenu={(event) => void openSectionMenu(event, true)}
      >
        {#each pinnedRows as row, index (row.id)}
          {#if row.kind === 'folder'}
            <SidebarFolder {row} last={index === pinnedRows.length - 1} />
          {:else}
            <SidebarTab {row} last={index === pinnedRows.length - 1} />
          {/if}
        {/each}
      </ul>
    {/if}

    <!-- The seam between the sections, and the whole of what marks them apart:
         a heading over each would say in two words what the line says by being
         there, in a column this narrow.

         Always in the layout, and only sometimes drawn. With tabs above it, it
         is the line that says where one section ends; with none, it is the
         empty section itself — unpainted while nothing is happening, so that a
         task with nothing pinned looks like a plain list, and painted the
         moment a tab that could be pinned is picked up. What it never does is
         change size, which is what keeps every row below it still while a drag
         goes on above it.

         A hairline is a one-pixel target, so while it stands in for the section
         it takes its drop from a band either side of itself (see `pin-seam`) —
         hit area only, again costing the layout nothing. -->
    <div
      class="pin-seam relative mx-2 my-1.5 h-px shrink-0"
      class:empty={seamIsSection}
      class:offering={seamIsSection && offering}
      class:aiming={seamIsSection && aiming}
      aria-hidden="true"
      ondragover={seamIsSection
        ? (event) => reorder.overSectionEnd(event, 'pinned-tab', 0)
        : undefined}
      ondrop={seamIsSection ? (event) => onReorderDrop(event, 'pinned-tab') : undefined}
      oncontextmenu={(event) => void openSectionMenu(event, true)}
    ></div>

    <!-- Runs to the bottom of the sidebar, so its drag handler covers the empty
         space below the last tab as well as leaving it. Each tab claims its own
         row first (see SidebarTab). -->
    <ul
      aria-label="Tabs"
      class="flex flex-1 flex-col gap-0.5"
      ondragover={(event) => reorder.overSectionEnd(event, 'tab', loose.length)}
      ondrop={(event) => onReorderDrop(event, 'tab')}
      oncontextmenu={(event) => void openSectionMenu(event, false)}
    >
      <!-- Head of the list, and fixed there: the tabs below it come and go, and
           a control that stays put is easier to reach for than one that follows
           the last row down. It belongs to this section rather than the header
           because what it adds is a loose tab: a new tab starts unpinned, and
           pinning is something done to it afterwards. A drop here goes before
           the section's first row, with the same line as that row's top edge.

           It opens the launcher rather than a tab, which is also what Cmd+T
           does: a new tab is a question about where to go, and this is the one
           place it gets asked. -->
      <li class="relative" ondragover={onNewTabDragOver}>
        <button
          type="button"
          onclick={() => window.api.launcher.open()}
          class="flex h-9 w-full items-center gap-2 rounded-lg glass-control py-1 pr-7 pl-2
                 text-xs text-ink-500 hover:text-ink-200"
        >
          <span class="icon-[ph--plus] shrink-0 text-base" aria-hidden="true"></span>
          <span class="truncate">New tab</span>
        </button>
        {#if looseRows.length === 0 && reorder.landsAtEnd('tab')}
          <span class="pointer-events-none absolute inset-x-0 -bottom-0.5 h-0.5 drop-line"></span>
        {/if}
      </li>

      {#each looseRows as row, index (row.id)}
        {#if row.kind === 'folder'}
          <SidebarFolder {row} last={index === looseRows.length - 1} />
        {:else}
          <SidebarTab {row} last={index === looseRows.length - 1} />
        {/if}
      {/each}

      {#if receiving && workspace.tabs.length === 0}
        <li class="px-2 py-1.5 text-xs text-ink-500">Drop to add a file tab.</li>
      {/if}
    </ul>
  </div>

  <!-- The foot of the sidebar, outside the scroller and so fixed there however
       long the tab list grows. It belongs at the bottom rather than up with the
       new-tab row because it is not about the task's tabs at all: it is about
       what the task *produced* along the way, which is the one thing here that
       reads backwards in time.

       Like the new-tab row it opens a panel rather than doing anything itself,
       and for the same reason — a panel is the only surface that can cover a
       browser tab's native view (see src/main/clipboard-window.ts). Cmd+Shift+V
       opens the same one.

       The glyphs carry these alone, and the name each would spell out is the
       first thing its own panel says. Squares the width of their own glyphs,
       centred in the column rather than stretched across it — nothing about the
       row below the tabs is a list row. -->
  <div class="flex shrink-0 items-center justify-center gap-1">
    <button
      type="button"
      onclick={() => window.api.clipboardWindow.open()}
      aria-label="Clipboard history"
      title="Clipboard history"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg glass-control
             text-ink-500 hover:text-ink-200"
    >
      <span class="icon-[ph--clipboard-text] text-base" aria-hidden="true"></span>
    </button>

    <!-- TODO: the task's own history, and the reason this sits here unwired
         rather than being left out until it works — what goes in it is a wider
         question than its name suggests, and the answer wants designing before
         anything is built.

         "Tab history" is the obvious reading: the tabs this task has held,
         including the ones closed along the way, so that a page shut an hour ago
         is a click away rather than a search. But the interesting version is the
         whole of what the task has been through, in one column read backwards in
         time — every address its browser tabs visited, not just the tabs
         themselves; the files dropped in and downloaded; the terminals opened
         and what directories they ended up in; what extensions pulled in; the
         notes agents left; and the events the task itself is made of, such as a
         routine opening it, a review being answered, or the task being settled.

         That is the thing worth having: a task is a frame around some work, and
         what nothing in the app can currently answer is "what did I actually do
         in here". The clipboard history beside this is the first slice of that
         same question — which is why the two belong together at the foot, and
         why this one is worth holding the space for.

         Open questions before it can be built: whether the underlying events are
         written as they happen (a table of their own, like the clipboard's) or
         reconstructed from what the tabs and routines already record, which is
         only enough for some of the above; whether closed tabs are restorable
         from it or only readable; and how far back it keeps, given a browser
         tab's history alone would dwarf the clipboard's two hundred rows.

         `disabled` rather than `inert`, dimmed the way IconButton dims its own
         dead ends: the button is announced, and announced as unavailable, which
         is the honest state — inert would drop it out of the accessibility tree
         and leave a square only sighted users know is there. -->
    <button
      type="button"
      disabled
      aria-label="Tab history (not yet available)"
      title="Tab history (not yet available)"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg glass-control
             text-ink-500 disabled:pointer-events-none disabled:text-ink-600"
    >
      <span class="icon-[ph--clock-counter-clockwise] text-base" aria-hidden="true"></span>
    </button>
  </div>
</nav>
