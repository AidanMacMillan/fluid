import type { SlackBlock, SlackRichTextBlock, SlackRichTextElement } from '../../main/slack'

/**
 * What a Slack message says, as something that can be drawn.
 *
 * A message arrives in one of two forms and the pane should not have to care
 * which. Anything posted by a modern Slack client carries `blocks`: a tree in
 * which a mention is an element that says it is a mention and carries the user
 * id. Anything else — an app's post, an old message, a webhook — carries only
 * `text`, which is mrkdwn, and in which that same mention is the substring
 * `<@U024BE7LH>` embedded in everything else.
 *
 * Both are turned into the nodes below, so there is exactly one renderer.
 * Blocks are preferred wherever they exist, because parsing them is reading
 * what Slack already decided rather than guessing at it a second time.
 */

/** The marks that can sit on a run of text. They combine. */
export type TextStyle = {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

export type InlineNode =
  | { kind: 'text'; text: string; style: TextStyle }
  | { kind: 'link'; url: string; label: string; style: TextStyle }
  /** A person. The id is resolved against the thread's users at draw time. */
  | { kind: 'user'; userId: string }
  /** `#channel`. Slack sometimes gives the name alongside the id, sometimes not. */
  | { kind: 'channel'; channelId: string; label?: string }
  | { kind: 'usergroup'; groupId: string; label?: string }
  /** `@here`, `@channel`, `@everyone`. */
  | { kind: 'broadcast'; range: string }
  | { kind: 'emoji'; name: string }

export type BlockNode =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'quote'; children: InlineNode[] }
  /** A fenced block. Held as raw text: nothing inside one is formatting. */
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; indent: number; items: InlineNode[][] }

// ---------------------------------------------------------------------------
// From blocks
// ---------------------------------------------------------------------------

function styleOf(style: TextStyle | undefined): TextStyle {
  return style ?? {}
}

function inlineFromElement(element: SlackRichTextElement): InlineNode | null {
  switch (element.type) {
    case 'text': {
      const text = (element as { text: string }).text
      return { kind: 'text', text, style: styleOf((element as { style?: TextStyle }).style) }
    }
    case 'link': {
      const link = element as { url: string; text?: string; style?: TextStyle }
      return {
        kind: 'link',
        url: link.url,
        // A bare URL has no label of its own, and showing the address is the
        // honest thing for one.
        label: link.text && link.text !== '' ? link.text : link.url,
        style: styleOf(link.style)
      }
    }
    case 'user':
      return { kind: 'user', userId: (element as { user_id: string }).user_id }
    case 'channel':
      return { kind: 'channel', channelId: (element as { channel_id: string }).channel_id }
    case 'usergroup':
      return { kind: 'usergroup', groupId: (element as { usergroup_id: string }).usergroup_id }
    case 'broadcast':
      return { kind: 'broadcast', range: (element as { range: string }).range }
    case 'emoji':
      return { kind: 'emoji', name: (element as { name: string }).name }
    default:
      // A block kit element this app has never met. Skipped rather than
      // guessed at: an unknown element drawn as `[object Object]` is worse
      // than one simply not drawn.
      return null
  }
}

function inlinesFrom(elements: SlackRichTextElement[] | undefined): InlineNode[] {
  return (elements ?? []).map(inlineFromElement).filter((node): node is InlineNode => node !== null)
}

function blockFromSection(section: SlackRichTextBlock): BlockNode | null {
  switch (section.type) {
    case 'rich_text_section':
      return { kind: 'paragraph', children: inlinesFrom(section.elements) }
    case 'rich_text_quote':
      return { kind: 'quote', children: inlinesFrom(section.elements) }
    case 'rich_text_preformatted':
      // Everything inside is literal, so the runs are concatenated back into
      // the one string they were before Slack split them.
      return {
        kind: 'code',
        text: inlinesFrom(section.elements)
          .map((node) => (node.kind === 'text' ? node.text : node.kind === 'link' ? node.url : ''))
          .join('')
      }
    case 'rich_text_list': {
      const list = section as Extract<SlackRichTextBlock, { type: 'rich_text_list' }>
      return {
        kind: 'list',
        ordered: list.style === 'ordered',
        indent: list.indent ?? 0,
        items: (list.elements ?? []).map((item) => inlinesFrom(item.elements))
      }
    }
    default:
      return null
  }
}

