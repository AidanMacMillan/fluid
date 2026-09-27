<script lang="ts">
  import { untrack } from 'svelte'
  /** Shared message navigation for every agent provider. */
  type Mark = {
    id: string
    speaker: 'user' | 'agent'
    label: string
  }

  type Props = {
    marks: Mark[]
    visible: Set<string>
    onJump: (id: string) => void
  }
  const { marks, visible, onJump }: Props = $props()
  const uid = $props.id()

  let rail = $state<HTMLElement | null>(null)
  let height = $state(0)
  let previewHeight = $state(0)
  let hovered = $state<string | null>(null)
  let focused = $state<string | null>(null)
  let anchorY = $state(0)
  // A turn starts with a user message and includes every response until the
  // next prompt. Both providers can emit multiple text blocks in one turn.
  const turns = $derived.by(() => {
    const out: (Mark & { response: string; messageIds: string[] })[] = []
    for (const mark of marks) {
      const previous = out[out.length - 1]
      if (mark.speaker === 'user' || !previous) {
        out.push({
          ...mark,
          response: mark.speaker === 'agent' ? mark.label : '',
          messageIds: [mark.id]
        })
      } else {
        previous.messageIds.push(mark.id)
        // Prefer the latest answer over earlier progress updates.
        if (mark.label) previous.response = mark.label
      }
    }
    return out
  })
  const active = $derived(turns.findIndex((turn) => turn.id === (hovered ?? focused)))
  // Thin paint, compact rows, and padding across the whole 40px gutter.
  const unit = $derived(Math.max(10, Math.min(12, Math.floor(height / (turns.length || 1)))))
  const previewTop = $derived(
    Math.max(0, Math.min(height - previewHeight, anchorY - previewHeight / 2))
  )
  const preview = $derived.by(() => {
    const turn = turns[active]
    if (!turn) return null
    return {
      title:
        turn.speaker === 'agent' ? 'Agent message' : turn.response ? turn.label : 'Your message',
      body: turn.response || turn.label
    }
  })

  function locate(button: HTMLElement): void {
    if (!rail) return
    const bounds = button.getBoundingClientRect()
    anchorY = bounds.top + bounds.height / 2 - rail.getBoundingClientRect().top
  }

  function dismiss(): void {
    hovered = null
    focused = null
  }

  $effect(() => {
    const element = rail
    const first = turns.find((turn) => turn.messageIds.some((id) => visible.has(id)))
    if (!element || !first || untrack(() => active >= 0)) return
    if (element.scrollHeight <= element.clientHeight) return
    // Scroll only the rail, without moving any of the conversation's ancestors.
    const button = element.querySelector<HTMLElement>(`[data-mark="${CSS.escape(first.id)}"]`)
    if (!button) return
    const top = button.offsetTop
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + unit > element.scrollTop + element.clientHeight)
      element.scrollTop = top + unit - element.clientHeight
  })
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && active >= 0) {
      dismiss()
      event.stopPropagation()
    }
  }}
/>

<nav
  aria-label="Turns in this conversation"
  class="message-map"
  onpointerleave={() => (hovered = null)}
>
  <div
    bind:this={rail}
    bind:clientHeight={height}
    class="message-map-scroll scrollbar-none"
    onscroll={() => {
      hovered = null
      if (focused) {
        const button = rail?.querySelector<HTMLElement>(`[data-mark="${CSS.escape(focused)}"]`)
        if (button) locate(button)
      }
    }}
  >
    <div class="message-map-marks">
      {#each turns as mark, index (mark.id)}
        {@const distance = active < 0 ? Infinity : Math.abs(index - active)}
        <button
          type="button"
          data-mark={mark.id}
          data-lit={mark.messageIds.some((id) => visible.has(id)) || undefined}
          data-active={index === active || undefined}
          aria-label="{mark.speaker === 'user' ? 'You' : 'Agent'}: {mark.label}"
          aria-describedby={index === active ? `${uid}-preview` : undefined}
          onpointerenter={(event) => {
            hovered = mark.id
            locate(event.currentTarget)
          }}
          onfocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) {
              focused = mark.id
              locate(event.currentTarget)
            }
          }}
          onblur={() => (focused = null)}
          onclick={() => onJump(mark.id)}
          style:height="{unit}px"
        >
          <span
            style:width="{distance === 0
              ? 28
              : distance === 1
                ? 22
                : distance === 2
                  ? 15
                  : distance === 3
                    ? 10
                    : 6}px"
          ></span>
        </button>
      {/each}
    </div>
  </div>
  {#if preview}
    <div class="message-map-preview" style:top="{previewTop}px">
      <div
        id="{uid}-preview"
        role="tooltip"
        bind:clientHeight={previewHeight}
        class="rounded-xl glass-popover px-3 py-2.5 text-xs shadow-lg ring-1 ring-white/10"
      >
        <div class="truncate font-medium text-ink-100">{preview.title}</div>
        {#if preview.body}
          <div class="mt-1.5 line-clamp-3 leading-relaxed text-ink-400">{preview.body}</div>
        {/if}
      </div>
    </div>
  {/if}
</nav>

<style>
  .message-map {
    position: relative;
    flex: 0 0 40px;
    min-height: 0;
  }

  .message-map-scroll {
    position: absolute;
    inset: 0;
    display: flex;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .message-map-marks {
    width: 100%;
    margin-block: auto;
  }

  button {
    display: flex;
    align-items: center;
    width: 100%;
    padding-inline: 8px 4px;
    cursor: pointer;
    border-radius: 4px;
  }

  button span {
    height: 2px;
    flex-shrink: 0;
    background: var(--theme-ink-100);
    opacity: 0.24;
    transition:
      width 140ms ease,
      opacity 140ms ease;
  }

  button[data-lit] span {
    opacity: 0.6;
  }

  button[data-active] span {
    opacity: 1;
  }

  button:focus-visible {
    outline: 1px solid var(--theme-ink-400);
    outline-offset: -2px;
  }

  .message-map-preview {
    position: absolute;
    left: 100%;
    z-index: 40;
    width: min(320px, 60vw);
    padding-left: 8px;
    overflow-wrap: anywhere;
  }

  @media (prefers-reduced-motion: reduce) {
    button span {
      transition: none;
    }
  }
</style>
