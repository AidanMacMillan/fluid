<script lang="ts">
  import { storedFileUrl, type FileTab } from '@fluid/sdk'
  import IconButton from './IconButton.svelte'

  type Props = { tab: FileTab }

  const { tab }: Props = $props()

  const payload = $derived(tab.payload)
  const source = $derived(storedFileUrl(payload.storageKey))

  /**
   * Whether the copy failed to load. Unlike an image, a video can fail well
   * after it starts — a container we can open holding a codec we cannot decode
   * fires `error` partway through — so this is not only a startup concern.
   */
  let broken = $state(false)

  /** How far a skip moves the playhead, in seconds. */
  const SKIP_SECONDS = 5

  let shell = $state<HTMLElement | null>(null)

  /**
   * The element's own state, mirrored by Svelte's media bindings. `paused` and
   * `currentTime` are two-way: writing them is how this component plays, pauses
   * and seeks, so there is no separate "intended" state to drift from what the
   * element is actually doing.
   */
  let paused = $state(true)
  let ended = $state(false)
  let muted = $state(false)
  let currentTime = $state(0)
  let duration = $state(0)

  /**
   * A drag in progress on the seek bar. While one is, the bar draws where the
   * user is pointing rather than where playback is: the element reports the
   * time it has actually reached, which during a seek lags the thumb and drags
   * it backwards under the cursor.
   */
  let scrubbing = $state(false)
  let scrubTime = $state(0)

  const position = $derived(scrubbing ? scrubTime : currentTime)
  /** Nothing to seek within until the metadata says how long the file is. */
  const seekable = $derived(Number.isFinite(duration) && duration > 0)
  const progress = $derived(seekable ? Math.min(1, position / duration) : 0)

  let fullscreen = $state(false)

  /**
   * Stops when the tab is looked away from. The page is kept warm out of
   * sight, which in the window it never was: there the player was taken down
   * with its pane, and a video left playing in a tab nobody can see — and
   * cannot find by listening — is not something a user asked for.
   */
  $effect(() => {
    const onVisibility = (): void => {
      if (document.hidden) paused = true
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  })

  $effect(() => {
    const onChange = (): void => {
      fullscreen = shell !== null && document.fullscreenElement === shell
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  })

  /**
   * The ambient copy: the same file playing behind the picture, oversized and
   * blurred, so a video whose shape is not the pane's sits in its own colour
   * rather than against a black band. It is decoration, so it follows the real
   * element rather than sharing state with it — nothing here is ever the thing
   * being played or seeked, and a failure to keep up is not worth reporting.
   */
  let ambient = $state<HTMLVideoElement | null>(null)

  /** How far the ambient copy may drift from the picture before it is pulled back. */
  const AMBIENT_DRIFT_SECONDS = 0.3

  $effect(() => {
    const copy = ambient
    if (!copy) return
    // Always silent: it is the same audio the picture is already playing.
    copy.muted = true
    // Reading `paused` is what subscribes this to it.
    if (paused) copy.pause()
    // A `play()` cut short by the next pause rejects, which is not a problem.
    else void copy.play().catch(() => {})
  })

  $effect(() => {
    const copy = ambient
    if (!copy) return
    const target = currentTime
    // Only real drift is corrected. `currentTime` ticks throughout playback, and
    // assigning it on every tick would seek the copy continuously instead of
    // letting it run — which both stutters the wash and decodes far more than a
    // decoration should.
    if (Math.abs(copy.currentTime - target) > AMBIENT_DRIFT_SECONDS) {
      copy.currentTime = target
    }
  })

  function togglePlay(): void {
    // Replaying from the end rather than resuming at it, which is where the
    // playhead is sitting and would otherwise end the video again at once.
    if (ended) currentTime = 0
    paused = !paused
  }

  function skip(seconds: number): void {
    if (!seekable) return
    currentTime = Math.min(duration, Math.max(0, currentTime + seconds))
  }

  function onScrub(event: Event & { currentTarget: HTMLInputElement }): void {
    scrubbing = true
    scrubTime = Number(event.currentTarget.value)
    currentTime = scrubTime
  }

  /** `change` is the release on a range input, which is where the drag ends. */
  function endScrub(): void {
    scrubbing = false
  }

  async function toggleFullscreen(): Promise<void> {
    // The wrapper goes fullscreen, not the video: the element's own fullscreen
    // brings Chromium's default controls with it and leaves these behind.
    if (!shell) return
    if (document.fullscreenElement === shell) {
      await document.exitFullscreen()
    } else {
      await shell.requestFullscreen()
    }
  }

  /**
   * The shortcuts a video is expected to answer. Handled on the wrapper rather
   * than the window so they belong to the pane that has focus, and skipped when
   * a control already has it — space on a focused button is that button's.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return

    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      skip(-SKIP_SECONDS)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      skip(SKIP_SECONDS)
    } else if (event.key === 'm') {
      muted = !muted
    }
  }

  /**
   * `h:mm:ss`, dropping the hours for anything under one. A placeholder of the
   * same shape stands in before the duration is known, so the bar does not
   * resize the moment metadata lands.
   */
  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds)) return '--:--'
    const whole = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const rest = whole % 60
    const pad = (value: number): string => String(value).padStart(2, '0')
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
  }
</script>

