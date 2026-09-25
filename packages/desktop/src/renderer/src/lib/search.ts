/**
 * Whether what has been typed so far picks out a row described by `words` —
 * everything while the field is empty, and whatever the words match once it is
 * not.
 *
 * Every term has to land somewhere, so typing more words narrows the list
 * rather than widening it; each may land anywhere, so the order they are typed
 * in does not matter.
 *
 * One rule for every searchable list in the app — the launcher's bookmarks and
 * actions, the project picker — so one field filters the whole panel the same
 * way.
 */
export function matchesQuery(query: string, words: (string | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = words.filter(Boolean).join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
