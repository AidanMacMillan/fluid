<script lang="ts">
  import type { TaskFact } from '../../../main/db/schema'
  import type { TaskActionInfo } from '../../../main/task-actions'
  import Avatar from './Avatar.svelte'

  /**
   * What is known about a task's work, above the tabs it opens on, and what
   * can be done about it from here.
   *
   * A panel of labelled values — it knows no more about what `Team` means than
   * the column that stores it does (see `TaskFact`). Whoever opened the task
   * decided what belongs here; this draws it in the order it was given.
   *
   * The values are read rather than used, so none of them is a control. A name
   * here is the answer to "who do I ask", and asking them is done in the thread
   * tab underneath — a row that looked clickable would promise something the
   * panel has no way to do. The controls are the buttons under the values, and
   * only those: whatever the task's type offers (see `TaskAction`), each doing
   * exactly what its label says.
   *
   * The face beside a name is drawn by `Avatar`, which is where the app
   * keeps the one behaviour this needs: a picture, or the initial of the name
   * when the picture will not load.
   */
  type Props = {
    /**
     * In the order to read them. Either this or `actions` has something in it
     * — the sidebar guards that.
     */
    facts: TaskFact[]
    actions: TaskActionInfo[]
    /** The id of the action under way, which holds every button until it ends. */
    running: string | null
    /** What the last press said when it failed. */
    error: string | null
    onRun: (actionId: string) => void
  }

  const { facts, actions, running, error, onRun }: Props = $props()
</script>

<!-- The app's card, quietened for a column this narrow: the same translucent
     ground and hairline ring the settings cards wear, at the sidebar's own text
     sizes. The ring is what keeps it from reading as a hovered tab — the rows
     below light up to a similar white, and none of them has an edge. -->
<div class="mb-1.5 shrink-0 rounded-lg bg-white/5 px-2 py-1.5 ring-1 ring-white/10">
  {#if facts.length > 0}
    <dl aria-label="About this work">
      {#each facts as fact, index (fact.label)}
        <!-- Above its value rather than beside it, which costs a line each and buys
         the one thing this panel is short of: width. A label and a value side by
         side in a column this narrow leave a value column of sixty pixels, and
         sixty pixels breaks `Vandenbroucke` in half — while stacked, the same
         name and the face beside it sit on one line at the sidebar's usual
         width, and on two at its narrowest. -->
        <dt class="text-[0.625rem] leading-4 text-ink-500" class:mt-1={index > 0}>{fact.label}</dt>
        <dd class="flex min-w-0 items-center gap-1.5">
          {#if fact.image}
            <!-- Small enough to sit on the line it belongs to, and no larger: this
             is a face to recognise, not a portrait. A 48px picture is the right
             two-for-one for it on the displays this runs on.

             Centred against the name rather than its first line, because with a
             face this size the two read as one row — and on the rare name that
             wraps, a picture pinned to the top of two lines looks dropped. -->
            <Avatar src={fact.image} name={fact.value} size="size-5" />
          {/if}
          <!-- Wrapped rather than truncated, for the reason the task's title above
           is: a value cut short is worse than one on two lines, and a panel
           nobody can point at has no hover to recover the rest from.

           Broken at spaces though, unlike that title — `wrap-break-word` splits
           a word only when the word by itself cannot fit. These are mostly
           people's names, and a name should come apart down the middle only on
           a sidebar dragged narrower than the name itself. -->
          <span class="min-w-0 text-[0.6875rem] leading-4 wrap-break-word text-ink-300"
            >{fact.value}</span
          >
        </dd>
      {/each}
    </dl>
  {/if}

  {#if actions.length > 0}
    <!-- Under the values, since they are what the buttons are decided on. Side
       by side while they fit and wrapping when they do not: two short verbs,
       or three emoji, sit on one line at the sidebar's usual width. -->
    <div class="flex flex-wrap gap-1.5" class:mt-2={facts.length > 0}>
      {#each actions as action, index (action.id)}
        <!-- Every one wears a faint ground and a hairline at rest, unlike the
           sidebar's other controls, which stay invisible until hovered. Those
           sit in rows where their place says what they are; these sit under
           values nobody can press, and a bare emoji under a name reads as one
           more value rather than as something to press.

           The first is the one the type leads with, and wears the stronger
           ground the settings panel gives its own leading button — when it is
           a word. A row of emoji has no lead: each is its own answer, and a
           stronger one reads as already chosen, the way a reacted pill does.
           At rest they look like the pills nobody has reacted with yet.

           A greyed-out one still takes the pointer, unlike the settings
           panel's: its tooltip is the hint saying why it is greyed out, and a
           button that cannot be hovered cannot say. It just does not light up. -->
        <!-- An icon stands in for the label, which then only names the button
           to a screen reader. While it runs the icon pulses rather than
           growing an ellipsis, which it has nowhere to put. -->
        <button
          type="button"
          title={action.hint}
          aria-label={action.icon ? action.label : undefined}
          disabled={!action.enabled || running !== null}
          onclick={() => onRun(action.id)}
          class="flex h-6 min-w-0 flex-1 items-center justify-center rounded-md glass-control px-2
               text-[0.6875rem] font-medium ring-1 ring-glow/10 ring-inset
               disabled:cursor-default disabled:opacity-40
               {index === 0 && !action.icon
            ? 'bg-glow/15 text-ink-100 hover:bg-glow/20 disabled:hover:bg-glow/15'
            : 'bg-glow/6 text-ink-300 hover:bg-glow/12 hover:text-ink-100 disabled:hover:bg-glow/6 disabled:hover:text-ink-300'}"
        >
          {#if action.icon}
            {#if 'image' in action.icon}
              <img
                src={action.icon.image}
                alt=""
                class="size-4 object-contain"
                class:animate-pulse={running === action.id}
              />
            {:else}
              <span class="text-sm leading-none" class:animate-pulse={running === action.id}
                >{action.icon.emoji}</span
              >
            {/if}
          {:else}
            {running === action.id ? `${action.label}…` : action.label}
          {/if}
        </button>
      {/each}
    </div>
    {#if error}
      <!-- Wrapped, like the values: a failure cut short is one the user cannot
         act on, and the extension's sentence says which step it stopped at. -->
      <p class="mt-1.5 text-[0.6875rem] leading-4 wrap-break-word text-red-400">{error}</p>
    {/if}
  {/if}
</div>
