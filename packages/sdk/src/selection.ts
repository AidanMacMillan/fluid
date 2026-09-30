/**
 * Keeps the row marked as selected visible inside a scrolling collection.
 *
 * Keyboard-driven lists use either `aria-current` or `aria-selected`, depending
 * on whether the highlight represents the current destination or a listbox
 * selection. Watching the attributes here lets panels and extension pickers
 * share the same behaviour without coupling the action to the state that
 * produced them. The child-list watch also covers filtering when the selected
 * index stays at zero but the row at that index is replaced.
 */
export function keepSelectionInView(node: HTMLElement): { destroy: () => void } {
  const reveal = (): void => {
    node
      .querySelector('[aria-current="true"], [aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const observer = new MutationObserver(reveal)
  observer.observe(node, {
    attributes: true,
    attributeFilter: ['aria-current', 'aria-selected'],
    childList: true,
    subtree: true
  })

  // Actions run while their element is mounting. Wait until its rows have
  // mounted too before revealing an initial selection that is not at the top.
  queueMicrotask(reveal)

  return { destroy: () => observer.disconnect() }
}
