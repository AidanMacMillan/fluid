import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid
} from 'drizzle-orm/pg-core'
import {
  CORE_TAB_TYPES,
  DEFAULT_TASK_COLOR,
  DEFAULT_TASK_ICON,
  TAB_ACTIVITIES,
  TASK_COLORS,
  type TabActivity,
  type TabSplit,
  type TabType,
  type TaskColor,
  type TaskFact,
  type TaskIcon
} from '@fluid/sdk'
import { DEFAULT_SPACE_ID } from '../browsing'
import { PROFILES } from '../profiles'

/**
 * A `jsonb` column that hands back what PGlite read, untouched.
 *
 * PGlite parses `jsonb` itself, so a value arrives as the JSON it was written
 * as. drizzle's own `jsonb` then runs `JSON.parse` on anything that is still a
 * string, which turns a stored `"1789742088.627119"` into a number and `"true"`
 * into a boolean. Written the same way drizzle's is, so the stored form and the
 * migrations are unchanged.
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value
})

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date())

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/**
 * A browsing world: a set of projects whose pages cannot see each other's
 * logins, whichever profile any of them is using.
 *
 * A profile answers "who am I on this site"; a space answers "which life is
 * this". Work and personal both have a default profile, and before spaces those
 * two were the same cookie jar — so signing into a site for one signed you into
 * it for the other, and there was no way to say otherwise short of spending one
 * of the five profiles on it and remembering which. A space is what makes that
 * separation structural rather than remembered: every project is in exactly
 * one, and every session a project opens is scoped to it (see
 * src/main/browsing.ts).
 *
 * There is always at least one — the default space, whose id is fixed at
 * `DEFAULT_SPACE_ID` so that a partition name can be built without asking the
 * database. Deleting it is refused; everything else about it is ordinary.
 */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the user calls it. The whole of how a space is identified. */
    name: text('name').notNull(),
    /** Order in the picker, on the same terms as `projects.position`. */
    position: integer('position').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [index('spaces_position_idx').on(table.position)]
)

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * A body of work with a folder behind it, and the frame everything else in the
 * app sits inside: every task belongs to one, and the strip across the top
 * shows one project's tasks at a time.
 *
 * What a project *is* is almost entirely its root. A terminal, an editor tab
 * and an extension's session all have to start somewhere, and before projects existed
 * that somewhere was a single global preference — which said, in effect, that
 * the user works on one thing. The root moving here is the whole point of the
 * table: switching project is how you say that the next shell, the next
 * session and the next editor are about something else.
 *
 * There is always at least one. The database starts with one (see
 * resources/migrations/0000_baseline.sql), and deleting the last one is
 * refused — a task has to belong somewhere, and so does the strip.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the user calls it. Never derived from the root — it is a label. */
    name: text('name').notNull(),
    /**
     * The folder the work is in, as an absolute path. Null is the user's home,
     * which is what the preference this replaces meant by being unset, and so
     * what the migrated project says when the user had never set one.
     *
     * Kept even while it is not there — an unmounted volume this morning is
     * still where the work lives — and resolved on the way out instead: see
     * `projectRoot` in src/main/projects.ts, which falls back to home for as
     * long as the folder is away.
     */
    root: text('root'),
    /**
     * Which browsing world the project's pages live in. Every project has one;
     * a project made without saying lands in the default space, which is where
     * every project that predates spaces already is.
     *
     * `restrict` rather than `cascade` or `set null`: a space going must never
     * take projects with it, and a project must never be left in no space at
     * all. Deleting a space moves its projects to the default one first and
     * then deletes the row — see `deleteSpace`, which this constraint is the
     * backstop for.
     */
    spaceId: uuid('space_id')
      .notNull()
      .default(DEFAULT_SPACE_ID)
      .references(() => spaces.id, { onDelete: 'restrict' }),
    /**
     * Order in the picker. Not unique, for the reason given on `tabs.position`,
     * and meaningful beyond the ordering in one place: the first project is
     * where background routines file the tasks they open, since a routine runs
     * on a timer and has no user in front of it to ask.
     */
    position: integer('position').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [
    index('projects_position_idx').on(table.position),
    index('projects_space_id_idx').on(table.spaceId)
  ]
)

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** A task is either still being worked (`open`) or finished with (`settled`). */
export const taskStatus = pgEnum('task_status', ['open', 'settled'])

