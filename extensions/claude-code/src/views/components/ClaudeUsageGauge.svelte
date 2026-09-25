<script lang="ts">
  import type { ClaudeContext, ClaudeCredits, ClaudeUsageWindow } from '../../main/events'

  /**
   * How much room is left, in one ring and a panel behind it.
   *
   * Shaped after Claude Code's desktop app, which puts two different questions
   * in one place because they are asked together: how full this conversation's
   * context window is, and how much of the plan's allowance is left. The first
   * changes every turn and is the one worth having always visible, so it is
   * what the ring draws; the rest is a click away.
   *
   * Everything here is the CLI's own data. Nothing is inferred and nothing is
   * drawn for a row the session did not report, which is why an account with no
   * plan behind it — an API key, one of the cloud providers — gets a panel with
   * only a context window in it rather than a set of empty gauges.
   */
  type Props = {
    context: ClaudeContext | null
    windows: ClaudeUsageWindow[]
    credits: ClaudeCredits | null
    /** `team`, `max`, `pro` — named beside the limits, as desktop does. */
    subscription: string | null
    /** What this session has cost so far, as the CLI estimates it. */
    costUsd: number | null
    /** Whether a turn is in flight, for the arc that turns on top of the ring. */
    running: boolean
  }
  const { context, windows, credits, subscription, costUsd, running }: Props = $props()

  let open = $state(false)

  /**
   * The CLI names a colour rather than giving one, so the names are mapped here
   * — the palette belongs to the app, not to the process it is talking to.
   *
   * This is the one place in the pane that draws in colours other than the
   * theme's ink, and it earns them the way the diff counts do: the segments are
   * categories, and a bar of five greys says nothing a single grey would not.
   */
  const SEGMENTS: Record<string, string> = {
    claude: 'bg-orange-400/80',
    warning: 'bg-amber-300/80',
    error: 'bg-red-400/80',
    success: 'bg-emerald-400/80',
    inactive: 'bg-zinc-500/60'
  }
  const segmentColour = (name: string): string => SEGMENTS[name] ?? 'bg-sky-400/70'

  /** `230k`, `1M` — the units the CLI's own context report is read in. */
  function tokens(count: number): string {
    if (count >= 1_000_000) {
      const millions = count / 1_000_000
      return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : millions.toFixed(1)}M`
    }
    if (count >= 1000) return `${Math.round(count / 1000)}k`
    return String(count)
  }

  function money(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
    } catch {
      // A currency code the platform does not know. The number is the part that
      // matters and it should still be shown.
      return amount.toFixed(2)
    }
  }

  /**
   * When a window rolls over, in the terms it is worth knowing in.
   *
   * How long is left for anything inside a day, because that is a number you
   * plan the next hour around; the day and time beyond that, because "in 5
   * days" is not how anybody thinks about next Sunday.
   */
  function resets(at: string, now: number): string {
    const when = new Date(at).getTime()
    if (Number.isNaN(when)) return ''
    const minutes = Math.round((when - now) / 60_000)
    if (minutes <= 0) return 'Resetting'
    if (minutes < 60) return `Resets in ${minutes} min`
    if (minutes < 24 * 60) {
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `Resets in ${hours} hr` : `Resets in ${hours} hr ${rest} min`
    }
    return `Resets ${new Date(when).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })}`
  }

  /** Ticks only while the panel is open: nothing else here reads the clock. */
  let now = $state(Date.now())
  $effect(() => {
    if (!open) return undefined
    const tick = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(tick)
  })

  /**
   * What the ring shows: the context window, or the fullest limit when the
   * session has not reported one yet. A ring that stayed empty until the first
   * turn would read as "nothing used" rather than "not known yet".
   */
  const filled = $derived(
    context?.usedPercent ?? windows.reduce((most, window) => Math.max(most, window.usedPercent), 0)
  )

  // The ring is an SVG circle drawn from its dash array: one stroke for the
  // track, one for the part used, rotated so it starts at the top.
  const RADIUS = 6.5
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS

  const tone = $derived(
    filled >= 90 ? 'stroke-red-400' : filled >= 70 ? 'stroke-amber-300' : 'stroke-sky-400'
  )

  /**
   * How wide to draw a bar for a percentage.
   *
   * A floor, so a window a fraction of a percent into its allowance still shows
   * something rather than reading as untouched — but not at zero, where a
   * sliver would be saying the opposite of what the number beside it says.
   */
  const width = (percent: number): number => (percent <= 0 ? 0 : Math.max(1, percent))

  const summary = $derived(
    context
      ? `Context ${Math.round(context.usedPercent)}% of ${tokens(context.maxTokens)}`
      : 'Usage'
  )
</script>

<div class="relative">
  <button
    type="button"
    aria-label="Usage"
    aria-haspopup="dialog"
    aria-expanded={open}
    title={summary}
    onclick={() => (open = !open)}
    class="grid size-6 shrink-0 place-items-center rounded-md glass-control"
  >
    <svg viewBox="0 0 16 16" class="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={RADIUS} fill="none" class="stroke-white/15" stroke-width="2.5" />
      {#if filled > 0}
        <!-- Drawn only when there is something to draw. A round cap on a
             zero-length dash is not nothing: SVG paints it as a dot, so an
             untouched gauge would show a mark exactly where "some of it is
             used" belongs. -->
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          class={tone}
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray="{(CIRCUMFERENCE * Math.min(100, filled)) / 100} {CIRCUMFERENCE}"
        />
      {/if}
      {#if running}
        <!-- A short arc turning over the top of the gauge, so one control says
             both "this is how full it is" and "something is happening" rather
             than a spinner appearing beside it and pushing the row along. -->
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          class="origin-center animate-spin stroke-ink-100/70"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray="{CIRCUMFERENCE / 6} {CIRCUMFERENCE}"
        />
      {/if}
    </svg>
  </button>

  {#if open}
    <!-- Closes on a click anywhere else, which for a panel with no field in it
         means a click that moves focus off it. -->
    <button
      type="button"
      aria-label="Close"
      onclick={() => (open = false)}
      class="fixed inset-0 z-30 cursor-default"
    ></button>

    <div
      role="dialog"
      aria-label="Usage"
      class="absolute right-0 bottom-full z-40 mb-1.5 w-80 rounded-lg glass-popover p-3 shadow-xl
             ring-1 ring-white/15"
    >
      {#if context}
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-xs text-ink-400">Context window</span>
          <span class="text-xs text-ink-300">
            {tokens(context.usedTokens)} / {tokens(context.maxTokens)}
            <span class="text-ink-500">({Math.round(context.usedPercent)}%)</span>
          </span>
        </div>
        <!-- One bar, in the CLI's own order, showing what the window is full
             of rather than only how full it is: a window mostly taken by tool
             schemas is a different problem from one taken by the conversation,
             and the fix is different too. -->
        <div class="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/10">
          {#each context.segments as segment (segment.name)}
            {#if segment.kind !== 'free'}
              <span
                class={segmentColour(segment.colour)}
                style:width="{(segment.tokens / context.maxTokens) * 100}%"
                title="{segment.name}: {tokens(segment.tokens)}"
              ></span>
            {/if}
          {/each}
        </div>
      {/if}

      {#if windows.length > 0 || credits}
        {#if context}
          <div class="my-2.5 h-px bg-white/10"></div>
        {/if}

        <p class="mb-1.5 text-xs text-ink-400">
          Your usage limits
          {#if subscription}
            <span class="text-ink-500">
              · {subscription.charAt(0).toUpperCase() + subscription.slice(1)}
            </span>
          {/if}
        </p>

        {#each windows as window (window.id)}
          <div class="mt-2 first:mt-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="min-w-0 truncate text-xs text-ink-300">{window.label}</span>
              <span class="flex shrink-0 items-baseline gap-2 text-[11px] text-ink-500">
                {#if window.resetsAt}
                  <span>{resets(window.resetsAt, now)}</span>
                {/if}
                <span class="text-ink-400">{Math.round(window.usedPercent)}%</span>
              </span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <span
                class="block h-full rounded-full {window.usedPercent >= 90
                  ? 'bg-red-400'
                  : window.usedPercent >= 70
                    ? 'bg-amber-300'
                    : 'bg-sky-400'}"
                style:width="{width(window.usedPercent)}%"
              ></span>
            </div>
          </div>
        {/each}

        {#if credits}
          <div class="mt-2">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs text-ink-300">Usage credits</span>
              <span class="text-[11px] text-ink-400">
                {money(credits.usedUsd, credits.currency)}
                {#if credits.limitUsd !== null}
                  <span class="text-ink-500">of {money(credits.limitUsd, credits.currency)}</span>
                {/if}
              </span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <span
                class="block h-full rounded-full bg-sky-400"
                style:width="{width(credits.usedPercent)}%"
              ></span>
            </div>
          </div>
        {/if}
      {/if}

      {#if costUsd !== null}
        <div class="my-2.5 h-px bg-white/10"></div>
        <div class="flex items-baseline justify-between gap-2">
          <!-- The CLI's own estimate for this conversation, which is a
               different question from the account's: it is the only number here
               that says how heavy *this* session has been. -->
          <span class="text-xs text-ink-400">This session</span>
          <span class="text-[11px] text-ink-400">
            ${costUsd < 0.01 ? costUsd.toFixed(3) : costUsd.toFixed(2)}
          </span>
        </div>
      {/if}

      {#if !context && windows.length === 0 && !credits && costUsd === null}
        <p class="text-xs text-ink-500">Nothing to report yet.</p>
      {/if}
    </div>
  {/if}
</div>
