import { isWebAddress, type HistoryEntry, type Tab, type TabTypeContribution } from '@fluid/sdk'
import { z } from 'zod'
import { isEphemeralProfile } from './profiles'
import { getTab } from './db/tabs'
import {
  insertHistory,
  updateHistory,
  updateSessionHistory,
  type NewHistoryEntry
} from './db/history'
import { changed, historyWork } from './api/history'
import { subscribe } from './api/bus'
import { tabType } from './api/contributions'

/** Copy references, never a terminal command, agent prompt or whole extension payload. */
export function describeVisit(tab: Tab, contribution?: TabTypeContribution): NewHistoryEntry {
  const field = (name?: string): string | null => {
    const value = name ? (tab.payload as Record<string, unknown>)[name] : null
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const file = tab.type === 'file' ? tab.payload : null
  const selected = Object.fromEntries(
    (contribution?.history?.payload ?? [])
      .filter((key) => (tab.payload as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, (tab.payload as Record<string, unknown>)[key]])
  )
  const parsed = z.record(z.string(), z.json()).safeParse(selected)
  const saved = parsed.success && JSON.stringify(parsed.data).length <= 65536 ? parsed.data : {}
  return {
    taskId: tab.taskId,
    tabId: tab.id,
    type: tab.type,
    label: file ? 'File' : (contribution?.label ?? tab.type),
    title: tab.title || file?.fileName || contribution?.label || tab.type,
    location: file ? file.sourcePath || file.fileName : field(contribution?.history?.location),
    sessionId: field(contribution?.history?.sessionId),
    extensionId: tab.type.includes('.') ? tab.type.split('.')[0] : null,
    metadata: file
      ? {
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
          ...(file.thumbnail ? { thumbnail: file.thumbnail } : {})
        }
      : Object.keys(saved).length
        ? { payload: saved }
        : {}
  }
}

// Only the most recent automatic visit per live tab needs later title/session updates.
const recent = new Map<string, HistoryEntry>()
let activeTabId: string | null = null
let activeTaskId: string | null = null

function capture(work: () => Promise<void>): void {
  void historyWork(work).catch((error) => console.error('Could not record task history:', error))
}

/** Called on selection changes, including renderer-only file/extension tabs. */
export function visitTab(tabId: string | null, taskId: string | null = null): void {
  if (activeTabId === tabId && activeTaskId === taskId) return
  activeTabId = tabId
  activeTaskId = taskId
  if (!tabId) return
  const snapshot = getTab(tabId)
  capture(async () => {
    const tab = await snapshot
    // Browser history is navigation-based, not a row for every focus change.
    if (!tab || tab.type === 'browser' || (taskId && tab.taskId !== taskId)) return
    const entry = await insertHistory(describeVisit(tab, tabType(tab.type)))
    recent.set(tabId, entry)
    changed(tab.taskId)
  })
}

/** A main-frame committed browser navigation, including same-document visits. */
export function visitPage(tabId: string, url: string, title?: string): void {
  if (url === 'about:blank' || !isWebAddress(url)) return
  const snapshot = getTab(tabId)
  capture(async () => {
    const tab = await snapshot
    if (!tab || tab.type !== 'browser' || isEphemeralProfile(tab.profile)) return
    const entry = await insertHistory({
      taskId: tab.taskId,
      tabId,
      type: 'browser',
      label: 'Web page',
      title: title || url,
      location: url,
      metadata: { profile: tab.profile }
    })
    recent.set(tabId, entry)
    changed(tab.taskId)
  })
}

export function updatePageTitle(tabId: string, url: string, title: string): void {
  if (!title) return
  capture(async () => {
    const entry = recent.get(tabId)
    if (!entry || entry.type !== 'browser' || entry.location !== url || entry.title === title)
      return
    await updateHistory(entry.id, entry.taskId, { title })
    recent.set(tabId, { ...entry, title })
    changed(entry.taskId)
  })
}

/** Session IDs arrive after a session tab is first shown. Enrich that visit. */
export function registerHistoryCapture(): void {
  subscribe((event) => {
    if (event.type === 'tab.updated' && event.tab.type !== 'browser') {
      const tab = event.tab
      capture(async () => {
        const description = describeVisit(tab, tabType(tab.type))
        if (tab.title && (await updateSessionHistory(description))) changed(tab.taskId)
        const entry = recent.get(tab.id)
        if (!entry || entry.taskId !== tab.taskId) return
        // A tab switching to a different session/location must not rewrite a past visit.
        const newTarget =
          (entry.sessionId && entry.sessionId !== description.sessionId) ||
          entry.location !== description.location ||
          (entry.metadata.payload &&
            JSON.stringify(entry.metadata.payload) !==
              JSON.stringify(description.metadata?.payload))
        if (newTarget) {
          if (activeTabId === tab.id) {
            recent.set(tab.id, await insertHistory(description))
            changed(tab.taskId)
          }
          return
        }
        const changes = {
          title: description.title,
          sessionId: description.sessionId ?? null,
          metadata: description.metadata ?? {}
        }
        if (
          entry.title === changes.title &&
          entry.sessionId === changes.sessionId &&
          JSON.stringify(entry.metadata) === JSON.stringify(changes.metadata)
        )
          return
        await updateHistory(entry.id, entry.taskId, changes)
        recent.set(tab.id, { ...entry, ...changes })
        changed(tab.taskId)
      })
    } else if (event.type === 'tab.closed' || event.type === 'tab.moved') {
      capture(async () => {
        recent.delete(event.tab.id)
      })
    } else if (event.type === 'task.deleted') {
      capture(async () => {
        for (const [id, entry] of recent) if (entry.taskId === event.task.id) recent.delete(id)
      })
    }
  })
}
