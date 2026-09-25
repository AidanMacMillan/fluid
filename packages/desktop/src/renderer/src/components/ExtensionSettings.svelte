<script lang="ts">
  /**
   * The space an extension's section of the settings panel takes up. The
   * section itself is a page of the extension's, which the main process lays
   * over this box as a view of its own (see src/main/settings-views.ts) — so
   * all this draws is the box, and all it does is say where the box is,
   * whenever that changes, and take the view down when it goes.
   */
  let { extensionId }: { extensionId: string } = $props()

  let slot: HTMLDivElement

  $effect(() => {
    const id = extensionId
    const send = (): void => {
      const { x, y, width, height } = slot.getBoundingClientRect()
      window.api.settingsWindow.showExtension(id, { x, y, width, height })
    }
    const observer = new ResizeObserver(send)
    observer.observe(slot)
    window.addEventListener('resize', send)
    send()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      window.api.settingsWindow.hideExtension()
    }
  })
</script>

<div bind:this={slot} class="min-h-0 flex-1"></div>
