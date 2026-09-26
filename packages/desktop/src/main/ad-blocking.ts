import { join } from 'node:path'
import { app } from 'electron'
import { AdBlocker } from './adblocker'
import {
  downloadFilters,
  FILTER_REFRESH_INTERVAL,
  loadFilters,
  saveFilters,
  selectFilters
} from './adblocker-cache'
import { getSetting } from './db/settings'
import { subscribe } from './api/bus'
import {
  AD_BLOCKING_SETTING,
  adBlockingSettings,
  blockingMode,
  blocksContentOn,
  type FilterGroup
} from '../shared/ad-blocking'

let settings = adBlockingSettings(null)
export const adBlocker = new AdBlocker((url) => blocksContentOn(settings, url))

/** Ready before any browsing view loads, even on the first launch while offline. */
export async function registerAdBlocking(): Promise<void> {
  settings = adBlockingSettings(await getSetting(AD_BLOCKING_SETTING))
  const groups: FilterGroup[] = ['ads', 'trackers']
  const cache = (group: FilterGroup): string =>
    join(app.getPath('userData'), 'adblocker', `${group}.bin`)
  const [ads, trackers] = await Promise.all(
    groups.map((group) =>
      loadFilters(cache(group), join(__dirname, `../../resources/adblocker/${group}.json.gz`))
    )
  )
  const engines = { ads: ads.engine, trackers: trackers.engine }
  const updatedAt = { ads: ads.updatedAt, trackers: trackers.updatedAt }
  let activeMode = blockingMode(settings)
  const applyFilters = (): void => {
    adBlocker.engine = selectFilters(
      engines,
      blockingMode(settings),
      updatedAt.ads >= updatedAt.trackers ? 'ads' : 'trackers'
    )
  }
  applyFilters()
  adBlocker.registerIPC()
  let updating = false

  const refresh = async (): Promise<void> => {
    if (updating) return
    const due = groups.filter(
      (group) =>
        (group === 'ads' ? settings.enabled : settings.blockTrackers) &&
        Date.now() - updatedAt[group] >= FILTER_REFRESH_INTERVAL
    )
    if (!due.length) return
    updating = true
    let changed = false
    try {
      await Promise.all(
        due.map(async (group) => {
          try {
            const engine = await downloadFilters(group)
            await saveFilters(cache(group), engine)
            engines[group] = engine
            updatedAt[group] = Date.now()
            changed = true
          } catch (error) {
            // Retain the working engine when offline or when any subscription fails.
            console.warn(`Could not refresh ${group} filters:`, error)
          }
        })
      )
      // Use the latest switches, even if they changed while a download was in flight.
      if (changed) applyFilters()
    } finally {
      updating = false
    }
  }
  subscribe((event) => {
    if (event.type !== 'setting.changed' || event.key !== AD_BLOCKING_SETTING) return
    settings = adBlockingSettings(event.value)
    const nextMode = blockingMode(settings)
    if (nextMode !== activeMode) {
      activeMode = nextMode
      applyFilters()
    }
    void refresh()
  })
  void refresh()
  const timer = setInterval(() => void refresh(), 60 * 60 * 1000)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
}
