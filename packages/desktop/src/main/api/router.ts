import { BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  createClient,
  methodSchema,
  type Client,
  type MethodName,
  type MethodOutput,
  type MethodParsedInput
} from '@fluid/sdk'
import { PROFILES } from '../profiles'
import { resetProfile } from '../profile-sessions'
import { revealTask, showNotification } from '../notifications'
import { callExtension, listExtensions, setExtensionEnabled } from '../extensions/host'
import * as bookmarks from './bookmarks'
import { subscribe } from './bus'
import { ApiError } from './errors'
import { checkIsolatedCall } from './isolation-policy'
import * as files from './files'
import * as folders from './folders'
import * as notes from './notes'
import * as projects from './projects'
import * as settings from './settings'
import * as tabs from './tabs'
import * as tasks from './tasks'

/**
 * The API's implementation: one handler per method in the SDK's contract.
 *
 * Every transport ends here — IPC from the windows (src/main/api/ipc.ts),
 * in-process calls from extensions (`localClient`) — so
 * input is validated once, in `callApi`, against the contract's schema, and a
 * handler only ever sees input that has passed it.
 *
 * The table is typed against the contract, so a method added there without a
 * handler here, or a handler that resolves to the wrong thing, fails to
 * compile.
 */

/** Who is calling. Kept for attribution; nothing is refused on it yet. */
export type Caller = { kind: 'window' } | { kind: 'extension'; extensionId: string }

type Handlers = {
  [M in MethodName]: (
    input: MethodParsedInput<M>,
    caller: Caller
  ) => Promise<MethodOutput<M>> | MethodOutput<M>
}

const handlers: Handlers = {
  'spaces.list': () => projects.listAllSpaces(),
  'spaces.create': ({ name }) => projects.createSpaceNamed(name),
  'spaces.rename': ({ id, name }) => projects.renameSpaceTo(id, name),
  'spaces.delete': ({ id }) => projects.removeSpace(id),

  'projects.list': () => projects.list(),
  'projects.get': ({ id }) => projects.get(id),
  'projects.active': () => projects.active(),
  'projects.setActive': ({ id }) => projects.setActive(id),
  'projects.create': (input) => projects.create(input),
  'projects.rename': ({ id, name }) => projects.rename(id, name),
  'projects.setRoot': ({ id, root }) => projects.setRoot(id, root),
  'projects.setSpace': ({ id, spaceId }) => projects.setSpace(id, spaceId),
  'projects.workingDirectory': ({ id }) => projects.workingDirectory(id),
  'projects.delete': ({ id, confirmation }) => projects.remove(id, confirmation),

  'tasks.list': ({ projectId, status }) => tasks.list(projectId, status),
  'tasks.get': ({ id }) => tasks.get(id),
  'tasks.create': (input) => tasks.create(input),
  'tasks.update': (input) => tasks.update(input),
  'tasks.settle': ({ id }) => tasks.settle(id),
  'tasks.reopen': ({ id }) => tasks.reopen(id),
  'tasks.delete': ({ id }) => tasks.remove(id),
  'tasks.reorder': ({ projectId, ids }) => tasks.reorder(projectId, ids),
  'tasks.setActiveTab': ({ id, tabId }) => tasks.setActiveTab(id, tabId),
  'tasks.setSplits': ({ id, splits, activeTabId }) => tasks.setSplits(id, splits, activeTabId),

  'notes.list': ({ taskId }) => notes.list(taskId),
  'notes.get': ({ id }) => notes.get(id),
  'notes.add': ({ taskId, body }) => notes.add(taskId, body),
  'notes.update': ({ id, body }) => notes.update(id, body),
  'notes.delete': ({ id }) => notes.remove(id),

  'tabs.list': ({ taskId }) => tabs.list(taskId),
  'tabs.get': ({ id }) => tabs.get(id),
  'tabs.open': ({ taskId, tab }) => tabs.open(taskId, tab),
  'tabs.update': (input) => tabs.update(input),
  'tabs.move': ({ id, taskId }) => tabs.move(id, taskId),
  'tabs.setPinned': ({ id, pinned }) => tabs.setPinned(id, pinned),
  'tabs.setActivity': ({ id, activity }) => tabs.setActivity(id, activity),
  'tabs.markSeen': ({ id }) => tabs.markSeen(id),
  'tabs.activity': ({ projectId }) => tabs.activity(projectId),
  'tabs.reorder': ({ taskId, ids }) => tabs.reorder(taskId, ids),
  'tabs.place': ({ id, folderId, pinned, index }) =>
    tabs.place({ id, folderId: folderId ?? null, pinned, index }),
  'tabs.arrange': ({ taskId, items }) => tabs.arrange(taskId, items),
  'tabs.close': ({ id }) => tabs.close(id),

  'folders.list': ({ taskId }) => folders.list(taskId),
  'folders.get': ({ id }) => folders.get(id),
  'folders.create': (input) => folders.create(input),
  'folders.update': (input) => folders.update(input),
  'folders.place': ({ id, parentId, pinned, index }) =>
    folders.place({ id, parentId: parentId ?? null, pinned, index }),
  'folders.move': ({ id, taskId }) => folders.move(id, taskId),
  'folders.delete': ({ id }) => folders.remove(id),

  'files.import': ({ path }) => files.importPath(path),

  'bookmarks.list': () => bookmarks.list(),
  'bookmarks.create': (input) => bookmarks.create(input),
  'bookmarks.update': (input) => bookmarks.update(input),
  'bookmarks.delete': ({ id }) => bookmarks.remove(id),
  'bookmarks.reorder': ({ ids }) => bookmarks.reorder(ids),

  'profiles.list': () => [...PROFILES],
  'profiles.reset': ({ spaceId, profile }) =>
    resetProfile(spaceId, profile, BrowserWindow.getFocusedWindow()),

  'settings.get': ({ key }) => settings.get(key),
  'settings.set': ({ key, value }) => settings.set(key, value),
  'settings.delete': ({ key }) => settings.remove(key),
  'settings.all': () => settings.all(),

  'notifications.show': ({ title, body, taskId, tabId }) =>
    showNotification({
      title,
      body,
      focus: taskId === undefined ? undefined : { taskId, tabId: tabId ?? null }
    }),

  'extensions.list': () => listExtensions(),
  'extensions.setEnabled': ({ id, enabled }) => setExtensionEnabled(id, enabled),
  'extensions.call': ({ extensionId, method, input }) => callExtension(extensionId, method, input),

  'ui.reveal': ({ taskId, tabId }) => revealTask({ taskId, tabId: tabId ?? null })
}

/** Validates a call against the contract and runs it. */
export async function callApi(name: string, input: unknown, caller: Caller): Promise<unknown> {
  const schema = methodSchema(name)
  const handler = (handlers as Record<string, Handlers[MethodName] | undefined>)[name]
  if (!schema || !handler) throw new ApiError(`There is no ${name} method.`)

  const parsed = schema.safeParse(input ?? {})
  if (!parsed.success) {
    throw new ApiError(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`)
  }
  // An installed extension is held to a narrower API than the app's own code.
  if (caller.kind === 'extension') await checkIsolatedCall(caller.extensionId, name, parsed.data)
  return (handler as (input: unknown, caller: Caller) => unknown)(parsed.data, caller)
}

/** A client for code running in the main process: extensions. */
export function localClient(caller: Caller): Client {
  return createClient({
    call: (method, input) => callApi(method, input, caller),
    subscribe
  })
}
