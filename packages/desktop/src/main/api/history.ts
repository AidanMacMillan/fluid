import type { HistoryEntry, MethodParsedInput } from '@fluid/sdk'
import { getTab } from '../db/tabs'
import { getTask } from '../db/tasks'
import { deleteHistory, insertHistory, listHistory } from '../db/history'
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
  await pending
  return listHistory(input.taskId, input.query, input.limit, input.offset)
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
