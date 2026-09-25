<script lang="ts">
  import type { ClaudeAside } from '../../main/events'
  import ClaudeMarkdown from './ClaudeMarkdown.svelte'

  /**
   * Something the harness did, between the turns.
   *
   * Drawn as a rule with a line of writing on it rather than as a card,
   * because none of these is a thing anybody said and the transcript reads
   * better when that is obvious at a glance. What it is not, deliberately, is
   * a bubble: these arrive wearing the user's role, and a background task
   * reporting back drawn as a turn is a message the reader never sent and
   * cannot make sense of. See ../../main/turns.ts.
   */
  type Props = { aside: ClaudeAside; id: string }
  const { aside, id }: Props = $props()

  let open = $state(false)

  // Written out in full rather than assembled: the Tailwind plugin generates
  // icons by scanning source text, so `icon-[ph--${name}]` produces nothing.
  const GLYPHS: Record<ClaudeAside['kind'], string> = {
    task: 'icon-[ph--tray-arrow-down]',
    command: 'icon-[ph--terminal-window]',
    skill: 'icon-[ph--book-open-text]',
    output: 'icon-[ph--text-align-left]',
    interrupted: 'icon-[ph--hand-palm]',
    summary: 'icon-[ph--arrows-in-line-vertical]',
    image: 'icon-[ph--image]'
  }

  /**
   * An agent's report and a conversation's summary are written to be read —
   * headings, tables, code — and a fold that showed the asterisks would be
   * showing the working. What a command printed is not prose and is left as
   * the characters it printed.
   */
  const prose = $derived(
    aside.kind === 'task' || aside.kind === 'summary' || aside.kind === 'skill'
  )
</script>

<div class="my-1.5 flex flex-col gap-1.5">
  <div class="flex items-center gap-2 text-[10px] text-ink-500">
    <span class="h-px flex-1 bg-white/10"></span>
    <span class="{GLYPHS[aside.kind]} shrink-0 text-xs" aria-hidden="true"></span>
    <!-- Capped rather than cut to a word count, so a long summary keeps its
         ending — the part of "Agent … finished" worth reading is the verb. -->
    <span class="max-w-md truncate text-ink-400" title={aside.label}>{aside.label}</span>
    {#if aside.detail}
      <button
        type="button"
        onclick={() => (open = !open)}
        aria-expanded={open}
        class="shrink-0 rounded glass-control px-1.5 py-0.5 select-none hover:text-ink-200"
      >
        {open ? 'Hide' : 'Show'}
      </button>
    {/if}
    <span class="h-px flex-1 bg-white/10"></span>
  </div>

  {#if open && aside.detail}
    <div class="max-h-96 overflow-auto rounded-md bg-black/15 px-2.5 py-2 ring-1 ring-white/5">
      {#if prose}
        <ClaudeMarkdown source={aside.detail} id="aside-{id}" />
      {:else}
        <pre
          class="font-mono text-[11px] leading-relaxed whitespace-pre-wrap
                 text-ink-400">{aside.detail}</pre>
      {/if}
    </div>
  {/if}
</div>
