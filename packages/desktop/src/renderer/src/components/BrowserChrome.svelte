<script lang="ts">
  import { untrack } from 'svelte'
  import { isWebAddress } from '@fluid/sdk'

  import type { Tab } from '../../../main/db/schema'
  import { profileById } from '../../../main/profiles'
  import { PROFILE_SWATCH } from '../lib/profile-colors'
  import { searchEngines } from '../lib/search-engine.svelte'
  import { resolveInput } from '../lib/urls'
  import { workspace } from '../lib/workspace.svelte'
  import IconButton from './IconButton.svelte'

  const { tab }: { tab: Extract<Tab, { type: 'browser' }> } = $props()

  const api = window.api.browser

  // The native view is the authority on where it actually is; the stored
  // payload only covers the moment before its first load reports back.
  const page = $derived(workspace.pages[tab.id])
  const url = $derived(page?.url || tab.payload.url)

  // Read out one field at a time rather than off `page`, which is a fresh
  // object on every push: the load bar's timers restart whenever what they
  // depend on changes, and a title arriving is no reason to restart them.
  const loading = $derived(page?.loading ?? false)
  const reported = $derived(page?.progress ?? null)
  const failed = $derived(page?.error != null)

  /**
   * How full the load bar is, 0–1, or null when there is no bar to draw. Held
   * here rather than taken from `reported` directly because the bar outlives
   * the load by a moment — it fills to the end and fades, which is the part
   * that reads as arrival — and because it keeps moving between the landmarks
   * the main process reports.
   */
  let fill = $state<number | null>(null)

  /** Set for the beat between the bar reaching the end and leaving. */
  let finishing = $state(false)

  let creep: ReturnType<typeof setInterval> | undefined
  let settle: ReturnType<typeof setTimeout> | undefined

  function stopTimers(): void {
    clearInterval(creep)
    clearTimeout(settle)
    creep = undefined
    settle = undefined
  }

  /**
   * Where the bar is allowed to drift to while it waits for the next landmark.
   * Short of that landmark, always: the drift is the bar saying the load is
   * still running, and arriving early at a place the page has not reached
   * would make the landmark itself land as a stall rather than as progress.
   */
  function ceilingFor(landmark: number): number {
    if (landmark < 0.45) return 0.4
    if (landmark < 0.8) return 0.74
    return 0.96
  }

  /**
   * The bar's own movement, between the three moments the page actually
   * reports. A load is not a download — nothing counts a page's bytes on the
   * way in — so this is the one part that is a picture rather than a
   * measurement: an ease that slows as it goes, never arriving, which says
   * "still working" without claiming to know how much is left.
   */
  $effect(() => {
    // The tab id is one of the dependencies, and read for that alone: the same
    // bar is reused as the user moves between browser tabs, and what it is
    // drawing has to move with them.
    const forTab = tab.id
    const isLoading = loading
    const landmark = reported
    const isFailed = failed
    if (!forTab) return undefined

    if (isLoading && landmark !== null) {
      // A landmark below where the bar already is means a new load began —
      // a redirect, or the user going somewhere else mid-load — so the bar
      // starts over rather than carrying the last one's fill forward.
      const held = untrack(() => fill)
      fill = held === null || landmark < held ? landmark : Math.max(held, landmark)
      finishing = false

      creep = setInterval(() => {
        const ceiling = ceilingFor(landmark)
        if (fill === null || fill >= ceiling) return
        fill += (ceiling - fill) * 0.1
      }, 400)
    } else if (untrack(() => fill) !== null) {
      // A load that failed has no arrival to draw, so the bar leaves without
      // filling: running it to the end would report the blank page that
      // replaces it as a page that made it.
      if (isFailed) {
        fill = null
        finishing = false
      } else {
        fill = 1
        // Long enough for the fill to the end to be seen before the fade
        // starts, which is the whole of what the last beat is for.
        settle = setTimeout(() => {
          finishing = true
          settle = setTimeout(() => {
            fill = null
            finishing = false
          }, 200)
        }, 220)
      }
    }

    return stopTimers
  })

  /**
   * The tab whose address is being edited, rather than a plain flag: the same
   * bar is reused as the user moves between browser tabs, and a half-typed
   * address belongs to the tab it was being typed into. Leaving that tab puts
   * the bar back to reporting, which is what a browser does with a tab switch.
   */
  let editingTabId = $state<string | null>(null)
  const editing = $derived(editingTabId === tab.id)

  /** What is in the field. Seeded from the full address, scheme and all — that
      is the form worth editing, and the one worth pasting over. */
  let draft = $state('')
  let addressInput: HTMLInputElement

  // Navigation reaches the native view asynchronously. Keep the submitted
  // address until it reports the new URL (including redirects) or finishes.
  let submitted = $state<{
    tabId: string
    url: string
    previousUrl: string
    started: boolean
  } | null>(null)
  const address = $derived(submitted?.tabId === tab.id ? submitted.url : url)
  const visibleAddress = $derived(editing ? draft : address)
  const suffixStart = $derived(visibleAddress.search(/[?#]/))
  const addressMain = $derived(
    suffixStart < 0 ? visibleAddress : visibleAddress.slice(0, suffixStart)
  )
  const addressSuffix = $derived(suffixStart < 0 ? '' : visibleAddress.slice(suffixStart))

  $effect(() => {
    if (!submitted) return
    if (
      submitted.tabId !== tab.id ||
      url !== submitted.previousUrl ||
      (submitted.started && !loading)
    ) {
      submitted = null
    } else if (loading) {
      submitted.started = true
    }
  })

  function beginEditing(): void {
    draft = address
    editingTabId = tab.id
  }

  /**
   * The tab whose address was just copied from the button, held for a beat so
   * the link turns into a tick. A tab rather than a flag for the reason
   * `editingTabId` is one: the bar is reused across tabs.
   */
  let copiedTabId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  async function copyUrl(): Promise<void> {
    if (!address) return
    await navigator.clipboard.writeText(address)
    copiedTabId = tab.id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedTabId = null), 1200)
  }

  function stopEditing(): void {
    editingTabId = null
    addressInput?.blur()
  }

  $effect(() => {
    const currentTabId = tab.id
    if (untrack(() => editingTabId !== null && editingTabId !== currentTabId)) stopEditing()
  })

  function commit(): void {
    const target = resolveInput(draft, searchEngines.current)
    // A pinned tab stays on its site: an address on another one gets a tab of
    // its own, and this one is left exactly as it was.
    if (target && isWebAddress(target) && workspace.leavesPinnedSite(tab, target)) {
      stopEditing()
      void workspace.openRequestedTab({
        sourceTabId: tab.id,
        url: target,
        background: false,
        profile: tab.profile
      })
      return
    }
    if (target && isWebAddress(target)) {
      submitted = { tabId: tab.id, url: target, previousUrl: url, started: false }
    }
    stopEditing()
    if (target) api.navigate(tab.id, target)
  }

  // Unlike the rename field on a task tab, blur abandons rather than commits:
  // clicking away from a half-typed address is how a browser is told to forget
  // it, and going there instead would navigate on every stray click. Enter is
  // the only thing that loads anything.
  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter') commit()
    else stopEditing()
  }

  /**
   * Which login this page is, drawn on the bar as well as on the tab's row. The
   * sidebar can be away — and a tab in a profile is exactly the tab whose
   * identity is worth being sure of before acting on it, which is the moment
   * the row carrying that news alone is not enough.
   *
   * Nothing at all for the default profile: it is what almost every page is,
   * and marking it would make the ordinary case look like a state.
   */
  const profile = $derived(profileById(tab.profile))

  async function pickProfile(): Promise<void> {
    const choice = await window.api.profiles.pick({
      verb: 'reopen',
      current: tab.profile,
      allowReset: true
    })
    if (!choice) return

    if (choice.kind === 'reset') await workspace.resetProfile(choice.profile)
    else await workspace.reopenInProfile(tab.id, choice.profile)
  }
