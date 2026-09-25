<script lang="ts">
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import '@xterm/xterm/css/xterm.css'
  import { leaveSplit, watchTabSplit, type ViewHost } from '@fluid/sdk'
  import type { MainMessage, TerminalTab, ViewMessage } from '../shared/tab'

  /**
   * A terminal tab's pane: an xterm.js screen wired to a real shell running in
   * the extension's main half (see ../main/sessions.ts). Nothing is interpreted
   * on the way past — what is typed goes to the shell's standard input, and
   * what the shell prints is written to the screen.
   *
   * The pane lives as long as its view, and the shell outlives both. It keeps
   * running in the background the way a browser tab's page does, and a view
   * built for it later is handed what it printed in the meantime, so coming
   * back to a build shows the build rather than a blank screen.
   *
   * The shell ending is the other way round: the tab goes with it. That is the
   * main half's doing, not this pane's — a shell can end in a tab with no view
   * at all — and the view simply goes with the tab.
   */

  type Props = { tab: TerminalTab; host: ViewHost }

  const { tab, host }: Props = $props()

  /** Which copy chord this platform uses; see the key handler below. */
  const MAC = navigator.userAgent.includes('Macintosh')

  /** The element xterm draws into. Sized by the pane; xterm reads it, not the reverse. */
  let screen = $state<HTMLElement | null>(null)

  /**
   * Why there is no terminal, when there is none: the native module failed to
   * load, or the shell would not start. Neither is something the pane can do
   * anything about, so it says so instead of showing an empty rectangle.
   */
  let failure = $state<string | null>(null)

  /** The live terminal, for the controls outside the effect that built it. */
  let terminal: Terminal | null = null

  /**
   * The shell's own colours. Only the background is unusual: it is left clear so
   * the window's glass carries through the way it does under every other kind of
   * tab, which is what `allowTransparency` below is for. The rest is the same
   * greyscale the chrome is built from, with the eight ANSI colours kept bright
   * enough to read against it.
   */
  const THEME = {
    background: '#00000000',
    foreground: '#e4e4e7',
    cursor: '#e4e4e7',
    cursorAccent: '#18181b',
    selectionBackground: '#ffffff40',
    black: '#3f3f46',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d8',
    brightBlack: '#71717a',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fcd34d',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa'
  }

  const post = (message: ViewMessage): void => host.post(message)

  /**
   * Builds the terminal, attaches it to this tab's shell, and takes both down
   * again when the pane goes. Everything the pane does lives in here: the xterm
   * instance is not reactive state, and nothing outside needs it before it is
   * ready.
   */
  $effect(() => {
    const element = screen
    if (!element) return undefined

    const term = new Terminal({
      // The material behind the pane is the window's own glass, and an opaque
      // terminal would be the one place in the app that covers it.
      allowTransparency: true,
      theme: THEME,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      // Well past a screenful, and well short of holding a whole build's output
      // in the view's memory for a tab nobody is reading.
      scrollback: 5000,
      // Left Option types the character printed on the key rather than sending
      // a meta escape — the macOS convention, and what makes `å` typable.
      macOptionIsMeta: false
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    // Addresses a shell prints — a dev server's, a CI run's — open as tabs in
    // this app rather than in the user's browser, the same as any other link.
    term.loadAddon(new WebLinksAddon((_event, uri) => host.openLink(uri)))

    term.open(element)

    /** Set on teardown: nothing may be written to a dead terminal. */
    let gone = false

    // One channel carries both the replay and what follows it, in order, so
    // there is nothing to reconcile: whatever arrives after `ready` is news.
    const stopListening = host.onMessage((raw) => {
      if (gone) return
      const message = raw as MainMessage
      switch (message.type) {
        case 'ready':
          failure = null
          if (message.replay) term.write(message.replay)
          term.focus()
          return
        case 'output':
          term.write(message.data)
          return
        case 'failed':
          failure = message.message
          return
      }
    })

    // Measured before the shell starts, so its first prompt is drawn at the
    // size it will be read at rather than at a default that is about to change.
    fit.fit()
    post({ type: 'open', cols: term.cols, rows: term.rows })

    term.onData((data) => post({ type: 'input', data }))

    // Re-measured rather than assumed: the sidebar slides, the window resizes,
    // and a shell told the wrong size redraws full-screen programs wrongly.
    const measure = (): void => {
      // A pane mid-teardown, or one laid out to nothing while the sidebar
      // animates, measures as zero cells and would resize the shell to nothing.
      if (gone || element.clientWidth === 0 || element.clientHeight === 0) return
      fit.fit()
      post({ type: 'resize', cols: term.cols, rows: term.rows })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)

    /**
     * Copying what xterm has selected. xterm draws its own selection rather than
     * making one in the document, so neither the Edit menu's Copy nor the
     * keystroke behind it finds anything to take without this: the menu's copy
     * arrives here as a `copy` event with nothing selected, and the keystroke
     * goes to the shell as an interrupt if it is not caught first.
     */
    const onCopy = (event: ClipboardEvent): void => {
      if (!term.hasSelection()) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', term.getSelection())
    }
    element.addEventListener('copy', onCopy)

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      // Cmd+C on macOS, Ctrl+Shift+C elsewhere — where a bare Ctrl+C is the
      // interrupt the shell is waiting for and must never be taken away.
      const chord = MAC
        ? event.metaKey && !event.ctrlKey && !event.shiftKey
        : event.ctrlKey && event.shiftKey
      if (chord && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        event.preventDefault()
        return false
      }
      return true
    })

    terminal = term

    return () => {
      gone = true
      terminal = null
      element.removeEventListener('copy', onCopy)
      observer.disconnect()
      stopListening()
      // The terminal goes; the shell behind it does not. Only the tab stopping
      // ends that (see `onStop` in ../index.ts).
      term.dispose()
    }
  })

  /**
   * The whole pane takes clicks on the shell's behalf. The screen is inset from
   * the pane's edges, and a click in that margin should land in the terminal
   * rather than nowhere — it is all one surface to the eye.
   */
  function focusTerminal(): void {
    terminal?.focus()
  }

  /** Where this shell is, following it as it moves (see ../main/sessions.ts). */
  const where = $derived(tab.payload.cwd)

  /** Whether the tab is one pane of a split, which is when its bar offers the way out. */
  let inSplit = $state(false)
  $effect(() => watchTabSplit(host.api, tab, (split) => (inSplit = split)))
