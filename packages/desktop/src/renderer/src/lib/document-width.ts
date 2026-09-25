import type { DocumentViewState, Tab } from '../../../main/db/schema'

/**
 * How wide an HTML file is read at, and the one line drawn across that range.
 *
 * The width is a number the user can put anywhere, by dragging either edge of
 * the view. What the toggle in the bar shows is not a second piece of state
 * beside it but a reading of it: a document at a phone's width or under is
 * being read as a phone, and anything wider is not. That is what keeps the two
 * from ever disagreeing — there is only the width, and the toggle is a question
 * asked of it.
 */
export type DocumentMode = 'desktop' | 'mobile'

/**
 * What a phone reports, and so both the width the toggle reaches for and the
 * line it reads. 390 is what the current iPhones are, and what a responsive
 * email's own breakpoints are written against.
 */
export const MOBILE_WIDTH = 390

/** The narrowest the view may be dragged — under a phone, but still a page. */
export const MIN_DOCUMENT_WIDTH = 240

/**
 * How much of the well is kept back either side of a document, for the handles
 * to live in.
 *
 * A handle has to sit outside the view to be usable at all: the view is native
 * and stacked above the renderer, so it takes every pointer event inside its
 * own rect and a handle overlapping it would be one nothing can reach. So even
 * a document at its widest stops short of the well's edges, which is also what
 * makes the handles reachable in desktop rather than only once it is narrowed.
 */
export const DOCUMENT_GUTTER = 12

/** A document tab's stored width, with the defaults an untouched tab reads as. */
export function documentStateOf(tab: Extract<Tab, { type: 'file' }>): Required<DocumentViewState> {
  const state = tab.viewState
  // A file tab's view state is whatever its own viewer put there — an image
  // tab's is a pan and a zoom — so what comes back is checked before it is
  // believed (see `FileViewState`).
  if (state === null || !('width' in state)) return { width: null, desktopWidth: null }
  return { width: state.width, desktopWidth: state.desktopWidth ?? null }
}

/** Which half of the toggle a width lights up. */
export function documentMode(width: number | null): DocumentMode {
  return width !== null && width <= MOBILE_WIDTH ? 'mobile' : 'desktop'
}
