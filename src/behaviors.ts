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

// In-memory mirror of the server's enabled map, kept in sync via the
// /api/behaviors GET on view init and every successful toggle POST.
const enabledByKey: Partial<Record<BehaviorKey, boolean>> = {}

export function isEnabled(key: BehaviorKey): boolean {
  return !!enabledByKey[key]
}

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  // Optimistic local update so the toggle UI doesn't flicker; the
  // server is authoritative and a re-fetch on next view-mount will
  // correct any drift.
  enabledByKey[key] = enabled
  try {
    const res = await fetch(`/api/behaviors/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    // Trust the server's echoed value
    enabledByKey[key] = !!data.enabled
  } catch (err) {
    // Roll back on failure so the UI matches reality
    enabledByKey[key] = !enabled
    throw err
  }
  window.dispatchEvent(new CustomEvent('poise:behaviors-changed', { detail: { key, enabled: enabledByKey[key] } }))
}

// Called by the view on init to load the current state from the server.
export async function refreshState(): Promise<void> {
  try {
    const res = await fetch('/api/behaviors')
    if (!res.ok) return
    const data = await res.json()
    for (const k of Object.keys(data) as BehaviorKey[]) {
      enabledByKey[k] = !!data[k]?.enabled
    }
  } catch { /* leave as-is */ }
}
