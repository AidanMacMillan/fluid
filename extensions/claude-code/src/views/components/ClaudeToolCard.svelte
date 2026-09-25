<script lang="ts">
  import type { ClaudeItem } from '../../main/events'

  /**
   * One tool call.
   *
   * Deliberately one component for every kind rather than one per kind. What
   * differs between a command and a file read is the glyph, the wording and
   * what counts as the one line worth showing — all of which are data — while
   * the shape is the same: a row that says what is happening, and output that
   * can be opened if it matters. A kind with no glyph of its own still draws as
   * itself, which is why a tool added to Claude Code next month needs nothing
   * here.
   */
  type Props = { item: ClaudeItem }
  const { item }: Props = $props()

  let open = $state(false)

  // Written out in full rather than assembled: the Tailwind plugin generates
  // icons by scanning source text, so `icon-[ph--${name}]` produces nothing.
  const GLYPHS: Record<ClaudeItem['kind'], string> = {
    command: 'icon-[ph--terminal-window]',
    'file-change': 'icon-[ph--pencil-simple]',
    'file-read': 'icon-[ph--file-text]',
    search: 'icon-[ph--magnifying-glass]',
    task: 'icon-[ph--users-three]',
    todo: 'icon-[ph--list-checks]',
    tool: 'icon-[ph--wrench]'
  }

  const glyph = $derived(GLYPHS[item.kind])
  const output = $derived(item.output ?? '')
  const openable = $derived(output !== '')
</script>

<div class="rounded-md bg-black/15 ring-1 ring-white/5">
  <div class="flex items-start gap-2 px-2.5 py-1.5">
    <!-- A box exactly one title-line tall, with the glyph centred in it, so the
         two share a centre line. Nudging the icon down by a pixel instead only
         works for one font size and one line height: the glyph is 14px and the
         title is 11px, and until the line box is stated rather than inherited
         there is no height to centre against. -->
    <span class="grid h-4 shrink-0 place-items-center">
      {#if item.status === 'running'}
        <span class="icon-[ph--circle-notch] animate-spin text-sm text-ink-500" aria-hidden="true"
        ></span>
      {:else if item.status === 'error'}
        <span class="icon-[ph--warning] text-sm text-red-400" aria-hidden="true"></span>
      {:else}
        <span class="{glyph} text-sm text-ink-500" aria-hidden="true"></span>
      {/if}
    </span>

    <div class="min-w-0 flex-1">
      <span class="block text-[11px]/4 font-medium text-ink-400">{item.title}</span>
      {#if item.detail}
        <!-- The tool's own words, not a summary of them: what is being checked
             is exactly what Claude is about to do, and a paraphrase is the
             wrong thing to check. -->
        <p class="truncate font-mono text-[11px] text-ink-300" title={item.detail}>
          {item.detail}
        </p>
      {/if}
    </div>

    {#if openable}
      <button
        type="button"
        onclick={() => (open = !open)}
        aria-expanded={open}
        class="shrink-0 rounded glass-control px-1.5 py-0.5 text-[10px] text-ink-500
               select-none hover:text-ink-200"
      >
        {open ? 'Hide' : 'Output'}
      </button>
    {/if}
  </div>

  {#if open && openable}
    <pre
      class="max-h-64 overflow-auto border-t border-white/5 px-2.5 py-2 font-mono text-[11px]
             leading-relaxed whitespace-pre-wrap text-ink-400">{output}</pre>
  {/if}
</div>
