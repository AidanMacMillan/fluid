<script lang="ts">
  import type { Tab } from '../../../main/db/schema'
  import { profileById } from '../../../main/profiles'
  import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../lib/activity'
  import { PROFILE_SWATCH } from '../lib/profile-colors'
  import { reorder, type SidebarSection } from '../lib/reorder.svelte'
  import { extensions } from '../lib/extensions.svelte'
  import { SIDEBAR_INDENT_REM, type SidebarRow } from '../lib/sidebar-rows'
  import { tabGlyph } from '../lib/tab-glyph'
  import { workspace } from '../lib/workspace.svelte'
  import IconButton from './IconButton.svelte'

  type Props = {
    /**
     * The tab, and where it sits: which section, which folder, and how deep —
     * which is what a drop against the row is resolved against. The section is
     * where a drag from it starts rather than where it must end: a drag that
     * ends in the other one pins the tab or unpins it (see `SECTIONS`).
     */
    row: Extract<SidebarRow, { kind: 'tab' }>
    /** Only the last row draws the line for the slot past the end of the section. */
    last: boolean
  }

  const { row, last }: Props = $props()
  const tab: Tab = $derived(row.tab)
  const section = $derived(row.slot.section)

  /**
   * Which of the sidebar's sections a row may be dragged into: both of them,
   * whatever kind of tab it is. Dropping one across the divider is what pins
   * and unpins it, and what pinning means — this is one of the things the task
   * is about — is as true of a shell or a checkout as of a page.
   *
   * A constant, and kept anyway rather than folded into the drag: what a drag
   * may do belongs to the row that starts it, and the two sections are not
   * interchangeable for the task strip next door.
   */
  const SECTIONS: SidebarSection[] = ['pinned-tab', 'tab']

  const selected = $derived(workspace.activeTabId === tab.id)

  /**
   * The split this tab is in, if any. Its row stays where it is — a split is a
   * way of looking at tabs together, not a folder they go into — and is only
   * set apart by how it is lit (see `alongside` and `grouped`).
   */
  const split = $derived(workspace.splitOfTab[tab.id] ?? null)
  /** On screen beside the selected tab, as another pane of the split in front. */
  const alongside = $derived(!selected && split !== null && workspace.activeSplit?.id === split.id)
  /**
   * Lit with the rest of its split while the pointer is over one of them,
   * which is how a row shows it is in a split at all when that split is not
   * the one on screen, and how two splits in one task are told apart.
   */
  const grouped = $derived(split !== null && workspace.hoveredSplitId === split.id)
  const label = $derived(workspace.labelFor(tab))
  const loading = $derived(workspace.pages[tab.id]?.loading ?? false)
  /** Dimmed while it is being carried, on its own or in a folder that is. */
  const dragging = $derived(reorder.carries(tab.id, row.within))
  /** The line a drop would be let go along, when it is this row's to draw. */
  const line = $derived(reorder.lineOn(tab.id))

  /**
   * Which side of the row a drop lands on: above it, or below it, among the
   * same folder's tabs — the row's midpoint decides, the way it always has.
   */
  function onDragOver(event: DragEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const below = event.clientY > box.top + box.height / 2
    reorder.aim(
      event,
      below ? { ...row.slot, index: row.slot.index + 1 } : row.slot,
      { kind: 'line', rowId: tab.id, edge: below ? 'bottom' : 'top', depth: row.depth },
      row.within
    )
  }

  /**
   * The dot the row wears for work in its tab (see `TabActivity`). A selected
   * tab's `done` is not drawn: the window clears it the moment it arrives, and
   * the round trip would otherwise put a blue dot on screen for a frame.
   */
  const activity = $derived(selected && tab.activity === 'done' ? null : tab.activity)

  /** The download filling this tab, while one is. */
  const download = $derived(workspace.downloadsByTab[tab.id] ?? null)
  /** How much of it has arrived, or null when the server never named a length. */
  const fraction = $derived(
    download && download.totalBytes > 0
      ? Math.min(1, download.receivedBytes / download.totalBytes)
      : null
  )

  /**
   * The icon that failed to decode, if any. Held as the source itself rather
   * than a flag so the next page's icon gets its own chance without needing to
   * be reset.
   */
  let broken = $state<string | null>(null)
  const picture = $derived(workspace.iconFor(tab))
  const icon = $derived(picture === broken ? null : picture)

  /**
   * A row with no icon asks what its site's is. Asked from the row rather than
   * when a task is selected, because a row appears in more ways than that —
   * restored on launch, moved in from another task, released back to the
   * address it is pinned to — and every one of them ends here. The ask is once
   * per site (see `requestSiteIcon`), so the rows sharing one cost one.
   */
  $effect(() => {
    if (!icon) workspace.requestSiteIcon(tab)
  })

  /**
   * The browsing profile this tab runs in, or null for the default one — which
   * is nearly every tab, and which wears no mark at all. Only a browser tab can
   * be in one; the others have no session to be in.
   */
  const profile = $derived(tab.type === 'browser' ? profileById(tab.profile) : null)

  /**
   * What hovering the row says. Nothing, for most tabs — the label is already
   * the whole truth. A browser tab in a profile needs the profile named, since
   * a colour says nothing on its own; a thread needs its opening message, since
   * the label is only ever the channel and a name.
   */
  const hoverTitle = $derived.by(() => {
    if (profile) return `${label} — ${profile.name}`
    // An extension says what its own tabs' rows should say on hover.
    const detail = extensions.tabView(tab.type)?.tooltip?.(tab)
    if (detail) return `${label}\n${detail}`
    return undefined
  })

  /**
   * The row's right-click menu. A browser tab's: duplicating it, floating it
   * in a window of its own (as Cmd+Shift+P does), and reopening it in another
   * profile or emptying the one it is in. Reopening rather than switching,
   * because a view's partition is fixed when it is created — see
   * `reopenInProfile`. An extension's tab gets whatever its type offers, and
   * those items run in the main process, so they never come back as a choice.
   * Every tab can also be moved to another of the project's tasks.
   *
   * The menu is native, popped by the main process: a tab's page is a view
   * composited above this window's own, so a menu drawn here would slide
   * underneath it (see src/main/tab-menu.ts).
   */
  async function openMenu(event: MouseEvent): Promise<void> {
    event.preventDefault()

    const choice = await window.api.browser.tabMenu({ tabId: tab.id })
    if (!choice) return

    if (choice.kind === 'duplicate') await workspace.duplicateTab(tab.id)
    else if (choice.kind === 'float') await workspace.floatTab(tab.id)
    else if (choice.kind === 'move') await workspace.moveTabToTask(tab.id, choice.taskId)
    else if (choice.kind === 'unsplit') await workspace.removeFromSplit(tab.id)
    // Beside the tab: in its folder if it is in one, at the top of its section
    // if it is not.
    else if (choice.kind === 'new-folder')
      await workspace.createFolder({ pinned: tab.pinned, parentId: tab.folderId })
    else if (choice.kind === 'reset') await workspace.resetProfile(choice.profile)
    else await workspace.reopenInProfile(tab.id, choice.profile)
  }
