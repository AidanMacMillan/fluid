export const SIDEBAR_POSITION_SETTING = 'sidebar.position'
export const WINDOW_TRANSPARENCY_SETTING = 'appearance.windowTransparency'
export const UI_DENSITY_SETTING = 'appearance.uiDensity'

/** One spacing multiplier for the main window's chrome; text stays the same size. */
export const UI_DENSITY = { min: 0.85, default: 1, max: 1.3 } as const
export const UI_DENSITY_MARKS = [
  { label: 'Compact', value: UI_DENSITY.min },
  { label: 'Spacious', value: UI_DENSITY.max }
] as const

export function uiDensity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(UI_DENSITY.max, Math.max(UI_DENSITY.min, value))
    : UI_DENSITY.default
}

const lowerRange = UI_DENSITY.default - UI_DENSITY.min
const upperRange = UI_DENSITY.max - UI_DENSITY.default
const curve = 2 * (upperRange - lowerRange)
const slope = 3 * lowerRange - upperRange

/** A smooth quadratic puts the default halfway along the continuous 0–1 slider. */
export function densityFromSlider(position: number): number {
  const t = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0.5
  return uiDensity(UI_DENSITY.min + t * (slope + curve * t))
}

/** Keep persisted values as spacing multipliers; only the slider is remapped. */
export function densityToSlider(value: unknown): number {
  const offset = uiDensity(value) - UI_DENSITY.min
  return (2 * offset) / (slope + Math.sqrt(slope * slope + 4 * curve * offset))
}

/** Native window controls need whole pixels; CSS uses this exact height too. */
export function titleBarHeight(density: unknown): number {
  return Math.round(40 * uiDensity(density))
}

export function trafficLightPosition(density: unknown): { x: number; y: number } {
  return { x: 14, y: Math.round((titleBarHeight(density) - 12) / 2) }
}

export type SidebarPosition = 'left' | 'right'

export function sidebarPosition(value: unknown): SidebarPosition {
  return value === 'right' ? 'right' : 'left'
}

/** 0 disables glass; 1 exposes the full native material. Preserve old toggles. */
export function windowTransparency(value: unknown): number {
  if (value === false) return 0
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}
