import {
  claimsMediaType,
  type BookmarkContribution,
  type Disposable,
  type FileViewerContribution,
  type TabTypeContribution,
  type TaskTypeContribution,
  type ViewConnection
} from '@fluid/sdk'
import { emit } from './bus'

/**
 * What extensions have added to the app, held in memory for as long as each
 * one is enabled.
 *
 * Nothing here is written down. An extension registers its contributions every
 * time it activates, and disposing a registration takes the contribution away —
 * which is how updating or removing an extension updates or removes what it
 * offered, without anything left behind in the database to clean up.
 *
 * Contributions are keyed by their full id, `extensionId.id`.
 */

type Registered<T> = { extensionId: string; fullId: string; contribution: T }

const taskTypes = new Map<string, Registered<TaskTypeContribution>>()
const tabTypes = new Map<string, Registered<TabTypeContribution>>()
const fileViewers = new Map<string, Registered<FileViewerContribution>>()
const bookmarkProviders = new Map<string, Set<() => BookmarkContribution[]>>()

const viewConnectors = new Map<string, Set<(connection: ViewConnection) => void>>()

const changeListeners = new Set<() => void>()

function onContributionsChanged(): void {
  for (const listener of changeListeners) listener()
}

/**
 * Called when task or tab types or file viewers come or go: so windows can
 * redraw badges and panes, and so views of a type that has gone can be taken
 * down.
 */
export function whenContributionsChange(listener: () => void): void {
  changeListeners.add(listener)
}

function register<T extends { id: string }>(
  registry: Map<string, Registered<T>>,
  extensionId: string,
  contribution: T
): Disposable {
  const fullId = `${extensionId}.${contribution.id}`
  if (registry.has(fullId)) throw new Error(`${fullId} is already registered.`)
  const entry = { extensionId, fullId, contribution }
  registry.set(fullId, entry)
  onContributionsChanged()
  return {
    dispose: () => {
      if (registry.get(fullId) === entry) {
        registry.delete(fullId)
        onContributionsChanged()
      }
    }
  }
}

export function registerTaskType(extensionId: string, type: TaskTypeContribution): Disposable {
  return register(taskTypes, extensionId, type)
}

export function registerTabType(extensionId: string, type: TabTypeContribution): Disposable {
  return register(tabTypes, extensionId, type)
}

export function registerFileViewer(
  extensionId: string,
  viewer: FileViewerContribution
): Disposable {
  return register(fileViewers, extensionId, viewer)
}

export function taskType(fullId: string | null): TaskTypeContribution | undefined {
  return fullId === null ? undefined : taskTypes.get(fullId)?.contribution
}

export function tabType(fullId: string): TabTypeContribution | undefined {
  return tabTypes.get(fullId)?.contribution
}

/** Every registered task type, for drawing badges. */
export function taskTypeList(): Registered<TaskTypeContribution>[] {
  return [...taskTypes.values()]
}

/** Every registered tab type. */
export function tabTypeList(): Registered<TabTypeContribution>[] {
  return [...tabTypes.values()]
}

export function fileViewer(fullId: string): Registered<FileViewerContribution> | undefined {
  return fileViewers.get(fullId)
}

/**
 * The installed extensions, in the order the app lists them, which is also the
 * order a type two file viewers claim is settled in. Handed over by the host
 * rather than read from it, which would make this module and the host each
 * other's imports.
 */
let extensionOrder: readonly string[] = []

export function setExtensionOrder(ids: readonly string[]): void {
  extensionOrder = ids
}

/**
 * Every registered file viewer: by extension in the app's order, and within
 * one extension in the order it registered them. Not merely in registration
 * order, which changes every time an extension is turned off and on again —
 * and which the windows, seeing only the list of extensions, could not follow.
 */
export function fileViewerList(): Registered<FileViewerContribution>[] {
  const rank = (extensionId: string): number => {
    const index = extensionOrder.indexOf(extensionId)
    return index === -1 ? extensionOrder.length : index
  }
  // A stable sort: a map iterates in the order it was filled.
  return [...fileViewers.values()].sort((a, b) => rank(a.extensionId) - rank(b.extensionId))
}

/**
 * The viewer that draws a file of `mimeType`, if a running extension offers
 * one. Where two claim it, the first in `fileViewerList` does — the same one
 * the windows pick from the extensions' list (see `Extensions.fileViewer`).
 */
export function fileViewerFor(mimeType: string): Registered<FileViewerContribution> | undefined {
  return fileViewerList().find((registered) =>
    claimsMediaType(registered.contribution.mimeTypes, mimeType)
  )
}

export function provideBookmarks(
  extensionId: string,
  provider: () => BookmarkContribution[]
): Disposable {
  let providers = bookmarkProviders.get(extensionId)
  if (!providers) bookmarkProviders.set(extensionId, (providers = new Set()))
  providers.add(provider)
  emit({ type: 'bookmarks.changed' })
  return {
    dispose: () => {
      if (providers.delete(provider)) emit({ type: 'bookmarks.changed' })
    }
  }
}

/** Every extension's bookmarks as they are right now, tagged with who supplied them. */
export function contributedBookmarks(): (BookmarkContribution & { extensionId: string })[] {
  const all: (BookmarkContribution & { extensionId: string })[] = []
  for (const [extensionId, providers] of bookmarkProviders) {
    for (const provider of providers) {
      try {
        for (const bookmark of provider()) all.push({ ...bookmark, extensionId })
      } catch (error) {
        console.error(`${extensionId} failed to list its bookmarks:`, error)
      }
    }
  }
  return all
}

/** Listens for the views of one tab type connecting. Keyed by the full type. */
export function registerViewConnector(
  fullType: string,
  listener: (connection: ViewConnection) => void
): Disposable {
  let listeners = viewConnectors.get(fullType)
  if (!listeners) viewConnectors.set(fullType, (listeners = new Set()))
  listeners.add(listener)
  return { dispose: () => listeners.delete(listener) }
}

/** Everyone listening for a view of `fullType` to connect. */
export function viewConnectorsFor(fullType: string): ((connection: ViewConnection) => void)[] {
  return [...(viewConnectors.get(fullType) ?? [])]
}