</script>

<!-- The row is the drop target and the box the drop lines are positioned
     against. The list runs vertically, so the pointer's y decides the slot.
     Drawn in from the edge by one step for each folder it is in; the lines
     start at the depth the drop would land at, which is how a drop into a
     folder's last slot reads apart from one just after the folder. -->
<li
  class="group/row relative {dragging ? 'opacity-40' : ''}"
  style:padding-left="{row.depth * SIDEBAR_INDENT_REM}rem"
  ondragover={onDragOver}
  onpointerenter={() => {
    if (split) workspace.hoveredSplitId = split.id
  }}
  onpointerleave={() => {
    if (split && workspace.hoveredSplitId === split.id) workspace.hoveredSplitId = null
  }}
>
  {#if line?.edge === 'top'}
    <span
      class="pointer-events-none absolute -top-0.5 right-0 h-0.5 drop-line"
      style:left="{line.depth * SIDEBAR_INDENT_REM}rem"
    ></span>
  {/if}

  <button
    type="button"
    aria-current={selected ? 'page' : undefined}
    draggable="true"
    title={hoverTitle}
    ondragstart={(event) =>
      reorder.startInSidebar(event, section, { kind: 'tab', id: tab.id }, row.slot, SECTIONS)}
    ondragend={() => reorder.end()}
    onclick={() => void workspace.selectTab(tab.id)}
    oncontextmenu={(event) => void openMenu(event)}
    class="relative flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg glass-control
           py-1 pr-7 pl-2 text-xs
           {selected
      ? 'text-ink-50'
      : alongside
        ? 'text-ink-200'
        : 'text-ink-400 hover:text-ink-200'}"
    class:split-alongside={alongside}
    class:split-grouped={grouped && !selected}
  >
    {#if profile}
      <!-- The whole of what says which login this tab is: a bar down its
           leading edge, in the profile's colour. On the edge rather than on the
           icon, because the icon slot is not always the tab's own — it gives
           way to a spinner while a page loads and to an arrow while a download
           fills the row, which is exactly when a mark attached to it would
           vanish.

           Taken out of the flow and sat in the row's own left padding, so it
           costs the row no width: every icon down the sidebar lines up on the
           same column whether its tab is in a profile or not. A marker that
           moved the icon would make the rows with one read as indented.
           `aria-hidden`: the name below carries it in words, where a colour
           says nothing. -->
      <span
        class="absolute inset-y-1.5 left-0.5 w-0.5 rounded-full {PROFILE_SWATCH[profile.color]}"
        aria-hidden="true"
      ></span>
      <span class="sr-only">{profile.name}</span>
    {/if}
    <!-- The leading glyph doubles as the progress indicator: an arrow while a
         download fills the tab, a spinner while a page fetches. Both replace the
         tab's own icon rather than sitting beside it, so the row never grows. -->
    {#if download}
      <span class="icon-[ph--arrow-circle-down] shrink-0 text-base" aria-hidden="true"></span>
    {:else if loading}
      <span class="icon-[ph--circle-notch] shrink-0 animate-spin text-base" aria-hidden="true"
      ></span>
    {:else if icon}
      <!-- Decorative: the label beside it already names the tab. Not draggable,
           or dragging the icon would start an image drag instead of the row's
           own reorder drag. A file's preview is cropped to the square rather
           than fitted into it — a thumbnail this small reads as a smudge of the
           picture either way, and cropping at least fills the slot the site
           icons beside it fill. -->
      <img
        src={icon}
        alt=""
        draggable="false"
        onerror={() => (broken = icon)}
        class="size-4 shrink-0 {tab.type === 'file' ? 'rounded-xs object-cover' : 'object-contain'}"
      />
    {:else}
      <span class="{tabGlyph(tab)} shrink-0 text-base" aria-hidden="true"></span>
    {/if}
    <span class="truncate">{label}</span>
    {#if split}
      <!-- Nothing drawn: a row in a split says so by being lit alongside the
           selected one, or with the rest of its split on hover. Only a screen
           reader, which sees neither, is told in words. -->
      <span class="sr-only">{alongside ? 'In the split on screen' : 'In a split'}</span>
    {/if}
    {#if activity}
      <span class="sr-only">{ACTIVITY_LABEL[activity]}</span>
    {/if}

    {#if download}
      <!-- Across the foot of the row, inside the corners the button clips to.
           `aria-hidden`: the label below carries the same news to a screen
           reader, where a bar that is only a shape says nothing. -->
      <span
        class="absolute inset-x-0 bottom-0 h-0.5 download-bar
               {fraction === null ? 'download-bar-sweep' : ''}"
        style={fraction === null ? undefined : `transform: scaleX(${fraction})`}
        aria-hidden="true"
      ></span>
      <span class="sr-only">
        {download.paused
          ? 'Download paused'
          : fraction === null
            ? 'Downloading'
            : `Downloading, ${Math.round(fraction * 100)}%`}
      </span>
    {/if}
  </button>

  <!-- What closing means depends on where a pinned tab has got to. On its own
       page there is nothing to undo, so the cross does what a cross does and
       the row goes. Wandered off, the page is the thing worth being rid of and
       the pin is not — so the mark changes to say a smaller thing is about to
       happen, and the row stays, back on the address it is pinned to. -->
  {#if tab.pinnedUrl !== null && !workspace.onPinnedPage(tab)}
    <IconButton
      icon="icon-[ph--minus]"
      label="Close {label}, keeping it pinned"
      size="sm"
      class="peer/close absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0
             group-hover/row:opacity-100 focus-visible:opacity-100"
      onclick={() => void workspace.releasePinnedTab(tab.id)}
    />
  {:else}
    <IconButton
      icon="icon-[ph--x]"
      label="Close {label}"
      size="sm"
      class="peer/close absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0
             group-hover/row:opacity-100 focus-visible:opacity-100"
      onclick={() => void workspace.closeTab(tab.id)}
    />
  {/if}

  <!-- In the close button's slot, after it so that it can give way to it: the
       button only shows on hover or keyboard focus, and then has the slot. -->
  {#if activity}
    <span
      class="pointer-events-none absolute top-1/2 right-3 size-2 -translate-y-1/2 rounded-full
             group-hover/row:opacity-0 peer-focus-visible/close:opacity-0
             {ACTIVITY_DOT[activity]}"
      aria-hidden="true"
    ></span>
  {/if}

  {#if line?.edge === 'bottom'}
    <span
      class="pointer-events-none absolute right-0 -bottom-0.5 h-0.5 drop-line"
      style:left="{line.depth * SIDEBAR_INDENT_REM}rem"
    ></span>
  {:else if last && reorder.landsAtEnd(section)}
    <span class="pointer-events-none absolute inset-x-0 -bottom-0.5 h-0.5 drop-line"></span>
  {/if}
</li>
