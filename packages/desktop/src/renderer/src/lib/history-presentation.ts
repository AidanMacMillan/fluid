import type { HistoryEntry, Tab } from '@fluid/sdk'

export type HistoryDay = {
  key: string
  label: string
  date: string
  visits: { entry: HistoryEntry; index: number }[]
}

const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric'
})
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Calendar days in the user's timezone, including across daylight-saving changes. */
export function historyDays(entries: HistoryEntry[], now: number): HistoryDay[] {
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const days: HistoryDay[] = []
  const sorted = [...entries].sort(
    (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime()
  )
  sorted.forEach((entry, index) => {
    const date = new Date(entry.visitedAt)
    const key = dayKey(date)
    let day = days.at(-1)
    if (day?.key !== key) {
      day = {
        key,
        label: key === dayKey(today) ? 'Today' : key === dayKey(yesterday) ? 'Yesterday' : '',
        date: DAY.format(date),
        visits: []
      }
      days.push(day)
    }
    day.visits.push({ entry, index })
  })
  return days
}

export function historyTime(entry: HistoryEntry): string {
  return CLOCK.format(new Date(entry.visitedAt))
}

export function historyLocation(entry: HistoryEntry): string {
  if (entry.type === 'browser' && entry.location) {
    try {
      return new URL(entry.location).host.replace(/^www\./, '')
    } catch {
      return entry.location
    }
  }
  return entry.location || entry.label
}

function webOrigin(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null
  } catch {
    return null
  }
}

/** Reuse known icons across a site's visits, including icons arriving after the list. */
export function historyFavicon(
  entry: HistoryEntry,
  tabs: Tab[],
  failedSources: readonly string[] = []
): string | null {
  if (entry.type !== 'browser') return null
  const usable = (source: unknown): source is string =>
    typeof source === 'string' &&
    source.startsWith('data:image/') &&
    !failedSources.includes(source)
  if (usable(entry.favicon)) return entry.favicon
  const origin = webOrigin(entry.location)
  if (!origin) return null
  for (const tab of tabs) {
    if (
      tab.type === 'browser' &&
      webOrigin(tab.payload.url) === origin &&
      usable(tab.payload.favicon)
    ) {
      return tab.payload.favicon
    }
  }
  return null
}
