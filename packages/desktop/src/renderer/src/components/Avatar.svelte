<script lang="ts">
  /**
   * Somebody's picture, or the initial of their name where they have none.
   *
   * The fallback is mostly for the times the image cannot be fetched at all:
   * the token gone, the proxy refusing, the machine offline. It matters because
   * the alternative is a broken-image glyph beside every name.
   */
  type Props = {
    src: string
    name: string
    /** A Tailwind size class. The letter scales with it. */
    size?: string
  }

  const { src, name, size = 'size-9' }: Props = $props()

  let broken = $state(false)
  // Reset when the picture changes, so a new one gets its own chance.
  const source = $derived(broken ? '' : src)
  const initial = $derived([...name.trim()][0]?.toUpperCase() ?? '?')
</script>

{#if source}
  <img
    {src}
    alt=""
    draggable="false"
    onerror={() => (broken = true)}
    class="{size} shrink-0 rounded-lg bg-white/5 object-cover"
  />
{:else}
  <span
    class="{size} grid shrink-0 place-items-center rounded-lg bg-white/10 text-xs font-medium
           text-ink-300"
    aria-hidden="true"
  >
    {initial}
  </span>
{/if}