/**
 * What kind of work a task is, for the tasks that are a kind of work at all.
 * Most are not — a task is whatever the user opened it for — so a type is
 * something a task may carry rather than something it has.
 *
 * Types are contributed by extensions and always namespaced `extension.kind`
 * (see `TaskTypeContribution` in the SDK). Which ones exist depends on which
 * extensions are installed, so the check below holds only the shape: a task
 * whose extension has gone keeps its type, and is drawn as an ordinary task
 * until the extension comes back.
 */
export type TaskType = string

/**
 * The shape an extension-contributed type takes, for both tasks and tabs:
 * `extension.kind`, lowercase. Kept in step with `extensionType` in the SDK.
 */
const NAMESPACED_TYPE = '^[a-z0-9-]+\\.[a-z0-9-]+$'

export type { TaskFact } from '@fluid/sdk'

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Which project this task is part of. Not nullable: a task is always about
     * something, the strip is built by asking a project for its tasks, and a
     * row belonging to no project would simply never be drawn.
     *
     * Cascading, which is what makes deleting a project the serious act the
     * picker treats it as — the tasks go, and their tabs, notes and clipboard
     * history go with them.
     */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // A task is a unit of work first; the title is a human label, not an
    // identity, so it stays nullable.
    title: text('title'),
    /** What kind of work this is; null for a task that is only ever itself. */
    type: text('type').$type<TaskType>(),
    /**
     * The glyph on the task's tab, by its id in `TASK_ICONS` (see the SDK's
     * task-icons.ts). Every task has one; a new one wears the default until the
     * user, or the extension that made it, picks another.
     *
     * Unlike the colour below, not held to the list by a check: the list is
     * curated and will be re-curated, and a task still wearing an icon that has
     * since been dropped is drawn with the default rather than refused.
     */
    icon: text('icon').$type<TaskIcon>().notNull().default(DEFAULT_TASK_ICON),
    /** The colour that glyph is drawn in: one of `TASK_COLORS`. */
    color: text('color').$type<TaskColor>().notNull().default(DEFAULT_TASK_COLOR),
    /**
     * What is known about the work, for the panel above the pinned tabs. Null
     * for a task that has nothing to say there: everything the user opened for
     * themselves, and any typed task whose lookups came back empty.
     *
     * A column on the task rather than a table of its own because these are
     * written once, together, and only ever read together — they are a single
     * description of the work, not rows anybody queries across.
     */
    facts: jsonb('facts').$type<TaskFact[]>(),
    status: taskStatus('status').notNull().default('open'),
    /**
     * The focused tab in this task's strip. Null only when the task has no
     * tabs — `createTab` adopts the first tab it adds, and `closeTab` hands
     * focus to a neighbour, so a task with tabs always has an active one.
     *
     * tasks → tabs → tasks is circular. The explicit `AnyPgColumn` return
     * annotation is drizzle's prescribed way to break that cycle; without it
     * TypeScript gives up and `.returning()` on this table degrades to the raw
     * driver result type.
     */
    activeTabId: uuid('active_tab_id').references((): AnyPgColumn => tabs.id, {
      onDelete: 'set null'
    }),
    /**
     * Its tabs drawn side by side (see `TabSplit`). A column rather than a
     * table for the reason `facts` is one: a task's splits are written
     * together and read together, and nothing ever queries across them.
     *
     * Not a foreign key to its tabs, which jsonb cannot be — so the API prunes
     * a tab from here whenever the tab leaves the task (see `pruneSplits`).
     */
    splits: jsonb('splits').$type<TabSplit[]>().notNull().default([]),
    /** Order within the task strip. Not unique, for the reason given on `tabs.position`. */
    position: integer('position').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [
    // The strip's own query: one project's open tasks, in order.
    index('tasks_project_id_status_position_idx').on(table.projectId, table.status, table.position),
    // Null passes: a check is satisfied by anything that is not false, which is
    // what keeps `type` optional without a second constraint saying so.
    check('tasks_type_check', sql.raw(`"type" is null or "type" ~ '${NAMESPACED_TYPE}'`)),
    check(
      'tasks_color_check',
      sql.raw(`"color" in (${TASK_COLORS.map((value) => `'${value}'`).join(', ')})`)
    )
  ]
)