</script>

<div class="flex h-screen min-h-0 flex-col">
  <!-- The terminal's own bar, in the row a browser tab puts its address in and a
       file tab its name. What a terminal is, is where it is running. -->
  <header class="flex h-9 shrink-0 items-center gap-2 px-3 pane-bar-edge">
    <span class="min-w-0 truncate text-xs text-ink-400" title={where}>{where}</span>
    {#if inSplit}
      <!-- The way out of a split, where the app puts it on every other pane:
           this bar is the pane's only one (see `drawsBar`). -->
      <button
        type="button"
        title="Remove from split"
        aria-label="Remove from split"
        onclick={() => void leaveSplit(host.api, tab)}
        class="-mr-1.5 ml-auto grid size-6 shrink-0 place-items-center rounded-md glass-control
               text-sm text-ink-400 hover:text-ink-100"
      >
        <span class="icon-[ph--minus]" aria-hidden="true"></span>
      </button>
    {/if}
  </header>

  {#if failure}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span class="icon-[ph--warning-circle] text-3xl text-ink-500" aria-hidden="true"></span>
      <p class="text-xs text-ink-400">{failure}</p>
    </div>
  {/if}

  <!-- Hidden rather than unmounted when the shell could not start: xterm is
       attached to this element, and taking it away would tear the terminal down
       on a failure that a restart may yet clear. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="min-h-0 flex-1 overflow-hidden px-3 pb-2"
    class:hidden={failure !== null}
    onclick={focusTerminal}
  >
    <div bind:this={screen} class="h-full w-full"></div>
  </div>
</div>

<style>
  /* xterm sizes its own scroll area and draws the rest; the viewport's default
     scrollbar is the one piece of chrome it brings that does not belong in a
     window made of glass. */
  :global(.xterm .xterm-viewport) {
    scrollbar-width: thin;
    scrollbar-color: rgb(255 255 255 / 0.18) transparent;
    background-color: transparent !important;
  }

  /* The pane holds the terminal's own padding, so xterm's element sits flush
     inside it and the measurement the fit addon makes is the whole of it. */
  :global(.xterm) {
    height: 100%;
  }
</style>
