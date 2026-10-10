import type { LauncherContext, LauncherRow } from './renderer'

/**
 * How much a launcher row thinks it is what was typed for.
 *
 * Every row in the new-tab and new-task panels is scored between 0 and 1 for
 * what is in the field, and the panel is that list sorted best first. A row
 * that scores 0 is not drawn at all. There is no model behind it: each entry
 * says, in a few plain rules, when it is the answer, when it might be, and
 * when it never is — a terminal knows `ls -la` is a command and that "How do I
 * list files?" is not.
 *
 * The scale is shared, so a score means the same thing whichever row gives it:
 *
 * - `1` — certainly this: a link the entry recognises, the "New task" row.
 * - `0.75` and up — almost certainly this, and worth going above the search:
 *   a known command, a row named exactly.
 * - `0.5` — the search for what was typed, which every other row is measured
 *   against, and what every row scores while nothing is typed.
 * - below `0.5` — plausible, offered under the search.
 * - `0` — not this at all. Hidden.
 *
 * An entry says this with its `relevance` (see `LauncherRow`). One that has no
 * opinion — no rule, or a rule that answers null — is scored the way every
 * row always was: by how well what was typed matches its name and keywords
 * (see `matchScore`), or, for a row offered for any typed text, just under the
 * search.
 */

/**
 * What the launcher has made of what was typed: worked out once a keystroke,
 * and handed to every row's `relevance` so each can decide from the same facts.
 * The text itself is there too, for a rule the facts do not cover.
 */
export type LauncherQuery = {
  /** Exactly what is in the field. */
  raw: string
  /** Trimmed. Empty while nothing has been typed. */
  text: string
  /** `text`, lower-cased. */
  lower: string
  /** `text` split on whitespace, as typed. */
  words: string[]
  /** The first word, lower-cased, or empty. */
  head: string
  /** Nothing typed yet. */
  empty: boolean
  /** Has a line break in it, anywhere — even a trailing one. */
  multiline: boolean
  /** Names somewhere to go: a full address, or a bare host like `example.com`. */
  url: boolean
  /**
   * Starts at a path — `./script.sh`, `~/notes`, `/usr/bin` — rather than a
   * word or a host.
   */
  path: boolean
  /**
   * Has something only a shell would read: a pipe, `&&`, a redirect, a
   * `$VARIABLE`, a backtick, or a leading `NAME=value`. Quoted text is not
   * looked in, so `git commit -m "this | that"` counts for the `-m`, not the pipe.
   */
  shellSyntax: boolean
  /** Has a word after the first that is a flag: `-l`, `--force`. */
  flags: boolean
  /**
   * Asks something: ends in a question mark, or opens with a question word
   * ("how", "what", "can", "does"…) and has a few words to it.
   */
  question: boolean
  /**
   * Reads as something said rather than something run: a question, a
   * capitalised sentence of more than one word, or a few words carried by the
   * little ones ("the", "to", "with") that commands never need. Never true of
   * text with shell syntax in it, or of an address.
   */
  naturalLanguage: boolean
}

/**
 * A row's opinion of what was typed: a score from 0 to 1 (see the top of this
 * file), or null for none — which leaves the row scored the default way.
 */
export type Relevance = (query: LauncherQuery, context: LauncherContext) => number | null

/** The words a question opens with. "which" is left out: it is a command too. */
const QUESTION_WORDS = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'can',
  'could',
  'should',
  'would',
  'will',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'am',
  'have',
  'has',
  'may',
  'might',
  'shall'
])

/**
 * The little words English cannot do without and a command line never uses.
 * One of these among a few words is most of what tells a sentence from a
 * command, once the quoted parts are taken out.
 */
