<script lang="ts">
  import { storedFileUrl } from '@fluid/sdk'
  import type { ClipboardEntry } from '../../main/db/schema'
  import type { ClipboardContext } from '../../main/clipboard-window'
  import {
    detailFor,
    fileNamesOf,
    hasFormatting,
    iconFor,
    isTruncated,
    matches,
    needsSanitising,
    previewOf
  } from './lib/clipboard-entries'
  import { sanitiseClipboardHtml } from './lib/clipboard-html'
  import { relativeTime } from './lib/time'

  /**
   * The clipboard panel: everything copied while this task was in front, newest
   * first, with a field to narrow it and Enter to put one back.
   *
   * Built to read as the same kind of thing as the new-tab panel — a field, a
   * line, and a list the arrow keys walk — because it is: a surface held over
   * the app for a few seconds that you type at and take one row from. What
   * differs is what a row carries. The launcher offers places to go, so its rows
   * are a name and an address; these rows are the content itself, which is why
   * the panel is wider and why a row may be a picture.
   *
   * It decides nothing about capture. Which task it is looking at is settled
   * before it loads (see src/main/clipboard-window.ts), and asked for here
   * rather than passed in.
   */

  const api = window.api

  /**
   * The tallest a copied picture is drawn. A cap rather than a size: an image
   * shorter than this is shown at its own dimensions, because what was copied is
   * what the row is about and scaling a 40px icon up to fill a box would
   * misrepresent it.
   *
   * Sized so that about three of them fit the panel at once — enough that
   * scrolling a run of screenshots is scanning rather than paging, and enough of
   * each one to tell which screenshot it is.
   */
  const IMAGE_PREVIEW_HEIGHT = 128

  /** Which task's history this is. Null only while the first ask is in flight. */
  let context = $state<ClipboardContext | null>(null)

  let entries = $state<ClipboardEntry[]>([])
  let loaded = $state(false)

  let query = $state('')

  /**
   * The row Enter would restore. Put back to the top on every keystroke, for the
   * reason the launcher does it: the list is rebuilt as the query filters it, so
   * a selection that survived would be sitting on a different row than the one
   * it was put on.
   */
  let selected = $state(0)

  /**
   * The clock the stamps are read against, ticked so that "just now" becomes
   * "2 minutes ago" while the panel is open rather than only when it is
   * reopened. One clock for every row, so they all move together.
   */
  let now = $state(Date.now())

  const shown = $derived(entries.filter((entry) => matches(entry, query)))

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })

  $effect(() => {
    void load()
  })

  async function load(): Promise<void> {
    const opened = await api.clipboardWindow.context()
    context = opened
    if (opened) entries = await api.clipboard.list(opened.taskId)
    loaded = true
  }

  /**
   * Works out how the rich entries should be drawn, and remembers the answer.
   *
   * This is the one thing the panel does that the capture could not: copies are
   * filed in the main process, which has no DOM and so cannot run the sanitiser
   * over the markup it caught. So a rich entry arrives unresolved and the first
   * panel to see it settles the question — either with markup worth drawing, or
   * by finding that the markup said no more than the text did, which relabels
   * the entry as the plain text it turned out to be.
   *
   * One pass, one assignment. Patching the rows individually would re-enter this
   * effect once per entry; as written it runs a second time, finds nothing left
   * to ask, and stops. After that there is nothing in the task that needs asking
   * again, however often the panel is reopened.
   */
  $effect(() => {
    if (!loaded) return

    const pending = entries.filter((entry) => needsSanitising(entry) && entry.html !== null)
    if (pending.length === 0) return

    const resolved = new Map(
      pending.map((entry) => [entry.id, sanitiseClipboardHtml(entry.html ?? '', entry.text)])
    )

    for (const [id, safeHtml] of resolved) void api.clipboard.resolve(id, safeHtml)

    // Patched here as well as written, rather than re-reading the list: the rows
    // are already on screen, and the round trip would repaint every one of them
    // to change a handful.
    entries = entries.map((row) => {
      if (!resolved.has(row.id)) return row
      const safeHtml = resolved.get(row.id) ?? null
      return { ...row, safeHtml, kind: safeHtml === null ? ('text' as const) : row.kind }
    })
  })

  /** Puts a row back on the clipboard. The panel closes itself once it lands. */
  function restore(entry: ClipboardEntry | undefined): void {
    if (!entry || isTruncated(entry)) return
    void api.clipboard.restore(entry.id)
  }

  /**
   * Forgets one row. The selection stays where it is rather than following the
   * row that went, so holding the chord deletes down the list from one place —
   * which is what the gesture is for.
   */
  async function forget(entry: ClipboardEntry): Promise<void> {
    await api.clipboard.delete(entry.id)
    entries = entries.filter((row) => row.id !== entry.id)
    selected = Math.max(0, Math.min(selected, shown.length - 1))
  }

  /** Focus the field the moment the panel appears: it is what the panel opens for. */
  function autofocus(node: HTMLInputElement): void {
    node.focus()
  }

  /**
   * Arrow keys walk the list and Enter restores. Wrapped at both ends, as the
   * launcher's are. Escape is deliberately absent — the main process closes the
   * panel wherever focus is, so it holds for the list as well as the field.
   *
   * Cmd+Backspace forgets the selected row. The destructive one is the chord
   * rather than the bare key, because the bare key is how a bad filter gets
   * cleared and the two would otherwise be one keystroke apart.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof Element && event.target.closest('button')) return
    if (shown.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selected = (selected + 1) % shown.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      selected = (selected - 1 + shown.length) % shown.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      restore(shown[selected])
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const entry = shown[selected]
      if (entry) void forget(entry)
    }
  }

  /** The panel itself, measured so the window can be sized to it. */
  let panel = $state<HTMLElement | null>(null)

  /**
   * Tells the window how tall the panel actually is, exactly as the launcher
   * does: the list grows and shrinks as the query filters it, and a window sized
   * off a guess is either clipping the last row or trailing empty glass below it.
   */
  $effect(() => {
    const element = panel
    if (!element) return undefined

    const report = (): void => api.clipboardWindow.resize(element.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  })

  /**
   * What to draw when the picture will not load — a row that outlived its file,
   * which a store emptied by hand or a half-finished write can both produce.
   *
   * The small preview made at capture is stored on the row itself, so there is
   * something to fall back to that needs no file at all. It is the one thing
   * that thumbnail is still for now that the rows draw the real picture, and it
   * is why the column is worth keeping.
   *
   * Handed out per entry rather than read off the event, and it clears the
   * handler as it fires: a thumbnail that also fails would otherwise put the
   * element straight back into the state that called this.
   */
  function fallBackToThumbnail(entry: ClipboardEntry) {
    return (event: Event): void => {
      const image = event.currentTarget as HTMLImageElement
      image.onerror = null
      if (entry.thumbnail) image.src = entry.thumbnail
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- No background of its own: the window's vibrancy material, under the tint
     its body is laid with (`body[data-panel]` in main.css), is what the panel is
     made of, and anything opaque here would cover it. -->
<div bind:this={panel} class="flex flex-col text-ink-100 select-none text-on-glass">
  <!-- The field, and the one line in the panel: the seam between what you are
       narrowing the list to and the list itself. The chip names the task, which
       is the whole of what makes this history *this* history. -->
  <div class="flex items-center gap-2.5 border-b border-white/10 px-4 py-3.5">
    <span class="icon-[ph--clipboard-text] shrink-0 text-base text-ink-500" aria-hidden="true"
    ></span>
    {#if context?.taskTitle}
      <span
        class="max-w-40 shrink-0 truncate rounded-md bg-white/10 px-2 py-1 text-[0.6875rem]
               font-medium text-ink-200"
        title={context.taskTitle}
      >
        {context.taskTitle}
      </span>
    {/if}
    <input
      use:autofocus
      bind:value={query}
      oninput={() => (selected = 0)}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label="Filter clipboard history"
      placeholder="Filter clipboard history"
      class="min-w-0 flex-1 cursor-text bg-transparent text-sm text-ink-50 outline-none
             placeholder:text-ink-500"
    />
  </div>

  {#if loaded && entries.length === 0}
    <p class="px-4 py-3 text-[0.6875rem] leading-relaxed text-ink-500">
      Nothing in the clipboard history for this task.
    </p>
  {:else if loaded && shown.length === 0}
    <p class="px-4 py-3 text-[0.6875rem] leading-relaxed text-ink-500">
      Nothing copied in this task matches that.
    </p>
  {/if}

  {#if shown.length > 0}
    <!-- Scrolls rather than growing without end: the window caps the panel's
         height (see MAX_HEIGHT in src/main/clipboard-window.ts), and a list that
         outgrew the cap would be cut off with no way to reach the rest. -->
    <ul
      aria-label="Clipboard history"
      class="flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto p-1.5"
    >
      {#each shown as entry, index (entry.id)}
        <!-- The row itself is not a button. It was, once, and the whole of it
             was the target — but that made the one thing a clipboard history is
             full of, text, impossible to select: a press inside a button starts
             a press, not a selection. So the row is inert and the actions it
             used to stand for have moved out to the buttons on its right. -->
        <li class="relative">
          <!-- Hover moves the selection rather than drawing a highlight of its
               own: one row is the row Enter would take, however the pointer and
               the arrow keys got it there. -->
          <div
            aria-selected={index === selected}
            onmouseenter={() => (selected = index)}
            class="flex w-full items-start gap-2.5 rounded-lg glass-control py-2 pr-16 pl-2.5
                   text-left"
          >
            <!-- Every row leads with its glyph, images included: the picture
                 itself is the row's content, and a thumbnail beside it would be
                 the same thing twice at two sizes. -->
            <span
              class="{iconFor(entry)} mt-0.5 shrink-0 text-base {index === selected
                ? 'text-ink-200'
                : 'text-ink-500'}"
              aria-hidden="true"
            ></span>

            <!-- Selectable, and with the caret to say so. This is the half of
                 the row that is the copy itself, so a user who wants one line
                 out of a longer one can take it here rather than restoring the
                 whole entry and trimming it after the paste. -->
            <div class="flex min-w-0 flex-1 cursor-text flex-col gap-1 select-text">
              {#if isTruncated(entry)}
                <span class="truncate text-xs text-ink-500 italic">
                  Content was too large to keep
                </span>
              {:else if entry.kind === 'image' && entry.storageKey}
                <!-- The picture at its own size, capped. Not `object-fit` into a
                     fixed box: a screenshot cropped to a strip is unrecognisable,
                     and a small copied icon blown up to fill one is a lie about
                     what was copied. Width and height both left to the image, so
                     a wide one runs out of row before it runs out of cap and a
                     tall one the other way round.

                     The same on every row, whether or not it is selected. The
                     obvious economy — the full picture only where the user is
                     looking, a thumbnail everywhere else — makes the row change
                     height as the pointer crosses it, and a list that moves under
                     the cursor is worse than any amount of decoding.

                     `loading="lazy"` is what pays for that: the panel scrolls
                     about three of these at a time, so a task at its two-hundred
                     cap still only decodes what is on screen. -->
                <img
                  src={storedFileUrl(entry.storageKey)}
                  alt=""
                  loading="lazy"
                  onerror={fallBackToThumbnail(entry)}
                  class="max-w-full self-start rounded"
                  style:max-height="{IMAGE_PREVIEW_HEIGHT}px"
                />
              {:else if entry.kind === 'files'}
                <!-- The names, with the paths a hover away: the folder is what
                     tells two files of the same name apart, and the row has no
                     width to spare for it. -->
                <span class="line-clamp-2 text-xs break-all text-ink-100" title={entry.text}>
                  {fileNamesOf(entry)}
                </span>
              {:else if hasFormatting(entry) && entry.safeHtml}
                <!-- The one place copied markup is drawn. It has been through
                     the allowlist in ./lib/clipboard-html.ts first, and the
                     panel's own CSP stands behind that: nothing here can run,
                     and nothing here can fetch. Clipped rather than scrolled,
                     because a row is a glance at what was copied and the whole
                     of it is one paste away. -->
                <div class="rich-preview max-h-16 overflow-hidden text-xs text-ink-100">
                  <!-- The rule below is right about `{@html}` in general, and
                       this is exactly the case it warns about: markup somebody
                       else wrote, drawn into a document that carries the preload
                       bridge. What makes it safe is not that the source is
                       trusted — it is not — but that `safeHtml` is the *output*
                       of the allowlist walker rather than anything that was
                       copied. Every script, handler, style block and
                       URL-bearing attribute is gone by this point, because the
                       walker rebuilds a fresh tree out of the dozen tags it
                       knows instead of removing what it does not (see
                       ./lib/clipboard-html.ts). The panel's CSP stands behind
                       that, and the raw markup — the thing that actually goes
                       back on the clipboard — is never rendered anywhere. -->
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  {@html entry.safeHtml}
                </div>
              {:else}
                <span class="line-clamp-2 text-xs break-all text-ink-100">
                  {previewOf(entry.text)}
                </span>
              {/if}

              <span class="truncate text-[0.6875rem] text-ink-500">
                {detailFor(entry)} · {relativeTime(entry.createdAt, now)}
              </span>
            </div>
          </div>

          <!-- Out of the way until the row is the one being looked at. A history
               being scanned should read as content, not as a column of buttons.
               `focus-within` on the pair rather than `focus-visible` on each, so
               that tabbing to either one brings both into view instead of
               revealing a button beside an invisible sibling. -->
          <div
            class="absolute top-2 right-2 flex items-center gap-1 focus-within:opacity-100
                   {index === selected ? 'opacity-100' : 'opacity-0'}"
          >
            <!-- What clicking the row used to do. Named rather than implied,
                 because the row no longer reads as a thing you press: with the
                 text selectable there has to be somewhere unambiguous to put
                 the copy, and this is it. Enter still does the same for the
                 selected row, so the keyboard never has to come over here. -->
            <button
              type="button"
              aria-label="Copy to clipboard"
              title="Copy"
              disabled={isTruncated(entry)}
              onclick={() => restore(entry)}
              class="grid size-6 place-items-center rounded-md glass-control text-ink-500
                     hover:text-ink-100 disabled:pointer-events-none disabled:opacity-40"
            >
              <span class="icon-[ph--copy] text-xs" aria-hidden="true"></span>
            </button>

            <button
              type="button"
              aria-label="Forget this entry"
              title="Forget"
              onclick={() => void forget(entry)}
              class="grid size-6 place-items-center rounded-md glass-control text-ink-500
                     hover:text-ink-100"
            >
              <span class="icon-[ph--x] text-xs" aria-hidden="true"></span>
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* The copied markup's own look, applied from out here because `{@html}`
     content carries none of Svelte's scoping attributes — so a plain rule in
     this block would never reach it.

     Kept deliberately thin. The point of a rich row is that bold reads as bold
     and a colour survives, not that the row reproduces the source's typography:
     a panel that inherited a page's font sizes would have rows of wildly
     different heights for no gain. So the copy's own block rhythm is flattened
     to the row's, and only its inline character comes through.

     Plain CSS values rather than Tailwind's `--alpha()` and friends: this block
     is processed by Svelte, not by the Tailwind plugin, so a build-time
     function here would be shipped to the browser verbatim and ignored. */
  .rich-preview :global(*) {
    font-size: inherit;
    line-height: 1.4;
    margin: 0;
    padding: 0;
  }

  .rich-preview :global(ul),
  .rich-preview :global(ol) {
    padding-left: 1.1em;
  }

  .rich-preview :global(ul) {
    list-style: disc;
  }

  .rich-preview :global(ol) {
    list-style: decimal;
  }

  .rich-preview :global(li) {
    list-style: inherit;
  }

  /* A link that was a link. There is no `href` on it — the sanitiser drops every
     URL rather than vetting one — so nothing here is clickable, and the
     underline is all that is left of what it was. */
  .rich-preview :global(a) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .rich-preview :global(table) {
    border-collapse: collapse;
  }

  .rich-preview :global(td),
  .rich-preview :global(th) {
    padding: 0 0.4em;
    text-align: left;
  }

  /* Where a picture was. The picture itself never crosses — an `<img>` in copied
     markup points at somebody else's server, and fetching it would report that
     the user had looked at their own clipboard history. */
  .rich-preview :global([data-clipboard-image]) {
    display: inline-block;
    border-radius: 0.25rem;
    background-color: rgb(255 255 255 / 0.1);
    padding: 0 0.35em;
    font-size: 0.9em;
    color: var(--theme-ink-400);
  }
</style>
