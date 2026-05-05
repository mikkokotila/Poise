// Behaviors — agent automations that run on the shared refresh tick.
//
// Lives outside any view so it keeps running regardless of which view
// the user is on. Each behavior has an enabled flag persisted to
// localStorage; when enabled, the behavior listens to
// `poise:refresh-tick` and does its work on every shared interval (1m
// or 5m, governed by the global Settings refresh-rate).
//
// First (and only) behavior right now: Review New Pull Requests —
// watch for new PRs in the org authored by the Poise user (settings.me)
// and auto-trigger `agent-interface --pr-review` for each one. We
// snapshot the currently-open PR set on enable / app boot so existing
// PRs don't all flood the agent on first activation; only PRs that
// appear AFTER the snapshot trigger a review.

import { getSettings } from './config'

export type BehaviorKey = 'review-new-prs'

export interface BehaviorMeta {
  key: BehaviorKey
  label: string
}

export const BEHAVIORS: BehaviorMeta[] = [
  { key: 'review-new-prs', label: 'Review New Pull Requests' },
]

const STORAGE_KEY = 'poise-behaviors-v1'

interface PersistedState {
  [k: string]: { enabled: boolean }
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function savePersisted(s: PersistedState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

const persisted: PersistedState = loadPersisted()

// Session-scoped — the set of PR keys (`repo#num`) that already
// existed at the time the behavior became active. New PRs are anything
// that turns up later. Re-snapshotted on enable, and on app boot when
// the behavior is already on, so reloads don't double-trigger.
const seenSets: Record<BehaviorKey, Set<string> | null> = {
  'review-new-prs': null,
}

export function isEnabled(key: BehaviorKey): boolean {
  return !!persisted[key]?.enabled
}

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  persisted[key] = { enabled }
  savePersisted(persisted)
  if (enabled) {
    await snapshot(key)
  } else {
    seenSets[key] = null
  }
  window.dispatchEvent(new CustomEvent('poise:behaviors-changed', { detail: { key, enabled } }))
}

// Pull the current open-PR set from the proxy so we know what was
// already there at activation time. Anything new after this is a hit.
async function fetchOpenPrsByPoiseUser(): Promise<{ repo: string, number: number, url: string }[]> {
  const me = getSettings().me
  if (!me) return []
  try {
    const res = await fetch('/api/gh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'list',
        record_type: 'pull_request',
        record_state: 'open',
        author: me,
        limit: 500,
      }),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.records || []).map((r: any) => ({ repo: r.repo, number: r.number, url: r.url }))
  } catch {
    return []
  }
}

async function snapshot(key: BehaviorKey): Promise<void> {
  if (key === 'review-new-prs') {
    const prs = await fetchOpenPrsByPoiseUser()
    seenSets[key] = new Set(prs.map((p) => `${p.repo}#${p.number}`))
  }
}

async function tickReviewNewPrs(): Promise<void> {
  // If we don't have a snapshot yet (boot path with persisted enabled
  // but snapshot never taken), take one now and bail without firing —
  // we only fire on PRs that appear AFTER a snapshot.
  if (!seenSets['review-new-prs']) {
    await snapshot('review-new-prs')
    return
  }
  const prs = await fetchOpenPrsByPoiseUser()
  const seen = seenSets['review-new-prs']!
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`
    if (seen.has(key)) continue
    seen.add(key)
    // Fire-and-forget: pr-review server-side detaches the agent run,
    // so we don't await its completion. Errors are logged but don't
    // halt subsequent triggers.
    fetch('/api/pr-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pr.url }),
    }).catch((err) => console.error('[behaviors] pr-review trigger failed for', key, err))
  }
}

export function startBehaviorsRuntime() {
  // If a behavior was already enabled from a previous session, take
  // a fresh snapshot so PRs that opened while we were offline don't
  // trigger en masse on the next tick.
  if (isEnabled('review-new-prs')) {
    snapshot('review-new-prs')
  }
  window.addEventListener('poise:refresh-tick', () => {
    if (isEnabled('review-new-prs')) tickReviewNewPrs()
  })
}
