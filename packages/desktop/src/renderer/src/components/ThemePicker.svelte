<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import { THEMES, THEME_SETTING_KEY, currentTheme } from '../lib/themes'

  /**
   * One card per theme, and picking one is choosing it: there is nothing to
   * apply or confirm. The choice lands on this window at once and reaches every
   * other window of the app through the setting (see src/main/theme.ts).
   *
   * Each card's preview is a small drawing of the chrome under that theme's own
   * `data-theme`, so it is drawn from the same tokens the app is and cannot
   * drift from what choosing it would look like. The ring around the chosen
   * card is outside that, and so wears the theme in force.
   *
   * Radio inputs rather than buttons, so the arrow keys move the choice the way
   * they do in any other set of options.
   */

  let selected = $state(currentTheme())
  let error = $state<string | null>(null)

  // The theme can change under this window too — from another window's picker,
  // should there ever be two — and the root is where it lands either way.
  $effect(() => {
    const observer = new MutationObserver(() => (selected = currentTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  })

  async function choose(id: string): Promise<void> {
    const previous = selected
    if (id === previous) return
    error = null
    // Drawn here straight away rather than after the round trip, so the click
    // and the change are the same moment.
    document.documentElement.dataset.theme = id
    try {
      await fluid.settings.set({ key: THEME_SETTING_KEY, value: id })
    } catch (cause) {
      document.documentElement.dataset.theme = previous
      error = reasonFrom(cause)
    }
  }
</script>

<div role="radiogroup" aria-label="Theme" class="grid grid-cols-2 gap-3">
  {#each THEMES as theme (theme.id)}
    {@const chosen = selected === theme.id}
    <label
      class="group flex cursor-default flex-col gap-3 rounded-lg bg-white/5 p-3 transition-shadow
             ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-marker/60
             {chosen ? 'ring-2 ring-marker/80' : 'ring-1 ring-white/10 hover:ring-white/20'}"
    >
      <input
        type="radio"
        name="theme"
        value={theme.id}
        checked={chosen}
        onchange={() => void choose(theme.id)}
        class="sr-only"
      />

      <!-- The chrome in miniature: a sidebar with its selected row, and a tab's
           well with a page loading into it. -->
      <div
        data-theme={theme.id}
        class="flex h-24 overflow-hidden rounded-md glass-scrim ring-1 ring-white/10"
        aria-hidden="true"
      >
        <div class="flex w-2/5 flex-col gap-1 p-1.5">
          <span
            class="flex h-4 items-center rounded bg-selected px-1.5 ring-1 ring-selected-edge ring-inset"
          >
            <span class="h-1 w-3/4 rounded-full bg-ink-100"></span>
          </span>
          <span class="flex h-4 items-center px-1.5">
            <span class="h-1 w-full rounded-full bg-ink-500"></span>
          </span>
          <span class="flex h-4 items-center px-1.5">
            <span class="h-1 w-1/2 rounded-full bg-ink-500"></span>
          </span>
          <span class="mx-1.5 mt-auto h-px bg-white/10"></span>
          <span class="flex h-4 items-center px-1.5">
            <span class="h-1 w-2/3 rounded-full bg-ink-600"></span>
          </span>
        </div>
        <div
          class="relative my-1.5 mr-1.5 flex flex-1 flex-col gap-1.5 overflow-hidden rounded bg-(--theme-well) p-2 pt-3"
        >
          <span class="absolute inset-x-0 top-0 h-0.5 load-bar scale-x-[0.6]"></span>
          <span class="h-1.5 w-3/4 rounded-full bg-ink-200"></span>
          <span class="h-1 w-full rounded-full bg-ink-400"></span>
          <span class="h-1 w-5/6 rounded-full bg-ink-400"></span>
          <span class="h-1 w-1/2 rounded-full bg-ink-600"></span>
        </div>
      </div>

      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-ink-100">{theme.name}</p>
          <p class="mt-0.5 text-xs text-ink-400">{theme.description}</p>
        </div>
        <span
          class="mt-0.5 shrink-0 text-base {chosen
            ? 'icon-[ph--check-circle-fill] text-marker'
            : 'icon-[ph--circle] text-ink-600'}"
          aria-hidden="true"
        ></span>
      </div>
    </label>
  {/each}
</div>

{#if error}
  <p class="mt-3 text-xs text-red-400">{error}</p>
{/if}
