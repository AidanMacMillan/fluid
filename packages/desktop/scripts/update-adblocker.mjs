// Refresh the separate offline ads and tracking snapshots. Keep source URLs,
// including each list's license notices, so the bundled data is inspectable.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { adsAndTrackingLists, adsLists, fetchResources, FiltersEngine } from '@ghostery/adblocker'

const fetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  return response.text()
}
const lists = await Promise.all(
  adsAndTrackingLists.map(async (url) => ({ url, text: await fetchText(url) }))
)
const resources = await fetchResources(async (url) => ({ text: () => fetchText(url) }))
const folder = new URL('../resources/adblocker/', import.meta.url)
await mkdir(folder, { recursive: true })
for (const group of ['ads', 'trackers']) {
  const selected = lists.filter(({ url }) => adsLists.includes(url) === (group === 'ads'))
  const engine = FiltersEngine.parse(selected.map((list) => list.text).join('\n'))
  engine.updateResources(resources, String(resources.length))
  if (engine.getFilters().networkFilters.length < 1000)
    throw new Error(`Incomplete ${group} snapshot`)
  if (!engine.resources.scriptlets.length || !engine.resources.resources.length)
    throw new Error(`Missing ${group} blocking resources`)
  const snapshot = { updatedAt: Date.now(), lists: selected, resources }
  const data = gzipSync(JSON.stringify(snapshot), { level: 9 })
  await writeFile(new URL(`${group}.json.gz`, folder), data)
  console.log(`Wrote ${group}: ${data.length} bytes to ${fileURLToPath(folder)}`)
}
