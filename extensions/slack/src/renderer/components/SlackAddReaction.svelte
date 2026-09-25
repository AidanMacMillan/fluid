<script lang="ts">
  import SlackEmojiPicker from './SlackEmojiPicker.svelte'

  /**
   * The button that adds a reaction, and the picker it opens.
   *
   * Its own component because it appears in two places that are not near each
   * other: at the end of the row of existing reactions, and — on a message
   * nobody has reacted to yet — floating in the message's top corner, where
   * Slack keeps its hover toolbar. The second is why a message with no
   * reactions costs no vertical space at all.
   */
  type Props = {
    disabled?: boolean
    /**
     * Which way the picker opens. Above, for a button at the end of a reaction
     * row near the foot of the thread; below, for one in a message's top
     * corner, where opening upwards would go off the top of the pane.
     */
    placement?: 'above' | 'below'
    onPick: (name: string) => void
  }

  const { disabled = false, placement = 'above', onPick }: Props = $props()

  let picking = $state(false)

  function pick(name: string): void {
    picking = false
    if (!disabled) onPick(name)
  }
</script>

<div class="relative">
  <button
    type="button"
    {disabled}
    aria-label="Add a reaction"
    onclick={() => (picking = !picking)}
    class="grid size-6 place-items-center rounded-full glass-control text-ink-500 ring-1
           ring-white/10 hover:text-ink-200 disabled:pointer-events-none disabled:opacity-40"
  >
    <span class="icon-[ph--smiley-sticker] text-sm" aria-hidden="true"></span>
  </button>

  {#if picking}
    <div
      class="absolute z-20 {placement === 'above'
        ? 'bottom-full left-0 mb-1'
        : 'top-full right-0 mt-1'}"
    >
      <SlackEmojiPicker onPick={pick} onDismiss={() => (picking = false)} />
    </div>
  {/if}
</div>
