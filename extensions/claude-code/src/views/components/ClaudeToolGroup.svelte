<script lang="ts">
  import type { ClaudeItem } from '../../main/events'
  import ClaudeToolCard from './ClaudeToolCard.svelte'

  /**
   * A run of tool calls, as one line.
   *
   * What the model did between two things it said is usually not what the
   * reader is following — they are following the argument, and six cards for
   * six greps push it off the screen. So a run of calls collapses to a sentence
   * about the run, and opens if it turns out to matter.
   *
   * Consecutive rather than all of them: the gap between two runs is a sentence
   * the model wrote, and that sentence is what the run was in aid of. Grouping
   * across it would put work under the wrong explanation.
   */
  type Props = { items: ClaudeItem[] }
  const { items }: Props = $props()

  let open = $state(false)

  const running = $derived(items.some((item) => item.status === 'running'))
  const failed = $derived(items.some((item) => item.status === 'error'))

  /** The last segment of a path, for naming a file change in the summary. */
  function basename(item: ClaudeItem): string | null {
    const path = item.input.file_path ?? item.input.notebook_path
    if (typeof path !== 'string' || path === '') return null
    return path.split('/').filter(Boolean).at(-1) ?? null
  }

  const plural = (count: number, one: string): string =>
    count === 1 ? `1 ${one}` : `${count} ${one}s`

  /**
   * What this run did, in the order the clauses read best.
   *
   * File changes first and by name, because that is the part with consequences
   * and the part worth recognising without opening anything. Everything else is
   * counted rather than named.
   */
  const summary = $derived.by(() => {
    // Claude writes a line about what it is doing and why on the calls that
    // take one — `description` on Bash, on Task. When a run is a single such
    // call, that sentence is better than anything countable: it says what the
    // command was for, where a count only says there was one.
    if (items.length === 1) {
      const described = items[0]!.input.description
      if (typeof described === 'string' && described.trim() !== '') return described
    }

    const by = (kind: ClaudeItem['kind']): ClaudeItem[] =>
      items.filter((item) => item.kind === kind)

    const clauses: string[] = []
    const changes = by('file-change')
    if (changes.length === 1) {
      const name = basename(changes[0]!)
      const wrote = changes[0]!.toolName.toLowerCase() === 'write'
      clauses.push(name ? `${wrote ? 'Wrote' : 'Edited'} ${name}` : 'Edited a file')
    } else if (changes.length > 1) {
      clauses.push(`Edited ${plural(changes.length, 'file')}`)
    }

    const commands = by('command')
    if (commands.length > 0) clauses.push(`ran ${plural(commands.length, 'command')}`)
    const reads = by('file-read')
    if (reads.length > 0) clauses.push(`read ${plural(reads.length, 'file')}`)
    const searches = by('search')
    if (searches.length > 0) clauses.push(`searched ${plural(searches.length, 'time')}`)
    const tasks = by('task')
    if (tasks.length > 0) clauses.push(`ran ${plural(tasks.length, 'subagent')}`)
    const rest = by('tool')
    if (rest.length === 1) clauses.push(rest[0]!.toolName)
    else if (rest.length > 1) clauses.push(`used ${plural(rest.length, 'tool')}`)

    if (clauses.length === 0) return `Ran ${plural(items.length, 'tool')}`
    // Only the first clause starts a sentence; the rest were written to follow.
    return (
      clauses[0]!.charAt(0).toUpperCase() +
      clauses[0]!.slice(1) +
      clauses
        .slice(1)
        .map((clause) => `, ${clause}`)
        .join('')
    )
  })

  /**
   * Lines added and removed across this run's file changes.
   *
   * Counted from the arguments rather than from the disk, so it says what the
   * model asked for rather than what the file ended up as — which is the same
   * thing unless something else wrote to it, and is the only number available
   * without reading every file back.
   */
  const lines = (text: unknown): number =>
    typeof text === 'string' && text !== '' ? text.split('\n').length : 0

  const diff = $derived.by(() => {
    let added = 0
    let removed = 0
    for (const item of items) {
      if (item.kind !== 'file-change') continue
      if (item.toolName.toLowerCase() === 'write') {
        added += lines(item.input.content)
        continue
      }
      added += lines(item.input.new_string)
      removed += lines(item.input.old_string)
    }
    return added === 0 && removed === 0 ? null : { added, removed }
  })
</script>

<div>
  <button
    type="button"
    onclick={() => (open = !open)}
    aria-expanded={open}
    class="group/run flex w-full items-center gap-1.5 rounded py-0.5 text-left text-xs
           text-ink-500 select-none hover:text-ink-300"
  >
    {#if running}
      <span class="icon-[ph--circle-notch] shrink-0 animate-spin text-xs" aria-hidden="true"></span>
    {:else if failed}
      <span class="icon-[ph--warning] shrink-0 text-xs text-red-400/70" aria-hidden="true"></span>
    {/if}

    <span class="min-w-0 truncate">{summary}</span>

    {#if diff}
      <span class="shrink-0 font-mono text-[11px]">
        <span class="text-emerald-400/80">+{diff.added}</span>
        <span class="text-red-400/80">-{diff.removed}</span>
      </span>
    {/if}

    <!-- Points along when shut and down when open, the way a disclosure does.
         It is the only affordance on the row, so it stays visible rather than
         appearing on hover. -->
    <span
      class="icon-[ph--caret-right] shrink-0 text-[11px] transition-transform
             {open ? 'rotate-90' : ''}"
      aria-hidden="true"
    ></span>
  </button>

  {#if open}
    <div class="mt-1 flex flex-col gap-1.5 pl-1">
      {#each items as item (item.id)}
        <ClaudeToolCard {item} />
      {/each}
    </div>
  {/if}
</div>
