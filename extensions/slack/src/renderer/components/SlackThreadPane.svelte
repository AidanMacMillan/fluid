<script lang="ts">
  import { isWebAddress, type ViewHost } from '@fluid/sdk'
  import type { ThreadView } from '../../main/slack-thread'
  import {
    isSlackThreadViewMessage,
    type SlackThreadTab,
    type SlackThreadTabPayload
  } from '../../shared/tab-types'
  import { reasonFrom, setHost, slackApi } from '../host'
  import { excerptOf } from '../lib/excerpt'
  import { slackWorkspace } from '../lib/slack.svelte'
  import SlackComposer from './SlackComposer.svelte'
  import SlackMessage from './SlackMessage.svelte'

  /**
   * A Slack thread, as a tab.
   *
   * The pane owns the conversation's freshness and nothing else: the main
   * process hands it a thread already assembled (see src/main/slack-thread.ts),
   * and everything below is about when to ask again and what to do while
   * waiting.
   *
   * It polls rather than subscribing. Slack's real-time story is Socket Mode,
   * which is an always-on websocket scoped to an app rather than to a person —
   * it cannot see what this token sees, and it would be a second connection to
   * keep alive for a pane that is usually not even on screen. A thread is a
   * handful of messages and `conversations.replies` is cheap; asking every few
   * seconds while the tab is in front and not at all otherwise costs less than
   * the machinery would.
   */
  type Props = { tab: SlackThreadTab; host: ViewHost }

  const { tab, host }: Props = $props()

  // svelte-ignore state_referenced_locally
  setHost(host)

  const api = slackApi

  /**
   * How often the thread is re-read while the tab is in front and the window
   * has focus. Slack rate-limits `conversations.replies` generously enough that
   * this is nowhere near it, and a reply landing within a few seconds is as
   * live as a conversation needs to feel.
   */
  const POLL_INTERVAL_MS = 8_000

  /**
   * How long a draft settles before it is written to the tab. The same reason
   * the file pane debounces its view state: a keystroke is not a decision, and
   * there are a hundred of them in a sentence.
   */
  const DRAFT_WRITE_DELAY_MS = 400

  /**
   * How often the "13 minutes ago" stamps are recomputed. Half a minute is
   * finer than the smallest thing they say, so nothing is ever visibly stale.
   */
  const CLOCK_TICK_MS = 30_000

  /** Messages closer together than this, from one person, are drawn as one block. */
  const GROUPING_WINDOW_MS = 5 * 60 * 1000

  /** How near the foot counts as "following along", for whether to auto-scroll. */
  const STICK_TO_BOTTOM_PX = 120

  let thread = $state<ThreadView | null>(null)
  let error = $state<string | null>(null)
  /** Only true for the very first read; a refresh that fails keeps the thread on screen. */
  let loading = $state(true)
  let connected = $state(true)

  /**
   * Now, ticking. One clock for the whole thread rather than one per message:
   * every stamp then moves at the same moment, and the ticking stops with the
   * pane instead of leaving an interval per row behind.
   */
  let now = $state(Date.now())

  /**
   * The pane, which is the whole of its page: it is drawn in a view of its own
   * (see ../../views), and the page itself is what scrolls rather than a box
   * inside it.
   */
  let root = $state<HTMLElement | null>(null)
  /** Whether the user is at the foot of the thread, and so wants to be kept there. */
  let following = true
  /** Set once the pane has scrolled to the message the tab was opened on. */
  let jumped = false

  const payload = $derived(tab.payload)
  /**
   * The thread's identity, pulled out as two plain strings.
   *
   * Not read off `payload` where it is depended on, because the payload is
   * rewritten as soon as the first read lands — the pane names the tab from
   * what it fetched. A dependency on the whole payload would therefore re-run
   * the poll below every time the thread was refreshed, throwing away the
   * interval and fetching again. A derived string only notifies when the string
   * actually changes, which is never.
   */
  const channelId = $derived(payload.channelId)
  const threadTs = $derived(payload.threadTs)
  /** What the composer calls the conversation before the first read lands, so it is never blank. */
  const label = $derived(thread?.channelLabel ?? payload.channelLabel ?? 'Slack thread')
  const readOnly = $derived(!connected || thread === null)

  /**
   * Which messages lose their avatar and name. Worked out here rather than in
   * the row, because it is a fact about a message's neighbour and the row only
   * knows itself.
   */
  const rows = $derived.by(() => {
    const messages = thread?.messages ?? []
    return messages.map((message, index) => {
      const previous = messages[index - 1]
      const sameAuthor =
        previous !== undefined &&
        previous.author.id === message.author.id &&
        previous.author.name === message.author.name
      const soonAfter =
        previous !== undefined &&
        Number(message.ts) * 1000 - Number(previous.ts) * 1000 < GROUPING_WINDOW_MS

      return {
        message,
        // The opening message is never compact: it is the thing the thread is
        // about, and it always gets a name and a face. Nor is the first reply,
        // which sits across the divider from it and would otherwise read as a
        // stray line under it.
        compact: index > 1 && sameAuthor && soonAfter && message.subtype === undefined,
        // The divider goes under the parent, where Slack puts it.
        repliesAfter: index === 0 ? messages.length - 1 : 0
      }
    })
  })

  async function read(initial = false): Promise<void> {
    if (initial) loading = true

    try {
      connected = await api.connected()
      if (!connected) {
        thread = null
        error = null
        return
      }

      const next = await api.thread(channelId, threadTs)
      thread = next
      error = null

      // Written back to the tab so the sidebar row, and the next launch, have
      // something to say before any of this has happened again.
      recordSummary(next)

      // A courtesy to the real Slack client: a thread read here should not keep
      // its unread badge there. Best effort, and deliberately not awaited.
      const last = next.messages.at(-1)
      if (last) void api.markRead(channelId, last.ts)
    } catch (cause) {
      // A refresh that fails leaves the thread it already has on screen, with
      // the failure said quietly above it — losing a conversation because
      // one poll timed out would be much worse than showing a stale one.
      error = reasonFrom(cause)
    } finally {
      loading = false
    }
  }

  // The directory and the emoji, shared by every thread tab and fetched once.
  $effect(() => {
    void slackWorkspace.load()
  })

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  })

  // The first read, and every one after it. Polling stops while the app is in
  // the background: nobody is reading a thread they cannot see, and an app left
  // open overnight should not spend the night talking to Slack. The app's focus
  // rather than this page's: the pane is a view of its own, which loses focus
  // to the sidebar while the thread is still in front of the user.
  $effect(() => {
    // Named so the effect re-runs if the tab is ever pointed somewhere else,
    // and only then — see the note on these two.
    void channelId
    void threadTs

    void read(true)

    let timer: ReturnType<typeof setInterval> | undefined

    const start = (): void => {
      if (timer !== undefined) return
      timer = setInterval(() => void read(), POLL_INTERVAL_MS)
    }
    const stop = (): void => {
      clearInterval(timer)
      timer = undefined
    }

    if (host.appFocused()) start()
    const unwatch = host.onAppFocusChange((focused) => (focused ? start() : stop()))

    return () => {
      stop()
      unwatch()
    }
  })

  // Refresh, from the tab's menu in the sidebar (see ../../index.ts), which is
  // where the pane's own bar used to offer it.
  $effect(() =>
    host.onMessage((message) => {
      if (isSlackThreadViewMessage(message)) void read()
    })
  )

  /**
   * Keeps the foot of the thread in view as replies arrive — but only for
   * somebody who was already there. Scrolling a reader away from the message
   * they were reading because a new one landed is the rudest thing a live view
   * can do.
   */
  $effect(() => {
    void thread
    const element = root
    if (!element || !thread) return

    // Once, and only when the tab was opened on a particular reply rather than
    // on the thread as a whole.
    if (!jumped && payload.focusTs !== undefined && payload.focusTs !== payload.threadTs) {
      jumped = true
      requestAnimationFrame(() => {
        element
          .querySelector(`[data-ts="${CSS.escape(payload.focusTs as string)}"]`)
          ?.scrollIntoView({ block: 'center' })
      })
      return
    }

    if (following) {
      requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }))
    }
  })

  $effect(() => {
    const onScroll = (): void => {
      const page = document.documentElement
      following = page.scrollHeight - window.scrollY - window.innerHeight < STICK_TO_BOTTOM_PX
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  })

  /**
   * Adds or removes one of the user's reactions, on screen first and in Slack
   * second — see the note in SlackReactions. The re-read is what makes the
   * optimistic guess safe: whatever it got wrong is corrected a moment later.
   */
  async function toggleReaction(messageTs: string, name: string, on: boolean): Promise<void> {
    const current = thread
    if (!current) return

    thread = {
      ...current,
      messages: current.messages.map((message) => {
        if (message.ts !== messageTs) return message

        const existing = message.reactions.find((reaction) => reaction.name === name)
        if (!existing) {
          return on
            ? {
                ...message,
                reactions: [...message.reactions, { name, count: 1, users: [current.me] }]
              }
            : message
        }

        const users = on
          ? [...existing.users, current.me]
          : existing.users.filter((id) => id !== current.me)

        return {
          ...message,
          reactions: message.reactions
            // A pill nobody is in any more should go, not sit at zero.
            .map((reaction) =>
              reaction.name === name ? { ...reaction, users, count: users.length } : reaction
            )
            .filter((reaction) => reaction.count > 0)
        }
      })
    }

    try {
      await api.react(channelId, messageTs, name, on)
    } catch (cause) {
      error = reasonFrom(cause)
    }
    await read()
  }

  async function sendReply(text: string): Promise<void> {
    await api.reply(channelId, threadTs, text)
    // Sending is a reason to be at the foot of the thread whatever the scroll
    // position was: the user just added the last message.
    following = true
    await read()
  }

  /** Drafts are written to the tab the way every other bit of view state is. */
  let draftWrite: ReturnType<typeof setTimeout> | undefined
  function onDraftChange(text: string): void {
    clearTimeout(draftWrite)
    draftWrite = setTimeout(
      () => host.setViewState(tab.id, text === '' ? null : { draft: text }),
      DRAFT_WRITE_DELAY_MS
    )
  }

  /**
   * Opens a link out of the thread, in the task's own tab for it when it has
   * one and a tab of its own when it does not — see `openLink`.
   *
   * Checked here as well as where the link is drawn, and again in the main
   * process before anything is loaded. Three times is not paranoia about any
   * one of them being wrong — it is that this is the path by which text written
   * by somebody outside the company becomes an address this app fetches, and
   * each layer is cheap.
   */
  function openUrl(url: string): void {
    if (!isWebAddress(url)) return
    host.openLink(url)
  }

  /**
   * Records what the thread turned out to be. The same job a browser tab's page
   * title does: the row is drawn from the payload, and the payload is what a tab
   * restored on the next launch has to go on before it has spoken to Slack.
   */
  function recordSummary(view: ThreadView): void {
    const first = view.messages[0]
    const next: SlackThreadTabPayload = {
      ...tab.payload,
      channelLabel: view.channelLabel,
      authorName: first?.author.name ?? tab.payload.authorName,
      excerpt: excerptOf(first?.text ?? '') || tab.payload.excerpt
    }
    if (
      next.channelLabel === tab.payload.channelLabel &&
      next.authorName === tab.payload.authorName &&
      next.excerpt === tab.payload.excerpt
    ) {
      return
    }
    void host.api.tabs.update({ id: tab.id, payload: next })
  }
</script>

<div bind:this={root} class="flex min-h-screen flex-col">
  <!-- No bar: the sidebar row already names the thread, and Refresh and Open in
       Slack are on its right-click menu. What is left up here is only ever a
       warning, and only while there is one. -->
  {#if thread?.trouble}
    <!-- The one failure this pane cannot show by failing: a token short of a
         scope draws a thread that looks finished and is quietly wrong — every
         name an id, every face a grey letter. Slack names the token's
         permissions on every reply, so this says exactly which line to add
         rather than leaving it to be guessed at. -->
    <div
      class="flex shrink-0 items-start gap-2 border-b border-amber-300/20 bg-amber-300/8 px-4 py-2"
    >
      <span class="mt-px icon-[ph--warning] shrink-0 text-sm text-amber-300" aria-hidden="true"
      ></span>
      <p class="text-[11px] leading-relaxed text-amber-200/90">{thread.trouble}</p>
      <button
        type="button"
        onclick={() => host.openSettings()}
        class="ml-auto shrink-0 rounded-md glass-control px-2 py-1 text-[11px] text-amber-200/80
               hover:text-amber-100"
      >
        Settings
      </button>
    </div>
  {/if}

  {#if thread && (!thread.complete || error)}
    <div class="flex shrink-0 items-center gap-3 px-4 pt-2 text-[0.6875rem] text-amber-300">
      {#if !thread.complete}
        <span title="This thread was too long to read in full; the oldest replies are missing.">
          Partial thread
        </span>
      {/if}
      {#if error}
        <!-- A failed refresh over a thread that is still on screen. Said, not
             shouted: the conversation below is real, just a few seconds old. -->
        <span class="truncate" title={error}>Not refreshing</span>
      {/if}
    </div>
  {/if}

  {#if loading}
    <div class="flex flex-1 items-center justify-center gap-2 text-xs text-ink-500">
      <span class="icon-[ph--circle-notch] animate-spin text-base" aria-hidden="true"></span>
      Reading the thread…
    </div>
  {:else if !connected}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span class="icon-[ph--plugs] text-3xl text-ink-500" aria-hidden="true"></span>
      <p class="text-xs text-ink-400">
        Slack is not connected. Connect it in settings to read this thread.
      </p>
      <button
        type="button"
        onclick={() => host.openSettings()}
        class="rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300
               hover:text-ink-50"
      >
        Open settings
      </button>
    </div>
  {:else if !thread}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span class="icon-[ph--warning-circle] text-3xl text-ink-500" aria-hidden="true"></span>
      <p class="max-w-md text-xs leading-relaxed text-ink-400">{error ?? 'Slack said no.'}</p>
      <button
        type="button"
        onclick={() => void read(true)}
        class="rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300
               hover:text-ink-50"
      >
        Try again
      </button>
    </div>
  {:else}
    <!-- The composer scrolls with the thread, after the messages, rather than
         being docked to the foot of the pane. That is what Slack does in a
         thread, and the difference is only visible on a short one — where a
         docked box sits marooned at the bottom of the window with a field of
         empty glass between it and the conversation it belongs to. Here it
         follows the last reply up. A long thread pushes it back down, and the
         auto-scroll above keeps it in view. -->
    <div class="flex flex-1 flex-col">
      <div class="flex flex-1 flex-col pt-2 pb-2">
        {#each rows as row (row.message.ts)}
          <div data-ts={row.message.ts}>
            <SlackMessage
              message={row.message}
              users={thread.users}
              groups={thread.groups}
              me={thread.me}
              compact={row.compact}
              highlighted={payload.focusTs === row.message.ts &&
                payload.focusTs !== payload.threadTs}
              {now}
              readOnly={false}
              onToggleReaction={(ts, name, on) => void toggleReaction(ts, name, on)}
              onOpenUrl={openUrl}
            />
          </div>

          {#if row.repliesAfter > 0}
            <!-- The line between the message a thread is about and the
               conversation under it, which is the one structural fact a thread
               has and the thing Slack's own pane marks. -->
            <div class="flex items-center gap-2 px-4 py-3">
              <span class="text-[0.6875rem] text-ink-500">
                {row.repliesAfter}
                {row.repliesAfter === 1 ? 'reply' : 'replies'}
              </span>
              <span class="h-px flex-1 bg-white/10"></span>
            </div>
          {/if}
        {/each}

        <SlackComposer
          channelLabel={label}
          draft={tab.viewState?.draft ?? ''}
          disabled={readOnly}
          {onDraftChange}
          onSend={sendReply}
        />
      </div>
    </div>
  {/if}
</div>
