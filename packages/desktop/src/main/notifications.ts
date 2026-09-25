import { randomUUID } from 'node:crypto'
import { Notification } from 'electron'
import { revealHost } from './browser-views'
import { emit } from './api/bus'

/**
 * Native notifications, and taking the user to the task one is about.
 *
 * Anything can post one through the API (`notifications.show`) — an
 * extension's routine announcing a task it opened, most often. Nothing is
 * announced automatically: an interruption should have to be asked for.
 *
 * Clicking one takes the user to the task, which is the same act as the API's
 * `ui.reveal` — and so the whole reason this module knows anything about
 * windows.
 *
 * On macOS a task's notifications are grouped under it in Notification Centre,
 * and are cleared once the user has gone to the task — by clicking one or by
 * any other way — since by then they have said all they had to say.
 */

/** Where a notification click lands. */
export type TaskFocus = {
  taskId: string
  /**
   * The tab to open the task on, or null to leave it on whichever tab it was
   * last left on. A request names its lead tab — the story for a review or a
   * test, the master pull request for an approval: the task may have been
   * sitting somewhere else for a day, and the click asked for it from the top.
   */
  tabId: string | null
}

/**
 * Whether Notification Centre can be read back and tidied. The history and the
 * removals are macOS's alone; elsewhere a notification is posted and left.
 */
const CENTRE = process.platform === 'darwin'

/** Posts a notification. With `focus`, clicking it takes the user to that task. */
export function showNotification(options: {
  title: string
  body: string
  focus?: TaskFocus
}): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    id: notificationId(options.focus),
    // The task is the thread: Notification Centre stacks a task's notifications
    // together, and `dismissTaskNotifications` clears them as one.
    ...(options.focus ? { groupId: options.focus.taskId } : {}),
    title: options.title,
    body: options.body
  })
  listen(notification, options.focus ?? null)
  notification.show()
}

/** What a notification does when it is clicked, and how it lets go. */
function listen(notification: Notification, focus: TaskFocus | null): void {
  notification.on('click', () => {
    live.delete(notification)
    if (focus) revealTask(focus)
  })
  notification.on('close', () => live.delete(notification))
  // macOS posts nothing for an app that is not code-signed, and says so only
  // here. Without this, a build that lost its signature would just go quiet.
  notification.on('failed', (_event, error) => {
    live.delete(notification)
    console.error('Failed to show a notification:', error)
  })
  retain(notification)
}

/**
 * A notification's identifier, carrying the task it leads to.
 *
 * The click handler is what knows where a notification goes, and it lives no
 * longer than the app does — but the banner stays in Notification Centre across
 * a restart. Writing the destination into the identifier is what lets
 * `restoreNotifications` wire a click back up after one, since the identifier
 * is the one thing macOS gives back. The trailing UUID keeps two notifications
 * about the same tab apart, so posting the second does not replace the first.
 */
function notificationId(focus: TaskFocus | undefined): string {
  if (!focus) return randomUUID()
  return [
    ID_PREFIX,
    encodeURIComponent(focus.taskId),
    encodeURIComponent(focus.tabId ?? ''),
    randomUUID()
  ].join(':')
}

const ID_PREFIX = 'task'

/** The task a notification leads to, read back out of its identifier. */
function focusFromId(id: string): TaskFocus | null {
  const [prefix, taskId, tabId] = id.split(':')
  if (prefix !== ID_PREFIX || !taskId) return null
  return { taskId: decodeURIComponent(taskId), tabId: tabId ? decodeURIComponent(tabId) : null }
}

/**
 * Picks back up the notifications a previous run left in Notification Centre,
 * so clicking one still goes somewhere. Called once, at startup.
 *
 * Without this, a banner posted before a restart is a dead end: macOS brings
 * the app forward on the click, and nothing else happens.
 */
export async function restoreNotifications(): Promise<void> {
  if (!CENTRE) return
  for (const notification of await Notification.getHistory()) {
    listen(notification, focusFromId(notification.id))
  }
}

/**
 * Clears a task's notifications from Notification Centre: the user has gone to
 * the task, or it no longer exists. Either way, what they announced is no
 * longer news, and a click on one would at best land where the user already
 * is.
 */
export function dismissTaskNotifications(taskId: string): void {
  if (!CENTRE) return
  Notification.removeGroup(taskId)
  for (const notification of live) {
    if (notification.groupId === taskId) live.delete(notification)
  }
}

/**
 * Notifications that can still be clicked.
 *
 * They are kept for no other reason than to stop them being collected. A
 * `Notification` with no reference left to it is garbage in the eyes of the
 * renderer that made it, and its banner outlives it: the banner is macOS's, and
 * it sits in Notification Centre for hours. Click it after the object has gone
 * and the callback has gone with it, which looks precisely like the app
 * ignoring the click — macOS brings the app forward by itself either way, so
 * the window comes up and nothing else happens.
 */
const live = new Set<Notification>()

/**
 * How many are held at once.
 *
 * Nothing is dropped on a timer, because a review is worth clicking on hours
 * after it landed and macOS keeps the banner until it is dismissed. The cap is
 * only to stop a machine left running for weeks accumulating them without
 * bound — `close` is not emitted reliably on macOS, so it cannot be the only
 * thing that empties this — and it is far more than anybody has reviews open.
 */
const MAX_LIVE = 100

function retain(notification: Notification): void {
  live.add(notification)

  // A `Set` iterates in insertion order, so this drops the oldest first.
  for (const oldest of live) {
    if (live.size <= MAX_LIVE) break
    live.delete(oldest)
  }
}

/**
 * How to make a window when the app has none. Registered by the app at startup:
 * building the main window is its business, and reaching for it from here would
 * mean importing the entry point that imports this.
 */
let openWindow: (() => void) | null = null

export function registerWindowOpener(open: () => void): void {
  openWindow = open
}

/**
 * A click that arrived with no window to take it, kept until one asks. At most
 * one: a user who clicks twice before the window is up meant the second.
 */
let pending: TaskFocus | null = null

/**
 * Takes the task a click asked for before this window existed, and forgets it.
 * The renderer asks once, while it loads — the only moment at which it can be
 * sure its own listener was not simply registered too late.
 */
export function takePendingOpenTask(): TaskFocus | null {
  const focus = pending
  pending = null
  return focus
}

/**
 * Takes the user to a task: the window comes forward, and the renderer is told
 * where to go.
 *
 * Only a renderer that is up can be told anything, and there may not be one. On
 * macOS the app outlives its window — closing one does not quit — so the click
 * may have to make the window it lands in, and a window that is still loading
 * would drop anything sent to it. Both of those leave the request where the
 * renderer will come looking for it as it finishes (see `takePendingOpenTask`),
 * which is the one moment it is certain to be listening.
 */
export function revealTask(focus: TaskFocus): void {
  switch (revealHost()) {
    case 'ready':
      emit({ type: 'ui.revealRequested', taskId: focus.taskId, tabId: focus.tabId })
      return
    case 'loading':
      pending = focus
      return
    case 'none':
      pending = focus
      openWindow?.()
  }
}
