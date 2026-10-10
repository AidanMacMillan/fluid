<script lang="ts">
  import { taskIcon } from '@fluid/sdk'
  import type { Task } from '../../../main/db/schema'
  import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../lib/activity'
  import { reorder } from '../lib/reorder.svelte'
  import { TASK_COLOR_TEXT } from '../lib/task-colors'
  import { NEW_TASK_TITLE, workspace } from '../lib/workspace.svelte'
  import { extensions } from '../lib/extensions.svelte'
  import IconButton from './IconButton.svelte'

  /** Both lists of the strip, which a task may be let go in whichever it started in. */
  const STRIP = ['pinned-task', 'task'] as const

  type Props = {
    task: Task
    /** Position in the strip, which is what a drop is resolved against. */
    index: number
    /** Only the last tab draws the line for the slot past the end of the strip. */
    last: boolean
  }

  const { task, index, last }: Props = $props()

  /** Pinned tasks are a list of their own, which a task can still be dragged into or out of. */
  const kind = $derived(task.pinned ? 'pinned-task' : 'task')

  const selected = $derived(workspace.activeTaskId === task.id)
  const label = $derived(task.title ?? NEW_TASK_TITLE)
  const dragging = $derived(reorder.dimmed === task.id)
  /** A tab from the sidebar is over this task, and letting go would move it here. */
  const receiving = $derived(reorder.intoTask === task.id)
  /** The strongest of its tabs' activity dots, rolled up (see `activityByTask`). */
  const activity = $derived(workspace.activityByTask[task.id] ?? null)
  /** Null for the ordinary case of a task that is only ever itself. */
  const type = $derived(extensions.taskType(task.type) ?? null)
  const icon = $derived(taskIcon(task.icon))
  /**
   * The default grey is faded against the strip, but the selected tab's own
   * highlight is about as light as that grey is, so there it steps up a shade
   * rather than vanishing into the tab it is on.
   */
  const iconColor = $derived(
    task.color === 'grey' || !(task.color in TASK_COLOR_TEXT)
      ? selected
        ? 'text-ink-400'
        : TASK_COLOR_TEXT.grey
      : TASK_COLOR_TEXT[task.color]
  )

  let renaming = $state(false)
  let draft = $state('')

  function startRenaming(): void {
    draft = task.title ?? ''
    renaming = true
  }

  function commit(): void {
    if (!renaming) return
    renaming = false
    if (draft !== (task.title ?? '')) void workspace.renameTask(task.id, draft)
  }

  function onKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    // Enter commits through the blur handler, so there is one commit path
    // rather than two that can disagree.
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') renaming = false
  }

  /**
   * The task's own right-click menu, native for the reason the sidebar rows'
   * are: the strip is right above a browser tab's view (see src/main/tab-menu.ts).
   */
  async function openMenu(event: MouseEvent): Promise<void> {
    event.preventDefault()
    const choice = await window.api.browser.taskMenu({ taskId: task.id })
    if (!choice) return

    if (choice.kind === 'pin' || choice.kind === 'unpin') {
      await workspace.setTaskPinned(task.id, choice.kind === 'pin')
    } else if (choice.kind === 'rename') {
      startRenaming()
    } else if (choice.kind === 'change-icon') {
      // The picker works on the task it is given, viewed or not.
      window.api.launcher.pickIcon(task.id)
    } else {
      await workspace.closeTask(task.id)
    }
  }

  /**
   * A pinned tab is all icon, so its one click does both jobs: it selects a task
   * that is not being viewed, and changes the icon of the one that is. The
   * unpinned tab's icon is a button only once it is selected (see below).
   */
  async function onIconClick(): Promise<void> {
    if (selected) window.api.launcher.pickIcon(task.id)
    else await workspace.selectTask(task.id)
  }

  /**
   * A tab or folder dragged up from the sidebar, which lands at the foot of
   * this task's loose tabs with the window following it — the same move as the
   * row's Move to Task menu (see `moveTabToTask` and `moveFolderToTask`). Not
   * the selected task: the row is already in it.
   */
  function onTabOver(event: DragEvent): void {
    if (!selected) reorder.overTask(event, task.id)
  }

  function onTabDrop(event: DragEvent): void {
    const item = reorder.dropOnTask(event, task.id)
    if (item?.kind === 'tab') void workspace.moveTabToTask(item.id, task.id)
    else if (item?.kind === 'folder') void workspace.moveFolderToTask(item.id, task.id)
  }

  /** Focus and select the whole name the moment the field appears. */
  function autoselect(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

<!-- The wrapper, not the button, is the drop target: it survives the swap to
     the rename field, and it is the box the drop lines are positioned against.
     The strip runs horizontally, so the pointer's x decides the slot.

     Every tab splits the strip evenly rather than sizing to its own title, so
     the row reads as one set of tabs whatever they are called. The cap lives on
     the strip instead of here: a flex item that is allowed to shrink reports its
     text width, not its basis, as its intrinsic size, so a cap set on the tab
     would leave the strip collapsed to the titles and never be reached. -->
<div
  role="presentation"
  class="group/tab relative press-scale hover-through {task.pinned
    ? 'w-(--width-tab-pinned) shrink-0'
    : 'min-w-24 shrink grow basis-0'} {dragging ? 'opacity-40' : ''}"
  oncontextmenu={openMenu}
  ondragover={(event) => {
    reorder.over(event, kind, index, 'x')
    onTabOver(event)
  }}
  ondragleave={(event) => reorder.leaveTask(event, task.id)}
  ondrop={onTabDrop}
