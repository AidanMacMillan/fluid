import { allSettings, deleteSetting, getSetting, setSetting } from '../db/settings'
import { emit } from './bus'

export async function get(key: string): Promise<unknown> {
  return (await getSetting(key)) ?? null
}

export async function set(key: string, value: unknown): Promise<void> {
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