// ---------------------------------------------------------------------------
// Task notes
// ---------------------------------------------------------------------------

/**
 * Free-form notes left on a task, often by agents. Notes are anonymous: there
 * is no author column, so nothing here distinguishes an agent from a person.
 */
export const taskNotes = pgTable(
  'task_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [index('task_notes_task_id_created_at_idx').on(table.taskId, table.createdAt)]
)

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * The tab kinds the app knows about. Stored as `text` guarded by a check
 * constraint rather than a Postgres enum: the set is still being designed, and
 * a check is a drop-and-recreate to rename or remove a value, where an enum
 * makes that genuinely painful.
 *
 * This array is the single source of truth — the constraint SQL is generated
 * from it, so adding a kind here is the whole change.
 */
export { CORE_TAB_TYPES }
export type { Tab, TabType } from '@fluid/sdk'

export type {
  BrowserTabPayload,
  DocumentViewState,
  FileTabPayload,
  FileViewState,
  ImageViewState
} from '@fluid/sdk'

export const tabs = pgTable(
  'tabs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * The folder the tab is in (see `tabFolders`), or null for the top of its
     * section. Null as well as `set null` on delete: deleting a folder is meant
     * to close its tabs, and the API does that first (see `folders.delete`) —
     * this is only the backstop for a tab that turned up in the meantime, which
     * is better drawn at the top of its section than taken without teardown.
     */
    folderId: uuid('folder_id').references((): AnyPgColumn => tabFolders.id, {
      onDelete: 'set null'
    }),
    type: text('type').$type<TabType>().notNull(),
    title: text('title'),
    /**
     * Order among the tab's siblings: whatever else sits directly in the same
     * folder, or at the top of the same section — the folders there included,
     * whose positions are counted on the same terms. Never compared across two
     * of those, so a new row only ever has to sort past its siblings, and the
     * task's largest position does that wherever it is (see `nextPosition`).
     *
     * Deliberately NOT unique: a unique index would reject the intermediate
     * state of a two-row position swap unless it were deferrable, so the order
     * is kept by rewriting the whole sidebar inside a transaction (see tabs.ts).
     */
    position: integer('position').notNull(),
    /**
     * Whether this tab belongs to the task rather than merely being open in it.
     * The sidebar draws the pinned ones as a section of their own above the
     * rest (see Sidebar.svelte), which is what a task's own work looks like
     * next to whatever got opened along the way.
     *
     * Any kind of tab can be pinned. This was once `pinnedUrl is not null` —
     * a pin *was* the address it held you to — which made the two kinds with an
     * address the only two that could belong to a task, and left no way to say
     * that a task is about this repository or this shell. The two questions are
     * now separate columns: this one is which section, and `pinnedUrl` is where
     * the tab comes home to, for the one kind that can wander off.
     */
    pinned: boolean('pinned').notNull().default(false),
    /**
     * Where a pinned tab comes home to, for a tab that can leave. Null for
     * every tab that cannot, pinned or not.
     *
     * This is what a pinned tab's close affordance reads: one still on its own
     * page offers to be removed, while one that has wandered offers to be sent
     * back instead. That difference is half of what pinning buys — the tab
     * survives being closed, and it always knows where to open.
     *
     * A browser tab is the kind that can wander, and its address is the page it
     * was pinned on. An extension's tab can record one as well — a chat thread
     * its permalink — though it cannot wander, because a link to it found in a
     * page should lead to the tab the task already has (see `pinnedTo` in the
     * renderer's workspace). A terminal, a file and an editor have no address at
     * all: what pinning means for them is the section, and nothing else.
     *
     * Non-null implies pinned: unpinning clears it, because an address to come
     * home to is meaningless for a tab that has nowhere to be sent back from.
     */
    pinnedUrl: text('pinned_url'),
    /**
     * Which browsing profile this tab's page runs in — see src/main/profiles.ts.
     * Null is the default profile, which is what nearly every tab is.
     *
     * Stored rather than derived, and restored with the tab, because it is not
     * recoverable from anything else the row holds: a tab reopened in the wrong
     * profile comes back signed in as somebody else, and looks exactly like one
     * that came back correctly. The colour on the row is the only tell.
     *
     * Only a browser tab can hold one: a profile is a set of cookies, and
     * nothing else here makes requests. The check below is what says so, and it
     * is also what holds the column to the five profiles that exist.
     */
    profile: integer('profile'),
    /**
     * Work going on in the tab, as whatever does it reports — see `TabActivity`
     * in the SDK. Null for nothing to report.
     *
     * Stored with the tab rather than held in memory so that every read of a
     * tab carries it, and so that `done` outlives a restart: work that finished
     * while the user was away is still unseen when they come back. `working`
     * and `waiting` cannot outlive one — whatever was working went with the
     * app — and are cleared on the way up (see `clearStaleActivity`).
     */
    activity: text('activity').$type<TabActivity>(),
    /** Type-specific state; shape is discriminated by `type`, not by a field. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** How the user left the tab looking. Null until they move something. */
    viewState: jsonb('view_state').$type<unknown>(),
    createdAt,
    updatedAt
  },
  (table) => [
    index('tabs_task_id_position_idx').on(table.taskId, table.position),
    check(
      'tabs_type_check',
      sql.raw(
        `"type" in (${CORE_TAB_TYPES.map((value) => `'${value}'`).join(', ')}) or "type" ~ '${NAMESPACED_TYPE}'`
      )
    ),
    // Only a tab with an address can be sent home to one: a browser tab, or an
    // extension's tab that says it has one (see `TabTypeContribution.pinnedUrl`).
    check(
      'tabs_pinned_url_check',
      sql.raw(`"pinned_url" is null or "type" = 'browser' or "type" ~ '${NAMESPACED_TYPE}'`)
    ),
    check(
      'tabs_activity_check',
      sql.raw(
        `"activity" is null or "activity" in (${TAB_ACTIVITIES.map((value) => `'${value}'`).join(', ')})`
      )
    ),
    check(
      'tabs_profile_check',
      sql.raw(
        `"profile" is null or ("type" = 'browser' and "profile" in (${PROFILES.map((profile) => profile.id).join(', ')}))`
      )
    )
  ]
)

