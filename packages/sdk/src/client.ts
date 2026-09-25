import {
  METHOD_NAMES,
  type Contract,
  type MethodInput,
  type MethodName,
  type MethodOutput,
  type Namespace
} from './api'
import { taskIdsOf, type EventOf, type WorkspaceEvent, type WorkspaceEventType } from './events'

/**
 * How a client reaches the workspace. The app provides one per surface — IPC in
 * a window, a direct call in the main process — and the client on top is the
 * same everywhere.
 */
export type Transport = {
  call(method: MethodName, input: unknown): Promise<unknown>
  subscribe(listener: (event: WorkspaceEvent) => void): () => void
}

export type Unsubscribe = () => void

/** A method's call signature. Methods that need nothing can be called with no argument. */
type Call<M extends MethodName> =
  Record<string, never> extends MethodInput<M>
    ? (input?: MethodInput<M>) => Promise<MethodOutput<M>>
    : (input: MethodInput<M>) => Promise<MethodOutput<M>>

type NamespaceClient<N extends Namespace> = {
  [K in Extract<keyof Contract[N], string>]: `${N}.${K}` extends MethodName
    ? Call<`${N}.${K}`>
    : never
}

/**
 * The reads that can be watched, and which events can change each one's answer.
 * A watch re-reads when one of these arrives; anything else is ignored.
 */
const WATCHES = {
  'spaces.list': (event) => event.type.startsWith('space.'),
  'projects.list': (event) => event.type.startsWith('project.'),
  'projects.get': (event, input) =>
    event.type.startsWith('project.') &&
    'project' in event &&
    event.project.id === (input as { id: string }).id,
  'projects.active': (event) =>
    event.type === 'project.activated' ||
    event.type === 'project.updated' ||
    event.type === 'project.deleted',
  // A root can be changed, and without an id the answer follows the active
  // project. A folder that appears or vanishes on disk announces nothing.
  'projects.workingDirectory': (event, input) => {
    const { id } = input as { id?: string }
    if (id === undefined)
      return event.type === 'project.activated' || event.type === 'project.updated'
    return event.type === 'project.updated' && event.project.id === id
  },
  'tasks.list': (event, input) => {
    const { projectId } = input as { projectId: string }
    if (event.type === 'tasks.reordered') return event.projectId === projectId
    return (
      (event.type === 'task.created' ||
        event.type === 'task.updated' ||
        event.type === 'task.deleted') &&
      event.task.projectId === projectId
    )
  },
  'tasks.get': (event, input) =>
    event.type.startsWith('task.') && taskIdsOf(event).includes((input as { id: string }).id),
  'notes.list': (event, input) =>
    event.type.startsWith('note.') &&
    taskIdsOf(event).includes((input as { taskId: string }).taskId),
  'tabs.list': (event, input) =>
    (event.type.startsWith('tab.') || event.type === 'tabs.reordered') &&
    taskIdsOf(event).includes((input as { taskId: string }).taskId),
  'folders.list': (event, input) =>
    (event.type.startsWith('folder.') || event.type === 'tabs.reordered') &&
    taskIdsOf(event).includes((input as { taskId: string }).taskId),
  'folders.get': (event, input) =>
    ('folder' in event && event.folder.id === (input as { id: string }).id) ||
    (event.type === 'tabs.reordered' &&
      event.folders.some((folder) => folder.id === (input as { id: string }).id)),
  'tabs.get': (event, input) =>
    event.type.startsWith('tab.') &&
    'tab' in event &&
    event.tab.id === (input as { id: string }).id,
  // Which project a tab is in is not on the event, so any tab changing, or a
  // task going or coming back, is a re-read. One indexed query, coalesced.
  'tabs.activity': (event) =>
    event.type.startsWith('tab.') ||
    event.type === 'task.deleted' ||
    (event.type === 'task.updated' && event.task.status !== event.previous.status),
  'bookmarks.list': (event) => event.type === 'bookmarks.changed',
  'settings.get': (event, input) =>
    event.type === 'setting.changed' && event.key === (input as { key: string }).key,
  'settings.all': (event) => event.type === 'setting.changed',
  'extensions.list': (event) => event.type === 'extensions.changed'
} satisfies Partial<Record<MethodName, (event: WorkspaceEvent, input: unknown) => boolean>>

export type WatchableMethod = keyof typeof WATCHES

export type Client = { [N in Namespace]: NamespaceClient<N> } & {
  /** Calls a method by name. The namespaced form (`client.tasks.list(...)`) is usually nicer. */
  call<M extends MethodName>(method: M, input: MethodInput<M>): Promise<MethodOutput<M>>

  /** Listens for one kind of event. */
  on<T extends WorkspaceEventType>(type: T, listener: (event: EventOf<T>) => void): Unsubscribe

  /** Listens for every event. */
  onAny(listener: (event: WorkspaceEvent) => void): Unsubscribe

  /**
   * Keeps a read up to date: calls `listener` with the answer now, and again
   * whenever an event that could change it arrives. Re-reads are coalesced, so
   * a burst of changes produces one call with the final answer.
   *
   * ```ts
   * const stop = client.watch('tasks.list', { projectId, status: 'open' }, (tasks) => draw(tasks))
   * ```
   */
  watch<M extends WatchableMethod>(
    method: M,
    input: MethodInput<M>,
    listener: (value: MethodOutput<M>) => void,
    onError?: (error: unknown) => void
  ): Unsubscribe
}

export function createClient(transport: Transport): Client {
  const call = <M extends MethodName>(method: M, input: MethodInput<M>): Promise<MethodOutput<M>> =>
    transport.call(method, input ?? {}) as Promise<MethodOutput<M>>

  const namespaces: Record<string, Record<string, unknown>> = {}
  for (const name of METHOD_NAMES) {
    const [namespace, key] = name.split('.')
    namespaces[namespace] ??= {}
    namespaces[namespace][key] = (input: unknown) => call(name, input as never)
  }

  const client = {
    ...namespaces,
    call,

    on<T extends WorkspaceEventType>(type: T, listener: (event: EventOf<T>) => void): Unsubscribe {
      return transport.subscribe((event) => {
        if (event.type === type) listener(event as EventOf<T>)
      })
    },

    onAny(listener: (event: WorkspaceEvent) => void): Unsubscribe {
      return transport.subscribe(listener)
    },

    watch<M extends WatchableMethod>(
      method: M,
      input: MethodInput<M>,
      listener: (value: MethodOutput<M>) => void,
      onError: (error: unknown) => void = (error) => console.error(`watch ${method}:`, error)
    ): Unsubscribe {
      const relevant = WATCHES[method] as (event: WorkspaceEvent, input: unknown) => boolean
      let stopped = false
      let running = false
      let again = false

      const read = async (): Promise<void> => {
        if (running) {
          again = true
          return
        }
        running = true
        try {
          do {
            again = false
            const value = await call(method, input)
            // Only the newest answer is worth handing on: a change that arrived
            // mid-read is read again before anything is delivered.
            if (!again && !stopped) listener(value)
          } while (again && !stopped)
        } catch (error) {
          if (!stopped) onError(error)
        } finally {
          running = false
        }
      }

      const unsubscribe = transport.subscribe((event) => {
        if (!stopped && relevant(event, input)) void read()
      })
      void read()

      return () => {
        stopped = true
        unsubscribe()
      }
    }
  }

  return client as unknown as Client
}
