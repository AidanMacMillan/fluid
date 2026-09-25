import type { BrowserViewState, OpenTabRequest } from '../../../main/browser-views'
import type {
  DownloadEvent,
  DownloadFinished,
  DownloadProgress,
  DownloadStarted
} from '../../../main/downloads'
import type { StoredFile } from '../../../main/files'
import type { ShortcutNavigation } from '../../../main/menu'
import type { TaskFocus } from '../../../main/notifications'
import type { ProjectRow, ProjectsState } from '../../../main/projects'
import {
  NEW_TASK_TITLE,
  folderSubtree,
  leavingSplit,
  sidebarItems,
  sidebarTree,
  splitContaining,
  tabIdsInSplit,
  taskIdsOf,
  type BrowserTabPayload,
  type FileTabPayload,
  type NewTab,
  type NewTaskTemplate,
  type SidebarItem,
  type Tab,
  type TabActivity,
  type TabActivityEntry,
  type TabFolder,
  type TabSplit,
  type Task,
  type WorkspaceEvent
} from '@fluid/sdk'
import { tick } from 'svelte'
import { strongerActivity } from './activity'
import { fluid } from './api'
import { extensions } from './extensions.svelte'
import { visibleTabs } from './sidebar-rows'
import {
  moveDivider,
  placeAlongside,
  placeBeside,
  type SplitDivider,
  type SplitEdge
} from './splits'
import { originOf } from './urls'

export { NEW_TASK_TITLE }

/**
 * How long a tab's view state settles before it is written. Panning and zooming
 * produce a change per frame, and the database is not where those belong; the
 * delay is short enough that the write lands during the pause after a gesture
 * rather than after the user has moved on.
 */
const VIEW_STATE_WRITE_DELAY_MS = 250

/** Where a new browser tab starts. No address bar yet, so this is the only way in. */
export const DEFAULT_BROWSER_URL = 'https://www.google.com'

const api = window.api

/** Settings row backing `Workspace.sidebarCollapsed`. */
const SIDEBAR_COLLAPSED_KEY = 'sidebar.collapsed'

/** Settings row backing `Workspace.sidebarWidth`. */
const SIDEBAR_WIDTH_KEY = 'sidebar.width'

/**
 * The sidebar's width, in CSS pixels, and the range the resize handle holds it
 * to. Pixels rather than a fraction of the window: what the sidebar has to fit
 * is a column of fixed-height rows with a label on each, and that does not grow
 * because the window did. The floor keeps a tab's title readable; the ceiling
 * keeps the sidebar from taking the window over.
 */
export const SIDEBAR_WIDTH = { default: 224, min: 168, max: 420 } as const

function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))
}

/**
 * The whole app's state: the task strip across the top, the tab list of
 * whichever task is selected, and the live page state the main process reports
 * for the native browser views.
 *
 * The database is the source of truth — every mutation writes first and then
 * re-reads, rather than patching the local copy and hoping the two agree.
 */
class Workspace {
  /**
   * The projects, as the bar and the picker draw them. The app is always in
   * exactly one of them, and `tasks` is that one's strip — switching project
   * replaces it wholesale, the way switching task replaces `tabs`.
   */
  projects = $state<ProjectRow[]>([])
  activeProjectId = $state<string | null>(null)
  /** The user's home, for drawing a root the way a shell would write it. */
  home = $state('')

  tasks = $state<Task[]>([])
  /**
   * Tabs of the selected task only, in the order the sidebar draws them.
   * Switching tasks replaces this wholesale.
   */
  tabs = $state<Tab[]>([])
  /** The selected task's folders, read and replaced alongside `tabs`. */
  folders = $state<TabFolder[]>([])
  /**
   * A folder just made, for its row to open its name for editing the moment it
   * is drawn. Taken back by the row once it has.
   */
  renamingFolderId = $state<string | null>(null)
  activeTaskId = $state<string | null>(null)
  ready = $state(false)

  /**
   * Whether the tab sidebar is hidden. Chrome state rather than workspace data,
   * but it is persisted the same way everything else here is, so it lives with
   * the rest of what the window restores on launch.
   */
  sidebarCollapsed = $state(false)

  /** How wide the sidebar is drawn, in CSS pixels. Persisted like the rest. */
  sidebarWidth = $state<number>(SIDEBAR_WIDTH.default)

  /**
   * Whether a resize drag is in flight. The browser surface takes its native
   * view down while one is — see the note there; nothing else cares.
   */
  sidebarResizing = $state(false)

  /**
   * Whether a collapsed sidebar is out because the pointer went looking for it.
   * The dock owns the behaviour; this lives here because the content well has
   * to know, and the two are not on the same branch of the tree.
   */
  sidebarPeeking = $state(false)

  /**
   * Whether the sidebar is out at all, docked or peeking — which is to say
   * whether the content well starts at the window's left edge or inboard of it.
   */
  get sidebarOut(): boolean {
    return !this.sidebarCollapsed || this.sidebarPeeking
  }

  /** Live title/url/loading per tab id, pushed from the native views. */
  pages = $state<Record<string, BrowserViewState>>({})

  /**
   * origin → that site's icon, for the rows drawing a tab that has no page open
   * to ask. A pinned tab restored on launch is the case this exists for: its
   * row is drawn before anything has loaded, and until it is clicked there is
   * no view to report an icon — which is the one moment an icon stops being
   * useful. Filled by `requestSiteIcon`, from what the main process has
   * remembered of every site any tab has ever opened.
   */
  siteIcons = $state<Record<string, string>>({})

  /**
   * Origins already asked about, hit or miss. A miss leaves `siteIcons` empty,
   * so without this the row that asked would ask again on every redraw.
   */
  private siteIconsAsked = new Set<string>()

  /**
   * Downloads still arriving, by the id the main process gave them. Ephemeral,
   * like `pages`: a download either becomes a file on disk or leaves nothing,
   * and neither outcome is worth a row.
   */
  downloads = $state<Record<string, LiveDownload>>({})

  /**
   * downloadId → the tab it is filling, resolved once that tab exists. Held as
   * the promise rather than the id so the end of a download can wait on the
   * start of it: a small file can finish before its tab has finished being
   * written, and awaiting this is what keeps the two in order.
   */
  private downloadTabs = new Map<string, Promise<string | null>>()

  /** View-state writes waiting out their delay, by tab id. */
  private viewStateWrites = new Map<string, ReturnType<typeof setTimeout>>()

  /** The download filling each tab, for the rows and panes that draw its progress. */
  downloadsByTab = $derived.by(() => {
    const byTab: Record<string, LiveDownload> = {}
    for (const download of Object.values(this.downloads)) {
      if (download.tabId) byTab[download.tabId] = download
    }
    return byTab
  })

  /**
   * The selected task's sidebar: its two sections, each a list of tabs and
   * folders, and each folder a list of the same (see `sidebarTree`).
   */
  sidebar = $derived(sidebarTree(this.tabs, this.folders))

  activeProject = $derived(
    this.projects.find((project) => project.id === this.activeProjectId) ?? null
  )

  /**
   * The space every page in this window is browsing in: the active project's.
   *
   * Half of what identifies a session — the profile on the tab is the other
   * half — and so passed to the main process with every view that is opened,
   * every icon that is fetched and every profile that is emptied. Null only
   * before `load` has run, which is the app's own session either way (see
   * src/main/browsing.ts).
   */
  activeSpaceId = $derived(this.activeProject?.spaceId ?? null)

  /** The space's name, for the bar to say which world the project is in. */
  activeSpaceName = $derived(this.activeProject?.spaceName ?? null)

  /**
   * The active project's tabs that have work to report, across every task
   * rather than only the selected one's — which is what the strip needs to
   * give each task a dot. Kept by a watch in App.svelte.
   */
  tabActivity = $state<TabActivityEntry[]>([])

  /**
   * Each task's dot: the strongest of its tabs' (see `strongerActivity`). The
   * tab in front's `done` does not count, for the reason its own row does not
   * draw it — it is cleared the moment it arrives.
   */
  activityByTask = $derived.by(() => {
    const byTask: Record<string, TabActivity> = {}
    for (const { tabId, taskId, activity } of this.tabActivity) {
      if (activity === 'done' && tabId === this.activeTabId) continue
      byTask[taskId] = strongerActivity(byTask[taskId], activity)
    }
    return byTask
  })

