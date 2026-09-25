import type { TaskColor } from '@fluid/sdk'

/**
 * What each task colour is, in the renderer's medium: the glyph's own colour,
 * and the swatch the picker offers it as.
 *
 * Written out as whole class names rather than built from the colour, for the
 * reason PROFILE_SWATCH is: Tailwind reads the source for literals, and a class
 * assembled at runtime is a class it never sees and never emits.
 *
 * Grey is not a colour so much as the absence of one. It is what every task
 * wears until somebody chooses, so it is drawn a step darker than the tab's own
 * text and recedes behind the title; the others are the Tailwind 400s, the same
 * weight the profile swatches use, which is what reads on the window's glass.
 */
export const TASK_COLOR_TEXT: Record<TaskColor, string> = {
  grey: 'text-zinc-500',
  red: 'text-red-400',
  orange: 'text-orange-400',
  yellow: 'text-yellow-400',
  green: 'text-green-400',
  teal: 'text-teal-400',
  blue: 'text-blue-400',
  purple: 'text-purple-400',
  pink: 'text-pink-400'
}

export const TASK_COLOR_SWATCH: Record<TaskColor, string> = {
  grey: 'bg-zinc-500',
  red: 'bg-red-400',
  orange: 'bg-orange-400',
  yellow: 'bg-yellow-400',
  green: 'bg-green-400',
  teal: 'bg-teal-400',
  blue: 'bg-blue-400',
  purple: 'bg-purple-400',
  pink: 'bg-pink-400'
}

/** What the picker calls each one, for its tooltip and for a screen reader. */
export const TASK_COLOR_LABEL: Record<TaskColor, string> = {
  grey: 'Grey',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink'
}
