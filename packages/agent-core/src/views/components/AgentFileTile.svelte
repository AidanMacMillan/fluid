<script lang="ts">
  /**
   * One attached file, as a tile.
   *
   * The same drawing in the composer and in the transcript, which is the point:
   * a file looks the same before it is sent as after, so what was attached is
   * recognisable rather than a path to be read back. An image shows itself; a
   * file that cannot be shown says its name.
   *
   * What differs between the two places is only what a tile can do — the
   * composer's can be taken off again, the transcript's cannot — and that is
   * settled by which handlers are passed.
   */
  type Props = {
    name: string
    /** The picture, when there is one. Null draws the file as a named card. */
    src: string | null
    /** Opens it full size. Absent for a tile with nothing to open. */
    onOpen?: () => void
    /** Takes it off the turn being written. Absent once the turn has been sent. */
    onRemove?: () => void
  }
  const { name, src, onOpen, onRemove }: Props = $props()
</script>

<div
  title={name}
  class="group/file relative size-20 shrink-0 overflow-hidden rounded-md bg-white/5
         ring-1 ring-white/10"
>
  {#if src && onOpen}
    <!-- The thumbnail is a crop, so the tile is a way in to the whole picture
         as well as a reminder that it is there. -->
    <button type="button" title="{name} — click to view" onclick={onOpen} class="size-full">
      <img {src} alt={name} class="size-full object-cover" />
    </button>
  {:else if src}
    <img {src} alt={name} class="size-full object-cover" />
  {:else}
    <div class="flex size-full flex-col items-center justify-center gap-1 px-1.5">
      <span class="icon-[ph--file-text] text-lg text-ink-500" aria-hidden="true"></span>
      <span class="w-full truncate text-center text-[10px] text-ink-400">{name}</span>
    </div>
  {/if}

  {#if onRemove}
    <!-- On hover, and in the corner: the tile is mostly there to be looked at,
         and a button drawn over it permanently is in front of the thing it is a
         button for. -->
    <button
      type="button"
      aria-label="Remove {name}"
      onclick={onRemove}
      class="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-black/70
             text-ink-300 opacity-0 select-none group-hover/file:opacity-100
             hover:text-ink-100 focus-visible:opacity-100"
    >
      <span class="icon-[ph--x] text-[10px]" aria-hidden="true"></span>
    </button>
  {/if}
</div>