/**
 * A message's rich text blocks as drawable nodes, or null when it has none
 * this renderer understands — an app's block kit layout, most often, which
 * falls back to the message's mrkdwn.
 */
export function fromBlocks(blocks: SlackBlock[] | undefined): BlockNode[] | null {
  const richText = (blocks ?? []).filter(
    (block): block is Extract<SlackBlock, { type: 'rich_text' }> => block.type === 'rich_text'
  )
  if (richText.length === 0) return null

  const nodes: BlockNode[] = []
  for (const block of richText) {
    for (const section of block.elements ?? []) {
      const node = blockFromSection(section)
      if (node) nodes.push(node)
    }
  }
  return nodes.length > 0 ? nodes : null
}

// ---------------------------------------------------------------------------
// From mrkdwn
// ---------------------------------------------------------------------------

/**
 * Slack escapes exactly three characters in message text, and no more — this
 * is not HTML, and treating it as such would turn `&copy;` into a symbol
 * nobody typed.
 */
function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/**
 * Everything mrkdwn can produce inside a line, in one alternation so that the
 * first match always wins. The order is what makes it correct: an angle-bracket
 * token can contain any character at all, so it has to be recognised before
 * anything looks for emphasis inside it, and a code span suppresses emphasis
 * within itself for the same reason.
 */

/**
 * A delimiter only counts at the edge of a word, which is the rule that keeps
 * `some_long_name` from turning into `somelongname` in italics — the single
 * most common thing a naive mrkdwn parser gets wrong, and one that a codebase's
 * Slack channels hit several times a day.
 */
const OPENS = '(?<![\\p{L}\\p{N}_])'
const CLOSES = '(?![\\p{L}\\p{N}_])'

/**
 * What can sit between a pair of `delimiter`s: at least one character, no
 * spaces immediately inside either end, and no newline — emphasis does not
 * cross lines in Slack.
 */
function body(delimiter: string): string {
  const not = `[^${delimiter}\\s]`
  return `${not}(?:[^${delimiter}\\n]*${not})?`
}

const INLINE_TOKEN = new RegExp(
  [
    // <@U123>, <@U123|name>, <#C123|general>, <!here>, <!subteam^S1|@eng>, <url|label>
    '<(?<token>[^<>]*)>',
    // `code`
    '`(?<code>[^`\\n]+)`',
    // *bold*, _italic_, ~strike~. `body` also requires the character just
    // inside each delimiter to be a non-space, which is what leaves `a * b`
    // alone — Slack will not open emphasis on a space either.
    `${OPENS}\\*(?<bold>${body('*')})\\*${CLOSES}`,
    `${OPENS}_(?<italic>${body('_')})_${CLOSES}`,
    `${OPENS}~(?<strike>${body('~')})~${CLOSES}`,
    // :emoji:, including a skin tone suffix
    ':(?<emoji>[a-z0-9_+\\-]+(?:::skin-tone-\\d)?):'
  ].join('|'),
  'giu'
)

/** `<!subteam^SAZ94GDB8|@engineering>` and its shorter forms. */
const SUBTEAM = /^!subteam\^([A-Z0-9]+)(?:\|(.*))?$/i

/** What an angle-bracket token turns into. */
function inlineFromToken(token: string): InlineNode {
  // A mention, a channel, or a broadcast — everything Slack encodes with a
  // sigil. The label after a pipe is Slack's own rendering hint and is only
  // used where nothing better can be looked up.
  const [target, label] = splitOnce(token, '|')

  if (target.startsWith('@')) return { kind: 'user', userId: target.slice(1) }
  if (target.startsWith('#')) {
    return { kind: 'channel', channelId: target.slice(1), label: label ?? undefined }
  }
  if (target.startsWith('!')) {
    const subteam = SUBTEAM.exec(target)
    if (subteam) return { kind: 'usergroup', groupId: subteam[1], label: subteam[2] ?? label }
    // `<!here>`, `<!channel>`, `<!everyone>`, and `<!date^…>` which is rare
    // enough to be drawn as whatever label Slack supplied.
    const range = target.slice(1).split('^')[0]
    return { kind: 'broadcast', range }
  }

  // Everything else is a link, which is the common case by a wide margin.
  return {
    kind: 'link',
    url: unescape(target),
    label: label !== null ? unescape(label) : unescape(target),
    style: {}
  }
}

function splitOnce(text: string, separator: string): [string, string | null] {
  const at = text.indexOf(separator)
  return at === -1 ? [text, null] : [text.slice(0, at), text.slice(at + separator.length)]
}