// ---------------------------------------------------------------------------
// Tab folders
// ---------------------------------------------------------------------------

/**
 * A named group in a task's sidebar, holding tabs and other folders.
 *
 * A folder is a thing the sidebar draws rather than a thing a tab *is*: a tab
 * knows which folder it is in and nothing more, and every write that knows
 * nothing of folders — opening a tab, moving it to another task — goes on
 * working by landing it at the top of a section. What the sidebar looks like is
 * built from the two tables together (see `sidebarTree` in the SDK), and is
 * forgiving about rows that disagree.
 *
 * Its section is its own `pinned`, which everything inside it shares: the API
 * keeps a folder's tabs and folders in step with it whenever it moves across
 * the divider (see `tabs.arrange`).
 */
export const tabFolders = pgTable(
  'tab_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cascading, like a tab's: a folder is part of the task it is drawn in. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * The folder this one is in, or null for the top of its section. Cascading,
     * because the folder it was in going is this one going too — the API closes
     * the tabs the pair of them held before either row is deleted.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => tabFolders.id, {
      onDelete: 'cascade'
    }),
    /** What the user calls it. Never empty: the API refuses a blank name. */
    name: text('name').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    /** Whether the sidebar is hiding what is in it. */
    collapsed: boolean('collapsed').notNull().default(false),
    /** Order among its siblings, on the terms given on `tabs.position`. */
    position: integer('position').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [index('tab_folders_task_id_idx').on(table.taskId)]
)

// ---------------------------------------------------------------------------
// Clipboard history
// ---------------------------------------------------------------------------

/**
 * What a copied thing turned out to be. Read off the clipboard's own formats
 * rather than guessed at: the system pasteboard carries every representation
 * the source could offer at once, and this names the richest of them that
 * arrived.
 *
 * `rich-text` is not a separate thing from `text` so much as text that brought
 * formatting with it — every rich entry has a plain form too, which is what the
 * panel draws when it cannot draw the formatting. `files` is a copy of files
 * themselves rather than of anything in them, and keeps their absolute paths as
 * its text, one to a line. Stored as `text` guarded by a
 * check constraint rather than a Postgres enum: a check is a drop-and-recreate
 * to change, where an enum makes renaming or removing a value genuinely painful.
 */
