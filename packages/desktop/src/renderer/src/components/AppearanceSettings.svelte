<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import {
    SIDEBAR_POSITION_SETTING,
    UI_DENSITY_SETTING,
    UI_DENSITY,
    UI_DENSITY_MARKS,
    uiDensity,
    densityFromSlider,
    densityToSlider,
    WINDOW_TRANSPARENCY_SETTING,
    sidebarPosition,
    windowTransparency,
    type SidebarPosition
  } from '../../../shared/appearance'
  import ThemePicker from './ThemePicker.svelte'

  let selected = $state<SidebarPosition>('left')
  let loaded = $state(false)
  let saving = $state(false)
  let transparency = $state(1)
  let transparencyLoaded = $state(false)
  let transparencySaving = $state(false)
  let transparencyError = $state<string | null>(null)
  let savedTransparency = 1
  let pendingTransparency: number | null = null
  let error = $state<string | null>(null)
  let density = $state<number>(UI_DENSITY.default)
  let densityLoaded = $state(false)
  let densitySaving = $state(false)
  let densityError = $state<string | null>(null)
  let savedDensity: number = UI_DENSITY.default
  let pendingDensity: number | null = null

  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: UI_DENSITY_SETTING },
      (value) => {
        // A write's echo must not pull the thumb back during a newer gesture.
        if (densitySaving) return
        density = savedDensity = uiDensity(value)
        densityLoaded = true
      },
      (cause) => (densityError = reasonFrom(cause))
    )
  )

  async function setDensity(value: number): Promise<void> {
    density = pendingDensity = uiDensity(value)
    densityError = null
    if (densitySaving) return
    densitySaving = true
    try {
      // Serialize writes and coalesce intermediate frames. The last position
      // always wins, including when the panel closes during a quick drag.
      while (pendingDensity !== null) {
        const next = pendingDensity
        pendingDensity = null
        try {
          await fluid.settings.set({ key: UI_DENSITY_SETTING, value: next })
          savedDensity = next
          densityError = null
        } catch (cause) {
          densityError = reasonFrom(cause)
          if (pendingDensity === null) density = savedDensity
        }
      }
    } finally {
      densitySaving = false
    }
  }

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

  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: WINDOW_TRANSPARENCY_SETTING },
      (value) => {
        if (transparencySaving) return
        transparency = savedTransparency = windowTransparency(value)
        transparencyLoaded = true
      },
      (cause) => (transparencyError = reasonFrom(cause))
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

  async function setTransparency(value: number): Promise<void> {
    transparency = pendingTransparency = windowTransparency(value)
    transparencyError = null
    if (transparencySaving) return
    transparencySaving = true
    try {
      // Keep dragging responsive while persisting the final position in order.
      while (pendingTransparency !== null) {
        const next = pendingTransparency
        pendingTransparency = null
        try {
          await fluid.settings.set({ key: WINDOW_TRANSPARENCY_SETTING, value: next })
          savedTransparency = next
          transparencyError = null
        } catch (cause) {
          transparencyError = reasonFrom(cause)
          if (pendingTransparency === null) transparency = savedTransparency
        }
      }
    } finally {
      transparencySaving = false
    }
  }
</script>

