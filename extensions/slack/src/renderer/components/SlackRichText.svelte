<script lang="ts">
  import { isWebAddress } from '@fluid/sdk'
  import type { SlackUserGroup } from '../../main/slack'
  import type { ThreadUser } from '../../main/slack-thread'
  import type { BlockNode, InlineNode, TextStyle } from '../lib/slack-rich-text'
  import SlackEmoji from './SlackEmoji.svelte'

  /**
   * A message's body.
   *
   * Takes the nodes rather than the message, so that one component draws both
   * of Slack's formats — see src/renderer/src/lib/slack-rich-text.ts, which is
   * where the two are reconciled.
   *
   * Links do not navigate here. The pane owns what a click means, because the
   * answer is "open a tab in this app", and a component that drew an `<a href>`
   * would hand the page to the OS browser instead.
   */
  type Props = {
    nodes: BlockNode[]
    /** For resolving `<@U…>` to a name. Absent ids are drawn as the id. */
    users: Record<string, ThreadUser>
    /**
     * For resolving `<!subteam^S…>` to a handle. Absent where the token cannot
     * read the workspace's groups, and those fall back to `@group` — a group
     * mention carries no name of its own to fall back to.
     */
    groups: Record<string, SlackUserGroup>
    /**
     * Whether to mark the message as edited. Drawn here rather than by the
     * caller so it can sit at the end of the last line, where Slack puts it —
     * appended after the body it would start a line of its own, which reads as
     * a second, very short message.
     */
    edited?: boolean
    onOpenUrl: (url: string) => void
  }

  const { nodes, users, groups, edited = false, onOpenUrl }: Props = $props()

  function classesFor(style: TextStyle): string {
    return [
      style.bold ? 'font-semibold text-ink-100' : '',
      style.italic ? 'italic' : '',
      style.strike ? 'line-through opacity-70' : ''
    ]
      .filter(Boolean)
      .join(' ')
  }

  function nameOf(userId: string): string {
    return users[userId]?.name ?? userId
  }

  /**
   * What to draw for a group mention, `@` and all.
   *
   * The directory first and the message's own label second, rather than the
   * other way round: a label is only ever there because whoever's Slack client
   * composed the message baked one in, and it is as old as the message. The
   * directory is what the group is called now.
   */
  function groupLabelOf(node: { groupId: string; label?: string }): string {
    const group = groups[node.groupId]
    if (group) return `@${group.handle || group.name}`
    // A baked-in label carries its own `@`; the placeholder is what is left
    // when there is neither — see the `usergroups:read` note in slack-scopes.ts.
    return node.label ?? '@group'
  }
</script>

{#snippet editedMark(index: number)}
  {#if edited && index === nodes.length - 1}<span
      class="ml-1 align-baseline text-[11px] text-ink-500">(edited)</span
    >{/if}
{/snippet}

{#snippet inline(children: InlineNode[])}
  {#each children as node, index (index)}
    {#if node.kind === 'text'}
      {#if node.style.code}
        <code
          class="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-amber-200/90
                 ring-1 ring-white/10">{node.text}</code
        >
      {:else}<span class={classesFor(node.style)}>{node.text}</span>{/if}
    {:else if node.kind === 'link' && isWebAddress(node.url)}
      <!-- A button rather than an anchor: see the note on `onOpenUrl`. It is
           styled as a link because that is what it is to the reader. -->
      <button
        type="button"
        onclick={() => onOpenUrl(node.url)}
        title={node.url}
        class="cursor-pointer text-left text-sky-400 underline-offset-2 hover:underline
               {classesFor(node.style)}"
      >
        {node.label}
      </button>
    {:else if node.kind === 'link'}
      <!-- A link to something this app will not open: `file:///…`, or a scheme
           nobody has heard of. Drawn as the text it is rather than dropped, and
           with the address spelled out rather than hidden behind a label — a
           message that tries this is worth being able to read in full.
           See src/main/safe-url.ts. -->
      <span class="text-ink-400" title="This app will not open {node.url}">
        {node.label}{node.label === node.url ? '' : ` (${node.url})`}
      </span>
    {:else if node.kind === 'user'}
      <!-- A mention of the reader would be worth marking differently; the pane
           knows who that is, and the day it matters this is where it goes. -->
      <span
        class="rounded bg-sky-400/15 px-1 py-px font-medium text-sky-200"
        title={users[node.userId]?.realName ?? node.userId}>@{nameOf(node.userId)}</span
      >
    {:else if node.kind === 'channel'}
      <span class="rounded bg-sky-400/15 px-1 py-px font-medium text-sky-200"
        >#{node.label ?? node.channelId}</span
      >
    {:else if node.kind === 'usergroup'}
      <span
        class="rounded bg-sky-400/15 px-1 py-px font-medium text-sky-200"
        title={groups[node.groupId]?.name ?? node.groupId}>{groupLabelOf(node)}</span
      >
    {:else if node.kind === 'broadcast'}
      <!-- `@here` and `@channel` reach everybody, so they are marked as the
           loud thing they are rather than as an ordinary mention. -->
      <span class="rounded bg-amber-400/15 px-1 py-px font-medium text-amber-200"
        >@{node.range}</span
      >
    {:else if node.kind === 'emoji'}
      <SlackEmoji name={node.name} />
    {/if}
  {/each}
{/snippet}

<!-- 14px, near enough Slack's own 15: this is a reading surface rather than
     chrome, and the rest of the app's 12px would be a wall. The caret cursor
     for the same reason: the app's default arrow says chrome, and the text here
     can be selected and copied. -->
<div
  class="cursor-text space-y-1.5 text-sm leading-[1.46] break-words whitespace-pre-wrap
         text-ink-200"
>
  {#each nodes as node, index (index)}
    {#if node.kind === 'paragraph'}
      <p>{@render inline(node.children)}{@render editedMark(index)}</p>
    {:else if node.kind === 'quote'}
      <blockquote class="border-l-2 border-white/25 pl-2.5 text-ink-400">
        {@render inline(node.children)}
      </blockquote>
    {:else if node.kind === 'code'}
      <!-- The one thing in a message allowed to scroll sideways: wrapping code
           is worse than a scrollbar, and the message column is narrow. -->
      <pre
        class="overflow-x-auto rounded-md bg-black/40 p-2.5 font-mono text-[0.75rem]
               leading-relaxed text-ink-200 ring-1 ring-white/10"><code>{node.text}</code></pre>
    {:else if node.kind === 'list'}
      {#if node.ordered}
        <ol class="list-decimal space-y-0.5 pl-5" style:margin-left="{node.indent}rem">
          {#each node.items as item, itemIndex (itemIndex)}
            <li>{@render inline(item)}</li>
          {/each}
        </ol>
      {:else}
        <ul class="list-disc space-y-0.5 pl-5" style:margin-left="{node.indent}rem">
          {#each node.items as item, itemIndex (itemIndex)}
            <li>{@render inline(item)}</li>
          {/each}
        </ul>
      {/if}
      {@render editedMark(index)}
    {/if}
  {/each}
</div>
