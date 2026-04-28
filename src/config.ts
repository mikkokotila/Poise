// Client-side cache of server settings (org, me, timezone).
// Loaded once at startup from /api/settings, refreshed whenever the user saves
// in the Settings panel.

export interface AppSettings {
  org: string
  me: string
  timezone: string
}

let current: AppSettings = { org: '', me: '', timezone: '' }
let loaded = false

export async function loadSettings(): Promise<AppSettings> {
  try {
    const res = await fetch('/api/settings')
    if (res.ok) current = await res.json()
  } catch { /* ignore — leave defaults */ }
  loaded = true
  return current
}

export function getSettings(): AppSettings {
  return current
}

export function settingsLoaded(): boolean {
  return loaded
}

export function settingsReady(): boolean {
  return !!(current.org && current.me)
}

export function setLocalSettings(s: AppSettings) {
  current = s
}

// Default to the browser's timezone if the user hasn't picked one yet.
export function effectiveTimezone(): string {
  if (current.timezone) return current.timezone
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
}
