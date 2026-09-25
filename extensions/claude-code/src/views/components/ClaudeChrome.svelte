<script lang="ts">
  import type { ClaudeModel } from '../../shared/protocol'
  import type { ClaudeContext, ClaudeCredits, ClaudeUsageWindow } from '../../main/events'
  import { CLAUDE_EFFORTS, type ClaudeEffort, type ClaudePermissionMode } from '../../shared/tab'
  import ClaudeUsageGauge from './ClaudeUsageGauge.svelte'

  /**
   * The controls for a session, in the strip under its composer.
   *
   * Under rather than over, which is where this app puts a pane's bar and where
   * an earlier version of this put it. The reason for the exception is that
   * these are not a description of the tab the way a browser's address or a
   * terminal's directory is — they are settings for the sentence being typed,
   * and they belong beside it. Claude Code's own desktop app makes the same
   * call, and a session that looks like the thing it is a session of is worth
   * more here than local consistency.
   */
  type Effort = ClaudeEffort
  type Mode = ClaudePermissionMode

  type Props = {
    model: string | null
    models: ClaudeModel[]
    effort: Effort
    mode: Mode
    usage: ClaudeUsageWindow[]
    /** What the account is on, named beside its limits. */
    subscription: string | null
    /** Extra usage spend, when the account has any. */
    credits: ClaudeCredits | null
    /** How full the context window is. */
    context: ClaudeContext | null
    /** What this session has cost so far, as the CLI estimates it. */
    costUsd: number | null
    /**
     * Where the session's credential came from. Anything but `none` means an
     * API key rather than the claude.ai login, which is worth saying: the user
     * is being billed per token beside a plan they already pay for.
     */
    apiKeySource: string | null
    /** Whether a turn is in flight, for the arc that turns on the gauge. */
    running: boolean
    /** Whether the transcript is showing the model's thinking as well as its answers. */
    thinking: boolean
    onAttach: () => void
    onModel: (model: string) => void
    onEffort: (effort: Effort) => void
    onMode: (mode: Mode) => void
    onThinking: () => void
  }
  const {
    model,
    models,
    effort,
    mode,
    usage,
    subscription,
    credits,
    context,
    costUsd,
    apiKeySource,
    running,
    thinking,
    onAttach,
    onModel,
    onEffort,
    onMode,
    onThinking
  }: Props = $props()

  const EFFORTS: readonly Effort[] = CLAUDE_EFFORTS
  // In order of how much rope each gives, so the list reads as a dial rather
  // than as a set of unrelated options. `dontAsk` is not here on purpose — see
  // `CLAUDE_MODES` in ../../shared/tab.ts.
  const MODES: { value: Mode; label: string; hint: string }[] = [
    { value: 'plan', label: 'Plan', hint: 'Explore and propose, but do not edit.' },
    { value: 'default', label: 'Ask', hint: 'Ask before anything that is not already allowed.' },
    {
      value: 'auto',
      label: 'Auto',
      hint: 'A model decides the easy calls and asks about the rest.'
    },
    { value: 'acceptEdits', label: 'Accept edits', hint: 'Edit files without asking.' },
    { value: 'bypassPermissions', label: 'Full access', hint: 'Run anything without asking.' }
  ]

  /** Greyed out for a model that has no use for a thinking level. */
  const effortable = $derived(models.find((entry) => entry.id === model)?.supportsEffort !== false)
  const billed = $derived(apiKeySource !== null && apiKeySource !== 'none')
  const label = $derived(models.find((entry) => entry.id === model)?.label ?? model ?? 'Model')

  /**
   * The rows to draw: the session's list, plus the current model when the list
   * does not contain it.
   *
   * It often does not, and not only before the list has been fetched. A session
   * reports the model it resolved to — `claude-opus-5[1m]` — while the list is
   * of aliases, and a tab may have been pinned to an alias this CLI no longer
   * offers. A `select` whose value matches none of its options shows nothing at
   * all, which reads as a broken control rather than as an unfamiliar model.
   */
  const options = $derived.by(() => {
    const current = model ?? ''
    if (current === '' || models.some((entry) => entry.id === current)) return models
    return [
      ...models,
      { id: current, label, resolved: current, description: '', supportsEffort: true }
    ]
  })

  let picked = $state<HTMLSelectElement | null>(null)

  /**
   * Puts the value back on the element whenever either it or the options
   * change.
   *
   * A `value` on a `select` is written to the DOM once, when the attribute
   * changes — and the options here arrive from the session a moment after the
   * control is first drawn. Replacing them leaves the element showing whatever
   * the browser fell back to rather than what this is bound to, and nothing
   * afterwards asks it again.
   */
  $effect(() => {
    void options
    // Only once there is a model to insist on: writing an empty value against a
    // list that has arrived would clear the selection rather than restore it.
    if (picked && model !== null) picked.value = model
  })

  /**
   * The pickers are bare `select`s wearing the row's own clothes.
   *
   * `appearance-none` takes the platform chrome off so they sit in the row as
   * words rather than as boxes, which is the whole look of this strip — but the
   * element stays a `select`, so the menu, the keyboard and the accessible name
   * are the ones the platform gives for free.
   */
  const picker =
    'glass-control h-6 shrink-0 cursor-default appearance-none rounded-md px-1.5 text-[11px] ' +
    'text-ink-400 hover:text-ink-100 disabled:pointer-events-none disabled:text-ink-600'
