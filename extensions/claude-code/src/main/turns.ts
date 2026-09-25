import type { ClaudeAside } from './events'

/**
 * Telling what the person typed apart from what Claude Code wrote for them.
 *
 * A transcript has one role for everything that is not the model: `user`. So
 * the CLI writes its own turns under that role too — a background task
 * reporting back, the caveat before a slash command, the summary that replaces
 * a compacted conversation — and marks them, when it marks them at all, with
 * fields the SDK's `SessionMessage` does not carry. Which leaves the text
 * itself as the only thing there is to go on, and the text is reliable: these
 * are written by the CLI to a fixed shape, in tags no composer produces.
 *
 * So this reads a user turn's text and says what it is made of. Anything it
 * does not recognise is the person speaking, which is the safe way round: a
 * harness note drawn as a turn is untidy, and a turn swallowed as a harness
 * note is a message the user wrote and cannot find.
 *
 * @module turns
 */

/** One piece of a user turn, in the order it appears. */
export type ClaudeTurnPart =
  | { kind: 'spoken'; text: string }
  | {
      kind: 'aside'
      aside: ClaudeAside
      /**
       * Whether this says again what the user sent, rather than reporting
       * something the harness did on its own — the expansion of a slash
       * command they typed, the note in place of a picture they attached.
       *
       * A live session has drawn that turn already, at the moment it was sent,
       * so an echo there would be the same thing twice. It is kept when a
       * transcript is read back off disk, where it is the only record of it.
       * The rest — a task reporting back, a conversation being summarised —
       * are nobody's echo and are drawn either way.
       */
      echo?: boolean
    }

/**
 * Blocks written to the model and addressed to nobody, which leave no trace on
 * screen. The caveat before a slash command says not to read it; the reminders
 * are the harness talking to itself, and are appended to turns the user did
 * type, so these are cut out of the text rather than recognised as the whole
 * of it.
 */
const SILENT = ['system-reminder', 'local-command-caveat'] as const

/**
 * What Claude Code writes on the line where a picture was: the file it came
 * from, or how it was scaled, or which numbered attachment it is. A line and
 * nothing else — the words that went with it are their own turn.
 */
