import { fluid } from './api'
import {
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINE_SETTING,
  searchEngine,
  type SearchEngine
} from '../../../shared/search-engine'

/**
 * The search engine the user picked in Settings, for the windows that search
 * with it: the address bar, the launcher, and the page a blank tab opens on.
 *
 * Each window has its own copy, kept current by watching the setting, so a pick
 * made in the settings panel reaches every open window without a reload. Until
 * the first answer arrives it is the default, which is also what an unset
 * setting means.
 */
class SearchEngineStore {
  current = $state<SearchEngine>(DEFAULT_SEARCH_ENGINE)

  constructor() {
    fluid.watch(
      'settings.get',
      { key: SEARCH_ENGINE_SETTING },
      (value) => (this.current = searchEngine(value)),
      (cause) => console.error('search engine setting:', cause)
    )
  }
}

export const searchEngines = new SearchEngineStore()
