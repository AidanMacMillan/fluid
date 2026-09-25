import './assets/main.css'

import type { SplitDropPreview } from '../../main/split-drop'

// The glass laid over the page area while a tab is dragged (see
// src/main/split-drop.ts). It takes the drag the pages under it would
// otherwise swallow, says where it is, and draws what the main window answers:
// the room the tab would take if let go now.
// Nothing is decided here — the panes, and so what a point means, are the main
// window's.

/** The type the sidebar's rows put on a tab drag (see `MIME` in lib/reorder.svelte.ts). */
const TAB_MIME = 'application/x-fluid-tab'

const api = window.api.splitDrop

document.body.style.cssText = 'position: fixed; inset: 0; margin: 0;'

function place(element: HTMLElement, box: Record<string, string>): void {
  Object.assign(element.style, { position: 'absolute', pointerEvents: 'none', ...box })
}

const preview = document.createElement('div')
preview.className = 'split-preview'
place(preview, { display: 'none' })
document.body.append(preview)

api.onPreview(({ box }: SplitDropPreview) => {
  if (!box) {
    preview.style.display = 'none'
    return
  }
  Object.assign(preview.style, {
    display: 'block',
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  })
})

// Every drag is taken: the glass is only ever up while one of the sidebar's
// tabs is in the air, and a drag carried in from another page does not always
// show its types until it lands.
function claim(event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  api.report({ kind: 'over', x: event.clientX, y: event.clientY })
}

// Both, since claiming either is what the platform reads as a drop target.
document.addEventListener('dragenter', claim)
document.addEventListener('dragover', claim)

document.addEventListener('dragleave', (event) => {
  // Crossing from one of the drawn boxes to the body is not leaving.
  if (event.relatedTarget === null) api.report({ kind: 'leave' })
})

document.addEventListener('drop', (event) => {
  event.preventDefault()
  const tabId = event.dataTransfer?.getData(TAB_MIME) || null
  api.report({ kind: 'drop', x: event.clientX, y: event.clientY, tabId })
})
