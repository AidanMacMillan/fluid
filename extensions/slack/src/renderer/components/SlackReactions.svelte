<script lang="ts">
  import type { SlackReaction } from '../../main/slack'
  import type { ThreadUser } from '../../main/slack-thread'
  import SlackAddReaction from './SlackAddReaction.svelte'
  import SlackEmoji from './SlackEmoji.svelte'

  /**
   * The row of reactions under a message, and the button that adds one.
   *
   * A pill the user is part of is drawn as pressed, which is both how Slack
   * says it and the only thing that makes clicking one predictable: the click
   * means "add mine" or "take mine away" depending on a fact the pill has to be
   * showing already.
   *
   * Changes are optimistic. Slack is a round trip away and a reaction is the
   * smallest thing in the interface; waiting on the network to redraw a pill
   * makes the whole pane feel like a web page. The pane re-reads the thread
   * shortly afterwards, which is what corrects an optimistic guess that turned
   * out to be wrong.
   */
  type Props = {
    reactions: SlackReaction[]
    /** The user's own id, which is how a pill knows whether it is pressed. */
    me: string
    users: Record<string, ThreadUser>
    /** True while the thread has no write access — no token, or a read failed. */
    disabled?: boolean
    onToggle: (name: string, on: boolean) => void
  }

  const { reactions, me, users, disabled = false, onToggle }: Props = $props()

  /** Who reacted, for the tooltip. Named people first; the rest counted. */
  function reactorsOf(reaction: SlackReaction): string {
    const names = reaction.users.map((id) => (id === me ? 'You' : (users[id]?.name ?? 'Someone')))
    if (names.length === 0) return `:${reaction.name}:`
    const shown = names.slice(0, 8)
    const rest = names.length - shown.length
    const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
    return `${list} reacted with :${reaction.name}:`
  }

  function toggle(reaction: SlackReaction): void {
    if (disabled) return
    onToggle(reaction.name, !reaction.users.includes(me))
  }
</script>

<div class="mt-2 flex flex-wrap items-center gap-1">
  {#each reactions as reaction (reaction.name)}
    {@const mine = reaction.users.includes(me)}
    <button
      type="button"
      {disabled}
      aria-pressed={mine}
      title={reactorsOf(reaction)}
      onclick={() => toggle(reaction)}
      class="flex h-6 items-center gap-1 rounded-full px-2 text-[11px] tabular-nums
             ring-1 transition-colors disabled:pointer-events-none disabled:opacity-50
             {mine
        ? 'bg-sky-400/20 text-sky-100 ring-sky-300/40'
        : 'bg-white/8 text-ink-300 ring-white/10 hover:bg-glow/14'}"
    >
      <SlackEmoji name={reaction.name} size="text-[0.9rem]" />
      {reaction.count}
    </button>
  {/each}

  <!-- Always present here, because this row only exists at all when somebody
       has already reacted — so there is nothing for it to be cluttering. The
       message with no reactions gets the floating one instead (see
       SlackMessage). -->
  <SlackAddReaction {disabled} onPick={(name) => onToggle(name, true)} />
</div>
