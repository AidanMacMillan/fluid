<script lang="ts">
  import { onMount } from 'svelte'
  import { keepSelectionInView, selectOnMouseMove, type HistoryEntry, type Tab } from '@fluid/sdk'
  import type { HistoryContext } from '../../main/history-window'
  import { fluid } from './lib/api'
  import { extensions } from './lib/extensions.svelte'
  import {
    historyDays,
    historyFavicon,
    historyLocation,
    historyTime
  } from './lib/history-presentation'

  let context = $state<HistoryContext | null>(null)
  let entries = $state<HistoryEntry[]>([])
  let tabs = $state<Tab[]>([])
  let query = $state('')
  let search = $state('')
  let pages = $state(1)
  let revision = $state(0)
  let selected = $state(0)
  let loading = $state(true)
  let more = $state(false)
  let error = $state('')
  let busy = $state(false)
  let panel = $state<HTMLElement | null>(null)
  let now = $state(Date.now())
  let failedPictures = $state<Record<string, string[]>>({})
  const days = $derived(historyDays(entries, now))
  const orderedEntries = $derived(days.flatMap((day) => day.visits.map(({ entry }) => entry)))
  const tabsById = $derived(new Map(tabs.map((tab) => [tab.id, tab])))

  function autofocus(node: HTMLInputElement): void {
    node.focus()
  }

  function fail(reason: unknown): void {
    error = reason instanceof Error ? reason.message : String(reason)
  }

  onMount(() => {
    void window.api.historyWindow
      .context()
      .then((value) => {
        context = value
      })
      .catch(fail)
    const stop = fluid.on('history.changed', (event) => {
      if (event.taskId === context?.taskId) revision++
    })
    const stopTabs = fluid.onAny((event) => {
      if (event.type.startsWith('tab.') || event.type === 'extensions.changed') revision++
    })
    const timer = setInterval(() => {
      now = Date.now()
    }, 30_000)
    return () => {
      stop()
      stopTabs()
      clearInterval(timer)
    }
  })

  $effect(() => {
    if (!context) return undefined
    return fluid.watch(
      'tabs.list',
      { taskId: context.taskId },
      (value) => {
        tabs = value
      },
      fail
    )
  })
  $effect(() => {
    const value = query
    const timer = setTimeout(() => {
      search = value
      pages = 1
      selected = 0
    }, 150)
    return () => clearTimeout(timer)
  })
  $effect(() => {
    if (!context) return undefined
    const taskId = context.taskId
    const count = pages
    const value = search
    void revision
    let cancelled = false
    loading = true
    void Promise.all(
      Array.from({ length: count }, (_, i) =>
        fluid.history.list({ taskId, query: value, limit: 100, offset: i * 100 })
      )
    )
      .then((results) => {
        if (cancelled) return
        entries = results.flat()
        more = results.at(-1)?.length === 100
        selected = Math.max(0, Math.min(selected, entries.length - 1))
        loading = false
      })
      .catch((reason) => {
        if (!cancelled) {
          fail(reason)
          loading = false
        }
      })
    return () => {
      cancelled = true
    }
  })
  $effect(() => {
    if (!panel) return undefined
    const element = panel
    const report = (): void =>
      window.api.historyWindow.resize(element.getBoundingClientRect().height)
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  })

  function canOpen(entry: HistoryEntry): boolean {
    return entry.canOpen === true
  }
  async function open(entry?: HistoryEntry): Promise<void> {
    if (!entry || !canOpen(entry) || busy) return
    busy = true
    error = ''
    try {
      const tab = await fluid.history.open({ taskId: entry.taskId, id: entry.id })
      await fluid.ui.reveal({ taskId: entry.taskId, tabId: tab.id })
      window.api.historyWindow.close()
    } catch (reason) {
      fail(reason)
    } finally {
      busy = false
    }
  }
  async function forget(entry: HistoryEntry): Promise<void> {
    try {
      await fluid.history.delete({ taskId: entry.taskId, id: entry.id })
    } catch (reason) {
      fail(reason)
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selected = Math.max(
        0,
        Math.min(entries.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))
      )
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      void open(orderedEntries[selected])
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (orderedEntries[selected]) void forget(orderedEntries[selected])
    }
  }
  function icon(entry: HistoryEntry): string {
    if (entry.type === 'browser') return 'icon-[ph--globe-simple]'
    if (entry.type === 'file') {
      const mime = typeof entry.metadata.mimeType === 'string' ? entry.metadata.mimeType : ''
      if (mime.startsWith('image/')) return 'icon-[ph--image]'
      if (mime.startsWith('video/')) return 'icon-[ph--video]'
      if (mime.startsWith('audio/')) return 'icon-[ph--music-note]'
      if (mime === 'application/pdf') return 'icon-[ph--file-pdf]'
      return 'icon-[ph--file]'
    }
    return extensions.tabIcon(entry.type) ?? 'icon-[ph--puzzle-piece]'
  }

  function picture(entry: HistoryEntry): string | null {
    const tab = entry.tabId ? tabsById.get(entry.tabId) : undefined
    let source: unknown
    if (entry.type === 'browser') {
      source = historyFavicon(entry, tabs, failedPictures[entry.id])
    } else if (entry.type === 'file') {
      source = entry.metadata.thumbnail ?? (tab?.type === 'file' ? tab.payload.thumbnail : null)
    }
    return typeof source === 'string' &&
      source.startsWith('data:image/') &&
      !failedPictures[entry.id]?.includes(source)
      ? source
      : null
  }
</script>

<svelte:window onkeydown={keydown} />

