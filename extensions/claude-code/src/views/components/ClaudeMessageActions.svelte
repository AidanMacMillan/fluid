<script lang="ts">
  /**
   * The row that appears under a turn when the pointer is over it.
   *
   * Hidden until then, because none of it is part of reading the conversation —
   * it is what to do about a turn once you have read it, and a transcript with
   * four buttons against every paragraph is a worse transcript.
   *
   * The time is here rather than always-on for the same reason. It is worth
   * having and almost never worth the line it would take.
   */
  type Props = {
    /** When this turn arrived. See the note on `ClaudeEntry`. */
    at: number
    /** Ticks while the pane is open, so "just now" becomes "2 minutes ago". */
    now: number
    /** What to copy. */
    text: string
    /**
     * The user turn a revert or a fork would name, if there is one.
     *
     * Absent for a conversation read back from a transcript written before
     * turns carried ids, and for anything the CLI wrote itself. Both buttons
     * are hidden rather than disabled in that case: a control that can never
     * work is not a control.
     */
    anchor: { uuid: string; text: string } | undefined
    /** Whether a turn is in flight. Reverting mid-answer is refused. */
    running: boolean
    /**
     * Whether reverting is offered here at all.
     *
     * Only on the user's own turns, which is what Claude Code's desktop app
     * does and what the operation actually is: a checkpoint is kept against a
     * question, not against an answer. Offered on an answer it would read as
     * "undo this reply", which is not a thing that can be done — the reply is
     * in the conversation either way, and only the files come back.
     */
    canRevert: boolean
    /** Right for the user's own turns, left for Claude's, matching the turn. */
    align: 'left' | 'right'
    onRevert: (uuid: string) => void
    onFork: (anchor: { uuid: string; text: string }) => void
  }
  const { at, now, text, anchor, running, canRevert, align, onRevert, onFork }: Props = $props()

  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  function copy(): void {
    void navigator.clipboard.writeText(text).then(() => {
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 1200)
    })
  }

  /**
   * How long ago, in the words somebody would actually use.
   *
   * Coarse on purpose: the difference between 40 and 50 seconds ago is not a
   * difference anybody is acting on, and a number that keeps changing draws the
   * eye to the one part of the row that does not matter.
   */
  const ago = $derived.by(() => {
    const seconds = Math.max(0, Math.round((now - at) / 1000))
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
    const days = Math.round(hours / 24)
    return days === 1 ? 'yesterday' : `${days} days ago`
  })

  const button =
    'glass-control grid size-5 place-items-center rounded text-ink-500 hover:text-ink-200 ' +
    'disabled:pointer-events-none disabled:text-ink-700'
</script>

<div
  class="mt-1 flex items-center gap-0.5 text-[11px] text-ink-600 opacity-0 transition-opacity
         select-none group-hover/turn:opacity-100 focus-within:opacity-100
         {align === 'right' ? 'justify-end' : ''}"
>
  <span class="mr-1">{ago}</span>

  <button type="button" class={button} onclick={copy} aria-label="Copy" title="Copy">
    <span class="{copied ? 'icon-[ph--check]' : 'icon-[ph--copy]'} text-xs" aria-hidden="true"
    ></span>
  </button>

  {#if anchor && canRevert}
    <button
      type="button"
      class={button}
      disabled={running}
      onclick={() => onRevert(anchor.uuid)}
      aria-label="Revert files to before this turn"
      title={running
        ? 'Wait for the answer to finish before reverting'
        : 'Revert files to before this turn'}
    >
      <span class="icon-[ph--arrow-counter-clockwise] text-xs" aria-hidden="true"></span>
    </button>
  {/if}

  {#if anchor}
    <button
      type="button"
      class={button}
      onclick={() => onFork(anchor)}
      aria-label="Fork the conversation here"
      title="Fork the conversation here into a new tab"
    >
      <span class="icon-[ph--git-branch] text-xs" aria-hidden="true"></span>
    </button>
  {/if}
</div>
