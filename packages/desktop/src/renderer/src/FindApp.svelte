<script lang="ts">
  import IconButton from './components/IconButton.svelte'
  import type { FindResult } from '../../main/find-bar'

  /**
   * The find bar: the strip held over the top-right corner of the page on
   * Cmd+F. A field, the count, and the three controls — back a match, on a
   * match, and done.
   *
   * It searches nothing itself. The page is a native view in another process
   * (see src/main/find-bar.ts), so everything here is a message out and the
   * count is a message back; even the query it opens with is handed to it,
   * because main is where a query has to live for Find Next to work with the
   * bar closed.
   */

  const api = window.api.find

  let query = $state('')
  let result = $state<FindResult>({ matches: 0, active: 0 })
  let field = $state<HTMLInputElement | undefined>()

  /**
   * Opening, which happens to a bar that may already be up: Cmd+F over an open
   * bar means "search for something else", so the field takes the focus back
   * and selects what is in it, ready to be typed over. The same call is what
   * puts the last query back when the bar has been closed and reopened.
   */
  $effect(() =>
    api.onOpen((state) => {
      query = state.query
      // After the assignment lands in the DOM. Selecting a value the field has
      // not been given yet selects the one it is replacing.
      void Promise.resolve().then(() => {
        field?.focus()
        field?.select()
      })
    })
  )

  $effect(() => api.onResult((next) => (result = next)))

  /**
   * Nothing to report on an empty field — a bar that says `0/0` before anything
   * has been asked for reads as a search that has already failed.
   */
  const count = $derived(query === '' ? null : `${result.active}/${result.matches}`)

  /** Whether there is anywhere to step to. Both arrows go dead together. */
  const steppable = $derived(result.matches > 0)

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    // Enter is the next match and Shift+Enter the one before it, which is what
    // the field is for once something has been typed into it. Escape is caught
    // in main, so that it holds however the field is being used.
    event.preventDefault()
    api.step(!event.shiftKey)
  }
</script>

<!-- The view around this is bigger than the bar, by exactly the room the shadow
     needs to fall in (see SHADOW_BLEED in src/main/find-bar.ts) — a view is a
     hard rectangle, and anything drawn outside it is clipped. The margin here
     is that room, and the size below is the bar the main process reserved.

     Near-opaque ink rather than the glass the app's own chrome is made of, and
     for the same reason the zoom pill is: this sits on whatever the page
     happens to be, so it cannot be thin and still be read. The inner hairline
     and the shadow are what hold it off a page that is already dark. -->
<div
  class="m-2.5 flex h-9 w-[340px] items-center gap-2 rounded-lg bg-ink-900/92 px-2.5
         text-ink-100 shadow-lg ring-1 ring-white/12"
>
  <span class="icon-[ph--magnifying-glass] shrink-0 text-sm text-ink-500" aria-hidden="true"></span>

  <!-- `select-text` because the app sets `user-select: none` on the body: every
       other surface here is chrome, and this is the one field on this page. -->
  <input
    bind:this={field}
    bind:value={query}
    oninput={() => api.query(query)}
    onkeydown={onKeydown}
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    aria-label="Find in page"
    placeholder="Find in page"
    class="w-full min-w-0 cursor-text bg-transparent text-sm text-ink-50 outline-none
           select-text placeholder:text-ink-500"
  />

  {#if count}
    <!-- Tabular figures so the count holds its width: it is rewritten on every
         keystroke, and digits of different widths would shift the controls
         beside it under the pointer. -->
    <span
      class="shrink-0 text-[0.6875rem] tabular-nums {steppable ? 'text-ink-400' : 'text-ink-500'}"
      aria-live="polite"
    >
      {count}
    </span>
  {/if}

  <!-- The seam between what you are asking and what you do with the answer —
       the same hairline the launcher draws under its field. -->
  <span class="h-4 w-px shrink-0 bg-white/10" aria-hidden="true"></span>

  <IconButton
    icon="icon-[ph--caret-up]"
    label="Previous match"
    size="sm"
    disabled={!steppable}
    onclick={() => api.step(false)}
  />
  <IconButton
    icon="icon-[ph--caret-down]"
    label="Next match"
    size="sm"
    disabled={!steppable}
    onclick={() => api.step(true)}
  />
  <IconButton icon="icon-[ph--x]" label="Close find bar" size="sm" onclick={() => api.close()} />
</div>
