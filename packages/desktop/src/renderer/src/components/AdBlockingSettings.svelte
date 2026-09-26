<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import {
    AD_BLOCKING_SETTING,
    adBlockingSettings,
    exceptionHost,
    type AdBlockingSettings
  } from '../../../shared/ad-blocking'

  let settings = $state(adBlockingSettings(null))
  let loaded = $state(false)
  let saving = $state(false)
  let site = $state('')
  let error = $state<string | null>(null)

  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: AD_BLOCKING_SETTING },
      (value) => {
        settings = adBlockingSettings(value)
        loaded = true
      },
      (cause) => {
        error = reasonFrom(cause)
      }
    )
  )

  async function save(next: AdBlockingSettings): Promise<boolean> {
    saving = true
    error = null
    try {
      // Svelte state can contain proxies; Electron IPC needs a plain object.
      await fluid.settings.set({
        key: AD_BLOCKING_SETTING,
        value: {
          enabled: next.enabled,
          blockTrackers: next.blockTrackers,
          exceptions: [...next.exceptions]
        }
      })
      settings = next
      return true
    } catch (cause) {
      error = reasonFrom(cause)
      return false
    } finally {
      saving = false
    }
  }

  async function addSite(): Promise<void> {
    const host = exceptionHost(site)
    if (!host) {
      error = 'Enter a website address, such as example.com.'
      return
    }
    if (settings.exceptions.includes(host)) {
      error = 'This site is already in the exceptions list.'
      return
    }
    if (await save({ ...settings, exceptions: [...settings.exceptions, host].sort() })) site = ''
  }
</script>

<div class="flex flex-col gap-5 text-xs">
  <label class="flex items-start gap-3 rounded-lg bg-white/5 p-3">
    <input
      type="checkbox"
      name="block-ads"
      class="mt-0.5 accent-marker"
      checked={settings.enabled}
      disabled={!loaded || saving}
      onchange={(event) => void save({ ...settings, enabled: event.currentTarget.checked })}
    />
    <span>
      <span class="block font-medium text-ink-100">Block ads</span>
      <span class="mt-1 block text-ink-400"
        >Powered by <a
          href="https://github.com/ghostery"
          target="_blank"
          rel="noopener noreferrer"
          class="underline decoration-ink-500 underline-offset-2 hover:text-ink-200">Ghostery</a
        >. Applies to all browsing profiles, including private browsing.</span
      >
    </span>
  </label>

  <label class="flex items-start gap-3 rounded-lg bg-white/5 p-3">
    <input
      type="checkbox"
      name="block-trackers"
      class="mt-0.5 accent-marker"
      checked={settings.blockTrackers}
      disabled={!loaded || saving}
      onchange={(event) => void save({ ...settings, blockTrackers: event.currentTarget.checked })}
    />
    <span>
      <span class="block font-medium text-ink-100">Block trackers</span>
      <span class="mt-1 block text-ink-400"
        >Block known tracking requests. Works independently of ad blocking across all browsing
        profiles.</span
      >
    </span>
  </label>

  <div class="flex flex-col gap-2">
    <h2 class="font-medium text-ink-200">Site exceptions</h2>
    <p class="text-ink-400">Allow ads and trackers on these sites and their subdomains.</p>
    <form
      class="flex gap-2"
      onsubmit={(event) => {
        event.preventDefault()
        void addSite()
      }}
    >
      <input
        type="text"
        aria-label="Website to allow ads and trackers on"
        placeholder="example.com"
        bind:value={site}
        disabled={!loaded || saving}
        class="min-w-0 flex-1 rounded-md bg-white/5 px-2.5 py-2 text-ink-100 ring-1 ring-white/10 outline-none focus:ring-marker/60"
      />
      <button
        type="submit"
        disabled={!loaded || saving || !site.trim()}
        class="rounded-md glass-control px-3 py-2 disabled:opacity-40">Add</button
      >
    </form>
    {#if loaded && settings.exceptions.length === 0}
      <p class="py-2 text-ink-500">No site exceptions.</p>
    {:else}
      <ul class="divide-y divide-white/10">
        {#each settings.exceptions as host (host)}
          <li class="flex items-center gap-2 py-2">
            <span class="min-w-0 flex-1 truncate text-ink-200">{host}</span>
            <button
              type="button"
              aria-label={`Remove exception for ${host}`}
              disabled={saving}
              onclick={() =>
                void save({
                  ...settings,
                  exceptions: settings.exceptions.filter((value) => value !== host)
                })}
              class="rounded-md glass-control px-2 py-1 text-ink-400 disabled:opacity-40"
              >Remove</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <p class="text-ink-500">Reload open pages after changing these settings.</p>
  {#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
</div>
