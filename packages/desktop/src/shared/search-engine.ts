export const SEARCH_ENGINE_SETTING = 'search.engine'

/** Stands in for the search in a template, as in every other browser's custom-engine form. */
export const QUERY_PLACEHOLDER = '%s'

export type SearchEngine = {
  id: string
  name: string
  /** The address that runs a search, with `%s` where the (encoded) query goes. */
  searchUrl: string
  /** Where a blank tab opens: the engine's own front page. */
  homeUrl: string
}

/** A preset as the settings tiles draw it: a logo where the icon set has one, a monogram where not. */
export type SearchEnginePreset = SearchEngine & { icon: string | null }

// Class names are written out in full so the icon plugin can see them in source.
export const SEARCH_ENGINE_PRESETS: readonly SearchEnginePreset[] = [
  {
    id: 'google',
    name: 'Google',
    searchUrl: 'https://www.google.com/search?q=%s',
    homeUrl: 'https://www.google.com',
    icon: 'icon-[logos--google-icon]'
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    homeUrl: 'https://duckduckgo.com',
    icon: 'icon-[logos--duckduckgo]'
  },
  {
    id: 'bing',
    name: 'Bing',
    searchUrl: 'https://www.bing.com/search?q=%s',
    homeUrl: 'https://www.bing.com',
    icon: 'icon-[logos--bing]'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    searchUrl: 'https://search.brave.com/search?q=%s',
    homeUrl: 'https://search.brave.com',
    icon: 'icon-[logos--brave]'
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    searchUrl: 'https://search.yahoo.com/search?p=%s',
    homeUrl: 'https://search.yahoo.com',
    icon: null
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    homeUrl: 'https://www.ecosia.org',
    icon: null
  }
]

export const DEFAULT_SEARCH_ENGINE: SearchEnginePreset = SEARCH_ENGINE_PRESETS[0]

/** A custom engine as saved: a name for the tile, and the template it searches with. */
export type CustomSearchEngine = { id: string; name: string; url: string }

/** More than this is a list nobody is choosing from. */
export const MAX_CUSTOM_ENGINES = 12

/**
 * Checks a custom template: a web address with `%s` in it. Returns the
 * template cleaned up, or null when it would not search for anything.
 */
export function customSearchTemplate(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text.includes(QUERY_PLACEHOLDER)) return null
  try {
    const parsed = new URL(text.replaceAll(QUERY_PLACEHOLDER, 'query'))
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? text : null
  } catch {
    return null
  }
}

function customEngine(value: unknown, fallbackId?: string): CustomSearchEngine | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name, url } = value as Record<string, unknown>
  const template = customSearchTemplate(url)
  const label = typeof name === 'string' ? name.trim().slice(0, 40) : ''
  const key = typeof id === 'string' && id !== '' ? id : fallbackId
  return template && label && key ? { id: key, name: label, url: template } : null
}

/**
 * What is saved: the id of the engine in use — a preset's, or one of the custom
 * engines' — and every custom engine, whether or not one of them is in use.
 */
export type SearchEngineSetting = { id: string; custom: CustomSearchEngine[] }

/** The one-engine shape this was first saved in, which is still out there. */
const LEGACY_CUSTOM_ID = 'custom'

/** Reads the saved value, falling back to Google for anything missing or damaged. */
export function searchEngineSetting(value: unknown): SearchEngineSetting {
  const saved =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

  // A lone object is the first format, which had no ids: it is the one engine `custom`.
  const legacy = !Array.isArray(saved.custom) && saved.custom != null
  const entries = Array.isArray(saved.custom) ? saved.custom : legacy ? [saved.custom] : []
  const custom: CustomSearchEngine[] = []
  for (const entry of entries) {
    const engine = customEngine(entry, legacy ? LEGACY_CUSTOM_ID : undefined)
    // A preset's id is not for a custom engine to take, and nor is one already taken.
    if (!engine || SEARCH_ENGINE_PRESETS.some((preset) => preset.id === engine.id)) continue
    if (custom.some((existing) => existing.id === engine.id)) continue
    custom.push(engine)
    if (custom.length === MAX_CUSTOM_ENGINES) break
  }

  const id = typeof saved.id === 'string' ? saved.id : DEFAULT_SEARCH_ENGINE.id
  const known =
    SEARCH_ENGINE_PRESETS.some((preset) => preset.id === id) ||
    custom.some((engine) => engine.id === id)
  return { id: known ? id : DEFAULT_SEARCH_ENGINE.id, custom }
}

/** The engine a saved value selects. */
export function searchEngine(value: unknown): SearchEngine {
  const setting = searchEngineSetting(value)
  const custom = setting.custom.find((engine) => engine.id === setting.id)
  if (custom) return customToEngine(custom)
  return SEARCH_ENGINE_PRESETS.find((preset) => preset.id === setting.id) ?? DEFAULT_SEARCH_ENGINE
}

export function customToEngine(custom: CustomSearchEngine): SearchEngine {
  let homeUrl = DEFAULT_SEARCH_ENGINE.homeUrl
  try {
    homeUrl = new URL(custom.url.replaceAll(QUERY_PLACEHOLDER, 'query')).origin
  } catch {
    // customSearchTemplate has already vetted it; the default home is only a guard.
  }
  return { id: custom.id, name: custom.name, searchUrl: custom.url, homeUrl }
}

/** The address that searches `engine` for `query`. */
export function searchAddress(engine: Pick<SearchEngine, 'searchUrl'>, query: string): string {
  // A function replacement, so a `$&` typed into the search is searched for, not expanded.
  return engine.searchUrl.replaceAll(QUERY_PLACEHOLDER, () => encodeURIComponent(query.trim()))
}
