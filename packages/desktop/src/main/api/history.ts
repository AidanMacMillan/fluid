import type { HistoryEntry, MethodParsedInput, Tab } from '@fluid/sdk'
import { getTab, listTabs } from '../db/tabs'
import { getTask } from '../db/tasks'
import {
  deleteHistory,
  getHistory,
  insertHistory,
  listHistory,
  updateSessionHistory
} from '../db/history'
import { historyRecovery } from '../history-recovery'
import { tabType } from './contributions'
import { emit } from './bus'
import { ApiError, found } from './errors'

// Capture, enrichment and deletion share an order. A pending title update cannot
// recreate a cleared entry, and a visit already queued is cleared with its task.
let pending: Promise<unknown> = Promise.resolve()
export function historyWork<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work)
  pending = result.catch(() => undefined)
  return result
}
export function changed(taskId: string): void {
  emit({ type: 'history.changed', taskId })
}

export async function list(input: MethodParsedInput<'history.list'>): Promise<HistoryEntry[]> {
  // Names already stored on live tabs should also repair older visits after a restart.
  const { tabs, entries } = await historyWork(async () => {
    const tabs = await listTabs(input.taskId)
    for (const tab of tabs) {
      const fields = tabType(tab.type)?.history
      const payload = tab.payload as Record<string, unknown>
      const sessionId = fields?.sessionId ? payload[fields.sessionId] : null
      const location = fields?.location ? payload[fields.location] : null
      if (tab.title && typeof sessionId === 'string' && sessionId)
        await updateSessionHistory({
          taskId: tab.taskId,
          tabId: tab.id,
          type: tab.type,
          label: tab.type,
          title: tab.title,
          sessionId,
          location: typeof location === 'string' ? location : null
        })
    }
    return {
      tabs,
      entries: await listHistory(input.taskId, input.query, input.limit, input.offset)
    }
  })
  return Promise.all(
    entries.map(async (entry) => {
      const recovery = await historyRecovery(entry, tabs)
      return {
        ...entry,
        canOpen: !('reason' in recovery),
        ...('reason' in recovery ? { unavailableReason: recovery.reason } : {})
      }
    })
  )
}

// Serialize opens so repeated clicks on closed sessions cannot create duplicates.
let opening: Promise<unknown> = Promise.resolve()
export function open(input: MethodParsedInput<'history.open'>): Promise<Tab> {
  const work = opening.then(async () => {
    await pending
    const entry = found(await getHistory(input.taskId, input.id), 'history entry')
    const recovery = await historyRecovery(entry, await listTabs(input.taskId))
    if ('reason' in recovery) throw new ApiError(recovery.reason)
    if ('tab' in recovery) return recovery.tab
    const tabs = await import('./tabs')
    if ('filePath' in recovery) {
      const files = await import('./files')
      return tabs.open(input.taskId, {
        type: 'file',
        title: entry.title,
        payload: await files.importPath(recovery.filePath)
      })
    }
    return tabs.open(input.taskId, recovery.input)
  })
  opening = work.catch(() => undefined)
  return work
}

export function record(
  input: MethodParsedInput<'history.record'>,
  extensionId: string | null
): Promise<HistoryEntry> {
  return historyWork(async () => {
    found(await getTask(input.taskId), 'task')
    if (extensionId && !input.type.startsWith(`${extensionId}.`)) {
      throw new ApiError('History event types must start with your extension ID followed by a dot.')
    }
    if (input.tabId) {
      const tab = found(await getTab(input.tabId), 'tab')
      if (tab.taskId !== input.taskId) throw new ApiError('That tab is not in that task.')
    }
    if (JSON.stringify(input.metadata).length > 65536)
      throw new ApiError('History metadata must fit within 64 KB.')
    const entry = await insertHistory({ ...input, extensionId })
    changed(input.taskId)
    return entry
  })
}
export function remove(taskId: string, id?: string): Promise<void> {
  return historyWork(async () => {
    await deleteHistory(taskId, id)
    changed(taskId)
  })
}
