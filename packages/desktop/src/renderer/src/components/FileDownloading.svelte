<script lang="ts">
  import type { LiveDownload } from '../lib/workspace.svelte'

  /**
   * What a file pane shows while the file is still arriving. The tab exists
   * from the moment the download starts — that is the point of it — so opening
   * the tab has to show something, and a half-written file handed to a viewer
   * would be a broken image rather than a file on its way.
   */
  type Props = { download: LiveDownload }

  const { download }: Props = $props()

  /** Null when the server never named a length: there is no fraction to draw. */
  const fraction = $derived(
    download.totalBytes > 0 ? Math.min(1, download.receivedBytes / download.totalBytes) : null
  )
</script>

<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-ink-500">
  <span class="icon-[ph--arrow-circle-down] text-3xl" aria-hidden="true"></span>

  <!-- The same bar the tab's row draws, at a size that can carry a figure
       beside it. Rounded and clipped by the track it sits in. -->
  <div class="h-1 w-48 max-w-full overflow-hidden rounded-full bg-white/10">
    <div
      class="h-full w-full download-bar {fraction === null ? 'download-bar-sweep' : ''}"
      style={fraction === null ? undefined : `transform: scaleX(${fraction})`}
    ></div>
  </div>

  <p class="text-xs">
    {#if download.paused}
      Download paused
    {:else if fraction === null}
      Downloading…
    {:else}
      Downloading… {Math.round(fraction * 100)}%
    {/if}
  </p>
</div>
