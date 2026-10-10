import { fluid } from './api'
import { SEARCH_ENGINE_SETTING, type SearchEngineSetting } from '../../../shared/search-engine'

/** Saves the picked engine and the custom ones kept alongside it. */
export async function saveSearchEngine(next: SearchEngineSetting): Promise<void> {
  // Svelte state can contain proxies; Electron IPC needs a plain object.
  await fluid.settings.set({
    key: SEARCH_ENGINE_SETTING,
    value: { id: next.id, custom: next.custom.map((engine) => ({ ...engine })) }
  })
}
