<script lang="ts">
  import { standardEmoji } from '../lib/slack-emoji'
  import { slackWorkspace } from '../lib/slack.svelte'

  /**
   * One emoji, by the name Slack calls it — `tada`, `party-parrot`, or
   * `wave::skin-tone-3`, always without the colons.
   *
   * A workspace's own emoji win over the standard ones, which is Slack's order
   * too: a team that has defined its own `:thumbsup:` means that one. What
   * neither can answer is drawn as `:name:`, which at least says what was
   * written rather than showing a hole.
   */
  const { name, size = 'text-base' }: { name: string; size?: string } = $props()

  const custom = $derived(slackWorkspace.emoji[name.split('::')[0]])
  const character = $derived(standardEmoji(name))
</script>

{#if custom}
  <img
    src={custom}
    alt=":{name}:"
    title=":{name}:"
    draggable="false"
    class="inline-block size-[1.125em] shrink-0 object-contain align-[-0.2em]"
  />
{:else if character}
  <!-- The emoji font is the one place this interface wants colour, and
       `font-emoji` is not a thing — the platform's own emoji font is picked up
       by the character itself. The title is what makes a reaction searchable
       by name, which is how people refer to them out loud. -->
  <span class="{size} leading-none" title=":{name}:">{character}</span>
{:else}
  <span class="rounded bg-white/10 px-1 font-mono text-[0.9em] text-ink-400">:{name}:</span>
{/if}
