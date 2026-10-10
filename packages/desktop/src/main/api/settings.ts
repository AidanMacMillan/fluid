import { allSettings, deleteSetting, getSetting, setSetting } from '../db/settings'
import { emit } from './bus'
import { AD_BLOCKING_SETTING, adBlockingSettings } from '../../shared/ad-blocking'
import { SEARCH_ENGINE_SETTING, searchEngineSetting } from '../../shared/search-engine'
import {
  UI_DENSITY_SETTING,
  uiDensity,
  WINDOW_TRANSPARENCY_SETTING,
  windowTransparency
} from '../../shared/appearance'

export async function get(key: string): Promise<unknown> {
  return (await getSetting(key)) ?? null
}

export async function set(key: string, value: unknown): Promise<void> {
  if (key === AD_BLOCKING_SETTING) value = adBlockingSettings(value)
  if (key === SEARCH_ENGINE_SETTING) value = searchEngineSetting(value)
  if (key === WINDOW_TRANSPARENCY_SETTING) value = windowTransparency(value)
  if (key === UI_DENSITY_SETTING) value = uiDensity(value)
  await setSetting(key, value)
  emit({ type: 'setting.changed', key, value })
}

export async function remove(key: string): Promise<void> {
  await deleteSetting(key)
  emit({ type: 'setting.changed', key, value: null })
}

export async function all(): Promise<Record<string, unknown>> {
  return allSettings()
}
