import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { isWebAddress, type HistoryEntry, type Tab, type ValidNewTab } from '@fluid/sdk'
import { tabType } from './api/contributions'

export type HistoryRecovery =
  { tab: Tab } | { input: ValidNewTab } | { filePath: string } | { reason: string }

/** Resolve the destination, never just a tab ID that may now hold something else. */
export async function historyRecovery(entry: HistoryEntry, tabs: Tab[]): Promise<HistoryRecovery> {
  const candidates = tabs.filter((tab) => tab.taskId === entry.taskId && tab.type === entry.type)
  const original = candidates.find((tab) => tab.id === entry.tabId)
  if (entry.type === 'browser' && entry.location && isWebAddress(entry.location)) {
    const profile = typeof entry.metadata.profile === 'number' ? entry.metadata.profile : null
    const tab = candidates.find(
      (tab) =>
        tab.type === 'browser' && tab.payload.url === entry.location && tab.profile === profile
    )
    return tab
      ? { tab }
      : {
          input: { type: 'browser', title: entry.title, payload: { url: entry.location }, profile }
        }
  }

  if (entry.type === 'file') {
    const tab = candidates.find(
      (tab) =>
        tab.type === 'file' &&
        (tab.id === entry.tabId || !!tab.payload.sourcePath) &&
        (tab.payload.sourcePath || tab.payload.fileName) === entry.location
    )
    if (tab) return { tab }
    if (entry.location && isAbsolute(entry.location)) {
      if (
        await stat(entry.location).then(
          (info) => info.isFile(),
          () => false
        )
      ) {
        return { filePath: entry.location }
      }
      return { reason: 'Original file no longer available' }
    }
    return { reason: 'Original file path not saved' }
  }

  const contribution = tabType(entry.type)
  if (entry.type.includes('.') && !contribution) return { reason: 'Extension unavailable' }
  const history = contribution?.history
  if (original) {
    const payload = original.payload as Record<string, unknown>
    const sameLocation =
      !history?.location || (payload[history.location] ?? null) === entry.location
    const sameSession =
      !entry.sessionId || (!!history?.sessionId && payload[history.sessionId] === entry.sessionId)
    const saved = entry.metadata.payload
    const samePayload =
      !saved ||
      (typeof saved === 'object' &&
        !Array.isArray(saved) &&
        Object.entries(saved).every(([key, value]) => isDeepStrictEqual(payload[key], value)))
    if (sameLocation && sameSession && samePayload) return { tab: original }
  }
  try {
    const restored = await history?.restore?.(entry)
    if (restored != null) {
      const payload = z.record(z.string(), z.json()).parse(restored)
      if (Object.keys(payload).length === 0 || JSON.stringify(payload).length > 65536) {
        return { reason: 'Invalid recovery data' }
      }
      const tab = candidates.find((tab) =>
        Object.entries(payload).every(([key, value]) =>
          isDeepStrictEqual((tab.payload as Record<string, unknown>)[key], value)
        )
      )
      return tab
        ? { tab }
        : { input: { type: entry.type, title: entry.title, payload } as ValidNewTab }
    }
  } catch {
    return { reason: 'Could not restore this visit' }
  }

  return {
    reason: history?.sessionId && !entry.sessionId ? 'Session not saved' : 'Tab unavailable'
  }
}