export const CLIPBOARD_KINDS = ['text', 'rich-text', 'image', 'files'] as const

export type ClipboardKind = (typeof CLIPBOARD_KINDS)[number]

/**
 * Everything copied while a task was in front, newest last.
 *
 * The rows are a record of what passed through the system clipboard rather than
 * of anything the app did: copying is caught by sampling the pasteboard (see
 * src/main/clipboard-capture.ts), which is the only way Electron offers, so an
 * entry here is a copy from a page, a terminal, a thread or a file view without
 * any of those having had to say so.
 *
 * Which task an entry belongs to is simply whichever one was selected when it
 * was copied. That is a weaker claim than it looks — the clipboard is one
 * global thing and a task is a frame around some work — but it is the claim the
 * feature is for: what did I copy while I was doing this.
 */
export const clipboardEntries = pgTable(
  'clipboard_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ClipboardKind>().notNull(),
    /**
     * The plain-text form, which nearly everything has one of — an image copied
     * out of a page is the one kind that does not, and it stores the empty
     * string rather than a null. Not nullable because this is what the panel
     * filters against and what it falls back to drawing: a column that is
     * sometimes absent would make both of those ask a question they do not
     * otherwise have to.
     */
    text: text('text').notNull(),
    /**
     * The markup exactly as it was copied, and deliberately never rendered.
     * It exists so that putting the entry back on the clipboard puts back what
     * was taken off it, byte for byte — see `safeHtml` for the half that is
     * drawn.
     */
    html: text('html'),
    /** The same, for the RTF representation. Kept and restored, never read. */
    rtf: text('rtf'),
    /**
     * `html` after the sanitiser has had it: the same content reduced to a
     * closed allowlist of presentational tags, with every script, style,
     * handler and resource-bearing attribute dropped rather than repaired (see
     * src/renderer/src/lib/clipboard-html.ts).
     *
     * Two columns rather than one because the two are answers to different
     * questions. What goes back on the clipboard has to be what was copied, or
     * pasting silently loses formatting the source meant; what gets drawn into
     * the panel's own document has to be something that cannot act. Nothing can
     * be both, so nothing tries.
     *
     * Written once, at capture, rather than on the way to the screen: the panel
     * is opened far more often than a thing is copied, and a sanitiser run per
     * render would be the same work done repeatedly for the same answer.
     */
    safeHtml: text('safe_html'),
    /**
     * Where the image lives in the app's file store, for an image entry. Null
     * for everything else — and also for an image too large to be worth
     * keeping, which is recorded as an entry with its size and nothing else, so
     * the history says a picture was copied rather than quietly skipping it.
     */
    storageKey: text('storage_key'),
    /** A small preview, as a `data:` URL, for the same reason a file tab has one. */
    thumbnail: text('thumbnail'),
    /** The image's natural size, in pixels. Null for everything that is not one. */
    width: integer('width'),
    height: integer('height'),
    /** Bytes: the encoded PNG for an image, the plain text's own length otherwise. */
    size: integer('size').notNull().default(0),
    createdAt
  },
  (table) => [
    index('clipboard_entries_task_id_created_at_idx').on(table.taskId, table.createdAt),
    check(
      'clipboard_entries_kind_check',
      sql.raw(`"kind" in (${CLIPBOARD_KINDS.map((value) => `'${value}'`).join(', ')})`)
    )
  ]
)

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Key/value store for app-level preferences. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt
})

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

/**
 * The user's own bookmarks: the places worth one keystroke from the launcher.
 *
 * Only the user's. Extensions supply bookmarks too, but live, while they are
 * enabled — never as rows here — so that updating or removing an extension
 * updates or removes what it offered (see src/main/api/bookmarks.ts).
 */
export const bookmarks = pgTable(
  'bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    /** An address an `<img>` can load, usually a `data:` URL. */
    icon: text('icon'),
    keywords: jsonb('keywords').$type<string[]>(),
    /** The launcher section it is drawn under. */
    group: text('group'),
    position: integer('position').notNull(),
    createdAt,
    updatedAt
  },
  (table) => [index('bookmarks_position_idx').on(table.position)]
)

// ---------------------------------------------------------------------------
// Extension storage
// ---------------------------------------------------------------------------

