<script lang="ts">
  import { shortenPath } from '../lib/paths'
  import { reorder } from '../lib/reorder.svelte'
  import { workspace } from '../lib/workspace.svelte'
  import IconButton from './IconButton.svelte'
  import TaskTab from './TaskTab.svelte'

  /**
   * What the project button says when it is hovered: the folder everything in
   * this project opens in. The name alone is on the button, and the folder is
   * the thing you occasionally have to check and never want taking up room.
   */
  const projectTitle = $derived.by(() => {
    const project = workspace.activeProject
    if (!project) return 'Switch project'
    const where = project.root === null ? 'home folder' : shortenPath(project.root, workspace.home)
    // The space as well, since it is what every page in the window is signed in
    // as: two projects with the same sites open are two different visitors when
    // they are in different spaces.
    return `${project.name} — ${where} · ${project.spaceName} space`
  })

  /**
   * The space's name, drawn on the button always — the default space included,
   * since it can be renamed and is then as much worth reading as any other.
   */
  const spaceLabel = $derived(workspace.activeSpaceName)

  function onDrop(event: DragEvent): void {
    const next = reorder.drop(event, 'task', workspace.tasks)
    if (next) void workspace.reorderTasks(next.map((task) => task.id))
  }
</script>

<!-- The whole bar is the window's drag handle; the controls inside opt out with
     `no-drag`. Nothing here paints a background or an edge, so the vibrancy runs
     edge to edge and the content well below marks where the bar ends. -->
<header class="h-titlebar shrink-0 select-none drag-region">
  <!-- No padding on the leading edge: `titlebar-safe-area` already starts the
       row past the OS window controls, and anything added here reads as a gap
       between them and the first button. The trailing edge has no furniture to
       clear, so it pads itself. -->
  <div class="titlebar-safe-area flex h-full items-center gap-1 pr-2">
    <!-- Filled while the sidebar is docked, outline once it is collapsed. The
         state it reads is `sidebarCollapsed`, not `sidebarOut`: a peek is the
         sidebar leaning out under the pointer and going away again, so the
         icon would otherwise flip back and forth without anything having been
         toggled. -->
    <IconButton
      icon={workspace.sidebarCollapsed
        ? 'icon-[ph--sidebar-simple]'
        : 'icon-[ph--sidebar-simple-fill]'}
      label={workspace.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      onclick={() => workspace.toggleSidebar()}
    />

    <!-- The strip and the new-task button share one flexible span: the tablist
         takes only what its tabs need, so the button sits against the last tab
         until the tabs fill the bar and push it to the edge.

         The drag handlers live out here rather than on the tablist so the empty
         space past the strip — the button's own gap included — still resolves
         to a drop at the end. Each tab claims its own span first (see TaskTab),
         and this runs on what bubbles up unclaimed. -->
    <div
      class="flex min-w-0 flex-1 items-center gap-1"
      ondragover={(event) => reorder.overRest(event, 'task', workspace.tasks.length)}
      ondragleave={(event) => reorder.leave(event)}
      ondrop={onDrop}
    >
      <!-- The strip asks for exactly the room its tabs want — one `--width-tab`
           each plus the gaps between them — and shrinks from there when the bar
           cannot spare it. That is what keeps the tabs equal and capped while
           the strip still ends where the tabs do: asking for the whole span
           instead would strand the new-task button out at the edge.

           Tabs shrink together until they hit their floor; past that the strip
           scrolls rather than squeezing them to nothing. The scrollbar itself
           is hidden: it would sit on the glass. -->
      <div
        role="tablist"
        aria-label="Tasks"
        style="width: calc({workspace.tasks.length} * var(--width-tab) + {workspace.tasks.length -
          1} * var(--spacing))"
        class="flex min-w-0 shrink items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
      >
        {#each workspace.tasks as task, index (task.id)}
          <TaskTab {task} {index} last={index === workspace.tasks.length - 1} />
        {/each}
      </div>

      <!-- Asks what the task should be rather than making one: the same panel
           Cmd+Shift+T opens, which starts on a blank task, so a click and
           Enter is still a blank task. -->
      <IconButton
        icon="icon-[ph--plus]"
        label="New task"
        onclick={() => window.api.launcher.open('task')}
      />
    </div>

    <!-- Outside the flexible span, so these are pinned to the trailing edge
         rather than travelling with the end of the task strip. -->

    <!-- Which project the tasks to the left belong to, and the way to another.
         A button with a name rather than a glyph: the whole point of it is to
         say where you are without being opened, and every task in the strip is
         read against it.

         It opens a panel in a window of its own — see
         src/main/project-window.ts — the way the plus button's launcher does. -->
    <button
      type="button"
      onclick={() => window.api.projects.open()}
      title={projectTitle}
      class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md glass-control px-2
             text-xs font-medium text-ink-300 no-drag hover:text-ink-100"
    >
      <span class="max-w-40 truncate">{workspace.activeProject?.name ?? 'Projects'}</span>
      {#if spaceLabel}
        <!-- Which browsing world the project's pages are signed in as. A chip
             rather than more of the same line: it is a different fact from the
             project's name, and one that changes what a page *is*. -->
        <span
          class="max-w-24 shrink truncate rounded bg-white/10 px-1.5 py-0.5 text-[0.625rem]
                 font-medium text-ink-300"
        >
          {spaceLabel}
        </span>
      {/if}
    </button>

    <IconButton
      icon="icon-[ph--gear]"
      label="Settings"
      onclick={() => window.api.settingsWindow.open()}
    />
  </div>
</header>
