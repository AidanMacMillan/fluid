import type { ProfileColor } from '../../../main/profiles'

/**
 * What each profile colour is, in the renderer's medium.
 *
 * Written out as whole class names rather than built from the colour: Tailwind
 * reads the source for literals, and a class assembled at runtime is a class it
 * never sees and never emits.
 *
 * These are the same five colours the page context menu draws its swatches in
 * (see SWATCH_COLORS in src/main/context-menu.ts) — the Tailwind 400s. The two
 * lists are separate because one is CSS and the other is pixels in a bitmap,
 * and neither medium should have to go through the other; if one moves, move
 * both.
 */
export const PROFILE_SWATCH: Record<ProfileColor, string> = {
  red: 'bg-red-400',
  blue: 'bg-blue-400',
  orange: 'bg-orange-400',
  green: 'bg-green-400',
  purple: 'bg-purple-400',
  grey: 'bg-zinc-400'
}
