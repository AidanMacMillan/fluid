<script lang="ts">
  /**
   * The strip along the bottom of a floating panel that names the keys it
   * answers to — the arrows that walk the list, the one that takes a row, the
   * one that dismisses the panel. It is a reminder, not a control: nothing in it
   * is clickable, and every key it names is handled by the panel it sits in.
   *
   * Drawn the same way in every panel that has one, so a row of hints read once
   * is read everywhere. Which panels have one is a decision about the panel (the
   * ones held over the app for a few seconds and driven from the keyboard), not
   * about this component.
   */

  type Hint = {
    /** One chip per entry, in order: `['mod', 'Backspace']` is two chips side by side. */
    keys: string[]
    label: string
  }

  type Props = { hints: Hint[] }

  const { hints }: Props = $props()

  /**
   * Arrows are drawn as glyphs rather than spelled out. Literal class names, for
   * the reason `IconButton` gives: the icon plugin scans source text.
   */
  const ARROWS: Record<string, string> = {
    up: 'icon-[ph--arrow-up]',
    down: 'icon-[ph--arrow-down]',
    left: 'icon-[ph--arrow-left]',
    right: 'icon-[ph--arrow-right]'
  }

  /** The chord key the panels listen for is Cmd or Ctrl; show the one this machine has. */
  const MODIFIER = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
</script>

<!-- A seam above, the same line the field has below it, so the list reads as the
     middle of the panel. Never shrinks: a panel capped in height scrolls its
     list, and the hints must stay on screen however long that list is. -->
<div
  class="flex shrink-0 items-center gap-4 border-t border-white/10 px-4 py-2.5
         text-[0.6875rem] text-ink-500"
  aria-label="Keyboard shortcuts"
>
  {#each hints as hint (hint.label)}
    <span class="flex items-center gap-1.5">
      <span class="flex items-center gap-1">
        {#each hint.keys as key (key)}
          <kbd
            class="grid h-5 min-w-5 place-items-center rounded bg-white/10 px-1 font-sans
                   text-[0.6875rem] leading-none font-light text-ink-200"
          >
            {#if ARROWS[key]}
              <span class="{ARROWS[key]} text-xs" aria-label="{key} arrow"></span>
            {:else if key === 'mod'}
              {MODIFIER}
            {:else}
              {key}
            {/if}
          </kbd>
        {/each}
      </span>
      {hint.label}
    </span>
  {/each}
</div>