  activeTask = $derived(this.tasks.find((task) => task.id === this.activeTaskId) ?? null)
  activeTabId = $derived(this.activeTask?.activeTabId ?? null)
  activeTab = $derived(this.tabs.find((tab) => tab.id === this.activeTabId) ?? null)

  /**
   * The split on screen: the one the tab in front is in, if it is in one.
   * Otherwise that tab has the page area to itself, and the task's splits wait
   * for one of their own tabs to be picked (see `TabSplit`).
   */
  activeSplit = $derived(splitContaining(this.activeTask?.splits ?? [], this.activeTabId) ?? null)

  /**
   * The tabs on screen: the one in front, and the rest of its split when it is
   * in one. What a closed folder keeps in sight (see `sidebarRows`).
   */
  onScreenTabIds = $derived(
    new Set(
      this.activeSplit
        ? tabIdsInSplit(this.activeSplit)
        : this.activeTabId === null
          ? []
          : [this.activeTabId]
    )
  )

  /** tab id → the split it is in, for the rows to wear the mark of it. */
  splitOfTab = $derived.by(() => {
    const byTab: Record<string, TabSplit> = {}
    for (const split of this.activeTask?.splits ?? []) {
      for (const tabId of tabIdsInSplit(split)) byTab[tabId] = split
    }
    return byTab
  })

  /**
   * The split whose rows are lit together because the pointer is over one of
   * them — the way to tell a task's splits apart, since every row in any of
   * them wears the same mark.
   */
  hoveredSplitId = $state<string | null>(null)

  async load(): Promise<void> {
    this.sidebarCollapsed =
      (await (fluid.settings.get({ key: SIDEBAR_COLLAPSED_KEY }) as Promise<boolean | null>)) ??
      false
    // Clamped on the way in as well as on the way out: the stored width was
    // written against whatever the range was at the time.
    const width = await (fluid.settings.get({ key: SIDEBAR_WIDTH_KEY }) as Promise<number | null>)
    if (typeof width === 'number') this.sidebarWidth = clampSidebarWidth(width)

    // The project comes first, because everything below is one project's: the
    // strip is its tasks, and a strip drawn before the project is known would
    // be somebody else's work for a frame.
    this.applyProjects(await api.projects.state())

    this.tasks = await this.listTasks()
    if (this.tasks.length > 0) await this.selectTask(this.tasks[0].id)

    // A notification clicked while the app had no window is what made this one,
    // and the main process has been holding the request for whichever window
    // turned up. Asked for here rather than listened for, because the push it
    // would otherwise arrive on went out long before this window could hear it.
    const pending = await api.notifications.takePendingOpenTask()
    if (pending) await this.revealTask(pending)

    this.ready = true
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed
    void fluid.settings.set({ key: SIDEBAR_COLLAPSED_KEY, value: this.sidebarCollapsed })
  }

  /**
   * A width the resize handle is still dragging towards. Nothing is written
   * yet — a pointer move is not a decision, and there are a few hundred of them
   * in a drag.
   */
  resizeSidebar(width: number): void {
    this.sidebarResizing = true
    this.sidebarWidth = clampSidebarWidth(width)
  }

  /** The width to keep, once the drag ends. */
  endSidebarResize(width: number): void {
    this.sidebarResizing = false
    this.sidebarWidth = clampSidebarWidth(width)
    void fluid.settings.set({ key: SIDEBAR_WIDTH_KEY, value: this.sidebarWidth })
  }

  /** The open tasks of whichever project the app is in. */
  private async listTasks(): Promise<Task[]> {
    const projectId = this.activeProjectId
    return projectId === null ? [] : fluid.tasks.list({ projectId: projectId, status: 'open' })
  }

  /**
   * Takes in the projects as the main process has them. Only the list and the
   * selection: which tasks that means is worked out from there, and by whoever
   * called this — `load` and `selectProject` both go on to fetch the strip.
   */
  private applyProjects(state: ProjectsState): void {
    this.projects = state.projects
    this.activeProjectId = state.activeId
    this.home = state.home
  }

  /**
   * Moves the app to a project: a new strip of tasks, and a new folder for
   * everything opened from here on.
   *
   * The strip is fetched before anything moves, for the reason `selectTask`
   * fetches tabs first — the two fields are read together by everything that
   * draws, and a moment where they disagree is a frame of one project's tasks
   * under another project's name.
   */
  async selectProject(id: string): Promise<void> {
    if (id === this.activeProjectId) return

    // Held while the switch is under way: the API announces the move, and the
    // announcement arriving mid-switch must not start a second one.
    this.switchingTo = id
    try {
      await this.switchProject(id)
    } finally {
      this.switchingTo = null
    }
  }

  /** The project a switch is on its way to, while one is. See `selectProject`. */
  private switchingTo: string | null = null

  private async switchProject(id: string): Promise<void> {
    await fluid.projects.setActive({ id })

    // Both answers before either is written down, for the reason `selectTask`
    // fetches tabs before it moves: the bar is drawn from one and the strip
    // from the other, and an await between the two writes is a frame of the new
    // project's name over the old project's tasks.
    //
    // The whole state rather than just the id, because the project may have been
    // made a moment ago in the picker — the list this side is holding does not
    // have it yet, and the bar would draw a nameless project.
    const [state, tasks] = await Promise.all([
      api.projects.state(),
      fluid.tasks.list({ projectId: id, status: 'open' })
    ])

    this.applyProjects(state)
    this.tasks = tasks
    this.activeTaskId = null
    this.tabs = []
    this.folders = []

    if (tasks.length > 0) await this.selectTask(tasks[0].id)
  }

  /**
   * Answers the projects themselves having changed — a rename, a folder moved,
   * a project deleted, or the app moved to another one by somebody other than
   * this window (an extension, the picker).
   *
   * A rename or a repoint is only the bar redrawing. A deletion may be the
   * project the app is in, and a move is a move: the main process has already
   * settled on where the app is, and this follows it there.
   */
  async applyProjectsChanged(state: ProjectsState): Promise<void> {
    if (this.switchingTo !== null) return
    const left = this.activeProjectId
    this.applyProjects(state)

    if (state.activeId === null || state.activeId === left) return

    // Nothing to tear down: a deleted project's tabs were stopped by the main
    // process when their rows went (see src/main/api/teardown.ts), and a
    // project merely moved away from keeps running in the background.
    const tasks = await this.listTasks()
    this.activeTaskId = null
    this.tabs = []
    this.folders = []
    this.tasks = tasks
    if (tasks.length > 0) await this.selectTask(tasks[0].id)
  }

  /**
   * Selects a task. The tabs are fetched before either field moves, so the two
   * never disagree: `activeTabId` derives from the task, and anything watching
   * it — the native view placement above all — would otherwise wake up during
   * the await with the new task's tab id and the old task's tab list, find no
   * match, and hide the page with nothing left to bring it back.
   */
  async selectTask(id: string): Promise<void> {
    const [tabs, folders] = await Promise.all([
      fluid.tabs.list({ taskId: id }),
      fluid.folders.list({ taskId: id })
    ])
    this.activeTaskId = id
    this.tabs = tabs
    this.folders = folders
  }

  /**
   * Answers a keyboard shortcut that asked to be somewhere else in the
   * workspace — Cmd+1..9, or one of the Cmd+Option+arrow chords. It arrives from
   * the main process rather than a key listener here, because a browser tab's
   * native view holds the keyboard whenever a page is in front (see
   * src/main/menu.ts); this end only has to say what each move means.
   */
  async navigate(navigation: ShortcutNavigation): Promise<void> {
    if (navigation.kind === 'task-index') {
      // Nothing for a number past the end of the strip. Closing in on the
      // nearest task instead would make the same key land somewhere different
      // depending on how many tasks happen to be open.
      const task = this.tasks[navigation.index]
      if (task && task.id !== this.activeTaskId) await this.selectTask(task.id)
      return
    }

    if (navigation.kind === 'task-step') {
      const task = stepThrough(this.tasks, this.activeTaskId, navigation.delta)
      if (task) await this.selectTask(task.id)
      return
    }

    // The rows as they are drawn, so stepping is stepping down the column —
    // over what a closed folder is hiding, the way the eye would.
    const tab = stepThrough(
      visibleTabs(this.sidebar, this.onScreenTabIds),
      this.activeTabId,
      navigation.delta
    )
    if (tab) await this.selectTab(tab.id)
  }

