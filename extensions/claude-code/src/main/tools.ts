import { isAbsolute } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  DEFAULT_TASK_COLOR,
  DEFAULT_TASK_ICON,
  folderSubtree,
  isWebAddress,
  TASK_COLORS,
  TASK_ICON_IDS,
  type Client,
  type Tab,
  type TabFolder,
  type TabTypeInfo,
  type Task
} from '@fluid/sdk'
import { isClaudeTab } from '../shared/tab'
import { context } from './context'

/**
 * The workspace, as tools a Claude session can use.
 *
 * A session in a tab is the one agent in the app that can see what the work is
 * about — it is sitting inside a task, next to the pages and shells opened for
 * it — and until now it could not act on any of that. These are the tools that
 * let it: read the strip, open the page it just found, leave a note for the
 * next session, and say when the work is done.
 *
 * They run in the app's process rather than behind a transport, which is the
 * whole reason they can exist at all: a tool here is a function with the
 * workspace API in scope. The cost is that they belong to sessions started in
 * the app — the CLI and the desktop app have no way to reach into this process,
 * and are not meant to.
 *
 * Two rules shape everything below.
 *
 * The first is that a session can only see its own project. What it may touch
 * is worked out once, from the tab it is running in, and every id it names is
 * checked against that — so a task id guessed, remembered from another window
 * or read out of a file answers the same way a deleted one does. No tool takes
 * a project id, and nothing lists the projects: a project a session cannot name
 * is one it cannot reach by accident.
 *
 * The second is that everything goes through the workspace API — the
 * extension's `ctx.api`, the same one the app's windows use. A change a tool
 * makes is announced to every window like any other, and runs the same code the
 * user's own click runs, down to the tearing-down of whatever a closed tab was
 * running.
 *
 * @module tools
 */

/**
 * What one session is allowed to touch, worked out when it starts.
 *
 * Deliberately the project of the session's *own task* rather than whichever
 * project the window happens to be showing. The two are usually the same and
 * come apart exactly when it matters: a session left running in a background
 * task would otherwise follow the user around as they switched projects, and
 * answer questions about work it has never been part of.
 *
 * Fixed for the session's life, which is sound for the project and no longer
 * sound for the task: a tab can be moved between tasks, and a session can move
 * its own — open a task for the thing this turned out to be about, and take
 * the conversation with it. So the task is not kept here. It is read off the
 * tab whenever it is needed (see `currentTaskId`), which costs one row and is
 * the difference between a session that follows itself and one that goes on
 * answering about the task it was started in.
 *
 * The project survives that, because a tab may only move within one.
 */
export type ClaudeScope = {
  /** The tab the session is running in: the one tab it must not close. */
  tabId: string
  projectId: string
  projectName: string
  /** The project's folder, or null for the user's home. */
  projectRoot: string | null
  /** Where the session itself is running, which is where a new shell starts. */
  cwd: string
  /**
   * The tab types other extensions offer to agents (see
   * `TabTypeContribution.agentDescription`), as they were when the session
   * started: what `open_tab` can open, and whose payloads `list_tabs` shows.
   */
  agentTabTypes: AgentTabType[]
}

/** A tab type an extension offers to agents, with the schema its payload has to match. */
type AgentTabType = TabTypeInfo & {
  agentDescription: string
  payloadSchema: Record<string, unknown>
}

/** A scope with the API client every tool acts through. */
type ToolScope = ClaudeScope & { api: Client }

/**
 * Works out a session's scope from the tab it is opening in.
 *
 * Null when any of the three rows is missing, which is not an error: a tab
 * being opened before its row is written, or a task deleted from under a
 * session, both land here. A session with no scope simply gets no tools — the
 * conversation is unaffected, and the alternative would be tools that cannot
 * say what they are allowed to touch.
 */
export async function scopeOf(tabId: string, cwd: string): Promise<ClaudeScope | null> {
  const api = context().api
  const tab = await api.tabs.get({ id: tabId })
  if (!tab) return null
  const task = await api.tasks.get({ id: tab.taskId })
  if (!task) return null
  const project = await api.projects.get({ id: task.projectId })
  if (!project) return null
  // The task is read only to reach the project; what the scope keeps is the
  // project alone. See the note on `ClaudeScope`.

  return {
    tabId,
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.root,
    cwd,
    agentTabTypes: await agentTabTypes(api)
  }
}

/**
 * Every tab type a running extension offers to agents. An extension that fails
 * to say is one whose tabs are not offered, rather than a session with no
 * tools.
 */
