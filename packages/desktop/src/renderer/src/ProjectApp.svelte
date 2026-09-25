<script lang="ts">
  import type { ProjectRow, ProjectsState } from '../../main/projects'
  import type { SpaceRow } from '../../main/spaces'
  import { matchesQuery } from './lib/search'
  import { reasonFrom } from './lib/ipc-error'
  import { shortenPath } from './lib/paths'

  /**
   * The panel that says which project the app is in: a field to filter by, a
   * row per project, and below a line the rows that are not projects — the way
   * to make another, and the way through to the spaces.
   *
   * Built to be the launcher a level up (see LauncherApp.svelte), down to the
   * prompts: everything this panel can do that needs a word typed narrows the
   * panel to that one question rather than opening a dialog over it.
   *
   * Spaces are managed here rather than in settings because a space is only
   * ever met through a project — it is the browsing world a project's pages are
   * signed in as (see src/main/browsing.ts) — and this is where projects are.
   * The spaces list is the same panel in a second mode, not a second panel.
   *
   * It decides nothing about tasks. Choosing a project hands the id back to the
   * window it opened over — that window draws the strip, and this one
   * deliberately knows nothing about what is in it.
   */

  const api = window.api.projects
  const spacesApi = window.api.spaces

  /**
   * The question the panel is asking, or null while it is the filter field it
   * usually is.
   *
   * `new` is the first half of making a project: the name. The folder is the
   * second half and is not typed at all — it is the OS picker, opened the
   * moment the name is taken, the way the launcher's editor row opens it. The
   * prompt offers two rows under the field for that second half: choose a
   * folder, which is what Enter does, or go without one and start in home.
   *
   * `new-space` carries the project it was reached from, when it was reached
   * from one: moving a project into a space that does not exist yet is the
   * commonest reason to want another space at all, and asking for the name and
   * then making the user go and assign it would be two steps for one thought.
   */
  type Prompt =
    | { kind: 'new' }
    | { kind: 'rename'; project: ProjectRow }
    | { kind: 'delete'; project: ProjectRow; tasks: number }
    | { kind: 'new-space'; project: ProjectRow | null }
    | { kind: 'rename-space'; space: SpaceRow }
    | { kind: 'delete-space'; space: SpaceRow }

  /** Which list the panel is showing. The field filters whichever one it is. */
  type View = 'projects' | 'spaces'

  let projectsState = $state<ProjectsState | null>(null)
  let view = $state<View>('projects')
  let query = $state('')
  let prompt = $state<Prompt | null>(null)
  let selected = $state(0)
  let busy = $state(false)
  /** What went wrong with the last thing asked for, shown under the field. */
  let error = $state<string | null>(null)

  const projects = $derived(projectsState?.projects ?? [])
  const spaces = $derived(projectsState?.spaces ?? [])

  $effect(() => {
    void load()
  })

  async function load(): Promise<void> {
    apply(await api.state())
  }

  function apply(next: ProjectsState): void {
    projectsState = next
  }

  /**
   * The rows the field has filtered to. Every project while nothing is typed.
   *
   * The folder is searched as well as the name, since half of remembering which
   * project is which is remembering which repository it is — and the space, so
   * that typing one gathers up everything in it.
   */
  const matches = $derived(
    projects.filter((project) =>
      matchesQuery(query, [project.name, project.root ?? '', project.spaceName])
    )
  )

  const spaceMatches = $derived(spaces.filter((space) => matchesQuery(query, [space.name])))

  /**
   * What a row says on its right: the folder, shortened the way a shell writes
   * it. A project with no folder says nothing rather than showing a path the
   * user never chose.
   */
  function detailOf(project: ProjectRow): string | null {
    if (project.root === null) return null
    return shortenPath(project.root, projectsState?.home ?? '')
  }

  /**
   * How far the arrow keys reach: the rows of whichever list is up, plus the
   * ones under the line — a new project and the way to the spaces, or a new
   * space. A prompt narrows the panel to its own question, and there is nothing
   * to walk while one is up.
   */
  const rowCount = $derived.by(() => {
    if (prompt?.kind === 'new') return 2
    if (prompt !== null) return 0
    return view === 'projects' ? matches.length + 2 : spaceMatches.length + 1
  })

  /** The field, so it can be given the keyboard back after a row is clicked. */
  let field = $state<HTMLInputElement | null>(null)

  function autofocus(node: HTMLInputElement): void {
    node.focus()
  }

  /** Opens a prompt in the field the panel already has. */
  function ask(next: Prompt, seed = ''): void {
    prompt = next
    query = seed
    selected = 0
    error = null
    field?.focus()
    // Seeded text is there to be replaced or edited, and a name is more often
    // adjusted than retyped — so it is selected rather than left with the caret
    // at the end.
    if (seed !== '') queueMicrotask(() => field?.select())
  }

  /**
   * One step back: out of a prompt to the list it was opened from, or out of
   * the spaces to the projects. One key for both, because both are the same
   * thing to the user — undo the last narrowing.
   */
  function back(): void {
    if (prompt !== null) prompt = null
    else view = 'projects'
    query = ''
    selected = 0
    error = null
    field?.focus()
  }

  /** Into the spaces list. */
  function showSpaces(): void {
    view = 'spaces'
    query = ''
    selected = 0
    error = null
    field?.focus()
  }

  /** Moves the app to a project. The panel closes; the window redraws its strip. */
  function choose(project: ProjectRow): void {
    api.submit({ kind: 'select', id: project.id })
  }

  /**
   * Makes a project out of the name in the field and, unless it was asked for
   * without one, a folder chosen straight after it.
   *
   * The panel is held open while the picker is — a sheet's key status arrives
   * here as the blur that usually dismisses the panel — and cancelling the
   * picker leaves the name where it was typed, which is the right answer to
   * changing your mind about the folder rather than about the project.
   */
  async function create(withFolder: boolean): Promise<void> {
    const name = query.trim()
    if (busy || name === '') return

    busy = true
    error = null
    try {
      const root = withFolder ? await api.chooseNewRoot(name) : null
      if (withFolder && root === null) return
      const created = await api.create(name, root)
      api.submit({ kind: 'select', id: created.id })
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  async function rename(project: ProjectRow): Promise<void> {
    const name = query.trim()
    if (busy || name === '') return

    busy = true
    error = null
    try {
      apply(await api.rename(project.id, name))
      back()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Deletes a project, once its name has been typed back.
   *
   * The typing is not theatre: this is the one thing the app does that destroys
   * work with no way back, and the main process refuses the call outright
   * unless the name it is given matches (see `deleteProject`). The button below
   * only unlocks at the same moment.
   */
  async function remove(project: ProjectRow): Promise<void> {
    if (busy || query.trim() !== project.name) return

    busy = true
    error = null
    try {
      apply(await api.remove(project.id, query.trim()))
      back()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /** Moves a project into an existing space. */
  async function moveToSpace(project: ProjectRow, spaceId: string): Promise<void> {
    if (busy || project.spaceId === spaceId) return

    busy = true
    error = null
    try {
      apply(await api.setSpace(project.id, spaceId))
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Makes a space out of the name in the field, and moves a project into it
   * when the prompt was reached from one.
   *
   * The two halves are one action deliberately: a space made and then left
   * empty is a thing nobody asked for, and the moment anyone wants another
   * space is the moment they have a project that does not belong in the one it
   * is in.
   */
  async function createSpace(project: ProjectRow | null): Promise<void> {
    const name = query.trim()
    if (busy || name === '') return

    busy = true
    error = null
    try {
      const space = await spacesApi.create(name)
      if (project) apply(await api.setSpace(project.id, space.id))
      else await load()
      back()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  async function renameSpace(space: SpaceRow): Promise<void> {
    const name = query.trim()
    if (busy || name === '') return

    busy = true
    error = null
    try {
      apply(await spacesApi.rename(space.id, name))
      back()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Deletes a space. Its projects move to the default space, so nothing that
   * was worked on goes with it — what goes is the isolation, and every login
   * the space was holding.
   *
   * Confirmed with a button rather than by typing the name back, unlike a
   * project: no work is destroyed here, and asking someone to type a word to
   * undo a grouping would be ceremony rather than a brake.
   */
  async function removeSpace(space: SpaceRow): Promise<void> {
    if (busy) return

    busy = true
    error = null
    try {
      apply(await spacesApi.remove(space.id))
      back()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Right-clicking a project asks what to do with it. The menu is native and
   * popped from the main process, for the reason the launcher's profile menu is
   * (see src/main/profile-menu.ts): this window is sized to the panel inside
   * it, so a menu drawn in the document would be clipped by the window's edge.
   *
   * Three of its answers come back here to be finished in the field — a new
   * name, a name typed back to confirm a deletion, and the name of a space that
   * does not exist yet — which is why the panel is held open for the length of
   * the menu rather than being allowed to take the menu's appearance as looking
   * away.
   */
  async function menu(project: ProjectRow, event: MouseEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const choice = await api.menu(project.id)
    if (choice === null) return

    if (choice.kind === 'rename') {
      ask({ kind: 'rename', project }, project.name)
      return
    }

    if (choice.kind === 'space') {
      await moveToSpace(project, choice.spaceId)
      return
    }

    if (choice.kind === 'new-space') {
      ask({ kind: 'new-space', project })
      return
    }

    if (choice.kind === 'clear-root') {
      busy = true
      error = null
      try {
        apply(await api.clearRoot(project.id))
      } catch (cause) {
        error = reasonFrom(cause)
      } finally {
        busy = false
      }
      return
    }

    if (choice.kind === 'root') {
      busy = true
      error = null
      try {
        apply(await api.chooseRoot(project.id))
      } catch (cause) {
        error = reasonFrom(cause)
      } finally {
        busy = false
      }
      return
    }

    const deletion = await api.deletion(project.id)
    if (deletion) ask({ kind: 'delete', project, tasks: deletion.tasks })
  }

  /** The same, on a space row: rename it, or delete it. */
  async function spaceMenu(space: SpaceRow, event: MouseEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const choice = await spacesApi.menu(space.id)
    if (choice === null) return

    if (choice === 'rename') ask({ kind: 'rename-space', space }, space.name)
    else ask({ kind: 'delete-space', space })
  }

  /** What Enter does, wherever the panel currently is. */
  function submit(): void {
    if (prompt?.kind === 'new') return void create(selected === 0)
    if (prompt?.kind === 'rename') return void rename(prompt.project)
    if (prompt?.kind === 'delete') return void remove(prompt.project)
    if (prompt?.kind === 'new-space') return void createSpace(prompt.project)
    if (prompt?.kind === 'rename-space') return void renameSpace(prompt.space)
    if (prompt?.kind === 'delete-space') return void removeSpace(prompt.space)

    if (view === 'spaces') {
      // Renaming is the only thing a space row can be taken for: a space is not
      // somewhere the app goes, it is what a project's pages are signed in as.
      const space = spaceMatches[selected]
      if (space) ask({ kind: 'rename-space', space }, space.name)
      else ask({ kind: 'new-space', project: null }, query.trim())
      return
    }

    // The two rows under the projects are the new-project row and the way
    // through to the spaces; everything above them is a project.
    const project = matches[selected]
    if (project) return choose(project)
    if (selected === matches.length + 1) return showSpaces()
    // Whatever was typed carries into the name, the way the launcher's top row
    // is made out of the query: a filter that found nothing is most of the way
    // to being the name of the project that does not exist yet.
    ask({ kind: 'new' }, query.trim())
  }

  /**
   * Arrow keys walk the list, wrapped at both ends, and Enter takes the row.
   * Escape is not here — the main process closes the panel wherever focus is —
   * which is also why backing out is backspace on an empty field, the same
   * idiom the launcher uses and for the same reason.
   */
  function onKeydown(event: KeyboardEvent): void {
    if ((prompt !== null || view === 'spaces') && event.key === 'Backspace' && query === '') {
      event.preventDefault()
      back()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }

    if (rowCount === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selected = (selected + 1) % rowCount
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      selected = (selected - 1 + rowCount) % rowCount
    }
  }

  /** The panel itself, measured so the window can be sized to it. */
  let panel = $state<HTMLElement | null>(null)

  $effect(() => {
    const element = panel
    if (!element) return undefined

    const report = (): void => api.resize(element.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  })

  /** The chip and placeholder for whichever question is being asked. */
  const asking = $derived.by(() => {
    if (prompt === null) {
      if (view === 'spaces') {
        return {
          label: 'Spaces',
          icon: null,
          placeholder: 'Find a space',
          hint: null
        }
      }
      return null
    }
    if (prompt.kind === 'new') {
      return {
        label: 'New project',
        icon: 'icon-[ph--folder-plus]',
        placeholder: 'Name the project',
        hint: null
      }
    }
    if (prompt.kind === 'rename') {
      return {
        label: 'Rename',
        icon: 'icon-[ph--pencil-simple]',
        placeholder: prompt.project.name,
        hint: null
      }
    }
    if (prompt.kind === 'new-space') {
      return {
        label: 'New space',
        icon: null,
        placeholder: 'Name the space',
        // Said only when a project is being moved, because then there is a
        // consequence to warn about rather than a concept to explain.
        hint:
          prompt.project === null
            ? null
            : `${prompt.project.name} moves into it. Its pages sign in separately from then on.`
      }
    }
    if (prompt.kind === 'rename-space') {
      return {
        label: 'Rename space',
        icon: 'icon-[ph--pencil-simple]',
        placeholder: prompt.space.name,
        hint: null
      }
    }
    if (prompt.kind === 'delete-space') {
      return {
        label: `Delete ${prompt.space.name}`,
        icon: 'icon-[ph--trash]',
        placeholder: 'Find a space',
        hint: null
      }
    }
    return {
      label: `Delete ${prompt.project.name}`,
      icon: 'icon-[ph--trash]',
      placeholder: `Type ${prompt.project.name}`,
      hint: null
    }
  })

  /** Whether the delete prompt's name has been typed back exactly. */
  const confirmed = $derived(prompt?.kind === 'delete' && query.trim() === prompt.project.name)

  /** How a space row reads on its right: how many projects are in it. */
  function spaceDetail(space: SpaceRow): string {
    return space.projects === 1 ? '1 project' : `${space.projects} projects`
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- No background of its own: the window's vibrancy material, under the tint
     its body is laid with (`body[data-panel]` in main.css), is what the panel is
     made of, and anything opaque here would cover it. -->
<div bind:this={panel} class="flex flex-col text-ink-100 select-none text-on-glass">
  <!-- The field, and the seam between what you are saying and what the panel is
       offering back — the only line in the panel besides the one above the
       rows that are not projects. -->
  <div class="flex items-center gap-2.5 border-b border-white/10 px-3.5 py-3">
    {#if asking}
      <!-- The way back, and the chip that says the field is no longer the
           projects filter. Both are needed: the chip alone would leave somebody
           who picked the wrong row with nothing but escape, which throws the
           whole panel away rather than the step they are in. -->
      <button
        type="button"
        onclick={back}
        aria-label="Back to the projects"
        class="-ml-1.5 grid size-6 shrink-0 place-items-center rounded-md glass-control
               text-ink-400 hover:text-ink-100"
      >
        <span class="icon-[ph--caret-left] text-sm" aria-hidden="true"></span>
      </button>
      <span
        class="flex min-w-0 shrink items-center gap-1.5 rounded-md bg-white/10 px-2 py-1
               text-[0.6875rem] font-medium text-ink-200"
      >
        {#if asking.icon}
          <span class="{asking.icon} shrink-0 text-xs" aria-hidden="true"></span>
        {/if}
        <span class="truncate">{asking.label}</span>
      </span>
    {:else}
      <span class="icon-[ph--folders] shrink-0 text-base text-ink-500" aria-hidden="true"></span>
    {/if}
    <input
      use:autofocus
      bind:this={field}
      bind:value={query}
      oninput={() => {
        selected = 0
        error = null
      }}
      disabled={busy}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label={asking?.placeholder ?? 'Find a project'}
      placeholder={asking?.placeholder ?? 'Find a project'}
      class="min-w-0 flex-1 cursor-text bg-transparent text-sm text-ink-50 outline-none
             placeholder:text-ink-500 disabled:opacity-60"
    />
  </div>

  {#if prompt?.kind === 'new'}
    <!-- The second half of making a project: where its work starts. Choosing a
         folder is the first row, so Enter on a typed name is what it always
         was; the second is for a project that is a name and nothing more. -->
    <ul aria-label="Folder" class="flex flex-col gap-0.5 p-1.5">
      {#each [{ withFolder: true, icon: 'icon-[ph--folder-open]', label: 'Choose a folder…', detail: null }, { withFolder: false, icon: 'icon-[ph--house]', label: 'No folder', detail: 'Starts in your home folder' }] as row, index (row.label)}
        <li>
          <button
            type="button"
            aria-selected={index === selected}
            onmouseenter={() => (selected = index)}
            onclick={() => void create(row.withFolder)}
            disabled={busy || query.trim() === ''}
            class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left
                   disabled:pointer-events-none disabled:opacity-40"
          >
            <span
              class="{row.icon} shrink-0 text-base {index === selected
                ? 'text-ink-200'
                : 'text-ink-500'}"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 truncate text-xs text-ink-100">{row.label}</span>
            {#if row.detail}
              <span class="shrink-0 truncate text-[0.6875rem] text-ink-500">{row.detail}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if prompt?.kind === 'delete'}
    <!-- Held here because the click handler below is a closure, and the narrowing
         of `prompt` to a deletion does not reach inside one. -->
    {@const project = prompt.project}
    <!-- The whole of the panel below the field while a deletion is being
         confirmed. It says what goes rather than asking whether you are sure:
         the tasks are the part nobody would think to count, and the typing is
         what the answer is made of. -->
    <div class="flex flex-col gap-2.5 px-3.5 py-3">
      <p class="text-xs leading-relaxed text-ink-300">
        Deleting <span class="font-medium text-ink-100">{prompt.project.name}</span> deletes
        {prompt.tasks === 0
          ? 'nothing else — it has no open tasks'
          : prompt.tasks === 1
            ? 'its 1 open task, and every tab, note and clipboard entry in it'
            : `its ${prompt.tasks} open tasks, and every tab, note and clipboard entry in them`}.
        This cannot be undone.
      </p>
      <button
        type="button"
        onclick={() => void remove(project)}
        disabled={busy || !confirmed}
        class="h-8 rounded-md glass-control bg-red-500/20 text-xs font-medium text-red-200
               ring-1 ring-red-400/30 hover:bg-red-500/30 disabled:pointer-events-none
               disabled:opacity-40"
      >
        Delete {prompt.project.name}
      </button>
    </div>
  {:else if prompt?.kind === 'delete-space'}
    {@const space = prompt.space}
    <!-- Deleting a space takes no work with it — the projects in it move — so
         this says where they go and what is actually lost, which is every login
         the space was holding. -->
    <div class="flex flex-col gap-2.5 px-3.5 py-3">
      <p class="text-xs leading-relaxed text-ink-300">
        <span class="font-medium text-ink-100">{prompt.space.name}</span>
        {prompt.space.projects === 0
          ? 'holds no projects'
          : prompt.space.projects === 1
            ? 'holds 1 project, which moves to the default space'
            : `holds ${prompt.space.projects} projects, which move to the default space`}. Every
        site those pages are signed into in this space is signed out. This cannot be undone.
      </p>
      <button
        type="button"
        onclick={() => void removeSpace(space)}
        disabled={busy}
        class="h-8 rounded-md glass-control bg-red-500/20 text-xs font-medium text-red-200
               ring-1 ring-red-400/30 hover:bg-red-500/30 disabled:pointer-events-none
               disabled:opacity-40"
      >
        Delete {prompt.space.name}
      </button>
    </div>
  {:else if asking?.hint && error === null}
    <p class="px-3.5 py-3 text-[0.6875rem] leading-relaxed text-ink-500">{asking.hint}</p>
  {/if}

  {#if error}
    <p class="px-3.5 pt-2.5 pb-3 text-xs text-red-400">{error}</p>
  {/if}

  {#if prompt === null && view === 'projects'}
    <ul aria-label="Projects" class="flex max-h-96 flex-col gap-0.5 overflow-y-auto p-1.5">
      {#each matches as project, index (project.id)}
        <li>
          <!-- Hover moves the selection rather than drawing a second highlight
               of its own: one row is the row Enter would take, however the
               pointer and the arrow keys got it there. -->
          <button
            type="button"
            aria-selected={index === selected}
            onmouseenter={() => (selected = index)}
            onclick={() => choose(project)}
            oncontextmenu={(event) => void menu(project, event)}
            class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
          >
            <span
              class="shrink-0 text-base {index === selected
                ? 'text-ink-200'
                : 'text-ink-500'} {project.id === projectsState?.activeId
                ? 'icon-[ph--folder-fill]'
                : 'icon-[ph--folder]'}"
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 truncate text-xs text-ink-100">{project.name}</span>
            <!-- Which browsing world this project's pages are signed in as. -->
            <span
              class="max-w-24 shrink-0 truncate rounded bg-white/10 px-1.5 py-0.5
                     text-[0.625rem] font-medium text-ink-300"
              title="In the {project.spaceName} space"
            >
              {project.spaceName}
            </span>
            {#if project.missing}
              <!-- The folder is away — an unmounted volume, a repository moved.
                   The project is left pointed at it and work started in it
                   falls back to home, which is worth a mark on the row rather
                   than a silence. -->
              <span
                class="icon-[ph--warning] shrink-0 text-sm text-amber-300"
                title="That folder is not there right now, so work in this project starts in your home folder."
              ></span>
            {/if}
            {#if detailOf(project) !== null}
              <span class="shrink-0 truncate text-[0.6875rem] text-ink-500"
                >{detailOf(project)}</span
              >
            {/if}
          </button>
        </li>
      {/each}

      <!-- The seam between the projects and the row that makes another one,
           drawn the way the launcher separates its bands. -->
      {#if matches.length > 0}
        <li class="mx-1 my-1.5 h-px bg-white/10" role="separator"></li>
      {/if}

      <li>
        <button
          type="button"
          aria-selected={selected === matches.length}
          onmouseenter={() => (selected = matches.length)}
          onclick={() => ask({ kind: 'new' }, query.trim())}
          class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
        >
          <span
            class="icon-[ph--plus] shrink-0 text-base {selected === matches.length
              ? 'text-ink-200'
              : 'text-ink-500'}"
            aria-hidden="true"
          ></span>
          <span class="min-w-0 flex-1 truncate text-xs text-ink-100">New project</span>
        </button>
      </li>

      <!-- A band of its own for the one row that leaves the subject. Everything
           above is a project or the making of one; this is a way out of the
           list to a different kind of thing, and sitting it under the new-project
           row without a line read as a third project action. -->
      <li class="mx-1 my-1.5 h-px bg-white/10" role="separator"></li>

      <li>
        <button
          type="button"
          aria-selected={selected === matches.length + 1}
          onmouseenter={() => (selected = matches.length + 1)}
          onclick={showSpaces}
          class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
        >
          <span
            class="icon-[ph--squares-four] shrink-0 text-base {selected === matches.length + 1
              ? 'text-ink-200'
              : 'text-ink-500'}"
            aria-hidden="true"
          ></span>
          <span class="min-w-0 flex-1 truncate text-xs text-ink-100">Spaces</span>
          <span class="shrink-0 text-[0.6875rem] text-ink-500">
            {spaces.length === 1 ? '1 space' : `${spaces.length} spaces`}
          </span>
          <!-- Says the row goes somewhere rather than doing something, which is
               the one way it differs from every other row in the panel. -->
          <span
            class="icon-[ph--caret-right] shrink-0 text-[0.625rem] text-ink-600"
            aria-hidden="true"
          ></span>
        </button>
      </li>
    </ul>
  {:else if prompt === null && view === 'spaces'}
    <ul aria-label="Spaces" class="flex max-h-96 flex-col gap-0.5 overflow-y-auto p-1.5">
      {#each spaceMatches as space, index (space.id)}
        <li>
          <button
            type="button"
            aria-selected={index === selected}
            onmouseenter={() => (selected = index)}
            onclick={() => ask({ kind: 'rename-space', space }, space.name)}
            oncontextmenu={(event) => void spaceMenu(space, event)}
            class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
          >
            <span class="min-w-0 flex-1 truncate text-xs text-ink-100">{space.name}</span>
            <span class="shrink-0 truncate text-[0.6875rem] text-ink-500">
              {spaceDetail(space)}
            </span>
          </button>
        </li>
      {/each}

      {#if spaceMatches.length > 0}
        <li class="mx-1 my-1.5 h-px bg-white/10" role="separator"></li>
      {/if}

      <li>
        <button
          type="button"
          aria-selected={selected === spaceMatches.length}
          onmouseenter={() => (selected = spaceMatches.length)}
          onclick={() => ask({ kind: 'new-space', project: null }, query.trim())}
          class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
        >
          <span
            class="icon-[ph--plus] shrink-0 text-base {selected === spaceMatches.length
              ? 'text-ink-200'
              : 'text-ink-500'}"
            aria-hidden="true"
          ></span>
          <span class="min-w-0 flex-1 truncate text-xs text-ink-100">New space</span>
        </button>
      </li>
    </ul>
  {/if}
</div>