  /**
   * Appends a task to the active project's strip and moves to it. Blank unless
   * told otherwise; the new-task panel hands over a template (see
   * `NewTaskTemplate` in the SDK) for a named task, or for one an extension
   * describes — its type, its facts, and the tabs it starts with.
   */
  async createTask(template: NewTaskTemplate = {}): Promise<string | null> {
    const projectId = this.activeProjectId
    // Only while the app has no project at all, which is only before `load` has
    // run: the picker refuses to delete the last one, so there is always one
    // afterwards.
    if (!projectId) return null

    const task = await fluid.tasks.create({
      projectId,
      title: template.title?.trim() || NEW_TASK_TITLE,
      type: template.type ?? null,
      icon: template.icon,
      color: template.color,
      facts: template.facts ?? null
    })
    // The main process announces the task before it answers the call, so
    // `applyEvent` has usually put it in the strip already. A second copy would
    // be a duplicate key in the strip's keyed `each`, which takes the strip down.
    if (!this.hasTask(task.id)) this.tasks = [...this.tasks, task]
    this.activeTaskId = task.id
    this.tabs = []

    const tabs = template.tabs ?? []
    if (tabs.length === 0) return task.id

    // One at a time, so the strip's order is the template's. The first is the
    // one the task opens on.
    const opened: Tab[] = []
    for (const tab of tabs) opened.push(await fluid.tabs.open({ taskId: task.id, tab }))

    // Moved away while they opened: they still belong to this task, and will be
    // there when it is next selected.
    if (this.activeTaskId !== task.id) return task.id
    this.addTabs(opened)
    await this.selectTab(opened[0].id)
    return task.id
  }

  /**
   * The task a new tab goes into: the selected one, or a fresh one when the
   * strip is empty. Opening something with no task selected is still a request
   * to open it, and a tab has to belong to a task.
   */
  private async taskForNewTab(): Promise<string | null> {
    return this.activeTaskId ?? (await this.createTask())
  }

  /**
   * Opens a task the user asked for from outside the window — by clicking the
   * notification that announced it, which is the only way in so far. The window
   * is already in front by the time this runs; what is left is going to the
   * work it was about.
   *
   * The task is not always in the strip yet. A routine announces each task as
   * it opens it but tells the window only once its whole pass is over, and a
   * pass is eight channels of network apart — plenty of time to click a banner.
   * So it is fetched when it is not already here, and one that has been settled
   * or deleted in the meantime is left alone: the click asked for work that is
   * over with.
   */
  async revealTask({ taskId, tabId }: TaskFocus): Promise<void> {
    if (!this.tasks.some((task) => task.id === taskId)) {
      const task = await fluid.tasks.get({ id: taskId })
      if (!task || task.status !== 'open') return

      // It may not be in this project at all — a routine files into the first
      // project whichever one the user is in, and the banner it posted is still
      // a request to go and look at it. Switching first is what makes the strip
      // the one this task is actually part of.
      // Checked again after each await, not just before them: an event can put
      // the task in the strip while either one is out (see `createTask`).
      if (task.projectId !== this.activeProjectId) await this.selectProject(task.projectId)
      if (!this.hasTask(taskId)) this.tasks = [...this.tasks, task]
    }

    await this.selectTask(taskId)

    // Only when it is still there: a pinned tab can be closed like any other,
    // and `setActive` refuses a tab the task does not own.
    if (tabId !== null && this.tabs.some((tab) => tab.id === tabId)) {
      await this.selectTab(tabId)
    }
  }

  async renameTask(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    const updated = await fluid.tasks.update({ id: id, title: trimmed === '' ? null : trimmed })
    if (updated) this.replaceTask(updated)
  }

  /**
   * Commits a drag-reordered task strip. `orderedIds` covers the open tasks —
   * the only ones the strip shows — and the write's own result replaces the
   * local copy, so the two cannot drift.
   */
  async reorderTasks(orderedIds: string[]): Promise<void> {
    const projectId = this.activeProjectId
    if (!projectId) return
    this.tasks = await fluid.tasks.reorder({ projectId, ids: orderedIds })
  }

  /**
   * Takes tasks out of the strip, and moves the selection off them if it was on
   * one: to the neighbour on the right, then the left, the same rule the tab
   * strip inside a task follows. An empty strip is left empty.
   */
  private async dropTasks(ids: string[]): Promise<void> {
    const gone = new Set(ids)
    const before = this.tasks
    this.tasks = before.filter((task) => !gone.has(task.id))

    const selected = this.activeTaskId
    if (selected === null || !gone.has(selected)) return

    const index = before.findIndex((task) => task.id === selected)
    const next =
      before.slice(index + 1).find((task) => !gone.has(task.id)) ??
      before
        .slice(0, index)
        .reverse()
        .find((task) => !gone.has(task.id))
    if (next) {
      await this.selectTask(next.id)
    } else {
      this.activeTaskId = null
      this.tabs = []
      this.folders = []
    }
  }

  /**
   * Deletes a task and everything under it.
   */
  async closeTask(id: string): Promise<void> {
    // What the tabs were running, the files they held and the task's clipboard
    // history all go in the main process (see src/main/api/teardown.ts). What
    // is left here is this window's own: a download still filling a tab.
    for (const tab of await fluid.tabs.list({ taskId: id })) {
      if (tab.type === 'file') this.cancelDownloadFor(tab.id)
    }
    await fluid.tasks.delete({ id })
    await this.dropTasks([id])
  }

  /**
   * Opens a browser tab. `profile` is which login it runs as — see
   * src/main/profiles.ts — and null, the default, is the app's own session,
   * which is what nearly every tab wants.
   */
  async createBrowserTab(
    url: string = DEFAULT_BROWSER_URL,
    profile: number | null = null
  ): Promise<void> {
    const taskId = await this.taskForNewTab()
    if (!taskId) return

    const tab = await fluid.tabs.open({
      taskId: taskId,
      tab: {
        type: 'browser',
        title: null,
        payload: { url },
        profile
      }
    })
    this.addTabs([tab])
    await this.selectTab(tab.id)
  }