async function agentTabTypes(api: Client): Promise<AgentTabType[]> {
  try {
    return (await api.extensions.list({}))
      .filter((info) => info.active)
      .flatMap((info) => info.tabTypes)
      .filter(
        (type): type is AgentTabType =>
          type.agentDescription !== undefined && type.payloadSchema !== undefined
      )
  } catch {
    return []
  }
}

/**
 * What the session is told about where it is, for the system prompt.
 *
 * Only the parts that cannot change while the session runs — which is the tab
 * and the project, and not the task: the title, the status and the facts are
 * all things the user may edit an hour in, and the task itself is something
 * the tab can be moved out of. A preamble is written once, so what the session
 * gets instead is where to go and look, which is the more useful thing to know
 * anyway.
 *
 * The rest of this is about a mistake a session in a tab makes that one in a
 * terminal cannot. A conversation started from a task is joined halfway
 * through: the user has been reading the work for an hour, the tab was opened
 * out of it, and they type the sentence that follows from all that. Read
 * without the task, it looks like a question with a word missing, and the
 * obvious move — ask what they mean — is the wrong one, because the answer is
 * written down two tool calls away and they can see it on screen while they
 * are being asked.
 *
 * The counterweight matters as much as the advice. A session told to look for
 * context finds it whether or not it is there — reading the task before
 * answering a question that never needed it, and worse, reading a clear
 * request as though it must somehow be about the work. So the lines say which
 * prompts this is for and, in as many words, which it is not.
 *
 * The last group are the other direction: not reading the task, but leaving
 * something in it. A task whose only tab is the conversation is a task that
 * says nothing about itself the moment this session ends — and the session is
 * the one thing in the app that knows what the work turned out to involve. So
 * it furnishes the task with what the work is about, and names the row if
 * nobody has.
 *
 * Naming carries a condition the others do not, and it is about standing
 * rather than accuracy. A session is one visit to a task that may have been
 * going on for days; a strip already full of somebody else's tabs is a task
 * whose purpose was settled before this conversation started, and retitling it
 * from inside one visit is overreach however good the title. The tab count is
 * the closest thing to a reading of how much of the task this session is.
 *
 * It gets the same counterweight as the rest, for the same reason — the
 * failure mode is just as easy to fall into from this side: six tabs nobody
 * asked for, under a title nobody chose.
 *
 * Said here rather than attached to each turn. It is advice about how to read
 * every message, not about any one of them, and a line repeated at the top of
 * every turn is a line that stops being read.
 */
export function describeScope(scope: ClaudeScope): string[] {
  return [
    `You are in a tab (id ${scope.tabId}) of the project "${scope.projectName}"${
      scope.projectRoot ? `, rooted at ${scope.projectRoot}` : ''
    }. That tab sits in one of the project's tasks; get_task with no arguments answers which, and the answer can change, because a tab can be moved between tasks and you can move this one yourself.`,
    'The fluid tools act on that project and no other. Use them to look around the workspace, open what the user needs in front of them, and leave notes on the task for later sessions.',
    'The user is working inside that task and writes as though you can see it too. A message that seems to be missing its subject — "is this ready?", "can you take a look", "why did that fail" — is usually not missing anything: what it refers to is the work the task is about.',
    'So when a prompt arrives with no apparent context, read the task before asking what it means. get_task gives you its title and the facts recorded about it, list_task_notes what earlier sessions left there, and list_tabs what the user has open in front of them right now. Ask them only once the task has failed to answer it.',
    'That is for a prompt that does not stand up on its own. One that does — a file named, a question asked, a command to run — means what it says: answer it, and leave the task out of it. Do not go looking for a connection to the work, and do not bend a clear request towards it. The task is where the conversation is happening, not what every message is about.',
    'A task holding nothing but this conversation has no record of what it is about beyond what you are doing in it, and that record ends when the session does. So when you find it that way — no tabs besides your own, or nothing in them that says what the work is — open what the work is actually about: the pull request under review, the page you keep going back to, the dev server you just started. Pin the ones that are the work itself, since a pinned tab is one the task owns and keeps; leave the incidental ones loose.',
    'The title is the same question asked about the row rather than its contents. A task with no title, or one still called "New Task", is a task nobody has named yet — so once you know what the work actually is, rename_task it. Only once you do, though: a confident wrong title is worse than a vague one, because the strip is read at a glance and nobody re-reads a row they think they already know.',
    'And only when the task is mostly yours. One holding a tab or two besides this conversation is a task whose work is largely the work you are doing in it, and naming it is naming that. One already full of tabs opened before you arrived has a purpose older and wider than this session — it has been named by what is in it, whatever the row says — so leave its title to the user.',
    `The icon on the tab is the same again, and follows the same rules: when you name a task, give it an icon that says what kind of work it is with set_task_icon. Only while it still wears the default — the "${DEFAULT_TASK_ICON}" icon in "${DEFAULT_TASK_COLOR}" — though. Any other icon or colour was chosen by the user or by the extension that opened the task, so leave it alone unless the user asks you to change it.`,
    'That is judgement, not reflex. Read list_tabs first so you do not open a second tab on something the task already has, and open what the user would want to come back to rather than every address you happened to mention. A task furnished with six tabs nobody asked for is worse than a bare one.',
    'Read it again rather than relying on what you found earlier: the title, the status, the facts, the notes, the tabs and which task this tab is in all change while you are running, and nothing tells you when they do.'
  ]
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** An MCP tool result. Typed here because the protocol's own types are not installed. */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const answered = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
})

