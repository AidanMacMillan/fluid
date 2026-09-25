import { homedir } from 'os'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { chooseDirectory, isDirectory, resolveDirectory, usableCwd } from './directories'
import {
  countOpenTasks,
  createProject as createProjectRow,
  deleteProject as deleteProjectRow,
  firstProject,
  getProject,
  listProjects,
  updateProject
} from './db/projects'
import { getSetting, setSetting } from './db/settings'
import { spaceMenuItems, spaceRows, type SpaceRow } from './spaces'
import { DEFAULT_SPACE_ID } from './browsing'
import type { Project } from './db/schema'

/**
 * Which project the app is working in, and what that means to everything that
 * has to start somewhere.
 *
 * The selection is one setting rather than a column on anything: it is where
 * the user is, not a fact about a project, and it is read from both sides —
 * the window draws the strip from it, and the main process answers "where
 * would a new terminal start" from it without a window having to say.
 *
 * The picker itself is a window of its own; see src/main/project-window.ts.
 */

/** Settings row holding the selected project's id. */
const ACTIVE_PROJECT_KEY = 'project.active'

/**
 * One project as the picker draws it: what the row says, plus the one thing
 * about it only this side can answer.
 */
export type ProjectRow = {
  id: string
  name: string
  /** The folder, or null for a project that has none and so starts at home. */
  root: string | null
  /**
   * Whether `root` is not a directory right now. Kept rather than cleared — an
   * unmounted volume this morning is still where the work lives — but work
   * started in the project falls back to home for as long as it is away, and
   * the row says so.
   */
  missing: boolean
  /**
   * The browsing world the project's pages live in. Carried on the row rather
   * than looked up, because both readers need it on sight: the picker draws the
   * name on the row, and the window hands the id to every view it opens (see
   * src/main/browsing.ts).
   */
  spaceId: string
  spaceName: string
}

/** Everything the picker and the top bar need, in one answer. */
export type ProjectsState = {
  projects: ProjectRow[]
  /** Every space, for the rows to be named against and for the picker to manage. */
  spaces: SpaceRow[]
  /** The selected project. Null only while there are no projects at all. */
  activeId: string | null
  /** The user's home, which is what a project with no root starts in. */
  home: string
}

export async function projectsState(): Promise<ProjectsState> {
  const [projects, spaces, active] = await Promise.all([
    listProjects(),
    spaceRows(),
    activeProject()
  ])
  const names = new Map(spaces.map((space) => [space.id, space.name]))

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      missing: project.root !== null && !isDirectory(project.root),
      spaceId: project.spaceId,
      // A space is always there to be named — the foreign key says so — but a
      // row drawn with an empty label would be a worse way to find that out.
      spaceName: names.get(project.spaceId) ?? 'Default'
    })),
    spaces,
    activeId: active?.id ?? null,
    home: homedir()
  }
}

/**
 * The project the app is in. Falls back to the first one whenever the stored id
 * names nothing — a first launch, or a project deleted from under the setting —
 * and writes that fallback back, so the answer is stable from then on.
 *
 * Undefined only if there are no projects at all, which the migration and
 * `deleteProject` between them rule out.
 */
export async function activeProject(): Promise<Project | undefined> {
  const id = await getSetting<string>(ACTIVE_PROJECT_KEY)
  if (id !== undefined) {
    const project = await getProject(id)
    if (project) return project
  }

  const first = await firstProject()
  if (first) await setSetting(ACTIVE_PROJECT_KEY, first.id)
  return first
}

/** Moves the app to a project. The id is checked, so a stale one cannot be stored. */
export async function setActiveProject(id: string): Promise<Project | undefined> {
  const project = await getProject(id)
  if (!project) return activeProject()

  await setSetting(ACTIVE_PROJECT_KEY, project.id)
  return project
}

/**
 * Where work in the current project starts: a terminal's shell, an
 * editor tab, an extension's session.
 *
 * A root that is not there falls back to home for this one tab rather than
 * being cleared — a volume that is not mounted is not the user changing their
 * mind about where their work lives — which is exactly what the preference this
 * replaced did.
 */
export async function projectRoot(): Promise<string> {
  return usableCwd((await activeProject())?.root)
}

/**
 * Makes a project from what the picker collected, and moves to it. Creating one
 * is how you say you are about to work on it, so selecting it afterwards would
 * be a second step that nobody would ever not take.
 *
 * The root is checked here rather than taken on trust, the same way the
 * terminal preference was: a path that names nothing would leave a project that
 * reads as pointed somewhere while every shell quietly opened at home.
 */
export async function createProject(
  name: string,
  root: string | null,
  spaceId?: string
): Promise<Project> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('Name the project.')

  // The space you are already working in, unless the caller said otherwise.
  // Making a project is usually making another one of the same kind of thing,
  // and for anyone who has never made a space this is the default space anyway
  // — so the rule costs nothing to learn and is right when it matters.
  const space = spaceId ?? (await activeProject())?.spaceId ?? DEFAULT_SPACE_ID

  const project = await createProjectRow(
    trimmed,
    root === null ? null : resolveDirectory(root),
    space
  )
  await setSetting(ACTIVE_PROJECT_KEY, project.id)
  return project
}

/**
 * The folder for a project that does not exist yet, chosen before it is made.
 *
 * A project is a name and a folder, and the folder half is not something anyone
 * types — so the picker collects the name in its own field and then opens this,
 * the way the launcher's editor row opens the OS picker rather than asking for
 * a path (see `folder` in src/renderer/src/lib/launcher-actions.ts).
 *
 * Null when the picker was cancelled, which leaves the name where it was typed:
 * changing your mind about the folder is not changing your mind about the
 * project.
 */
