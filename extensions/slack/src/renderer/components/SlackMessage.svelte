<script lang="ts">
  import type { SlackUserGroup } from '../../main/slack'
  import type { ThreadMessage, ThreadUser } from '../../main/slack-thread'
  import { messageNodes } from '../lib/slack-rich-text'
  import { clockTime, fullTime, postedAt, relativeTime } from '../lib/slack-time'
  import SlackAddReaction from './SlackAddReaction.svelte'
  import SlackAvatar from './SlackAvatar.svelte'
  import SlackFiles from './SlackFiles.svelte'
  import SlackReactions from './SlackReactions.svelte'
  import SlackRichText from './SlackRichText.svelte'

  /**
   * One message in a thread.
   *
   * Consecutive messages from the same person within a few minutes lose their
   * avatar and name and become one block, which is what Slack does and what
   * makes a back-and-forth readable — a name repeated eight times down the left
   * edge is eight times nothing.
   */
  type Props = {
    message: ThreadMessage
    users: Record<string, ThreadUser>
    /** The groups the thread flags, for the mentions in this message. */
    groups: Record<string, SlackUserGroup>
    me: string
    /** Run on from the message above: no avatar, no name, no time. */
    compact: boolean
    /** The message the tab was opened on, which is marked for a moment. */
    highlighted: boolean
    /**
     * The pane's clock, ticking. Passed in rather than read here so that every
     * stamp in the thread moves at the same moment, and so that the ticking
     * stops when the pane goes away rather than running per message for ever.
     */
    now: number
    readOnly: boolean
    onToggleReaction: (messageTs: string, name: string, on: boolean) => void
    onOpenUrl: (url: string) => void
  }

  const {
    message,
    users,
    groups,
    me,
    compact,
    highlighted,
    now,
    readOnly,
    onToggleReaction,
    onOpenUrl
  }: Props = $props()

  const nodes = $derived(messageNodes(message.text, message.blocks))
  const author = $derived(message.author)
  /** The author's directory entry, for the card their name opens. */
  const profile = $derived(author.id !== undefined ? users[author.id] : undefined)

  let cardOpen = $state(false)

  const posted = $derived(postedAt(message.ts))
</script>

<!-- Hovered as a whole, the way Slack does it: the row is the unit you act on,
     and the time in the gutter and the reaction button both appear with it. -->
<article
  class="group/message relative flex gap-2 px-4 transition-colors hover:bg-glow/[0.03]
         {compact ? 'py-1' : 'pt-3 pb-1.5'}
         {highlighted ? 'bg-amber-300/8 hover:bg-amber-300/10' : ''}"
>
  <!-- The gutter keeps its width whether or not it holds a picture, so a run of
       messages stays in one column. On a compact row it holds the time instead,
       revealed on hover the way Slack does it. -->
  <div class="w-9 shrink-0">
    {#if compact}
      <span
        class="mt-1 block text-right text-[10px] text-ink-500 tabular-nums opacity-0
               group-hover/message:opacity-100"
        aria-hidden="true"
      >
        {clockTime(posted)}
      </span>
    {:else}
      <SlackAvatar src={author.avatar} name={author.name} app={author.isApp} />
    {/if}
  </div>

  <!-- A thread is the one surface in this app that is a document rather than
       chrome, so the body's `user-select: none` is lifted here — a message you
       cannot quote out of is half a message. The gutter is left out of it, so
       dragging down a run of replies picks up what was said and not a column of
       times. -->
  <div class="min-w-0 flex-1 select-text">
    {#if !compact}
      <header class="mb-0.5 flex items-baseline gap-2">
        <button
          type="button"
          onclick={() => (cardOpen = !cardOpen)}
          class="text-sm font-bold text-ink-50 hover:underline"
        >
          {author.name}
        </button>
        {#if author.isApp}
          <span class="rounded bg-white/10 px-1 text-[9px] font-medium tracking-wide text-ink-400">
            App
          </span>
        {/if}
        <!-- How long ago rather than what time it was: in a thread you are
             taking part in, that is the question being asked. -->
        <time
          datetime={posted.toISOString()}
          title={fullTime(posted)}
          class="text-[11px] text-ink-500"
        >
          {relativeTime(posted, now)}
        </time>
      </header>
    {/if}

    {#if message.subtype === 'channel_join' || message.subtype === 'channel_leave'}
      <!-- Not a message anyone wrote. Said in a line rather than given the
           full treatment, so a thread is not padded out with arrivals. -->
      <p class="text-[11px] text-ink-500">
        {author.name}
        {message.subtype.replace('channel_', '')}ed the channel
      </p>
    {:else}
      <SlackRichText {nodes} {users} {groups} edited={message.edited} {onOpenUrl} />
      <SlackFiles files={message.files} attachments={message.attachments} {onOpenUrl} />
    {/if}

    {#if message.reactions.length > 0}
      <SlackReactions
        reactions={message.reactions}
        {me}
        {users}
        disabled={readOnly}
        onToggle={(name, on) => onToggleReaction(message.ts, name, on)}
      />
    {/if}
  </div>

  {#if !readOnly && message.reactions.length === 0}
    <!-- Slack's hover toolbar, reduced to the one thing in it this app can do.
         Floating rather than in the flow, so a message nobody has reacted to
         costs no height for a control that is not there — which is most
         messages, and the difference between a thread that breathes and one
         padded out with empty grey circles.

         `focus-within` as well as hover, or the button would be unreachable
         from the keyboard. -->
    <div
      class="absolute top-1 right-3 opacity-0 transition-opacity group-hover/message:opacity-100
             focus-within:opacity-100"
    >
      <SlackAddReaction
        placement="below"
        onPick={(name) => onToggleReaction(message.ts, name, true)}
      />
    </div>
  {/if}

  {#if cardOpen && profile}
    <!-- The profile, for the question a name in a thread most often raises:
         who is this and what do they do. Dismissed by clicking the name again
         rather than by a scrim, because it is small and harmless. -->
    <div
      class="absolute top-8 left-12 z-30 flex w-64 gap-3 rounded-lg glass-scrim p-3 shadow-xl
             ring-1 ring-white/15"
    >
      <SlackAvatar src={profile.avatarLarge} name={profile.name} size="size-12" />
      <div class="min-w-0">
        <p class="truncate text-sm font-medium text-ink-100">{profile.realName}</p>
        {#if profile.handle}
          <p class="truncate text-[11px] text-ink-400">@{profile.handle}</p>
        {/if}
        {#if profile.title}
          <p class="mt-1 text-[11px] leading-snug text-ink-400">{profile.title}</p>
        {/if}
        {#if profile.deleted}
          <p class="mt-1 text-[11px] text-amber-300">No longer in the workspace</p>
        {/if}
      </div>
    </div>
  {/if}
</article>