const refused = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

/**
 * Wraps a tool so that anything it throws comes back as the tool's own answer.
 *
 * Every refusal below is a sentence written for the model to read and act on —
 * "that task is in another project", "that is the tab you are running in" —
 * and a thrown error would otherwise reach it as a stack trace, or as nothing
 * at all. So the guards throw, one line each, and this is what turns them into
 * the result.
 */
function answering<A>(run: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return answered(await run(args))
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
  }
}

// ---------------------------------------------------------------------------
// What a session may touch
// ---------------------------------------------------------------------------

/**
 * The task the session is in *now*.
 *
 * Read rather than remembered, because the tab it is running in may have been
 * moved since the session started — possibly by the session itself. Everything
 * that defaults to "this task", and both of the guards that stop a session
 * ending its own conversation, go through here.
 */
async function currentTaskId(scope: ToolScope): Promise<string> {
  const tab = await scope.api.tabs.get({ id: scope.tabId })
  if (!tab) throw new Error('This tab no longer exists.')
  return tab.taskId
}

/**
 * The task an id names, or a refusal.
 *
 * A task in another project is reported as one that does not exist rather than
 * as one that is off limits. The distinction is worth keeping: an answer that
 * says "that task is in another project" confirms the id is real, which is
 * something a session outside that project has no business learning.
 */
async function taskIn(scope: ToolScope, taskId?: string): Promise<Task> {
  const id = taskId ?? (await currentTaskId(scope))
  const task = await scope.api.tasks.get({ id })
  if (!task || task.projectId !== scope.projectId) {
    throw new Error(`No task ${id} in this project.`)
  }
  return task
}

/** The tab an id names, checked the same way and through the same rule. */
async function tabIn(scope: ToolScope, tabId: string): Promise<Tab> {
  const tab = await scope.api.tabs.get({ id: tabId })
  if (!tab) throw new Error(`No tab ${tabId} in this project.`)
  // The tab's own task is what places it, so this is the task check again.
  await taskIn(scope, tab.taskId)
  return tab
}

/** The folder an id names, checked through its task on the same terms. */
async function folderIn(scope: ToolScope, folderId: string): Promise<TabFolder> {
  const folder = await scope.api.folders.get({ id: folderId })
  if (!folder) throw new Error(`No folder ${folderId} in this project.`)
  await taskIn(scope, folder.taskId)
  return folder
}

/**
 * Where a tool that opens a tab puts it: the task named, or the folder's, or
 * the session's own — and the folder, when one is named, which has to be in
 * that task.
 */
async function destination(
  scope: ToolScope,
  taskId: string | undefined,
  folderId: string | undefined
): Promise<{ task: Task; folderId: string | null }> {
  if (folderId === undefined) return { task: await taskIn(scope, taskId), folderId: null }
  const folder = await folderIn(scope, folderId)
  if (taskId !== undefined && taskId !== folder.taskId) {
    throw new Error('That folder is in a different task from the one named.')
  }
  return { task: await taskIn(scope, folder.taskId), folderId: folder.id }
}

// ---------------------------------------------------------------------------
// What a session is told back
// ---------------------------------------------------------------------------

/**
 * A task as the model reads it.
 *
 * A projection rather than the row: `facts` carries a picture for each entry
 * that the panel draws and nothing here can use, and the row also carries
 * positions and a project id that exist to answer questions the session is not
 * allowed to ask.
 */
function describeTask(task: Task, currentId: string): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    icon: task.icon,
    color: task.color,
    facts: task.facts?.map((fact) => ({ label: fact.label, value: fact.value })) ?? null,
    isCurrentTask: task.id === currentId
  }
}

/**
 * A tab as the model reads it, down to the one line that says what it is.
 *
 * The payloads are left out on purpose and not merely trimmed. A browser tab
 * carries its favicon and a file tab its thumbnail, both as `data:` URLs of a
 * few kilobytes each — a strip of a dozen tabs handed over whole would be tens
 * of thousands of tokens of base64, describing nothing.
 */