/**
 * Each extension's private key–value store (`ctx.storage` in the SDK). One
 * table for all of them rather than tables of their own, so installing an
 * extension never needs a migration.
 */
export const extensionStorage = pgTable(
  'extension_storage',
  {
    extensionId: text('extension_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt
  },
  (table) => [primaryKey({ columns: [table.extensionId, table.key] })]
)

// ---------------------------------------------------------------------------
// Site icons
// ---------------------------------------------------------------------------

/**
 * Favicons, remembered per site rather than per tab.
 *
 * A browser tab's payload already keeps the icon of the page it last had open,
 * which covers every tab that has been looked at. What it cannot cover is the
 * tab that has not: a pinned tab restored on launch has no view, and so nothing
 * to report an icon, until the moment somebody clicks it — which is the one
 * moment the icon was no longer needed. Released pinned tabs have the same gap
 * for a different reason: the release throws the stored icon away with the page
 * it described (see `releasePinnedTab`).
 *
 * So this is where those rows get their picture from. It is keyed by origin,
 * which is the unit a favicon actually belongs to, and it is shared across
 * every task: the first tab anywhere to visit a site fills it in, and every
 * other tab on that site draws from it without a load of its own.
 *
 * Purely a cache — losing it costs a launch's worth of generic glyphs and
 * nothing else. `dataUrl` is null for a site that was asked and turned out to
 * have no icon of its own, which is worth keeping so it is not asked again
 * every launch; `fetchedAt` is what lets that answer expire.
 */
export const siteIcons = pgTable('site_icons', {
  /** `https://github.com` — scheme, host and port, never a path. */
  origin: text('origin').primaryKey(),
  /** The icon inlined as a `data:` URL, or null for a site that has none. */
  dataUrl: text('data_url'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
})

// ---------------------------------------------------------------------------
// Relations (enables db.query.tasks.findMany({ with: { notes: true } }))
// ---------------------------------------------------------------------------

export const spacesRelations = relations(spaces, ({ many }) => ({
  projects: many(projects)
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  space: one(spaces, { fields: [projects.spaceId], references: [spaces.id] }),
  tasks: many(tasks)
}))

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  notes: many(taskNotes),
  tabs: many(tabs),
  folders: many(tabFolders),
  clipboardEntries: many(clipboardEntries)
}))

export const taskNotesRelations = relations(taskNotes, ({ one }) => ({
  task: one(tasks, { fields: [taskNotes.taskId], references: [tasks.id] })
}))

export const tabsRelations = relations(tabs, ({ one }) => ({
  task: one(tasks, { fields: [tabs.taskId], references: [tasks.id] }),
  folder: one(tabFolders, { fields: [tabs.folderId], references: [tabFolders.id] })
}))

export const tabFoldersRelations = relations(tabFolders, ({ one, many }) => ({
  task: one(tasks, { fields: [tabFolders.taskId], references: [tasks.id] }),
  parent: one(tabFolders, {
    fields: [tabFolders.parentId],
    references: [tabFolders.id],
    relationName: 'nested'
  }),
  folders: many(tabFolders, { relationName: 'nested' }),
  tabs: many(tabs)
}))

export const clipboardEntriesRelations = relations(clipboardEntries, ({ one }) => ({
  task: one(tasks, { fields: [clipboardEntries.taskId], references: [tasks.id] })
}))

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type TaskStatus = (typeof taskStatus.enumValues)[number]

export type Space = typeof spaces.$inferSelect
export type NewSpace = typeof spaces.$inferInsert

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert

export type TabFolderRow = typeof tabFolders.$inferSelect

export type TaskNote = typeof taskNotes.$inferSelect
export type NewTaskNote = typeof taskNotes.$inferInsert

/**
 * One thing that was copied. Not narrowed on `kind` the way a tab is on its
 * type: every column here is nullable for reasons of its own — an image has no
 * text, plain text has no markup, formatted text has no picture — and a union
 * would have to spell out five combinations to say what the four nullable
 * columns already say.
 */
export type ClipboardEntry = typeof clipboardEntries.$inferSelect
export type NewClipboardEntry = typeof clipboardEntries.$inferInsert

export type Setting = typeof settings.$inferSelect

export type BookmarkRow = typeof bookmarks.$inferSelect
