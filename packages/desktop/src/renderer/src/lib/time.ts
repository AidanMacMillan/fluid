/**
 * When something happened, relative for anything recent — "13 minutes ago" —
 * and only a clock reading once relative stops being informative. That beats
 * showing `1:36 AM` for everything: how long ago is usually the question being
 * asked, and a clock time makes the reader do the subtraction.
 */

/** Below this, "now" is truer than any number of seconds. */
const JUST_NOW_MS = 45_000

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** Whether two moments fall on the same calendar day, in the reader's own zone. */
function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/**
 * How long ago, in words. `now` is passed in rather than read from the clock so
 * that a pane can tick it and have every stamp on screen move together — and so
 * that this stays a pure function of its arguments.
 */
export function relativeTime(posted: Date, now: number): string {
  const elapsed = now - posted.getTime()

  if (elapsed < JUST_NOW_MS) return 'just now'
  if (elapsed < HOUR_MS) return RELATIVE.format(-Math.round(elapsed / MINUTE_MS), 'minute')

  // Hours only while it is still today. Past midnight "7 hours ago" is a worse
  // answer than naming the day, however few hours it has been.
  if (elapsed < 24 * HOUR_MS && sameDay(posted, new Date(now))) {
    return RELATIVE.format(-Math.round(elapsed / HOUR_MS), 'hour')
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(posted, yesterday)) return `Yesterday at ${CLOCK.format(posted)}`

  return `${DAY.format(posted)} at ${CLOCK.format(posted)}`
}
