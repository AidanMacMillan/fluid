<script lang="ts">
  import { isWebAddress } from '@fluid/sdk'
  import type { ThreadAttachment, ThreadFile } from '../../main/slack-thread'

  /**
   * What is hanging off a message: files shared into it, and the previews Slack
   * generated for links in it.
   *
   * Pictures are drawn inline because that is what they are for. Everything
   * else is a card naming the file, which opens in Slack — this app has no
   * viewer for a spreadsheet and is not going to pretend otherwise, and Slack's
   * own page for a file is where its comments and its history are anyway.
   */
  type Props = {
    files: ThreadFile[]
    attachments: ThreadAttachment[]
    onOpenUrl: (url: string) => void
  }

  const { files, attachments, onOpenUrl }: Props = $props()

  /**
   * The widest an inline preview is drawn, so one screenshot cannot own the
   * pane. Applied as an inline style rather than a Tailwind class: the class
   * generator scans source text, and a width assembled from a constant at
   * runtime would produce no rule at all.
   */
  const MAX_PREVIEW_WIDTH = 360

  /**
   * Opens a link Slack gave us, if it is one the app will open at all. Every
   * address on this component came off the wire rather than out of the app —
   * see src/main/safe-url.ts.
   */
  function open(url: string | undefined): void {
    if (url !== undefined && isWebAddress(url)) onOpenUrl(url)
  }

  function formatSize(bytes: number): string {
    if (bytes <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let size = bytes
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }
    return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`
  }

  /**
   * The box an image is drawn in, from the dimensions Slack reported for its
   * thumbnail. Reserving the space up front is what stops the thread jumping
   * around as pictures land — which matters most in the one place it is most
   * annoying, a thread you have just scrolled to the bottom of.
   */
  function previewBox(file: ThreadFile): { width: number; height: number } | null {
    if (!file.thumbWidth || !file.thumbHeight) return null
    const scale = Math.min(1, MAX_PREVIEW_WIDTH / file.thumbWidth)
    return {
      width: Math.round(file.thumbWidth * scale),
      height: Math.round(file.thumbHeight * scale)
    }
  }
</script>

{#if files.length > 0 || attachments.length > 0}
  <div class="mt-2 space-y-2">
    {#each files as file (file.id)}
      {#if file.unavailable}
        <p class="flex items-center gap-1.5 text-[11px] text-ink-500">
          <span class="icon-[ph--file-x] text-sm" aria-hidden="true"></span>
          {file.name} — no longer available
        </p>
      {:else if file.kind === 'image' && (file.thumb || file.src)}
        {@const box = previewBox(file)}
        <button
          type="button"
          onclick={() => open(file.permalink)}
          title={file.name}
          class="block overflow-hidden rounded-lg ring-1 ring-white/10 hover:ring-white/25"
          style:width={box ? `${box.width}px` : undefined}
        >
          <img
            src={file.thumb || file.src}
            alt={file.name}
            draggable="false"
            width={box?.width}
            height={box?.height}
            class="block h-auto w-full object-contain"
          />
        </button>
      {:else if file.kind === 'video' && file.src}
        <!-- `preload="metadata"`: a thread of clips should not fetch every one
             of them the moment it opens. -->
        <video
          src={file.src}
          controls
          preload="metadata"
          style:max-width="{MAX_PREVIEW_WIDTH}px"
          class="max-h-72 w-full rounded-lg ring-1 ring-white/10"
        >
          <track kind="captions" />
        </video>
      {:else}
        <button
          type="button"
          onclick={() => open(file.permalink)}
          class="flex w-full max-w-sm items-center gap-2.5 rounded-lg glass-control p-2.5
                 text-left ring-1 ring-white/10"
        >
          <span class="icon-[ph--file] shrink-0 text-lg text-ink-400" aria-hidden="true"></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs text-ink-200">{file.name}</span>
            <span class="block text-[11px] text-ink-500">
              {[file.prettyType, formatSize(file.size)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span class="icon-[ph--arrow-square-out] shrink-0 text-sm text-ink-500" aria-hidden="true"
          ></span>
        </button>
      {/if}
    {/each}

    {#each attachments as attachment, index (index)}
      {#if attachment.title || attachment.text}
        <!-- Slack's own unfurl, reduced to the two lines worth reading. The bar
             down the side is how Slack marks one, and it is the quickest way to
             say "this is the link, not the message". -->
        <div class="max-w-md border-l-2 border-white/20 pl-2.5">
          {#if attachment.title}
            {#if attachment.titleLink}
              <button
                type="button"
                onclick={() => open(attachment.titleLink)}
                class="text-left text-xs font-medium text-sky-300 hover:underline"
              >
                {attachment.title}
              </button>
            {:else}
              <p class="text-xs font-medium text-ink-200">{attachment.title}</p>
            {/if}
          {/if}
          {#if attachment.text}
            <p class="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-ink-400">
              {attachment.text}
            </p>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}
