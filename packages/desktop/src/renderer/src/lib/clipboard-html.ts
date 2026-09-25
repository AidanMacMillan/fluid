/**
 * Reducing copied markup to something safe to draw.
 *
 * A clipboard history that shows formatting has to put markup somebody else
 * wrote into the app's own document, and that document carries the preload
 * bridge. So nothing copied is ever rendered as it arrived: what the panel
 * draws is the output of this file, and what goes back on the clipboard is the
 * untouched original, which is never rendered at all (see `restoreClipboardEntry`
 * in src/main/clipboard-window.ts). The two are different questions and neither
 * answer is made to serve both.
 *
 * The method is parse, walk, and rebuild — never filter text. Input is parsed
 * with `DOMParser`, which builds a tree in an inert document: no script runs, no
 * resource is fetched, and no `onerror` fires, which is exactly what makes it
 * safe to touch at all and exactly what assigning to `innerHTML` would not be.
 * Every node in that tree is then *ignored* unless it is on the allowlists
 * below, and what comes out is a fresh tree built with `createElement` and
 * `textContent`. Nothing is repaired, nothing is stripped in place, and nothing
 * survives by not having been thought of.
 *
 * The allowlist is small because the job is small. A row in a history panel
 * needs to look like what was copied, not to reproduce a document: bold, italic,
 * colour, lists, a table's shape. Everything that loads, executes, positions or
 * navigates is absent, so there is no attribute here through which a URL could
 * reach the page.
 */

/**
 * Tags kept, as the tag they already are. Presentational and structural only —
 * every one of them draws something and none of them can fetch anything.
 *
 * `a` is on the list but its `href` is not (see `ATTRIBUTES`): a link in a
 * clipboard row is a thing that was a link, not a thing to follow, and the
 * panel styles it as such. Dropping the attribute rather than checking its
 * scheme is deliberate — there is no URL to get wrong if there is no URL.
 */
const TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
])

/**
 * Tags whose *contents* are dropped along with them, rather than being pulled
 * up into the parent the way an unknown tag's children are.
 *
 * The difference matters. A `<section>` is not on the allowlist but the words
 * inside it are still what was copied, so they are kept and the wrapper is not.
 * A `<style>` block's contents are CSS, and a `<script>`'s are code: pulling
 * those up would put the text of a stylesheet into the middle of the row, which
 * is not dangerous but is nonsense.
 */
const OPAQUE_TAGS = new Set(['head', 'iframe', 'noscript', 'object', 'script', 'style', 'template'])

/**
 * The only attributes that survive, by tag. Vanishingly short on purpose: an
 * attribute is how content reaches out of itself, and the two kept here reach
 * nowhere.
 *
 * `colspan` and `rowspan` because a table without them is a table with the
 * wrong shape, and they are integers. Nothing else — no `id`, no `class`, no
 * `href`, no `src`, and no `style`, which is handled separately below because
 * it is not carried across but rebuilt property by property.
 */
const ATTRIBUTES: Record<string, Set<string>> = {
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan'])
}

/**
 * CSS properties copied out of a `style` attribute, and the whole of what makes
 * a rich row look like what was copied.
 *
 * Only properties that colour or weight text. Nothing that positions, sizes,
 * floats, or loads: `background-color` is here and `background` is not, because
 * the shorthand takes a `url()` and the longhand cannot.
 *
 * Values are not parsed here. Each is handed to `style.setProperty` on a real
 * element, and the browser's own CSS parser is what accepts or rejects it — a
 * value it does not understand is simply never set. That is a far better
 * validator than any expression written here could be; `SAFE_VALUE` and
 * `SAFE_FUNCTIONS` below are the belt to its braces.
 */
const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-align'
] as const

/**
 * What a style value may be made of before it is offered to the CSS parser at
 * all: letters, digits, and the punctuation colours and keywords are written
 * with. Quotes, semicolons, braces and backslashes are absent, which is most of
 * the vocabulary a CSS trick needs.
 *
 * Parentheses are here, and they have to be. Every colour a browser hands back
 * has already been normalised to `rgb(…)` — that is what `getPropertyValue`
 * answers with, whatever the source wrote — so a pattern that excluded them
 * would silently drop every colour in the panel while looking like it worked.
 * `SAFE_FUNCTIONS` below is what takes the parenthesis back.
 */
const SAFE_VALUE = /^[a-z0-9\s(),.#%/-]+$/i

/**
 * The only CSS functions allowed to appear in a value. An allowlist rather than
 * a list of the dangerous ones, for the reason the tags are: `url()` is the one
 * everybody thinks of, but `image()`, `image-set()`, `-moz-element()` and
 * `attr()` all reach outside the declaration too, and so will the next one
 * nobody has thought of yet.
 *
 * None of the seven properties above can legitimately hold anything but these:
 * a colour, and colours are all this is for.
 */
const SAFE_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color'
])

