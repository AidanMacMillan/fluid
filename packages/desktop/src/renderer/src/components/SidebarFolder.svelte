<script lang="ts">
  import type { TabActivity } from '@fluid/sdk'
  import { ACTIVITY_DOT, ACTIVITY_LABEL, strongerActivity } from '../lib/activity'
  import { reorder, type SidebarSection } from '../lib/reorder.svelte'
  import { SIDEBAR_INDENT_REM, type SidebarRow } from '../lib/sidebar-rows'
  import { workspace } from '../lib/workspace.svelte'

  type Props = {
    /** The folder, and where it sits, on the terms a tab's row has them. */
    row: Extract<SidebarRow, { kind: 'folder' }>
    /** Only the last row draws the line for the slot past the end of the section. */
    last: boolean
  }

  const { row, last }: Props = $props()
  const folder = $derived(row.folder)
  const section = $derived(row.slot.section)

  /** Either section, as for a tab: dropping a folder across the divider pins what it holds. */
  const SECTIONS: SidebarSection[] = ['pinned-tab', 'tab']

  const dragging = $derived(reorder.carries(folder.id, row.within))
  const line = $derived(reorder.lineOn(folder.id))
  /** A drop would land inside it, which lights the whole row. */
  const receiving = $derived(reorder.landsIn(folder.id))

  /**
   * Whether a tab on screen is somewhere inside — the one in front, or another
   * pane of its split. A closed folder says so by how its name is lit, over
   * the rows it still shows (see `peek`).
   */
  const holdsActive = $derived(row.tabs.some((tab) => workspace.onScreenTabIds.has(tab.id)))

  /**
   * The strongest dot among the tabs inside, while it is closed and they are
   * out of sight — a shell finishing inside a folder nobody has open is
   * exactly the news a dot is for. An open folder leaves it to the rows.
   */
  const activity = $derived.by(() => {
    if (row.open) return null
    let strongest: TabActivity | undefined
    for (const tab of row.tabs) {
      if (!tab.activity) continue
      if (tab.activity === 'done' && tab.id === workspace.activeTabId) continue
      strongest = strongerActivity(strongest, tab.activity)
    }
    return strongest ?? null
  })

  let renaming = $state(false)
  let draft = $state('')

  /**
   * Opens the name for editing. Only ever from the row's menu, or for a folder
   * just made: a click on the row is what opens and closes it, and a
   * double-click that also renamed would do both at once.
   */
  function startRenaming(): void {
    draft = folder.name
    renaming = true
  }

  // A folder just made opens its name for editing as soon as it is drawn.
  $effect(() => {
    if (workspace.renamingFolderId !== folder.id) return
    workspace.renamingFolderId = null
    startRenaming()
  })

  function commit(): void {
    if (!renaming) return
    renaming = false
    void workspace.renameFolder(folder.id, draft)
  }

  function onKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    // Enter commits through the blur handler, as a task's name does.
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') renaming = false
  }

  /**
   * Focus and select the whole name the moment the field appears — a turn
   * later, since the binding writes the name in after the field is mounted,
   * and writing a value puts the caret at its end.
   */
  function autoselect(node: HTMLInputElement): void {
    node.focus()
    queueMicrotask(() => node.select())
  }

  /**
   * A folder row has three places on it rather than a tab row's two: its top
   * edge is before it, its bottom edge after it — or, while it is open with
   * something in it, the first slot inside — and the middle is into it, at the
   * end of whatever it holds.
   */
  function onDragOver(event: DragEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const at = (event.clientY - box.top) / box.height
    const inside = [...row.within, folder.id]

    if (at < 0.25) {
      reorder.aim(
        event,
        row.slot,
        { kind: 'line', rowId: folder.id, edge: 'top', depth: row.depth },
        row.within
      )
    } else if (at > 0.75 && row.open && row.size > 0) {
      reorder.aim(
        event,
        { section, parentId: folder.id, index: 0 },
        { kind: 'line', rowId: folder.id, edge: 'bottom', depth: row.depth + 1 },
        inside
      )
    } else if (at > 0.75) {
      reorder.aim(
        event,
        { ...row.slot, index: row.slot.index + 1 },
        { kind: 'line', rowId: folder.id, edge: 'bottom', depth: row.depth },
        row.within
      )
    } else {
      reorder.aim(
        event,
        { section, parentId: folder.id, index: row.size },
        { kind: 'into', folderId: folder.id },
        inside
      )
    }
  }

  /** The row's right-click menu, native for the reason a tab's is (see src/main/tab-menu.ts). */
  async function openMenu(event: MouseEvent): Promise<void> {
    event.preventDefault()
    const choice = await window.api.browser.folderMenu({ folderId: folder.id })
    if (!choice) return

    if (choice.kind === 'new-folder') {
      await workspace.createFolder({ pinned: folder.pinned, parentId: folder.id })
    } else if (choice.kind === 'rename') startRenaming()
    else if (choice.kind === 'move') await workspace.moveFolderToTask(folder.id, choice.taskId)
    else await workspace.deleteFolder(folder.id)
  }