<div class="flex flex-col gap-6">
  <section aria-labelledby="density-heading">
    <h2 id="density-heading" class="mb-3 text-xs font-medium text-ink-200">Interface density</h2>
    <div class="rounded-lg bg-white/5 p-3 text-xs">
      <div class="flex items-center justify-between gap-3">
        <label for="interface-density" class="font-medium text-ink-100">Spacing</label>
        <button
          type="button"
          onclick={() => void setDensity(UI_DENSITY.default)}
          disabled={!densityLoaded || density === UI_DENSITY.default}
          class="rounded glass-control px-2 py-1 text-ink-400 hover:text-ink-100 focus-visible:ring-2 focus-visible:ring-marker/60 disabled:opacity-40"
          >Reset</button
        >
      </div>
      <p id="density-description" class="mt-1 text-ink-400">
        Adjust spacing in the main window’s navigation and sidebar. Text size stays the same.
      </p>
      <div class="density-slider mt-5">
        <div class="density-marks text-ink-400" aria-hidden="true">
          {#each UI_DENSITY_MARKS as mark (mark.label)}
            <span
              class="density-mark"
              class:first={mark.value === UI_DENSITY.min}
              class:last={mark.value === UI_DENSITY.max}
              style:left="{densityToSlider(mark.value) * 100}%">{mark.label}</span
            >
          {/each}
        </div>
        <input
          id="interface-density"
          type="range"
          min={0}
          max={1}
          step="any"
          value={densityToSlider(density)}
          disabled={!densityLoaded}
          aria-describedby="density-description"
          aria-valuetext={`${Math.round(density * 100)}% spacing${density === UI_DENSITY.default ? ', default' : ''}`}
          oninput={(event) => void setDensity(densityFromSlider(event.currentTarget.valueAsNumber))}
        />
      </div>
      {#if densityError}<p role="alert" class="mt-3 text-red-400">{densityError}</p>{/if}
    </div>
  </section>

  <section aria-labelledby="window-heading">
    <h2 id="window-heading" class="mb-3 text-xs font-medium text-ink-200">Window</h2>
    <div class="rounded-lg bg-white/5 p-3 text-xs">
      <div class="flex items-center justify-between gap-3">
        <label for="window-transparency" class="font-medium text-ink-100">Transparency</label>
        <span class="text-ink-400 tabular-nums">
          {transparency === 0 ? 'Off' : `${Math.round(transparency * 100)}%`}
        </span>
      </div>
      <p id="transparency-description" class="mt-1 text-ink-400">
        Adjust how much the desktop shows through app windows. Fully opaque turns transparency off.
      </p>
      <div class="mt-5">
        <div class="mb-1 flex justify-between text-[0.6875rem] text-ink-400" aria-hidden="true">
          <span>Fully opaque</span>
          <span>Maximum transparency</span>
        </div>
        <input
          id="window-transparency"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={transparency}
          disabled={!transparencyLoaded}
          aria-describedby="transparency-description"
          aria-valuetext={transparency === 0
            ? 'Fully opaque, transparency off'
            : `${Math.round(transparency * 100)}% transparency`}
          oninput={(event) => void setTransparency(event.currentTarget.valueAsNumber)}
        />
      </div>
      {#if transparencyError}<p role="alert" class="mt-3 text-red-400">{transparencyError}</p>{/if}
    </div>
  </section>

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

<style>
  .density-marks {
    position: relative;
    height: 1.75rem;
    margin-inline: 0.5rem;
    font-size: 0.6875rem;
  }

  .density-mark {
    position: absolute;
    transform: translateX(-50%);
  }

  .density-mark.first {
    transform: none;
  }
  .density-mark.last {
    transform: translateX(-100%);
  }

  .density-mark::after {
    content: '';
    position: absolute;
    top: 1.125rem;
    left: 50%;
    height: 0.375rem;
    width: 1px;
    background: currentColor;
    opacity: 0.5;
  }

  .density-mark.first::after {
    left: 0;
  }
  .density-mark.last::after {
    left: 100%;
  }

  input[type='range'] {
    display: block;
    appearance: none;
    width: 100%;
    height: 1.25rem;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  input[type='range']::-webkit-slider-runnable-track {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--color-ink-600);
  }

  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 1rem;
    height: 1rem;
    margin-top: -0.375rem;
    border-radius: 50%;
    background: var(--color-ink-100);
    box-shadow: 0 1px 4px #0006;
  }

  input[type='range']:focus-visible {
    border-radius: 0.25rem;
    outline: 2px solid var(--color-marker);
    outline-offset: 3px;
  }

  input[type='range']:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