function describeTab(tab: Tab, activeTabId: string | null, scope: ToolScope): unknown {
  const common = {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    pinned: tab.pinned,
    folderId: tab.folderId,
    isActive: tab.id === activeTabId,
    isThisSession: tab.id === scope.tabId
  }

  switch (tab.type) {
    case 'browser':
      return { ...common, title: tab.title ?? tab.payload.pageTitle ?? null, url: tab.payload.url }
    case 'file':
      return { ...common, fileName: tab.payload.fileName, mimeType: tab.payload.mimeType }
    default:
      // Another session is this extension's own, and says where it is. Another
      // extension's tab holds that extension's business, and the title is what
      // the row says — unless its type is offered to agents, which is its
      // extension saying the payload is theirs to read.
      if (isClaudeTab(tab)) return { ...common, cwd: tab.payload.cwd }
      return scope.agentTabTypes.some((type) => type.id === tab.type)
        ? { ...common, payload: tab.payload }
        : common
  }
}

/** A folder as the model reads it: its place, and nothing it would have no use for. */
const describeFolder = (folder: TabFolder): unknown => ({
  id: folder.id,
  name: folder.name,
  parentFolderId: folder.parentId,
  pinned: folder.pinned,
  collapsed: folder.collapsed
})

const noteOf = (note: { id: string; body: string; createdAt: Date; updatedAt: Date }): unknown => ({
  id: note.id,
  body: note.body,
  writtenAt: note.createdAt.toISOString(),
  editedAt: note.updatedAt.toISOString()
})

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * The tools that only look.
 *
 * Named here so the approver can let them through without a card (see
 * `approver` in ./sessions.ts). A prompt is for a decision the
 * user would want to make, and "may I read the strip you are looking at" is
 * not one: the answer is always yes, the card would appear several times a
 * turn, and a user who has learnt to dismiss cards without reading them is
 * worse off on the calls that do matter.
 *
 * Everything that changes something is deliberately absent, opening a tab
 * included. The list is the whole of the rule — a tool added below and not
 * added here asks, which is the right way round for the mistake to go.
 */
export const READ_ONLY_TOOLS = new Set([
  'mcp__fluid__get_task',
  'mcp__fluid__list_tasks',
  'mcp__fluid__list_task_notes',
  'mcp__fluid__list_tabs',
  'mcp__fluid__list_folders'
])

/** Shared by every tool that can name a task other than the session's own. */
const otherTask = z
  .string()
  .optional()
  .describe('A task in this project. Defaults to the task this session is running in.')

const taskIcon = z
  .enum(TASK_ICON_IDS)
  .describe("The glyph on the task's tab, from the app's curated set. Named for what it draws.")

const taskColor = z
  .enum(TASK_COLORS)
  .describe('The colour the glyph is drawn in. "grey" is the faded default.')

const pinned = z
  .boolean()
  .optional()
  .describe(
    "Whether the tab belongs to the task rather than merely being open in it: pinned tabs are drawn in a section of their own above the rest, and survive being closed. Defaults to false. Ignored when folder_id is given: the tab takes the folder's section."
  )

/** Shared by every tool that opens a tab, which can open it straight into a folder. */
const intoFolder = z
  .string()
  .optional()
  .describe(
    "A folder to open the tab in, from list_folders, at the end of what it holds. The task defaults to the folder's own."
  )

const slot = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Where among what is already there to put it: 0 is first. Defaults to the end.')

/**
 * Opening a tab of a type another extension offers — an editor on a folder,
 * say. One tool for all of them rather than one each, because what they are is
 * the extensions' to say and not this one's: the description lists each type
 * with what its extension says it is and the schema its payload has to match,
 * and the app checks the payload against that schema as the tab opens.
 *
 * Built from the types there were when the session started. One enabled later
 * is offered to the next session; one disabled since is refused by the app.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the tool's type is its schema's
function openTabTool(scope: ToolScope) {
  const types = scope.agentTabTypes
    .map(
      (type) =>
        `- ${type.id} (${type.label}): ${type.agentDescription}\n  payload: ${JSON.stringify(type.payloadSchema)}`
    )
    .join('\n')
  return tool(
    'open_tab',
    `Open a tab of one of these types in a task, with a payload matching its schema:\n${types}`,
    {
      type: z.string().describe('One of the types listed above.'),
      // A loose object rather than `z.record`, which the SDK cannot turn into
      // JSON Schema: `tools/list` fails outright, and the session is left with
      // the server's instructions and none of its tools.
      payload: z.object({}).loose().describe("The tab's payload, matching its type's schema."),
      task_id: otherTask,
      pinned,
      folder_id: intoFolder
    },
    answering(async ({ type, payload, task_id, pinned: pin, folder_id }) => {
      if (!scope.agentTabTypes.some((offered) => offered.id === type)) {
        throw new Error(`${type} is not a type that can be opened here.`)
      }
      const { task, folderId } = await destination(scope, task_id, folder_id)
      const tab = await scope.api.tabs.open({
        taskId: task.id,
        tab: { type: type as `${string}.${string}`, payload, pinned: pin === true, folderId }
      })
      return describeTab(tab, null, scope)
    })
  )
}

/**
 * The tools themselves, built fresh for each session so that every one of them
 * closes over the scope it is allowed to act in. There is no tool that takes a
 * scope as an argument, which is what makes the rule at the top of this file
 * hold rather than merely being documented.
 */
