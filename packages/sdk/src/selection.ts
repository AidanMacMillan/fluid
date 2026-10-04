/**
 * Keeps the row marked as selected visible inside a scrolling collection.
 *
 * Keyboard-driven lists use either `aria-current` or `aria-selected`, depending
 * on whether the highlight represents the current destination or a listbox
 * selection. Hover also changes these attributes, but must not scroll the
 * collection. Track pointer and keyboard input before selection handlers run
 * so only keyboard-driven changes reveal a row. The child-list watch also
 * covers filtering when the selected index stays at zero but its row changes.
 */
export function keepSelectionInView(node: HTMLElement): { destroy: () => void } {
  let pointerSelection = false
  let destroyed = false
  const onPointer = (event: MouseEvent): void => {
    if (mouseMoved(event)) pointerSelection = true
  }
  const onKeyboard = (): void => {
    pointerSelection = false
  }

  const reveal = (): void => {
    if (pointerSelection || destroyed) return
    node
      .querySelector('[aria-current="true"], [aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // Capture movement before the rows select themselves. Key events often
  // target a search field outside the list. Enter/over events can be caused by
  // keyboard scrolling, so they must not switch back to pointer selection.
  node.addEventListener('mousemove', onPointer, true)
  node.ownerDocument.addEventListener('keydown', onKeyboard, true)

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

  return {
    destroy: () => {
      destroyed = true
      observer.disconnect()
      node.removeEventListener('mousemove', onPointer, true)
      node.ownerDocument.removeEventListener('keydown', onKeyboard, true)
    }
  }
}

/** Ignore stationary pointer events generated as content moves under the mouse. */
function mouseMoved(event: MouseEvent): boolean {
  return event.movementX !== 0 || event.movementY !== 0
}

/**
 * Let real mouse movement take over keyboard selection, including movement
 * within the same row. Entering a row because the list scrolled does nothing.
 * The marker also opts these rows out of the independent CSS hover highlight.
 */
export function selectOnMouseMove(
  node: HTMLElement,
  select: () => void
): { update: (select: () => void) => void; destroy: () => void } {
  const onMove = (event: MouseEvent): void => {
    if (mouseMoved(event)) select()
  }
  node.setAttribute('data-mouse-selection', '')
  node.addEventListener('mousemove', onMove)

  return {
    update: (next) => {
      select = next
    },
    destroy: () => {
      node.removeEventListener('mousemove', onMove)
      node.removeAttribute('data-mouse-selection')
    }
  }
}
