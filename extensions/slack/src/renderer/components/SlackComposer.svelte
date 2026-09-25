<script lang="ts">
  import { untrack } from 'svelte'
  import type { ThreadUser } from '../../main/slack-thread'
  import { slackWorkspace } from '../lib/slack.svelte'
  import SlackAvatar from './SlackAvatar.svelte'

  /**
   * Writing a reply, mentions included.
   *
   * ## Why this is a `contenteditable` and not a `<textarea>`
   *
   * Slack does not accept a mention as text. `@Aidan MacMillan` sent as-is
   * arrives as those literal characters and notifies nobody: the wire format is
   * `<@U024BE7LH>`, and Slack will not resolve a display name into one for us
   * (`link_names` matches the `@handle`, not the name, and is unreliable
   * besides). So the composer has to keep, for every mention, both what the
   * user sees and the id it stands for.
   *
   * A textarea can only hold the first. The usual patch — a side table of
   * character offsets — survives typing at the end and falls apart the moment
   * anybody edits in the middle, which is exactly when a mention silently turns
   * into plain text.
   *
   * So each mention is an element: `contenteditable="false"`, carrying its id in
   * a data attribute. The browser then treats it as one indivisible character —
   * the caret steps over it, backspace removes the whole thing — and sending is
   * a walk over the child nodes. It is how Slack's own composer works, and it
   * is the only version of this that does not have a wrong answer in it.
   */
  type Props = {
    /** Where it is being sent, for the placeholder. `#deploys`, or a person's name. */
    channelLabel: string
    /** The draft as Slack would receive it, restored from the tab's view state. */
    draft: string
    disabled?: boolean
    /** Called as the user types, debounced by the caller. */
    onDraftChange: (text: string) => void
    /** Called with the message in Slack's own form. Rejects to leave the text in place. */
    onSend: (text: string) => Promise<void>
  }

  const { channelLabel, draft, disabled = false, onDraftChange, onSend }: Props = $props()

  /** A person, or one of the two mentions that reach everybody. */
  type Suggestion =
    { kind: 'user'; user: ThreadUser } | { kind: 'broadcast'; range: 'here' | 'channel' }

  /**
   * What the empty box says. "Reply in #deploys" reads well for a channel and
   * badly for a direct message, where the label is a person's name and the
   * sentence becomes "Reply in Dana Okafor".
   */
  const placeholder = $derived(channelLabel.startsWith('#') ? `Reply in ${channelLabel}` : 'Reply…')

  let editor = $state<HTMLDivElement | null>(null)
  let sending = $state(false)
  let error = $state<string | null>(null)
  /** Whether there is anything to send, which is what the button reads. */
  let empty = $state(true)

  /** The mention being typed, or null when the caret is not in one. */
  let query = $state<string | null>(null)
  let selected = $state(0)

  const suggestions = $derived.by<Suggestion[]>(() => {
    if (query === null) return []

    const needle = query.toLowerCase()
    // `@here` and `@channel` are offered alongside people because that is where
    // the hand reaches for them, and they are the two mentions most worth
    // being deliberate about — so they are listed, not hidden.
    const broadcasts: Suggestion[] = (['here', 'channel'] as const)
      .filter((range) => range.startsWith(needle))
      .map((range) => ({ kind: 'broadcast', range }))

    return [
      ...broadcasts,
      ...slackWorkspace.matchUsers(query, 8).map((user) => ({ kind: 'user' as const, user }))
    ]
  })

  // Any change to the list makes the old highlight meaningless.
  $effect(() => {
    void suggestions
    selected = 0
  })

  // ---------------------------------------------------------------------------
  // Reading and writing the editor's contents
  // ---------------------------------------------------------------------------

  /** Slack escapes exactly these three, and expects them escaped on the way in. */
  function escapeForSlack(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /**
   * The editor's contents as Slack would receive them: text escaped, mentions
   * as ids, line breaks as newlines.
   */
  function serialize(root: HTMLElement): string {
    let out = ''

    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += escapeForSlack(node.textContent ?? '')
        return
      }
      if (!(node instanceof HTMLElement)) return

      const userId = node.dataset.userId
      if (userId !== undefined) {
        out += `<@${userId}>`
        return
      }
      const broadcast = node.dataset.broadcast
      if (broadcast !== undefined) {
        out += `<!${broadcast}>`
        return
      }
      if (node.tagName === 'BR') {
        out += '\n'
        return
      }

      // A div or a paragraph is a line the browser made when Enter was pressed;
      // everything after the first starts on a new one.
      const isBlock = node.tagName === 'DIV' || node.tagName === 'P'
      if (isBlock && out !== '' && !out.endsWith('\n')) out += '\n'
      for (const child of node.childNodes) walk(child)
    }

    for (const child of root.childNodes) walk(child)
    // The browser leaves a trailing break behind an emptied line; it is not
    // part of what anybody typed.
    return out.replace(/\n+$/, '')
  }

  /** A mention, as the one element the browser is not allowed to take apart. */
  function mentionElement(
    label: string,
    data: { userId?: string; broadcast?: string }
  ): HTMLElement {
    const pill = document.createElement('span')
    pill.contentEditable = 'false'
    pill.textContent = `@${label}`
    pill.className = 'rounded bg-sky-400/20 px-1 py-px font-medium text-sky-200 whitespace-nowrap'
    if (data.userId !== undefined) pill.dataset.userId = data.userId
    if (data.broadcast !== undefined) pill.dataset.broadcast = data.broadcast
    return pill
  }

  /** `<@U024BE7LH>` and `<!here>`, for restoring a draft written earlier. */
  const STORED_MENTION = /<@([UWB][A-Z0-9]+)>|<!(here|channel|everyone)>/g

  /**
   * Fills the editor from a stored draft. Called once, when the pane opens: the
   * editor owns its contents from then on, and rewriting it from a prop while
   * somebody is typing would move their caret to the front.
   */
  function restore(root: HTMLElement, text: string): void {
    root.replaceChildren()
    if (text === '') return

    let cursor = 0
    const push = (raw: string): void => {
      if (raw === '') return
      // Undoing the escaping `serialize` applied.
      const plain = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      root.append(document.createTextNode(plain))
    }

    for (const match of text.matchAll(STORED_MENTION)) {
      push(text.slice(cursor, match.index))
      cursor = match.index + match[0].length

      const [, userId, broadcast] = match
      if (userId !== undefined) {
        const user = slackWorkspace.usersById[userId]
        root.append(mentionElement(user?.name ?? userId, { userId }))
      } else {
        root.append(mentionElement(broadcast, { broadcast }))
      }
    }
    push(text.slice(cursor))
  }

  // ---------------------------------------------------------------------------
  // The mention being typed
  // ---------------------------------------------------------------------------

  /**
   * An `@` that starts a word, and whatever has been typed since. Anchored to a
   * word boundary so that an email address does not open the picker.
   */
  const ACTIVE_MENTION = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u

  /** The text node the caret is in, and how far into it. */
  function caret(): { node: Text; offset: number } | null {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null
    const node = selection.focusNode
    if (!(node instanceof Text) || !editor?.contains(node)) return null
    return { node, offset: selection.focusOffset }
  }

  /** Reads what is being typed after an `@`, or clears the picker. */
  function refreshQuery(): void {
    const at = caret()
    if (!at) {
      query = null
      return
    }
    const match = ACTIVE_MENTION.exec(at.node.textContent?.slice(0, at.offset) ?? '')
    query = match ? match[1] : null
  }

  /** Replaces the `@…` under the caret with a pill and a trailing space. */
  function accept(suggestion: Suggestion): void {
    const at = caret()
    if (!at || !editor) return

    const before = at.node.textContent?.slice(0, at.offset) ?? ''
    const match = ACTIVE_MENTION.exec(before)
    if (!match) return

    // The `@` itself, plus everything typed after it. The optional leading
    // space the pattern allows is not part of what gets replaced.
    const start = at.offset - (match[1].length + 1)

    const range = document.createRange()
    range.setStart(at.node, start)
    range.setEnd(at.node, at.offset)
    range.deleteContents()

    const pill =
      suggestion.kind === 'user'
        ? mentionElement(suggestion.user.name, { userId: suggestion.user.id })
        : mentionElement(suggestion.range, { broadcast: suggestion.range })
    // The space is what lets the caret land somewhere ordinary afterwards; a
    // caret directly against a non-editable element is awkward in every browser.
    const space = document.createTextNode(' ')

    range.insertNode(space)
    range.insertNode(pill)

    const selection = window.getSelection()
    const after = document.createRange()
    after.setStart(space, 1)
    after.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(after)

    query = null
    onInput()
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function onInput(): void {
    if (!editor) return
    const text = serialize(editor)
    empty = text.trim() === ''
    error = null
    refreshQuery()
    onDraftChange(text)
  }

  async function send(): Promise<void> {
    if (!editor || sending) return
    const text = serialize(editor)
    if (text.trim() === '') return

    sending = true
    error = null
    try {
      await onSend(text)
      // Emptied only once Slack has taken it. A failed send that cleared the
      // box would lose what somebody wrote, which is the one unforgivable bug
      // a composer can have.
      //
      // The rule below guards against Svelte and the DOM disagreeing about
      // children Svelte rendered. There are none: this element's contents are
      // written by hand from the first keystroke to the last, which is the
      // whole design (see the note at the top).
      // eslint-disable-next-line svelte/no-dom-manipulating
      editor.replaceChildren()
      empty = true
      query = null
      onDraftChange('')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      sending = false
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (query !== null && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        selected = (selected + 1) % suggestions.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        selected = (selected - 1 + suggestions.length) % suggestions.length
        return
      }
      // Tab as well as Enter: the picker is a completion, and Tab is what
      // completes things everywhere else in this app.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        accept(suggestions[selected])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        query = null
        return
      }
    }

    // Enter sends, shift-Enter is a new line. The other way round is a setting
    // in Slack; it is not one here, and this is the order that matches it out
    // of the box.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  /**
   * Pasting drops everything but the text. Styled HTML from a browser or
   * another Slack message would otherwise land inside the editor as markup,
   * and `serialize` would carry none of it — so the user would see formatting
   * that silently did not send.
   */
  function onPaste(event: ClipboardEvent): void {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text === '') return
    document.execCommand('insertText', false, text)
  }

  // Filled once, from the stored draft.
  //
  // `draft` is read untracked, and that is load-bearing rather than tidy: what
  // this component reports through `onDraftChange` is written to the tab, and
  // the tab is where `draft` comes from. Tracking it would mean every keystroke
  // came back round and rebuilt the editor underneath the caret — which would
  // send it to the front of the box on every character typed.
  $effect(() => {
    const root = editor
    if (!root) return
    untrack(() => {
      restore(root, draft)
      empty = serialize(root).trim() === ''
    })
  })