</script>

<!-- Drawn like a tab's row, at the same height and on the same column, so a
     folder reads as one more thing in the list rather than a heading over it:
     it can be dragged, dropped on, and dropped into, the way a tab can be
     dropped next to. -->
<li
  class="group/row relative {dragging ? 'opacity-40' : ''}"
  style:padding-left="{row.depth * SIDEBAR_INDENT_REM}rem"
  ondragover={onDragOver}
>
  {#if line?.edge === 'top'}
    <span
      class="pointer-events-none absolute -top-0.5 right-0 h-0.5 drop-line"
      style:left="{line.depth * SIDEBAR_INDENT_REM}rem"
    ></span>
  {/if}

  <span
    class="pointer-events-none absolute inset-y-0 right-0 drop-zone rounded-lg"
    style:left="{row.depth * SIDEBAR_INDENT_REM}rem"
    class:receiving
    aria-hidden="true"
  ></span>

  {#if renaming}
    <!-- In the button's place rather than inside it, which a field cannot be.
         The glyph stays where it was, so the name does not jump sideways. -->
    <div
      class="flex h-9 w-full items-center gap-2 rounded-lg bg-white/10 py-1 pr-2 pl-2"
      role="presentation"
      oncontextmenu={(event) => event.stopPropagation()}
    >
      <span class="icon-[ph--folder-open] shrink-0 text-base text-ink-400" aria-hidden="true"
      ></span>
      <input
        use:autoselect
        bind:value={draft}
        onblur={commit}
        onkeydown={onKeydown}
        aria-label="Folder name"
        class="h-6 min-w-0 flex-1 rounded bg-white/10 px-1.5 text-xs text-ink-50 ring-1
               ring-white/20 outline-none"
      />
    </div>
  {:else}
    <button
      type="button"
      draggable="true"
      aria-expanded={row.open}
      ondragstart={(event) =>
        reorder.startInSidebar(
          event,
          section,
          { kind: 'folder', id: folder.id },
          row.slot,
          SECTIONS
        )}
      ondragend={() => reorder.end()}
      onclick={() => void workspace.setFolderCollapsed(folder.id, row.open)}
      oncontextmenu={(event) => void openMenu(event)}
      class="relative flex h-9 w-full items-center gap-2 rounded-lg glass-control py-1 pr-7 pl-2
             text-xs
             {holdsActive && !row.open ? 'text-ink-200' : 'text-ink-400 hover:text-ink-200'}"
    >
      <span
        class="{row.open ? 'icon-[ph--folder-open]' : 'icon-[ph--folder]'} shrink-0 text-base"
        aria-hidden="true"
      ></span>
      <span class="truncate">{folder.name}</span>
      {#if activity}
        <span class="sr-only">{ACTIVITY_LABEL[activity]}</span>
      {/if}
    </button>

    <!-- Which way it is folded, in the slot a tab's close button has. Only a
         mark — the whole row is what opens and closes it — and it gives way to
         the dot of whatever is working inside, the way a close button gives
         way to a tab's, until the pointer comes to the row. -->
    <span
      class="pointer-events-none absolute top-1/2 right-2.5 icon-[ph--caret-right] -translate-y-1/2
             text-xs text-ink-500 transition-transform
             {row.open ? 'rotate-90' : ''}
             {activity ? 'opacity-0 group-hover/row:opacity-100' : ''}"
      aria-hidden="true"
    ></span>
    {#if activity}
      <span
        class="pointer-events-none absolute top-1/2 right-3 size-2 -translate-y-1/2 rounded-full
               group-hover/row:opacity-0 {ACTIVITY_DOT[activity]}"
        aria-hidden="true"
      ></span>
    {/if}
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
