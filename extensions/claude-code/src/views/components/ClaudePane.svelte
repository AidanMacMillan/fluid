<script lang="ts">
  import { leaveSplit, watchTabSplit, type ViewHost } from '@fluid/sdk'
  import { untrack } from 'svelte'
  import type { ClaudeItem } from '../../main/events'
  import { attachmentUrl } from '../../shared/attachments'
  import { imageTypeFor, supportsFile } from '../../shared/files'
  import type {
    ClaudeFromView,
    ClaudeMethod,
    ClaudeMethods,
    ClaudeModel,
    ClaudeToView
  } from '../../shared/protocol'
  import {
    CLAUDE_DEFAULT_EFFORT,
    CLAUDE_DEFAULT_MODE,
    folderName,
    type ClaudeTab,
    type ClaudeTabPayload
  } from '../../shared/tab'
  import { filesFrom, hasLeft, isFileDrag } from '../lib/drop'
  import { ClaudeTranscript } from '../lib/transcript.svelte'
  import ClaudeAside from './ClaudeAside.svelte'
  import ClaudeChrome from './ClaudeChrome.svelte'
  import ClaudeFileTile from './ClaudeFileTile.svelte'
  import ClaudeMarkdown from './ClaudeMarkdown.svelte'
  import ClaudeMessageActions from './ClaudeMessageActions.svelte'
  import ClaudeMinimap from './ClaudeMinimap.svelte'
  import ClaudeToolGroup from './ClaudeToolGroup.svelte'
  import ClaudeApprovalCard from './ClaudeApprovalCard.svelte'
  import ClaudeQuestionCard from './ClaudeQuestionCard.svelte'

  /**
   * A Claude Code session, drawn, in a view of its own.
   *
   * The view can be let go of at any time — pushed out of the app's warm set,
   * or crashed — and the session behind it is not: the same arrangement a
   * terminal has, and for the same reason. Which means everything on screen has
   * to be rebuildable from what the session says it has said, and it is: see
   * the attach handshake below, and ../lib/transcript.svelte.ts for the fold.
   *
   * `tab` is kept current by the page (see ../index.svelte.ts), so a payload or
   * title the session writes arrives here as the tab changing.
   */
  type Props = { tab: ClaudeTab; host: ViewHost }
  const { tab, host }: Props = $props()

  /** Whether the tab is one pane of a split, which is when its bar offers the way out. */
  let inSplit = $state(false)
  $effect(() => watchTabSplit(host.api, tab, (split) => (inSplit = split)))

  /** One of the extension's own methods, typed by ../../shared/protocol.ts. */
  function call<M extends ClaudeMethod>(
    method: M,
    input: ClaudeMethods[M]['input']
  ): Promise<ClaudeMethods[M]['output']> {
    return host.call<ClaudeMethods[M]['output']>(method, input)
  }

  /** Says something went wrong, in the transcript where the user is looking. */
  function warn(cause: unknown): void {
    transcript.apply([{ type: 'notice', level: 'warning', message: host.reasonFrom(cause) }])
  }

  /** How near the foot counts as "following along", for whether to auto-scroll. */
  const STICK_TO_BOTTOM_PX = 120
  const DRAFT_WRITE_DELAY_MS = 400
  /** How much of the turn above a jump lands on, so it does not sit flush. */
  const JUMP_PEEK_PX = 16
  /** How much of a message the rail's tooltip quotes back. */
  const MARK_LABEL_MAX = 90

  const transcript = new ClaudeTranscript()

  let failure = $state<string | null>(null)
  let composer = $state<HTMLTextAreaElement | null>(null)
  // The draft the tab was opened with. From then on the composer is the draft,
  // and the view state it writes back is only what the next view starts from.
  let draft = $state(untrack(() => tab.viewState?.draft) ?? '')
  let models = $state<ClaudeModel[]>([])
  let picker = $state<HTMLInputElement | null>(null)
  /**
   * A file waiting to go with the next turn.
   *
   * `preview` is a `data:` URL for an image and null for everything else. An
   * object URL over the `File` would hold one copy of the bytes rather than
   * two, and was the first answer here — but the page's policy allows images
   * from `data:` and from the app's and this extension's own schemes only (see
   * the CSP in the app's src/renderer/extension-view.html), so a `blob:` URL
   * draws as a broken image. Between
   * widening what the window will load pictures from and holding a screenshot
   * twice for as long as its thumbnail is up, the second is the cheaper price.
   *
   * It stays on this side: a URL that only means anything to this page has no
   * business crossing to the main process, so `send` strips it.
   */
  type Attachment = { name: string; data: string; preview: string | null }
  /** Files dropped or pasted, waiting to go with the next turn. */
  // `$state.raw`, not `$state`: deep state hands back a Proxy, a Proxy cannot be
  // structured-cloned across the IPC boundary, and these go straight across it
  // when a turn is sent. The list is replaced wholesale on every change anyway,
  // so there is nothing for deep state to do.
  let attachments = $state.raw<Attachment[]>([])
  /** Whether a file dragged in from outside is currently over the pane. */
  let receiving = $state(false)
  /**
   * The attachment being looked at full size, if any.
   *
   * A thumbnail is big enough to answer "is that the right screenshot" and not
   * big enough to answer "is the thing I meant to show in it" — which is the
   * question somebody attaching a screenshot of a bug is actually asking.
   */
  let expanded = $state.raw<{ name: string; src: string } | null>(null)
  /** Whether the user is at the foot, and so wants to be kept there. */
  let following = true
  /** Where the last scroll left the transcript, to tell a scroll up from one down. */
  let lastScrollTop = 0
  /**
   * The transcript's own scroller. A box between the header and the composer
   * rather than the page, so that the conversation ends where the composer
   * begins and nothing is ever drawn underneath it.
   */
  let scroller = $state<HTMLElement | null>(null)
  /**
   * The clock behind the elapsed time in the footer.
   *
   * Only runs while a turn does. A timer ticking through an idle session would
   * wake the renderer once a second for a number that is not changing.
   */
  let now = $state(Date.now())
  $effect(() => {
    // A second while a turn runs, because the footer counts in seconds; a
    // minute otherwise, which is all "2 minutes ago" ever needs.
    const every = transcript.running ? 1000 : 60_000
    const tick = setInterval(() => (now = Date.now()), every)
    return () => clearInterval(tick)
  })

  /**
   * The controls as last chosen here, ahead of the payload catching up.
   *
   * The session writes a choice to the payload once it has taken it, which is
   * a round trip and a tab update away. The picker answers the click instead,
   * and goes back if the session says no — see `settle`.
   */
  let chosen = $state.raw<Partial<ClaudeTabPayload>>({})
  const controls = $derived({ ...tab.payload, ...chosen })

  const effort = $derived(controls.effort ?? CLAUDE_DEFAULT_EFFORT)
  // The mode a session with no recorded choice is started in. The picker has to
  // name the same one or it claims a mode the session is not running.
  const mode = $derived(controls.permissionMode ?? CLAUDE_DEFAULT_MODE)
  /** Whether the model's thinking is drawn. The session says, as the view attaches. */
  let thinking = $state(true)
  /**
   * Which row of the picker is the current one.
   *
   * The user's own choice if they have made one, because that is the alias they
   * picked and the one to show back to them. Otherwise the alias whose resolved
   * model matches what the session says it is running — without that step the
   * picker has no option matching its own value and draws itself blank.
   */
  const model = $derived.by(() => {
    if (controls.model) return controls.model
    const running = transcript.session?.model
    if (!running) return null
    return models.find((entry) => entry.resolved === running)?.id ?? running
  })

  /**
   * Attaching.
   *
   * Listen first, then ask: the session says nothing until the view has said
   * it is ready (see `ClaudeFromView`), and then says it all in order over the
   * one channel — the conversation so far, and everything after it. There is
   * no race to settle, because there is only the one queue.
   */
  $effect(() => {
    const stop = host.onMessage((raw) => {
      const message = raw as ClaudeToView
      switch (message.type) {
        case 'failure':
          failure = message.message
          return
        case 'snapshot':
          failure = null
          thinking = message.thinking
          transcript.apply(message.replay)
          if (message.exit) transcript.stopped = message.exit.error ?? 'The session ended.'
          // Authoritative, and it has to be: a replay that ends mid-turn looks
          // the same whether the turn is still going or the transcript simply
          // stops there, and only the session knows which. See
          // `ClaudeSnapshot.running`.
          transcript.running = message.running
          composer?.focus()
          void call('session.models', { tabId: tab.id }).then((list) => (models = list))
          return
        case 'events':
          transcript.apply(message.events)
          return
        case 'exit':
          transcript.stopped = message.error ?? 'The session ended.'
          return
        case 'thinking':
          thinking = message.show
          return
      }
    })
    host.post({ type: 'attach' } satisfies ClaudeFromView)
    return stop
  })

  function onScroll(): void {
    const element = scroller
    if (!element) return
    const below = element.scrollHeight - element.scrollTop - element.clientHeight
    // Only the scroll offset, deliberately: the rail's answer to "what is on
    // screen" is arithmetic over measurements taken when the column last
    // changed shape, so scrolling asks the DOM for one number rather than
    // re-measuring every turn in the conversation on every wheel tick.
    viewTop = element.scrollTop
    // Only a scroll upwards leaves the foot. The transcript also scrolls when
    // it is sent to the foot, and the event for that arrives a frame later — by
    // which time the answer being written may have grown again, and the foot
    // looks further away than the reader went.
    if (below < STICK_TO_BOTTOM_PX) following = true
    else if (element.scrollTop < lastScrollTop) following = false
    lastScrollTop = element.scrollTop
  }

  let draftWrite: ReturnType<typeof setTimeout> | undefined
  function onDraft(text: string): void {
    draft = text
    clearTimeout(draftWrite)
    draftWrite = setTimeout(
      () => host.setViewState(tab.id, text === '' ? null : { draft: text }),
      DRAFT_WRITE_DELAY_MS
    )
  }

  function send(): void {
    const text = draft.trim()
    if (text === '' && attachments.length === 0) return
    void call('session.send', {
      tabId: tab.id,
      text,
      attachments: attachments.map(({ name, data }) => ({ name, data }))
    }).catch(warn)
    attachments = []
    // Nothing to look at once it has gone with the turn.
    expanded = null
    onDraft('')
    // Sending is a reason to be at the foot whatever the scroll position was:
    // the user just added the last thing in it.
    following = true
  }

  /**
   * Whether there is a guess to offer: one exists, and the user has not started
   * saying something of their own. A suggestion under half-typed words would be
   * a suggestion about a question nobody asked.
   */
  const suggested = $derived(draft === '' ? transcript.suggestion : null)

  function onKeydown(event: KeyboardEvent): void {
    // Tab takes the guess, which is what Tab does everywhere something is being
    // completed. Only while it is showing, so Tab is still Tab otherwise.
    if (event.key === 'Tab' && suggested !== null) {
      event.preventDefault()
      onDraft(suggested)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    if (transcript.running) return
    send()
  }

  /**
   * Takes files in.
   *
   * Read here and sent as bytes: the view has a `File` and no business writing
   * to disk, and the main half has both — it puts them in a directory the
   * session is allowed to read and names them in the turn. As bytes rather than
   * as a path because a pasted screenshot has no path.
   *
   * One gate for all three ways a file arrives — the picker, a paste, a drop —
   * because "can Claude read this" is a property of the file rather than of how
   * it got here. What it cannot read is said rather than silently dropped: a
   * file that vanishes on release reads as a broken drop target.
   */
  async function take(files: ArrayLike<File> | null | undefined): Promise<void> {
    if (!files) return
    const refused: string[] = []
    for (const file of Array.from(files)) {
      if (!supportsFile(file.name)) {
        refused.push(file.name)
        continue
      }
      const buffer = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buffer)
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]!)
      }
      const data = btoa(binary)
      const type = imageTypeFor(file.name)
      attachments = [
        ...attachments,
        { name: file.name, data, preview: type ? `data:${type};base64,${data}` : null }
      ]
    }
    if (refused.length > 0) {
      transcript.apply([
        {
          type: 'notice',
          level: 'warning',
          message: `Claude Code cannot read ${refused.join(', ')} — it takes text, PDFs, notebooks and PNG, JPEG, GIF or WebP images.`
        }
      ])
    }
  }

  function onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files
    if (files && files.length > 0) {
      event.preventDefault()
      void take(files)
    }
  }

  /**
   * Dropping a file anywhere on the pane attaches it.
   *
   * The whole pane rather than the composer, because the pane is what the user
   * is aiming at — the transcript is most of it, and a target the size of one
   * text field is a target that gets missed.
   *
   * Whether the files are ones Claude can read is settled on the drop and not
   * before it. During the drag the platform exposes each item's MIME type and
   * withholds its name, and the MIME type is exactly the thing that cannot be
   * trusted here: Chromium calls a `.ts` file `video/mp2t`. So the drag is
   * accepted on the strength of it carrying files at all, and anything
   * unreadable is named afterwards. See `supportsFile`.
   */
  function onDragOver(event: DragEvent): void {
    // Nothing to attach to: a pane showing why the session could not start has
    // no composer to put a file in front of. Left unclaimed rather than refused,
    // so the drag falls through to whatever else would have taken it.
    if (failure || !isFileDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    receiving = true
  }

  function onDragLeave(event: DragEvent): void {
    if (hasLeft(event, event.currentTarget)) receiving = false
  }

  function onDrop(event: DragEvent): void {
    if (failure || !isFileDrag(event)) return
    event.preventDefault()
    receiving = false
    void take(filesFrom(event))
  }

  /**
   * Moves one of the chrome's controls, and puts it back if the session says no.
   *
   * The control moves first so the picker answers to the click rather than to
   * a round trip. That is a bet, and it is not always won: `auto` is not
   * offered on every setup. So the old choice is kept, and a refusal restores
   * it and says what happened rather than leaving the chrome claiming
   * something that is not true.
   */
  function settle(change: Partial<ClaudeTabPayload>, applying: () => Promise<void>): void {
    const before = chosen
    chosen = { ...chosen, ...change }
    void applying().catch((cause: unknown) => {
      chosen = before
      warn(cause)
    })
  }

  /**
   * Puts the files back to before a turn, and says what moved.
   *
   * Asked as a dry run first: the answer is what the button should have warned
   * about, and a revert that turns out to touch nothing is worth saying rather
   * than leaving the user wondering whether it worked.
   */
  async function revert(uuid: string): Promise<void> {
    const preview = await call('session.revert', { tabId: tab.id, uuid, dryRun: true })
    if (!preview.ok) {
      transcript.apply([
        {
          type: 'notice',
          level: 'warning',
          message: preview.error ?? 'These files cannot be put back.'
        }
      ])
      return
    }
    const done = await call('session.revert', { tabId: tab.id, uuid, dryRun: false })
    // Counted from the preview, not from the run: only the dry run reports
    // which files it would touch — the real one answers whether it happened
    // and nothing more.
    const count = preview.filesChanged?.length ?? 0
    transcript.apply([
      {
        type: 'notice',
        level: 'warning',
        message: !done.ok
          ? (done.error ?? 'These files could not be put back.')
          : count === 0
            ? 'Nothing to put back — no tracked file changed after that turn.'
            : `Put back ${count === 1 ? '1 file' : `${count} files`} (+${preview.insertions ?? 0} -${preview.deletions ?? 0}). The conversation is unchanged.`
      }
    ])
  }

  /**
   * Branches the conversation into a tab of its own, leaving this one alone.
   *
   * The new tab opens on everything up to but not including the turn forked
   * from, with that turn's words waiting in its composer — so the branch is
   * taken by editing the question rather than by remembering it. The session
   * opens it and takes the user there; see `forkClaude`.
   */
  async function fork(target: { uuid: string; text: string }): Promise<void> {
    const refusal = await call('session.fork', {
      tabId: tab.id,
      uuid: target.uuid,
      draft: target.text
    }).catch((cause: unknown) => host.reasonFrom(cause))
    if (refusal) transcript.apply([{ type: 'notice', level: 'warning', message: refusal }])
  }

  /** `2m 59s`, or `14s` under a minute — as long as the wait actually was. */
  function elapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  const tokens = (count: number): string =>
    count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`

  /**
   * The line under a turn: how long it took, and how much it wrote.
   *
   * Counts up while the turn runs and settles when it ends, so the same line
   * answers "is it still going" and "what did that cost me" without becoming
   * two different things in two places.
   */
  const footer = $derived.by(() => {
    if (transcript.running && transcript.startedAt !== null) {
      return { text: elapsed(now - transcript.startedAt), running: true }
    }
    const last = transcript.lastTurn
    if (!last) return null
    const parts = [elapsed(last.ms)]
    if (last.outputTokens) parts.push(tokens(last.outputTokens))
    return { text: parts.join(' · '), running: false }
  })

  const folder = $derived(folderName(tab.payload.cwd))
  /**
   * The transcript as rows, with runs of tool calls folded into one, and the
   * model's thinking left out when the reader has asked for it to be.
   *
   * Done here rather than in the fold, because both are questions about drawing
   * rather than about what happened: the transcript keeps every call and every
   * thought in the order it arrived, and this only decides how many lines that
   * takes. Which is also why hiding thinking costs nothing to undo — the words
   * are still in `entries`, so the toggle redraws the conversation it always
   * had rather than asking the session for one it has already finished.
   */
  const rows = $derived.by(() => {
    type Row =
      | {
          kind: 'entry'
          id: string
          entry: (typeof transcript.entries)[number]
          /** Where this sits in the transcript, for `anchorFor`. */
          at: number
        }
      | { kind: 'run'; id: string; items: ClaudeItem[] }
    const out: Row[] = []
    for (const entry of transcript.entries) {
      // Skipped before the run below sees it, so a stretch of thinking between
      // two tool calls does not keep them in separate groups once it is hidden.
      if (!thinking && entry.kind === 'text' && entry.thinking) continue
      const last = out.at(-1)
      if (entry.kind === 'item') {
        if (last?.kind === 'run') last.items = [...last.items, entry.item]
        else out.push({ kind: 'run', id: entry.id, items: [entry.item] })
        continue
      }
      out.push({ kind: 'entry', id: entry.id, entry, at: transcript.entries.indexOf(entry) })
    }
    return out
  })

  /**
   * The rail's ticks: one per thing that was actually said.
   *
   * Tool calls, notices and the summarised-earlier rule are all left out, which
   * is the point of it — the rail answers "what did we talk about" and the
   * transcript answers "what happened". Thinking is out too, said or not: it is
   * the model working rather than the model addressing anybody, and a session
   * with it showing would otherwise draw twice the ticks of the same session
   * with it hidden.
   *
   * Read off `rows` rather than off `entries` so the ids match the blocks the
   * markup keys by, which are the blocks `mark` registers.
   */
  const marks = $derived.by(() => {
    const out: { id: string; speaker: 'user' | 'claude'; label: string }[] = []
    for (const row of rows) {
      if (row.kind !== 'entry') continue
      const entry = row.entry
      if (entry.kind === 'user') {
        // A turn can be a screenshot and nothing else, and a tooltip has to say
        // something: the attachment is what that turn was.
        out.push({ id: row.id, speaker: 'user', label: label(entry.text) || 'Attached a file' })
      } else if (entry.kind === 'text' && !entry.thinking) {
        out.push({ id: row.id, speaker: 'claude', label: label(entry.text) })
      } else if (entry.kind === 'proposal') {
        out.push({ id: row.id, speaker: 'claude', label: label(entry.markdown) })
      }
    }
    return out
  })

  /** The opening words of a message on one line, for the rail's tooltip. */
  function label(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > MARK_LABEL_MAX ? `${line.slice(0, MARK_LABEL_MAX)}…` : line
  }

  /**
   * Where each mark's message sits in the scrolled column, and how much of that
   * column is on screen — between them, which ticks the rail lights.
   *
   * Measured when the column changes shape and not when it scrolls. Scrolling
   * is the frequent thing and it moves nothing: a turn's offset into the
   * conversation is the same number before and after a wheel tick, so reading
   * it again would be a layout flush per frame for an answer already known.
   */
  let column = $state<HTMLElement | null>(null)
  /**
   * The registered message elements, by the row id the rail names them with.
   *
   * A plain record for the reason the transcript gives about its own two: this
   * is bookkeeping, not something anything draws. What is drawn is `spans`,
   * which is worked out from these — so a reactive map here would invalidate
   * the rail every time a turn mounted, to say something it had not yet
   * measured.
   */
  const anchors: Record<string, HTMLElement> = {}
  let spans = $state.raw<Record<string, { top: number; bottom: number }>>({})
  let viewTop = $state(0)
  let viewHeight = $state(0)

  /**
   * Registers a message element with the rail.
   *
   * An action rather than `bind:this` into a record, because what the rail
   * needs is to know when one goes as well as when it arrives — a conversation
   * that is reverted or has its thinking hidden takes elements out of the
   * column, and a stale node left in the map is a tick that scrolls nowhere.
   * The blocks are keyed, so an id never moves to another element and there is
   * nothing for an `update` to do.
   */
  function mark(node: HTMLElement, id: string): { destroy: () => void } {
    anchors[id] = node
    remeasure()
    return {
      destroy() {
        if (anchors[id] === node) delete anchors[id]
        remeasure()
      }
    }
  }

  let measuring: number | undefined
  /** Batches the reads to one a frame: a turn arriving registers and resizes. */
  function remeasure(): void {
    if (measuring !== undefined) return
    measuring = requestAnimationFrame(() => {
      measuring = undefined
      measure()
    })
  }

  function measure(): void {
    const element = scroller
    if (!element) return
    // Against the scroller's own box rather than `offsetTop`, which is measured
    // from the nearest positioned ancestor — the pane, whose header would be
    // counted into every offset and put every tick a header's worth out.
    const origin = element.getBoundingClientRect().top - element.scrollTop
    const next: Record<string, { top: number; bottom: number }> = {}
    for (const [id, node] of Object.entries(anchors)) {
      const box = node.getBoundingClientRect()
      next[id] = { top: box.top - origin, bottom: box.bottom - origin }
    }
    spans = next
    viewTop = element.scrollTop
    viewHeight = element.clientHeight
  }

  /**
   * Answers the transcript changing shape: growing as turns arrive and as the
   * model writes, or its box resizing — the view resized, or the composer
   * growing a line as it is typed into.
   *
   * It is also what keeps the foot in view as the model writes — but only for
   * somebody who was already there. Scrolling a reader away from what they are
   * reading because another line arrived is the rudest thing a live view can
   * do. A block still being written grows without the transcript scrolling, so
   * nothing else would notice.
   */
  function reflow(): void {
    const element = scroller
    if (!element) return
    if (following) element.scrollTo({ top: element.scrollHeight })
    onScroll()
    remeasure()
  }

  $effect(() => {
    const content = column
    const view = scroller
    if (!content || !view) return undefined
    untrack(reflow)
    const observer = new ResizeObserver(reflow)
    observer.observe(content)
    observer.observe(view)
    return () => observer.disconnect()
  })

  /** Which messages are on screen. Overlap, not containment: a turn taller than
      the pane is what you are reading even though neither end of it is in view. */
  const visible = $derived.by(() => {
    const foot = viewTop + viewHeight
    // A plain Set, not a reactive one: it is built whole on every run and
    // handed over as a new value, so the derived is what anything tracks —
    // there is no mutation here for a reactive Set to report.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const on = new Set<string>()
    for (const item of marks) {
      const span = spans[item.id]
      if (span && span.top < foot && span.bottom > viewTop) on.add(item.id)
    }
    return on
  })

  function jump(id: string): void {
    const span = spans[id]
    if (!span) return
    // Settled here rather than left to the scroll handler: a smooth scroll
    // takes a few hundred milliseconds to report anything, and a turn landing
    // in that window would haul the view back to the foot the user just left.
    // Landing at the foot turns it back on, through `onScroll` as usual.
    following = false
    scroller?.scrollTo({ top: Math.max(0, span.top - JUMP_PEEK_PX), behavior: 'smooth' })
  }

  /** What the tab is called: the conversation's name, or the folder until it has one. */
  const name = $derived(transcript.title ?? tab.title ?? folder)

  let renaming = $state(false)
  let nameDraft = $state('')

  function startRenaming(): void {
    if (!transcript.session) return
    nameDraft = name
    renaming = true
  }

  function commitName(): void {
    if (!renaming) return
    renaming = false
    if (nameDraft.trim() === '' || nameDraft === name) return
    // Through the session rather than straight onto the tab: the name belongs
    // to the conversation, and it comes back as an event like any other.
    void call('session.rename', { tabId: tab.id, title: nameDraft }).catch(warn)
  }

  function onNameKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    // Enter commits through the blur handler, so there is one commit path
    // rather than two that can disagree — as TaskTab does.
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') renaming = false
  }

  /** Focus and select the whole name the moment the field appears. */
  function autoselect(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

<!-- The drop target is the pane, not a strip of it: the whole view, header and
     composer and all. What says the release will land is drawn over it
     further down. -->
<div
  class="flex h-screen flex-col"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="presentation"
>
  <!-- What the tab is, in the row a browser tab puts its address in and a
       terminal its folder. Only the folder: the session's settings used to live
       up here too and have moved down beside the composer they belong to. -->
  <header class="flex h-9 shrink-0 items-center gap-2 px-3 pane-bar-edge">
    {#if renaming}
      <input
        use:autoselect
        bind:value={nameDraft}
        onblur={commitName}
        onkeydown={onNameKeydown}
        aria-label="Conversation name"
        class="min-w-0 flex-1 rounded bg-black/25 px-1.5 py-0.5 text-xs text-ink-100
               ring-1 ring-white/20 outline-none select-text"
      />
    {:else}
      <!-- Click to rename, the way a task's tab is renamed. Disabled until the
           session exists, because there is nothing to rename before that. -->
      <button
        type="button"
        onclick={startRenaming}
        disabled={!transcript.session}
        title={transcript.session ? `${name} — click to rename` : tab.payload.cwd}
        class="min-w-0 truncate rounded glass-control px-1.5 py-0.5 text-xs text-ink-400
               hover:text-ink-100 disabled:pointer-events-none"
      >
        {name}
      </button>
      <!-- The folder as a pill rather than as more grey text beside the name:
           the two are different kinds of thing — one is what this conversation
           is about, the other is where it is happening — and a shape says that
           faster than a colour does. -->
      <span
        class="shrink-0 truncate rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-ink-400
               ring-1 ring-white/10"
        title={tab.payload.cwd}
      >
        {folder}
      </span>
    {/if}
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
    <div class="flex min-h-0 flex-1 items-center justify-center p-8">
      <p class="max-w-md text-center text-xs leading-relaxed text-ink-400">{failure}</p>
    </div>
  {:else}
    <!-- The rail is beside the scroller rather than in it: what it draws is
         where you are in the conversation, and a map that scrolls away with the
         thing it maps is not one. It keeps its width whether or not there is
         anything to draw yet, so the column does not shift sideways the first
         time somebody says something. -->
    <div class="flex min-h-0 flex-1">
      <ClaudeMinimap {marks} {visible} onJump={jump} />
      <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
        <!-- A transcript is a document rather than chrome, so the body's
           `user-select: none` is lifted here the way a Slack thread lifts it
           (see SlackMessage): an answer you cannot quote out of, a path you
           cannot copy, or a command you cannot paste into a terminal is half of
           what it should be. The cards' own buttons opt back out, so dragging
           down a run of turns picks up what was said and not the word "Allow". -->
        <div
          bind:this={column}
          class="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-2.5 px-4 py-3 select-text"
        >
          {#if transcript.entries.length === 0}
            <p class="mt-8 text-center text-xs text-ink-500">
              Claude Code, in {tab.payload.cwd}
            </p>
          {/if}

          {#each rows as row (row.id)}
            {#if row.kind === 'run'}
              <ClaudeToolGroup items={row.items} />
            {:else}
              {@const entry = row.entry}
              {#if entry.kind === 'user'}
                <!-- The margin is on the user's turn rather than on the column's
                 gap, because the two gaps are different questions. Between one
                 thing Claude did and the next — a sentence, then the tool it
                 ran — tight is right: they are one train of thought. Between
                 somebody asking and somebody answering, the change of speaker
                 is the thing to show, and a turn carries that space on both
                 sides without the rest of the transcript loosening. -->
                <!-- `group/turn` wraps the bubble and its row together, so moving
                   the pointer onto the buttons does not count as leaving the
                   turn and take them away again. -->
                <!-- The cap belongs on this wrapper, not on the bubble inside it.
                   `self-end` makes the wrapper shrink to fit its contents, so a
                   percentage set on the bubble would resolve against the
                   bubble's own width — capping it at 85% of whatever it wanted
                   to be, and wrapping every turn regardless of the room going
                   spare. Here it resolves against the column. -->
                <div
                  use:mark={row.id}
                  class="group/turn my-5 flex max-w-[85%] flex-col items-end self-end"
                >
                  {#if entry.attachments}
                    <!-- Above the bubble and drawn as the composer drew them: the
                       turn was sent with pictures attached, and a transcript
                       that showed the paths instead would be showing the
                       plumbing. The paths are still in what the model was
                       told — see the `user` event. -->
                    <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {#each entry.attachments as file (file.key)}
                        {@const src = imageTypeFor(file.name) ? attachmentUrl(file.key) : null}
                        <ClaudeFileTile
                          name={file.name}
                          {src}
                          onOpen={src ? () => (expanded = { name: file.name, src }) : undefined}
                        />
                      {/each}
                    </div>
                  {/if}
                  {#if entry.text !== ''}
                    <div
                      class="rounded-lg bg-white/10 px-3 py-1.5 text-[13px] whitespace-pre-wrap
                           text-ink-100"
                    >
                      {entry.text}
                    </div>
                  {/if}
                  <ClaudeMessageActions
                    at={entry.at}
                    {now}
                    text={entry.text}
                    anchor={transcript.anchorFor(row.at)}
                    running={transcript.running}
                    canRevert={true}
                    align="right"
                    onRevert={(uuid) => void revert(uuid).catch(warn)}
                    onFork={(target) => void fork(target)}
                  />
                </div>
              {:else if entry.kind === 'text'}
                <div use:mark={row.id} class="group/turn">
                  <ClaudeMarkdown source={entry.text} id={entry.id} muted={entry.thinking} />
                  <!-- Only once the block is finished: a row under text still
                     being written would move down the screen on every delta. -->
                  {#if entry.done}
                    <ClaudeMessageActions
                      at={entry.at}
                      {now}
                      text={entry.text}
                      anchor={transcript.anchorFor(row.at)}
                      running={transcript.running}
                      canRevert={false}
                      align="left"
                      onRevert={(uuid) => void revert(uuid).catch(warn)}
                      onFork={(target) => void fork(target)}
                    />
                  {/if}
                </div>
              {:else if entry.kind === 'proposal'}
                <div
                  use:mark={row.id}
                  class="rounded-md bg-black/20 px-3 py-2.5 ring-1 ring-white/10"
                >
                  <p class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-300">
                    <span class="icon-[ph--map-trifold] text-sm" aria-hidden="true"></span>
                    Proposed plan
                  </p>
                  <!-- A plan is written as markdown and is the one thing here most
                   worth reading as it was written. -->
                  <ClaudeMarkdown source={entry.markdown} id={entry.id} />
                  <p class="mt-2 text-[10px] text-ink-500">
                    Reply to accept it, or say what to change.
                  </p>
                </div>
              {:else if entry.kind === 'aside'}
                <ClaudeAside aside={entry.aside} id={entry.id} />
              {:else if entry.kind === 'compacted'}
                <div class="flex items-center gap-2 py-1 text-[10px] text-ink-600">
                  <span class="h-px flex-1 bg-white/10"></span>
                  <span>Earlier conversation summarised</span>
                  <span class="h-px flex-1 bg-white/10"></span>
                </div>
              {:else if entry.kind === 'notice'}
                <p
                  class="text-[11px] {entry.level === 'error' ? 'text-red-400' : 'text-amber-300'}"
                >
                  {entry.message}
                </p>
              {/if}
            {/if}
          {/each}

          {#if footer}
            <!-- Quiet, and at the foot of the turn rather than attached to any
               one thing in it: what it measures is the whole of the wait. -->
            <div class="flex items-center gap-1.5 text-[11px] text-ink-600">
              <span
                class="icon-[ph--asterisk] text-xs {footer.running ? 'animate-pulse' : ''}"
                aria-hidden="true"
              ></span>
              <span>{footer.text}</span>
              {#if footer.running}
                <span>· working…</span>
              {/if}
            </div>
          {/if}

          {#if transcript.approval}
            <ClaudeApprovalCard
              approval={transcript.approval}
              onDecide={(decision) => {
                if (!transcript.approval) return
                const { requestId } = transcript.approval
                void call('session.respond', { tabId: tab.id, requestId, decision }).catch(warn)
              }}
            />
          {/if}

          {#if transcript.question}
            <ClaudeQuestionCard
              questions={transcript.question.questions}
              onAnswer={(answers) => {
                if (!transcript.question) return
                const { requestId } = transcript.question
                void call('session.answer', { tabId: tab.id, requestId, answers }).catch(warn)
              }}
            />
          {/if}

          {#if transcript.stopped}
            <p class="text-[11px] text-red-400">{transcript.stopped}</p>
          {/if}
        </div>
      </div>
    </div>

    <!-- The plan and the composer, below the transcript rather than over it. -->
    <div class="shrink-0">
      {#if transcript.plan.length > 0}
        <div class="border-t border-white/5 px-4 py-1.5">
          <div class="mx-auto flex w-full max-w-3xl flex-wrap gap-x-3 gap-y-1">
            {#each transcript.plan as step (step.step)}
              <span
                class="flex items-center gap-1 text-[10px] {step.status === 'completed'
                  ? 'text-ink-600 line-through'
                  : step.status === 'inProgress'
                    ? 'text-ink-200'
                    : 'text-ink-500'}"
              >
                {#if step.status === 'completed'}
                  <span class="icon-[ph--check] text-xs" aria-hidden="true"></span>
                {:else if step.status === 'inProgress'}
                  <span class="icon-[ph--circle-notch] animate-spin text-xs" aria-hidden="true"
                  ></span>
                {:else}
                  <span class="icon-[ph--circle] text-xs" aria-hidden="true"></span>
                {/if}
                {step.step}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <div class="px-4 pt-1 pb-3">
        <div class="mx-auto w-full max-w-3xl">
          <div
            class="rounded-lg bg-black/25 px-2 py-1.5 ring-1 ring-white/15
                 focus-within:ring-white/30"
          >
            <!-- Inside the box rather than above it, because an attachment is
               part of the message being written and not a thing sitting beside
               it — the same call Claude Code's desktop app makes. An image
               shows itself: a thumbnail answers "is that the right screenshot"
               where a file name only answers "is that the right name". -->
            {#if attachments.length > 0}
              <div class="mb-1.5 flex flex-wrap gap-1.5">
                {#each attachments as file, index (file.name + index)}
                  <ClaudeFileTile
                    name={file.name}
                    src={file.preview}
                    onOpen={file.preview
                      ? () => (expanded = { name: file.name, src: file.preview! })
                      : undefined}
                    onRemove={() => {
                      if (expanded?.src === file.preview) expanded = null
                      attachments = attachments.filter((_, at) => at !== index)
                    }}
                  />
                {/each}
              </div>
            {/if}

            <div class="flex items-end gap-1.5">
              <textarea
                bind:this={composer}
                value={draft}
                oninput={(event) => onDraft(event.currentTarget.value)}
                onkeydown={onKeydown}
                onpaste={onPaste}
                rows="1"
                placeholder={suggested ??
                  (transcript.running ? 'Claude is working…' : 'Ask Claude Code')}
                class="field-sizing-content max-h-40 min-h-6 flex-1 resize-none bg-transparent
                     py-0.5 text-xs leading-relaxed text-ink-100 placeholder:text-ink-600
                     focus:outline-none"
              ></textarea>
              {#if transcript.running}
                <button
                  type="button"
                  aria-label="Stop"
                  onclick={() => void call('session.interrupt', { tabId: tab.id }).catch(warn)}
                  class="grid size-6 shrink-0 place-items-center rounded-md glass-control
                       text-ink-300 hover:text-ink-100"
                >
                  <span class="icon-[ph--stop-fill] text-sm" aria-hidden="true"></span>
                </button>
              {:else}
                <button
                  type="button"
                  aria-label="Send"
                  disabled={draft.trim() === '' && attachments.length === 0}
                  onclick={send}
                  class="grid size-6 shrink-0 place-items-center rounded-md glass-control
                       text-ink-300 hover:text-ink-100 disabled:pointer-events-none
                       disabled:text-ink-600"
                >
                  <span class="icon-[ph--arrow-up] text-sm" aria-hidden="true"></span>
                </button>
              {/if}
            </div>
          </div>

          <ClaudeChrome
            {model}
            {models}
            {effort}
            {mode}
            usage={transcript.usage}
            subscription={transcript.subscription}
            credits={transcript.credits}
            context={transcript.context}
            costUsd={transcript.costUsd}
            apiKeySource={transcript.session?.apiKeySource ?? null}
            running={transcript.running}
            {thinking}
            onAttach={() => picker?.click()}
            onModel={(next) =>
              settle({ model: next }, () =>
                call('session.setModel', { tabId: tab.id, model: next })
              )}
            onEffort={(next) =>
              settle({ effort: next }, () =>
                call('session.setEffort', { tabId: tab.id, effort: next })
              )}
            onMode={(next) =>
              settle({ permissionMode: next }, () =>
                call('session.setMode', { tabId: tab.id, mode: next })
              )}
            onThinking={() => {
              thinking = !thinking
              void call('thinking.set', { show: thinking }).catch(warn)
            }}
          />

          <!-- The `+` in the strip above opens this. A file input is the only way
             to reach the system picker, and it is the only reason this exists —
             hence hidden rather than styled. -->
          <input
            bind:this={picker}
            type="file"
            multiple
            hidden
            onchange={(event) => {
              void take(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
        </div>
      </div>
    </div>
  {/if}

  <!-- The ring and the wash, and what the release will do, over the view.
       `drop-zone` is the sidebar's own class doing the same job, drawn on the
       part of the page that is on screen. Always there, so the ring fades in
       and out as the sidebar's does; `pointer-events-none` so it is a caption
       rather than a surface: one that took the drop would take it from the page
       and fire `dragleave` the moment it appeared. -->
  <div
    class="pointer-events-none fixed inset-0 z-20 grid place-items-center drop-zone"
    class:receiving
  >
    {#if receiving}
      <span
        class="flex items-center gap-1.5 rounded-md bg-black/70 px-2.5 py-1.5 text-xs
               text-ink-200 ring-1 ring-white/15"
      >
        <span class="icon-[ph--paperclip] text-sm" aria-hidden="true"></span>
        Drop to attach
      </span>
    {/if}
  </div>

  {#if expanded}
    <!-- Over the whole view rather than the column: the point is to see the
         picture, and a picture shown at the width of a chat column is the
         problem this is solving rather than the answer to it. -->
    <div
      role="dialog"
      aria-modal="true"
      aria-label={expanded.name}
      class="fixed inset-0 z-50 grid place-items-center bg-black/80 p-8"
    >
      <!-- The backdrop is the dismiss control, which is what clicking outside a
           lightbox has always meant. A button rather than a handler on the
           panel, so it is reachable by keyboard and announced as what it is. -->
      <button
        type="button"
        aria-label="Close"
        onclick={() => (expanded = null)}
        class="absolute inset-0 cursor-default"
      ></button>
      <img
        src={expanded.src}
        alt={expanded.name}
        class="pointer-events-none relative max-h-full max-w-full rounded-md object-contain
               shadow-2xl"
      />
    </div>
  {/if}
</div>

<!-- Escape closes it, wherever focus has got to. -->
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && expanded) expanded = null
  }}
/>