/** One line of mrkdwn as inline nodes. */
function inlinesFromMrkdwn(line: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let cursor = 0

  const push = (text: string, style: TextStyle = {}): void => {
    if (text !== '') nodes.push({ kind: 'text', text: unescape(text), style })
  }

  INLINE_TOKEN.lastIndex = 0
  for (let match = INLINE_TOKEN.exec(line); match !== null; match = INLINE_TOKEN.exec(line)) {
    push(line.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const groups = match.groups ?? {}
    if (groups.token !== undefined) nodes.push(inlineFromToken(groups.token))
    else if (groups.code !== undefined) push(groups.code, { code: true })
    else if (groups.bold !== undefined) push(groups.bold, { bold: true })
    else if (groups.italic !== undefined) push(groups.italic, { italic: true })
    else if (groups.strike !== undefined) push(groups.strike, { strike: true })
    else if (groups.emoji !== undefined) nodes.push({ kind: 'emoji', name: groups.emoji })
  }

  push(line.slice(cursor))
  return nodes
}

/** A line that is part of a list, and which kind. */
const BULLET = /^\s*[•\-*]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/

/**
 * A mrkdwn message as drawable nodes.
 *
 * Deliberately line-oriented: Slack's mrkdwn has no block structure beyond
 * fences, quotes and the lists people type by hand, and anything cleverer would
 * be inventing a grammar Slack does not have.
 */
export function fromMrkdwn(text: string): BlockNode[] {
  if (text.trim() === '') return []

  const nodes: BlockNode[] = []
  const lines = text.split('\n')

  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    nodes.push({ kind: 'paragraph', children: inlinesFromMrkdwn(paragraph.join('\n')) })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    // A fence runs to the closing one, or to the end of the message when the
    // author never closed it — which people do constantly.
    if (line.trimStart().startsWith('```')) {
      flush()
      const body: string[] = []
      // Slack allows content on the opening fence line itself.
      const opener = line.trimStart().slice(3)
      if (opener.trim() !== '') body.push(opener)

      index += 1
      for (; index < lines.length; index++) {
        if (lines[index].trimStart().startsWith('```')) break
        body.push(lines[index])
      }
      nodes.push({ kind: 'code', text: unescape(body.join('\n')) })
      continue
    }

    if (line.startsWith('>')) {
      flush()
      // Consecutive quoted lines are one quote, the way Slack draws them.
      const quoted: string[] = []
      for (; index < lines.length && lines[index].startsWith('>'); index++) {
        quoted.push(lines[index].replace(/^>\s?/, ''))
      }
      index -= 1
      nodes.push({ kind: 'quote', children: inlinesFromMrkdwn(quoted.join('\n')) })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    if (bullet || ordered) {
      flush()
      const isOrdered = ordered !== null
      const items: InlineNode[][] = []
      for (; index < lines.length; index++) {
        const item = isOrdered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index])
        if (!item) break
        items.push(inlinesFromMrkdwn(item[1]))
      }
      index -= 1
      nodes.push({ kind: 'list', ordered: isOrdered, indent: 0, items })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    paragraph.push(line)
  }

  flush()
  return nodes
}

/**
 * A message's content, from whichever of the two forms it came in. Blocks win
 * where there are any; `text` is both the fallback and what an app's message
 * has instead.
 */
export function messageNodes(text: string, blocks: SlackBlock[] | undefined): BlockNode[] {
  return fromBlocks(blocks) ?? fromMrkdwn(text)
}

/**
 * The plain-text reading of a message, for a tooltip or a row. Mentions come
 * out as ids unless `names` can resolve them, which is the caller's business.
 */
export function plainText(nodes: BlockNode[], names: (userId: string) => string): string {
  const inline = (children: InlineNode[]): string =>
    children
      .map((node) => {
        switch (node.kind) {
          case 'text':
            return node.text
          case 'link':
            return node.label
          case 'user':
            return `@${names(node.userId)}`
          case 'channel':
            return `#${node.label ?? node.channelId}`
          case 'usergroup':
            return node.label ?? '@group'
          case 'broadcast':
            return `@${node.range}`
          case 'emoji':
            return `:${node.name}:`
        }
      })
      .join('')

  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'paragraph':
        case 'quote':
          return inline(node.children)
        case 'code':
          return node.text
        case 'list':
          return node.items.map(inline).join('\n')
      }
    })
    .join('\n')
    .trim()
}
