<script lang="ts">
  import { taskIcon } from '@fluid/sdk'
  import type { Task } from '../../../main/db/schema'
  import { ACTIVITY_DOT, ACTIVITY_LABEL } from '../lib/activity'
  import { reorder } from '../lib/reorder.svelte'
  import { TASK_COLOR_TEXT } from '../lib/task-colors'
  import { NEW_TASK_TITLE, workspace } from '../lib/workspace.svelte'
  import { extensions } from '../lib/extensions.svelte'
  import IconButton from './IconButton.svelte'

  type Props = {
    task: Task
    /** Position in the strip, which is what a drop is resolved against. */
    index: number
    /** Only the last tab draws the line for the slot past the end of the strip. */
    last: boolean
  }

  const { task, index, last }: Props = $props()

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
  class="group/tab relative min-w-24 shrink grow basis-0 {dragging ? 'opacity-40' : ''}"
  ondragover={(event) => {
    reorder.over(event, 'task', index, 'x')
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

  {#if reorder.lineAt('task', index)}
    <span class="pointer-events-none absolute inset-y-0.5 -left-[3px] w-0.5 drop-line"></span>
  {/if}

  {#if renaming}
    <input
      use:autoselect
      bind:value={draft}
      onblur={commit}
      onkeydown={onKeydown}
      class="h-7 w-full rounded-md bg-white/15 pr-2.5 pl-7 text-xs font-medium text-ink-50 ring-1 ring-white/20 outline-none no-drag"
    />
  {:else}
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      draggable="true"
      ondragstart={(event) => reorder.start(event, 'task', task.id, index)}
      ondragend={() => reorder.end()}
      onclick={() => void workspace.selectTask(task.id)}
      ondblclick={startRenaming}
      class="flex h-7 w-full items-center rounded-md glass-control py-1 pr-7 pl-7 text-xs
             font-medium no-drag
             {selected ? 'text-ink-50' : 'text-ink-400 hover:text-ink-200'}"
    >
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
    <!-- In the close button's slot, giving way to it, as a tab's row does. -->
    {#if activity}
      <span
        class="pointer-events-none absolute top-1/2 right-2.5 size-2 -translate-y-1/2 rounded-full
               group-hover/tab:opacity-0 peer-focus-visible/close:opacity-0 {ACTIVITY_DOT[
          activity
        ]}"
        aria-hidden="true"
      ></span>
    {/if}
  {/if}

  <!-- The task's icon, and the way to change it: a button of its own over the
       tab's leading edge, the way the close button sits over its trailing one,
       since a button cannot sit inside the tab's. Drawn while renaming too, so
       the name does not jump sideways as the field swaps in.

       Opens the picker as a panel over the window rather than a popover here,
       for the reason the launcher is one: nothing drawn in this document can
       cover a browser tab's native view, which is right below the strip. -->
  <button
    type="button"
    onclick={() => window.api.launcher.pickIcon(task.id)}
    aria-label="Change icon of {label}"
    title={type ? `${type.label} · Change icon` : 'Change icon'}
    class="absolute top-1/2 left-1 grid size-5 -translate-y-1/2 place-items-center rounded no-drag
           hover:bg-glow/10 focus-visible:bg-glow/10"
  >
    <span class="{icon.className} text-sm {iconColor}" aria-hidden="true"></span>
  </button>

  {#if last && reorder.lineAt('task', index + 1)}
    <span class="pointer-events-none absolute inset-y-0.5 -right-[3px] w-0.5 drop-line"></span>
  {/if}
</div>
