import type { TabActivity } from '@fluid/sdk'

/**
 * The dot a row wears for work in a tab (see `TabActivity`): yellow while it
 * is under way, blue once there is something for the user — an answer it is
 * stopped on, or a result they have not seen. Whole class names, for the
 * reason `TASK_COLOR_TEXT` spells them out.
 */
export const ACTIVITY_DOT: Record<TabActivity, string> = {
  working: 'bg-yellow-400',
  waiting: 'bg-blue-500',
  done: 'bg-blue-500'
}

/** What the dot says, for a screen reader. */
export const ACTIVITY_LABEL: Record<TabActivity, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Finished'
}

/**
 * Which of two tabs' activities a task's dot shows: whatever needs the user
 * over whatever does not, so a task with one tab waiting and three working
 * reads as waiting.
 */
const RANK: Record<TabActivity, number> = { working: 0, done: 1, waiting: 2 }

export function strongerActivity(a: TabActivity | undefined, b: TabActivity): TabActivity {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b
}
