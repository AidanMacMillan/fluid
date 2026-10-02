/** The gap between icons and readable labels is never a resting width. */
export const SIDEBAR_WIDTH = { default: 224, icons: 56, min: 168, max: 420 } as const

export function clampSidebarWidth(width: number, icons = true): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default
  if (icons && width < (SIDEBAR_WIDTH.icons + SIDEBAR_WIDTH.min) / 2) {
    return SIDEBAR_WIDTH.icons
  }
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))
}
