<script lang="ts">
  import { reasonFrom } from '../lib/ipc-error'

  /**
   * The top of the Extensions section: installing one from a folder, and the
   * folder installed ones live in. The folder picked is a built extension — or
   * the package it was built in, whose `dist/` holds it — and the main process
   * asks before installing it (see src/main/installed-extensions-ipc.ts).
   *
   * What it installed shows up in the list below on its own, with everything
   * else about it; this only says what just happened.
   */

  let busy = $state(false)
  let error = $state<string | null>(null)
  let done = $state<string | null>(null)

  async function install(): Promise<void> {
    if (busy) return
    busy = true
    error = null
    done = null
    try {
      const result = await window.api.installedExtensions.install()
      if ('installed' in result) {
        const { name, version, pendingRelaunch } = result.installed
        done = pendingRelaunch
          ? `Installed ${name}${version ? ` ${version}` : ''}. It starts once the app relaunches.`
          : `Installed ${name}${version ? ` ${version}` : ''}.`
      }
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  async function openFolder(): Promise<void> {
    error = null
    try {
      await window.api.installedExtensions.openFolder()
    } catch (cause) {
      error = reasonFrom(cause)
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-2">
    <button
      type="button"
      onclick={() => void install()}
      disabled={busy}
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-md glass-control bg-white/10 px-3
             text-xs font-medium text-ink-100 disabled:pointer-events-none disabled:opacity-40"
    >
      <span class="icon-[ph--folder-simple-plus] text-sm" aria-hidden="true"></span>
      Install from folder…
    </button>
    <button
      type="button"
      onclick={() => void openFolder()}
      class="h-8 shrink-0 rounded-md glass-control px-3 text-xs font-medium text-ink-400
             hover:text-ink-100"
    >
      Open extensions folder
    </button>
  </div>
  {#if done}
    <p class="text-xs text-ink-400">{done}</p>
  {/if}
  {#if error}
    <p class="text-xs text-red-400">{error}</p>
  {/if}
</div>