/** Every function name a value invokes, whether or not it is one we allow. */
const FUNCTION_CALL = /([a-z][a-z0-9-]*)\s*\(/gi

/** Whether a value calls only functions on the allowlist — or none at all. */
function functionsAreSafe(value: string): boolean {
  for (const [, name] of value.matchAll(FUNCTION_CALL)) {
    if (!SAFE_FUNCTIONS.has(name.toLowerCase())) return false
  }
  return true
}

/**
 * Ceilings on what one entry may produce. A clipboard is a place people put
 * whole documents into by accident, and a row in a panel is not the place to
 * find out how deep somebody's nesting goes.
 */
const MAX_DEPTH = 24
const MAX_NODES = 4000

/** Where an image was, since the picture itself is never brought across. */
function placeholder(document: Document, alt: string): HTMLElement {
  const marker = document.createElement('span')
  marker.setAttribute('data-clipboard-image', '')
  // `textContent`, so an `alt` full of angle brackets is words rather than
  // markup. This is the only place any of the original's own text becomes part
  // of an element rather than a text node, and it is still only text.
  marker.textContent = alt.trim() === '' ? 'Image' : alt.trim()
  return marker
}

/** Rebuilds one element, or answers null when the tag itself is not kept. */
function rebuild(source: Element, document: Document): HTMLElement | null {
  const tag = source.tagName.toLowerCase()
  if (!TAGS.has(tag)) return null

  const element = document.createElement(tag)

  for (const name of ATTRIBUTES[tag] ?? []) {
    const value = source.getAttribute(name)
    // Integers only, which is the whole of what a span attribute can mean.
    if (value && /^\d{1,3}$/.test(value)) element.setAttribute(name, value)
  }

  const declared = source.getAttribute('style')
  if (declared) {
    // Read back off the source's own parsed style rather than off the string:
    // the browser has already split the declaration, dropped what it could not
    // understand, and normalised the rest.
    const styles = (source as HTMLElement).style
    for (const property of STYLE_PROPERTIES) {
      const value = styles.getPropertyValue(property)
      if (value && SAFE_VALUE.test(value) && functionsAreSafe(value)) {
        element.style.setProperty(property, value)
      }
    }
  }

  return element
}

/** Copies `source`'s children into `target`, keeping only what is allowed. */
function walk(source: Node, target: Node, document: Document, depth: number, budget: Budget): void {
  if (depth > MAX_DEPTH) return

  for (const child of Array.from(source.childNodes)) {
    if (budget.nodes >= MAX_NODES) return

    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue ?? ''
      if (text === '') continue
      budget.nodes += 1
      target.appendChild(document.createTextNode(text))
      continue
    }

    // Everything that is not an element or a text node — comments, processing
    // instructions, doctypes — is simply not copied. There is no case in which
    // one of them is what somebody meant to copy.
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const element = child as Element
    const tag = element.tagName.toLowerCase()

    if (OPAQUE_TAGS.has(tag)) continue

    if (tag === 'img') {
      budget.nodes += 1
      target.appendChild(placeholder(document, element.getAttribute('alt') ?? ''))
      continue
    }

    const rebuilt = rebuild(element, document)
    if (!rebuilt) {
      // An unknown wrapper. Its children are still what was copied, so they are
      // lifted into the parent rather than going down with it.
      walk(element, target, document, depth + 1, budget)
      continue
    }

    budget.nodes += 1
    walk(element, rebuilt, document, depth + 1, budget)
    target.appendChild(rebuilt)
  }
}

/** How much of the ceiling the walk has spent so far. */
type Budget = { nodes: number }

/**
 * The drawable form of some copied markup, or null when there is nothing worth
 * drawing — markup that reduced to bare text, which the row already shows, or
 * to nothing at all.
 *
 * Returning null for plain-looking markup is what keeps the panel from putting
 * a rich row and an identical plain row side by side: the entry falls back to
 * its text, which is the same words with less machinery behind them.
 */
export function sanitiseClipboardHtml(html: string, text: string): string | null {
  if (html.trim() === '') return null

  // An inert document: nothing in here runs, loads, or fires an event, which is
  // the property the whole file rests on.
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const target = document.createElement('div')

  walk(parsed.body, target, document, 0, { nodes: 0 })

  // Nothing survived, or what survived is the plain text again with tags around
  // it that say nothing.
  if (target.childElementCount === 0) return null
  if (target.textContent?.trim() === '') return null
  if (target.innerHTML === text) return null

  return target.innerHTML
}
