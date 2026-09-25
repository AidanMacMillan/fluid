<script lang="ts">
  import type { ClaudeApproval, ClaudeDecision } from '../../main/events'

  /**
   * A tool call waiting on the user.
   *
   * The sentence at the top is the CLI's own — it renders the prompt itself,
   * and a sentence rebuilt here from the tool name and its arguments would be a
   * worse one that also drifts as the tools change.
   *
   * Two of the props are safety rather than styling and are honoured rather
   * than interpreted. `allowAlways` false means the rule that choice would
   * write grants more than this one action, so the button is not offered at
   * all; `defaultToNo` means the decline is what a stray keystroke should
   * reach, so it takes the focus.
   */
  type Props = {
    approval: ClaudeApproval
    onDecide: (decision: ClaudeDecision) => void
  }
  const { approval, onDecide }: Props = $props()

  let decline = $state<HTMLButtonElement | null>(null)
  let accept = $state<HTMLButtonElement | null>(null)

  $effect(() => {
    if (approval.defaultToNo) decline?.focus()
    else accept?.focus()
  })

  const command = $derived(
    typeof approval.input.command === 'string' ? approval.input.command : null
  )
  const path = $derived(
    typeof approval.input.file_path === 'string' ? approval.input.file_path : null
  )
</script>

<div class="rounded-md bg-amber-400/5 px-3 py-2.5 ring-1 ring-amber-300/25">
  <div class="flex items-start gap-2">
    <!-- One line tall and centred, for the reason given in ClaudeToolCard. -->
    <span class="grid h-5 shrink-0 place-items-center">
      <span class="icon-[ph--hand-palm] text-sm text-amber-300" aria-hidden="true"></span>
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-xs/5 text-ink-200">{approval.title}</p>

      {#if command ?? path}
        <pre
          class="mt-1.5 max-h-40 overflow-auto rounded bg-black/25 px-2 py-1.5 font-mono
                 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-300">{command ??
            path}</pre>
      {/if}

      {#if approval.description}
        <p class="mt-1.5 text-[11px] leading-relaxed text-ink-400">{approval.description}</p>
      {/if}

      {#if approval.blockedPath}
        <p class="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-300">
          <span class="mt-px icon-[ph--warning] shrink-0 text-xs" aria-hidden="true"></span>
          <span>Outside this session's folder: {approval.blockedPath}</span>
        </p>
      {/if}
    </div>
  </div>

  <div class="mt-2.5 flex flex-wrap items-center gap-1.5 select-none">
    <button
      bind:this={accept}
      type="button"
      onclick={() => onDecide('once')}
      class="h-6 rounded-md bg-ink-100 px-2.5 text-[11px] font-medium text-ink-900
             hover:bg-white"
    >
      Allow
    </button>
    {#if approval.allowAlways}
      <button
        type="button"
        onclick={() => onDecide('always')}
        class="h-6 rounded-md glass-control px-2.5 text-[11px] font-medium text-ink-300
               hover:text-ink-100"
      >
        Allow for this session
      </button>
    {/if}
    <button
      bind:this={decline}
      type="button"
      onclick={() => onDecide('deny')}
      class="h-6 rounded-md glass-control px-2.5 text-[11px] font-medium text-ink-400
             hover:text-ink-100"
    >
      Decline
    </button>
  </div>
</div>
