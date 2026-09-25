<script lang="ts">
  /**
   * What a file pane shows instead of the file. Shared by every viewer so the
   * two ways of having nothing to draw — a format we do not render, and a copy
   * that will not load — read the same wherever they happen.
   */
  type Props = {
    /**
     * `unsupported` is a format the app has no viewer for, which is the common
     * case and not a problem. `unreadable` means the store and the tab's row
     * disagree, which nothing in the app should be able to cause — it is still
     * worth saying rather than leaving a blank frame.
     */
    reason: 'unsupported' | 'unreadable'
  }

  const { reason }: Props = $props()
</script>

<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-ink-500">
  <span class="icon-[ph--file] text-3xl" aria-hidden="true"></span>
  <p class="max-w-xs text-center text-xs">
    {#if reason === 'unreadable'}
      This file could not be read.
    {:else}
      This file type is not supported yet.
    {/if}
  </p>
</div>
