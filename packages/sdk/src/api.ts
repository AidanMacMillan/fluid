import { z } from 'zod'
import {
  TAB_ACTIVITIES,
  type Bookmark,
  type ExtensionInfo,
  type FileTabPayload,
  type Profile,
  type Project,
  type Space,
  type Tab,
  type TabActivityEntry,
  type TabFolder,
  type Task,
  type TaskNote
} from './models'
import { tabSplitSchema } from './splits'
import { TASK_COLORS, TASK_ICON_IDS } from './task-icons'

/**
 * Every operation the workspace offers, defined once.
 *
 * The app implements this table in its main process, and every caller reaches
 * the same implementation: the app's own windows over IPC, and extensions
 * in-process — including the Claude Code extension's sessions, through their
 * MCP tools. Nothing writes workspace
 * data any other way, which is what makes the events in `events.ts` a complete
 * account of what changed.
 *
 * Each method takes a single object, validated against its schema before the
 * implementation sees it, and resolves to the type named by `returns`.
 */

/** A method: its input schema, and (as a phantom) what it resolves to. */
export type Method<Input extends z.ZodType = z.ZodType, Output = unknown> = {
  input: Input
  /** Never read at runtime; carries the output type. */
  output?: Output
}

function method<Input extends z.ZodType>(
  input: Input
): { returns: <Output>() => Method<Input, Output> } {
  return {
    returns: <Output>(): Method<Input, Output> => ({ input })
  }
}

const id = z.string().min(1)
const title = z.string().nullable()

export const taskFactSchema = z.object({
  label: z.string(),
  value: z.string(),
  image: z.string().optional()
})

const taskIcon = z.enum(TASK_ICON_IDS)
const taskColor = z.enum(TASK_COLORS)

/** `extension.kind`: see `ExtensionTabType`. */
const extensionType = z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/, 'Expected extension.kind')

const browserPayload = z.object({
  url: z.string(),
  pageTitle: z.string().optional(),
  favicon: z.string().optional()
})
const filePayload = z.object({
  storageKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  sourcePath: z.string().optional(),
  thumbnail: z.string().optional()
})

const tabPlacement = {
  title: title.optional(),
  /** Pinned tabs go at the end of the pinned section, loose ones at the end of the strip. */
  pinned: z.boolean().optional(),
  /**
   * A folder in the same task to open the tab in, at the end of what it holds.
   * The tab takes the folder's section, whatever `pinned` says.
   */
  folderId: z.string().min(1).nullable().optional()
}

/** A slot among what a folder, or the top of a section, holds: 0 is first. Left out, the end. */
const placeIndex = z.number().int().min(0).optional()

/**
 * What a new tab is. The payload is checked against its type. A union rather
 * than a discriminated one because extension types are matched by pattern, not
 * by literal; no core type contains a dot, so no input can match two members.
 */
export const newTabSchema = z.union([
  z.object({
    type: z.literal('browser'),
    payload: browserPayload,
    pinnedUrl: z.string().nullable().optional(),
    profile: z.number().int().nullable().optional(),
    ...tabPlacement
  }),
  z.object({ type: z.literal('file'), payload: filePayload, ...tabPlacement }),
  z.object({
    type: extensionType,
    payload: z.record(z.string(), z.unknown()),
    pinnedUrl: z.string().nullable().optional(),
    ...tabPlacement
  })
])

/**
 * One row of a sidebar written whole (see `tabs.arrange`): a tab or a folder,
 * the folder it goes in, and which section. Listed parents first, so a row's
 * folder is always one listed before it.
 */
export const sidebarItemSchema = z.object({
  kind: z.enum(['tab', 'folder']),
  id,
  parentId: id.nullable(),
  pinned: z.boolean()
})

export type SidebarItem = z.input<typeof sidebarItemSchema>

/** A task's sidebar as `tabs.arrange` leaves it. */
export type SidebarArrangement = { tabs: Tab[]; folders: TabFolder[] }

export type NewTab = z.input<typeof newTabSchema>
/** A new tab after validation, as the app's implementation receives it. */
export type ValidNewTab = z.output<typeof newTabSchema>

const bookmarkFields = {
  label: z.string().trim().min(1),
  url: z.url(),
  icon: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  group: z.string().optional()
}

