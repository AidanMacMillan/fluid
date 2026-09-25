<svelte:head>
  <title>Fluid</title>
</svelte:head>

<main>
  <h1>Fluid</h1>
  <p>Nothing to see here yet. Connect Slack from the Fluid app's settings.</p>
</main>

<style>
  :global(:root) {
    color-scheme: light dark;
    --bg: #fafafa;
    --fg: #18181b;
    --muted: #52525b;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #09090b;
      --fg: #f4f4f5;
      --muted: #a1a1aa;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font:
      15px/1.5 system-ui,
      sans-serif;
  }
  main {
    max-width: 28rem;
    margin: 20vh auto 0;
    padding: 0 16px;
  }
  h1 {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  p {
    margin: 0;
    color: var(--muted);
  }
</style>
