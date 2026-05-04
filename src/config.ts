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

// ── Theme ─────────────────────────────────────────────────────────────
// Light or dark, persisted client-side. Applied via `data-theme="dark"`
// on <html> so [data-theme="dark"] CSS overrides take effect. The page
// listens for `poise:theme-changed` to react in JS where needed.

const THEME_KEY = 'poise-theme'
export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* ignore */ }
  return 'light'
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

export function setTheme(theme: Theme) {
  if (theme !== 'light' && theme !== 'dark') return
  if (getTheme() === theme) return
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* ignore */ }
  applyTheme(theme)
  window.dispatchEvent(new CustomEvent('poise:theme-changed', { detail: { theme } }))
}

// ── Refresh rate ──────────────────────────────────────────────────────
// How often the live views (Current, Swarm, Archive) re-fetch their data.
// Two presets only — "1m" or "5m" — picked from the Settings panel.
// Stored client-side; views listen for `poise:refresh-rate-changed` and
// restart their timers.

const REFRESH_KEY = 'poise-refresh-rate'
export type RefreshRate = '1m' | '5m'

export function getRefreshRate(): RefreshRate {
  try {
    const v = localStorage.getItem(REFRESH_KEY)
    if (v === '1m' || v === '5m') return v
  } catch { /* ignore */ }
  return '1m'
}

export function getRefreshRateMs(): number {
  return getRefreshRate() === '5m' ? 5 * 60_000 : 60_000
}

export function setRefreshRate(rate: RefreshRate) {
  if (rate !== '1m' && rate !== '5m') return
  if (getRefreshRate() === rate) return
  try { localStorage.setItem(REFRESH_KEY, rate) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('poise:refresh-rate-changed', { detail: { rate } }))
}

// Shared wall-clock-aligned ticker. Every view listens for
// `poise:refresh-tick` and refreshes on it. Anchoring to interval-
// boundaries (Math.ceil(now / interval) * interval) means that
// switching views mid-cycle never causes the new view to refresh
// shortly after the one you just left — they all share one clock.
let tickTimer: ReturnType<typeof setTimeout> | null = null
let tickerStarted = false

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer)
  const intervalMs = getRefreshRateMs()
  const now = Date.now()
  // +1 to push past the current boundary if we just landed on it
  const nextBoundary = Math.ceil((now + 1) / intervalMs) * intervalMs
  tickTimer = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('poise:refresh-tick'))
    scheduleNextTick()
  }, Math.max(0, nextBoundary - now))
}

export function startRefreshTicker() {
  if (tickerStarted) return
  tickerStarted = true
  scheduleNextTick()
}

window.addEventListener('poise:refresh-rate-changed', () => {
  if (tickerStarted) scheduleNextTick()
})

// Minutes between an IANA zone's wall clock and UTC at a given UTC instant.
// Positive for zones east of UTC. Anchoring at the desired instant handles DST.
function tzOffsetMin(tz: string, atUtc: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(atUtc)
  const p = (t: string) => Number(parts.find((x) => x.type === t)!.value)
  const wallAsUtc = Date.UTC(p('year'), p('month') - 1, p('day'), p('hour'), p('minute'), p('second'))
  return Math.round((wallAsUtc - atUtc.getTime()) / 60000)
}

// Midnight (00:00) of "today + dayOffset" in the configured zone, returned as a Date.
// Day rolls at midnight, weeks start on Monday — this function only handles the day part.
export function midnightInZone(dayOffset: number = 0): Date {
  const tz = effectiveTimezone()
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = ymd.split('-').map(Number)
  // Probe the offset at noon of the target day so DST transitions near midnight
  // can't accidentally pick the wrong side of the jump.
  const noonProbe = new Date(Date.UTC(y, m - 1, d + dayOffset, 12, 0, 0))
  const offsetMin = tzOffsetMin(tz, noonProbe)
  const wallMidUtc = Date.UTC(y, m - 1, d + dayOffset, 0, 0, 0)
  return new Date(wallMidUtc - offsetMin * 60000)
}

// Most recent Monday 00:00 in the configured zone (today if today is Monday).
export function startOfWeekInZone(): Date {
  const tz = effectiveTimezone()
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date())
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  return midnightInZone(-(map[dow] ?? 0))
}
