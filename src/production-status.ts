// The one line in Settings that says whether a merge reached production.
// Kept free of imports so it can be tested under the node environment, like
// the behaviors client state.

// The production updater's last run, as /api/health passes it through
// (server/production-update.ts). `unknown` on a dev server, or before the
// updater has run since this record existed.
export interface ProductionUpdate {
  status: 'current' | 'updated' | 'failed' | 'unknown'
  checkedAt: string | null
  deployedCommit: string | null
  remoteCommit: string | null
  behind: number | null
  failingSince: string | null
  error: string | null
}

// The updater runs every minute; a record older than this means it is not
// running at all, which matters more than whatever it last found.
const UPDATER_SILENT_AFTER_MS = 10 * 60_000

function short(commit: string | null): string {
  return commit ? commit.slice(0, 7) : '?'
}

function minutesAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes === 0) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return new Date(iso).toLocaleString()
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// One line, in words: what production is running, what `main` is at, and
// whether the updater is keeping the two together. Null when there is nothing
// to say (no record), so the group hides instead of showing a placeholder.
export function productionSummary(update: ProductionUpdate, now = Date.now()): { text: string, level: 'info' | 'error' } | null {
  if (update.status === 'unknown' || !update.checkedAt) return null
  const deployed = `Deployed ${short(update.deployedCommit)}`
  if (now - Date.parse(update.checkedAt) >= UPDATER_SILENT_AFTER_MS) {
    return { text: `${deployed} — the updater has not run since ${clock(update.checkedAt)}; merges are not reaching production.`, level: 'error' }
  }
  if (update.status === 'failed') {
    const behind = update.behind ? ` — ${update.behind} commit${update.behind === 1 ? '' : 's'} behind` : ''
    const since = update.failingSince ? ` since ${clock(update.failingSince)}` : ''
    const main = update.remoteCommit ? ` · main ${short(update.remoteCommit)}` : ''
    return { text: `${deployed}${main}${behind}; updater failing${since}: ${update.error || 'no error recorded'}`, level: 'error' }
  }
  const main = update.remoteCommit ? ` · main ${short(update.remoteCommit)}` : ''
  return { text: `${deployed}${main} — up to date, checked ${minutesAgo(update.checkedAt, now)}.`, level: 'info' }
}
