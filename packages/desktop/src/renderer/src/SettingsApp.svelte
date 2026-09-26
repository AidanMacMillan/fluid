<script lang="ts">
  import ExtensionInstaller from './components/ExtensionInstaller.svelte'
  import ExtensionRow from './components/ExtensionRow.svelte'
  import ExtensionSettings from './components/ExtensionSettings.svelte'
  import ThemePicker from './components/ThemePicker.svelte'
  import AdBlockingSettings from './components/AdBlockingSettings.svelte'
  import { extensions } from './lib/extensions.svelte'

  extensions.start()

  /**
   * The sections down the left. The nav is driven off these lists rather than
   * hard-coded markup, so another section is a line here and a branch in the
   * panel below.
   *
   * What a project is — its name and its folder — is asked in the project
   * picker rather than here. What is left is the settings that are the same
   * whichever project the app is in.
   *
   * First the app's own: the extensions themselves, and the theme, which is
   * the whole app's. Below those, a section for each running extension that
   * asked for one (see `Extension.settings`), which the extension draws
   * itself: the services it connects to, which are one account per service
   * however much work is open against them.
   */
  const SECTIONS = [
    { id: 'extensions', label: 'Extensions', icon: 'icon-[ph--puzzle-piece]' },
    { id: 'themes', label: 'Themes', icon: 'icon-[ph--palette]' },
    { id: 'ad-blocking', label: 'Privacy', icon: 'icon-[ph--shield-check]' }
  ] as const

  type Section = { id: string; label: string; icon: string; extensionId?: string }

  const extensionSections = $derived<Section[]>(
    extensions.infos.flatMap((info) =>
      info.active && info.settings
        ? [
            {
              id: `extension:${info.id}`,
              label: info.settings.label,
              icon: 'icon-[ph--plugs]',
              extensionId: info.id
            }
          ]
        : []
    )
  )

  /** The section picked in the nav, or null for the one the panel opens on. */
  let chosen = $state<string | null>(null)

  const sections = $derived<Section[]>([...SECTIONS, ...extensionSections])

  /**
   * The section showing: the one picked, or the first there is. An extension's
   * section goes with the extension, so turning it off moves the panel on to
   * the first section rather than to nothing.
   */
  const current = $derived(sections.find((item) => item.id === chosen) ?? sections[0])

  const heading = $derived(current.label)

  // Menu accelerators also reach us while an extension's native settings view
  // holds focus, where a key listener on this page would never see the chord.
  $effect(() =>
    window.api.shortcuts.onNavigate((navigation) => {
      if (navigation.kind !== 'tab-step' || !extensions.loaded) return
      const index = sections.findIndex((item) => item.id === current.id)
      chosen = sections[(index + navigation.delta + sections.length) % sections.length].id
    })
  )
</script>

<!-- The window is the panel, and the panel is the launcher's: the same vibrancy
     material under the same tint as the app's own glass (`body[data-panel]` in
     main.css), so it reads as the same stuff as the window it opens over.
     Nothing here paints an edge: the window's own rounded corner and shadow are
     the panel's edge. -->
<div class="flex h-screen text-ink-100 text-on-glass">
  <!-- The sections, and the whole of the panel's chrome. Nothing above them
       names the window: it was opened from a control that says Settings, and the
       sections themselves say what it holds. A bar repeating that would be a
       strip of chrome held over content that needs the room. -->
  <nav class="flex w-44 shrink-0 flex-col border-r border-white/10 p-2">
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings sections"
      class="flex flex-col gap-0.5"
    >
      <!-- Held back with the panel (see below), so the extensions' sections
           arrive with the rest rather than a moment after them. -->
      {#if extensions.loaded}
        {#each SECTIONS as item (item.id)}
          {@render sectionRow(item)}
        {/each}
        {#if extensionSections.length > 0}
          <div class="mx-2.5 my-1.5 border-t border-white/10" role="presentation"></div>
          {#each extensionSections as item (item.id)}
            {@render sectionRow(item)}
          {/each}
        {/if}
      {/if}
    </div>
  </nav>

  <!-- Nothing until the extensions have been heard from, since which section
       the panel opens on depends on them: a guess would draw one section and
       then jump to another. -->
  {#if !extensions.loaded}
    <div class="flex-1"></div>
  {:else if current.extensionId}
    <!-- The extension draws the rest, in a page of its own laid over the box
         below the title; the page scrolls itself. -->
    <section role="tabpanel" class="flex min-h-0 flex-1 flex-col pt-4">
      <h1 class="px-4 pb-3 text-xs font-semibold text-ink-200">{heading}</h1>
      {#key current.extensionId}
        <ExtensionSettings extensionId={current.extensionId} />
      {/key}
    </section>
  {:else}
    {@render builtInPanel()}
  {/if}
</div>

{#snippet sectionRow(item: Section)}
  <!-- A launcher row: the glyph takes the row's own colour, the name runs
       beside it, and the row earns a background only by being hovered or
       selected. -->
  <button
    type="button"
    role="tab"
    aria-selected={current.id === item.id}
    onclick={() => (chosen = item.id)}
    class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
  >
    <span
      class="{item.icon} shrink-0 text-base {current.id === item.id
        ? 'text-ink-200'
        : 'text-ink-500'}"
      aria-hidden="true"
    ></span>
    <span class="min-w-0 flex-1 truncate text-xs text-ink-100">{item.label}</span>
  </button>
{/snippet}

{#snippet builtInPanel()}
  <!-- The title scrolls with its section rather than pinning to the top: the
       nav already says which section is open, so a bar repeating it is a line of
       chrome held over content that needs the room. -->
  <section role="tabpanel" class="min-h-0 flex-1 overflow-y-auto p-4">
    <h1 class="pb-3 text-xs font-semibold text-ink-200">{heading}</h1>

    {#if current.id === 'extensions'}
      <div class="flex flex-col gap-3">
        <ExtensionInstaller />
        {#each extensions.infos as extension (extension.id)}
          <ExtensionRow {extension} />
        {/each}
      </div>
    {:else if current.id === 'themes'}
      <ThemePicker />
    {:else if current.id === 'ad-blocking'}
      <AdBlockingSettings />
    {/if}
  </section>
{/snippet}
