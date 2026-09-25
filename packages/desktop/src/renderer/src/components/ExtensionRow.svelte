<script lang="ts">
  import type { ExtensionInfo } from '@fluid/sdk'
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'

  /**
   * One installed extension, and the switch that turns it on and off. Turning
   * one off takes away everything it adds — its task badges, tab types,
   * bookmarks, launcher rows and background jobs — and turning it back on
   * brings them back; its tabs and tasks stay where they were throughout.
   *
   * An installed one can also be found on disk and removed, and one installed
   * while the app was running may be waiting for a relaunch to start.
   */
  type Props = { extension: ExtensionInfo }

  const { extension }: Props = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)

  const labelId = $derived(`extension-${extension.id}`)

  /** Set when a relaunch was asked for while developing, which cannot do one. */
  let relaunchByHand = $state(false)

  async function reveal(): Promise<void> {
    error = null
    try {
      await window.api.installedExtensions.reveal(extension.id)
    } catch (cause) {
      error = reasonFrom(cause)
    }
  }

  async function remove(): Promise<void> {
    busy = true
    error = null
    try {
      // The row goes with the extension, once the list hears it is gone.
      await window.api.installedExtensions.remove(extension.id)
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  async function review(): Promise<void> {
    busy = true
    error = null
    try {
      await window.api.installedExtensions.approve(extension.id)
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /** What an installed extension may do beyond the workspace, one short phrase each. */
  const abilities = $derived.by(() => {
    const permissions = extension.permissions
    if (!permissions) return []
    return [
      ...permissions.hosts.map((host) => `connect to ${host}`),
      ...permissions.commands.map((command) => `run ${command}`),
      ...permissions.extensions.map((id) => `use ${id}`)
    ]
  })

  /** Whether it is on and allowed to be: one waiting for approval is off, whatever was saved. */
  const on = $derived(extension.enabled && !extension.needsApproval)

  async function relaunch(): Promise<void> {
    error = null
    try {
      relaunchByHand = !(await window.api.installedExtensions.relaunch())
    } catch (cause) {
      error = reasonFrom(cause)
    }
  }

  async function toggle(): Promise<void> {
    busy = true
    error = null
    try {
      await fluid.extensions.setEnabled({ id: extension.id, enabled: !extension.enabled })
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }
</script>

<article class="rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
  <div class="flex items-start gap-3">
    <span
      class="icon-[ph--puzzle-piece] grid size-8 shrink-0 place-items-center rounded-md bg-white/10
             text-lg text-ink-200"
      aria-hidden="true"
    ></span>
    <div class="min-w-0 flex-1">
      <h3 id={labelId} class="text-sm font-medium text-ink-100">
        {extension.name}
        {#if extension.source === 'installed'}
          <!-- Said because it is not the app's: it was put in the app's data
               folder, and is updated and removed there. -->
          <span class="ml-1.5 text-xs font-normal text-ink-500">
            Installed{extension.version ? ` · ${extension.version}` : ''}
          </span>
        {/if}
      </h3>
      {#if extension.description}
        <p class="mt-0.5 text-xs text-ink-400">{extension.description}</p>
      {/if}
      {#if abilities.length > 0}
        <!-- What it was allowed to do when it was approved. Everything else an
             installed extension might try is refused. -->
        <p class="mt-1 text-[11px] text-ink-500">Can {abilities.join(', ')}.</p>
      {/if}
    </div>

    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelId}
      onclick={() => void toggle()}
      disabled={busy || extension.needsApproval !== undefined}
      class="relative h-5 w-9 shrink-0 rounded-full ring-1 transition-colors
             disabled:pointer-events-none disabled:opacity-40
             {on ? 'bg-switch-on ring-white/20' : 'bg-white/10 ring-white/15'}"
    >
      <span
        class="absolute top-0.5 size-4 rounded-full bg-ink-100 shadow transition-[left]
               {on ? 'left-[1.125rem]' : 'left-0.5'}"
        aria-hidden="true"
      ></span>
    </button>
  </div>

  {#if extension.needsApproval}
    <div class="mt-3 flex items-center gap-3">
      <p class="min-w-0 flex-1 text-xs text-amber-300">
        {extension.needsApproval === 'changed'
          ? 'Its files have changed since you approved it, so it is not running.'
          : "It was added to the app's data folder rather than installed here, so it is not running."}
      </p>
      <button
        type="button"
        onclick={() => void review()}
        disabled={busy}
        class="h-7 shrink-0 rounded-md glass-control bg-white/10 px-3 text-xs font-medium
               text-ink-100 disabled:pointer-events-none disabled:opacity-40"
      >
        Review…
      </button>
    </div>
  {:else if extension.pendingRelaunch}
    <div class="mt-3 flex items-center gap-3">
      <p class="min-w-0 flex-1 text-xs text-ink-400">
        {relaunchByHand
          ? 'Restart the dev server to finish installing it.'
          : 'Relaunch the app to finish installing it.'}
      </p>
      <button
        type="button"
        onclick={() => void relaunch()}
        class="h-7 shrink-0 rounded-md glass-control bg-white/10 px-3 text-xs font-medium
               text-ink-100"
      >
        Relaunch
      </button>
    </div>
  {:else if extension.error}
    <p class="mt-3 text-xs text-amber-300">Could not start: {extension.error}</p>
  {/if}
  {#if extension.source === 'installed'}
    <div class="mt-3 flex items-center gap-1 border-t border-white/5 pt-2">
      <button
        type="button"
        onclick={() => void reveal()}
        class="h-7 rounded-md glass-control px-2.5 text-xs text-ink-400 hover:text-ink-100"
      >
        Show folder
      </button>
      <button
        type="button"
        onclick={() => void remove()}
        disabled={busy}
        class="h-7 rounded-md glass-control px-2.5 text-xs text-ink-400 hover:text-red-300
               disabled:pointer-events-none disabled:opacity-40"
      >
        Remove
      </button>
    </div>
  {/if}
  {#if error}
    <p class="mt-3 text-xs text-red-400">{error}</p>
  {/if}
</article>
