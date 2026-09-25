import type { Tab } from '../../../main/db/schema'
import { extensions } from './extensions.svelte'

/**
 * The glyph a tab is drawn with when it has no picture of its own (see
 * `workspace.iconFor`), or when that picture will not decode: a globe for a
 * page, a file or an image for a file, and whatever an extension names for its
 * tabs. Literal classes throughout, because the Iconify plugin only generates
 * the icons it can find written out in source.
 */
export function tabGlyph(tab: Tab): string {
  if (tab.type === 'browser') return 'icon-[ph--globe-simple]'
  if (tab.type === 'file') {
    return tab.payload.mimeType.startsWith('image/') ? 'icon-[ph--image]' : 'icon-[ph--file]'
  }
  return extensions.tabView(tab.type)?.icon ?? 'icon-[ph--puzzle-piece]'
}