>
  <!-- Where a tab dragged from the sidebar would go: the whole task, since the
       drop is into it rather than between it and a neighbour. -->
  <span
    class="pointer-events-none absolute inset-0 drop-zone rounded-md"
    class:receiving
    aria-hidden="true"
  ></span>

  {#if reorder.lineAt(kind, index)}
    <span class="pointer-events-none absolute inset-y-0.5 -left-[3px] w-0.5 drop-line"></span>
  {/if}

  {#if task.pinned}
    <!-- Just the icon, with the name left to the tooltip. The tab is all icon,
         so the tab is the icon's button: the first click selects it and a click
         on the one being viewed changes the icon (see `onIconClick`), lit the
         way the unpinned tab's icon button is. No close
         button: a pinned task is one that should stay, so closing it is the
         menu's. -->
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={label}
      title={selected ? `${label} · Change icon` : label}
      draggable="true"
      ondragstart={(event) => reorder.start(event, kind, task.id, index, STRIP)}
      ondragend={() => reorder.end()}
      onclick={() => void onIconClick()}
      class="grid h-7 w-full place-items-center rounded-md glass-control no-drag
             {selected ? 'text-ink-50' : 'text-ink-400 hover:text-ink-200'}"
    >
      <span
        class="grid size-5 place-items-center rounded {selected ? 'hover:bg-glow/10' : ''}"
        aria-hidden="true"
      >
        <span class="{icon.className} text-sm {iconColor}"></span>
      </span>
      {#if activity}
        <span class="sr-only">{ACTIVITY_LABEL[activity]}</span>
      {/if}
    </button>
    {#if activity}
      <span
        class="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full {ACTIVITY_DOT[
          activity
        ]}"
        aria-hidden="true"
      ></span>
    {/if}
  {:else if renaming}
    <input
      use:autoselect
      bind:value={draft}
      onblur={commit}
      onkeydown={onKeydown}
      class="h-7 w-full rounded-md bg-white/15 pr-2.5 pl-7 text-xs font-medium text-ink-50 ring-1 ring-white/20 outline-none no-drag"
    />
    {#if !selected}
      <div class="pointer-events-none absolute inset-y-0 left-0">{@render glyph()}</div>
    {/if}
  {:else}
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      draggable="true"
      ondragstart={(event) => reorder.start(event, kind, task.id, index, STRIP)}
      ondragend={() => reorder.end()}
      onclick={() => void workspace.selectTask(task.id)}
      ondblclick={startRenaming}
      class="relative flex h-7 w-full items-center rounded-md glass-control py-1 pl-7 text-xs
             font-medium no-drag {activity ? 'pr-7 group-hover/tab:pr-10' : 'pr-7'}
             {selected ? 'text-ink-50' : 'text-ink-400 hover:text-ink-200'}"
    >
      {#if !selected}
        {@render glyph()}
      {/if}
      <span class="truncate text-left">{label}</span>
      {#if activity}
        <span class="sr-only">{ACTIVITY_LABEL[activity]}</span>
      {/if}
    </button>
    <IconButton
      icon="icon-[ph--x]"
      label="Close {label}"
      size="sm"
      class="peer/close absolute top-1/2 right-1 -translate-y-1/2 opacity-0
             group-hover/tab:opacity-100 focus-visible:opacity-100"
      onclick={() => void workspace.closeTask(task.id)}
    />
    <!-- In the close button's slot until the button appears, then stepped
         aside to its left, as a tab's row does. -->
    {#if activity}
      <span
        class="pointer-events-none absolute top-1/2 right-2.5 size-2 -translate-y-1/2 rounded-full
               group-hover/tab:right-7 peer-focus-visible/close:right-7 {ACTIVITY_DOT[activity]}"
        aria-hidden="true"
      ></span>
    {/if}
  {/if}

  <!-- The task's icon, as the button that changes it: over the tab's leading
       edge, since a button cannot sit inside the tab's. Only on the task being
       viewed, where it opens the picker. On any other the icon is part of the
       tab's own button (see `glyph`), so hovering and clicking it are hovering
       and clicking the tab: lit as a whole, and selecting it. That is the one
       rule for the icon, and the pinned tab follows it with the whole tab as the
       button.

       The picker is a panel over the window rather than a popover here, for the
       reason the launcher is one: nothing drawn in this document can cover a
       browser tab's native view, which is right below the strip. -->
  {#if !task.pinned && selected}
    <button
      type="button"
      onclick={() => window.api.launcher.pickIcon(task.id)}
      aria-label="Change icon of {label}"
      title={type ? `${type.label} · Change icon` : 'Change icon'}
      class="absolute top-1/2 left-1 grid size-5 -translate-y-1/2 place-items-center rounded
             no-drag hover:bg-glow/10 focus-visible:bg-glow/10"
    >
      <span class="{icon.className} text-sm {iconColor}" aria-hidden="true"></span>
    </button>
  {/if}

  {#if last && reorder.lineAt(kind, index + 1)}
    <span class="pointer-events-none absolute inset-y-0.5 -right-[3px] w-0.5 drop-line"></span>
  {/if}
</div>

<!-- The icon as a bare glyph, in the place the icon button takes on the selected
     task. Drawn inside whatever is under it, so that is what the pointer is on. -->
{#snippet glyph()}
  <span
    class="absolute top-1/2 left-1 grid size-5 -translate-y-1/2 place-items-center"
    aria-hidden="true"
  >
    <span class="{icon.className} text-sm {iconColor}"></span>
  </span>
{/snippet}
