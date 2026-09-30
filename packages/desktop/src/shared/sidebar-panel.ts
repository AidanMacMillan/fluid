import type { Tab, TabFolder, Task } from '@fluid/sdk'
import type { BrowserViewState } from '../main/browser-views'
import type { ProjectRow } from '../main/projects'
import type { SidebarPosition } from './appearance'

export const SIDEBAR_OPEN_MS = 260
export const SIDEBAR_CLOSE_MS = 200
export const SIDEBAR_PANEL_BLEED = 12
export const SIDEBAR_PANEL_INSET = 6

/** Data only: the host owns selection and live page state in both renderers. */
export type SidebarPanelState = {
  projects: ProjectRow[]
  activeProjectId: string | null
  tasks: Task[]
  tabs: Tab[]
  folders: TabFolder[]
  activeTaskId: string | null
  pages: Record<string, BrowserViewState>
  downloads: Record<
    string,
    {
      downloadId: string
      receivedBytes: number
      totalBytes: number
      paused: boolean
      tabId: string | null
    }
  >
  sidebarWidth: number
  sidebarPosition: SidebarPosition
  open: boolean
  density: number
  top: number
  collapsed: boolean
}

export type SidebarPanelReport =
  | { kind: 'hover'; inside: boolean }
  | { kind: 'resize'; width: number; commit: boolean }
  | {
      kind: 'drag'
      item: { kind: 'tab' | 'folder'; id: string } | null
      section: 'tab' | 'pinned-tab'
    }
  | { kind: 'close' }
