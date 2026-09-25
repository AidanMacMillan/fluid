<script lang="ts">
  /**
   * Somebody's picture, or the initial of their name where they have none.
   *
   * Slack always has an avatar — it generates one from the initials for anyone
   * who has not uploaded a picture — so the fallback here is for the times the
   * image cannot be fetched at all: the token gone, the proxy refusing, the
   * machine offline. It matters because the alternative is a broken-image glyph
   * beside every message.
   */
  type Props = {
    src: string
    name: string
    /** A Tailwind size class. The letter scales with it. */
    size?: string
    /** An app's avatar is squarer than a person's, the way Slack draws it. */
    app?: boolean
  }

  const { src, name, size = 'size-9', app = false }: Props = $props()

  let broken = $state(false)
  // Reset when the picture changes, so a new one gets its own chance.
  const source = $derived(broken ? '' : src)
  const initial = $derived([...name.trim()][0]?.toUpperCase() ?? '?')
  const rounding = $derived(app ? 'rounded-md' : 'rounded-lg')
</script>

{#if source}
  <img
    {src}
    alt=""
    draggable="false"
    onerror={() => (broken = true)}
    class="{size} {rounding} shrink-0 bg-white/5 object-cover"
  />
{:else}
  <span
    class="{size} {rounding} grid shrink-0 place-items-center bg-white/10 text-xs font-medium
           text-ink-300"
    aria-hidden="true"
  >
    {initial}
  </span>
{/if}
