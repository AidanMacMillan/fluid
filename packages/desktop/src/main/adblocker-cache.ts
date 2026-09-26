import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { adsAndTrackingLists, adsLists, FiltersEngine, Resources } from '@ghostery/adblocker'
import type { BlockingMode, FilterGroup } from '../shared/ad-blocking'

export const FILTER_REFRESH_INTERVAL = 24 * 60 * 60 * 1000

export function selectFilters(
  engines: Record<FilterGroup, FiltersEngine>,
  mode: BlockingMode,
  resourceGroup: FilterGroup = 'ads'
): FiltersEngine | undefined {
  // Merge rules before matching so exceptions retain their usual precedence
  // across both subscriptions. Running two independent blockers would lose that.
  if (mode === 'ads-and-trackers') {
    // Groups refresh independently, so their resource checksums can differ.
    // Both use Ghostery's same resource feed; use the most recently fetched copy.
    const merged = FiltersEngine.merge([engines.ads, engines.trackers], { skipResources: true })
    merged.resources = Resources.copy(engines[resourceGroup].resources)
    return merged
  }
  return mode ? engines[mode] : undefined
}

export async function loadFilters(
  cache: string,
  snapshot: string
): Promise<{
  engine: FiltersEngine
  updatedAt: number
}> {
  try {
    const [bytes, info] = await Promise.all([readFile(cache), stat(cache)])
    const engine = FiltersEngine.deserialize(bytes)
    // Earlier caches used an empty checksum, which made updateResources skip
    // installation entirely. Rebuild those caches from the bundled snapshot.
    if (!engine.resources.scriptlets.length || !engine.resources.resources.length) {
      throw new Error('Cached filters are missing blocking resources')
    }
    return { engine, updatedAt: info.mtimeMs }
  } catch {
    // A missing, damaged, or incompatible cache falls back to the shipped lists.
    const data = JSON.parse(gunzipSync(await readFile(snapshot)).toString('utf8')) as {
      updatedAt: number
      lists: { text: string }[]
      resources: string
    }
    const engine = FiltersEngine.parse(data.lists.map((list) => list.text).join('\n'))
    engine.updateResources(data.resources, String(data.resources.length))
    await saveFilters(cache, engine, data.updatedAt).catch((error) => {
      console.warn('Could not cache bundled ad-blocking filters:', error)
    })
    return { engine, updatedAt: data.updatedAt }
  }
}

export async function saveFilters(
  cache: string,
  engine: FiltersEngine,
  updatedAt = Date.now()
): Promise<void> {
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(`${cache}.tmp`, engine.serialize())
  const updated = new Date(updatedAt)
  await utimes(`${cache}.tmp`, updated, updated)
  await rename(`${cache}.tmp`, cache)
}

export async function downloadFilters(group: FilterGroup): Promise<FiltersEngine> {
  const signal = AbortSignal.timeout(15_000)
  const lists =
    group === 'ads' ? adsLists : adsAndTrackingLists.filter((url) => !adsLists.includes(url))
  const engine = await FiltersEngine.fromLists(async (url) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Filter download failed: HTTP ${response.status}`)
    return response
  }, lists)
  if (engine.getFilters().networkFilters.length < 1000) throw new Error('Incomplete filter update')
  return engine
}
