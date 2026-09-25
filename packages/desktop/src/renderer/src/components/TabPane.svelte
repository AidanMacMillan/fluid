<script lang="ts">
  import { untrack } from 'svelte'
  import type { Tab } from '../../../main/db/schema'
  import type { MeasuredBounds } from '../../../main/browser-views'
  import {
    documentStateOf,
    DOCUMENT_GUTTER,
    MIN_DOCUMENT_WIDTH,
    MOBILE_WIDTH,
    type DocumentMode
  } from '../lib/document-width'
  import type { PanePlace } from '../lib/splits'
  import { views } from '../lib/views.svelte'
  import { workspace } from '../lib/workspace.svelte'
  import BrowserChrome from './BrowserChrome.svelte'
  import FileChrome from './FileChrome.svelte'
  import FilePane from './FilePane.svelte'
  import IconButton from './IconButton.svelte'
  import PageErrorPane from './PageErrorPane.svelte'
  import ResizeHandle from './ResizeHandle.svelte'
  import ViewStopped from './ViewStopped.svelte'
  import { extensions } from '../lib/extensions.svelte'

  type Props = {
    /** Fixed for the pane's life: the surface keys its panes by tab. */
    tab: Tab
    /** Where the pane sits in the page area, for carrying it through a resize. */
    place: PanePlace
    /** Whether this is the tab in front — in a split, the pane being worked in. */
    focused: boolean
    /** Whether it shares the page area with other panes. */
    split: boolean
  }

  const { tab, place, focused, split }: Props = $props()

  /**
   * The page area is a hole in the renderer, not a rendered thing: pages are
   * native `WebContentsView`s the main process positions on top of the window.
   * This element exists to be measured; the well around it draws the rounded
   * edge and shadow the native layer cannot draw for itself. It sits below the
   * chrome bar, so the bar stays visible rather than being covered by the page.
   *
   * It is a proxy rather than the box the renderer's own panes live in, and
   * draws nothing itself. That is what lets a document be narrowed to a phone's
   * width without the panes beside it being narrowed too — and what makes the
   * narrowing an animation for free, since a width in transition is a size
   * change every frame and the observer below reports every one of them.
   */
  let pageArea = $state<HTMLElement | null>(null)
  /** The box the proxy is centred in — watched for the reason given below. */
  let pageWell = $state<HTMLElement | null>(null)
  // `$state.raw`, not `$state`: deep state hands back a Proxy, and a Proxy
  // cannot be structured-cloned across the IPC boundary. The rect is replaced
  // wholesale on every measure anyway, so there is nothing for deep state to do.
  let bounds = $state.raw<MeasuredBounds>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    viewport: { width: 0, height: 0 },
    anchor: 'fill'
  })
  /** The well's own width, which is what a document's handles may drag out to. */
  let wellWidth = $state(0)

  $effect(() => {
    const element = pageArea
    const well = pageWell
    if (!element || !well) return undefined

    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      // With the window it was measured in and how it sits there, so the main
      // process can carry it through a resize this has not caught up with (see
      // `rebase` in src/main/browser-views.ts). Untracked: the effect is for
      // the elements, and a narrowed document or a moved divider resizes the
      // proxy anyway.
      const centred = untrack(() => sizedTab !== null && documentWidth < maxWidth)
      const { x, y } = untrack(() => place)
      bounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        anchor: centred ? 'center' : 'fill',
        span: { left: x.from, right: x.to, top: y.from, bottom: y.to }
      }
      wellWidth = well.getBoundingClientRect().width
    }

    measure()
    // The observer catches layout changes; the window listener catches moves
    // that leave the element's own size untouched, which it does not report.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // The well as well as the proxy, because a proxy at a phone's width is a
    // fixed size: the sidebar sliding moves it without resizing it, and a
    // `ResizeObserver` reports sizes and not positions. At full width the proxy
    // changes size with the well and would be caught either way — it is the
    // narrowed one that would otherwise be left behind where it was.
    observer.observe(well)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  })

  /**
   * Why the tab's page is blank, when it is. A failed navigation commits an
   * empty document — Electron has none of Chrome's net-error pages — so the
   * view has nothing to draw and the renderer says what happened instead.
   */
  const pageError = $derived(
    tab.type === 'browser' ? (workspace.pages[tab.id]?.error ?? null) : null
  )

  /**
   * The viewer drawing the tab's file, when it is a file tab and a running
   * extension offers one. Every file is drawn in a view of its own, the same
   * way a page is: a page of the viewer's extension, or Chromium rendering the
   * file itself (see `showFileView` in src/main/browser-views.ts).
   */
  const fileViewer = $derived(
    tab.type === 'file' ? extensions.fileViewer(tab.payload.mimeType) : null
  )

  /**
   * The stored file the tab wants a view put up for, if it wants one. Null for
   * every other tab; for a file nothing can draw; for one there is not yet all
   * of — a download half landed is not a document — and for one whose view has
   * already said it could not load it, which the pane explains (see FilePane).
   */
  const fileKey = $derived.by(() => {
    if (tab.type !== 'file' || fileViewer === null) return null
    if (workspace.downloadsByTab[tab.id]) return null
    if (workspace.pages[tab.id]?.error != null) return null
    return tab.payload.storageKey
  })

  /**
   * The file whose width the user is steering, when the tab is one: an HTML
   * file, whose viewer asked for it (see `NativeFileViewDeclaration`).
   *
   * A PDF is drawn natively too but is not one of these: its page width was
   * decided when it was made, so there is nothing to choose and it gets the
   * whole well, with no handles and no toggle (see FileChrome).
   */
  const sizedTab = $derived(
    fileKey !== null &&
      tab.type === 'file' &&
      fileViewer?.view.kind === 'native' &&
      fileViewer.view.resizable
      ? tab
      : null
  )

  /**
   * How long the width takes to change, and a little over — the class is what
   * the browser animates against, and this is what decides when to take it
   * away, so it has to outlast the transition rather than end with it.
   */
  const WIDTH_TRANSITION_MS = 360

  /**
   * Whether the width is mid-change, which is the only time it is animated.
   *
   * Without this the same transition would run on a tab switch: arriving at a
   * document left narrow would draw it full width and squeeze it down, which is
   * not a change the user made and not one they should watch happen. It is also
   * what keeps a drag from easing — an edge the width lags behind is an edge
   * that does not feel attached to the pointer.
   */
  let animating = $state(false)
  let settle: ReturnType<typeof setTimeout> | undefined

  $effect(() => () => clearTimeout(settle))

  /**
   * The widest a document may be drawn: the well, less a gutter either side.
   * A well not yet measured has no answer, and the proxy stays at the full
   * width until it does rather than opening at the floor and jumping out.
   */
  const maxWidth = $derived(
    Math.max(MIN_DOCUMENT_WIDTH, Math.round(wellWidth) - 2 * DOCUMENT_GUTTER)
  )

  /**
   * What the document is actually drawn at. The stored width is the user's and
   * is left as they set it; this is that width as it fits today, so one dragged
   * wide on a large window still gets all of a small one rather than running
   * off the edge of it.
   */
  const documentWidth = $derived(
    Math.min(sizedTab === null ? maxWidth : (documentStateOf(sizedTab).width ?? maxWidth), maxWidth)
  )

  /**
   * Records a width the user has just set, by dragging an edge or by the
   * toggle. A width on the desktop side of the line is kept a second time as
   * the one to come back to, so that going to the phone and back is a round
   * trip rather than a way of losing the size you had chosen.
   */
  function setDocumentWidth(file: Extract<Tab, { type: 'file' }>, width: number | null): void {
    const { desktopWidth } = documentStateOf(file)
    workspace.setViewState(file.id, {
      width,
      desktopWidth: width === null || width > MOBILE_WIDTH ? width : desktopWidth
    })
  }

  /** The toggle: to the phone's width, or back to whatever the desktop last was. */
  function setDocumentMode(file: Extract<Tab, { type: 'file' }>, mode: DocumentMode): void {
    animating = true
    clearTimeout(settle)
    settle = setTimeout(() => (animating = false), WIDTH_TRANSITION_MS)
    setDocumentWidth(file, mode === 'mobile' ? MOBILE_WIDTH : documentStateOf(file).desktopWidth)
  }

  /**
   * Which kind of view the tab is drawn in, if it is an extension's drawn in
   * one of its own: its page, or a web application.
   */
  const extensionView = $derived(extensions.tabViewKind(tab.type))
  /** Whether its view draws its own bar, which the pane's would sit on top of. */
  const drawsBar = $derived(extensions.tabDrawsBar(tab.type))

  // Asked the first time the tab is looked at; see `views.prepare`.
  $effect(() => {
    if (extensionView === 'web') views.prepare(tab.id, tab.type)
  })

  $effect(() => {
    const tabId = tab.id
    const rect = bounds
    // The view draws on top of this window, so it has to step aside for the
    // error page rather than being drawn over: detached, not destroyed, which
    // is the same thing a tab switch does and costs the page nothing.
    const failed = pageError !== null
    const key = fileKey
    const room = rect.width > 0 && rect.height > 0
    const api = window.api.browser

    // Said before the view is asked for, so the main process knows which pane
    // is in front by the time this one arrives — an extension's view that takes
    // the keyboard on arrival only does so for that one.
    if (focused) api.focus(tabId)

    if (tabId === views.poppedOutTabId) {
      // The page is elsewhere, and nothing is put up in its place but the note
      // below. Read tracked: the tab coming home is the re-run that shows it.
      api.hide(tabId)
    } else if (tab.type === 'browser' && !failed && room) {
      // Read untracked: page titles rewrite the payload as pages load, and
      // tracking that would re-run this on every title change. The address is
      // only read the first time a view is made anyway.
      const { url, profile } = untrack(() =>
        tab.type === 'browser'
          ? { url: tab.payload.url, profile: tab.profile }
          : { url: '', profile: null }
      )
      // The space is read tracked, unlike the tab: a project moved into another
      // space is a page that has to be rebuilt in another session, and this is
      // the re-run that does it (see `attach` in src/main/browser-views.ts).
      api.show(tabId, url, workspace.activeSpaceId, profile, rect)
    } else if (
      tab.type === 'file' &&
      key !== null &&
      views.goneViews[tabId] === undefined &&
      room
    ) {
      // Read tracked, like an extension's view below: a viewer's page that
      // crashed stays down until the user clears it.
      api.showFile(tabId, key, rect)
    } else if (
      extensionView !== null &&
      (extensionView === 'page' || views.webViews[tabId]?.ok) &&
      views.goneViews[tabId] === undefined &&
      room
    ) {
      // All read tracked: an extension enabled while its tab is on screen is
      // the re-run that puts a view up, a web view's answer arriving is the one
      // that puts it on its address, and a crash cleared by the user is the one
      // that puts it back.
      api.showExtension(tabId, tab.type, rect)
    } else {
      api.hide(tabId)
    }
  })

  // The page leaves the screen with its pane — the tab switched away from, or
  // a split let go of. Only then: the id is read untracked, so nothing but the
  // pane going runs this.
  $effect(() => {
    const tabId = untrack(() => tab.id)
    return () => window.api.browser.hide(tabId)
  })

  /**
   * A click anywhere in a pane that is not in front brings its tab forward.
   * Only what the renderer draws — the chrome, a placeholder, an extension's
   * pane drawn here — reaches this; a click into a page arrives from the main
   * process instead (see `focusPane`).
   */
  function claim(event: PointerEvent): void {
    // Not for the button that takes the pane out of the split: bringing it
    // forward first would move the selection onto the very pane that is about
    // to leave the view.
    if ((event.target as Element).closest('[data-leaves-split]')) return
    if (!focused) void workspace.focusPane(tab.id)
  }
