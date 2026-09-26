export const AD_BLOCKING_SETTING = 'browsing.adBlocking'
export const ADBLOCK_SCHEME_NAME = 'fluid-adblock'

export type AdBlockingSettings = { enabled: boolean; blockTrackers: boolean; exceptions: string[] }
export type FilterGroup = 'ads' | 'trackers'
export type BlockingMode = FilterGroup | 'ads-and-trackers' | null

export function blockingMode(settings: AdBlockingSettings): BlockingMode {
  if (settings.enabled && settings.blockTrackers) return 'ads-and-trackers'
  if (settings.enabled) return 'ads'
  return settings.blockTrackers ? 'trackers' : null
}

/** Accept a hostname or pasted web address, storing only its canonical hostname. */
export function exceptionHost(input: string): string | null {
  try {
    const value = input.trim()
    if (!value || value.includes('*')) return null
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return host && host.length <= 253 ? host : null
  } catch {
    return null
  }
}

export function adBlockingSettings(value: unknown): AdBlockingSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    enabled: record.enabled !== false,
    blockTrackers: record.blockTrackers === true,
    exceptions: Array.isArray(record.exceptions)
      ? [
          ...new Set(
            record.exceptions
              .filter((item): item is string => typeof item === 'string')
              .map(exceptionHost)
              .filter((host): host is string => host !== null)
          )
        ]
      : []
  }
}

export function blocksContentOn(settings: AdBlockingSettings, url: string): boolean {
  if (!blockingMode(settings)) return false
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return !settings.exceptions.some(
      (exception) => host === exception || host.endsWith(`.${exception}`)
    )
  } catch {
    return false
  }
}
