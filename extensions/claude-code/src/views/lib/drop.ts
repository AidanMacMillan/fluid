/**
 * Drags that come from outside the view: a file from Finder, or from a page in
 * a browser tab. The same three questions the app's own drop targets ask (see
 * src/renderer/src/lib/file-drop.ts in the app), which a view cannot import.
 */

/**
 * Whether a drag is carrying files. `dataTransfer.items` is readable during
 * `dragover` — unlike the files themselves, which the platform withholds until
 * the drop — so this is what a drop target has to decide on.
 */
export function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/**
 * The files a drop is carrying. Directories come through the same list and are
 * left out: a folder is not something that can be attached, and dropping one
 * is more plausibly a mis-drop than a request to attach every file beneath it.
 */
export function filesFrom(event: DragEvent): File[] {
  const items = event.dataTransfer?.items
  if (!items) return []

  return [...items]
    .filter((item) => item.kind === 'file' && item.webkitGetAsEntry()?.isFile !== false)
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/**
 * Whether a `dragleave` means the drag has really left `container`, rather than
 * just crossed between two children of it — which fires the same event.
 */
export function hasLeft(event: DragEvent, container: EventTarget | null): boolean {
  return !(
    container instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    container.contains(event.relatedTarget)
  )
}