export const contract = {
  spaces: {
    list: method(z.object({})).returns<Space[]>(),
    create: method(z.object({ name: z.string().trim().min(1) })).returns<Space>(),
    rename: method(z.object({ id, name: z.string().trim().min(1) })).returns<Space>(),
    /** Deleting a space clears every session in it. The default space cannot be deleted. */
    delete: method(z.object({ id })).returns<void>()
  },

  projects: {
    list: method(z.object({})).returns<Project[]>(),
    get: method(z.object({ id })).returns<Project | null>(),
    /** The project the app is in. */
    active: method(z.object({})).returns<Project | null>(),
    setActive: method(z.object({ id })).returns<Project>(),
    /** Creates a project and makes it the active one. */
    create: method(
      z.object({
        name: z.string().trim().min(1),
        root: z.string().nullable().optional(),
        spaceId: id.optional()
      })
    ).returns<Project>(),
    rename: method(z.object({ id, name: z.string().trim().min(1) })).returns<Project>(),
    setRoot: method(z.object({ id, root: z.string().nullable() })).returns<Project>(),
    setSpace: method(z.object({ id, spaceId: id })).returns<Project>(),
    /**
     * Where work in a project starts — a terminal's shell, an editor, an
     * extension's session: its root, or the user's home when it has none or the root is not
     * there. The active project's, without an id.
     */
    workingDirectory: method(z.object({ id: id.optional() })).returns<string>(),
    /**
     * Deletes a project with all of its tasks, tabs and notes. `confirmation`
     * must be the project's name. The last project cannot be deleted.
     */
    delete: method(z.object({ id, confirmation: z.string() })).returns<void>()
  },

  tasks: {
    list: method(
      z.object({ projectId: id, status: z.enum(['open', 'settled']).optional() })
    ).returns<Task[]>(),
    get: method(z.object({ id })).returns<Task | null>(),
    /** Appends a task to the end of the project's strip. */
    create: method(
      z.object({
        projectId: id,
        title: title.optional(),
        type: extensionType.nullable().optional(),
        /** Defaults to `DEFAULT_TASK_ICON`. See `task-icons.ts`. */
        icon: taskIcon.optional(),
        /** Defaults to `DEFAULT_TASK_COLOR`. */
        color: taskColor.optional(),
        facts: z.array(taskFactSchema).nullable().optional()
      })
    ).returns<Task>(),
    update: method(
      z.object({
        id,
        title: title.optional(),
        icon: taskIcon.optional(),
        color: taskColor.optional(),
        facts: z.array(taskFactSchema).nullable().optional()
      })
    ).returns<Task>(),
    /**
     * Marks a task finished and takes it off the strip. Its tabs, notes and
     * history survive; what was running in its tabs is stopped.
     */
    settle: method(z.object({ id })).returns<Task>(),
    /** Puts a settled task back at the end of the strip. */
    reopen: method(z.object({ id })).returns<Task>(),
    /** Deletes a task and everything in it, including the files its tabs hold. */
    delete: method(z.object({ id })).returns<void>(),
    /** Rewrites the order of a project's open tasks. */
    reorder: method(z.object({ projectId: id, ids: z.array(id) })).returns<Task[]>(),
    /** Which tab the task opens on. */
    setActiveTab: method(z.object({ id, tabId: id.nullable() })).returns<Task>(),
    /**
     * Replaces the task's splits (see `TabSplit`). What is written is tidied
     * first: panes naming tabs the task does not hold are dropped, and so is
     * anything that leaves a split with fewer than two tabs.
     *
     * `activeTabId` moves the task to a tab in the same write, which is what a
     * tab dropped into a split wants: one change, rather than a split drawn
     * around the old tab for a moment before the new one is brought forward.
     */
    setSplits: method(
      z.object({ id, splits: z.array(tabSplitSchema), activeTabId: id.optional() })
    ).returns<Task>()
  },

  notes: {
    list: method(z.object({ taskId: id })).returns<TaskNote[]>(),
    get: method(z.object({ id })).returns<TaskNote | null>(),
    add: method(z.object({ taskId: id, body: z.string().min(1) })).returns<TaskNote>(),
    update: method(z.object({ id, body: z.string().min(1) })).returns<TaskNote>(),
    delete: method(z.object({ id })).returns<void>()
  },

  tabs: {
    list: method(z.object({ taskId: id })).returns<Tab[]>(),
    get: method(z.object({ id })).returns<Tab | null>(),
    /**
     * Opens a tab in a task — at the end of its section, or of a folder given
     * as `folderId`. Does not move the user; see `ui.reveal`.
     */
    open: method(z.object({ taskId: id, tab: newTabSchema })).returns<Tab>(),
    update: method(
      z.object({
        id,
        title: title.optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        viewState: z.unknown().optional()
      })
    ).returns<Tab>(),
    /**
     * Moves a tab to another task, keeping whether it is pinned. It leaves any
     * folder it was in, which stays behind.
     */
    move: method(z.object({ id, taskId: id })).returns<Tab>(),
    setPinned: method(z.object({ id, pinned: z.boolean() })).returns<Tab>(),
    /**
     * Says what work is going on in a tab, for its row to show: `working` while
     * it is under way, `waiting` while it is stopped on the user, `done` once it
     * has finished, null for nothing to report (see `TabActivity`). A tab the
     * user has open never keeps `done` — the app clears it as soon as they are
     * looking — so it can be set without asking whether they are. Nothing
     * survives a restart as `working` or `waiting`.
     */
    setActivity: method(
      z.object({ id, activity: z.enum(TAB_ACTIVITIES).nullable() })
    ).returns<Tab>(),
    /**
     * Says the user has seen a tab: takes `done` off it, and leaves `working`
     * alone. The app's window calls this for whichever tab is in front.
     */
    markSeen: method(z.object({ id })).returns<Tab>(),
    /**
     * Every tab in a project's open tasks that has something to report, for
     * the task strip to roll up into one dot per task.
     */
    activity: method(z.object({ projectId: id })).returns<TabActivityEntry[]>(),
    /**
     * Rewrites the order of a task's tabs. Each tab stays in the folder and
     * section it is in; only the order among tabs sharing one changes. To move
     * tabs between folders or sections, use `arrange`.
     */
    reorder: method(z.object({ taskId: id, ids: z.array(id) })).returns<Tab[]>(),
    /**
     * Moves a tab within its task's sidebar: into a folder (`folderId`), or out
     * to the top of a section (`folderId` null, with `pinned` saying which —
     * left out, the one it is in). `index` is its slot among what is there,
     * counted as it stands; left out, the end. A tab that changes section is
     * pinned or unpinned as `setPinned` would.
     */
    place: method(
      z.object({
        id,
        folderId: id.nullable(),
        pinned: z.boolean().optional(),
        index: placeIndex
      })
    ).returns<Tab>(),
    /**
     * Writes a task's sidebar whole: every tab and folder listed, parents
     * first, in the order they are drawn, each with the folder it goes in and
     * its section. What a drag in the sidebar ends with.
     *
     * A tab or folder moved across the divider is pinned or unpinned as
     * `setPinned` would. Whatever is in a folder takes the folder's section,
     * whichever it was listed with. Rows the task does not hold are ignored,
     * and so is anything it holds that is left out, which keeps its place.
     */
    arrange: method(
      z.object({ taskId: id, items: z.array(sidebarItemSchema) })
    ).returns<SidebarArrangement>(),
    /** Closes a tab and stops whatever was running in it. */
    close: method(z.object({ id })).returns<void>()
  },

  /** The folders in a task's sidebar (see `TabFolder`). */
  folders: {
    list: method(z.object({ taskId: id })).returns<TabFolder[]>(),
    get: method(z.object({ id })).returns<TabFolder | null>(),
    /**
     * Makes a folder at the end of a section, or at the end of another folder.
     * A folder made inside another is in that one's section, whatever
     * `pinned` says. Named `NEW_FOLDER_NAME` unless told otherwise.
     */
    create: method(
      z.object({
        taskId: id,
        name: z.string().trim().min(1).optional(),
        parentId: id.nullable().optional(),
        pinned: z.boolean().optional()
      })
    ).returns<TabFolder>(),
    update: method(
      z.object({ id, name: z.string().trim().min(1).optional(), collapsed: z.boolean().optional() })
    ).returns<TabFolder>(),
    /**
     * Moves a folder, with everything in it, within its task's sidebar: into
     * another folder (`parentId`), or out to the top of a section (`parentId`
     * null, with `pinned` saying which — left out, the one it is in). `index`
     * is as for `tabs.place`. Moving it across the divider pins or unpins
     * everything inside. A folder cannot go inside itself or anything it holds.
     */
    place: method(
      z.object({
        id,
        parentId: id.nullable(),
        pinned: z.boolean().optional(),
        index: placeIndex
      })
    ).returns<TabFolder>(),
    /**
     * Moves a folder, with everything in it, to another task in the same
     * project: to the end of its unpinned tabs, unpinning whatever it holds.
     */
    move: method(z.object({ id, taskId: id })).returns<TabFolder>(),
    /**
     * Deletes a folder and every folder in it, and closes every tab they hold
     * — stopping whatever was running in them, as `tabs.close` does.
     */
    delete: method(z.object({ id })).returns<void>()
  },

  files: {
    /**
     * Copies a file into the app's store and describes the copy, in exactly the
     * terms a file tab's payload holds it in: open one with
     * `tabs.open({ taskId, tab: { type: 'file', payload } })`. The copy is the
     * tab's from then on, and is removed when the tab is. `path` is absolute.
     */
    import: method(z.object({ path: z.string().min(1) })).returns<FileTabPayload>()
  },

  bookmarks: {
    /** The user's bookmarks followed by every enabled extension's. */
    list: method(z.object({})).returns<Bookmark[]>(),
    create: method(z.object(bookmarkFields)).returns<Bookmark>(),
    /** Only the user's own bookmarks can be changed. */
    update: method(
      z.object({
        id,
        label: bookmarkFields.label.optional(),
        url: bookmarkFields.url.optional(),
        icon: bookmarkFields.icon,
        keywords: bookmarkFields.keywords,
        group: bookmarkFields.group
      })
    ).returns<Bookmark>(),
    delete: method(z.object({ id })).returns<void>(),
    reorder: method(z.object({ ids: z.array(id) })).returns<Bookmark[]>()
  },

  profiles: {
    list: method(z.object({})).returns<Profile[]>(),
    /**
     * Signs out of every site in a profile within one space and clears what it
     * stored. Asks the user first; resolves false if they decline.
     */
    reset: method(
      z.object({ spaceId: id.nullable(), profile: z.number().int() })
    ).returns<boolean>()
  },

  settings: {
    get: method(z.object({ key: z.string() })).returns<unknown>(),
    set: method(z.object({ key: z.string(), value: z.unknown() })).returns<void>(),
    delete: method(z.object({ key: z.string() })).returns<void>(),
    all: method(z.object({})).returns<Record<string, unknown>>()
  },

  notifications: {
    /**
     * Posts a system notification. With a task, clicking it brings the app
     * forward on that task (and tab, if given).
     */
    show: method(
      z.object({
        title: z.string().min(1),
        body: z.string(),
        taskId: id.optional(),
        tabId: id.optional()
      })
    ).returns<void>()
  },

  extensions: {
    list: method(z.object({})).returns<ExtensionInfo[]>(),
    /** Enables or disables an extension. Disabling takes away everything it contributed. */
    setEnabled: method(z.object({ id, enabled: z.boolean() })).returns<ExtensionInfo>(),
    /**
     * Calls a method an extension exposes (see `ExtensionContext.rpc`). How an
     * extension's renderer code talks to its main-process half, and how one
     * extension talks to another.
     */
    call: method(
      z.object({ extensionId: id, method: z.string().min(1), input: z.unknown().optional() })
    ).returns<unknown>()
  },

  ui: {
    /**
     * Takes the user to a task, switching project if it is in another one, and
     * to one of its tabs if given. The only method that moves the user.
     */
    reveal: method(z.object({ taskId: id, tabId: id.nullable().optional() })).returns<void>()
  }
} as const