  /**
   * Opens the tab's page again in another profile, and closes the tab it came
   * from. Reopening rather than switching because a view's partition is fixed
   * when it is created: there is no way to move a running page from one login
   * to another, and pretending otherwise would be a toggle that silently
   * reloads.
   *
   * What carries over is the address the tab is on now, not the one it was
   * opened with — reopening a page you navigated to should land on that page.
   * Scroll position and anything typed into the page do not survive, which is
   * why the affordance is worded as reopening.
   */
  async reopenInProfile(tabId: string, profile: number | null): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.type !== 'browser' || tab.profile === profile) return

    const url = this.pages[tab.id]?.url || tab.payload.url
    // The sidebar as it stands, with the tab still in it, which is what the
    // replacement is put back into.
    const before = sidebarItems(this.sidebar)

    const replacement = await fluid.tabs.open({
      taskId: tab.taskId,
      tab: {
        type: 'browser',
        title: null,
        payload: { url },
        pinned: tab.pinned,
        pinnedUrl: tab.pinnedUrl,
        profile
      }
    })

    // Re-reads the strip from the database, which by now holds the replacement
    // at the end of its section and no longer holds the tab it replaces.
    await this.closeTab(tabId)

    // Back where the old tab was — the same folder, the same slot — rather than
    // at the end of the strip: this is the same tab as far as the user is
    // concerned, and a row that jumps to the bottom reads as a different one.
    await this.arrangeSidebar(
      before.map((item) => (item.id === tabId ? { ...item, id: replacement.id } : item))
    )
    await this.selectTab(replacement.id)
  }

  /**
   * Opens a second tab on the page a browser tab is showing, in the same
   * profile, directly below it, and goes to it. Like `reopenInProfile`, it is
   * the address the tab is on now that carries over, not its history.
   *
   * Never pinned, even when the original is: a pinned row stands for one
   * address in the task, and two rows pinned to the same one would leave links
   * to it with no single place to go (see `openLink`). A copy of a pinned tab
   * lands at the top of the loose tabs instead.
   */
  async duplicateTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.type !== 'browser') return

    const url = this.pages[tab.id]?.url || tab.payload.url
    const copy = await fluid.tabs.open({
      taskId: tab.taskId,
      tab: { type: 'browser', title: null, payload: { url }, profile: tab.profile }
    })

    // Read after the open, so the copy is a row the sidebar already knows.
    this.addTabs([copy])
    const rest = sidebarItems(this.sidebar).filter((item) => item.id !== copy.id)
    const at = tab.pinned
      ? rest.findIndex((item) => !item.pinned)
      : rest.findIndex((item) => item.id === tab.id) + 1
    const place: SidebarItem = tab.pinned
      ? { kind: 'tab', id: copy.id, parentId: null, pinned: false }
      : { kind: 'tab', id: copy.id, parentId: tab.folderId, pinned: false }
    const slot = at === -1 ? rest.length : at
    await this.arrangeSidebar([...rest.slice(0, slot), place, ...rest.slice(slot)])
    await this.selectTab(copy.id)
  }

  /**
   * Moves a tab to another of the project's tasks, from its row's menu, and
   * goes with it.
   *
   * Always as a loose tab at the foot of the new strip, even when it was pinned
   * here: a pin says the address belongs to this task, and a tab moved out of
   * it has been judged to belong to another. `tabs.move` alone keeps the section
   * (see `moveTab` in src/main/db/tabs.ts), so the pin comes off first.
   *
   * The window follows whichever tab it was. `applyEvent` already follows the
   * one on screen; a tab moved from further down the column is one the user
   * just asked for by name, and landing them anywhere else would leave them to
   * go and find it.
   */
  async moveTabToTask(tabId: string, taskId: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.taskId === taskId) return

    if (tab.pinned) await fluid.tabs.setPinned({ id: tabId, pinned: false })
    await fluid.tabs.move({ id: tabId, taskId })
    await this.revealTask({ taskId, tabId })
  }

  /**
   * Floats a tab in a window of its own, the way Cmd+Shift+P floats the one on
   * screen. The tab is selected first, as it would be for the shortcut: its
   * page may not have been opened yet, and selecting it is what opens it —
   * the tick lets the pane ask for the view before the float asks for it.
   */
  async floatTab(tabId: string): Promise<void> {
    if (this.activeTabId !== tabId) {
      await this.selectTab(tabId)
      await tick()
    }
    api.browser.popOut(tabId)
  }

  /**
   * Empties a profile in this space, if the user confirms when the main process
   * asks. The tabs running in it are reloaded by the main process and come back
   * signed out; nothing here has to change, because a profile is not part of
   * what the database holds.
   *
   * This space's copy of the profile and no other: a profile is a session
   * within a space, and emptying the red profile here has no business signing
   * anyone out of the red profile somewhere else.
   */
  async resetProfile(profile: number): Promise<void> {
    await api.profiles.reset(this.activeSpaceId, profile)
  }

  /**
   * Opens a tab an extension's launcher entry described (see `LauncherEntry` in
   * the SDK), in the selected task.
   */
  async openExtensionTab(tab: NewTab): Promise<void> {
    const taskId = await this.taskForNewTab()
    if (!taskId) return

    const opened = await fluid.tabs.open({ taskId, tab })

    // The launcher may have been left open long enough for the selected task
    // to change; the tab still belongs where it was made.
    if (this.activeTaskId !== taskId) return
    this.addTabs([opened])
    await this.selectTab(opened.id)
  }

  /**
   * Opens a tab a page asked for, with `window.open` or a `target=_blank`
   * link. It joins the task the asking page belongs to, which is not
   * necessarily the one on screen — views keep running while their task is in
   * the background — and it only takes focus if it is.
   *
   * It also joins the asking page's browsing profile, which is what keeps a
   * signed-in session coherent as you follow links out of it: a link opened
   * from a page in the red profile is still the red profile's, without anybody
   * being asked again.
   */
  async openRequestedTab({ sourceTabId, url, background, profile }: OpenTabRequest): Promise<void> {
    // The tab, not the local list: the page that asked may belong to a task
    // other than the selected one, and `this.tabs` only holds that one's tabs.
    const source = await fluid.tabs.get({ id: sourceTabId })
    if (!source) return

    // The rest of that task's tabs, which are only to hand when it is the
    // selected one. A page the task already has a pinned row for is that row's,
    // however the link to it was followed — see `openLink`.
    const siblings =
      source.taskId === this.activeTaskId
        ? this.tabs
        : await fluid.tabs.list({ taskId: source.taskId })
    const pinned = siblings.find((tab) => pinnedTo(tab, url, profile))
    if (pinned) {
      await this.revealPinnedTab(pinned, url, background)
      return
    }

    const tab = await fluid.tabs.open({
      taskId: source.taskId,
      tab: {
        type: 'browser',
        title: null,
        payload: { url },
        // Decided in the main process, which knows the profile of the page that
        // asked: either inherited from it, or named outright when the link was
        // opened from its own menu.
        profile
      }
    })

    if (this.activeTaskId !== source.taskId) return
    this.addTabs([tab])
    // Cmd-click and middle-click ask for the tab without asking to go to it.
    if (!background) await this.selectTab(tab.id)
  }

  /**
   * Opens a link followed from inside one of the selected task's tabs — out of
   * an extension's view, out of a shell's output — in a tab of its own.
   *
   * Unless the task already has one. The same few addresses turn up over and
   * over inside a task, because they are what the task is about: the message
   * that opened it names the ticket, the ticket names its pull requests, and
   * each of those may have arrived as a pinned tab of its own, opened by an
   * extension. Following one of those links is
   * asking for that page, and the task already has a row for that page — so it
   * goes there, rather than opening a second tab on it that the pinned one
   * then sits next to.
   */
  async openLink(url: string): Promise<void> {
    const pinned = this.tabs.find((tab) => pinnedTo(tab, url, null))
    if (pinned) {
      await this.revealPinnedTab(pinned, url, false)
      return
    }
    await this.createBrowserTab(url)
  }

  /**
   * Goes to the pinned tab a followed link turned out to be about.
   *
   * A pinned tab that has wandered off is sent to the page that was clicked;
   * one already showing that page is left exactly as it is. "Already showing
   * it" is the loose sense `covers` means, deliberately: a pull request open
   * at its Files tab with half a review written in it is showing the pull
   * request, and reloading it onto the bare address in the link would throw
   * that away to arrive somewhere the user can already see.
   */
  private async revealPinnedTab(tab: Tab, url: string, background: boolean): Promise<void> {
    // Only a browser tab has anywhere to be sent: a pinned thread is the one
    // thread it was opened on, and so is always already there — the same
    // reason `onPinnedPage` answers true for it.
    if (tab.type === 'browser') {
      const current = this.pages[tab.id]?.url || tab.payload.url
      if (!samePage(current, url)) {
        // The payload as well as the live view, because a pinned tab whose page
        // has been closed has no view to navigate and the payload is what its
        // next one opens on. The stored title and icon go with the page being
        // left, exactly as they do in `releasePinnedTab`.
        const payload: BrowserTabPayload = { url }
        tab.payload = payload
        api.browser.navigate(tab.id, url)
        await fluid.tabs.update({ id: tab.id, payload })
      }
    }

    // Cmd-click and middle-click ask for the page without asking to go to it.
    // `setActive` rather than `selectTab`: the link was followed in whichever
    // task owns the tab, and that is not always the selected one.
    if (background) return
    const task = await fluid.tasks.setActiveTab({ id: tab.taskId, tabId: tab.id })
    if (task) this.replaceTask(task)
  }

  /**
   * Imports dropped files and opens a tab for each, in the order they were
   * dropped. The copy happens before any tab exists, so a file that cannot be
   * read leaves nothing behind; the rest still open.
   */
  async createFileTabs(files: File[]): Promise<void> {
    if (files.length === 0) return
    const taskId = await this.taskForNewTab()
    if (!taskId) return

    const paths = files.map((file) => api.files.pathFor(file)).filter((path) => path !== '')
    if (paths.length === 0) return

    const stored = await api.files.import(paths)

    const created: Tab[] = []
    for (const file of stored) {
      created.push(
        await fluid.tabs.open({
          taskId: taskId,
          tab: { type: 'file', title: null, payload: fileTabPayload(file) }
        })
      )
    }

    // The drop may have landed on a task that is no longer the selected one.
    if (this.activeTaskId !== taskId) return
    this.addTabs(created)

    const last = created.at(-1)
    if (last) await this.selectTab(last.id)
  }

  /**
   * A page's download, from the moment it starts to the moment it stops.
   * Downloads do not go to the user's Downloads folder — they land in the app's
   * store (see src/main/downloads.ts) — and each gets a file tab as soon as it
   * begins rather than when it ends, so the task shows it arriving.
   *
   * The tab belongs to whichever task the page that asked for it belongs to,
   * which is not necessarily the task on screen: views keep running while their
   * task is in the background.
   */
  handleDownload(event: DownloadEvent): void {
    if (event.phase === 'started') {
      this.startDownload(event)
    } else if (event.phase === 'progress') {
      this.updateDownload(event)
    } else {
      void this.finishDownload(event)
    }
  }

  private startDownload(start: DownloadStarted): void {
    this.downloads[start.downloadId] = {
      downloadId: start.downloadId,
      receivedBytes: 0,
      totalBytes: start.totalBytes,
      paused: false,
      tabId: null
    }
    this.downloadTabs.set(start.downloadId, this.openDownloadTab(start))
  }

  /**
   * Opens the tab a download will fill. Resolves to its id, or to null when
   * there was nowhere to put it.
   */
  private async openDownloadTab(start: DownloadStarted): Promise<string | null> {
    // The tab, not the local list: the download's task may not be the selected
    // one, and `this.tabs` only ever holds the selected task's tabs.
    const source = await fluid.tabs.get({ id: start.sourceTabId })
    if (!source) return null

    // The payload is the server's word for the file — a size it promised and a
    // type read off the name. `finishDownload` replaces it with what arrived.
    const tab = await fluid.tabs.open({
      taskId: source.taskId,
      tab: {
        type: 'file',
        title: null,
        payload: fileTabPayload(start.file)
      }
    })

    const download = this.downloads[start.downloadId]
    if (download) download.tabId = tab.id

    // The row joins the strip, but focus stays where the user left it: they
    // asked for a file, not for the page they were reading to be taken away.
    // The bar on the row is what says the download is happening.
    if (this.activeTaskId === source.taskId) this.addTabs([tab])
    return tab.id
  }

  private updateDownload(progress: DownloadProgress): void {
    const download = this.downloads[progress.downloadId]
    // Gone already: the tab holding it was closed, which called the download
    // off, and a last update can still be in flight behind that.
    if (!download) return

    download.receivedBytes = progress.receivedBytes
    download.totalBytes = progress.totalBytes
    download.paused = progress.paused
  }

  private async finishDownload({ downloadId, file }: DownloadFinished): Promise<void> {
    const opening = this.downloadTabs.get(downloadId)
    this.downloadTabs.delete(downloadId)
    delete this.downloads[downloadId]

    // Nothing was ever opened for it, or the tab that was has since been closed
    // — which is what called the download off in the first place.
    const tabId = opening ? await opening : null
    if (tabId === null) {
      if (file) void api.files.remove(file.storageKey)
      return
    }

    // Cancelled, interrupted, or failed. The store has already dropped what
    // arrived, so the tab points at nothing and goes with it.
    if (!file) {
      await this.discardTab(tabId)
      return
    }

    // The real size, type and preview, none of which were knowable until the
    // bytes stopped.
    const payload = fileTabPayload(file)
    await fluid.tabs.update({ id: tabId, payload })
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.type === 'file') tab.payload = payload
  }

  /**
   * Stops the download filling a tab, if one is. Called on the way to closing
   * that tab, since the tab is the only thing the file was being fetched for.
   */
  private cancelDownloadFor(tabId: string): void {
    const download = this.downloadsByTab[tabId]
    if (!download) return
    api.files.cancelDownload(download.downloadId)
    this.downloadTabs.delete(download.downloadId)
    delete this.downloads[download.downloadId]
  }

  async selectTab(id: string): Promise<void> {
    const taskId = this.activeTaskId
    if (!taskId) return
    const updated = await fluid.tasks.setActiveTab({ id: taskId, tabId: id })
    if (updated) this.replaceTask(updated)
  }

  /**
   * Records how the user has left a tab looking. The local copy moves at once —
   * it is what the pane is drawing — while the write is held back until the
   * gesture stops, so a pan costs one row update rather than one per frame.
   *
   * Every tab kind with something to remember goes through here, an
   * extension's included; the shape of what it remembers is its own business.
   */
  setViewState(tabId: string, viewState: unknown): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    // Each kind's view state is its own shape, discriminated by the tab's type
    // rather than by a field; whoever calls this is the one that knows it.
    if (tab) (tab as { viewState: unknown }).viewState = viewState

    clearTimeout(this.viewStateWrites.get(tabId))
    this.viewStateWrites.set(
      tabId,
      setTimeout(() => {
        this.viewStateWrites.delete(tabId)
        void fluid.tabs.update({ id: tabId, viewState })
      }, VIEW_STATE_WRITE_DELAY_MS)
    )
  }

  /**
   * Writes a tab's pending view state now. Called when a pane is torn down —
   * switching tabs or closing one — so the last gesture before leaving is not
   * the one that gets lost.
   */
  flushViewState(tabId: string): void {
    if (!this.viewStateWrites.has(tabId)) return
    clearTimeout(this.viewStateWrites.get(tabId))
    this.viewStateWrites.delete(tabId)

    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (tab) void fluid.tabs.update({ id: tabId, viewState: tab.viewState })
  }

  /**
   * Writes the selected task's sidebar whole (see `tabs.arrange`): what a drag
   * in it ends with, and what puts a tab opened in place of another back where
   * that one was. A tab or folder that crossed the divider is pinned or
   * unpinned by the write, along with everything in the folder.
   *
   * What is drawn afterwards is what the write answers, never what was asked
   * for: a tab closed from under the drag is simply missing from it, and a row
   * the write would not move stays where it is recorded as being.
   */
  async arrangeSidebar(items: SidebarItem[]): Promise<void> {
    const taskId = this.activeTaskId
    if (!taskId) return
    const arranged = await fluid.tabs.arrange({ taskId, items })
    if (this.activeTaskId !== taskId) return
    this.tabs = arranged.tabs
    this.folders = arranged.folders
  }

  /**
   * Makes a folder at the end of a section of the selected task's sidebar, or
   * at the end of another folder — which opens, so the new one can be seen —
   * and opens its name for editing.
   */
  async createFolder(place: { pinned: boolean; parentId: string | null }): Promise<void> {
    const taskId = this.activeTaskId
    if (!taskId) return
    const parent = place.parentId && this.folders.find((folder) => folder.id === place.parentId)
    if (parent && parent.collapsed) await this.setFolderCollapsed(parent.id, false)

    const folder = await fluid.folders.create({
      taskId,
      parentId: place.parentId,
      pinned: place.pinned
    })
    if (this.activeTaskId !== taskId) return
    if (!this.folders.some((candidate) => candidate.id === folder.id)) {
      this.folders = [...this.folders, folder]
    }
    this.renamingFolderId = folder.id
  }

  /** Renames a folder. A blank name is no name at all, and keeps the one it had. */
  async renameFolder(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    const folder = this.folders.find((candidate) => candidate.id === id)
    if (!folder || trimmed === '' || trimmed === folder.name) return
    folder.name = trimmed
    this.patchFolder(await fluid.folders.update({ id, name: trimmed }))
  }

  /**
   * Opens or closes a folder. The row moves at once, since it is what was
   * clicked; the write follows, and whatever it answers is what stays.
   */
  async setFolderCollapsed(id: string, collapsed: boolean): Promise<void> {
    const folder = this.folders.find((candidate) => candidate.id === id)
    if (!folder || folder.collapsed === collapsed) return
    folder.collapsed = collapsed
    this.patchFolder(await fluid.folders.update({ id, collapsed }))
  }

  /**
   * Deletes a folder, and the folders in it, closing every tab they hold. What
   * those tabs ran and held is let go of in the main process, as it is for any
   * closed tab; what is left here is this window's own — a download filling
   * one of them.
   */
  async deleteFolder(id: string): Promise<void> {
    const taskId = this.activeTaskId
    if (!taskId) return
    const doomed = new Set(folderSubtree(this.folders, id).map((folder) => folder.id))
    for (const tab of this.tabs) {
      if (tab.folderId !== null && doomed.has(tab.folderId)) this.forgetTab(tab.id)
    }

    await fluid.folders.delete({ id })
    if (this.activeTaskId !== taskId) return
    const [tabs, folders, task] = await Promise.all([
      fluid.tabs.list({ taskId }),
      fluid.folders.list({ taskId }),
      fluid.tasks.get({ id: taskId })
    ])
    this.tabs = tabs
    this.folders = folders
    if (task) this.replaceTask(task)
  }

  /**
   * Moves a folder, and everything in it, to another of the project's tasks —
   * unpinned, at the foot of its tabs — and goes with it, the way a tab moved
   * the same way does (see `moveTabToTask`).
   */
  async moveFolderToTask(id: string, taskId: string): Promise<void> {
    const folder = this.folders.find((candidate) => candidate.id === id)
    if (!folder || folder.taskId === taskId) return
    await fluid.folders.move({ id, taskId })
    await this.revealTask({ taskId, tabId: null })
  }

  private patchFolder(updated: TabFolder): void {
    const index = this.folders.findIndex((folder) => folder.id === updated.id)
    if (index !== -1) this.folders[index] = updated
  }

  async closeTab(id: string): Promise<void> {
    await this.discardTab(id)
  }

  /**
   * Draws a tab beside another, on the edge it was dropped on — making a split
   * of the two, or adding it to the split the other is in (see `placeBeside`
   * for which way it goes) — and brings it forward, in one write.
   */
  async splitTab(tabId: string, targetId: string, edge: SplitEdge): Promise<void> {
    const task = this.activeTask
    if (!task || tabId === targetId) return
    const owned = (id: string): boolean => this.tabs.some((tab) => tab.id === id)
    if (!owned(tabId) || !owned(targetId)) return

    await this.writeSplits(task, placeBeside(task.splits, tabId, targetId, edge), tabId)
  }

  /**
   * The same for a tab dropped on an outer edge of the split on screen: a row
   * the width of the whole split, or a column its whole height (see
   * `placeAlongside`). `anchorId` is any tab of that split.
   */
  async splitAlongside(tabId: string, anchorId: string, edge: SplitEdge): Promise<void> {
    const task = this.activeTask
    if (!task || !this.tabs.some((tab) => tab.id === tabId)) return
    await this.writeSplits(task, placeAlongside(task.splits, tabId, anchorId, edge), tabId)
  }

  /**
   * Writes a task's splits, and the tab it is on when that moves with them.
   * The local copy moves first: the surface is laid out from it, and a drop or
   * a divider that took a round trip to show up would look like it had not
   * landed.
   *
   * What is sent is a snapshot. New splits are built out of the task's own,
   * which are reactive state, and whatever part of them an edit left alone is
   * still one of state's proxies — which cannot be copied across to the main
   * process. The call throws, nothing is written, and the next re-read of the
   * task puts the splits back as they were.
   */
  private async writeSplits(task: Task, splits: TabSplit[], activeTabId?: string): Promise<void> {
    this.replaceTask({ ...task, splits, activeTabId: activeTabId ?? task.activeTabId })
    this.replaceTask(
      await fluid.tasks.setSplits({ id: task.id, splits: $state.snapshot(splits), activeTabId })
    )
  }

  /**
   * Takes a tab out of its split — from its pane's bar, or its row's menu. It
   * stays where it is in the sidebar; what it leaves is the view. The rest of
   * the split closes up over its room and stays on screen, so a pane taken out
   * of the split in front goes the way a closed one would: if it was the pane
   * being worked in, the one beside it takes over (the same neighbour the main
   * process hands a closed tab's focus to — see `settleSplits`), and a split
   * down to one tab leaves that tab with the page area to itself.
   */
  async removeFromSplit(tabId: string): Promise<void> {
    const task = this.activeTask
    const leaving = task && leavingSplit(task, tabId)
    if (task && leaving) await this.writeSplits(task, leaving.splits, leaving.activeTabId)
  }

  /**
   * A divider being dragged. Only the local copy moves — a pointer move is not
   * a decision — and `endSplitResize` writes where it was let go.
   */
  resizeSplit(divider: SplitDivider, share: number): void {
    const task = this.activeTask
    if (task) this.replaceTask({ ...task, splits: moveDivider(task.splits, divider, share) })
  }

  async endSplitResize(divider: SplitDivider, share: number): Promise<void> {
    const task = this.activeTask
    if (!task) return
    await this.writeSplits(task, moveDivider(task.splits, divider, share))
  }

  /**
   * The user clicked into one of the pages on screen, which the main process
   * reports because this document never sees the click. In a split that is
   * moving to that pane's tab; alone, it is the tab already in front, and
   * selecting it again writes nothing.
   */
  async focusPane(tabId: string): Promise<void> {
    if (tabId === this.activeTabId || !this.tabs.some((tab) => tab.id === tabId)) return
    await this.selectTab(tabId)
  }

  /**
   * Closes a tab in whichever task holds it, on screen or not.
   *
   * The tab's own resources outlive its row unless they are torn down here: a
   * native view keeps running, and a dropped file's copy keeps its bytes.
   *
   * The owning task is read off the tab rather than assumed to be the selected
   * one, which is what lets the three callers share this: the user's own close,
   * a download that failed and left a tab pointing at nothing, and a tool
   * closing a tab in a task nobody is looking at (an extension acting through
   * the API).
   */
  private async discardTab(id: string): Promise<void> {
    // Read rather than found locally: `tabs` holds the selected task's strip
    // alone, and the tab being closed need not be in it.
    const closing = await fluid.tabs.get({ id: id })

    clearTimeout(this.viewStateWrites.get(id))
    this.viewStateWrites.delete(id)
    this.cancelDownloadFor(id)
    // Whatever the tab was running, and any file it held, is let go of in the
    // main process once the tab is closed (see src/main/api/teardown.ts).
    await fluid.tabs.close({ id })

    // A tab whose row had already gone leaves nothing to redraw.
    if (!closing) return

    // `tabs:close` also moves the task's active tab, so both have to be re-read
    // — the strip only when the task holding it is the one on screen.
    if (closing.taskId === this.activeTaskId)
      this.tabs = await fluid.tabs.list({ taskId: closing.taskId })
    const task = await fluid.tasks.get({ id: closing.taskId })
    if (task) this.replaceTask(task)

    delete this.pages[id]
  }

  /**
   * Whether a pinned tab is still showing the page it is pinned to. False for
   * any tab that is not pinned, which have nowhere to have wandered from.
   *
   * This is what the row's close affordance reads: a pinned tab at home offers
   * to be removed, and one that has wandered offers to be sent back instead.
   */
  onPinnedPage(tab: Tab): boolean {
    if (!tab.pinned) return false
    // Every other kind is the one thing it was opened as for as long as it
    // exists — a thread cannot be navigated within, a shell is where it is —
    // so there is nowhere for any of them to have wandered to. Always at home,
    // which is what gives their rows an ordinary close. A browser tab with no
    // address is in the same position, though it takes a failed pin to make
    // one.
    if (tab.type !== 'browser' || tab.pinnedUrl === null) return true
    // The live view is the authority; the payload covers the stretch before a
    // tab's first load reports back, and a tab that has never been opened.
    return covers(tab.pinnedUrl, this.pages[tab.id]?.url || tab.payload.url)
  }

  /**
   * Closes a pinned tab without unpinning it. The page is torn down and the row
   * goes back to pointing at the address it is pinned to, so clicking it again
   * opens the pinned page fresh rather than wherever the tab had got to.
   *
   * This is the whole of what pinning buys over an ordinary tab, and it is why
   * the row offers this instead of a close once it has wandered: the tab you
   * would be throwing away is the one thing the task was opened for.
   */
  async releasePinnedTab(id: string): Promise<void> {
    const taskId = this.activeTaskId
    const tab = this.tabs.find((candidate) => candidate.id === id)
    // Only a browser tab can be released: this undoes a wander, and nothing
    // else that can be pinned is able to wander. The row never offers it for
    // anything else (see `onPinnedPage`), so this is the belt to that braces.
    if (!taskId || tab?.type !== 'browser' || tab.pinnedUrl === null) return

    api.browser.destroy(id)
    delete this.pages[id]

    // The stored title and icon go with the page: they describe wherever the
    // tab wandered to, not the page it is about to open on. What the row falls
    // back to is the tab's own title, which pinned tabs are given.
    const payload: BrowserTabPayload = { url: tab.pinnedUrl }
    tab.payload = payload
    await fluid.tabs.update({ id: id, payload })

    // A closed tab is not the one you are looking at, so focus leaves it the
    // way it leaves a tab that is really closed — right, then left. The row
    // stays where it is; it is the page that went.
    if (this.activeTabId !== id) return
    const index = this.tabs.findIndex((candidate) => candidate.id === id)
    const next = this.tabs[index + 1] ?? this.tabs[index - 1] ?? null
    const task = await fluid.tasks.setActiveTab({ id: taskId, tabId: next?.id ?? null })
    if (task) this.replaceTask(task)
  }

  /**
   * Records what a native view reports about its page. The address, title and
   * favicon are also written back to the tab's payload, so the sidebar can draw
   * the tab on the next launch before any page has loaded.
   *
   * A file tab rendering an HTML document has a view of its own and reports
   * here too, but a document is not an address: only the live state is kept,
   * and the one part of it the pane reads is whether the file failed to load.
   */
  applyPageState(state: BrowserViewState): void {
    this.pages[state.tabId] = state

    const tab = this.tabs.find((candidate) => candidate.id === state.tabId)
    if (!tab || tab.type !== 'browser') return

    const payload: BrowserTabPayload = {
      ...tab.payload,
      url: state.url || tab.payload.url,
      // An empty title is the gap between navigating and the document naming
      // itself, not a page that has no name; the favicon has no such gap,
      // because the view clears it deliberately on every navigation.
      pageTitle: state.title || tab.payload.pageTitle,
      favicon: state.favicon ?? undefined
    }
    if (
      payload.url === tab.payload.url &&
      payload.pageTitle === tab.payload.pageTitle &&
      payload.favicon === tab.payload.favicon
    ) {
      return
    }

    tab.payload = payload
    void fluid.tabs.update({ id: tab.id, payload })
  }

  /** What the sidebar shows for a tab: the live page title if there is one yet. */
  labelFor(tab: Tab): string {
    if (tab.title) return tab.title
    if (tab.type === 'browser') {
      return this.pages[tab.id]?.title || tab.payload.pageTitle || hostOf(tab.payload.url)
    }
    if (tab.type === 'file') return tab.payload.fileName
    // An extension's tab is named by the extension, and failing that by what
    // kind of tab it is.
    return extensions.tabView(tab.type)?.label?.(tab) || extensions.tabTypeLabel(tab.type)
  }

  /**
   * The picture a tab's row draws instead of a glyph, as a `data:` URL, or null
   * when it has none. For a file tab it is the preview made when the file was
   * imported, which never changes. For a browser tab it is the site's icon,
   * from the best source the tab has:
   *
   * A live view that has finished loading is the whole answer, icon or no icon
   * — standing in for a page that turned out to have none of its own would be
   * wrong. Everything else falls back: the icon stored on the tab when it was
   * last open, and failing that what the site's icon is known to be (see
   * `siteIcons`), which is what draws a pinned tab nobody has clicked yet.
   *
   * A view still loading falls back too, rather than going blank for the second
   * between the click and the page: the row was showing the right icon already,
   * and a flicker is not news.
   */
  iconFor(tab: Tab): string | null {
    if (tab.type === 'file') return tab.payload.thumbnail ?? null
    if (tab.type !== 'browser') return null

    const page = this.pages[tab.id]
    if (page?.favicon) return page.favicon
    if (page && !page.loading) return null
    if (tab.payload.favicon) return tab.payload.favicon

    const origin = originOf(tab.payload.url)
    return (origin ? this.siteIcons[origin] : null) ?? null
  }

  /**
   * Asks for a site's icon on behalf of a row that has nothing to draw. Called
   * by the row itself (see SidebarTab), which is what makes this cover every
   * way a tab can turn up in the sidebar rather than only the ones a task
   * switch goes through.
   *
   * Once per origin per launch, and cheap when it lands: the main process
   * answers from what other tabs have already loaded whenever it can, and only
   * goes to the network for a site this app has never opened.
   */
  requestSiteIcon(tab: Tab): void {
    if (tab.type !== 'browser') return

    const origin = originOf(tab.payload.url)
    if (!origin || this.siteIconsAsked.has(origin)) return
    this.siteIconsAsked.add(origin)

    void api.browser.siteIcon(tab.payload.url, this.activeSpaceId, tab.profile).then((dataUrl) => {
      // A site with no icon leaves the row on its glyph, which is what it has
      // been showing all along.
      if (dataUrl) this.siteIcons[origin] = dataUrl
    })
  }

  /**
   * Takes in a change to the workspace, whoever made it.
   *
   * Every write the API makes is announced to every window (see
   * src/main/api/bus.ts), including the ones this window made itself — which it
   * has usually already drawn, so everything here is written to be a no-op for
   * a change that is already on screen. What it is for is the rest: a task a
   * routine opened, a tab an extension moved, a rename in another window.
   */
  applyEvent(event: WorkspaceEvent): void {
    switch (event.type) {
      case 'task.created': {
        const { task } = event
        if (
          task.status === 'open' &&
          task.projectId === this.activeProjectId &&
          !this.hasTask(task.id)
        ) {
          this.tasks = [...this.tasks, task]
        }
        return
      }

      case 'task.updated': {
        const { task } = event
        if (!this.hasTask(task.id)) {
          // Reopened, most likely: back into the strip, in its place.
          if (task.status === 'open' && task.projectId === this.activeProjectId) {
            this.tasks = [...this.tasks, task].sort((a, b) => a.position - b.position)
          }
          return
        }
        if (task.status === 'settled') void this.dropTasks([task.id])
        else this.replaceTask(task)
        return
      }

      case 'task.deleted':
        for (const tab of event.tabs) this.forgetTab(tab.id)
        if (this.hasTask(event.task.id)) void this.dropTasks([event.task.id])
        return

      case 'tasks.reordered':
        if (event.projectId === this.activeProjectId) {
          this.tasks = event.tasks.filter((task) => task.status === 'open')
        }
        return

      case 'tab.updated':
        if (event.tab.taskId === this.activeTaskId) this.patchTab(event.tab)
        return

      case 'tab.moved':
        // The one time the window moves on its own, and the opposite of a focus
        // steal: the tab the user is looking at went somewhere, and the window
        // goes with it rather than leaving them in front of whichever tab fell
        // into its place. `activeTabId` still names it — the task rows it
        // changed are announced after this.
        if (event.fromTaskId === this.activeTaskId && this.activeTabId === event.tab.id) {
          void this.revealTask({ taskId: event.tab.taskId, tabId: event.tab.id })
          return
        }
        if (taskIdsOf(event).includes(this.activeTaskId ?? '')) this.refreshTabs()
        return

      case 'tab.closed':
        this.forgetTab(event.tab.id)
        if (event.tab.taskId === this.activeTaskId) this.refreshTabs()
        return

      case 'tab.created':
      case 'tabs.reordered':
      case 'folder.created':
      case 'folder.moved':
      case 'folder.deleted':
        if (taskIdsOf(event).includes(this.activeTaskId ?? '')) this.refreshTabs()
        return

      case 'folder.updated':
        if (event.folder.taskId === this.activeTaskId) this.patchFolder(event.folder)
        return

      case 'project.created':
      case 'project.updated':
      case 'project.deleted':
      case 'project.activated':
      case 'space.created':
      case 'space.updated':
      case 'space.deleted':
        this.refreshProjects()
        return

      case 'setting.changed':
        if (event.key === SIDEBAR_COLLAPSED_KEY) this.sidebarCollapsed = event.value === true
        if (
          event.key === SIDEBAR_WIDTH_KEY &&
          typeof event.value === 'number' &&
          !this.sidebarResizing
        ) {
          this.sidebarWidth = clampSidebarWidth(event.value)
        }
        return

      case 'ui.revealRequested':
        void this.revealTask({ taskId: event.taskId, tabId: event.tabId })
        return
    }
  }

  private hasTask(id: string): boolean {
    return this.tasks.some((task) => task.id === id)
  }

  /**
   * Appends tabs just opened to the selected task's list, skipping any already
   * in it. Each open is announced before its call returns, and the re-read that
   * announcement sets off (see `refreshTabs`) can land first — most easily while
   * a drop of several files is still opening the rest. A second copy would be a
   * duplicate key in the sidebar's keyed `each`, the same way as `createTask`.
   */
  private addTabs(opened: Tab[]): void {
    const fresh = opened.filter((tab) => !this.tabs.some((current) => current.id === tab.id))
    if (fresh.length > 0) this.tabs = [...this.tabs, ...fresh]
  }

  /**
   * Replaces one of the selected task's tabs with the row as it now stands —
   * keeping how the tab looks if a write of that is still waiting out its
   * delay, since the row is older than what is on screen.
   */
  private patchTab(updated: Tab): void {
    const index = this.tabs.findIndex((tab) => tab.id === updated.id)
    if (index === -1) return
    const current = this.tabs[index]
    const next = this.viewStateWrites.has(updated.id)
      ? ({ ...updated, viewState: current.viewState } as Tab)
      : updated
    this.tabs[index] = next
  }

  /** Whether a re-read of the selected task's tabs is already on its way. */
  private tabsRefreshQueued = false

  /**
   * Re-reads the selected task's tabs, and its folders with them. Coalesced, so
   * the burst of events one change can produce — a tab opened and the task
   * adopting it, a folder's tabs closed one by one — is one read.
   */
  private refreshTabs(): void {
    if (this.tabsRefreshQueued) return
    this.tabsRefreshQueued = true
    queueMicrotask(async () => {
      this.tabsRefreshQueued = false
      const taskId = this.activeTaskId
      if (!taskId) return
      const [fresh, folders] = await Promise.all([
        fluid.tabs.list({ taskId }),
        fluid.folders.list({ taskId })
      ])
      if (this.activeTaskId !== taskId) return
      this.folders = folders
      this.tabs = fresh.map((tab) => {
        const current = this.tabs.find((candidate) => candidate.id === tab.id)
        return current && this.viewStateWrites.has(tab.id)
          ? ({ ...tab, viewState: current.viewState } as Tab)
          : tab
      })
    })
  }

  /** Whether a re-read of the projects is already on its way. */
  private projectsRefreshQueued = false

  private refreshProjects(): void {
    if (this.projectsRefreshQueued) return
    this.projectsRefreshQueued = true
    queueMicrotask(async () => {
      this.projectsRefreshQueued = false
      await this.applyProjectsChanged(await api.projects.state())
    })
  }

  /** Lets go of what this window was holding for a tab that has gone. */
  private forgetTab(id: string): void {
    clearTimeout(this.viewStateWrites.get(id))
    this.viewStateWrites.delete(id)
    this.cancelDownloadFor(id)
    delete this.pages[id]
  }

  private replaceTask(updated: Task): void {
    this.tasks = this.tasks.map((task) => (task.id === updated.id ? updated : task))
  }
}

