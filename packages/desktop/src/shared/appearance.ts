export const SIDEBAR_POSITION_SETTING = 'sidebar.position'

export type SidebarPosition = 'left' | 'right'

export function sidebarPosition(value: unknown): SidebarPosition {
  return value === 'right' ? 'right' : 'left'
}
