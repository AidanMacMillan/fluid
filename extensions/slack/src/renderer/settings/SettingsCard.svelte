<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * The frame of the settings card: what it connects, how it stands, and a
   * rule under which the controls are drawn. Drawn the same way as the other
   * extensions' integration cards, so the settings window reads as one list.
   */
  let {
    name,
    icon,
    summary,
    badge,
    children
  }: {
    name: string
    icon: string
    /** One line under the name: what connecting it buys. */
    summary: string
    /**
     * The pill at the top right, or null while the first answer is still in
     * flight — it waits rather than guessing.
     */
    badge: { label: string; tone: 'good' | 'warn' | 'idle' } | null
    children: Snippet
  } = $props()

  const TONES = {
    good: { text: 'text-emerald-300', dot: 'bg-emerald-400' },
    warn: { text: 'text-amber-300', dot: 'bg-amber-400' },
    idle: { text: 'text-zinc-400', dot: 'bg-zinc-500' }
  } as const
</script>

<article class="rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
  <header class="flex items-start gap-3">
    <span
      class="{icon} grid size-8 shrink-0 place-items-center rounded-md bg-white/10
             text-lg text-ink-200"
      aria-hidden="true"
    ></span>
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-medium text-ink-100">{name}</h3>
      <p class="mt-0.5 text-xs text-ink-400">{summary}</p>
    </div>

    {#if badge}
      <span
        class="flex shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-2 py-1 text-[11px]
               font-medium {TONES[badge.tone].text}"
      >
        <span class="size-1.5 rounded-full {TONES[badge.tone].dot}" aria-hidden="true"></span>
        {badge.label}
      </span>
    {/if}
  </header>

  <div class="mt-4 border-t border-white/10 pt-4">
    {@render children()}
  </div>
</article>
