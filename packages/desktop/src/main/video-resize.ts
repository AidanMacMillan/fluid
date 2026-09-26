import type { BaseWindow } from 'electron'

/** Constrain the picture while keeping the dragged edge attached to the pointer. */
export function constrainVideoResize(
  window: BaseWindow,
  ratio: number,
  barHeight: number,
  limits: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number }
): void {
  // Linux has no cancellable will-resize event.
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    window.setAspectRatio(ratio, { width: 0, height: barHeight })
    return
  }

  // A single range of widths keeps both limits compatible with the picture.
  const maxWidth = Math.min(limits.maxWidth, limits.maxHeight * ratio)
  const minWidth = Math.min(maxWidth, Math.max(limits.minWidth, limits.minHeight * ratio))
  let horizontal: boolean | null = null

  window.on('will-resize', (event, proposed, { edge }) => {
    event.preventDefault()
    const bounds = window.getBounds()
    if (horizontal === null) {
      // Keep the driving axis for the whole gesture, including corner drags.
      // macOS already reports the dominant axis as either right or bottom.
      horizontal =
        edge === 'left' ||
        edge === 'right' ||
        (edge.includes('-') &&
          Math.abs(proposed.width - bounds.width) >= Math.abs(proposed.height - bounds.height))
    }

    // Use the native drag's proposed size on its driving axis, then derive
    // only the other dimension. Applying setAspectRatio as well would constrain
    // the proposal before this event and detach the edge from the pointer.
    const requestedWidth = horizontal ? proposed.width : (proposed.height - barHeight) * ratio
    const width = Math.round(Math.min(maxWidth, Math.max(minWidth, requestedWidth)))
    const height = Math.round(width / ratio) + barHeight
    if (process.platform === 'darwin') {
      // Cocoa positions the resized frame around the grabbed edge after this
      // callback. Moving it here too would apply the left/top offset twice.
      window.setSize(width, height)
      return
    }
    window.setBounds({
      x: edge.includes('left') ? bounds.x + bounds.width - width : bounds.x,
      y: edge.includes('top') ? bounds.y + bounds.height - height : bounds.y,
      width,
      height
    })
  })
  window.on('resized', () => {
    horizontal = null
  })
}