{#if broken}
  <div class="flex h-screen flex-col items-center justify-center gap-3 px-6 text-ink-500">
    <span class="icon-[ph--file-video] text-3xl" aria-hidden="true"></span>
    <p class="max-w-xs text-center text-xs">This video could not be played.</p>
  </div>
{:else}
  <!-- The whole page. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    bind:this={shell}
    tabindex="-1"
    aria-label={payload.fileName}
    onkeydown={onKeyDown}
    class="relative flex h-screen flex-col bg-black/20"
  >
    <!-- The wash. It is laid on the shell rather than inside the picture well
         so that it runs under the transport too: the row reads as the edge of
         the video's own light rather than as a separate strip bolted beneath
         it, and the blur is free to bleed down into it.

         The copy is laid out exactly where the picture is — same box, same
         `object-contain`, no scaling — so what bleeds into a bar is the colour
         of the edge it is beside. A scaled copy is a different framing of the
         frame, and the wash then disagrees with the picture about where things
         are. The rows below mirror the shell's own so that box is the well's
         without restating the transport's height here. -->
    <div aria-hidden="true" class="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div class="flex h-full flex-col">
        <div class="relative min-h-0 flex-1">
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={ambient}
            src={source}
            muted
            playsinline
            preload="metadata"
            tabindex="-1"
            class="ambient absolute inset-0 h-full w-full object-contain"
          ></video>
        </div>
        <div class="h-11 shrink-0"></div>
      </div>
      <div class="absolute inset-0 bg-black/25"></div>
    </div>

    <!-- The picture takes whatever the controls leave, and is fitted inside it:
         a video has one right size and it is not the window's, so it is letter-
         boxed on the well's own ground rather than stretched or cropped. The
         well centres with flex rather than grid so that the fitting holds in a
         short window: a grid row sizes to its content, which leaves the video's
         `max-h-full` a percentage of nothing to resolve against and drops it,
         and the picture then overflows the well and is clipped by it. A flex
         item measures against the container's own definite height instead. -->
    <div class="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:paused
        bind:ended
        bind:muted
        bind:currentTime
        bind:duration
        src={source}
        preload="metadata"
        onerror={() => (broken = true)}
        onclick={togglePlay}
        class="max-h-full max-w-full cursor-pointer"
      ></video>
    </div>

    <!-- The transport, in its own row under the picture rather than floating
         over it: the picture is already letterboxed, so there is room without
         taking any, and controls that do not fade cannot be hunted for. -->
    <div class="relative z-10 flex h-11 shrink-0 items-center gap-2 px-3">
      <IconButton
        icon={paused ? 'icon-[ph--play-fill]' : 'icon-[ph--pause-fill]'}
        label={paused ? 'Play' : 'Pause'}
        onclick={togglePlay}
      />

      <span class="shrink-0 text-[0.6875rem] text-ink-400 tabular-nums">
        {formatTime(position)}
      </span>

      <!-- The bar is a range input rather than a hand-rolled track: dragging,
           clicking anywhere along it and arrow-key stepping all come with it,
           and all three are what a seeker is expected to do. -->
      <input
        type="range"
        min="0"
        max={seekable ? duration : 0}
        step="0.01"
        value={position}
        disabled={!seekable}
        aria-label="Seek"
        oninput={onScrub}
        onchange={endScrub}
        style="--progress: {progress * 100}%"
        class="seek min-w-0 flex-1"
      />

      <span class="shrink-0 text-[0.6875rem] text-ink-500 tabular-nums">
        {formatTime(duration)}
      </span>

      <IconButton
        icon={muted
          ? 'icon-[ph--speaker-simple-slash-fill]'
          : 'icon-[ph--speaker-simple-high-fill]'}
        label={muted ? 'Unmute' : 'Mute'}
        onclick={() => (muted = !muted)}
      />
      <IconButton
        icon={fullscreen ? 'icon-[ph--corners-in]' : 'icon-[ph--corners-out]'}
        label={fullscreen ? 'Exit full screen' : 'Full screen'}
        onclick={() => void toggleFullscreen()}
      />
    </div>
  </section>
{/if}

<style>
  /* Blur and saturation go here rather than in Tailwind utilities so they read
     as one filter. A filter paints outside its element's box, which is what
     carries the wash off the picture and into the bars and the transport's row;
     the radius is what sets how far it reaches, since nothing is scaled up to
     carry it further. The opacity is high because the wash is now the picture's
     own edge continued outward — the nearer it is to matching that edge, the
     less the boundary between the two reads as a seam. */
  .ambient {
    filter: blur(4.5rem) saturate(1.8);
    opacity: 0.9;
  }

  /* The native track and thumb are an opaque light-mode control and there is no
     styling them in place, so the input is stripped to a bare box and both are
     drawn here. Colours go through `color-mix` rather than Tailwind's `--alpha`:
     this block is compiled by Svelte, not by Tailwind, so only CSS the browser
     itself understands survives. The theme's `--color-*` variables do reach it —
     Tailwind emits those into `:root`. */
  .seek {
    -webkit-appearance: none;
    appearance: none;
    height: 1rem;
    background: transparent;
    cursor: pointer;
  }

  /* The played portion is a hard-stopped gradient driven by `--progress`, which
     saves keeping a second element in sync with the first. */
  .seek::-webkit-slider-runnable-track {
    height: 0.25rem;
    border-radius: 9999px;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--theme-ink-200) 90%, transparent) var(--progress),
      color-mix(in srgb, var(--color-white) 15%, transparent) var(--progress)
    );
  }

  .seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    height: 0.75rem;
    width: 0.75rem;
    /* Centres the thumb on a track a quarter of its height. */
    margin-top: -0.25rem;
    border-radius: 9999px;
    background: var(--theme-ink-100);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--color-black) 40%, transparent);
    transition: transform 120ms ease;
  }

  /* The thumb is a small target at rest and a comfortable one while it matters. */
  .seek:hover::-webkit-slider-thumb,
  .seek:active::-webkit-slider-thumb {
    transform: scale(1.15);
  }

  .seek:disabled {
    cursor: default;
  }

  .seek:disabled::-webkit-slider-thumb {
    opacity: 0;
  }
</style>
