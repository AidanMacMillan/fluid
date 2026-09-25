<script lang="ts">
  /**
   * The file's own bar, in the row a browser tab puts its address in — the same
   * row, drawn by the same surface, because a file tab and a page tab are the
   * same shape of thing with a different thing inside them.
   *
   * It lives here rather than inside FilePane so the pane below it is nothing
   * but the file: an HTML file is rendered by a native view laid over that area
   * (see BrowserSurface), and a bar drawn inside it would be covered by one.
   */
  import type { Tab } from '../../../main/db/schema'
  import { documentMode, documentStateOf, type DocumentMode } from '../lib/document-width'
  import { extensions } from '../lib/extensions.svelte'
  import { workspace } from '../lib/workspace.svelte'

  type Props = {
    tab: Extract<Tab, { type: 'file' }>
    /**
     * Sends an HTML file to one of the two widths the toggle reaches for.
     * Handed down rather than written here because the width is the shape of
     * the native view below this bar, and BrowserSurface is what draws that
     * view — it is also the only place that can tell a toggle worth animating
     * from a tab switch that is not, and the only one holding the width to come
     * back to.
     */
    onMode: (mode: DocumentMode) => void
  }

  const { tab, onMode }: Props = $props()

  const payload = $derived(tab.payload)

  /**
   * Whether the file has two widths to be read at — an HTML file, whose viewer
   * asks for them. Everything else has one.
   */
  const isDocument = $derived.by(() => {
    const viewer = extensions.fileViewer(payload.mimeType)
    return viewer?.view.kind === 'native' && viewer.view.resizable
  })

  /**
   * Which half lights up: read off the width the view is actually at, so that
   * dragging the handles past a phone's width moves the toggle with it rather
   * than leaving it claiming something the view has stopped being.
   */
  const mode = $derived(documentMode(documentStateOf(tab).width))

  /** Both glyphs, in the order they sit in the control. */
  const MODES: { value: DocumentMode; icon: string }[] = [
    { value: 'desktop', icon: 'icon-[ph--monitor]' },
    { value: 'mobile', icon: 'icon-[ph--device-mobile]' }
  ]

  /** Where a click goes, which with two modes is simply the other one. */
  const next: DocumentMode = $derived(mode === 'mobile' ? 'desktop' : 'mobile')
  const nextLabel = $derived(
    next === 'mobile' ? 'Switch to mobile width' : 'Switch to desktop width'
  )

  /**
   * The download still filling this tab, if it has one. Until it is done there
   * is no file to show and none to hand to the OS: the bytes on disk are a
   * fraction of one.
   */
  const download = $derived(workspace.downloadsByTab[tab.id] ?? null)

  function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB']
    let size = bytes
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }
    return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`
  }
</script>

<!-- The name is the address here: it is what the tab is, so it leads. `Reveal`
     points at the app's copy, not the original — the copy is what this tab is,
     and the original may have moved on since it was dropped.

     Three groups, and with a toggle between them the two on the outside are
     given `flex-1 basis-0`: both start from nothing and grow by the same
     amount, which puts the middle at the bar's own centre rather than at the
     centre of whatever the name happened to leave over. Without a toggle there
     is no middle to centre, and the name is better off with the whole bar than
     with half of it — so the outer groups only take equal shares when there is
     something between them to hold in place. -->
<header class="flex h-9 shrink-0 items-center gap-3 px-3 pane-bar-edge">
  <div class="flex min-w-0 items-center gap-3 {isDocument ? 'flex-1 basis-0' : ''}">
    <span class="truncate text-xs text-ink-300" title={payload.fileName}>
      {payload.fileName}
    </span>
    <span class="shrink-0 text-[0.6875rem] text-ink-500">
      {#if download}
        <!-- What has landed against what was promised, which is all that is
             known until the download ends. -->
        {formatSize(download.receivedBytes)}{download.totalBytes > 0
          ? ` / ${formatSize(download.totalBytes)}`
          : ''}
      {:else}
        {formatSize(payload.size)}
      {/if}
    </span>
  </div>

  {#if isDocument}
    <!-- One button showing both glyphs, rather than one button each. It reads
         as a pair because which width you are on is the thing being asked, and
         a control showing a single glyph can only ever show one of the two
         answers while meaning the other — but there are only two widths, so
         there is nothing to aim at: a click anywhere on it means the other one.
         The glyphs are therefore marks on the switch, not targets. -->
    <button
      type="button"
      title={nextLabel}
      aria-label={nextLabel}
      onclick={() => onMode(next)}
      class="group flex shrink-0 items-center gap-0.5 rounded-md glass-control p-0.5"
    >
      {#each MODES as option (option.value)}
        <span
          aria-hidden="true"
          class="grid size-5 place-items-center rounded text-xs transition-colors
                 {mode === option.value
            ? 'bg-white/10 text-ink-100'
            : 'text-ink-500 group-hover:text-ink-300'}"
        >
          <span class={option.icon}></span>
        </span>
      {/each}
    </button>
  {/if}

  <div
    class="flex items-center gap-1 {isDocument ? 'flex-1 basis-0 justify-end' : 'ml-auto shrink-0'}"
  >
    <button
      type="button"
      disabled={download !== null}
      onclick={() => void window.api.files.copy(payload.storageKey)}
      class="shrink-0 rounded-md glass-control px-2.5 py-1 text-xs text-ink-400
             hover:text-ink-100 disabled:pointer-events-none disabled:opacity-40"
    >
      Copy
    </button>
    <button
      type="button"
      disabled={download !== null}
      onclick={() => void window.api.files.open(payload.storageKey)}
      class="shrink-0 rounded-md glass-control px-2.5 py-1 text-xs text-ink-400
             hover:text-ink-100 disabled:pointer-events-none disabled:opacity-40"
    >
      Open
    </button>
    <button
      type="button"
      disabled={download !== null}
      onclick={() => window.api.files.reveal(payload.storageKey)}
      class="shrink-0 rounded-md glass-control px-2.5 py-1 text-xs text-ink-400
             hover:text-ink-100 disabled:pointer-events-none disabled:opacity-40"
    >
      Reveal
    </button>
  </div>
</header>
