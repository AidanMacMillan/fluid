<script lang="ts">
  import { onMount } from 'svelte'
  import type { AgentVisualization } from '../../shared/visualizations'

  let {
    visualization,
    load,
    onFollowUp
  }: {
    visualization: AgentVisualization
    load: (path: string) => Promise<string>
    onFollowUp?: (prompt: string) => void
  } = $props()
  let frame = $state<HTMLIFrameElement>()
  let url = $state('')
  let error = $state('')
  let height = $state(360)
  let expanded = $state(false)
  let revision = $state(0)
  let followUp = $state('')
  const title = $derived(visualization.title || 'Interactive visualization')
  const path = $derived(visualization.path)

  $effect(() => {
    const currentPath = path
    void revision
    let cancelled = false
    url = ''
    error = ''
    followUp = ''
    load(currentPath)
      .then((value) => {
        if (!cancelled) url = value
      })
      .catch((cause) => {
        if (!cancelled) error = cause instanceof Error ? cause.message : String(cause)
      })
    return () => {
      cancelled = true
    }
  })

  function theme(): void {
    const style = getComputedStyle(document.documentElement)
    const colors: Record<string, string> = {}
    for (const [target, source] of Object.entries({
      '--foreground': '--theme-ink-100',
      '--muted-foreground': '--theme-ink-400'
    })) {
      const value = style.getPropertyValue(source).trim()
      if (value) colors[target] = value
    }
    frame?.contentWindow?.postMessage(
      { channel: 'fluid-visualization', type: 'theme', colors },
      '*'
    )
  }
  onMount(() => {
    const receive = (event: MessageEvent): void => {
      if (
        !frame?.contentWindow ||
        event.source !== frame.contentWindow ||
        event.data?.channel !== 'fluid-visualization'
      )
        return
      if (event.data.type === 'ready') theme()
      if (
        event.data.type === 'resize' &&
        typeof event.data.height === 'number' &&
        Number.isFinite(event.data.height)
      ) {
        height = Math.max(120, Math.min(1600, event.data.height + 4))
      }
      if (
        event.data.type === 'followup' &&
        typeof event.data.prompt === 'string' &&
        event.data.prompt.trim() &&
        event.data.prompt.length <= 10000
      )
        followUp = event.data.prompt
    }
    window.addEventListener('message', receive)
    const observer = new MutationObserver(theme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })
    return () => {
      window.removeEventListener('message', receive)
      observer.disconnect()
    }
  })
</script>

<section class="visualization" class:expanded aria-label={title}>
  <header>
    <span>{title}</span>
    <div>
      <button type="button" onclick={() => revision++}>Reload</button>
      <button type="button" aria-pressed={expanded} onclick={() => (expanded = !expanded)}>
        {expanded ? 'Collapse' : 'Expand'}
      </button>
    </div>
  </header>
  {#if error}
    <p role="alert">Couldn’t load this visualization: {error}</p>
    <p class="path">{visualization.path}</p>
  {:else if url}
    <iframe
      bind:this={frame}
      src={url}
      {title}
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      style:height={expanded ? 'calc(100vh - 10rem)' : `${height}px`}
      style:max-width={visualization.mode === 'wide' ? '1024px' : '736px'}
    ></iframe>
  {:else}
    <p role="status">Loading visualization…</p>
  {/if}
  {#if followUp && onFollowUp}
    <div class="follow-up">
      <p>{followUp}</p>
      <button
        type="button"
        onclick={() => {
          onFollowUp?.(followUp)
          followUp = ''
        }}>Use as draft</button
      >
      <button type="button" onclick={() => (followUp = '')}>Dismiss</button>
    </div>
  {/if}
</section>

<style>
  .visualization {
    margin: 0.75rem 0;
    min-width: 0;
    color: var(--theme-ink-200);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  header div {
    display: flex;
    gap: 8px;
  }
  button {
    font: inherit;
    color: inherit;
    border: 1px solid var(--theme-ink-700);
    border-radius: 5px;
    background: transparent;
    padding: 4px 8px;
    cursor: pointer;
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    margin: 0 auto;
    background: transparent;
    color-scheme: dark;
  }
  .path {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .expanded {
    position: fixed;
    inset: 24px;
    z-index: 100;
    padding: 20px;
    margin: 0;
    overflow: auto;
    border: 1px solid var(--theme-ink-700);
    border-radius: 12px;
    background: #14161c;
  }
  .follow-up {
    border: 1px solid var(--theme-ink-700);
    padding: 12px;
    border-radius: 8px;
  }
  .follow-up p {
    white-space: pre-wrap;
  }
</style>