<div bind:this={panel} class="history-panel flex flex-col text-ink-100 text-on-glass">
  <header class="flex items-center gap-2.5 border-b border-white/10 px-4 py-3.5">
    <span
      class="icon-[ph--clock-counter-clockwise] shrink-0 text-base text-ink-500"
      aria-hidden="true"
    ></span>
    {#if context?.taskTitle}
      <span
        class="max-w-40 shrink-0 truncate rounded-md bg-white/10 px-2 py-1 text-[0.6875rem] font-medium text-ink-200"
        title={context.taskTitle}
      >
        {context.taskTitle}
      </span>
    {/if}
    <input
      use:autofocus
      bind:value={query}
      oninput={() => (selected = 0)}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label="Search task history"
      placeholder="Search history"
      class="min-w-0 flex-1 cursor-text bg-transparent text-sm text-ink-50 outline-none placeholder:text-ink-500"
    />
  </header>

  {#if error}<p role="alert" class="px-5 py-2 text-xs text-red-400">{error}</p>{/if}
  <div
    use:keepSelectionInView
    aria-busy={loading}
    class="history-scroll max-h-[27rem] overflow-y-auto overscroll-contain px-3 pb-3"
  >
    {#if !loading && entries.length === 0}
      <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <span
          class="mb-1 icon-[ph--clock-counter-clockwise] text-2xl text-ink-500"
          aria-hidden="true"
        ></span>
        <p class="text-sm text-ink-200">
          {search ? 'No matching visits' : 'Your history starts here'}
        </p>
        <p class="text-xs text-ink-500">
          {search
            ? 'Try a different title, site, or location.'
            : 'Pages and tabs you visit in this task will appear here.'}
        </p>
      </div>
    {:else if loading && entries.length === 0}
      <p class="px-4 py-10 text-center text-xs text-ink-500">Loading history…</p>
    {/if}
    {#each days as day (day.key)}
      <section aria-labelledby={'day-' + day.key} class="history-day">
        <h2
          id={'day-' + day.key}
          class="flex flex-wrap items-baseline gap-x-2 px-2 pt-4 pb-3 text-xs"
        >
          {#if day.label}<span class="font-semibold text-ink-100">{day.label}</span>{/if}
          <time
            datetime={day.key}
            class={day.label ? 'text-[0.6875rem] text-ink-500' : 'font-semibold text-ink-100'}
            >{day.date}</time
          >
        </h2>
        <ol class="flex flex-col gap-0.5">
          {#each day.visits as { entry, index } (entry.id)}
            {@const image = picture(entry)}
            <li
              class="history-entry group flex items-center gap-3 rounded-lg px-2 py-2"
              aria-current={selected === index}
              use:selectOnMouseMove={() => (selected = index)}
              onfocusin={() => (selected = index)}
            >
              <time
                datetime={new Date(entry.visitedAt).toISOString()}
                title={new Date(entry.visitedAt).toLocaleString()}
                class="w-[4.5rem] shrink-0 text-left text-[0.6875rem] text-ink-500 tabular-nums"
              >
                {historyTime(entry)}
              </time>
              <span class="flex size-7 shrink-0 items-center justify-center" aria-hidden="true">
                {#if image}
                  <img
                    src={image}
                    alt=""
                    class="size-4 rounded-sm object-contain"
                    onerror={() =>
                      (failedPictures[entry.id] = [...(failedPictures[entry.id] ?? []), image])}
                  />
                {:else}
                  <span class="{icon(entry)} text-base text-ink-400"></span>
                {/if}
              </span>
              <div class="min-w-0 flex-1">
                <button
                  onclick={() => open(entry)}
                  disabled={!canOpen(entry) || busy}
                  title={canOpen(entry)
                    ? entry.title
                    : entry.title + ' — ' + entry.unavailableReason}
                  class="block max-w-full truncate text-left text-xs font-medium text-ink-100 enabled:cursor-pointer enabled:hover:underline disabled:text-ink-400"
                  >{entry.title}</button
                >
                <p
                  class="mt-0.5 truncate text-[0.6875rem] text-ink-500 select-text"
                  title={entry.location ?? entry.label}
                >
                  {historyLocation(entry)}{!canOpen(entry)
                    ? ' · ' + (entry.unavailableReason ?? 'Tab unavailable')
                    : ''}
                </p>
                {#if entry.sessionId}<p
                    class="mt-0.5 truncate text-[0.625rem] text-ink-500 select-text"
                    title={entry.sessionId}
                  >
                    Session: {entry.sessionId}
                  </p>{/if}
              </div>
              <button
                onclick={() => forget(entry)}
                aria-label={'Delete visit to ' + entry.title}
                title="Remove from history"
                class="history-remove flex size-6 shrink-0 items-center justify-center rounded-md text-ink-500 opacity-0 transition-opacity group-focus-within:opacity-100 hover:bg-white/10 hover:text-ink-100 focus-visible:opacity-100"
                ><span class="icon-[ph--x] text-xs" aria-hidden="true"></span></button
              >
            </li>
          {/each}
        </ol>
      </section>
    {/each}
    {#if more}
      <button
        onclick={() => pages++}
        disabled={loading}
        class="mt-3 w-full rounded-lg py-2.5 text-xs text-ink-400 hover:bg-white/5 disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load older visits'}
      </button>
    {/if}
  </div>
</div>

<style>
  .history-day + .history-day {
    margin-top: 0.5rem;
    border-top: 1px solid color-mix(in srgb, var(--theme-glow) 8%, transparent);
  }

  .history-entry {
    transition: background-color 120ms ease;
  }

  .history-entry[aria-current='true'] {
    background-color: color-mix(in srgb, var(--theme-glow) 7%, transparent);
  }

  .history-entry[aria-current='true'] .history-remove {
    opacity: 1;
  }

  .history-panel :global(button:focus-visible) {
    outline: 1px solid var(--theme-selected-edge);
    outline-offset: 3px;
  }
</style>
