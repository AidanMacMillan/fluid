import type { ClipboardEntry } from '../../../main/db/schema'

/**
 * Reading a clipboard entry back: what kind of thing it is, what to call it,
 * and what a row should show of it.
 *
 * Everything here is derived rather than stored. The row that draws an entry
 * and the filter that searches one both need the same answers, and a column
 * holding any of them would be a second copy of something the entry already
 * says.
 */

/**
 * Whether the content itself was too big to keep, so the entry is a record that
 * something was copied rather than a copy of it.
 *
 * The shape is the same for both kinds that can hit a ceiling: the content
 * column is empty and `size` is not. An image says so by having no file, text
 * by having no text — see MAX_IMAGE_BYTES and MAX_TEXT_BYTES in
 * src/main/clipboard-capture.ts.
 */
export function isTruncated(entry: ClipboardEntry): boolean {
  return entry.kind === 'image' ? entry.storageKey === null : entry.text === ''
}

/**
 * Whether the panel has yet worked out how to draw this entry's formatting.
 *
 * An entry is captured in the main process, which has no DOM and so cannot run
 * the sanitiser (see ./clipboard-html.ts). So a rich entry arrives unresolved,
 * and the first panel to lay eyes on it settles the question one way or the
 * other: either it comes back with markup worth drawing, or the entry turns out
 * to have been plain text wearing a `<meta>` tag and is relabelled as such.
 * Either way it is answered once, for good.
 */
export function needsSanitising(entry: ClipboardEntry): boolean {
  return entry.kind === 'rich-text' && entry.safeHtml === null
}

/** Whether the row should draw markup rather than a line of plain text. */
export function hasFormatting(entry: ClipboardEntry): boolean {
  return entry.kind === 'rich-text' && entry.safeHtml !== null
}

/** The glyph a row leads with, which is the whole of what says what it is. */
export function iconFor(entry: ClipboardEntry): string {
  if (entry.kind === 'files')
    return pathsOf(entry).length > 1 ? 'icon-[ph--files]' : 'icon-[ph--file]'
  if (entry.kind === 'image') return 'icon-[ph--image]'
  if (entry.kind === 'rich-text') return 'icon-[ph--text-aa]'
  return 'icon-[ph--text-align-left]'
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** A byte count as something to read, at the coarsest unit that still says something. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // Whole bytes stay whole; everything scaled gets one decimal until it is big
  // enough not to need one.
  const rounded = unit === 0 ? value : value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${UNITS[unit]}`
}

/**
 * The dimmer half of a row: what this entry is, in the few words that are worth
 * the space. Deliberately never the content — that is the other half of the row,
 * and repeating it here would cost the width that makes it readable.
 */
export function detailFor(entry: ClipboardEntry): string {
  if (isTruncated(entry)) return `Too large to keep · ${formatBytes(entry.size)}`

  if (entry.kind === 'image') {
    const size = entry.width && entry.height ? `${entry.width}×${entry.height}` : 'Image'
    return `${size} · ${formatBytes(entry.size)}`
  }

  if (entry.kind === 'files') {
    const count = pathsOf(entry).length
    return count === 1 ? '1 file' : `${count} files`
  }

  if (entry.kind === 'rich-text') return `Formatted · ${countLabel(entry.text)}`
  return countLabel(entry.text)
}

/** How much text, in whichever unit is the honest one at this length. */
function countLabel(text: string): string {
  const lines = text.split('\n').length
  if (lines > 1) return `${lines} lines`
  const characters = [...text].length
  return characters === 1 ? '1 character' : `${characters} characters`
}

/** A files entry's paths, which it keeps as its text, one to a line. */
function pathsOf(entry: ClipboardEntry): string[] {
  return entry.text.split('\n')
}

/**
 * What a files entry's row shows: the names, since a row is too narrow for a
 * path to say anything before it runs out, and the name is what was copied.
 * Split on either separator, the panel having no `path` module to ask.
 */
export function fileNamesOf(entry: ClipboardEntry): string {
  return pathsOf(entry)
    .map((path) => path.split(/[\\/]/).pop() || path)
    .join(', ')
}

/**
 * The single line a row shows of an entry's text. Runs of whitespace collapse,
 * because a copy that begins with a newline and four levels of indentation
 * would otherwise start the row with an empty stretch and no way to tell why.
 *
 * Cut short here rather than by CSS alone: a row holding a megabyte of one-line
 * JSON is a megabyte of text the browser still has to lay out to decide where
 * the ellipsis goes.
 */
export function previewOf(text: string): string {
  return text.slice(0, 400).replace(/\s+/g, ' ').trim()
}

/**
 * Whether an entry answers what was typed into the panel's field.
 *
 * Only ever the text — an image matches nothing but an empty query, and its own
 * detail line is generated rather than copied, so searching it would be
 * searching this file's wording rather than the user's content.
 */
export function matches(entry: ClipboardEntry, query: string): boolean {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return true
  return entry.text.toLowerCase().includes(wanted)
}