</script>

<!-- `onpointerdowncapture` rather than a click: the pane is brought forward as
     the button goes down, the way a window is, so the control under the
     pointer then acts in a pane that is already the one in front. -->
<div class="relative flex min-h-0 flex-1 flex-col" onpointerdowncapture={claim}>
  <!-- In a split, only the pane in front has its bar at full strength: with
       two address bars side by side, which one Cmd+L and the page shortcuts
       mean should not be left to guesswork. -->
  <div
    class="flex transition-opacity duration-150 {split && !focused
      ? 'opacity-55 hover:opacity-90'
      : ''}"
  >
    <div class="min-w-0 flex-1">
      {#if tab.type === 'browser'}
        <BrowserChrome {tab} />
      {:else if tab.type === 'file'}
        <!-- The file's bar sits in the row a page puts its address in, and above
           the area a native view covers — an HTML file's view would otherwise be
           drawn over it. -->
        <FileChrome {tab} onMode={(mode) => setDocumentMode(tab, mode)} />
      {:else if split && !drawsBar}
        <!-- A tab with no chrome of its own still needs a bar in a split: it is
           what says which pane is which, and which is in front. One whose view
           draws its own bar gets none from here, and offers the way out of the
           split in its own (see `PageViewDeclaration.drawsBar`). -->
        <div class="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-ink-400 pane-bar-edge">
          <span
            class="{extensions.tabView(tab.type)?.icon ??
              'icon-[ph--puzzle-piece]'} shrink-0 text-sm"
            aria-hidden="true"
          ></span>
          <span class="truncate">{workspace.labelFor(tab)}</span>
        </div>
      {/if}
    </div>
    {#if split && !drawsBar}
      <!-- The way out of the split, on every pane of it: the pane leaves the
           view and the rest close up over it, while the tab itself stays in the
           sidebar, open and where it was. A column of its own at the end of the
           bar rather than a control inside it, so no kind of chrome has to make
           room for it — the hairline under it continues the bar's. -->
      <div class="flex h-9 shrink-0 items-center pr-1.5 pane-bar-edge" data-leaves-split>
        <IconButton
          icon="icon-[ph--minus]"
          label="Remove from split"
          onclick={() => void workspace.removeFromSplit(tab.id)}
        />
      </div>
    {/if}
  </div>

  <div bind:this={pageWell} class="relative min-h-0 flex-1">
    <!-- The measured proxy. Empty and inert itself: it is a rectangle for the
         native layer to be laid into, not something the user ever sees. The
         transition is only on it while the toggle is moving it, never while an
         edge is being dragged. It is lifted above the panes so that the handles
         it carries are reachable — a pane is a later sibling covering the same
         box, and would otherwise take the clicks meant for them. -->
    <div
      bind:this={pageArea}
      style:width={sizedTab === null || wellWidth === 0 ? '100%' : `${documentWidth}px`}
      class="pointer-events-none absolute inset-y-0 left-1/2 z-10 -translate-x-1/2
             {animating ? 'transition-[width] duration-300 ease-out' : ''}"
    >
      {#if sizedTab !== null}
        <!-- An edge either side, both sitting just outside the proxy rather
             than on it: the view is native and takes every pointer event inside
             its own rect, so a handle overlapping it would be one nothing can
             reach. That is also what the gutter is for — even at its widest the
             document stops short of the well, so the handles are there to be
             grabbed in desktop and not only once it has been narrowed.

             The document is held in the middle, so one pixel of pointer is two
             of width, and the left edge counts the other way: travelling left
             is what makes it wider. -->
        {#each [-2, 2] as factor (factor)}
          <ResizeHandle
            label={factor < 0 ? 'Resize document from the left' : 'Resize document from the right'}
            width={documentWidth}
            min={MIN_DOCUMENT_WIDTH}
            max={maxWidth}
            {factor}
            markClass="inset-y-0"
            class="pointer-events-auto absolute inset-y-0 w-3 {factor < 0 ? '-left-3' : '-right-3'}"
            onresize={(width) => setDocumentWidth(sizedTab, width)}
            oncommit={(width) => setDocumentWidth(sizedTab, width)}
          />
        {/each}
      {/if}
    </div>

    <!-- Only ever visible when no native view is covering the proxy above. -->
    {#if tab.id === views.poppedOutTabId}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-ink-500">
        <span class="icon-[ph--picture-in-picture] text-3xl" aria-hidden="true"></span>
        <p class="text-xs">This tab is open in a floating window.</p>
        <button
          type="button"
          onclick={() => window.api.browser.popIn(tab.id)}
          class="flex items-center gap-1.5 rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300 hover:text-ink-50"
        >
          <span class="icon-[ph--arrow-square-in] text-sm" aria-hidden="true"></span>
          Bring it back
        </button>
      </div>
    {:else if tab.type === 'browser' && pageError}
      <PageErrorPane error={pageError} onRetry={() => window.api.browser.reload(tab.id)} />
    {:else if tab.type === 'file'}
      <FilePane
        {tab}
        stopped={views.goneViews[tab.id] !== undefined}
        onReload={() => views.revive(tab.id)}
      />
    {:else if tab.type !== 'browser'}
      <!-- An extension's tab, drawn by the extension: in a view of its own,
           which covers this, or here. -->
      {@const view = extensions.tabView(tab.type)}
      {#if extensionView !== null}
        {@const readiness = views.webViews[tab.id]}
        {#if views.goneViews[tab.id] !== undefined}
          <ViewStopped onReload={() => views.revive(tab.id)} />
        {:else if extensionView === 'web' && readiness?.ok !== true}
          <!-- Only ever seen before the application has an address, or when it
               will never have one: once it does, a native view covers this. -->
          <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-ink-500">
            <span class="{view?.icon ?? 'icon-[ph--puzzle-piece]'} text-3xl" aria-hidden="true"
            ></span>
            {#if readiness}
              <p class="max-w-sm text-center text-xs">{readiness.message}</p>
            {:else}
              <p class="text-xs">{view?.starting?.message ?? 'Starting…'}</p>
              {#if view?.starting?.detail}
                <p class="text-[11px] text-ink-600">{view.starting.detail}</p>
              {/if}
            {/if}
          </div>
        {/if}
      {:else if view?.pane}
        {@const Pane = view.pane}
        <Pane {tab} host={view.host} />
      {:else}
        <!-- Its extension is disabled or gone. The tab is kept — it comes back
             to life with the extension — and says why it is blank. -->
        <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-ink-500">
          <span class="icon-[ph--puzzle-piece] text-3xl" aria-hidden="true"></span>
          <p class="max-w-sm text-center text-xs">
            This tab belongs to an extension that is not enabled.
          </p>
        </div>
      {/if}
    {/if}
  </div>
</div>
