<script lang="ts">
  /**
   * The draggable edge of something whose width it steers. Pointer events
   * rather than native drag and drop: a resize is a continuous value being
   * steered, not an item being carried somewhere, and the platform's drag gives
   * none of what that needs — no live position, no cursor of our choosing.
   */
  type Props = {
    /** The panel's current width, in CSS pixels. */
    width: number
    min: number
    max: number
    label: string
    /**
     * How much width one pixel of pointer buys, and which way round.
     *
     * 1 is an edge that grows away from a fixed one, which is what a panel
     * pinned to the side of the window is. A box held in the middle instead has
     * two of these, and each pixel its edge travels is two of width because the
     * far edge moves the same distance the other way: 2 on its right edge, and
     * -2 on its left, where travelling left is what makes it wider.
     */
    factor?: number
    /** Placement. The handle positions itself against whatever is passed. */
    class?: string
    /**
     * How far the line the handle draws runs. It defaults to clearing the
     * content well's rounded corner, which is what a handle on the well's own
     * edge has to do; one inside the well passes `inset-y-0` instead.
     */
    markClass?: string
    /** Every pointer move, with the width already clamped to the range. */
    onresize: (width: number) => void
    /** Once the drag ends, with the width to keep. */
    oncommit: (width: number) => void
  }

  const {
    width,
    min,
    max,
    label,
    factor = 1,
    class: className = '',
    markClass = 'top-(--radius-surface) bottom-0',
    onresize,
    oncommit
  }: Props = $props()

  /** How far one arrow-key press moves the edge. */
  const STEP = 16

  let handle = $state<HTMLElement | null>(null)

  /** Where the pointer and the edge started; null when no drag is in flight. */
  let drag = $state.raw<{ pointerId: number; x: number; width: number } | null>(null)

  /**
   * The width the pointer is asking for, before clamping. The clamped width is
   * what the panel gets; this is what the cursor is drawn from, and the two
   * part company exactly when the drag runs past an end of the range.
   */
  let wanted = $state(0)

  const cursor = $derived.by(() => {
    if (!drag) return null
    // Past an end, only one direction still changes anything, and offering the
    // other one would promise a move that will not happen.
    if (wanted <= max && wanted >= min) return 'both'
    const held = wanted > max ? 'shrink' : 'grow'
    // Which way the pointer has to go to get back inside the range is the other
    // way round on an edge that grows by travelling left.
    if (factor >= 0) return held
    return held === 'shrink' ? 'grow' : 'shrink'
  })

  const clamp = (value: number): number => Math.round(Math.min(max, Math.max(min, value)))

  /**
   * The cursor has to hold across the whole window for as long as the drag
   * runs: the pointer leaves the handle on the first move, and every element it
   * crosses would otherwise get a say. The root element carries it — see the
   * `data-resize` rules in main.css.
   */
  $effect(() => {
    if (!cursor) return undefined
    document.documentElement.dataset.resize = cursor
    return () => delete document.documentElement.dataset.resize
  })

  /**
   * The drag is tracked from the window rather than from the handle. Capture
   * routes every pointer event in this renderer to the handle already, but the
   * page is a native view stacked above the renderer: if a drag that crosses it
   * loses events there, they come back the moment the pointer returns, and a
   * window listener is what is still standing to catch them.
   */
  $effect(() => {
    if (!drag) return undefined
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  })

  function start(event: PointerEvent): void {
    if (event.button !== 0) return
    // Without this the press starts a selection drag instead.
    event.preventDefault()
    // Capture keeps the moves coming once the pointer is off the handle, which
    // it is for all of the drag but the first pixel, and it is what holds the
    // resize cursor while the pointer is over the page.
    handle?.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, x: event.clientX, width }
    wanted = width
  }

  function move(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    // No button on a move that belongs to a drag means the release happened
    // somewhere this renderer never saw it, and this is the first word of it.
    // Without this the drag would run on with nothing left to end it.
    if (event.buttons === 0) {
      end(event)
      return
    }
    // Measured from where the drag began rather than from the current width:
    // once clamped, the width stops tracking the pointer, and a step-by-step
    // sum would lose the distance the pointer covered past the end.
    wanted = drag.width + factor * (event.clientX - drag.x)
    onresize(clamp(wanted))
  }

  /** Runs on release, on cancel, and if the handle goes away mid-drag. */
  function end(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
    oncommit(clamp(wanted))
  }

  function onkeydown(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? -STEP : event.key === 'ArrowRight' ? STEP : 0
    if (step === 0) return
    event.preventDefault()
    // One press is one step of width whichever edge this is, so only the sign
    // of the factor is taken: the size of it is about pointer travel, and a
    // key press has none.
    oncommit(clamp(width + step * Math.sign(factor)))
  }
</script>

<div
  bind:this={handle}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={width}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  class="group cursor-ew-resize {className}"
  onpointerdown={start}
  onlostpointercapture={end}
  {onkeydown}
>
  <!-- The element above is a hit area, deliberately wider than anything it
       draws; this is the mark it leaves on the glass, and only while it is
       being used.

       By default it stops where the content well beside it stops running
       straight. The hit area spans the full height, but a line that carried on
       past the well's corner radius would be left standing alongside the curve
       with nothing to sit against. Only the well's top-left corner is rounded,
       so that is the one offset; the well runs to the window's bottom edge, and
       so does this. A handle inside the well has no corner to clear and says so
       with `markClass`. -->
  <span
    aria-hidden="true"
    class="pointer-events-none absolute left-1/2 w-px -translate-x-1/2 rounded-full transition-colors duration-100 {markClass} {drag
      ? 'bg-white/45'
      : 'bg-transparent group-hover:bg-glow/25 group-focus-visible:bg-glow/25'}"
  ></span>
</div>
