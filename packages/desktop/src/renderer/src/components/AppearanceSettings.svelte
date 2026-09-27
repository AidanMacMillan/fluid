<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import {
    SIDEBAR_POSITION_SETTING,
    sidebarPosition,
    type SidebarPosition
  } from '../../../shared/appearance'
  import ThemePicker from './ThemePicker.svelte'

  let selected = $state<SidebarPosition>('left')
  let loaded = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)

  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: SIDEBAR_POSITION_SETTING },
      (value) => {
        selected = sidebarPosition(value)
        loaded = true
      },
      (cause) => (error = reasonFrom(cause))
    )
  )

  async function choose(position: SidebarPosition): Promise<void> {
    const previous = selected
    selected = position
    saving = true
    error = null
    try {
      await fluid.settings.set({ key: SIDEBAR_POSITION_SETTING, value: position })
      selected = position
    } catch (cause) {
      selected = previous
      error = reasonFrom(cause)
    } finally {
      saving = false
    }
  }
</script>

<div class="flex flex-col gap-6">
  <section aria-labelledby="sidebar-heading">
    <h2 id="sidebar-heading" class="mb-3 text-xs font-medium text-ink-200">Sidebar</h2>
    <div class="flex items-center justify-between gap-3 rounded-lg bg-white/5 p-3 text-xs">
      <label for="sidebar-position" class="text-ink-200">Position</label>
      <select
        id="sidebar-position"
        value={selected}
        disabled={!loaded || saving}
        onchange={(event) => void choose(sidebarPosition(event.currentTarget.value))}
        class="rounded-md glass-control px-3 py-2 text-ink-100 outline-none focus-visible:ring-2 focus-visible:ring-marker/60 disabled:opacity-40"
      >
        <option value="left">Left</option>
        <option value="right">Right</option>
      </select>
    </div>
    {#if error}<p role="alert" class="mt-3 text-xs text-red-400">{error}</p>{/if}
  </section>

  <section aria-labelledby="theme-heading">
    <h2 id="theme-heading" class="mb-3 text-xs font-medium text-ink-200">Theme</h2>
    <ThemePicker />
  </section>
</div>