export async function chooseNewProjectRoot(
  parent: BrowserWindow | null,
  name: string
): Promise<string | null> {
  return chooseDirectory(parent, { title: `Choose the folder for ${name.trim() || 'the project'}` })
}

/** Renames a project. Its root, tasks and selection are untouched. */
export async function renameProject(id: string, name: string): Promise<Project | undefined> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('Name the project.')
  return updateProject(id, { name: trimmed })
}

/**
 * Asks for a different folder for a project, from the OS picker. Null when the
 * picker was cancelled. Pointing the project at it is the API's `projects.setRoot`.
 *
 * Only the next thing opened moves: a shell already running stays where it is,
 * the way it did when this was a preference (see the note at the foot of the
 * old settings card).
 */
export async function chooseProjectDirectory(
  parent: BrowserWindow | null,
  id: string
): Promise<string | null> {
  const project = await getProject(id)
  if (!project) return null

  return chooseDirectory(parent, {
    title: `Choose the folder for ${project.name}`,
    startAt: project.root
  })
}

/**
 * How much a deletion would take with it, for the confirmation to say. Counted
 * rather than guessed at: the picker asks the user to type the project's name
 * back, and a warning that cannot say what is at stake is not worth typing for.
 */
export async function projectDeletion(id: string): Promise<{ name: string; tasks: number } | null> {
  const project = await getProject(id)
  if (!project) return null
  return { name: project.name, tasks: await countOpenTasks(id) }
}

/**
 * Deletes a project, its tasks, and everything under them.
 *
 * The name is required and has to match, which is the picker's confirmation
 * arriving as an argument rather than as a promise the panel made: this is the
 * one call in the app that destroys work the user cannot get back, and it
 * should not be possible to make it by accident from anywhere.
 *
 * The selection is left alone. Whether the app has to move is the window's
 * question — it is the side that knows which project it is drawing — and it is
 * answered when the new state reaches it.
 */
export async function deleteProject(id: string, confirmation: string): Promise<ProjectsState> {
  const project = await getProject(id)
  if (!project) return projectsState()

  if (confirmation.trim() !== project.name) {
    throw new Error(`Type ${project.name} to delete it.`)
  }

  await deleteProjectRow(id)

  // The stored selection may be the row that just went; asking for the active
  // project is what puts it back on the first one.
  await activeProject()
  return projectsState()
}

/**
 * What the picker's row menu was asked for.
 *
 * A union rather than a string since the space rows arrived: moving a project
 * carries which space it is moving to, and `new-space` carries nothing because
 * the space does not exist yet — the panel asks for its name and makes it.
 */
export type ProjectMenuChoice =
  | { kind: 'rename' }
  | { kind: 'root' }
  | { kind: 'clear-root' }
  | { kind: 'delete' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'new-space' }

/**
 * The menu on a project row in the picker: rename it, point it somewhere else
 * or at nothing, or delete it.
 *
 * Native, for the reason src/main/profile-menu.ts gives — the picker's window
 * is sized to the panel inside it, so a menu drawn in that document would be
 * clipped by the window's own edge a row or two down.
 *
 * It only reports what was asked for. Three of its answers are finished by the
 * panel itself, in the field it already has: a name is typed, a deletion is
 * confirmed by typing the name back, and a new space is named. The panel
 * therefore has to survive the menu, which is what the hold around this call is
 * for (see `holdProjectWindow`).
 */
export function popupProjectMenu(
  window: BrowserWindow | null,
  project: { name: string; last: boolean; spaceId: string; root: string | null },
  spaces: SpaceRow[]
): Promise<ProjectMenuChoice | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: ProjectMenuChoice | null): void => {
      if (settled) return
      settled = true
      resolve(choice)
    }

    const items: MenuItemConstructorOptions[] = [
      { label: 'Rename…', click: () => settle({ kind: 'rename' }) },
      {
        label: project.root === null ? 'Choose Folder…' : 'Change Folder…',
        click: () => settle({ kind: 'root' })
      },
      // Back to no folder at all, so work starts in home. Greyed on a project
      // that already has none, for the reason Delete is greyed below.
      {
        label: 'Remove Folder',
        enabled: project.root !== null,
        click: () => settle({ kind: 'clear-root' })
      },
      // Which browsing world the project's pages live in. A submenu rather than
      // a flat list, because it is open-ended — there is no cap on spaces — and
      // because it is the one item on this menu that is a choice among things
      // rather than a verb. Shaped like the profile menu it rhymes with: the
      // current one ticked, and the way to another below a line.
      {
        label: 'Space',
        submenu: spaceMenuItems(spaces, project.spaceId, (spaceId) =>
          settle(spaceId === null ? { kind: 'new-space' } : { kind: 'space', spaceId })
        )
      },
      { type: 'separator' },
      {
        label: 'Delete…',
        // The last project cannot go — every task belongs to one, and an app
        // with none has nothing to draw. Shown greyed rather than left out, so
        // the menu does not change shape as projects come and go.
        enabled: !project.last,
        click: () => settle({ kind: 'delete' })
      }
    ]

    const menu = Menu.buildFromTemplate(items)

    // A choice settles this from the item's own click handler; the close
    // callback only answers for a menu that was dismissed. Which of the two
    // runs first is not something Electron promises, so the dismissal is
    // deferred a turn and a click in the same turn wins either way round — the
    // same dance `popupProfileMenu` does, and for the same reason.
    const close = (): void => {
      setTimeout(() => settle(null), 0)
    }

    if (window && !window.isDestroyed()) menu.popup({ window, callback: close })
    else menu.popup({ callback: close })
  })
}

/** Every project, for the picker to draw. */
export { listProjects }
