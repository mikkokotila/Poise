// Browser-side reading of the self-improvement status: what the deploy card
// shows for a session, how often to ask again, and when a rollback button is
// honest. Pure functions over the shared public types; no DOM, no fetch.

import type { BuildIdentity, SelfChange, SelfChangeState, SelfRelease, SelfUpdateStatus } from './self-update-types'

const CHANGE_STATES: readonly SelfChangeState[] = ['implementing', 'checking', 'awaiting_ci', 'merging', 'merged', 'deploying', 'verifying', 'live', 'reverting', 'reverted', 'failed', 'blocked', 'superseded']

/** States after which the controller does nothing more for the change. */
export const TERMINAL_STATES: ReadonlySet<SelfChangeState> = new Set(['live', 'reverted', 'failed', 'blocked', 'superseded'])

/** Status polling while a change is moving, and while nothing is. */
export const POLL_ACTIVE_MS = 5_000
export const POLL_IDLE_MS = 60_000
/** Backoff cap once the endpoint errors or is unavailable. */
export const POLL_MAX_MS = 5 * 60_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
}

export function parseRelease(v: unknown): SelfRelease | null {
  if (!isRecord(v)) return null
  if (typeof v.id !== 'string' || !v.id || typeof v.sha !== 'string') return null
  return {
    id: v.id,
    sha: v.sha,
    root: typeof v.root === 'string' ? v.root : '',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    callerSha: typeof v.callerSha === 'string' ? v.callerSha : '',
  }
}

export function parseChange(v: unknown): SelfChange | null {
  if (!isRecord(v)) return null
  if (typeof v.id !== 'string' || !v.id) return null
  if (typeof v.state !== 'string' || !CHANGE_STATES.includes(v.state as SelfChangeState)) return null
  const sourceRevert = isRecord(v.sourceRevert) && typeof v.sourceRevert.state === 'string'
    ? { state: v.sourceRevert.state as NonNullable<SelfChange['sourceRevert']>['state'], prUrl: optionalString(v.sourceRevert.prUrl), error: optionalString(v.sourceRevert.error) }
    : undefined
  return {
    id: v.id,
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
    instance: typeof v.instance === 'string' ? v.instance : '',
    request: typeof v.request === 'string' ? v.request : '',
    title: typeof v.title === 'string' ? v.title : '',
    repository: 'mikkokotila/Poise',
    branch: typeof v.branch === 'string' ? v.branch : '',
    baseSha: typeof v.baseSha === 'string' ? v.baseSha : '',
    headSha: optionalString(v.headSha),
    mergeSha: optionalString(v.mergeSha),
    prNumber: typeof v.prNumber === 'number' && Number.isSafeInteger(v.prNumber) ? v.prNumber : undefined,
    prUrl: optionalString(v.prUrl),
    state: v.state as SelfChangeState,
    error: optionalString(v.error),
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    releaseId: optionalString(v.releaseId),
    previousReleaseId: optionalString(v.previousReleaseId),
    canRevert: v.canRevert === true,
    sourceRevert,
  }
}

/** Read a status body defensively. Anything that is not the contract shape —
 *  an older server answering `{}`, a 404 page — reads as "unavailable" rather
 *  than throwing, so a missing supervisor leaves the Chat view exactly as it was. */
export function parseSelfUpdateStatus(v: unknown): SelfUpdateStatus | null {
  if (!isRecord(v) || typeof v.enabled !== 'boolean' || typeof v.available !== 'boolean') return null
  const changes = Array.isArray(v.changes) ? v.changes.map(parseChange).filter((c): c is SelfChange => !!c) : []
  const hold = isRecord(v.hold) && typeof v.hold.changeId === 'string'
    ? { changeId: v.hold.changeId, sha: typeof v.hold.sha === 'string' ? v.hold.sha : '', reason: typeof v.hold.reason === 'string' ? v.hold.reason : '' }
    : null
  return {
    enabled: v.enabled,
    available: v.available,
    reason: optionalString(v.reason),
    activeRelease: parseRelease(v.activeRelease),
    previousRelease: parseRelease(v.previousRelease),
    hold,
    changes,
    recoveryUrl: optionalString(v.recoveryUrl),
  }
}

/** Build identity as `/api/health` carries it; `null` when the server does not report one. */
export function parseBuildIdentity(v: unknown): BuildIdentity | null {
  if (!isRecord(v) || !isRecord(v.build)) return null
  const sha = isSha(v.build.sha) ? v.build.sha : null
  const releaseId = typeof v.build.releaseId === 'string' && v.build.releaseId ? v.build.releaseId : null
  return { sha, releaseId }
}

/** The change a session's card shows: the newest one this session started or
 *  is the dedicated workspace of. Nothing else — the card never borrows another
 *  session's change even if the server returned it. */
export function selectChangeForSession(changes: SelfChange[], sessionId: string | null, selfChangeId?: string, localIds: ReadonlySet<string> = new Set()): SelfChange | null {
  if (!sessionId) return null
  const related = changes.filter((c) => c.sessionId === sessionId || c.id === selfChangeId || localIds.has(c.id))
  if (!related.length) return null
  return related.slice().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0]
}

export function isTerminal(state: SelfChangeState): boolean {
  return TERMINAL_STATES.has(state)
}

/** How long to wait before the next status request. Moving changes poll fast;
 *  an unreachable endpoint backs off, bounded, and never stops entirely. */
export function nextPollDelay(input: { available: boolean, failed: boolean, moving: boolean, previous: number }): number {
  if (input.failed) return Math.min(Math.max(input.previous * 2, POLL_IDLE_MS), POLL_MAX_MS)
  if (!input.available) return POLL_IDLE_MS
  return input.moving ? POLL_ACTIVE_MS : POLL_IDLE_MS
}

/** Whether a one-click Revert for this change is honest right now: the server
 *  says so, the change carries the release it produced, and that release is the
 *  one currently active. An older card can never revert a newer change. Nothing
 *  else gates it — not `enabled`, not `available`, not a release token: a
 *  revert restores retained local artifacts and needs no network, model or
 *  GitHub, so the button must not disappear when those do. */
export function revertTarget(change: SelfChange, status: SelfUpdateStatus): { changeId: string, expectedReleaseId: string } | null {
  if (!change.canRevert || !change.releaseId) return null
  if (!status.activeRelease || status.activeRelease.id !== change.releaseId) return null
  if (change.state === 'reverting' || change.state === 'reverted') return null
  return { changeId: change.id, expectedReleaseId: change.releaseId }
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

export function stateLabel(state: SelfChangeState): string {
  switch (state) {
    case 'implementing': return 'Implementing'
    case 'checking': return 'Running checks'
    case 'awaiting_ci': return 'Waiting for CI'
    case 'merging': return 'Merging'
    case 'merged': return 'Merged'
    case 'deploying': return 'Deploying'
    case 'verifying': return 'Verifying'
    case 'live': return 'Live'
    case 'reverting': return 'Reverting'
    case 'reverted': return 'Reverted'
    case 'failed': return 'Failed'
    case 'blocked': return 'Needs manual approval'
    case 'superseded': return 'Superseded'
  }
}

/** Whether this tab already runs the build a change produced. `null` when it cannot be known. */
export function tabRunsChange(change: SelfChange, status: SelfUpdateStatus, browserSha: string | null): boolean | null {
  if (!browserSha) return null
  const release = change.releaseId && status.activeRelease?.id === change.releaseId ? status.activeRelease : null
  const sha = release?.sha || change.mergeSha
  if (!sha) return null
  return sha === browserSha
}
