<script lang="ts">
  import { untrack } from 'svelte'
  import { storedFileUrl, type FileTab, type ViewHost } from '@fluid/sdk'
  import IconButton from './IconButton.svelte'

  type Props = { tab: FileTab; host: ViewHost }

  const { tab, host }: Props = $props()

  const payload = $derived(tab.payload)

  const source = $derived(storedFileUrl(payload.storageKey))

  /**
   * The source that failed to load, if any. Held as the source itself rather
   * than a flag, so a new source gets its own chance without needing to be
   * reset. A copy that will not load means the store and the tab's row
   * disagree, which nothing in the app should be able to cause — or it is a
   * format the store names but Chromium cannot decode. Either is worth saying
   * rather than leaving a blank frame.
   */
  let broken = $state<string | null>(null)
  const failed = $derived(source === broken)

  // Past 20x an image is pixels rather than a picture.
  const MAX_SCALE = 20
  /**
   * How far out the view can be taken — except for an image so large that it
   * does not fit even at a tenth, which can always be taken out far enough to
   * see whole (see `minScale`). A floor above the fitted scale would leave the
   * wheel unable to reach a view the fit button hands over.
   */
  const MIN_SCALE = 0.1

  let viewport = $state<HTMLElement | null>(null)
  let picture = $state<HTMLImageElement | null>(null)
  /** The viewport's own size, and the image's, both in CSS pixels. */
  let box = $state.raw({ width: 0, height: 0 })
  let natural = $state.raw({ width: 0, height: 0 })

  /**
   * The user's magnification, or null while they have not set one — which is
   * not the same as a scale that happens to equal the fitted one. Null keeps
   * the image fitted to the viewport as the window is resized; a number is a
   * decision, and resizing the window does not get to revise it.
   *
   * A view draws one tab for its whole life, so the stored state is read once,
   * as the view is built. Whatever it writes back is written by the page it
   * lives in, which also writes anything still pending as it goes.
   *
   * A file tab's stored state is whatever its viewer put there, and a document
   * tab's is a width rather than a view (see `FileViewState`), so what comes
   * back is checked for being this viewer's before it is believed.
   */
  const opened = untrack(() => {
    const state = tab.viewState
    return state !== null && 'scale' in state ? state : null
  })
  let scale = $state<number | null>(opened?.scale ?? null)
  let offset = $state.raw({ x: opened?.offsetX ?? 0, y: opened?.offsetY ?? 0 })

  /** The scale that shows the whole image, never enlarging one smaller than the viewport. */
  const fitScale = $derived(
    natural.width > 0 && box.width > 0
      ? Math.min(1, box.width / natural.width, box.height / natural.height)
      : 1
  )
  const effectiveScale = $derived(scale ?? fitScale)
  /** The floor, lowered for an image the fitted view is already below. */
  const minScale = $derived(Math.min(MIN_SCALE, fitScale))

  /**
   * Everything about the view is worked out from the image's own size, so it
   * has to be read from the element rather than assumed. `load` covers the
   * usual case; the check on mount covers an image the cache can hand over
   * complete, whose `load` fired before there was a handler to hear it.
   */
  function measureImage(): void {
    if (!picture?.naturalWidth) return
    natural = { width: picture.naturalWidth, height: picture.naturalHeight }
  }

  $effect(() => {
    if (picture) measureImage()
  })

  $effect(() => {
    const element = viewport
    if (!element) return undefined

    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      box = { width: rect.width, height: rect.height }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  })

  /**
   * How far the image may be dragged: far enough that its centre reaches the
   * viewport's edge, and no further. Stopping where the image's own edge meets
   * the viewport's instead would pin a picture that already fits to the middle,
   * with nothing to take hold of — this leaves room to push it aside at any
   * magnification while keeping at least a quarter of it on screen.
   */
  function clamp(next: { x: number; y: number }, atScale: number): { x: number; y: number } {
    const bound = (extent: number, along: number): number => Math.max(extent * atScale, along) / 2
    const limitX = bound(natural.width, box.width)
    const limitY = bound(natural.height, box.height)
    return {
      x: Math.min(limitX, Math.max(-limitX, next.x)),
      y: Math.min(limitY, Math.max(-limitY, next.y))
    }
  }

  /** Hands the current view to the host, which decides when it reaches the database. */
  function remember(): void {
    // A fitted image sitting where it opens is the absence of a view, not a
    // view worth storing — but a fitted image the user has pushed aside is one.
    const untouched = scale === null && offset.x === 0 && offset.y === 0
    host.setViewState(tab.id, untouched ? null : { scale, offsetX: offset.x, offsetY: offset.y })
  }

  function apply(nextScale: number | null, nextOffset: { x: number; y: number }): void {
    scale = nextScale
    offset = clamp(nextOffset, nextScale ?? fitScale)
    remember()
  }

  /**
   * A resized window changes what "inside the viewport" means, so an offset
   * that was against the edge of the old one can be outside the new one. Only
   * the correction is made: the scale is the user's, and the offset is read
   * untracked so that this does not answer its own write.
   */
  $effect(() => {
    const atScale = effectiveScale
    if (box.width === 0 || natural.width === 0) return
    const current = untrack(() => offset)
    const next = clamp(current, atScale)
    if (next.x === current.x && next.y === current.y) return
    offset = next
    untrack(remember)
  })

  /**
   * Zooms about a point on screen, so whatever is under the pointer stays under
   * it. Zooming about the centre instead would walk the thing being examined
   * out of the frame.
   *
   * The image is drawn centred on the viewport, moved by `offset` and scaled
   * about its own centre, so a point `p` of the image (measured from its
   * centre, in the image's own pixels) lands at `offset + scale * p` from the
   * viewport's centre. Holding the point under the cursor is then a matter of
   * solving that for the offset the new scale needs.
   */
  function zoomAbout(clientX: number, clientY: number, factor: number): void {
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const x = clientX - (rect.left + rect.width / 2)
    const y = clientY - (rect.top + rect.height / 2)

    const from = effectiveScale
    const to = Math.min(MAX_SCALE, Math.max(minScale, from * factor))
    if (to === from) return

    const ratio = to / from
    apply(to, { x: x - ratio * (x - offset.x), y: y - ratio * (y - offset.y) })
  }

  /**
   * A trackpad pinch arrives as a wheel event with `ctrlKey` set — the same
   * shape as ctrl and the wheel together, which is the mouse gesture for the
   * same thing. Everything else scrolls, and here scrolling is panning.
   */
  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      // A pinch arrives in small steps and a mouse wheel in notches of 120, and
      // the same exponent cannot serve both: unclamped, one notch is a threefold
      // jump. Capping the step keeps a notch to about a quarter while leaving a
      // pinch its fine control.
      const step = Math.max(-40, Math.min(40, event.deltaY))
      zoomAbout(event.clientX, event.clientY, Math.exp(-step / 160))
      return
    }
    // A wheel mouse reports one axis, and shift is the long-standing way of
    // lending it the other. A trackpad reports both itself and is left alone.
    const sideways = event.shiftKey && event.deltaX === 0
    apply(scale, {
      x: offset.x - (sideways ? event.deltaY : event.deltaX),
      y: offset.y - (sideways ? 0 : event.deltaY)
    })
  }

  let panning = $state(false)
  /**
   * Where the pointer was at the last move. The pan follows the difference
   * between positions rather than `movementX`/`movementY`, which are reported
   * in the screen's own pixels — on a scaled display those are not the pixels
   * the image is drawn in, and it slides out from under the cursor.
   */
  let last = { x: 0, y: 0 }

  function onPointerDown(event: PointerEvent): void {
    // The left button is the viewer's own pan; the middle one is what a canvas
    // is expected to answer, and costs a condition to honour.
    if (event.button !== 0 && event.button !== 1) return
    // Nothing is cancelled here: the drag the picture would otherwise start is
    // off at the element (`draggable`), the selection it would otherwise make
    // is off for the whole page, and cancelling `pointerdown` would take the
    // compatibility mouse events with it — which is what `dblclick` is built
    // from, and double-clicking is how the view is fitted.
    panning = true
    last = { x: event.clientX, y: event.clientY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!panning) return
    apply(scale, {
      x: offset.x + (event.clientX - last.x),
      y: offset.y + (event.clientY - last.y)
    })
    last = { x: event.clientX, y: event.clientY }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!panning) return
    panning = false
    const element = event.currentTarget as HTMLElement
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
  }

  /** Back to the view the pane opens with, which is also what "no view state" means. */
  function fit(): void {
    apply(null, { x: 0, y: 0 })
  }

  /** Brings the image back to the middle without touching how far it is zoomed. */
  function recentre(): void {
    apply(scale, { x: 0, y: 0 })
  }
