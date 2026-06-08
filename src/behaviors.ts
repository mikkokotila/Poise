// Thin client for the Behaviors view.
//
// All polling, snapshotting, and triggering live SERVER-SIDE in
// server/behaviors.ts — that's the only place a behavior can run
// reliably (browser tabs close, reload, get backgrounded). This
// module is just labels + an HTTP client for the toggle.

export type BehaviorKey = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking'

export interface BehaviorMeta {
  key: BehaviorKey
  label: string
  // Whether this behavior exposes a priority-ceiling setting (p0..p4).
  // The Behaviors view renders an em dash in the Setting cell when
  // this is false.
  hasSetting: boolean
  // Whether this behavior has a memory scratchpad — true only for the
  // agent-backed behaviors whose prompt the note can be injected into.
  // resolve-unblocking calls github-interface directly with no agent,
  // so it has nothing to receive a note; the Memory cell shows a dash.
  hasMemory: boolean
}

// The trilogy: initial review → follow-up review/approval → final
// gate-clearing so a human can merge. Order matters for display since
// the view renders rows in the listed sequence.
export const BEHAVIORS: BehaviorMeta[] = [
  { key: 'review-new-prs',     label: 'Review New Pull Requests',      hasSetting: true,  hasMemory: true  },
  { key: 'approve-prs',        label: 'Approve Pull Requests',         hasSetting: false, hasMemory: true  },
  { key: 'resolve-unblocking', label: 'Resolve Unblocking Conversations', hasSetting: false, hasMemory: false },
]

export type BehaviorSetting = 'p0' | 'p1' | 'p2' | 'p3' | 'p4'
export interface LastTriggered { at: string; target: string }

// In-memory mirror of the server's state, kept in sync via
// /api/behaviors GET on view init and every successful POST.
const enabledByKey: Partial<Record<BehaviorKey, boolean>> = {}
const settingByKey: Partial<Record<BehaviorKey, BehaviorSetting>> = {}
const lastByKey: Partial<Record<BehaviorKey, LastTriggered | null>> = {}
const scratchpadByKey: Partial<Record<BehaviorKey, string>> = {}

export function isEnabled(key: BehaviorKey): boolean {
  return !!enabledByKey[key]
}

export function getSetting(key: BehaviorKey): BehaviorSetting {
  return settingByKey[key] || 'p2'
}

export function getLastTriggered(key: BehaviorKey): LastTriggered | null {
  return lastByKey[key] || null
}

export function getScratchpad(key: BehaviorKey): string {
  return scratchpadByKey[key] || ''
}

async function postBehavior(key: BehaviorKey, body: { enabled?: boolean, setting?: BehaviorSetting, scratchpad?: string }) {
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

export async function setScratchpad(key: BehaviorKey, text: string): Promise<void> {
  const previous = scratchpadByKey[key] ?? ''
  scratchpadByKey[key] = text
  try {
    const data = await postBehavior(key, { scratchpad: text })
    if (typeof data.scratchpad === 'string') scratchpadByKey[key] = data.scratchpad
  } catch (err) {
    scratchpadByKey[key] = previous
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
      scratchpadByKey[k] = typeof data[k]?.scratchpad === 'string' ? data[k].scratchpad : ''
      lastByKey[k] = data[k]?.lastTriggered ?? null
    }
  } catch { /* leave as-is */ }
}
