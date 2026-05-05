// Thin client for the Behaviors view.
//
// All polling, snapshotting, and triggering live SERVER-SIDE in
// server/behaviors.ts — that's the only place a behavior can run
// reliably (browser tabs close, reload, get backgrounded). This
// module is just labels + an HTTP client for the toggle.

export type BehaviorKey = 'review-new-prs'

export interface BehaviorMeta {
  key: BehaviorKey
  label: string
}

export const BEHAVIORS: BehaviorMeta[] = [
  { key: 'review-new-prs', label: 'Review New Pull Requests' },
]

export type BehaviorSetting = 'p0' | 'p1' | 'p2'

// In-memory mirror of the server's enabled + setting maps, kept in
// sync via /api/behaviors GET on view init and every successful POST.
const enabledByKey: Partial<Record<BehaviorKey, boolean>> = {}
const settingByKey: Partial<Record<BehaviorKey, BehaviorSetting>> = {}

export function isEnabled(key: BehaviorKey): boolean {
  return !!enabledByKey[key]
}

export function getSetting(key: BehaviorKey): BehaviorSetting {
  return settingByKey[key] || 'p2'
}

async function postBehavior(key: BehaviorKey, body: { enabled?: boolean, setting?: BehaviorSetting }) {
  const res = await fetch(`/api/behaviors/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  // Optimistic local update so the toggle UI doesn't flicker; the
  // server is authoritative and a re-fetch on next view-mount will
  // correct any drift.
  enabledByKey[key] = enabled
  try {
    const data = await postBehavior(key, { enabled })
    enabledByKey[key] = !!data.enabled
  } catch (err) {
    enabledByKey[key] = !enabled
    throw err
  }
  window.dispatchEvent(new CustomEvent('poise:behaviors-changed', { detail: { key, enabled: enabledByKey[key] } }))
}

export async function setSetting(key: BehaviorKey, setting: BehaviorSetting): Promise<void> {
  const previous = settingByKey[key] ?? 'p2'
  settingByKey[key] = setting
  try {
    const data = await postBehavior(key, { setting })
    if (data.setting) settingByKey[key] = data.setting
  } catch (err) {
    settingByKey[key] = previous
    throw err
  }
}

// Called by the view on init to load the current state from the server.
export async function refreshState(): Promise<void> {
  try {
    const res = await fetch('/api/behaviors')
    if (!res.ok) return
    const data = await res.json()
    for (const k of Object.keys(data) as BehaviorKey[]) {
      enabledByKey[k] = !!data[k]?.enabled
      if (data[k]?.setting) settingByKey[k] = data[k].setting
    }
  } catch { /* leave as-is */ }
}