</script>

<!-- A box rather than a bar across the foot of the pane. It sits directly under
     the last message (see SlackThreadPane), so a full-width rule above it would
     read as a divider in the middle of the conversation rather than as the
     edge of somewhere to type. -->
<div class="relative px-4 pt-4 pb-4">
  {#if query !== null && suggestions.length > 0}
    <!-- Above the box, pinned to its left edge rather than following the caret.
         The list is short and the composer is at the foot of the pane, so there
         is nowhere else for it to go and nothing to be gained by chasing the
         caret across one line of text. -->
    <ul
      class="absolute bottom-full left-4 z-30 mb-1 max-h-64 w-72 overflow-y-auto rounded-lg
             glass-scrim p-1 shadow-xl ring-1 ring-white/15"
      aria-label="People to mention"
    >
      {#each suggestions as suggestion, index (suggestion.kind === 'user' ? suggestion.user.id : suggestion.range)}
        <li>
          <button
            type="button"
            aria-selected={index === selected}
            onmouseenter={() => (selected = index)}
            onclick={() => accept(suggestion)}
            class="flex w-full items-center gap-2 rounded-md glass-control px-2 py-1.5 text-left"
          >
            {#if suggestion.kind === 'user'}
              <SlackAvatar src={suggestion.user.avatar} name={suggestion.user.name} size="size-5" />
              <span class="min-w-0 flex-1 truncate text-xs text-ink-100">
                {suggestion.user.name}
              </span>
              {#if suggestion.user.handle && suggestion.user.handle !== suggestion.user.name}
                <span class="shrink-0 truncate text-[11px] text-ink-500">
                  @{suggestion.user.handle}
                </span>
              {/if}
            {:else}
              <span
                class="icon-[ph--megaphone] grid size-5 shrink-0 place-items-center text-sm
                       text-amber-300"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1 truncate text-xs text-ink-100">@{suggestion.range}</span>
              <span class="shrink-0 text-[11px] text-ink-500">
                {suggestion.range === 'here' ? 'everyone online' : 'everyone in the channel'}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-end gap-2">
    <div class="relative min-w-0 flex-1">
      {#if empty}
        <!-- A contenteditable has no placeholder attribute, and the CSS trick
             for one fights with the pills. A plain overlay is simpler and does
             not need the editor to be empty of elements, only of text. -->
        <span
          class="pointer-events-none absolute top-2 left-3 text-sm text-ink-500"
          aria-hidden="true"
        >
          {placeholder}
        </span>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={editor}
        role="textbox"
        tabindex="0"
        aria-multiline="true"
        aria-label="Reply to the thread"
        contenteditable={!disabled && !sending}
        oninput={onInput}
        onkeydown={onKeydown}
        onpaste={onPaste}
        onblur={() => (query = null)}
        class="max-h-40 min-h-9 w-full overflow-y-auto rounded-lg bg-black/25 px-3 py-2 text-sm
               leading-relaxed text-ink-100 ring-1 ring-white/15 outline-none select-text
               focus:ring-white/30 {disabled ? 'opacity-50' : ''}"
      ></div>
    </div>

    <button
      type="button"
      disabled={disabled || sending || empty}
      onclick={() => void send()}
      aria-label="Send reply"
      class="grid size-9 shrink-0 place-items-center rounded-lg glass-control bg-white/10
             text-ink-100 disabled:pointer-events-none disabled:opacity-40"
    >
      {#if sending}
        <span class="icon-[ph--circle-notch] animate-spin text-base" aria-hidden="true"></span>
      {:else}
        <span class="icon-[ph--paper-plane-tilt] text-base" aria-hidden="true"></span>
      {/if}
    </button>
  </div>

  {#if error}
    <p class="mt-2 text-[11px] text-red-400">{error}</p>
  {/if}
</div>
