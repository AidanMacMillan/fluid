<script lang="ts">
  import BrowserSurface from './components/BrowserSurface.svelte'
  import SidebarDock from './components/SidebarDock.svelte'
  import TopBar from './components/TopBar.svelte'
  import { fluid } from './lib/api'
  import { extensions, provideWindowActions } from './lib/extensions.svelte'
  import { workspace } from './lib/workspace.svelte'

  // Extensions' renderer halves open links, and remember how their tabs were
  // left, through this window: it is the one with a strip to open them in.
  extensions.start()
  provideWindowActions({
    openLink: (url) => void workspace.openLink(url),
    setViewState: (tabId, viewState) => workspace.setViewState(tabId, viewState),
    flushViewState: (tabId) => workspace.flushViewState(tabId)
  })

  /**
   * One of an extension entry's other answers, picked from its row's menu in
   * the launcher. The launcher has closed by now, so the extension is asked for
   * the tab here — and whatever it asks the user on the way, a folder say, is
   * asked over this window.
   */
  async function openAlternative(choice: { entry: string; alternative: string }): Promise<void> {
    const found = extensions
      .launcherEntries()
      .find(({ extensionId, entry }) => `${extensionId}.${entry.id}` === choice.entry)
    const alternative = found?.entry.alternatives?.find(({ id }) => id === choice.alternative)
    if (!found || !alternative) return
    const tab = await alternative.open(found.host)
    if (tab) await workspace.openExtensionTab(tab)
  }

  // Every change to the workspace, whoever made it — this window, a routine, an
  // extension, another window. See `applyEvent`.
  $effect(() => fluid.onAny((event) => workspace.applyEvent(event)))

  $effect(() => {
    void workspace.load()
    // Title and loading updates arrive from the native views for as long as
    // the app is up; the unsubscribe is here for HMR, not for shutdown.
    return window.api.browser.onState((state) => workspace.applyPageState(state))
  })

  // Downloads a page starts go into the app's file store rather than the
  // Downloads folder, and each one becomes a file tab in the task it came from
  // the moment it begins — the tab then fills up as the bytes land.
  $effect(() => window.api.files.onDownload((event) => workspace.handleDownload(event)))

  // A page asking to open somewhere else — window.open, or a link set to open
  // in a new tab — gets a tab in this app rather than being handed to the
  // user's real browser, which holds none of the session it was signed in to.
  $effect(() => window.api.browser.onOpenTab((request) => void workspace.openRequestedTab(request)))

  // The launcher is a window of its own, so what it settles on comes back
  // across the bridge rather than up through the tree. The choice is all it
  // knows; which task the tab joins, or which project the task, is decided here.
  $effect(() =>
    window.api.launcher.onOpenTab((choice) => {
      if (choice.kind === 'url') void workspace.createBrowserTab(choice.url, choice.profile)
      else if (choice.kind === 'extension-tab') void workspace.openExtensionTab(choice.tab)
      else if (choice.kind === 'task') void workspace.createTask(choice.task)
      else void openAlternative(choice)
    })
  )

  // The way back out of a miniplayer. It lands in the same place a clicked
  // notification does — a task, and a tab within it — because it is the same
  // request: the user is looking at something else and wants to be looking at
  // this instead.
  $effect(() => window.api.miniplayer.onRevealTab((focus) => void workspace.revealTask(focus)))

  // The project picker is a window of its own, like the launcher, so what it
  // settles on comes back across the bridge. It hands over an id and nothing
  // else; which tasks that means is this side's to work out.
  $effect(() => window.api.projects.onSelected((choice) => void workspace.selectProject(choice.id)))

  // Which task is in front, told to the main process rather than asked for.
  // Copies are caught by a timer there (see src/main/clipboard-capture.ts) and
  // have to be filed against a task, and the selection is this window's own
  // state — written down nowhere that side could look it up. The title goes
  // along because the clipboard panel draws it.
  $effect(() => {
    const task = workspace.activeTask
    window.api.clipboard.setTask(task ? { id: task.id, title: task.title } : null)
  })

  // Work a tab finished stops being news once the user has the tab open, and
  // the tab in front is open for as long as it is in front — so one that
  // finishes while it is there is seen as it finishes. See `TabActivity`.
  $effect(() => {
    const tab = workspace.activeTab
    if (tab?.activity === 'done') void fluid.tabs.markSeen({ id: tab.id })
  })

  // Every task's tabs' activity rather than only the selected task's, which is
  // all `tabs` holds: the strip gives each task a dot of its own.
  $effect(() => {
    const projectId = workspace.activeProjectId
    if (!projectId) return undefined
    return fluid.watch('tabs.activity', { projectId }, (entries) => {
      if (workspace.activeProjectId === projectId) workspace.tabActivity = entries
    })
  })

  // Cmd+S is a menu accelerator rather than a key listener here: a browser
  // tab's native view has the keyboard whenever a page is in front, and this
  // window would never see the key. Main sends it back the other way.
  $effect(() => window.api.sidebar.onToggle(() => workspace.toggleSidebar()))

  // Cmd+1..9 and the Cmd+Option+arrow chords, which move between tasks and
  // between tabs, arrive the same way and for the same reason.
  $effect(() =>
    window.api.shortcuts.onNavigate((navigation) => void workspace.navigate(navigation))
  )

  // A link clicked in the app's own interface rather than in a page: the window
  // it would otherwise navigate is the app itself. The main process refuses the navigation and sends the
  // address here, where it opens the way a link followed out of a tab or a
  // shell's output does.
  $effect(() => window.api.workspace.onOpenLink((url) => void workspace.openLink(url)))

  // A file dropped anywhere the app does not handle would otherwise be loaded
  // by the window itself, replacing the whole interface with the file. The
  // drop zones claim their own events before these see them.
  $effect(() => {
    const swallow = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  })
</script>

<div class="flex h-screen flex-col glass-scrim text-ink-100 text-on-glass">
  <TopBar />
  {#if workspace.ready}
    <div class="flex min-h-0 flex-1">
      <SidebarDock />
      <div class="flex min-w-0 flex-1">
        <BrowserSurface />
      </div>
    </div>
  {/if}
</div>