export type Contract = typeof contract
export type Namespace = keyof Contract
export type MethodName = {
  [N in Namespace]: `${N}.${Extract<keyof Contract[N], string>}`
}[Namespace]

type Lookup<M extends MethodName> = M extends `${infer N}.${infer K}`
  ? N extends Namespace
    ? K extends keyof Contract[N]
      ? Contract[N][K]
      : never
    : never
  : never

export type MethodInput<M extends MethodName> =
  Lookup<M> extends Method<infer I> ? z.input<I> : never
export type MethodParsedInput<M extends MethodName> =
  Lookup<M> extends Method<infer I> ? z.output<I> : never
export type MethodOutput<M extends MethodName> =
  Lookup<M> extends Method<z.ZodType, infer O> ? O : never

/** Every method name, for transports that route by name. */
export const METHOD_NAMES = Object.entries(contract).flatMap(([namespace, methods]) =>
  Object.keys(methods).map((name) => `${namespace}.${name}`)
) as MethodName[]

/** The schema for a method, or undefined for a name that is not in the contract. */
export function methodSchema(name: string): z.ZodType | undefined {
  const [namespace, key] = name.split('.')
  const methods = (contract as Record<string, Record<string, Method> | undefined>)[namespace]
  return methods?.[key]?.input
}
