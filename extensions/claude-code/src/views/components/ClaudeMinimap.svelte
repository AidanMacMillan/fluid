<script lang="ts">
  /**
   * The rail down the side of a conversation: one tick per message.
   *
   * A transcript is mostly tool cards, and tool cards are mostly noise once
   * they have run — so scrolling back through a long session to find the thing
   * you asked an hour ago means dragging past a great deal that is not it. The
   * rail leaves all of that out and draws only what was said: a tick for each
   * turn, in order, the whole session at once. How many there are and how far
   * back they go is then a glance rather than a scroll, and any of them is one
   * click away.
   *
   * Which ticks are lit says what is on screen. That is the part that makes it
   * a map rather than a table of contents: the lit stretch moves as you scroll,
   * so where you are in the conversation is readable without leaving where you
   * are in the conversation.
   *
   * Draws nothing of its own about the transcript — `marks` and `visible` are
   * worked out by the pane, which owns the scroller the answers come from.
   */
  type Mark = {
    id: string
    speaker: 'user' | 'claude'
    /** The opening words, for the tooltip. A tick alone says nothing. */
    label: string
  }

  type Props = {
    marks: Mark[]
    /** Ids of the marks whose messages are on screen, lit rather than dimmed. */
    visible: Set<string>
    onJump: (id: string) => void
  }
  const { marks, visible, onJump }: Props = $props()

  /**
   * How much height one tick gets, gap included.
   *
   * The rail's whole claim is that it holds the entire session, so the ticks
   * are sized to the rail rather than the rail to the ticks: they open out to
   * `UNIT_MAX` when there is room to spare and close up as the conversation
   * grows. `UNIT_MIN` is where that stops — below a pixel of paint and a pixel
   * of gap there is no tick left — and a session long enough to reach it gets a
   * rail that scrolls instead.
   */
  const UNIT_MAX = 8
  const UNIT_MIN = 2

  let rail = $state<HTMLElement | null>(null)
  let height = $state(0)

  const unit = $derived(
    marks.length === 0
      ? UNIT_MAX
      : Math.max(UNIT_MIN, Math.min(UNIT_MAX, Math.floor(height / marks.length)))
  )
  /** The painted part of a row. What is left over is the gap to the next one. */
  const bar = $derived(Math.max(1, unit - 2))

  /**
   * Keeps the lit stretch in the rail's own view.
   *
   * Only ever does anything for a session long enough to have overflowed the
   * rail — the case the whole thing is meant to cope with, where scrolling the
   * transcript to a part of the conversation the rail is not showing would
   * otherwise leave nothing lit at all. `nearest` so it moves the least it can:
   * centring would slide the rail under the pointer on every scroll.
   */
  $effect(() => {
    const element = rail
    const first = marks.find((mark) => visible.has(mark.id))
    if (!element || !first) return
    if (element.scrollHeight <= element.clientHeight) return
    // The rail is the only scrolling ancestor — the transcript's scroller is a
    // sibling — so this cannot pull the conversation itself around.
    element.querySelector(`[data-mark="${CSS.escape(first.id)}"]`)?.scrollIntoView({
      block: 'nearest'
    })
  })
</script>

<!-- Width enough for the tick and the breathing room left of it, and no more:
     this is a gutter, and a gutter that takes a column's worth of space has
     stopped being one.

     No padding down the ends of it, and not only to keep the map honest about
     where the conversation starts and stops: `clientHeight` counts padding in,
     so any here would be height the ticks are sized against and cannot use. -->
<nav
  bind:this={rail}
  bind:clientHeight={height}
  aria-label="Messages in this conversation"
  class="scrollbar-none flex w-5 shrink-0 overflow-y-auto pl-2"
>
  <!-- `m-auto` rather than `justify-center`, which is the one that survives
       overflowing: a centred flex column in a scroll container puts its first
       rows above the scrollable area, where nothing can reach them. -->
  <div class="m-auto flex w-full flex-col">
    {#each marks as mark (mark.id)}
      {@const lit = visible.has(mark.id)}
      <!-- The button is the whole row, gap included, so the target is as big as
           the rail can make it — at full size that is a comfortable 8px, and at
           the other end it is as thin as the tick it aims at.

           Being lit is marked as data rather than as `aria-current`: a dozen
           ticks are on screen at once, and a reader told "current" a dozen
           times has been told nothing. What each one is, its label says. -->
      <button
        type="button"
        data-mark={mark.id}
        title={mark.label}
        aria-label="{mark.speaker === 'user' ? 'You' : 'Claude'}: {mark.label}"
        data-lit={lit || undefined}
        onclick={() => onJump(mark.id)}
        class="group flex shrink-0 items-center {mark.speaker === 'user'
          ? 'justify-end'
          : 'justify-start'}"
        style="height: {unit}px"
      >
        <!-- Who said it, in the two things a tick has to say it with. The short
             ticks are Claude's and the long ones are the user's, hung off
             opposite edges — the same shape the transcript itself has, where a
             turn sits against the right margin and an answer runs the column.
             Colour then carries what is on screen, so the two questions never
             compete for the same cue. -->
        <span
          class="rounded-full transition-colors duration-150 group-hover:bg-ink-100 {lit
            ? mark.speaker === 'user'
              ? 'bg-ink-100/80'
              : 'bg-ink-100/45'
            : mark.speaker === 'user'
              ? 'bg-white/25'
              : 'bg-white/12'}"
          style="height: {bar}px; width: {mark.speaker === 'user' ? '100%' : '55%'}"
        ></span>
      </button>
    {/each}
  </div>
</nav>
