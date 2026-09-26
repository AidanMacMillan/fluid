<script lang="ts">
  import IconButton from './components/IconButton.svelte'
  import type { PoppedOutTab } from '../../main/miniplayer'

  /**
   * The bar across the top of a floating window — a tab floating whole, or a
   * call or video in its miniplayer: the tab's icon and name, as its row in
   * the sidebar has them, the way back, and a close that leaves the tab where
   * it is. The whole bar is the handle the window is moved by, since the
   * window has no frame of its own.
   *
   * It knows nothing about the tab but what it is told. Names and icons are
   * worked out in the main window, from state only that window has, and are
   * sent across whenever they change.
   */

  let tab = $state<PoppedOutTab | null>(null)

  $effect(() => window.api.popout.onTab((next) => (tab = next)))

  /** The image that failed to decode, if any, which the glyph stands in for. */
  let broken = $state<string | null>(null)
  const image = $derived(tab?.image && tab.image !== broken ? tab.image : null)
</script>

<div class="flex h-screen items-center gap-2 pr-1 pl-3 select-none drag-region">
  {#if tab}
    {#if image}
      <img
        src={image}
        alt=""
        draggable="false"
        onerror={() => (broken = image)}
        class="size-4 shrink-0 object-contain"
      />
    {:else}
      <span class="{tab.glyph} shrink-0 text-base text-ink-400" aria-hidden="true"></span>
    {/if}
    <span class="min-w-0 flex-1 truncate text-xs font-medium text-ink-300">{tab.label}</span>
  {:else}
    <span class="flex-1"></span>
  {/if}
  <IconButton
    icon="icon-[ph--arrow-square-in]"
    label="Back to tab"
    onclick={() => window.api.popout.back()}
  />
  <IconButton icon="icon-[ph--minus]" label="Close" onclick={() => window.api.popout.dismiss()} />
</div>
