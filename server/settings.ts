import { getMeta, setMeta } from './db'

export interface Settings {
  org: string
  me: string
  timezone: string
}

const KEYS: Array<keyof Settings> = ['org', 'me', 'timezone']

export function getSettings(): Settings {
  return {
    org: getMeta('org') || '',
    me: getMeta('me') || '',
    timezone: getMeta('timezone') || '',
  }
}

export function setSettings(partial: Partial<Settings>): Settings {
  for (const k of KEYS) {
    const v = partial[k]
    if (typeof v === 'string') setMeta(k, v.trim())
  }
  return getSettings()
}

export function isReady(): boolean {
  const s = getSettings()
  return !!(s.org && s.me)
}