/** A download in flight, as the rows and panes drawing it need to see it. */
export type LiveDownload = {
  downloadId: string
  receivedBytes: number
  /** 0 for a server that never named a length; there is no fraction to draw. */
  totalBytes: number
  paused: boolean
  /** The tab it is filling, or null for the moment before that tab exists. */
  tabId: string | null
}

/** What a file tab holds, for a file the store has taken in however it arrived. */
function fileTabPayload(file: StoredFile): FileTabPayload {
  return {
    storageKey: file.storageKey,
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.size,
    sourcePath: file.sourcePath,
    thumbnail: file.thumbnail
  }
}

/**
 * Whether `tab` is pinned to the page `url` names, and holds it in the login
 * the link was asked for. This is the question a followed link puts to a
 * task's tabs before one is opened for it.
 *
 * The profile has to agree as well as the address. A page opened from inside
 * the red profile is the red profile's — that is what keeps a signed-in
 * session coherent as you follow links out of it — and landing it in a tab
 * signed in as somebody else would be a wrong page that looks like the right
 * one. Better a second tab.
 */
function pinnedTo(tab: Tab, url: string, profile: number | null): boolean {
  if (tab.pinnedUrl === null || tab.profile !== profile) return false
  return samePage(tab.pinnedUrl, url)
}

