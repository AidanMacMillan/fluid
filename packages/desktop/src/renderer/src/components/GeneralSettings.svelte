<script lang="ts">
  import { reasonFrom } from '../lib/ipc-error'
  import SearchEngineSettings from './SearchEngineSettings.svelte'

  let { onCustomEngine }: { onCustomEngine: (id: string | null) => void } = $props()

  type Status = Awaited<ReturnType<typeof window.api.defaultBrowser.status>>

  let status = $state<Status | null>(null)
  let working = $state(false)
  let error = $state<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      status = await window.api.defaultBrowser.status()
    } catch (cause) {
      error = reasonFrom(cause)
    }
  }

  async function makeDefault(): Promise<void> {
    working = true
    error = null
    try {
      status = await window.api.defaultBrowser.set()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      working = false
    }
  }

  // The system confirms in a prompt of its own, so the answer to the request is
  // not yet the outcome. The panel coming back to the front is the prompt being
  // dealt with, whichever way the user answered it.
  $effect(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  })
</script>

<div class="flex flex-col gap-5 text-xs">
  <SearchEngineSettings onCustom={onCustomEngine} />
  <div class="flex items-start gap-3 rounded-lg bg-white/5 p-3">
    <span class="min-w-0 flex-1">
      <span class="block font-medium text-ink-100">Default browser</span>
      <span class="mt-1 block text-ink-400">
        {#if status === null}
          Links from other apps open in the default browser.
        {:else if !status.supported}
          Only an installed build of Fluid can be made the default browser.
        {:else if status.isDefault}
          Fluid is your default browser. Links from other apps open as a new tab in the task you
          have selected.
        {:else}
          Open links from other apps in Fluid, as a new tab in the task you have selected.
          {#if status.currentApp}Your default is currently {status.currentApp}.{/if}
        {/if}
      </span>
    </span>
    {#if status?.supported}
      <button
        type="button"
        disabled={working || status.isDefault}
        onclick={() => void makeDefault()}
        class="shrink-0 rounded-md glass-control px-3 py-2 disabled:opacity-40"
        >{status.isDefault ? 'Default' : 'Make default'}</button
      >
    {/if}
  </div>
  {#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
</div>