const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'for',
  'in',
  'on',
  'at',
  'by',
  'with',
  'about',
  'into',
  'from',
  'and',
  'or',
  'but',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'we',
  'you',
  'it',
  'is',
  'are',
  'was',
  'be',
  'been',
  'some',
  'any',
  'all',
  'every',
  'please',
  'should',
  'would',
  'could',
  'can',
  'will',
  'not',
  'why',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'do',
  'does',
  'than',
  'vs',
  'versus',
  'between',
  'without',
  'using'
])

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i
const BARE_HOST =
  /^(localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#]\S*)?$/i
const PATH = /^(\.{1,2}\/|~\/?|\/)/
/** Quoted spans, which say nothing about whether the line around them is a command. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
/** A pipe, `&&`/`||`, `;`, a redirect, `$VAR`/`$(…)`, a backtick, or a leading `NAME=value`. */
const SHELL_SYNTAX = /\||&&|;|(^|\s)\d?>{1,2}|<\s|\$[({A-Za-z_]|`|^[A-Z_][A-Z0-9_]*=\S/
const FLAG = /^--?[a-z0-9]/i

/**
 * Reads what was typed into the facts rows are scored from. `url` overrides the
 * SDK's own address test, for a host that has a better one of its own.
 */
export function analyseQuery(raw: string, options: { url?: boolean } = {}): LauncherQuery {
  const text = raw.trim()
  const lower = text.toLowerCase()
  const words = text === '' ? [] : text.split(/\s+/)
  const head = words[0]?.toLowerCase() ?? ''
  const multiline = /[\r\n]/.test(raw)

  const url =
    options.url ??
    (!multiline && words.length === 1 && (ABSOLUTE_URL.test(text) || BARE_HOST.test(text)))
  const unquoted = text.replace(QUOTED, ' ')
  const shellSyntax = SHELL_SYNTAX.test(unquoted)
  const flags = words.slice(1).some((word) => FLAG.test(word))
  const path = PATH.test(text)

  // Flags out first, or `ls -a` would read as having an "a" in it.
  const bare = unquoted
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => !FLAG.test(word))
    .map((word) => word.replace(/[^a-z']/g, ''))
    .filter(Boolean)
  // A question mark at the end outweighs a stray `;` or `>` in the middle: it
  // is what a question looks like, and nothing a command ends in.
  const question =
    (words.length >= 2 && /\?\s*$/.test(text)) ||
    (QUESTION_WORDS.has(head) && words.length >= 3 && !flags && !shellSyntax)
  const capitalisedSentence = /^[A-Z][a-z']*$/.test(words[0] ?? '') && words.length >= 2
  const carriedByLittleWords =
    bare.length >= 3 && bare.slice(1).some((word) => FUNCTION_WORDS.has(word))
  // A word with a full stop after it, which `go run .` and `ls ../..` are not.
  const sentenceEnd = words.length >= 3 && /^[a-z']+[.!]$/i.test(words.at(-1) ?? '')

  const naturalLanguage =
    !url &&
    !path &&
    (question ||
      (!shellSyntax && (capitalisedSentence || ((carriedByLittleWords || sentenceEnd) && !flags))))

  return {
    raw,
    text,
    lower,
    words,
    head,
    empty: text === '',
    multiline,
    url,
    path,
    shellSyntax,
    flags,
    question,
    naturalLanguage
  }
}

/**
 * Whether `term` starts a word somewhere in `text`: at the very start, or after
 * anything that is not a letter or a digit — so `ex` finds `https://example.com`
 * and `line` finds "command line", but `ls` does not find "elsewhere".
 */
function startsAWord(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true
  }
  return false
}

/**
 * The default score: how well what was typed matches a row's name, detail and
 * keywords. Every word typed has to start a word of the row's for it to match
 * at all — inside one is too loose, and finds the editor for `ls` because it
 * is offered "elsewhere" — and the closer it comes to the name itself, the
 * higher the row goes. Only a whole name, a whole keyword or the start of the
 * name beats the search; anything looser goes under it.
 */
export function matchScore(
  query: LauncherQuery,
  row: { label: string; detail?: string; keywords?: readonly string[] }
): number {
  if (query.empty) return 0.5

  const label = row.label.toLowerCase()
  const keywords = (row.keywords ?? []).map((keyword) => keyword.toLowerCase())
  const haystack = [label, row.detail?.toLowerCase() ?? '', ...keywords].join(' ')
  const terms = query.lower.split(/\s+/)
  if (!terms.every((term) => startsAWord(haystack, term))) return 0

  if (query.lower === label) return 0.85
  if (keywords.includes(query.lower)) return 0.75
  // A single letter starts too many names to mean any one of them.
  if (query.lower.length >= 2 && label.startsWith(query.lower)) return 0.6
  if (query.lower.length >= 2 && label.split(/\s+/).some((word) => word.startsWith(query.lower)))
    return 0.45
  return 0.3
}

/** Keeps a score on the scale: anything not a number above 0 is hidden, anything over 1 is 1. */
export function clampScore(score: number): number {
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0
}

/**
 * A row's score for what was typed: its own rule's, where it has an opinion,
 * and otherwise `fallback` — the name match for a row anyone might go looking
 * for, or a fixed place under the search for one offered for any text.
 */
export function scoreRow(
  row: LauncherRow,
  query: LauncherQuery,
  context: LauncherContext,
  fallback: number
): number {
  const own = row.relevance?.(query, context)
  return clampScore(own ?? fallback)
}

/** A rule, or a fixed score, for `when` to answer with. */
type Answer = number | Relevance

/**
 * Rules tried in order; the first with an opinion decides. The way most
 * entries are written: the cases where a row is certainly wrong first, then
 * the ones where it is certainly right, then whatever is left.
 *
 *     relevance: rules(
 *       when((q) => q.naturalLanguage, 0),
 *       when((q) => q.head === 'git', 0.95),
 *       () => 0.3
 *     )
 *
 * With none of them answering, the row is scored the default way.
 */
export function rules(...list: Relevance[]): Relevance {
  return (query, context) => {
    for (const rule of list) {
      const score = rule(query, context)
      if (score !== null) return score
    }
    return null
  }
}

/** A rule that answers `answer` when `test` holds, and has no opinion otherwise. */
export function when(
  test: (query: LauncherQuery, context: LauncherContext) => boolean,
  answer: Answer
): Relevance {
  return (query, context) =>
    test(query, context) ? (typeof answer === 'number' ? answer : answer(query, context)) : null
}
