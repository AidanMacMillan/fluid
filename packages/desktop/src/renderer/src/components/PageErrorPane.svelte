<script lang="ts">
  /**
   * What the page area shows when a navigation produced no page.
   *
   * Electron ships Chromium's engine but not Chrome's net-error pages: those
   * belong to the browser layer around it, the one this app replaces. Without
   * them a refused connection or a timed-out gateway leaves the view holding an
   * empty document, and the window just goes blank. This is that page, written
   * here so it can say what happened and offer the one useful thing — try again.
   *
   * It is drawn by the renderer rather than injected into the page, so the
   * failed address stays in the address bar and reload still retries it.
   */
  import type { PageError } from '../../../main/browser-views'

  const { error, onRetry }: { error: PageError; onRetry: () => void } = $props()

  /** What the user was reaching for, since the page cannot name itself. */
  const host = $derived.by(() => {
    try {
      return new URL(error.url).host
    } catch {
      return error.url
    }
  })

  /**
   * Chromium's net errors, in the words of the thing that went wrong rather
   * than the symbol for it. Only the ones a person can actually hit browsing —
   * anything else falls through to the general case, which is honest about
   * knowing no more than that the page did not load.
   */
  const NET_ERRORS: Record<number, { title: string; body: string }> = {
    [-2]: {
      title: 'This page did not load',
      body: 'The request failed before the page could be shown.'
    },
    [-6]: { title: 'This file was not found', body: 'There is nothing at that path on disk.' },
    [-7]: {
      title: 'This page took too long',
      body: 'The site did not answer in time. It may be busy or unreachable from here.'
    },
    [-21]: {
      title: 'The network changed',
      body: 'The connection dropped part-way through — moving between Wi-Fi and a wired network does this.'
    },
    [-100]: {
      title: 'The connection closed',
      body: 'The site closed the connection before it finished answering.'
    },
    [-101]: {
      title: 'The connection was reset',
      body: 'The site cut the connection part-way through.'
    },
    [-102]: {
      title: 'The connection was refused',
      body: 'Nothing is listening at that address. If it is a dev server, it may not be running.'
    },
    [-104]: { title: 'The connection failed', body: 'The site could not be reached.' },
    [-105]: {
      title: 'This site cannot be found',
      body: `No address could be found for ${host}. Check the spelling, or the network you are on.`
    },
    [-106]: { title: 'You are offline', body: 'There is no internet connection.' },
    [-109]: {
      title: 'This site is unreachable',
      body: 'The address resolved, but nothing there answered.'
    },
    [-118]: {
      title: 'The connection timed out',
      body: 'The site took too long to respond. It may be down, or blocked on this network.'
    },
    [-137]: {
      title: 'This site cannot be found',
      body: `The address for ${host} could not be resolved.`
    },
    [-200]: {
      title: 'This connection is not private',
      body: `The certificate ${host} presented is for a different site.`
    },
    [-201]: {
      title: 'This connection is not private',
      body: `The certificate ${host} presented has expired, or is not valid yet.`
    },
    [-202]: {
      title: 'This connection is not private',
      body: `The certificate ${host} presented was not issued by a trusted authority.`
    },
    [-324]: { title: 'This page sent nothing', body: 'The site answered with an empty response.' },
    [-501]: {
      title: 'This connection is not private',
      body: `The secure connection to ${host} could not be trusted.`
    }
  }

  /**
   * The error statuses worth naming. A response reaches this page only when its
   * body turned out to be empty, so these are the ones that arrive bare — the
   * gateway errors above all.
   */
  const HTTP_ERRORS: Record<number, { title: string; body: string }> = {
    [401]: {
      title: 'This page needs a sign-in',
      body: 'The site would not serve the page without credentials.'
    },
    [403]: {
      title: 'This page is not allowed',
      body: 'The site refused to serve it to this session.'
    },
    [404]: { title: 'This page was not found', body: `${host} has nothing at that address.` },
    [408]: {
      title: 'The request timed out',
      body: 'The site gave up waiting before the request finished.'
    },
    [429]: {
      title: 'Too many requests',
      body: 'The site is rate-limiting this connection. Waiting a moment usually clears it.'
    },
    [500]: {
      title: 'This site hit an error',
      body: 'Something went wrong on the server, and it sent no page to explain it.'
    },
    [502]: {
      title: 'This site is unavailable',
      body: `A gateway in front of ${host} got a bad response from it.`
    },
    [503]: {
      title: 'This site is unavailable',
      body: 'The server is down or overloaded. It may be a deploy in progress.'
    },
    [504]: {
      title: 'This site took too long',
      body: `A gateway in front of ${host} timed out waiting for it.`
    }
  }

  const shown = $derived(
    (error.kind === 'net' ? NET_ERRORS[error.code] : HTTP_ERRORS[error.code]) ?? {
      title: 'This page did not load',
      body:
        error.kind === 'http'
          ? `${host} answered with an error and sent no page.`
          : `${host} could not be reached.`
    }
  )

  /** The bottom line, for when the words above are not enough to go on. */
  const code = $derived(
    error.kind === 'http'
      ? `Status ${error.code}${error.detail ? ` · ${error.detail.toLowerCase()}` : ''}`
      : `Error ${Math.abs(error.code)}`
  )
</script>

<div class="flex h-full flex-col items-center justify-center gap-4 px-6">
  <span class="icon-[ph--cloud-slash] text-4xl text-ink-600" aria-hidden="true"></span>

  <div class="flex max-w-sm flex-col items-center gap-2 text-center">
    <h1 class="text-sm font-medium text-ink-200">{shown.title}</h1>
    <p class="text-xs leading-relaxed text-ink-500">{shown.body}</p>
  </div>

  <button
    type="button"
    onclick={onRetry}
    class="rounded-md glass-control px-3 py-1.5 text-xs font-medium text-ink-300 hover:text-ink-50"
  >
    Try again
  </button>

  <p class="text-[10px] text-ink-600 select-text">{code}</p>
</div>