/**
 * Whether two addresses name the same page, in the sense `covers` means and
 * whichever way round they are written.
 *
 * A link and the pinned tab for what it points at are rarely the same string:
 * a message quotes a ticket as `/story/144277` while the tab holds the slug
 * the tracker redirects it to, and a pull request is linked to by its Files tab
 * as readily as by itself. Either way round, it is the page the task already
 * has a row for.
 */
function samePage(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a)
}

/**
 * Whether `url` counts as the page `pinned` names — which is not string
 * equality, because a pinned address is rarely where the page settles.
 * A tracker may redirect `/story/144277` to `/story/144277/add-pkce-compatibility`
 * the moment it loads, so a tab that reported having wandered off the instant
 * it opened would never report anything else.
 *
 * A pinned address therefore covers its page and everything under it: a pull
 * request's own Files tab is still that pull request, while the next pull
 * request along is not. The boundary check is what keeps `…/pull/3` from
 * claiming `…/pull/33`.
 */
function covers(pinned: string, url: string): boolean {
  const home = bareAddress(pinned)
  const here = bareAddress(url)
  if (here === home) return true
  if (!here.startsWith(home)) return false
  // A deeper path or a query on the same path; anything else is another page
  // whose address merely begins the same way.
  const rest = here.slice(home.length)
  return rest.startsWith('/') || rest.startsWith('?')
}

/**
 * An address without the parts that do not change which page it is: the
 * fragment, which is a place within a document rather than a document — a link
 * to a review comment is still the pull request the comment is on — and a
 * trailing slash, which is nothing at all.
 */
function bareAddress(url: string): string {
  try {
    const { origin, pathname, search } = new URL(url)
    return `${origin}${pathname.replace(/\/$/, '')}${search}`
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * One step along a strip from whatever is selected, wrapping round at either
 * end. Null when there is nowhere to go: an empty strip, or a single item that
 * every step lands back on — which is worth telling apart from a real move,
 * since selecting is a write to the database rather than a local change.
 *
 * A strip with nothing selected yet starts at the end the step came from, so
 * the first key lands on the nearest item rather than on nothing.
 */
function stepThrough<T extends { id: string }>(
  items: T[],
  activeId: string | null,
  delta: number
): T | null {
  if (items.length === 0) return null

  const index = items.findIndex((item) => item.id === activeId)
  if (index === -1) return delta > 0 ? items[0] : items[items.length - 1]

  const next = items[(index + delta + items.length) % items.length]
  return next.id === activeId ? null : next
}

export const workspace = new Workspace()