</script>

{#if failed}
  <div class="flex h-screen flex-col items-center justify-center gap-3 px-6 text-ink-500">
    <span class="icon-[ph--file-image] text-3xl" aria-hidden="true"></span>
    <p class="max-w-xs text-center text-xs">This image could not be read.</p>
  </div>
{:else}
  <!-- The whole page. The controls are a sibling of the surface the gestures
       are bound to, not a child of it: a pointerdown inside it is captured for
       a pan, which swallows the click before the button under it ever sees
       one. -->
  <div class="relative h-screen">
    <!-- The image sits on the well's own dark ground rather than a
         checkerboard: transparency reads as the glass showing through, which is
         what the rest of the window does too. Overflow is hidden because the
         transform, not a scrollbar, is what moves the picture, and
         `touch-none` keeps a trackpad gesture from being read as a scroll of
         something behind this. -->
    <div
      bind:this={viewport}
      role="img"
      aria-label={payload.fileName}
      class="absolute inset-0 touch-none overflow-hidden
             {panning ? 'cursor-grabbing' : 'cursor-grab'}"
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={fit}
    >
      <!-- Centred by the leading `translate(-50%, -50%)` against a corner put
           at the middle of the viewport, rather than by the layout: an image
           larger than the pane overflows whatever box holds it, and a grid or
           flex centre anchors such an item at the start edge instead — which
           silently moves the centre every one of these gestures is measured
           from. Two translates and a scale, in that order, put the image's
           centre at `offset` from the viewport's and grow it from there.

           It has to be the `transform` shorthand: the `translate` and `scale`
           properties it could use instead are the ones Tailwind's own utilities
           write to, and one of those would fight this for the same
           declaration. -->
      <img
        bind:this={picture}
        src={source}
        alt=""
        draggable="false"
        onload={measureImage}
        onerror={() => (broken = source)}
        style="width: {natural.width}px; height: {natural.height}px;
               transform: translate(-50%, -50%) translate({offset.x}px, {offset.y}px)
                          scale({effectiveScale});"
        class="absolute top-1/2 left-1/2 max-w-none origin-center will-change-transform select-none"
      />
    </div>

    <!-- Where the view stands, and the two ways back from it: the percentage
         returns to the fitted view, the button beside it brings the image back
         to the middle at the magnification it is already at. -->
    <div class="absolute right-3 bottom-3 flex items-center gap-1">
      <button
        type="button"
        title="Fit to window"
        onclick={fit}
        class="rounded-md glass-control bg-ink-900/70 px-2 py-1 text-[0.6875rem] text-ink-400 tabular-nums ring-1 ring-white/10 hover:text-ink-100"
      >
        {Math.round(effectiveScale * 100)}%
      </button>
      <IconButton
        icon="icon-[ph--crosshair-simple]"
        label="Recentre"
        class="bg-ink-900/70 ring-1 ring-white/10"
        onclick={recentre}
      />
    </div>
  </div>
{/if}
