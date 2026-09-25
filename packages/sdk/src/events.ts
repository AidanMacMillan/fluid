import type { Project, Space, Tab, TabFolder, Task, TaskNote } from './models'

/**
 * What changed in the workspace, announced after the change has been written.
 *
 * Every write the API makes produces exactly one of these, whoever asked for
 * it, so a subscriber sees the same account whether the change came from a
 * click, a routine or an extension. Records are carried whole, as they
 * are after the change, so a subscriber rarely has to ask for anything.
 */
export type WorkspaceEvent =
  | { type: 'space.created'; space: Space }
  | { type: 'space.updated'; space: Space }
  | { type: 'space.deleted'; space: Space }
  | { type: 'project.created'; project: Project }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; project: Project }
  /** The app moved to another project. */
  | { type: 'project.activated'; project: Project }
  | { type: 'task.created'; task: Task }
  /**
   * Any change to a task's row: a rename, new facts, its active tab, or its
   * status. `previous` is the row before, so a settle is
   * `previous.status === 'open' && task.status === 'settled'`.
   */
  | { type: 'task.updated'; task: Task; previous: Task }
  /** With the tabs it held, which went with it. */
  | { type: 'task.deleted'; task: Task; tabs: Tab[] }
  | { type: 'tasks.reordered'; projectId: string; tasks: Task[] }
  | { type: 'note.created'; note: TaskNote }
  | { type: 'note.updated'; note: TaskNote }
  | { type: 'note.deleted'; note: TaskNote }
  | { type: 'tab.created'; tab: Tab }
  | { type: 'tab.updated'; tab: Tab }
  | { type: 'tab.moved'; tab: Tab; fromTaskId: string }
  | { type: 'tab.closed'; tab: Tab }
  /** Tabs or folders changed places in a task's sidebar. Carries both, as they now are. */
  | { type: 'tabs.reordered'; taskId: string; tabs: Tab[]; folders: TabFolder[] }
  | { type: 'folder.created'; folder: TabFolder }
  /** A rename, or folding and unfolding. */
  | { type: 'folder.updated'; folder: TabFolder }
  /** Moved to another task. Each tab it carried is announced with `tab.moved`. */
  | { type: 'folder.moved'; folder: TabFolder; fromTaskId: string }
  /** Deleted. The tabs it held were closed first, and announced with `tab.closed`. */
  | { type: 'folder.deleted'; folder: TabFolder }
  /** The bookmark list changed: the user edited theirs, or an extension's changed. */
  | { type: 'bookmarks.changed' }
  | { type: 'setting.changed'; key: string; value: unknown }
  /** An extension was enabled, disabled or failed, or what it contributes changed. */
  | { type: 'extensions.changed' }
  /** Somebody asked for the user to be taken to a task. Windows act on this. */
  | { type: 'ui.revealRequested'; taskId: string; tabId: string | null }

export type WorkspaceEventType = WorkspaceEvent['type']

export type EventOf<T extends WorkspaceEventType> = Extract<WorkspaceEvent, { type: T }>

/**
 * The task an event is about, when it is about one — the task a tab or note
 * belongs to counts. Used to decide which live queries an event touches.
 */
export function taskIdsOf(event: WorkspaceEvent): string[] {
  switch (event.type) {
    case 'task.created':
    case 'task.updated':
    case 'task.deleted':
      return [event.task.id]
    case 'note.created':
    case 'note.updated':
    case 'note.deleted':
      return [event.note.taskId]
    case 'tab.created':
    case 'tab.updated':
    case 'tab.closed':
      return [event.tab.taskId]
    case 'tab.moved':
      return [event.tab.taskId, event.fromTaskId]
    case 'tabs.reordered':
      return [event.taskId]
    case 'folder.created':
    case 'folder.updated':
    case 'folder.deleted':
      return [event.folder.taskId]
    case 'folder.moved':
      return [event.folder.taskId, event.fromTaskId]
    default:
      return []
  }
}
