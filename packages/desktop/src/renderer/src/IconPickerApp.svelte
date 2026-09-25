<script lang="ts">
  import {
    TASK_COLORS,
    TASK_ICONS,
    taskIcon,
    type Task,
    type TaskColor,
    type TaskIcon
  } from '@fluid/sdk'
  import { fluid } from './lib/api'
  import { matchesQuery } from './lib/search'
  import { TASK_COLOR_LABEL, TASK_COLOR_SWATCH, TASK_COLOR_TEXT } from './lib/task-colors'

  /**
   * The panel that changes what a task wears: which icon, from the curated set
   * (see task-icons.ts in the SDK), and in which colour.
   *
   * The launcher's window asking a different question (see `LauncherMode`), and
   * built to feel like the launcher — the same field, the same way the arrow keys
   * and Enter work, the same "look away to dismiss" — but over a grid of glyphs
   * rather than a list of rows, since an icon is recognised rather than read.
   *
   * Below a line that is always there, whatever the field filters, the colours.
   * Taking one writes it at once and leaves the panel open, since the colour is
   * something you look at alongside the icon rather than a choice that ends the
   * question; taking an icon writes it and closes the panel.
   *
   * Unlike the launcher it writes what it settles on itself, through the API,
   * rather than handing a choice back to the window it opened over. The task is
   * named in the query, so there is nothing about the window's state it needs,
   * and the tab hears the change as the `task.updated` every other write makes.
   */

  const api = window.api.launcher

  document.title = 'Task icon'

  const taskId = new URLSearchParams(location.search).get('task') ?? ''

  /** How many glyphs to a row. The arrow keys move by this much up and down. */
  const COLUMNS = 10

  let task = $state<Task | null>(null)

  /**
   * The colour as the panel has it, which runs ahead of the task's while a write
   * is on its way: the swatch and the grid answer the click at once.
   */
  let color = $state<TaskColor | null>(null)
  const shownColor = $derived<TaskColor>(color ?? task?.color ?? 'grey')

  $effect(() =>
    fluid.watch('tasks.get', { id: taskId }, (found) => {
      // Gone while the panel was open — deleted, or settled from somewhere
      // else. There is nothing left to choose for.
      if (!found || found.status !== 'open') {
        api.close()
        return
      }
      const first = task === null
      task = found
      if (color === found.color) color = null
      // Opened on the icon the task already wears, so Enter straight away is
      // "keep it" and the arrow keys start from where it is.
      if (first && query === '') {
        selected = Math.max(
          0,
          TASK_ICONS.findIndex((icon) => icon.id === taskIcon(found.icon).id)
        )
      }
    })
  )

  let query = $state('')

  /** The glyph Enter would take, as an index into `icons`. */
  let selected = $state(0)

  const icons = $derived(
    TASK_ICONS.filter((icon) => matchesQuery(query, [icon.label, icon.id, ...icon.keywords]))
  )

  /** What the highlighted glyph is called, for the dimmer half of the field's row. */
  const selectedLabel = $derived(icons[selected]?.label ?? '')

  /**
   * What went wrong with the last write, or null. Said in the panel rather than
   * left to the console: a write that fails and a panel that ignores Enter look
   * exactly the same otherwise.
   */
  let failure = $state<string | null>(null)

  async function chooseIcon(icon: TaskIcon): Promise<void> {
    if (!task) return
    failure = null
    try {
      if (icon !== task.icon) await fluid.tasks.update({ id: task.id, icon })
    } catch (error) {
      console.error('Could not change the task icon:', error)
      failure = 'Couldn’t save that icon.'
      return
    }
    api.close()
  }

  async function chooseColor(next: TaskColor): Promise<void> {
    if (!task) return
    failure = null
    color = next
    // The field keeps the keyboard: a colour is picked on the way to an icon as
    // often as instead of one, and the next thing done may well be typing.
    field?.focus()
    if (next === task.color) return
    try {
      await fluid.tasks.update({ id: task.id, color: next })
    } catch (error) {
      console.error('Could not change the task colour:', error)
      color = null
      failure = 'Couldn’t save that color.'
    }
  }

  let field = $state<HTMLInputElement | null>(null)

  function autofocus(node: HTMLInputElement): void {
    node.focus()
  }

  /**
   * The arrow keys walk the grid: left and right along it, wrapping from the end
   * of one row to the start of the next, and up and down a row at a time,
   * stopping at the edges rather than wrapping — a column is short enough that
   * running off it is more likely a slip than a way round. Escape is the main
   * process's, as it is for the launcher (see src/main/launcher-window.ts).
   */
  function onKeydown(event: KeyboardEvent): void {
    if (icons.length === 0) return
    const last = icons.length - 1

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      selected = selected >= last ? 0 : selected + 1
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      selected = selected <= 0 ? last : selected - 1
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (selected + COLUMNS <= last) selected += COLUMNS
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (selected - COLUMNS >= 0) selected -= COLUMNS
    } else if (event.key === 'Enter') {
      // A focused button — a glyph or a swatch reached with Tab — answers Enter
      // with its own click, which is what was aimed at. Taking the highlighted
      // glyph as well would pick an icon when a colour was asked for.
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      const icon = icons[selected]
      if (icon) void chooseIcon(icon.id)
    }
  }

  /**
   * The grid, which scrolls rather than growing past what the window allows —
   * the whole set fits as drawn, but the panel is capped to the window it opens
   * over (see src/main/launcher-window.ts), and a short one would otherwise cut
   * off the palette. So the highlighted glyph is kept in view as the arrow keys
   * move it.
   */
  let grid = $state<HTMLElement | null>(null)

  $effect(() => {
    void selected
    void icons
    grid?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  /** The panel itself, measured so the window can be sized to it, as the launcher's is. */
  let panel = $state<HTMLElement | null>(null)

  $effect(() => {
    const element = panel
    if (!element) return undefined

    const report = (): void => api.resize(element.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<!-- No background of its own, like the launcher: the window's vibrancy
     material, under its body's tint, is what the panel is made of. -->
<div bind:this={panel} class="flex flex-col text-ink-100 select-none text-on-glass">
  <div class="flex items-center gap-2.5 border-b border-white/10 px-4 py-3.5">
    <span class="icon-[ph--magnifying-glass] shrink-0 text-base text-ink-500" aria-hidden="true"
    ></span>
    <input
      use:autofocus
      bind:this={field}
      bind:value={query}
      oninput={() => {
        selected = 0
        failure = null
      }}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label="Search icons"
      placeholder="Search icons"
      class="w-full cursor-text bg-transparent text-sm text-ink-50 outline-none
             placeholder:text-ink-500"
    />
    <span class="shrink-0 truncate text-[0.6875rem] text-ink-500">{selectedLabel}</span>
  </div>

  {#if icons.length > 0}
    <div
      role="listbox"
      aria-label="Icons"
      bind:this={grid}
      class="grid max-h-96 gap-0.5 overflow-y-auto p-1.5"
      style="grid-template-columns: repeat({COLUMNS}, minmax(0, 1fr))"
    >
      {#each icons as icon, index (icon.id)}
        <!-- Hover moves the selection rather than drawing a highlight of its
             own, as a launcher row's does: one glyph is the one Enter takes. -->
        <button
          type="button"
          role="option"
          aria-selected={index === selected}
          aria-label={icon.label}
          title={icon.label}
          onmouseenter={() => (selected = index)}
          onfocus={() => (selected = index)}
          onclick={() => void chooseIcon(icon.id)}
          class="grid h-8 place-items-center rounded-lg glass-control"
        >
          <span class="{icon.className} text-lg {TASK_COLOR_TEXT[shownColor]}" aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="px-4 py-3 text-[0.6875rem] text-ink-500">No icons match “{query.trim()}”.</p>
  {/if}

  {#if failure}
    <p class="px-4 pb-2 text-[0.6875rem] text-red-400">{failure}</p>
  {/if}

  <!-- The colours, below a line that stays whatever the field filters: the
       colour is a question about the task, not about the search. -->
  <div
    role="radiogroup"
    aria-label="Color"
    class="flex items-center gap-2 border-t border-white/10 px-4 py-2.5"
  >
    {#each TASK_COLORS as swatch (swatch)}
      <button
        type="button"
        role="radio"
        aria-checked={swatch === shownColor}
        aria-label={TASK_COLOR_LABEL[swatch]}
        title={TASK_COLOR_LABEL[swatch]}
        onclick={() => void chooseColor(swatch)}
        class="size-4 rounded-full {TASK_COLOR_SWATCH[swatch]} 
               {swatch === shownColor
          ? 'outline-2 outline-offset-2 outline-white/80'
          : 'hover:outline-2 hover:outline-offset-2 hover:outline-white/25'}"
      ></button>
    {/each}
  </div>
</div>
