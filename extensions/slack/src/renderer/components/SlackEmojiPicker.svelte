<script lang="ts">
  import { QUICK_REACTIONS, standardEmojiNames } from '../lib/slack-emoji'
  import { slackWorkspace } from '../lib/slack.svelte'
  import SlackEmoji from './SlackEmoji.svelte'

  /**
   * Picking an emoji to react with.
   *
   * Opens on the handful a team actually uses and only becomes a search once
   * something is typed — a grid of two thousand emoji is a worse answer to
   * "thumbs up this" than six buttons are.
   *
   * The workspace's own emoji sort first in a search, because a custom emoji is
   * nearly always the one being reached for by name: nobody types `kn` looking
   * for `knife`.
   */
  type Props = {
    onPick: (name: string) => void
    onDismiss: () => void
  }

  const { onPick, onDismiss }: Props = $props()

  let query = $state('')
  let field = $state<HTMLInputElement | null>(null)

  /** How many results the grid holds before it would need to scroll for ever. */
  const LIMIT = 60

  const results = $derived.by(() => {
    const needle = query.trim().toLowerCase().replace(/^:|:$/g, '')
    if (needle === '') return [...QUICK_REACTIONS]

    const custom = Object.keys(slackWorkspace.emoji)
      .filter((name) => name.includes(needle))
      .sort(
        (left, right) => left.indexOf(needle) - right.indexOf(needle) || left.localeCompare(right)
      )

    const standard = standardEmojiNames()
      .filter((name) => name.includes(needle))
      .sort(
        (left, right) => left.indexOf(needle) - right.indexOf(needle) || left.localeCompare(right)
      )

    return [...custom, ...standard].slice(0, LIMIT)
  })

  // Focus lands here the moment it opens: the picker is opened by somebody who
  // already knows what they want, and making them click the field first would
  // be a step for nothing.
  $effect(() => {
    field?.focus()
  })

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
    }
    // Enter takes the first result, so a reaction is type-and-go.
    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault()
      onPick(results[0])
    }
  }
</script>

<!-- `tabindex="-1"`: the keys are handled here rather than on the field so that
     the arrow keys and Escape work wherever focus has got to inside the picker,
     and a dialog that can receive them has to be focusable at all. -->
<div
  role="dialog"
  tabindex="-1"
  aria-label="Pick a reaction"
  class="w-64 rounded-lg glass-scrim p-2 shadow-xl ring-1 ring-white/15"
  onkeydown={onKeydown}
>
  <input
    bind:this={field}
    bind:value={query}
    type="text"
    placeholder="Search emoji"
    autocomplete="off"
    spellcheck="false"
    class="h-7 w-full rounded-md bg-black/30 px-2 text-xs text-ink-100 ring-1 ring-white/15
           outline-none select-text placeholder:text-ink-500 focus:ring-white/30"
  />

  {#if results.length === 0}
    <p class="px-1 py-3 text-center text-[11px] text-ink-500">Nothing by that name.</p>
  {:else}
    <div class="mt-2 grid max-h-52 grid-cols-6 gap-0.5 overflow-y-auto">
      {#each results as name (name)}
        <button
          type="button"
          onclick={() => onPick(name)}
          title=":{name}:"
          class="grid size-9 place-items-center rounded-md glass-control"
        >
          <SlackEmoji {name} size="text-lg" />
        </button>
      {/each}
    </div>
  {/if}
</div>
