<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown'

  /**
   * Claude's prose, rendered.
   *
   * The model writes markdown — headings, lists, `code`, tables — and a
   * transcript that shows the asterisks is showing its working. This is the one
   * place that turns it into the thing it describes.
   *
   * `streaming` is the reason this library rather than a bare parser. The text
   * arrives a fragment at a time, so the source grows on every delta; the naive
   * answer is to re-parse and re-render the whole message each time, which is
   * quadratic and visibly stutters by the time an answer is a page long. The
   * component re-parses for correctness but diffs the result against what is on
   * screen, so only the last paragraph actually changes.
   *
   * `streamId` is what tells it one message from another: without it, a new
   * message would be read as an edit of the one before and the diff would be
   * against the wrong document.
   *
   * Half-written markdown is the other half of the problem, and it solves
   * itself — an unclosed fence or a lone `**` is simply text until the rest
   * arrives, which is the right thing to draw in the meantime.
   */
  type Props = {
    source: string
    /** Identity of this block, so the diff is against the right document. */
    id: string
    /** Thinking is drawn quieter than an answer; otherwise the two are the same. */
    muted?: boolean
  }
  const { source, id, muted = false }: Props = $props()
</script>

<div class="md {muted ? 'md-muted' : ''}">
  <SvelteMarkdown {source} streaming streamId={id} options={{ gfm: true, breaks: true }} />
</div>

<style>
  /*
   * `:global`, because these elements are the child component's rather than
   * this one's and scoped styles would never reach them. Confined to `.md` so
   * that is all this leaks to.
   *
   * `color-mix` rather than Tailwind's `--alpha()`: component styles are
   * compiled by Svelte and never reach Tailwind, so its build-time functions
   * would survive into the stylesheet as invalid CSS and the rule would simply
   * not apply. The theme's custom properties are fine — those are real
   * variables at runtime. VideoView does the same.
   *
   * Written out rather than reached for through a typography plugin: the whole
   * of what is needed is a dozen rules at this app's own sizes, and a plugin
   * would bring a stylesheet built for documents into a pane built for glances.
   */
  .md {
    font-size: 0.8125rem;
    line-height: 1.65;
    color: var(--theme-ink-200);
    overflow-wrap: anywhere;
  }

  .md-muted {
    color: var(--theme-ink-500);
    font-style: italic;
  }

  /* Blocks separate from each other but not from the turn around them: the
     column already spaces those, and a leading margin here would double it. */
  .md :global(> :first-child) {
    margin-top: 0;
  }
  .md :global(> :last-child) {
    margin-bottom: 0;
  }
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(pre),
  .md :global(blockquote),
  .md :global(table) {
    margin: 0.5rem 0;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.75rem 0 0.35rem;
    font-weight: 600;
    color: var(--theme-ink-100);
  }
  /* Barely larger than the body. A heading in a chat pane is a signpost, not a
     title page, and the weight is doing the work. */
  .md :global(h1) {
    font-size: 0.9rem;
  }
  .md :global(h2) {
    font-size: 0.85rem;
  }
  .md :global(h3),
  .md :global(h4) {
    font-size: 0.8rem;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.1rem;
  }
  .md :global(ul) {
    list-style: disc;
  }
  .md :global(ol) {
    list-style: decimal;
  }
  .md :global(li) {
    margin: 0.15rem 0;
  }
  .md :global(li::marker) {
    color: var(--theme-ink-600);
  }

  .md :global(strong) {
    font-weight: 600;
    color: var(--theme-ink-100);
  }
  .md :global(em) {
    font-style: italic;
  }

  .md :global(a) {
    color: var(--theme-ink-100);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Coloured rather than boxed. A background wide enough to read as a plate
     also reads as a gap either side of it, which is why `(cat, grep, sed)` came
     out looking like `( cat , grep , sed )`. The colour does the whole job and
     the padding can go back to almost nothing. */
  .md :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    color: var(--color-rose-300);
    background-color: color-mix(in srgb, var(--color-white) 5%, transparent);
    border-radius: 0.1875rem;
    padding: 0.0625rem 0.1875rem;
  }

  /* A fence is the one thing here that may be wider than the pane, and it
     scrolls on its own rather than widening the turn it sits in. */
  .md :global(pre) {
    background-color: color-mix(in srgb, var(--color-black) 25%, transparent);
    border-radius: 0.375rem;
    padding: 0.5rem 0.625rem;
    overflow-x: auto;
  }
  /* Inside a fence the colour would fight the block, and there is nothing to
     pick out: the whole thing is code. */
  .md :global(pre code) {
    background: none;
    padding: 0;
    color: var(--theme-ink-300);
    font-size: 0.75rem;
    line-height: 1.55;
  }

  .md :global(blockquote) {
    border-left: 2px solid color-mix(in srgb, var(--color-white) 15%, transparent);
    padding-left: 0.6rem;
    color: var(--theme-ink-400);
  }

  .md :global(hr) {
    margin: 0.75rem 0;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--color-white) 10%, transparent);
  }

  .md :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid color-mix(in srgb, var(--color-white) 10%, transparent);
    padding: 0.2rem 0.45rem;
    text-align: left;
  }
  .md :global(th) {
    color: var(--theme-ink-100);
    font-weight: 600;
  }
</style>