</script>

<!-- A native browser view can take window focus without blurring the active
     DOM element. Leaving the renderer must discard an address draft too. -->
<svelte:window onblur={stopEditing} />

<!-- Back/forward/reload sit in the flow on the left; the address is taken out of
     it and centred on the bar itself, so the controls' width never pulls it off
     centre. -->
<div class="relative flex h-9 shrink-0 items-center gap-0.5 px-2 pane-bar-edge">
  <IconButton
    icon="icon-[ph--arrow-left]"
    label="Back"
    disabled={!page?.canGoBack}
    onclick={() => api.goBack(tab.id)}
  />
  <IconButton
    icon="icon-[ph--arrow-right]"
    label="Forward"
    disabled={!page?.canGoForward}
    onclick={() => api.goForward(tab.id)}
  />
  <IconButton icon="icon-[ph--arrow-clockwise]" label="Reload" onclick={() => api.reload(tab.id)} />

  {#if profile}
    <!-- Pushed to the far end of the bar, clear of the address centred over it.
         A colour and nothing else for the five reusable profiles, the same as
         the tab's row: what one is called is for the places a colour cannot be
         read — the tooltip, and the name the button carries for a screen
         reader.

         Incognito gets the glyph instead. It is the one profile whose meaning
         is not "which of the five" but "this will not be kept", and that is
         worth saying in a mark every browser has taught people to read rather
         than in a sixth colour they would have to learn. -->
    <button
      type="button"
      title={profile.ephemeral
        ? `${profile.name} — cleared when its last tab closes`
        : profile.name}
      onclick={() => void pickProfile()}
      class="z-10 ml-auto flex size-6 shrink-0 items-center justify-center rounded-md glass-control"
    >
      {#if profile.ephemeral}
        <span class="icon-[ph--detective] text-sm text-ink-300" aria-hidden="true"></span>
      {:else}
        <span class="size-2 rounded-full {PROFILE_SWATCH[profile.color]}" aria-hidden="true"></span>
      {/if}
      <span class="sr-only">{profile.name}</span>
    </button>
  {/if}

  <!-- The row is inert and its children are not: it spans the whole bar, so
       taking pointer events would put its side padding over the controls and
       swallow their clicks. The padding keeps a long address clear of them. -->
  <div class="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1 px-24">
    <IconButton
      icon={copiedTabId === tab.id ? 'icon-[ph--check]' : 'icon-[ph--link]'}
      label="Copy URL"
      class="pointer-events-auto"
      onclick={() => void copyUrl()}
    />
    <!-- One native input keeps pointer placement and drag-selection intact.
         Size from the visible text, so typing grows or shrinks the field while
         focusing alone leaves its width unchanged.
         Keep the full URL visible in every state: revealing a scheme on focus
         would shift the text underneath the initial click. -->
    <div class="group/address pointer-events-auto relative min-w-0 text-xs">
      <!-- The sizing text also paints the idle address. Let the input paint
           its own text while editing so selection and horizontal scrolling
           remain native. Both layers use the same text and font metrics.
           The input transitions only its background and focus ring: fading
           its text from transparent would leave a gap when this layer hides. -->
      <span
        aria-hidden="true"
        class="pointer-events-none relative z-10 block overflow-hidden px-2 py-0.5 whitespace-pre text-ink-400 select-none group-hover/address:text-ink-200 {editing
          ? 'invisible'
          : ''}"
      >
        {addressMain || '\u200b'}<span class="opacity-60">{addressSuffix}</span>
      </span>
      <input
        bind:this={addressInput}
        value={visibleAddress}
        onfocus={beginEditing}
        oninput={(event) => (draft = event.currentTarget.value)}
        onblur={stopEditing}
        onkeydown={onKeydown}
        title={address}
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        aria-label="Address"
        class="absolute inset-0 size-full min-w-0 cursor-text rounded-md glass-control px-2 py-0.5 text-center transition-[background-color,box-shadow] outline-none selection:bg-accent/30 selection:text-ink-50 focus:bg-selected focus:ring-1 focus:ring-selected-edge {editing
          ? 'text-ink-50'
          : 'text-transparent'}"
      />
    </div>
  </div>

  <!-- Across the foot of the bar, where every browser has taught people to look
       for this — but held clear of the seam itself rather than sitting on it.
       The page below is a native view positioned over the window, and it takes
       the last pixel row of the seam with it: a bar laid on the edge loses its
       lower half under the page, which is the same reason the hairline above
       is an inset shadow rather than a border. `aria-hidden`: the row in the
       sidebar carries the same news in a form a screen reader can read, and a
       bar that is only a shape says nothing twice. -->
  {#if fill !== null}
    <span
      class="absolute inset-x-0 bottom-0.5 h-0.5 load-bar {finishing ? 'opacity-0' : ''}"
      style="transform: scaleX({fill})"
      aria-hidden="true"
    ></span>
  {/if}
</div>
