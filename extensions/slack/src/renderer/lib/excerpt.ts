/**
 * The first line of a message, near enough, for a sidebar row. Mentions and
 * links are already resolved by the time this sees them; all it does is flatten
 * the whitespace and cut it short.
 */
export function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}
