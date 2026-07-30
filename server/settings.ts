import { getMeta, setMeta } from './db'
import { invalidateRepoListCache } from './gh'

// GitHub logins and organization names: 1–39 characters, alphanumerics and
// single hyphens, not leading or trailing. Stored with nothing but .trim()
// before, so a pasted URL saved cleanly and every query built from it came
// back empty with no indication why.
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

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
  // Validate everything before writing anything: the loop below writes key by
  // key, so a value rejected halfway used to leave the earlier ones applied.
  const next: Partial<Settings> = {}
  for (const k of KEYS) {
    const v = partial[k]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if ((k === 'org' || k === 'me') && trimmed && !GITHUB_NAME.test(trimmed)) {
      throw new Error(`${k} must be a GitHub name: letters, digits and single hyphens`)
    }
    next[k] = trimmed
  }
  const orgChanged = typeof next.org === 'string' && next.org !== (getMeta('org') || '')
  for (const k of KEYS) {
    const v = next[k]
    if (typeof v === 'string') setMeta(k, v)
  }
  if (orgChanged) invalidateRepoListCache()
  return getSettings()
}

export function isReady(): boolean {
  const s = getSettings()
  return !!(s.org && s.me)
}
