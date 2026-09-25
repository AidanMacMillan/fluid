<script lang="ts">
  /**
   * What an extension's view leaves behind when its page crashed: the view is
   * already gone, and this says so until the user asks for it back. Shared by
   * the extension tabs and the file tabs an extension's viewer draws.
   */
  type Props = {
    /** Asks for the view again, which makes a new one. */
    onReload: () => void
  }

  const { onReload }: Props = $props()
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-ink-500">
  <span class="icon-[ph--warning-circle] text-3xl" aria-hidden="true"></span>
  <p class="max-w-sm text-center text-xs">This tab stopped unexpectedly.</p>
  <button
    type="button"
    onclick={onReload}
    class="rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300 hover:text-ink-50"
  >
    Reload
  </button>
</div>