export function workspaceTools(session: ClaudeScope): ReturnType<typeof createSdkMcpServer> {
  // Every tool goes through the same API the app's windows use, so what a
  // session changes is announced to them like anything else — attributed to
  // this extension.
  const scope: ToolScope = { ...session, api: context().api }
  return createSdkMcpServer({
    name: 'fluid',
    version: '1.0.0',
    instructions:
      'The workspace this conversation is happening inside: the tasks of one project, and the tabs open in them. Everything here is scoped to that project.',
    // These are the tools for the app the user is looking at, and a session
    // that has to search for them before it can answer "what am I in" will not
    // bother. Small enough a set that always carrying them is cheap.
    alwaysLoad: true,
    tools: [
      tool(
        'get_task',
        'Read a task: its title, status, type and the facts recorded about the work. Call this rather than trusting the preamble, which was written when the session started.',
        { task_id: otherTask },
        answering(async ({ task_id }) => {
          const task = await taskIn(scope, task_id)
          const tabs = await scope.api.tabs.list({ taskId: task.id })
          return {
            ...describeTask(task, await currentTaskId(scope)),
            tabCount: tabs.length,
            noteCount: (await scope.api.notes.list({ taskId: task.id })).length
          }
        })
      ),

      tool(
        'list_tasks',
        "List this project's tasks. Open ones are what the strip shows; settled ones are finished work that has been taken off it.",
        {
          status: z
            .enum(['open', 'settled', 'all'])
            .optional()
            .describe('Which tasks to list. Defaults to open.')
        },
        answering(async ({ status }) => {
          const wanted = status ?? 'open'
          const tasks = await scope.api.tasks.list({
            projectId: scope.projectId,
            status: wanted === 'all' ? undefined : wanted
          })
          const current = await currentTaskId(scope)
          return tasks.map((task) => describeTask(task, current))
        })
      ),

      tool(
        'create_task',
        'Open a new, empty task in this project. Use this when the user turns to a piece of work that does not belong in the task you are in; tabs can then be opened in it.',
        {
          title: z
            .string()
            .optional()
            .describe('What to call it. A task can be untitled, and most start that way.'),
          icon: taskIcon.optional(),
          color: taskColor.optional()
        },
        answering(async ({ title, icon, color }) => {
          const task = await scope.api.tasks.create({
            projectId: scope.projectId,
            title: title?.trim() || null,
            icon,
            color
          })
          return describeTask(task, await currentTaskId(scope))
        })
      ),

      tool(
        'rename_task',
        'Retitle a task. Worth doing once you know what the work turned out to be: tasks are born untitled, and a strip of untitled rows is unreadable.',
        {
          task_id: otherTask,
          title: z.string().describe('The new title. Empty clears it, leaving the task untitled.')
        },
        answering(async ({ task_id, title }) => {
          const task = await taskIn(scope, task_id)
          const renamed = await scope.api.tasks.update({ id: task.id, title: title.trim() || null })
          return describeTask(renamed, await currentTaskId(scope))
        })
      ),

      tool(
        'set_task_icon',
        "Change the icon on a task's tab, its colour, or both. The icon is what the strip is scanned by before any title is read, so pick one that says what kind of work this is.",
        {
          task_id: otherTask,
          icon: taskIcon.optional(),
          color: taskColor.optional()
        },
        answering(async ({ task_id, icon, color }) => {
          if (icon === undefined && color === undefined) {
            throw new Error('Give an icon, a colour, or both.')
          }
          const task = await taskIn(scope, task_id)
          const updated = await scope.api.tasks.update({ id: task.id, icon, color })
          return describeTask(updated, await currentTaskId(scope))
        })
      ),

      tool(
        'settle_task',
        'Mark a task finished and take it off the strip. Not a delete: the task, its tabs and its notes all survive, and it can be listed again with status "settled". The tabs it holds are closed and anything running in them is stopped.',
        { task_id: z.string().describe('The task to settle.') },
        answering(async ({ task_id }) => {
          const task = await taskIn(scope, task_id)
          if (task.id === (await currentTaskId(scope))) {
            throw new Error(
              'That is the task this session is running in. Settling it would close this tab and end the conversation mid-answer, so it has to be done by the user — tell them the work looks finished and let them settle it.'
            )
          }
          await scope.api.tasks.settle({ id: task.id })
          return { settled: true }
        })
      ),

      tool(
        'list_task_notes',
        'Read the notes left on a task. Notes are how sessions leave context for whoever picks the work up next — including a later session in this same task, which will remember nothing else.',
        { task_id: otherTask },
        answering(async ({ task_id }) => {
          const task = await taskIn(scope, task_id)
          return (await scope.api.notes.list({ taskId: task.id })).map(noteOf)
        })
      ),

      tool(
        'add_task_note',
        'Leave a note on a task: what was decided, what was tried, where the work got to. Write it for a reader who has none of this conversation.',
        {
          body: z.string().min(1).describe('The note, as prose. Markdown is fine.'),
          task_id: otherTask
        },
        answering(async ({ body, task_id }) => {
          const task = await taskIn(scope, task_id)
          return noteOf(await scope.api.notes.add({ taskId: task.id, body }))
        })
      ),

      tool(
        'update_task_note',
        'Rewrite a note you or an earlier session left, when what it says has stopped being true. Prefer this to piling a correction on top of it.',
        {
          note_id: z.string().describe('The note to rewrite, from list_task_notes.'),
          body: z.string().min(1).describe('What the note should now say, in full.')
        },
        answering(async ({ note_id, body }) => {
          const note = await scope.api.notes.get({ id: note_id })
          if (!note) throw new Error(`No note ${note_id} in this project.`)
          await taskIn(scope, note.taskId)
          return noteOf(await scope.api.notes.update({ id: note_id, body }))
        })
      ),

      tool(
        'list_tabs',
        'List the tabs open in a task: the pages, shells, editors and files it holds, in the order the sidebar draws them. The tab this session is running in is marked, and so is the one in front. A tab in a folder names it as folderId; list_folders says what the folders are.',
        { task_id: otherTask },
        answering(async ({ task_id }) => {
          const task = await taskIn(scope, task_id)
          const tabs = await scope.api.tabs.list({ taskId: task.id })
          return tabs.map((tab) => describeTab(tab, task.activeTabId, scope))
        })
      ),

      tool(
        'open_url',
        'Open a web page as a tab in a task. Use this to put something in front of the user — a pull request, a dashboard, the documentation you just cited — rather than pasting a link for them to click. It opens in the background and waits for them; say in your answer that you opened it.',
        {
          url: z.string().describe('An http or https address.'),
          task_id: otherTask,
          pinned,
          folder_id: intoFolder
        },
        answering(async ({ url, task_id, pinned: pin, folder_id }) => {
          if (!isWebAddress(url)) throw new Error(`${url} is not an http or https address.`)
          const { task, folderId } = await destination(scope, task_id, folder_id)
          const tab = await scope.api.tabs.open({
            taskId: task.id,
            tab: { type: 'browser', payload: { url }, pinned: pin === true, folderId }
          })
          return describeTab(tab, null, scope)
        })
      ),

      ...(scope.agentTabTypes.length > 0 ? [openTabTool(scope)] : []),

      tool(
        'open_file',
        'Open a file as a tab in a task. Use this to put a file in front of the user — the screenshot you just took, the report you wrote, the PDF you were asked to go through — rather than leaving a path in your answer for them to go and find. The app takes its own copy, so the tab goes on working after you move or delete yours; a file written into this session’s attachments directory is kept by being opened and by nothing else. Images, video, PDFs and text are drawn in the app; anything else becomes a tab the user can open elsewhere. It opens in the background and waits for them; say in your answer that you opened it.',
        {
          file_path: z.string().describe('Absolute path of the file to open.'),
          task_id: otherTask,
          pinned,
          folder_id: intoFolder
        },
        answering(async ({ file_path, task_id, pinned: pin, folder_id }) => {
          // Relative would resolve against this process’s working directory,
          // which is the app’s and not the session’s — so it would find the
          // wrong file rather than none, which is the worse of the two.
          if (!isAbsolute(file_path)) throw new Error(`${file_path} is not an absolute path.`)
          // Checked before the copy is made, so a refused call leaves nothing
          // behind in the store for nobody to collect.
          const { task, folderId } = await destination(scope, task_id, folder_id)
          const file = await scope.api.files.import({ path: file_path })
          const tab = await scope.api.tabs.open({
            taskId: task.id,
            tab: { type: 'file', payload: file, pinned: pin === true, folderId }
          })
          return describeTab(tab, null, scope)
        })
      ),

      tool(
        'move_tab',
        'Move a tab to another task in this project, keeping whether it is pinned; it leaves any folder it was in. Use this when something turns out to belong to different work than the task it was opened in — including this conversation: a session can move its own tab, which is how it follows the work when what it is doing turns out to be its own task. Create the task first if there is not one yet. If the user is looking at the tab when it moves, the app goes with it.',
        {
          tab_id: z
            .string()
            .describe('The tab to move. May be the tab this session is running in.'),
          task_id: z.string().describe('The task in this project to move it to.')
        },
        answering(async ({ tab_id, task_id }) => {
          const tab = await tabIn(scope, tab_id)
          const task = await taskIn(scope, task_id)
          if (tab.taskId === task.id) {
            throw new Error('That tab is already in that task.')
          }
          const moved = await scope.api.tabs.move({ id: tab.id, taskId: task.id })
          return describeTab(moved, null, scope)
        })
      ),

      tool(
        'focus_tab',
        'Take the user to a tab: the one thing here that moves them off what they are looking at. Only when they asked to be taken there — a tab you opened for them is waiting in the strip, and they will get to it when they are ready.',
        { tab_id: z.string().describe('The tab to go to.') },
        answering(async ({ tab_id }) => {
          const tab = await tabIn(scope, tab_id)
          await scope.api.ui.reveal({ taskId: tab.taskId, tabId: tab.id })
          return { focused: true }
        })
      ),

      tool(
        'close_tab',
        'Close a tab and stop whatever was running in it. A pinned tab is unpinned from its task by being closed, so prefer set_tab_pinned if the tab should stay part of the work.',
        { tab_id: z.string().describe('The tab to close.') },
        answering(async ({ tab_id }) => {
          const tab = await tabIn(scope, tab_id)
          if (tab.id === scope.tabId) {
            throw new Error(
              'That is the tab this session is running in. Closing it would end the conversation mid-answer, so it has to be done by the user.'
            )
          }
          await scope.api.tabs.close({ id: tab.id })
          return { closed: true }
        })
      ),

      tool(
        'set_tab_pinned',
        "Move a tab between the task's own section and the loose tabs below it. Pinning says the tab is part of what the task is for; a pinned browser tab also remembers the page it was pinned on and can be sent back to it. A tab in a folder leaves it, since a folder is in one section; to move a whole folder across, use place_folder.",
        {
          tab_id: z.string().describe('The tab to move.'),
          pinned: z.boolean().describe('True to pin it to the task, false to unpin it.')
        },
        answering(async ({ tab_id, pinned: pin }) => {
          const tab = await tabIn(scope, tab_id)
          const moved = await scope.api.tabs.setPinned({ id: tab.id, pinned: pin })
          return describeTab(moved, null, scope)
        })
      ),

      tool(
        'list_folders',
        "List the folders in a task's sidebar. A folder groups tabs, and other folders, under a name; it sits in the pinned section or among the loose tabs, and everything inside it is in the same section. Each tab's folderId in list_tabs is one of these.",
        { task_id: otherTask },
        answering(async ({ task_id }) => {
          const task = await taskIn(scope, task_id)
          return (await scope.api.folders.list({ taskId: task.id })).map(describeFolder)
        })
      ),

      tool(
        'create_folder',
        "Make a folder in a task's sidebar, at the end of a section or inside another folder. Use folders when the user asks for them, or to group tabs they have asked you to organise — not to rearrange a sidebar nobody asked you to touch.",
        {
          name: z.string().min(1).describe('What to call it.'),
          task_id: otherTask,
          parent_folder_id: z
            .string()
            .optional()
            .describe('A folder to make it inside, which also decides its section and its task.'),
          pinned: z
            .boolean()
            .optional()
            .describe(
              'Whether it goes in the pinned section. Defaults to false. Ignored inside another folder.'
            )
        },
        answering(async ({ name, task_id, parent_folder_id, pinned: pin }) => {
          const { task, folderId } = await destination(scope, task_id, parent_folder_id)
          const folder = await scope.api.folders.create({
            taskId: task.id,
            name: name.trim(),
            parentId: folderId,
            pinned: pin === true
          })
          return describeFolder(folder)
        })
      ),

      tool(
        'rename_folder',
        'Rename a folder.',
        {
          folder_id: z.string().describe('The folder to rename.'),
          name: z.string().min(1).describe('The new name.')
        },
        answering(async ({ folder_id, name }) => {
          const folder = await folderIn(scope, folder_id)
          return describeFolder(
            await scope.api.folders.update({ id: folder.id, name: name.trim() })
          )
        })
      ),

      tool(
        'set_folder_collapsed',
        'Close a folder so the sidebar hides what is in it, or open it again. Only when the user asks: which folders are open is how they have chosen to look at their work.',
        {
          folder_id: z.string().describe('The folder to open or close.'),
          collapsed: z.boolean().describe('True to close it, false to open it.')
        },
        answering(async ({ folder_id, collapsed }) => {
          const folder = await folderIn(scope, folder_id)
          return describeFolder(await scope.api.folders.update({ id: folder.id, collapsed }))
        })
      ),

      tool(
        'move_tab_to_folder',
        "Move a tab within its task's sidebar: into a folder, or out of one to the top of a section. A tab moved into a folder takes the folder's section, pinned or not. To move a tab to another task, use move_tab.",
        {
          tab_id: z
            .string()
            .describe('The tab to move. May be the tab this session is running in.'),
          folder_id: z
            .string()
            .nullable()
            .describe(
              "A folder in the tab's task to put it in, or null to take it out to the top of a section."
            ),
          pinned: z
            .boolean()
            .optional()
            .describe(
              'With folder_id null: which section to put it at the top of. Defaults to the one it is in.'
            ),
          index: slot
        },
        answering(async ({ tab_id, folder_id, pinned: pin, index }) => {
          const tab = await tabIn(scope, tab_id)
          if (folder_id !== null && (await folderIn(scope, folder_id)).taskId !== tab.taskId) {
            throw new Error(
              'That folder is in another task. Move the tab there with move_tab first.'
            )
          }
          const moved = await scope.api.tabs.place({
            id: tab.id,
            folderId: folder_id,
            pinned: pin,
            index
          })
          return describeTab(moved, null, scope)
        })
      ),

      tool(
        'place_folder',
        "Move a folder, with everything in it, within its task's sidebar: into another folder, or out to the top of a section. Moving it into the pinned section pins every tab inside, and out of it unpins them.",
        {
          folder_id: z.string().describe('The folder to move.'),
          parent_folder_id: z
            .string()
            .nullable()
            .describe(
              'A folder to put it inside, or null for the top of a section. Never itself or one of its own.'
            ),
          pinned: z
            .boolean()
            .optional()
            .describe('With parent_folder_id null: which section. Defaults to the one it is in.'),
          index: slot
        },
        answering(async ({ folder_id, parent_folder_id, pinned: pin, index }) => {
          const folder = await folderIn(scope, folder_id)
          if (
            parent_folder_id !== null &&
            (await folderIn(scope, parent_folder_id)).taskId !== folder.taskId
          ) {
            throw new Error(
              'That folder is in another task. Use move_folder_to_task to move between tasks.'
            )
          }
          const placed = await scope.api.folders.place({
            id: folder.id,
            parentId: parent_folder_id,
            pinned: pin,
            index
          })
          return describeFolder(placed)
        })
      ),

      tool(
        'move_folder_to_task',
        'Move a folder, with every tab and folder inside it, to another task in this project. It lands among the loose tabs there, and the tabs inside are unpinned.',
        {
          folder_id: z.string().describe('The folder to move.'),
          task_id: z.string().describe('The task in this project to move it to.')
        },
        answering(async ({ folder_id, task_id }) => {
          const folder = await folderIn(scope, folder_id)
          const task = await taskIn(scope, task_id)
          if (folder.taskId === task.id) throw new Error('That folder is already in that task.')
          return describeFolder(await scope.api.folders.move({ id: folder.id, taskId: task.id }))
        })
      ),

      tool(
        'delete_folder',
        'Delete a folder and every folder inside it, closing every tab they hold and stopping whatever was running in them. To keep the tabs, move them out with move_tab_to_folder first.',
        { folder_id: z.string().describe('The folder to delete.') },
        answering(async ({ folder_id }) => {
          const folder = await folderIn(scope, folder_id)
          const inside = new Set(
            folderSubtree(await scope.api.folders.list({ taskId: folder.taskId }), folder.id).map(
              (candidate) => candidate.id
            )
          )
          const own = await scope.api.tabs.get({ id: scope.tabId })
          if (own?.folderId && inside.has(own.folderId)) {
            throw new Error(
              'The tab this session is running in is inside that folder. Deleting it would end the conversation mid-answer — move this tab out with move_tab_to_folder first, or leave it to the user.'
            )
          }
          await scope.api.folders.delete({ id: folder.id })
          return { deleted: true }
        })
      )
    ]
  })
}