</script>

<div class="mt-1.5 flex items-center gap-1 select-none">
  <button
    type="button"
    aria-label="Attach files"
    title="Attach files"
    onclick={onAttach}
    class="grid size-6 shrink-0 place-items-center rounded-md glass-control text-ink-400
           hover:text-ink-100"
  >
    <span class="icon-[ph--plus] text-sm" aria-hidden="true"></span>
  </button>

  <select
    class={picker}
    aria-label="Permissions"
    value={mode}
    onchange={(event) => onMode(event.currentTarget.value as Mode)}
  >
    {#each MODES as option (option.value)}
      <option value={option.value} title={option.hint}>{option.label}</option>
    {/each}
  </select>

  <div class="ml-auto flex shrink-0 items-center gap-1">
    {#if billed}
      <span
        class="flex items-center gap-1 text-[10px] text-amber-300"
        title="This session is authenticated with an API key ({apiKeySource}), so it is billed per token rather than drawn from your Claude plan."
      >
        <span class="icon-[ph--credit-card] text-xs" aria-hidden="true"></span>
        Billed
      </span>
    {/if}

    <select
      bind:this={picked}
      class={picker}
      aria-label="Model"
      value={model ?? ''}
      onchange={(event) => onModel(event.currentTarget.value)}
    >
      {#each options as entry (entry.id)}
        <option value={entry.id} title={entry.description}>{entry.label}</option>
      {/each}
    </select>

    <select
      class={picker}
      aria-label="Thinking"
      disabled={!effortable}
      value={effort}
      onchange={(event) => onEffort(event.currentTarget.value as Effort)}
    >
      {#each EFFORTS as level (level)}
        <!-- The value stays as the CLI spells it; only the label is for reading. -->
        <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
      {/each}
    </select>

    <!-- Beside the level rather than in a menu somewhere, because the two are
         the same subject read from either end: one says how hard to think, this
         says whether to watch it happen. `aria-pressed` rather than two labels,
         so what the button says is the thing it does and the state is the
         platform's to announce. -->
    <button
      type="button"
      aria-label="Show thinking"
      aria-pressed={thinking}
      title={thinking ? 'Hide the model’s thinking' : 'Show the model’s thinking'}
      onclick={onThinking}
      class="grid size-6 shrink-0 place-items-center rounded-md glass-control
             {thinking ? 'text-ink-300' : 'text-ink-500'} hover:text-ink-100"
    >
      <!-- A brain, struck through when its thinking is not being shown. The
           strike is what carries the state: the same glyph in two shades of
           grey only answers "is it on?" for somebody who has seen both. -->
      <span class="brain size-3.5" class:struck={!thinking} aria-hidden="true">
        <span class="glyph"><span class="icon-[ph--brain] size-3.5"></span></span>
      </span>
    </button>

    <ClaudeUsageGauge {context} windows={usage} {credits} {subscription} {costUsd} {running} />
  </div>
</div>

<style>
  /*
   * A brain with a line through it, which Phosphor does not ship — it has the
   * glyph and a `*-slash` variant of plenty of others, but not of this one. So
   * the strike is drawn here, at the angle, weight and knocked-out gap its own
   * slashed icons use, and the result reads as one of them rather than as a
   * line that happened to land on an icon.
   *
   * The gap is the part worth the trouble. A bar laid straight over the glyph
   * is legible at the size this was designed at and not at the 14px it is drawn
   * at, where it reads as one more of the brain's own folds.
   */
  .brain {
    position: relative;
    display: grid;
    place-items: center;
  }

  /*
   * Square and exactly the icon's size, so the band cut out of it lines up with
   * the bar over it. Left inline it would be as tall as a line of text, and the
   * gap would sit somewhere above or below the strike rather than under it.
   */
  .glyph {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
  }

  .struck::after {
    content: '';
    position: absolute;
    /* The diagonal of the box, which is the distance a line across it at 45°
       actually has to cover; its width would stop short of both corners. */
    width: 142%;
    height: 1.5px;
    border-radius: 9999px;
    background: currentColor;
    transform: rotate(45deg);
  }

  /*
   * The band the strike sits in, taken out of the glyph under it.
   *
   * On this wrapper rather than on the icon itself because the icon *is* a
   * mask — Iconify draws it as a coloured box masked to the glyph — and a
   * second `mask-image` there would replace that one and leave a bare square.
   */
  .struck .glyph {
    mask-image: linear-gradient(45deg, #000 41%, transparent 41%, transparent 59%, #000 59%);
  }
</style>