const IMAGE_MARKER = /^\[Image(?::[^\]\n]*|\s*#\d+)?\]$/

/** The two sentences the CLI leaves when a turn was cut short. */
const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/

/** How the summary of a compacted conversation opens. */
const SUMMARY_OPENING = 'This session is being continued from a previous conversation'

/**
 * How a skill's instructions open. The whole of a skill is pasted into the
 * conversation as a turn, and it is a document written for the model — pages
 * of it — rather than anything the reader asked for.
 */
const SKILL_OPENING = /^Base directory for this skill: (\S+)/

/**
 * Blocks that are a thing that happened rather than a thing that was said.
 *
 * The last alternative catches the wrappers the desktop app sends when a
 * button rather than a person starts a turn — `<create-pr-command>` and its
 * kind. Matching the suffix rather than listing them keeps a new one from
 * arriving on screen as a wall of XML, and costs only the vanishing case of
 * somebody typing a lone element named that way.
 */
const ASIDES = /<(task-notification|local-command-stdout|[a-z][a-z0-9-]*-command)>([\s\S]*?)<\/\1>/g

/**
 * The parts of a slash command, which arrive as loose sibling tags rather than
 * nested in anything. `skill-format` rides along when the command is a skill.
 */
const COMMAND_PARTS = /<(command-name|command-message|command-args|skill-format)>([\s\S]*?)<\/\1>/g

/** Pasted text, wrapped by the composer. Claude Code repeats the id on the closing tag. */
const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g

/** Reads one text block of a user turn. */
export function readTurn(source: string): ClaudeTurnPart[] {
  let text = source
  for (const tag of SILENT) text = cut(text, tag)
  text = text.replace(PASTED, (_, body: string) => body)

  const images = countMarkers(text, IMAGE_MARKER)
  if (images > 0) text = dropMarkers(text, IMAGE_MARKER)

  const parts: ClaudeTurnPart[] = []

  // Ahead of the scan below rather than part of it, because the tags of a
  // command are siblings in whatever order the CLI wrote them and mean one
  // thing between them. A turn holding any of them holds nothing else.
  const command = readCommand(text)
  if (command) {
    parts.push({ kind: 'aside', aside: command.aside, echo: true })
    text = command.rest
  }

  let at = 0
  ASIDES.lastIndex = 0
  for (let match = ASIDES.exec(text); match; match = ASIDES.exec(text)) {
    say(parts, text.slice(at, match.index))
    parts.push({ kind: 'aside', aside: asideOf(match[1]!, match[2]!) })
    at = match.index + match[0].length
  }
  say(parts, text.slice(at))

  // Last, because a picture is sent with the words about it and the words are
  // the turn: the note only earns a line of its own when it is all there was.
  if (images > 0 && parts.length === 0) {
    parts.push({
      kind: 'aside',
      aside: { kind: 'image', label: images === 1 ? 'Sent an image' : `Sent ${images} images` },
      echo: true
    })
  }
  return parts
}

/** Adds a stretch of leftover text, as whatever it turns out to be. */
function say(parts: ClaudeTurnPart[], text: string): void {
  const trimmed = text.trim()
  if (trimmed === '') return

  if (INTERRUPTED.test(trimmed)) {
    parts.push({ kind: 'aside', aside: { kind: 'interrupted', label: 'Interrupted by user' } })
    return
  }
  const skill = SKILL_OPENING.exec(trimmed)
  if (skill) {
    parts.push({
      kind: 'aside',
      aside: {
        kind: 'skill',
        label: `Skill: ${skill[1]!.split('/').filter(Boolean).at(-1) ?? 'loaded'}`,
        detail: trimmed
      }
    })
    return
  }
  if (trimmed.startsWith(SUMMARY_OPENING)) {
    parts.push({
      kind: 'aside',
      aside: { kind: 'summary', label: 'Earlier conversation summarised', detail: trimmed }
    })
    return
  }
  parts.push({ kind: 'spoken', text: trimmed })
}

/** What one recognised block means. */
function asideOf(tag: string, body: string): ClaudeAside {
  if (tag === 'task-notification') {
    const summary = inner(body, 'summary')
    const status = inner(body, 'status')
    // An agent's report can run to twenty thousand words and is the whole
    // reason the task was started, so it is kept and folded away rather than
    // dropped with the bookkeeping around it. The ids, the output file and the
    // note reminding the model how notifications work are bookkeeping.
    const detail = inner(body, 'result') || inner(body, 'diagnostics')
    return {
      kind: 'task',
      label: summary || (status ? `Background task ${status}` : 'A background task finished'),
      ...(detail === '' ? {} : { detail })
    }
  }
  if (tag === 'local-command-stdout') {
    const output = body.trim()
    // A one-line result is its own heading; anything longer is folded away,
    // because what a command printed is worth keeping and not worth reading
    // again every time the conversation is scrolled past.
    return output.length <= 80 && !output.includes('\n')
      ? { kind: 'output', label: output === '' ? 'No output' : output }
      : { kind: 'output', label: 'Command output', detail: output }
  }
  // One of the desktop app's own wrappers: `<create-pr-command>` and its kind.
  return { kind: 'command', label: `/${tag.slice(0, -'-command'.length)}` }
}

/**
 * The slash command a turn ran, if it ran one, and what is left of the text
 * once its tags are out.
 */
function readCommand(text: string): { aside: ClaudeAside; rest: string } | null {
  const found: Record<string, string> = {}
  COMMAND_PARTS.lastIndex = 0
  for (let match = COMMAND_PARTS.exec(text); match; match = COMMAND_PARTS.exec(text)) {
    found[match[1]!] = match[2]!.trim()
  }
  const name = found['command-name'] ?? found['command-message']
  if (name === undefined || name === '') return null

  const args = found['command-args'] ?? ''
  return {
    aside: {
      kind: 'command',
      label: name.startsWith('/') ? name : `/${name}`,
      ...(args === '' ? {} : { detail: args })
    },
    rest: text.replace(COMMAND_PARTS, '')
  }
}

/** Removes every `<tag>…</tag>` from the text. */
function cut(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '')
}

/** How many of the text's own lines are one of these markers. */
function countMarkers(text: string, marker: RegExp): number {
  return text.split('\n').filter((line) => marker.test(line.trim())).length
}

function dropMarkers(text: string, marker: RegExp): string {
  return text
    .split('\n')
    .filter((line) => !marker.test(line.trim()))
    .join('\n')
}

/** The text of one `<tag>` inside a block, or `''` when it has none. */
function inner(body: string, tag: string): string {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]
  return found === undefined ? '' : decode(found.trim())
}

/**
 * Undoes the escaping that putting text inside a tag required. Claude Code
 * writes these blocks as XML, so an agent's report comes back with every
 * angle bracket in its code samples spelled out.
 */
function decode(text: string): string {
  return (
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(?:39|x27);/g, "'")
      .replace(/&apos;/g, "'")
      // Last, so an escaped ampersand cannot turn the text after it into another
      // entity: `&amp;lt;` is the four characters `&lt;`, not a `<`.
      .replace(/&amp;/g, '&')
  )
}
