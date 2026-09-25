<script lang="ts">
  /**
   * What a file tab shows below its bar (see FileChrome, which draws the bar).
   *
   * Mostly nothing. Every file is drawn by an extension's file viewer, in a
   * view laid over this area the same way a page is (see BrowserSurface): a
   * page of the extension's, for a picture or a video, or Chromium rendering
   * the file itself, for an HTML file or a PDF. What is left here is the ground
   * that view covers, and what shows through when there is none — a file no
   * running extension can draw, a download not yet whole, a view that failed.
   */
  import type { Tab } from '../../../main/db/schema'
  import { extensions } from '../lib/extensions.svelte'
  import { workspace } from '../lib/workspace.svelte'
  import FileDownloading from './FileDownloading.svelte'
  import FileFallback from './FileFallback.svelte'
  import ViewStopped from './ViewStopped.svelte'

  type Props = {
    tab: Extract<Tab, { type: 'file' }>
    /** Whether the viewer's page crashed, which is the pane's to say until it is reloaded. */
    stopped: boolean
    onReload: () => void
  }

  const { tab, stopped, onReload }: Props = $props()

  /**
   * The download still filling this tab, if it has one. Until it is done there
   * is nothing to render: the bytes on disk are a fraction of a file.
   */
  const download = $derived(workspace.downloadsByTab[tab.id] ?? null)

  const viewer = $derived(extensions.fileViewer(tab.payload.mimeType))

  /**
   * Whether a native view gave up on the file. A stored file that will not
   * load means the store and the tab's row disagree, which nothing in the app
   * should be able to cause — it is still worth saying rather than leaving the
   * empty ground the view was meant to cover. A viewer's own page says so
   * itself, since it is the one that tried.
   */
  const nativeViewFailed = $derived(workspace.pages[tab.id]?.error != null)
</script>

<!-- The column is what anything below sizes itself against, with `flex-1`,
     rather than measuring the pane's height. -->
<div class="flex h-full min-h-0 flex-col">
  {#if download}
    <FileDownloading {download} />
  {:else if viewer === null}
    <FileFallback reason="unsupported" />
  {:else if stopped}
    <ViewStopped {onReload} />
  {:else if viewer.view.kind === 'native' && nativeViewFailed}
    <FileFallback reason="unreadable" />
  {/if}
</div>
