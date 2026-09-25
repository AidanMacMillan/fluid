import type { Tab } from '@fluid/sdk'
import { destroyBrowserView } from '../browser-views'
import { clearClipboardEntries } from '../db/clipboard'
import { listTabs } from '../db/tabs'
import { removeStoredFile } from '../files'
import { subscribe } from './bus'
import { tabType } from './contributions'
import { setActivity } from './tabs'

/**
 * Stopping what a tab was running once nothing can reach it any more.
 *
 * A browser view, a shell or an extension's process left alive for a tab that
 * has been closed — or whose task has been settled or deleted — is a process
 * with no way back to it. This used to be the window's job, which meant a tab closed
 * by anything other than a click left its process running; it is here now so
 * that every caller of the API gets the same cleanup.
 *
 * Settling keeps the rows, so only what is running stops. Closing and deleting
 * lose the rows, so the files they held go too.
 *
 * An extension's tab types take part through the same two steps: `onStop` and
 * `onClose` on their `TabTypeContribution`.
 */

/** Runs one of an extension tab type's hooks, if it has one. A throw is only logged. */
function notify(tab: Tab, hook: 'onStop' | 'onClose'): void {
  if (!tab.type.includes('.')) return
  try {
    tabType(tab.type)?.[hook]?.(tab)
  } catch (error) {
    console.error(`${tab.type} ${hook} failed:`, error)
  }
}

/** Stops a tab's processes. Safe to call for a tab that has none. */
function stop(tab: Tab): void {
  destroyBrowserView(tab.id)
  notify(tab, 'onStop')
}

/**
 * Stops a settled task's tab, which stays. Work it said was under way, or
 * waiting on the user, stopped with it, so it stops saying so; work that
 * finished and was never looked at is still unseen, and keeps its dot for when
 * the task is reopened.
 */
function settle(tab: Tab): void {
  stop(tab)
  if (tab.activity !== 'working' && tab.activity !== 'waiting') return
  void setActivity(tab.id, null).catch((error: unknown) =>
    console.error('Failed to clear a settled tab:', error)
  )
}

/** Stops a tab and lets go of everything stored for it. */
function discard(tab: Tab): void {
  stop(tab)
  if (tab.type === 'file') void removeStoredFile(tab.payload.storageKey)
  notify(tab, 'onClose')
}

export function registerTeardown(): void {
  subscribe((event) => {
    switch (event.type) {
      case 'tab.closed':
        discard(event.tab)
        return

      case 'task.updated':
        if (event.previous.status === 'open' && event.task.status === 'settled') {
          void listTabs(event.task.id).then((tabs) => tabs.forEach(settle))
        }
        return

      case 'task.deleted':
        event.tabs.forEach(discard)
        return
    }
  })
}

/**
 * Deletes a task's clipboard history along with the pictures it stored. Called
 * before the task itself is deleted: the entries cascade away with the task,
 * and a copied picture whose row has gone is a file nothing can name.
 */
export async function clearTaskClipboard(taskId: string): Promise<void> {
  for (const key of await clearClipboardEntries(taskId)) await removeStoredFile(key)
}
