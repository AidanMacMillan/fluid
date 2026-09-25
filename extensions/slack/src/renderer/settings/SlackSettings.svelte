<script lang="ts">
  import type { RendererHost } from '@fluid/sdk'
  import { SLACK_USER_SCOPE_GROUPS } from '../../main/slack-scopes'
  import type { TokenStatus } from '../../main/token'
  import { reasonFrom, setHost, tokenApi } from '../host'
  import SettingsCard from './SettingsCard.svelte'

  /**
   * Connecting Slack: signing in through the browser, which is the normal way,
   * or a user OAuth token pasted in, which is the fallback for when the sign-in
   * server cannot be reached. Either way the result is the same user token in
   * the vault, and the card lists the scopes it has to carry.
   */
  type Props = { host: RendererHost }

  const { host }: Props = $props()

  // svelte-ignore state_referenced_locally
  setHost(host)

  const api = tokenApi

  /**
   * A prefix today's tokens carry. Said under the field, never enforced: only
   * Slack can judge a token, and a client-side rule would age into a false
   * refusal.
   */
  const PREFIX = 'xoxp-'

  /**
   * The permissions the token has to carry, grouped by what each group buys.
   *
   * Listed on the card rather than left to a README because a token with the
   * wrong permissions does not look broken — it looks like the app is broken.
   * A Slack thread missing `users:read` draws perfectly, with every name an id
   * and every face a grey letter, and nothing anywhere says why.
   */
  const scopes = SLACK_USER_SCOPE_GROUPS

  /** Null until the first status lands; the card shows nothing rather than guessing. */
  let status = $state<TokenStatus | null>(null)
  /**
   * What the user has typed. Never seeded from storage — a saved token is not
   * readable from here, by design — so an empty field over a configured
   * token means "keep what is stored", not "clear it".
   */
  let draft = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  /** Cleared the moment the user types again, so it reads as "that just happened". */
  let saved = $state(false)

  $effect(() => {
    void refresh()
  })

  async function refresh(): Promise<void> {
    status = await api.status()
  }

  async function save(): Promise<void> {
    const token = draft.trim()
    if (token === '' || busy) return

    busy = true
    error = null
    try {
      status = await api.set(token)
      // The field empties on success: what is stored is not shown again, and
      // leaving the token sitting on screen would suggest otherwise.
      draft = ''
      saved = true
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /** True while the browser is out signing in, so the card can offer to stop waiting. */
  let connecting = $state(false)

  async function connect(): Promise<void> {
    if (busy) return
    busy = true
    connecting = true
    error = null
    saved = false
    try {
      // Null when cancelled, which is not worth a word: the user asked for it.
      const next = await api.connect()
      if (next !== null) {
        status = next
        saved = true
      }
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
      connecting = false
    }
  }

  function cancel(): void {
    void api.cancel()
  }

  async function remove(): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      status = await api.clear()
      saved = false
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') void save()
  }

  function onInput(): void {
    saved = false
    error = null
  }

  const fieldId = 'slack-token'
  const unavailable = $derived(status !== null && !status.available)
  const configured = $derived(status?.configured ?? false)
  /** Said, not enforced — see the note on `PREFIX`. */
  const looksWrong = $derived(draft.trim() !== '' && !draft.trim().startsWith(PREFIX))

  function savedAt(iso: string | null): string {
    if (!iso) return ''
    return new Date(iso).toLocaleString()
  }

  /** The scope list is long and typed into another application; nobody should retype it. */
  let copied = $state(false)

  async function copyScopes(): Promise<void> {
    // Newline separated: Slack's scope picker takes one at a time, and a list
    // that can be read down a column is easier to work through than a
    // comma-separated run-on.
    await navigator.clipboard.writeText(scopes.flatMap((group) => group.scopes).join('\n'))
    copied = true
    setTimeout(() => (copied = false), 2000)
  }
</script>

<SettingsCard
  name="Slack"
  icon="icon-[ph--slack-logo]"
  summary="Read and reply to Slack threads in a tab, as you."
  badge={status === null
    ? null
    : configured
      ? { label: 'Connected', tone: 'good' }
      : { label: 'Not connected', tone: 'idle' }}
>
  {#if unavailable}
    <!-- No credential store on this machine — a keyring that is not running,
         most often. Offering the field anyway would invite a key we would
         then have to refuse. -->
    <p class="flex items-start gap-2 text-xs text-amber-300">
      <span class="mt-px icon-[ph--warning] shrink-0 text-sm" aria-hidden="true"></span>
      <span>
        This computer has no secure credential store available, so a key cannot be saved.
      </span>
    </p>
  {:else}
    <!-- Signing in is the way in. The buttons change with where things stand:
         waiting on the browser, connected, or not yet. -->
    <div class="flex items-center gap-2">
      {#if connecting}
        <p class="flex min-w-0 flex-1 items-center gap-2 text-xs text-ink-300">
          <span class="icon-[ph--spinner] shrink-0 animate-spin text-sm" aria-hidden="true"></span>
          Finish signing in to Slack in your browser.
        </p>
        <button
          type="button"
          onclick={cancel}
          class="h-8 shrink-0 rounded-md glass-control px-3 text-xs font-medium text-ink-400
                 hover:text-ink-100"
        >
          Cancel
        </button>
      {:else}
        <button
          type="button"
          onclick={() => void connect()}
          disabled={busy}
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-md glass-control bg-white/10 px-3
                 text-xs font-medium text-ink-100 disabled:pointer-events-none disabled:opacity-40"
        >
          <span class="icon-[logos--slack-icon] text-sm" aria-hidden="true"></span>
          {configured ? 'Reconnect' : 'Connect Slack'}
        </button>
        {#if configured}
          <button
            type="button"
            onclick={() => void remove()}
            disabled={busy}
            class="h-8 shrink-0 rounded-md glass-control px-3 text-xs font-medium text-ink-400
                   hover:text-ink-100 disabled:pointer-events-none disabled:opacity-40"
          >
            Disconnect
          </button>
        {/if}
      {/if}
    </div>

    <!-- One line under the buttons, whichever matters most: a failure, then the
         confirmation, then what is already stored. -->
    {#if error}
      <p class="mt-2 text-xs text-red-400">{error}</p>
    {:else if saved}
      <p class="mt-2 text-xs text-emerald-300">Connected.</p>
    {:else if configured && status?.updatedAt}
      <p class="mt-2 text-xs text-ink-500">Connected {savedAt(status.updatedAt)}.</p>
    {/if}

    <p class="mt-3 text-[11px] leading-relaxed text-ink-500">
      Opens Slack in your browser to sign in. The token that comes back is encrypted with this
      computer's credential store and is never shown.
    </p>

    <!-- The fallback, for when the sign-in server cannot be reached: the same
         user token, pasted in from a Slack app of your own. -->
    <details class="group/token mt-3">
      <summary
        class="flex cursor-default list-none items-center gap-1.5 text-[11px] text-ink-400
               hover:text-ink-200"
      >
        <span
          class="icon-[ph--caret-right] text-xs transition-transform group-open/token:rotate-90"
          aria-hidden="true"
        ></span>
        Paste a token instead
      </summary>

      <div class="mt-2 border-l border-white/10 pl-3">
        <label class="block text-xs font-medium text-ink-300" for={fieldId}>
          User OAuth token
        </label>
        <div class="mt-1.5 flex items-center gap-2">
          <input
            id={fieldId}
            type="password"
            bind:value={draft}
            oninput={onInput}
            onkeydown={onKeydown}
            disabled={busy}
            placeholder={configured ? 'Enter a new token to replace the saved one' : `${PREFIX}…`}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="h-8 min-w-0 flex-1 rounded-md bg-black/30 px-2.5 font-mono text-xs text-ink-100
                   ring-1 ring-white/15 outline-none select-text placeholder:font-sans
                   placeholder:text-ink-500 focus:ring-white/30 disabled:opacity-60"
          />
          <button
            type="button"
            onclick={() => void save()}
            disabled={busy || draft.trim() === ''}
            class="h-8 shrink-0 rounded-md glass-control bg-white/10 px-3 text-xs font-medium
                   text-ink-100 disabled:pointer-events-none disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {#if looksWrong}
          <p class="mt-2 text-xs text-amber-300">
            Slack user tokens normally start with
            <code class="font-mono">{PREFIX}</code>.
          </p>
        {/if}
        <p class="mt-2 text-[11px] leading-relaxed text-ink-500">
          Found under <span class="text-ink-400">OAuth &amp; Permissions → User Token Scopes</span>
          in your Slack app's settings.
        </p>
      </div>
    </details>

    <!-- The permissions, spelled out. A token with the wrong ones does not
         announce itself: everything loads, and the parts that needed the
         missing scope are quietly wrong instead of absent. -->
    <details class="group/scopes mt-3">
      <summary
        class="flex cursor-default list-none items-center gap-1.5 text-[11px] text-ink-400
               hover:text-ink-200"
      >
        <span
          class="icon-[ph--caret-right] text-xs transition-transform
                   group-open/scopes:rotate-90"
          aria-hidden="true"
        ></span>
        Permissions this needs
      </summary>

      <div class="mt-2 space-y-2 border-l border-white/10 pl-3">
        {#each scopes as group (group.buys)}
          <div>
            <p class="text-[11px] text-ink-400">{group.buys}</p>
            <p class="mt-0.5 font-mono text-[11px] leading-relaxed break-words text-ink-500">
              {group.scopes.join('  ')}
            </p>
          </div>
        {/each}

        <button
          type="button"
          onclick={() => void copyScopes()}
          class="rounded-md glass-control px-2 py-1 text-[11px] text-ink-400 ring-1
                   ring-white/10 hover:text-ink-100"
        >
          {copied ? 'Copied' : 'Copy all'}
        </button>
      </div>
    </details>
  {/if}
</SettingsCard>
