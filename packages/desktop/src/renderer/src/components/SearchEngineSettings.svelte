<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import { saveSearchEngine } from '../lib/search-engine-setting'
  import ecosiaLogo from '../assets/search-engines/ecosia.png'
  import yahooLogo from '../assets/search-engines/yahoo.png'
  import {
    MAX_CUSTOM_ENGINES,
    SEARCH_ENGINE_PRESETS,
    SEARCH_ENGINE_SETTING,
    searchEngineSetting,
    type SearchEngineSetting
  } from '../../../shared/search-engine'

  /**
   * Opens the custom engine page — for the engine with this id, or for a new one
   * when there is none. The panel it lives on is the parent's to swap.
   */
  let { onCustom }: { onCustom: (id: string | null) => void } = $props()

  /** Logos that are bundled files rather than icon-set glyphs, by preset id. */
  const IMAGES: Record<string, string> = { ecosia: ecosiaLogo, yahoo: yahooLogo }

  let setting = $state<SearchEngineSetting>(searchEngineSetting(null))
  let loaded = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)

  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: SEARCH_ENGINE_SETTING },
      (value) => {
        setting = searchEngineSetting(value)
        loaded = true
      },
      (cause) => (error = reasonFrom(cause))
    )
  )

  async function pick(id: string): Promise<void> {
    const next = { ...setting, id }
    saving = true
    error = null
    try {
      await saveSearchEngine(next)
      setting = next
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      saving = false
    }
  }

  const tile =
    'flex flex-col items-center gap-2 rounded-lg bg-white/5 px-2 py-3 text-ink-100 ring-1 ring-transparent transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-marker/60 disabled:opacity-40'
</script>

<div class="flex flex-col gap-3 text-xs">
  <div>
    <h2 class="font-medium text-ink-200">Search engine</h2>
    <p class="mt-1 text-ink-400">
      Used when you type something that isn’t a web address, and for the page a new tab opens on.
    </p>
  </div>

  <div
    role="radiogroup"
    aria-label="Search engine"
    class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2"
  >
    {#each SEARCH_ENGINE_PRESETS as preset (preset.id)}
      {@const selected = setting.id === preset.id}
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={!loaded || saving}
        onclick={() => void pick(preset.id)}
        class="{tile} {selected ? 'bg-white/10 !ring-marker/70' : ''}"
      >
        {@render logo(preset.icon, IMAGES[preset.id], preset.name)}
        <span class="max-w-full truncate">{preset.name}</span>
      </button>
    {/each}

    {#if setting.custom.length === 0}
      {@render addTile()}
    {/if}
  </div>

  {#if setting.custom.length > 0}
    <div class="mt-2">
      <h3 class="font-medium text-ink-200">Custom search engines</h3>
    </div>
    <div
      role="radiogroup"
      aria-label="Custom search engines"
      class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2"
    >
      {#each setting.custom as engine (engine.id)}
        {@const selected = setting.id === engine.id}
        <!-- The edit button sits over the tile rather than inside it: a button
             cannot hold a button. It shows on hover and on keyboard focus. -->
        <div class="group relative">
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            title={engine.url}
            disabled={!loaded || saving}
            onclick={() => void pick(engine.id)}
            class="{tile} w-full {selected ? 'bg-white/10 !ring-marker/70' : ''}"
          >
            {@render logo(null, undefined, engine.name)}
            <span class="max-w-full truncate">{engine.name}</span>
          </button>
          <button
            type="button"
            aria-label={`Edit ${engine.name}`}
            disabled={saving}
            onclick={() => onCustom(engine.id)}
            class="absolute top-1 right-1 grid size-6 place-items-center rounded-md glass-control text-ink-400 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink-100 focus-visible:opacity-100"
          >
            <span class="icon-[ph--pencil-simple] text-sm" aria-hidden="true"></span>
          </button>
        </div>
      {/each}
      {#if setting.custom.length < MAX_CUSTOM_ENGINES}
        {@render addTile()}
      {/if}
    </div>
  {/if}
  {#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
</div>

{#snippet addTile()}
  <button
    type="button"
    disabled={!loaded || saving}
    onclick={() => onCustom(null)}
    class="{tile} border border-dashed border-white/20 text-ink-300"
  >
    <span
      class="flex size-7 items-center justify-center rounded-full bg-white/10"
      aria-hidden="true"
    >
      <span class="icon-[ph--plus] text-base"></span>
    </span>
    <span>Add custom</span>
  </button>
{/snippet}

{#snippet logo(icon: string | null, image: string | undefined, label: string)}
  <!-- A brand's logo where there is one — from the icon set, or a bundled file —
       and its first letter where not. -->
  {#if icon}
    <span class="{icon} size-7" aria-hidden="true"></span>
  {:else if image}
    <img src={image} alt="" class="size-7 object-contain" />
  {:else}
    <span
      class="flex size-7 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-ink-200"
      aria-hidden="true">{label.trim().charAt(0).toUpperCase()}</span
    >
  {/if}
{/snippet}
