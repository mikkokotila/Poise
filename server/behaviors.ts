import { prepareModelClis } from './provider-clis'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'
// Server-side behavior runtime. Lives with the Poise HTTP server
// so the toggle keeps working when the browser tab is closed,
// reloaded, or backgrounded — none of which the original
// browser-side runtime survived.
//
// Mirrors the browser's wall-clock-aligned ticker (see src/config.ts
// `startRefreshTicker`) but in Node. On every tick, each enabled
// behavior runs its check; the seen ledger lives in SQLite so claims are
// atomic across overlapping ticks and multiple server processes.
//
// Behavior preferences are global; each ready account has its own datastore scope.
// Repository-qualified targets preserve the existing durable launch ledger;
// snapshots and process locks are isolated by organization.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { ISSUE_REVIEW_BEHAVIOR, fetchAgentLogSnapshot, quarantinedLogMayMatch, type LogEntry } from './agent'
import { claudeAuth } from './claude-auth'
import { REVIEW_POLICY, needsClaude, reviewChoice, reviewPanel, type ReviewPlace } from './review-model'
import { type Catalog, type ReviewerSlot, REVIEWER_SLOTS, loadCatalog } from './models'
import {
  db,
  claimPrOperationOwned,
  claimSeenOwned,
  claimSeenOwnedAs,
  clearSeenExceptLaunched,
  clearUnreadableBehaviorLaunchOwned,
  completeBehaviorLaunchOwned,
  completeIssueReviewLaunchOwned,
  countBehaviorDeadLetters,
  hasExpiredPreLaunchClaim,
  completeSeenOwned,
  getFailedBehaviorLaunch,
  getMeta as databaseGetMeta,
  hasSeen,
  latestApprovalBasisLaunch,
  linkBehaviorLaunchCallOwned,
  listBehaviorLaunchClaims as databaseListBehaviorLaunchClaims,
  listBehaviorDeadLetters as databaseListBehaviorDeadLetters,
  listBehaviorIncidents as databaseListBehaviorIncidents,
  listSeenTargets,
  listSnapshotOnlySeen,
  markBehaviorLaunchIntentOwned,
  recordBehaviorDeadLetter,
  quarantineBehaviorLaunchOwned,
  retireBehaviorDeadLetter,
  retireBehaviorDeadLettersForClosedPrs,
  retireBehaviorDeadLettersForTarget,
  recordSeen,
  releaseSeen,
  releaseSeenOwned,
  releaseFailedBehaviorLaunch,
  releasePrOperationOwned,
  renewSeenOwned,
  renewPrOperationOwned,
  setBehaviorLaunchErrorOwned,
  setMeta as databaseSetMeta,
  type BehaviorAgentLaunch,
  type BehaviorLaunchClaim,
} from './db'
import { HttpError } from './http'
import { behaviorErrorMessage } from './behavior-diagnostics'
import { recoverLegacyDatastore } from './legacy-datastore-recovery'
import { resolveReviewCheckout } from './review-checkout'
import { claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'
import { withProcessLock } from './process-lock'
import { getReviewAgentUsername, setReviewAgentUsername } from './gh'
import { getOrganizations, readyOrganizations, organizationArgs, type Organization } from './organizations'

const DATASTORE = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const AGENT_INTERFACE = 'agent-interface'
const LEGACY_REVIEW_SNAPSHOT_TARGET = '__snapshot_v2__'
const REVIEW_SNAPSHOT_TARGET = '__snapshot_v3__'
const BEHAVIOR_AUTH_FRESHNESS_MS = 60_000
const DATASTORE_MAX_AGE_SECONDS = 120
const SHA_PATTERN = /^[0-9a-f]{40}$/
const GITHUB_USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/

// The account is captured for an entire asynchronous operation: datastore reads,
// runtime state, process locks and callbacks must agree on the same owner.
const behaviorOrganization = new AsyncLocalStorage<Organization | null>()

function currentOrganization(): Organization | null {
  const scoped = behaviorOrganization.getStore()
  if (scoped !== undefined) return scoped
  const organizations = getOrganizations()
  return organizations.find((org) => !org.managed) ?? organizations[0] ?? null
}

export function withBehaviorOrganization<T>(orgLogin: string | undefined, operation: () => T): T {
  const org = orgLogin === undefined
    ? currentOrganization()
    : getOrganizations().find((candidate) => candidate.login.toLowerCase() === orgLogin.toLowerCase())
  if (orgLogin !== undefined && !org) throw new HttpError(404, 'GitHub account is not configured')
  return behaviorOrganization.run(org ?? null, operation)
}

function organizationOwns(repoOrTarget: string): boolean {
  const org = currentOrganization()
  return !org || repoOrTarget.split('/')[0].toLowerCase() === org.login.toLowerCase()
}

function isGlobalPreference(key: string): boolean {
  return /^behavior_(?:review_new_prs|approve_prs|resolve_unblocking|review_new_issues)_(?:enabled|setting|reviewers|scratchpad)$/.test(key)
    || /^behavior_review_new_issues_(?:repos|authors|slot_since)$/.test(key)
}

function scopedMetaKey(key: string): string {
  const org = currentOrganization()
  return org?.managed && key.startsWith('behavior_') && !isGlobalPreference(key)
    ? `org:${org.login.toLowerCase()}:${key}` : key
}

function globalPreference(key: string): string | null {
  const existing = databaseGetMeta(key)
  if (existing !== null) return existing
  const organizations = getOrganizations()
  // Legacy preferences, including unset defaults, remain authoritative. A
  // managed-only installation adopts its old preferences once, independently
  // of which account happens to make the first settings request.
  if (organizations.some((org) => !org.managed)) return null
  const values = organizations.map((org) => databaseGetMeta(`org:${org.login.toLowerCase()}:${key}`))
    .filter((value): value is string => value !== null)
  if (values.length === 0) return null
  let value = values[0]
  if (key === 'behavior_review_new_issues_repos') {
    const repositories = new Map<string, IssueRepository>()
    for (const raw of values) {
      try {
        const entries = JSON.parse(raw)
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (!entry || !isValidRepository(entry.repo) || typeof entry.since !== 'string' || !Number.isFinite(Date.parse(entry.since))) continue
          const previous = repositories.get(entry.repo.toLowerCase())
          if (!previous || Date.parse(entry.since) < Date.parse(previous.since)) repositories.set(entry.repo.toLowerCase(), entry)
        }
      } catch { /* Ignore corrupt account preferences. */ }
    }
    value = JSON.stringify([...repositories.values()].sort((a, b) => a.repo.localeCompare(b.repo)))
  }
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(key, value)
  return databaseGetMeta(key)
}

function getMeta(key: string): string | null {
  return isGlobalPreference(key) ? globalPreference(key) : databaseGetMeta(scopedMetaKey(key))
}

function setMeta(key: string, value: string): void {
  databaseSetMeta(scopedMetaKey(key), value)
}

function operationKey(key: BehaviorKey): string {
  return `${currentOrganization()?.login.toLowerCase() ?? 'legacy'}:${key}`
}

function snapshotTarget(): string {
  const org = currentOrganization()
  return org?.managed ? `${REVIEW_SNAPSHOT_TARGET}:org:${org.login.toLowerCase()}` : REVIEW_SNAPSHOT_TARGET
}

function datastoreArgs(args: string[]): string[] {
  const org = currentOrganization()
  return org ? organizationArgs(org, args) : args
}

function listBehaviorLaunchClaims(key: string): BehaviorLaunchClaim[] {
  return databaseListBehaviorLaunchClaims(key).filter((claim) => organizationOwns(claim.launchRepo ?? claim.target))
}

function listBehaviorDeadLetters(limit = 50) {
  return databaseListBehaviorDeadLetters(limit, currentOrganization()?.login)
}

function listBehaviorIncidents(limit = 50) {
  return databaseListBehaviorIncidents(limit, currentOrganization()?.login)
}

// Same cwd hack agent.ts uses — agent-interface infers the repo from
// cwd's last two path parts when no git remote is found.
const GH_INTERFACE_CWD_ROOT = join(tmpdir(), 'poise-gh-interface')
function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

function behaviorProcessLockPath(behavior: BehaviorKey): string {
  const configuredDb = process.env.POISE_DB
  const directory = configuredDb && configuredDb !== ':memory:'
    ? dirname(resolve(configuredDb))
    : join(homedir(), '.poise')
  const org = currentOrganization()
  const prefix = org?.managed ? `${org.login.toLowerCase()}-` : ''
  return join(directory, `.poise-${prefix}${behavior}-runtime-lock.sqlite3`)
}

const BEHAVIOR_LOCK_BUSY_MESSAGE = 'behavior operation is already running in another process'

class BehaviorProcessLockContentionError extends HttpError {
  readonly code = 'BEHAVIOR_PROCESS_LOCK_BUSY'

  constructor() {
    super(503, BEHAVIOR_LOCK_BUSY_MESSAGE)
    this.name = 'BehaviorProcessLockContentionError'
  }
}

async function withBehaviorProcessLock<T>(
  behavior: BehaviorKey,
  operation: () => Promise<T>,
): Promise<T> {
  return await withProcessLock({
    path: behaviorProcessLockPath(behavior),
    timeoutMessage: BEHAVIOR_LOCK_BUSY_MESSAGE,
    errorFactory: (message) => message === BEHAVIOR_LOCK_BUSY_MESSAGE
      ? new BehaviorProcessLockContentionError()
      : new HttpError(503, message),
  }, operation)
}

export type BehaviorKey = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking' | 'review-new-issues'
export const BEHAVIOR_KEYS: BehaviorKey[] = ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'review-new-issues']

let behaviorAbortController: AbortController | null = null
const behaviorOperationSignal = new AsyncLocalStorage<AbortSignal>()

function behaviorSignal(): AbortSignal | undefined {
  return behaviorOperationSignal.getStore() ?? behaviorAbortController?.signal
}

function behaviorAborted(): boolean {
  return behaviorSignal()?.aborted === true
}

async function waitForBehavior<T>(operation: T | PromiseLike<T>): Promise<T> {
  const pending = Promise.resolve(operation)
  const signal = behaviorSignal()
  if (!signal) return pending
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = () => rejectOperation(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolveOperation(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectOperation(error)
      },
    )
  })
}

// ── Persistence ─────────────────────────────────────────────────────────
// Enabled flags and dedupe claims survive server restarts via cache.db.
// The completed snapshot marker survives restarts so work opened during
// downtime remains eligible. Only a new/cleared ledger takes an anti-flood
// snapshot.

const META_PREFIX = 'behavior_'

function enabledKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_enabled' }
function settingKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_setting' }

export function isEnabled(key: BehaviorKey): boolean {
  const org = behaviorOrganization.getStore()
  if (org && !readyOrganizations().some((candidate) => candidate.login.toLowerCase() === org.login.toLowerCase()
    && candidate.datastorePath === org.datastorePath)) return false
  return getMeta(enabledKey(key)) === '1'
}

function setPersistedEnabled(key: BehaviorKey, enabled: boolean) {
  setMeta(enabledKey(key), enabled ? '1' : '0')
}

export const BEHAVIOR_RETRY_BASE_MS = 60_000
export const BEHAVIOR_RETRY_MAX_MS = 60 * 60_000

type BehaviorFailureKind = 'operation' | 'worker'

interface PersistedBehaviorFailure {
  kind: BehaviorFailureKind
  consecutiveFailures: number
  lastFailureAtMs: number
  nextRetryAtMs: number
  // What failed last, so the view can say why rather than only how often.
  error?: string
}

function failureKey(key: BehaviorKey, target?: string): string {
  return `${META_PREFIX}${key.replace(/-/g, '_')}_failure${target ? `:${target}` : ''}`
}

function readBehaviorFailure(key: BehaviorKey, target?: string): PersistedBehaviorFailure | null {
  const raw = getMeta(failureKey(key, target))
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PersistedBehaviorFailure>
    if ((value.kind !== 'operation' && value.kind !== 'worker')
      || !Number.isSafeInteger(value.consecutiveFailures)
      || Number(value.consecutiveFailures) < 1
      || !Number.isFinite(value.lastFailureAtMs)
      || Number(value.lastFailureAtMs) < 0
      || Number(value.lastFailureAtMs) > 8.64e15
      || !Number.isFinite(value.nextRetryAtMs)
      || Number(value.nextRetryAtMs) < 0
      || Number(value.nextRetryAtMs) > 8.64e15) return null
    return {
      kind: value.kind,
      consecutiveFailures: Math.min(Number(value.consecutiveFailures), 31),
      lastFailureAtMs: Number(value.lastFailureAtMs),
      nextRetryAtMs: Number(value.nextRetryAtMs),
      ...(typeof value.error === 'string' && value.error ? { error: value.error.slice(0, 300) } : {}),
    }
  } catch {
    return null
  }
}

function recordBehaviorFailure(key: BehaviorKey, kind: 'worker', cause: unknown, target: string): void
function recordBehaviorFailure(key: BehaviorKey, kind: 'operation', cause?: unknown, target?: string): void
function recordBehaviorFailure(key: BehaviorKey, kind: BehaviorFailureKind, cause?: unknown, target?: string): void {
  if (!isEnabled(key)) return
  const previous = readBehaviorFailure(key, target)
  const consecutiveFailures = Math.min((previous?.consecutiveFailures ?? 0) + 1, 31)
  const delayMs = Math.min(
    BEHAVIOR_RETRY_BASE_MS * (2 ** Math.min(consecutiveFailures - 1, 20)),
    BEHAVIOR_RETRY_MAX_MS,
  )
  const now = Date.now()
  const error = cause === undefined ? undefined : behaviorErrorMessage(cause)
  setMeta(failureKey(key, target), JSON.stringify({
    kind,
    consecutiveFailures,
    lastFailureAtMs: now,
    nextRetryAtMs: now + delayMs,
    ...(error ? { error } : {}),
  } satisfies PersistedBehaviorFailure))
}

function clearBehaviorFailure(key: BehaviorKey, target?: string): void {
  setMeta(failureKey(key, target), '')
}

// Retry delays belong to one PR/issue and reviewer. Legacy behavior-wide
// summaries are retired on the next cycle; they never block reconciliation.
function behaviorRetryDue(key: BehaviorKey, target: string): boolean {
  const failure = readBehaviorFailure(key, target)
  return failure === null || Date.now() >= failure.nextRetryAtMs
}

function behaviorFailureTargets(key: BehaviorKey): string[] {
  const prefix = `${scopedMetaKey(failureKey(key))}:`
  const rows = db.prepare(
    "SELECT key FROM meta WHERE substr(key, 1, ?) = ? AND value <> ''",
  ).all(prefix.length, prefix) as Array<{ key: string }>
  return rows.map((row) => row.key.slice(prefix.length))
}

function retireClosedTargetFailures(open: ReadonlySet<string>, behaviors: readonly BehaviorKey[], unreadRepositories?: ReadonlySet<string>): void {
  for (const behavior of behaviors) {
    for (const target of behaviorFailureTargets(behavior)) {
      const ref = target.match(/^[^#]+#\d+/)?.[0]
      if (ref && !unreadRepositories?.has(ref.split('#')[0]) && !open.has(ref)) {
        clearBehaviorFailure(behavior, target)
      }
    }
  }
}

// Per-behavior setting (the priority ceiling for review-new-prs:
// "p0" / "p1" / "p2" / "p3" / "p4"). Default "p2" so a freshly-enabled
// behavior catches p0..p2 unless the user narrows or widens it.
export type BehaviorSetting = 'p0' | 'p1' | 'p2' | 'p3' | 'p4'
const VALID_SETTINGS: BehaviorSetting[] = ['p0', 'p1', 'p2', 'p3', 'p4']
const DEFAULT_SETTING: BehaviorSetting = 'p2'

export function getSetting(key: BehaviorKey): BehaviorSetting {
  const v = getMeta(settingKey(key))
  return (VALID_SETTINGS as string[]).includes(v || '')
    ? (v as BehaviorSetting)
    : DEFAULT_SETTING
}

function setPersistedSetting(key: BehaviorKey, setting: BehaviorSetting) {
  setMeta(settingKey(key), setting)
}

export function isValidSetting(v: unknown): v is BehaviorSetting {
  return typeof v === 'string' && (VALID_SETTINGS as string[]).includes(v)
}

// How many of a review place's reviewers (default, secondary, tertiary)
// review each new pull request or issue — at the same time, each as its own
// launch. One by default; a wider panel is a deliberate choice in Behaviors.
export type ReviewerCount = 1 | 2 | 3
const DEFAULT_REVIEWERS: ReviewerCount = 1
export type PanelBehavior = 'review-new-prs' | 'review-new-issues'
export const PANEL_BEHAVIORS: readonly PanelBehavior[] = ['review-new-prs', 'review-new-issues']

function reviewersKey(key: PanelBehavior): string {
  return `${META_PREFIX}${key.replace(/-/g, '_')}_reviewers`
}

export function isPanelBehavior(key: string): key is PanelBehavior {
  return (PANEL_BEHAVIORS as readonly string[]).includes(key)
}

export function getReviewers(key: PanelBehavior = 'review-new-prs'): ReviewerCount {
  const value = Number(getMeta(reviewersKey(key)) || '')
  return value === 2 || value === 3 ? value : DEFAULT_REVIEWERS
}

export function isValidReviewers(v: unknown): v is ReviewerCount {
  return v === 1 || v === 2 || v === 3
}

export function setReviewers(count: ReviewerCount, key: PanelBehavior = 'review-new-prs'): void {
  if (key === 'review-new-issues') setIssueSlotSince(getReviewers(key), count)
  setMeta(reviewersKey(key), String(count))
}

// The primary reviewer keeps the pull request's own claim key, so ledgers
// written before panels stay valid; the others claim a suffixed key each.
export function reviewSlotTarget(key: string, slot: ReviewerSlot): string {
  return slot === 'primary' ? key : `${key}:${slot}`
}

function reviewSlotOfTarget(target: string): ReviewerSlot {
  for (const slot of ['secondary', 'tertiary'] as const) {
    if (target.endsWith(`:${slot}`)) return slot
  }
  return 'primary'
}

// ── Per-behavior memory (scratchpad) ────────────────────────────────────
// Free-text the user types in the Behaviors view that gets appended to
// the agent's prompt on every fire of that behavior — a durable,
// behavior-scoped instruction ("always check the changelog", "this repo
// uses pnpm", …). Stored in the meta table under
// behavior_<key>_scratchpad and delivered via agent-interface's `--note`
// flag (see fireReview / fireApprove). Only the agent-backed behaviors
// (review-new-prs, approve-prs) have a prompt to inject into;
// resolve-unblocking calls github-interface directly with no agent, so
// it has no scratchpad.

function scratchpadKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_scratchpad' }

// Upper bound so a runaway note can't bloat the prompt or blow past the
// OS argv limit when passed as --note. Generous for instructions;
// trimmed silently rather than rejected so the UI stays forgiving.
const MAX_SCRATCHPAD = 8000

export function getScratchpad(key: BehaviorKey): string {
  return getMeta(scratchpadKey(key)) || ''
}

export function setScratchpad(key: BehaviorKey, text: string): void {
  setMeta(scratchpadKey(key), String(text ?? '').slice(0, MAX_SCRATCHPAD))
}

// Build the `--note <text>` argv fragment for a spawn, or [] when the
// behavior has no memory set. The installed agent-interface advertises
// `--note TEXT` for both --pr-review and --pr-approve and carries it into
// the behavior prompt.
function noteArgs(key: BehaviorKey): string[] {
  const note = getScratchpad(key).trim()
  // Caller reads a flag value that starts with "--" as the next flag, so a
  // note opening with a Markdown rule stopped every launch before it ran.
  return note ? ['--note', note.startsWith('-') ? ` ${note}` : note] : []
}

// Last-fired info is intentionally NOT persisted here — agent-interface
// already records every pr_review / pr_approve run in its calls log,
// and that's the single source of truth. The /api/behaviors GET
// derives `lastTriggered` from `agent-interface --logs` directly. See
// the comment in cache-plugin.ts where the derivation happens.

// ── Dedupe ledger ──────────────────────────────────────────────────────
// Lives in SQLite (db.behavior_seen) instead of process memory so the
// claim is atomic across whatever runs the runtime: multiple vite dev
// servers, accidental tick re-entry inside one process, or even a
// datastore query that hands the same PR back twice. INSERT OR IGNORE
// on a (key,target) primary key makes "claim if new" a single atomic
// statement — exactly one caller wins, the rest skip.

interface ActiveClaim {
  behavior: 'review-new-prs' | 'approve-prs' | 'review-new-issues'
  target: string
  launched: boolean
}

const activeClaims = new Map<string, ActiveClaim>()

function trackClaim(
  behavior: ActiveClaim['behavior'],
  target: string,
  claimId: string,
): void {
  activeClaims.set(claimId, { behavior, target, launched: false })
}

function markClaimLaunched(claimId: string): void {
  const claim = activeClaims.get(claimId)
  if (claim) claim.launched = true
}

function releaseOwnedClaim(behavior: ActiveClaim['behavior'], target: string, claimId: string): boolean {
  activeClaims.delete(claimId)
  return releaseSeenOwned(behavior, target, claimId)
}

function completeOwnedClaim(behavior: ActiveClaim['behavior'], target: string, claimId: string): boolean {
  activeClaims.delete(claimId)
  return completeSeenOwned(behavior, target, claimId)
}

export const BEHAVIOR_REGISTRATION_GRACE_MS = 5 * 60_000
const BEHAVIOR_CLAIM_RENEWAL_MS = 2 * 60 * 60_000
const PR_OPERATION_EVALUATION_LEASE_MS = 65_000
const PR_OPERATION_WAIT_MS = 10_000
const PR_OPERATION_RETRY_MS = 50
const RUNNING_AGENT_STATUSES = new Set(['pending', 'queued', 'running', 'in_progress'])
const FAILED_AGENT_STATUSES = new Set([
  'failed',
  'error',
  'cancelled',
  'canceled',
  'timed_out',
  'timeout',
])
const SUPERSEDED_AGENT_ERROR = 'pull-request head changed during behavior execution'

function upstreamBehavior(behavior: ActiveClaim['behavior']): BehaviorAgentLaunch {
  return behavior === 'review-new-prs' ? 'pr_review' : behavior === 'review-new-issues' ? 'issue_review' : 'pr_approve'
}

async function claimEligiblePrOperation(behavior: ActiveClaim['behavior'], target: string): Promise<string | null> {
  const deadline = Date.now() + PR_OPERATION_WAIT_MS
  while (!behaviorAborted() && isEnabled(behavior)) {
    const operationId = claimPrOperationOwned(target, PR_OPERATION_EVALUATION_LEASE_MS)
    if (operationId) return operationId
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await waitForBehavior(new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(PR_OPERATION_RETRY_MS, remaining))
    }))
  }
  return null
}

function hasActiveAgentLaunchForPr(repo: string, pr: number): boolean {
  return (['review-new-prs', 'approve-prs'] as const).some((behavior) =>
    listBehaviorLaunchClaims(behavior).some((claim) =>
      claim.launchRepo === repo && claim.launchPr === pr))
}

function markLaunchIntent(
  behavior: ActiveClaim['behavior'],
  pr: DatastorePr,
  target: string,
  claimId: string,
  expectedHead: string,
  actor: string,
): boolean {
  const source = `poise:${behavior}`
  return markBehaviorLaunchIntentOwned({
    key: behavior,
    target,
    claimId,
    launchBehavior: upstreamBehavior(behavior),
    repo: pr.repo,
    pr: pr.number,
    requestedAt: new Date().toISOString(),
    expectedHead,
    actor,
    source,
    correlationId: claimId,
  })
}

function retainClaimSafely(claim: BehaviorLaunchClaim, error: string): void {
  if (!claim.launchQuarantine) setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, error)
  renewSeenOwned(
    claim.key,
    claim.target,
    claim.claimId,
    BEHAVIOR_CLAIM_RENEWAL_MS,
  )
  renewPrOperationOwned(claim.claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
}

function completeClaimSafely(claim: BehaviorLaunchClaim, error: string | null = null): boolean {
  setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, error)
  const completed = completeSeenOwned(claim.key, claim.target, claim.claimId)
  if (completed) activeClaims.delete(claim.claimId)
  return completed
}

function deadLetterClaim(claim: BehaviorLaunchClaim, error: string): boolean {
  recordBehaviorDeadLetter(claim, error)
  return completeClaimSafely(claim, error)
}

function recordQuarantineIncident(claim: BehaviorLaunchClaim, error: string, callId: string | null): void {
  if (claim.launchQuarantine === 'invalid_result') return
  const updated = db.prepare(`
    UPDATE behavior_dead_letters SET error = ?, call_id = COALESCE(call_id, ?)
    WHERE behavior = ? AND target = ? AND correlation_id = ? AND retired_at IS NULL
  `).run(error, callId, claim.key, claim.target, claim.launchCorrelationId)
  if (!updated.changes) recordBehaviorDeadLetter(claim, error, callId)
}

function retireQuarantineIncident(claim: BehaviorLaunchClaim): void {
  db.prepare(`
    UPDATE behavior_dead_letters SET retired_at = ?
    WHERE behavior = ? AND target = ? AND correlation_id = ? AND retired_at IS NULL
  `).run(new Date().toISOString(), claim.key, claim.target, claim.launchCorrelationId)
}

function terminalAgentStatus(status?: string | null): boolean {
  const value = status?.toLowerCase() || ''
  return ['completed', 'superseded', 'invalid'].includes(value) || FAILED_AGENT_STATUSES.has(value)
}

// Unreadable evidence cannot later become proof that nothing ran. A result
// attributable to this launch is held for a person once it contradicts the
// launch contract; rewriting or rotating Caller logs cannot clear that fact.
function quarantineClaim(
  claim: BehaviorLaunchClaim,
  kind: NonNullable<BehaviorLaunchClaim['launchQuarantine']>,
  error: string,
  callId: string | null = claim.launchCallId,
  mayRun = true,
): void {
  db.transaction(() => {
    if (!quarantineBehaviorLaunchOwned(claim.key, claim.target, claim.claimId, kind, error, mayRun)) return
    if (kind === 'invalid_result' && !claim.launchCallId && callId) {
      linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, callId)
    }
    recordQuarantineIncident(claim, error, callId)
    clearBehaviorFailure(claim.key as BehaviorKey, claim.target)
  })()
  retainClaimSafely({ ...claim, launchQuarantine: kind }, error)
}

function quarantineBlocksLogCorrection(behavior: string, target: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM behavior_seen
    WHERE key = ? AND target = ? AND (launch_quarantine = 'invalid_result'
      OR (launch_quarantine = 'unreadable' AND claim_id <> ''))
  `).get(behavior, target)
}

// Approval keys change with commits and author responses. A durable hold
// belongs to the PR, even if an earlier runtime closed its owned claim.
function invalidPrResultHeld(repo: string, pr: number): boolean {
  return !!db.prepare(`
    SELECT 1 FROM behavior_seen
    WHERE key IN ('review-new-prs', 'approve-prs') AND (
      (launch_repo = ? AND launch_pr = ? AND launch_quarantine = 'invalid_result')
      OR (target = ? AND launch_requested_at IS NULL AND launch_quarantine IS NOT NULL)
    )
    LIMIT 1
  `).get(repo, pr, `${repo}#${pr}`)
}

// Invalid terminal results keep ownership and coverage without using a
// worker slot. Unreadable evidence can still hide a running worker.
function runningIssueReviewCount(): number {
  return listBehaviorLaunchClaims(ISSUES_KEY).filter((claim) => !claim.launchQuarantine || claim.launchQuarantineMayRun).length
    + failedBehaviorLaunches(ISSUES_KEY).filter((claim) => claim.launchQuarantine && claim.launchQuarantineMayRun).length
}

type AgentLogSnapshot = Awaited<ReturnType<typeof fetchAgentLogSnapshot>>

class BehaviorLogFeedError extends Error {}

async function readBehaviorLogSnapshot(): Promise<AgentLogSnapshot> {
  try {
    return await fetchAgentLogSnapshot({ signal: behaviorSignal() })
  } catch (cause) {
    throw new BehaviorLogFeedError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
type AgentLogIdentity = Parameters<typeof quarantinedLogMayMatch>[1]

// A malformed duplicate makes even a valid row with that identity uncertain.
// An unidentifiable row prevents absence proofs, but does not invalidate a
// separately validated, authoritative result.
function logQuarantine(snapshot: AgentLogSnapshot, identity: AgentLogIdentity, authoritative = false) {
  return snapshot.quarantined.find((row) =>
    (identity.id && row.id === identity.id)
    || (identity.correlationId && row.correlationId === identity.correlationId)
    || (!authoritative && quarantinedLogMayMatch(row, identity)))
}

// Contradictory duplicates can connect multiple call IDs through one
// correlation. A terminal result never proves those other workers stopped.
function quarantineEvidence(snapshot: AgentLogSnapshot, claim: BehaviorLaunchClaim, observed?: LogEntry) {
  const rows = [
    ...snapshot.entries.map((row) => ({ id: row.id, correlationId: row.correlation_id, status: row.status, error: null as string | null })),
    ...snapshot.quarantined,
  ]
  const ids = new Set([claim.launchCallId, observed?.id].filter((id): id is string => !!id))
  const correlations = new Set([claim.launchCorrelationId])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!(row.id && ids.has(row.id)) && !(row.correlationId && correlations.has(row.correlationId))) continue
      if (row.id && !ids.has(row.id)) { ids.add(row.id); changed = true }
      if (row.correlationId && !correlations.has(row.correlationId)) { correlations.add(row.correlationId); changed = true }
    }
  }
  const matching = rows.filter((row) => (row.id && ids.has(row.id)) || (row.correlationId && correlations.has(row.correlationId)))
  return {
    terminal: matching.find((row) => row.error !== null && terminalAgentStatus(row.status)),
    mayRun: matching.length === 0 || matching.some((row) => !terminalAgentStatus(row.status)),
    hasLiveEvidence: matching.some((row) => !terminalAgentStatus(row.status)),
  }
}

function claimLogIdentity(claim: BehaviorLaunchClaim): AgentLogIdentity {
  return { id: claim.launchCallId, correlationId: claim.launchCorrelationId,
    repo: claim.launchRepo, prId: String(claim.launchPr), behavior: claim.launchBehavior }
}

// A closed failed claim has no owner token. Its call, correlation, and
// launch watermark jointly prevent a late read from changing a newer launch.
function quarantineFailedClaim(
  claim: BehaviorLaunchClaim,
  kind: NonNullable<BehaviorLaunchClaim['launchQuarantine']>,
  error: string,
  mayRun = false,
): void {
  db.transaction(() => {
    const changed = db.prepare(`
      UPDATE behavior_seen
      SET launch_quarantine_may_run = CASE WHEN launch_quarantine IS NULL THEN ? ELSE MAX(launch_quarantine_may_run, ?) END,
          launch_quarantine = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_quarantine ELSE ? END,
          launch_error = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_error ELSE ? END
      WHERE key = ? AND target = ? AND claim_id = '' AND launch_outcome IS NULL
        AND launch_call_id = ? AND launch_correlation_id = ? AND launch_requested_at = ?
    `).run(Number(mayRun), Number(mayRun), kind, error, claim.key, claim.target, claim.launchCallId, claim.launchCorrelationId, claim.launchRequestedAt)
    if (changed.changes) {
      recordQuarantineIncident(claim, error, claim.launchCallId)
      clearBehaviorFailure(claim.key as BehaviorKey, claim.target)
    }
  })()
}

function quarantineFailedLog(snapshot: AgentLogSnapshot, claim: BehaviorLaunchClaim, observed?: LogEntry): boolean {
  const quarantine = logQuarantine(snapshot, claimLogIdentity(claim), observed !== undefined)
  if (!quarantine) return false
  const attributable = quarantine.correlationId === claim.launchCorrelationId
    || (!!quarantine.id && quarantine.id === claim.launchCallId)
  quarantineFailedClaim(claim, attributable ? 'invalid_result' : 'unreadable',
    `agent log row quarantined: ${quarantine.error}`, quarantineEvidence(snapshot, claim, observed).hasLiveEvidence)
  return true
}

// Exact readable evidence restores normal reconciliation; absence and
// conflicting identities do not. The linked call remains in the launch ledger.
function unambiguousAgentCall(snapshot: AgentLogSnapshot, call: LogEntry): boolean {
  return !logQuarantine(snapshot, { id: call.id, correlationId: call.correlation_id }, true)
    && snapshot.entries.filter((row) => row.id === call.id || row.correlation_id === call.correlation_id).length === 1
}

function restoreReadableClaim(claim: BehaviorLaunchClaim, call: LogEntry, snapshot: AgentLogSnapshot): boolean {
  if (!unambiguousAgentCall(snapshot, call)) return false
  return db.transaction(() => {
    if (!clearUnreadableBehaviorLaunchOwned(claim.key, claim.target, claim.claimId, call.id)) return false
    retireQuarantineIncident(claim)
    return true
  })()
}

// A previously failed launch may also encounter a transient feed outage.
// Restore only its exact terminal failure, leaving ordinary no-action policy
// to decide whether it can retry. Running rows cannot revive closed ownership.
function restoreReadableFailedClaim(claim: BehaviorLaunchClaim, call: LogEntry | undefined, snapshot: AgentLogSnapshot): void {
  if (claim.launchQuarantine !== 'unreadable' || !call
    || !FAILED_AGENT_STATUSES.has(call.status.toLowerCase())
    || call.error_code === 'invalid_agent_result'
    || !unambiguousAgentCall(snapshot, call)
    || call.id !== claim.launchCallId
    || call.behavior !== claim.launchBehavior
    || call.repo !== claim.launchRepo
    || String(call.pr_id || '') !== String(claim.launchPr)
    || String(call.actor || '').toLowerCase() !== claim.launchActor.toLowerCase()
    || call.source !== claim.launchSource
    || call.correlation_id !== claim.launchCorrelationId
    || (call.expected_head || '') !== claim.launchExpectedHead
    || !Number.isFinite(Date.parse(claim.launchRequestedAt))
    || !Number.isFinite(Date.parse(agentCallStartedAt(call)))
    || Date.parse(agentCallStartedAt(call)) < Date.parse(claim.launchRequestedAt)) return
  const message = call.error || `agent call terminated with status ${call.status.toLowerCase()}`
  db.transaction(() => {
    const changed = db.prepare(`
      UPDATE behavior_seen SET launch_quarantine = NULL, launch_error = ?, launch_quarantine_may_run = 1
      WHERE key = ? AND target = ? AND claim_id = '' AND launch_quarantine = 'unreadable'
        AND launch_call_id = ? AND launch_correlation_id = ? AND launch_requested_at = ?
        AND launch_outcome IS NULL
    `).run(message, claim.key, claim.target, claim.launchCallId, claim.launchCorrelationId, claim.launchRequestedAt)
    if (!changed.changes) return
    retireQuarantineIncident(claim)
    recordBehaviorDeadLetter(claim, message, call.id)
    const retryFailure = claim.key === ISSUES_KEY
      ? call.error_code !== 'stopped' && (call.receipts != null || !HELD_ISSUE_REVIEW_ERRORS.has(call.error_code || ''))
      : !boundedReviewFailure(call) && call.error_code !== 'review_packet_too_large'
    if (retryFailure) recordBehaviorFailure(claim.key as BehaviorKey, 'worker', message, claim.target)
  })()
}

function clearCompletedUnreadableHold(claim: BehaviorLaunchClaim, call: LogEntry, snapshot: AgentLogSnapshot): boolean {
  if (claim.launchQuarantine === 'invalid_result') return false
  const actions = claim.launchBehavior === 'issue_review'
    ? new Map([['commented', 'commented']])
    : claim.launchBehavior === 'pr_review'
      ? new Map([['reviewed_clean', 'clean'], ['requested_changes', 'changes_requested']])
      : new Map([['approved', 'approved'], ['requested_changes', 'changes_requested']])
  if (!unambiguousAgentCall(snapshot, call)
    || call.id !== claim.launchCallId
    || call.behavior !== claim.launchBehavior
    || call.repo !== claim.launchRepo
    || String(call.pr_id || '') !== String(claim.launchPr)
    || String(call.actor || '').toLowerCase() !== claim.launchActor.toLowerCase()
    || call.source !== claim.launchSource
    || call.correlation_id !== claim.launchCorrelationId
    || (call.expected_head || '') !== claim.launchExpectedHead
    || !Number.isFinite(Date.parse(claim.launchRequestedAt))
    || !Number.isFinite(Date.parse(agentCallStartedAt(call)))
    || Date.parse(agentCallStartedAt(call)) < Date.parse(claim.launchRequestedAt)
    || call.status.toLowerCase() !== 'completed'
    || actions.get(call.action || '') !== call.outcome
    || !Number.isFinite(Date.parse(call.completed_at || ''))
    || (claim.launchBehavior !== 'issue_review' && call.head_sha !== claim.launchExpectedHead)) {
    quarantineFailedClaim(claim, 'invalid_result',
      'completed agent evidence is ambiguous or contradicts the persisted launch contract',
      quarantineEvidence(snapshot, claim, call).hasLiveEvidence)
    return false
  }
  db.prepare(`
    UPDATE behavior_seen SET launch_quarantine = NULL
    WHERE key = ? AND target = ? AND claim_id = '' AND launch_quarantine = 'unreadable'
      AND launch_call_id = ? AND launch_correlation_id = ? AND launch_requested_at = ?
  `).run(claim.key, claim.target, claim.launchCallId, claim.launchCorrelationId, claim.launchRequestedAt)
  return true
}

function failedBehaviorLaunches(behavior: string): BehaviorLaunchClaim[] {
  const rows = db.prepare(`
    SELECT target FROM behavior_seen AS launch
    WHERE key = ? AND claim_id = '' AND launch_call_id IS NOT NULL
      AND launch_requested_at IS NOT NULL AND launch_error IS NOT NULL AND launch_outcome IS NULL
      AND (launch_quarantine IS NOT NULL OR EXISTS (
        SELECT 1 FROM behavior_dead_letters AS incident
        WHERE incident.behavior = launch.key AND incident.target = launch.target
          AND incident.correlation_id = launch.launch_correlation_id AND incident.retired_at IS NULL
          AND (incident.call_id IS NULL OR incident.call_id = launch.launch_call_id)
      ))
  `).all(behavior) as Array<{ target: string }>
  return rows.map(({ target }) => getFailedBehaviorLaunch(behavior, target))
    .filter((claim): claim is BehaviorLaunchClaim => claim !== null && organizationOwns(claim.launchRepo))
}

function quarantinedIssueReviews(): BehaviorLaunchClaim[] {
  const active = listBehaviorLaunchClaims(ISSUES_KEY).filter((claim) => claim.launchQuarantine)
  return [...active, ...failedBehaviorLaunches(ISSUES_KEY).filter((claim) => claim.launchQuarantine)]
}

function agentCallStartedAt(call: LogEntry): string {
  return String(call.started_at_precise || call.started_at || '')
}

async function reconcileBehaviorLaunchClaims(
  behavior: 'review-new-prs' | 'approve-prs',
): Promise<void> {
  const claims = listBehaviorLaunchClaims(behavior).filter((claim) => {
    if (claim.launchQuarantine !== 'invalid_result') return true
    retainClaimSafely(claim, claim.launchError || 'invalid agent result remains held')
    return false
  })
  const deadLetters = listBehaviorDeadLetters(500).filter(
    (letter) => letter.behavior === behavior && letter.callId !== null
      && !quarantineBlocksLogCorrection(letter.behavior, letter.target),
  )
  const failedClaims = failedBehaviorLaunches(behavior).filter((claim) => claim.launchQuarantine !== 'invalid_result')
  if (claims.length === 0 && deadLetters.length === 0 && failedClaims.length === 0) return

  let snapshot: AgentLogSnapshot
  try {
    snapshot = await readBehaviorLogSnapshot()
  } catch (error) {
    const message = `agent log reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`
    for (const claim of claims) quarantineClaim(claim, 'unreadable', message)
    for (const failed of failedClaims) quarantineFailedClaim(failed, 'unreadable', message)
    throw error
  }
  const logs = snapshot.entries
  for (const failed of failedClaims) {
    const call = logs.find((row) => row.id === failed.launchCallId)
    if (!quarantineFailedLog(snapshot, failed, call)) restoreReadableFailedClaim(failed, call, snapshot)
  }
  // Which sign-in a failed call counts against is decided by its model's
  // provider; a log row can name a model the catalog has since retired.
  const catalogForCalls: Catalog | null = await loadCatalog().catch(() => null)

  let recoveredDeadLetter = false
  const expectedActions = behavior === 'review-new-prs'
    ? new Map([['reviewed_clean', 'clean'], ['requested_changes', 'changes_requested']])
    : new Map([['approved', 'approved'], ['requested_changes', 'changes_requested']])
  for (const letter of deadLetters) {
    const call = logs.find((row) => row.status.toLowerCase() === 'completed'
      && (row.id.toLowerCase() === letter.callId || (!!letter.correlationId && row.correlation_id === letter.correlationId)))
      ?? logs.find((row) => row.id.toLowerCase() === letter.callId)
    const failed = getFailedBehaviorLaunch(letter.behavior, letter.target)
    if (failed?.launchCallId === letter.callId && failed.launchCorrelationId === letter.correlationId
      && quarantineFailedLog(snapshot, failed, call)) continue
    if (call?.status.toLowerCase() === 'completed' && failed?.launchCallId === letter.callId
      && failed.launchCorrelationId === letter.correlationId
      && !clearCompletedUnreadableHold(failed, call, snapshot)) continue
    const completedAt = String(call?.completed_at || '')
    const action = String(call?.action || '')
    const outcome = String(call?.outcome || '')
    if (call?.status.toLowerCase() === 'completed'
      && !logQuarantine(snapshot, { id: call.id, correlationId: call.correlation_id }, true)
      && call.behavior === upstreamBehavior(behavior)
      && call.repo === letter.repo
      && String(call.pr_id || '') === String(letter.pr)
      && String(call.actor || '').toLowerCase() === String(letter.actor || '').toLowerCase()
      && call.source === letter.source
      && call.correlation_id === letter.correlationId
      && expectedActions.get(action) === outcome
      && SHA_PATTERN.test(String(call.head_sha || '').toLowerCase())
      && Number.isFinite(Date.parse(completedAt))) {
      if (retireBehaviorDeadLetter(letter.id)) {
        clearBehaviorFailure(behavior, letter.target)
        recoveredDeadLetter = true
      }
    }
  }
  if (recoveredDeadLetter
    && !listBehaviorDeadLetters(500).some((letter) => letter.behavior === behavior)) {
    clearBehaviorFailure(behavior)
  }

  for (const claim of claims) {
    if (claim.launchBehavior !== upstreamBehavior(behavior)
      || !claim.launchRepo
      || !Number.isSafeInteger(claim.launchPr)
      || claim.launchPr <= 0
      || !SHA_PATTERN.test(claim.launchExpectedHead)
      || !GITHUB_USERNAME_PATTERN.test(claim.launchActor)
      || claim.launchSource !== `poise:${behavior}`
      || claim.launchCorrelationId !== claim.claimId
      || (claim.launchCallId !== null && !/^[0-9a-f]{32}$/.test(claim.launchCallId))) {
      deadLetterClaim(claim, 'launch correlation metadata is invalid; retained to prevent duplicate launch')
      continue
    }
    const requestedAtMs = Date.parse(claim.launchRequestedAt)
    if (!Number.isFinite(requestedAtMs)) {
      deadLetterClaim(claim, 'launch watermark is invalid; retained to prevent duplicate launch')
      continue
    }

    const candidates = logs.filter(
      (row) => row.correlation_id === claim.launchCorrelationId,
    )
    let call = claim.launchCallId
      ? candidates.find((row) => row.id.toLowerCase() === claim.launchCallId)
      : undefined
    const observed = call ?? (candidates.length === 1 ? candidates[0] : undefined)
    const quarantine = logQuarantine(snapshot, {
      ...claimLogIdentity(claim), id: claim.launchCallId ?? observed?.id ?? null,
    }, observed !== undefined)
    const ambiguousCompletion = claim.launchQuarantine === 'unreadable'
      ? logs.find((row) => row.status.toLowerCase() === 'completed'
        && (row.correlation_id === claim.launchCorrelationId || row.id === claim.launchCallId)
        && (!unambiguousAgentCall(snapshot, row)
          || (!!claim.launchCallId && row.id !== claim.launchCallId)
          || row.correlation_id !== claim.launchCorrelationId))
      : undefined
    if (ambiguousCompletion) {
      quarantineClaim(claim, 'invalid_result',
        'completed agent evidence conflicts with another record for the same launch',
        claim.launchCallId ?? ambiguousCompletion.id, quarantineEvidence(snapshot, claim, ambiguousCompletion).mayRun)
      continue
    }
    if (quarantine) {
      const evidence = quarantineEvidence(snapshot, claim, observed)
      quarantineClaim(claim, evidence.terminal ? 'invalid_result' : 'unreadable',
        `agent log row quarantined: ${evidence.terminal?.error || quarantine.error}`,
        claim.launchCallId ?? observed?.id ?? evidence.terminal?.id ?? null, evidence.mayRun)
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && !observed) {
      retainClaimSafely(claim, claim.launchError || 'agent evidence remains unreadable')
      continue
    }

    if (!call) {
      if (claim.launchCallId) {
        const ageMs = Date.now() - requestedAtMs
        if (ageMs < BEHAVIOR_CLAIM_RENEWAL_MS) {
          retainClaimSafely(claim, 'awaiting linked agent call visibility')
        } else {
          deadLetterClaim(
            claim,
            'linked agent call remained missing for the full launch lease; retained to prevent duplicate launch',
          )
        }
        continue
      }
      if (candidates.length > 1) {
        deadLetterClaim(
          claim,
          `ambiguous correlation id matched ${candidates.length} agent calls; retained to prevent duplicate launch`,
        )
        continue
      }
      if (candidates.length === 0) {
        const ageMs = Date.now() - requestedAtMs
        if (ageMs < BEHAVIOR_REGISTRATION_GRACE_MS) {
          retainClaimSafely(claim, 'awaiting agent call registration')
        } else {
          const message = 'agent call did not register before the launch deadline'
          recordBehaviorDeadLetter(claim, message)
          if (releaseOwnedClaim(behavior, claim.target, claim.claimId)) {
            recordBehaviorFailure(behavior, 'worker', message, claim.target)
          }
        }
        continue
      }

      call = candidates[0]
      if (!linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, call.id)) {
        continue
      }
      claim.launchCallId = call.id
    }

    const linkedStartedAtMs = Date.parse(agentCallStartedAt(call))
    if (call.behavior !== claim.launchBehavior
      || call.repo !== claim.launchRepo
      || String(call.pr_id || '') !== String(claim.launchPr)
      || String(call.actor || '').toLowerCase() !== claim.launchActor.toLowerCase()
      || call.source !== claim.launchSource
      || call.correlation_id !== claim.launchCorrelationId
      || call.expected_head !== claim.launchExpectedHead
      || !Number.isFinite(linkedStartedAtMs)
      || linkedStartedAtMs < requestedAtMs) {
      quarantineClaim(claim, terminalAgentStatus(call.status) ? 'invalid_result' : 'unreadable',
        'linked agent call does not match the persisted launch contract; retained to prevent duplicate launch', call.id,
        quarantineEvidence(snapshot, claim, call).mayRun)
      continue
    }

    const status = call.status.toLowerCase()
    if (status === 'invalid' || call.error_code === 'invalid_agent_result') {
      quarantineClaim(claim, 'invalid_result', call.error || 'agent result is invalid', call.id,
        quarantineEvidence(snapshot, claim, call).mayRun)
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && !unambiguousAgentCall(snapshot, call)) {
      retainClaimSafely(claim, claim.launchError || 'agent evidence remains ambiguous')
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && status !== 'completed') {
      const recognized = RUNNING_AGENT_STATUSES.has(status) || FAILED_AGENT_STATUSES.has(status) || status === 'superseded'
      if (!recognized || !restoreReadableClaim(claim, call, snapshot)) {
        retainClaimSafely(claim, claim.launchError || 'agent evidence remains unreadable')
        continue
      }
    }
    const superseded = status === 'superseded'
      || String(call.outcome || '') === 'superseded'
      || call.error === SUPERSEDED_AGENT_ERROR
    if (superseded) {
      if (releaseOwnedClaim(behavior, claim.target, claim.claimId)) {
        clearBehaviorFailure(behavior, claim.target)
      }
      console.log(
        `[behaviors] ${behavior} superseded for ${claim.launchRepo}#${claim.launchPr}; current head will be reconsidered`,
      )
      continue
    }
    if (FAILED_AGENT_STATUSES.has(status) && boundedReviewFailure(call)) {
      deadLetterClaim(claim, call.error || 'Review needs attention')
      continue
    }
    const preflightFailed = FAILED_AGENT_STATUSES.has(status)
      && call.action === 'not_started'
      && call.outcome === 'preflight_failed'
      && !call.head_sha
    if (preflightFailed) {
      const message = call.error || 'agent preflight failed before any action'
      if (call.error_code === 'review_packet_too_large') {
        // This input cannot improve through retry. Retain the launch proof and
        // block this PR/head only; other targets continue normally.
        db.transaction(() => {
          if (deadLetterClaim(claim, message)) {
            setMeta(packetBlockKey(behavior, claim.launchRepo, claim.launchPr), claim.launchExpectedHead)
          }
        })()
      } else {
        recordBehaviorDeadLetter(claim, message, call.id)
        if (releaseOwnedClaim(behavior, claim.target, claim.claimId)) {
          recordBehaviorFailure(behavior, 'worker', message, claim.target)
        }
      }
      continue
    }
    const terminal = status === 'completed' || FAILED_AGENT_STATUSES.has(status)
    if (!terminal && Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
      const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker', message, claim.target)
        if (needsClaude(catalogForCalls, call.model)) claudeAuth.observeProcessFailure({ code: 1, signal: null, error: new Error(message) })
      }
      continue
    }
    if (status === 'completed') {
      const expectedActions = behavior === 'review-new-prs'
        ? new Map([['reviewed_clean', 'clean'], ['requested_changes', 'changes_requested']])
        : new Map([['approved', 'approved'], ['requested_changes', 'changes_requested']])
      const action = String(call.action || '')
      const outcome = String(call.outcome || '')
      const completedAt = String(call.completed_at || '')
      const headSha = String(call.head_sha || '').toLowerCase()
      if (expectedActions.get(action) !== outcome
        || !Number.isFinite(Date.parse(completedAt))
        || headSha !== claim.launchExpectedHead) {
        const error = 'completed agent call is missing authoritative action/outcome/head metadata'
        quarantineClaim(claim, 'invalid_result', error, call.id, quarantineEvidence(snapshot, claim, call).mayRun)
        console.error(`[behaviors] ${error} for ${claim.launchRepo}#${claim.launchPr}`)
        continue
      }
      const completed = completeBehaviorLaunchOwned({
        key: claim.key,
        target: claim.target,
        claimId: claim.claimId,
        action: action as 'reviewed_clean' | 'requested_changes' | 'approved',
        outcome: outcome as 'clean' | 'changes_requested' | 'approved',
        completedAt,
        headSha,
      })
      if (completed) {
        if (claim.launchQuarantine === 'unreadable') retireQuarantineIncident(claim)
        activeClaims.delete(claim.claimId)
        clearBehaviorFailure(behavior, claim.target)
      } else {
        activeClaims.delete(claim.claimId)
        const current = listBehaviorLaunchClaims(behavior).find(
          (candidate) => candidate.target === claim.target
            && candidate.claimId === claim.claimId,
        )
        if (current) {
          const error = 'terminal agent outcome could not complete its owned launch claim'
          if (deadLetterClaim(current, error)) recordBehaviorFailure(behavior, 'worker', error, claim.target)
        }
      }
    } else if (FAILED_AGENT_STATUSES.has(status)) {
      const message = call.error || `agent call terminated with status ${status}`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker', message, claim.target)
        // A run the user stopped from Swarm says nothing about the provider.
        if (call.error_code !== 'stopped' && needsClaude(catalogForCalls, call.model)) claudeAuth.observeProcessFailure(message)
      }
    } else if (RUNNING_AGENT_STATUSES.has(status)) {
      setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, null)
      renewSeenOwned(
        claim.key,
        claim.target,
        claim.claimId,
        BEHAVIOR_CLAIM_RENEWAL_MS,
      )
      renewPrOperationOwned(claim.claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
    } else {
      const message = `unrecognized agent call status "${status || 'missing'}"`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker', message, claim.target)
        if (needsClaude(catalogForCalls, call.model)) claudeAuth.observeProcessFailure(message)
      }
    }
  }
}

// ── review-new-prs implementation ───────────────────────────────────────

interface DatastorePr {
  repo: string
  number: number
  url: string
  draft: boolean
}

interface DatastoreFreshness {
  status: 'unchecked' | 'healthy' | 'unavailable'
  checkedAt: string
  ageSeconds: number | null
  lastSuccessAt: string | null
  error: string | null
}

const initialDatastoreFreshness: DatastoreFreshness = {
  status: 'unchecked',
  checkedAt: new Date(0).toISOString(),
  ageSeconds: null,
  lastSuccessAt: null,
  error: null,
}

const datastoreFreshnessByOrganization = new Map<string, DatastoreFreshness>()

function datastoreFreshness(): DatastoreFreshness {
  return datastoreFreshnessByOrganization.get(operationKey('review-new-prs')) ?? initialDatastoreFreshness
}

function configuredReviewer(): string {
  return getReviewAgentUsername()
}

function parseJson(value: string, operation: string): unknown {
  if (!value.trim()) throw new Error(`${operation} returned empty output`)
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error })
  }
}

function objectValue(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${operation} returned a non-object`)
  }
  return value as Record<string, unknown>
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return Number(value)
}

async function requireFreshDatastore(): Promise<void> {
  const checkedAt = new Date().toISOString()
  try {
    let stdout: string
    let unhealthyExit: unknown
    try {
      const result = await runFile(
        DATASTORE,
        datastoreArgs(['health', '--max-age-seconds', String(DATASTORE_MAX_AGE_SECONDS)]),
        { timeoutMs: 30_000, maxOutputBytes: 1 * 1024 * 1024, signal: behaviorSignal() },
      )
      stdout = result.stdout
    } catch (error) {
      const failure = error as { code?: unknown, stdout?: unknown }
      if (failure.code !== 1 || typeof failure.stdout !== 'string' || !failure.stdout.trim()) throw error
      stdout = failure.stdout
      unhealthyExit = error
    }
    const data = objectValue(parseJson(stdout, 'github-datastore health'), 'github-datastore health')
    const org = currentOrganization()
    if (org?.datastorePath && data.database !== resolve(org.datastorePath)) {
      throw new Error('github-datastore health returned a different account database')
    }
    if (data.action === 'health' && data.status === 'stale' && data.healthy === false
      && safeInteger(data.max_age_seconds, 'datastore max_age_seconds') === DATASTORE_MAX_AGE_SECONDS
      && safeInteger(data.age_seconds, 'datastore age_seconds') > DATASTORE_MAX_AGE_SECONDS
      && typeof data.last_success_at === 'string' && Number.isFinite(Date.parse(data.last_success_at))) {
      const message = `Datastore stale: last successful sync ${data.last_success_at}; age ${data.age_seconds}s exceeds ${DATASTORE_MAX_AGE_SECONDS}s`
      datastoreFreshnessByOrganization.set(operationKey('review-new-prs'), {
        status: 'unavailable', checkedAt, ageSeconds: Number(data.age_seconds),
        lastSuccessAt: data.last_success_at, error: message,
      })
      try { await recoverLegacyDatastore(org, behaviorSignal()) }
      catch (error) { console.error('[behaviors] legacy datastore sync recovery failed:', behaviorErrorMessage(error)) }
      throw new Error(message)
    }
    if (unhealthyExit) throw unhealthyExit
    if (data.action !== 'health'
      || data.status !== 'healthy'
      || data.healthy !== true
      || safeInteger(data.max_age_seconds, 'datastore max_age_seconds') !== DATASTORE_MAX_AGE_SECONDS) {
      throw new Error('github-datastore health returned a malformed or stale result')
    }
    const ageSeconds = safeInteger(data.age_seconds, 'datastore age_seconds')
    const lastSuccessAt = String(data.last_success_at || '')
    if (ageSeconds > DATASTORE_MAX_AGE_SECONDS || !Number.isFinite(Date.parse(lastSuccessAt))) {
      throw new Error('github-datastore health returned invalid freshness metadata')
    }
    datastoreFreshnessByOrganization.set(operationKey('review-new-prs'), {
      status: 'healthy',
      checkedAt,
      ageSeconds,
      lastSuccessAt,
      error: null,
    })
  } catch (error) {
    const message = behaviorErrorMessage(error)
    const observed = datastoreFreshnessByOrganization.get(operationKey('review-new-prs'))
    datastoreFreshnessByOrganization.set(operationKey('review-new-prs'), {
      status: 'unavailable', checkedAt,
      ageSeconds: observed?.checkedAt === checkedAt ? observed.ageSeconds : null,
      lastSuccessAt: observed?.checkedAt === checkedAt ? observed.lastSuccessAt : null,
      error: message,
    })
    throw new Error(`github-datastore freshness gate failed: ${message}`, { cause: error })
  }
}

async function listOpenPrsByAuthor(author: string): Promise<DatastorePr[]> {
  if (!author) return []
  await requireFreshDatastore()
  const { stdout } = await runFile(
    DATASTORE,
    datastoreArgs(['view', 'pr', '--status', 'open', '--format', 'json']),
    { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024, signal: behaviorSignal() },
  )
  const parsed = parseJson(stdout, 'github-datastore view pr')
  if (!Array.isArray(parsed)) throw new Error('github-datastore view pr returned a non-array')
  const seen = new Set<string>()
  const prs = parsed.map((row, index) => {
    const value = objectValue(row, `github-datastore PR row ${index}`)
    const repo = String(value.repo || '')
    const number = safeInteger(value.number, `github-datastore PR row ${index} number`)
    const url = String(value.url || '')
    const prAuthor = String(value.author || '')
    const draft = safeInteger(value.draft, `github-datastore PR row ${index} draft`)
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)
      || number < 1
      || draft > 1
      || value.status !== 'open'
      || !prAuthor
      || url !== `https://github.com/${repo}/pull/${number}`) {
      throw new Error(`github-datastore PR row ${index} violates the candidate contract`)
    }
    const key = `${repo}#${number}`
    if (seen.has(key)) throw new Error(`github-datastore returned duplicate PR ${key}`)
    seen.add(key)
    return { repo, number, url, draft: draft === 1, author: prAuthor }
  })
  retireBehaviorDeadLettersForClosedPrs(seen, undefined, currentOrganization()?.login)
  retireClosedTargetFailures(seen, ['review-new-prs', 'approve-prs', 'resolve-unblocking'])
  return prs.filter((pr) => organizationOwns(pr.repo) && pr.author === author && !pr.draft)
}

async function localCheckoutPath(owner: string, repo: string, number: number, head: string): Promise<string> {
  return resolveReviewCheckout(owner, repo, number, configuredReviewer(), head, behaviorSignal())
}

async function currentHeadSha(
  repo: string,
  number: number,
  actor: string,
): Promise<string> {
  const [owner, name] = repo.split('/', 2)
  if (!owner || !name || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`invalid GitHub PR identity: ${repo}#${number}`)
  }
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await runFile(
    GH_INTERFACE,
    ['--head-sha', `#${number}`, '--token-user', actor],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 1 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = objectValue(
    parseJson(stdout, 'github-interface --head-sha'),
    'github-interface --head-sha',
  )
  const headSha = String(data.head_sha || '').toLowerCase()
  if (data.action !== 'head_sha'
    || data.repository !== repo
    || data.pull_number !== number
    || !SHA_PATTERN.test(headSha)) {
    throw new Error('github-interface --head-sha returned malformed state')
  }
  return headSha
}

function settleClaimAfterExit(
  behavior: ActiveClaim['behavior'],
  target: string,
  claimId: string,
): (result: { code: number | null, signal: NodeJS.Signals | null, error?: Error }) => void {
  return ({ code, signal, error }) => {
    if (!error && signal === null && code === 0) {
      activeClaims.delete(claimId)
      setBehaviorLaunchErrorOwned(
        behavior,
        target,
        claimId,
        'worker exited successfully; awaiting durable agent result',
      )
      renewSeenOwned(behavior, target, claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
      renewPrOperationOwned(claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
      return
    }
    const outcome = error?.message || signal || `exit ${code ?? 'unknown'}`
    activeClaims.delete(claimId)
    setBehaviorLaunchErrorOwned(
      behavior,
      target,
      claimId,
      `worker exited ${outcome}; awaiting durable agent result`,
    )
    renewSeenOwned(behavior, target, claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
    renewPrOperationOwned(claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
    console.error(`[behaviors] ${behavior} worker exited for ${target}; awaiting durable result (${outcome})`)
  }
}

// The model a reviewer slot launches right now, or null when the panel no
// longer has that slot — the count was lowered while this tick was waiting.
async function slotModel(slot: ReviewerSlot): Promise<{ model: string, recovery: string, catalog: Catalog } | null> {
  const panel = await reviewPanel(getReviewers('review-new-prs'))
  const reviewer = panel.reviewers.find((entry) => entry.slot === slot)
  return reviewer ? { model: reviewer.model, recovery: panel.recovery, catalog: panel.catalog } : null
}

async function fireReview(
  pr: DatastorePr,
  claimTarget: string,
  claimId: string,
  slot: ReviewerSlot = 'primary',
): Promise<boolean> {
  if (!isEnabled('review-new-prs')) return false
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const resolved = await waitForBehavior(slotModel(slot))
  if (!resolved) return false
  const { model, recovery, catalog } = resolved
  const claude = needsClaude(catalog, model)
  const actor = configuredReviewer()
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  await waitForBehavior(prepareModelClis(catalog, [model, recovery]))
  // mkdir the cwd hack dir — agent-interface needs it to exist for
  // --pwd resolution behavior identical to triggerPrReview in agent.ts.
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('review-new-prs')) return false
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('review-new-prs') || behaviorAborted()) return false
  const expectedHead = await currentHeadSha(pr.repo, pr.number, actor)
  const pwd = await localCheckoutPath(owner, repo, pr.number, expectedHead)
  // The head-SHA lookup above is a subprocess with a 30s timeout, so the user
  // has a real window to turn the behaviour off while it is out. Nothing
  // re-read the flag between it returning and the spawn below, so a toggle-off
  // in that window still posted on the pull request it was meant to stop.
  if (!isEnabled('review-new-prs') || behaviorAborted()) return false
  // Read the ceiling here rather than taking a snapshot from the top of the
  // tick. A tick fans out over every open pull request, and each one waits on
  // auth, a checkout resolve and the head-SHA subprocess above — minutes, in
  // the worst case. Narrowing the ceiling in the view took effect immediately
  // on screen while the run already under way kept spawning agents at the old
  // one, so the view understated which pull requests were being acted on.
  const setting = getSetting('review-new-prs')
  // Pass the priority ceiling through as `--p`. agent-interface forwards
  // it to github-interface as `--p <value>`; for review-new-prs the
  // possible values are p0 / p1 / p2.
  if ((await slotModel(slot))?.model !== model) return false
  const source = 'poise:review-new-prs'
  const args = [
    '--pr-review',
    `#${num}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    claimId,
    '--pwd',
    pwd,
    '--p',
    setting,
    ...noteArgs('review-new-prs'),
  ]
  if (!markLaunchIntent(
    'review-new-prs',
    pr,
    claimTarget,
    claimId,
    expectedHead,
    actor,
  )) return false
  if (!renewPrOperationOwned(claimId, BEHAVIOR_CLAIM_RENEWAL_MS)) {
    throw new Error(`review PR operation ownership was lost for ${pr.repo}#${pr.number}`)
  }
  await spawnDetached(AGENT_INTERFACE, args, {
    cwd: agentInterfaceCwd(),
    env: claudeSubscriptionEnvironment(),
    onExit: settleClaimAfterExit('review-new-prs', claimTarget, claimId),
  })
  markClaimLaunched(claimId)
  return true
}

const INITIAL_REVIEW_BASELINE_KEY = 'behavior_review_new_prs_initial_baseline'

function prepareInitialReviewBaselines(): void {
  if (getMeta(enabledKey('review-new-prs')) !== '1') return
  db.transaction(() => {
    const completed = listSeenTargets('review-new-prs').some((target) =>
      target === REVIEW_SNAPSHOT_TARGET || target === LEGACY_REVIEW_SNAPSHOT_TARGET
      || target.startsWith(`${REVIEW_SNAPSHOT_TARGET}:org:`))
    if (completed) return
    // Reserve every initial account before any asynchronous snapshot can finish.
    // A partial first enable must still baseline its failed account on retry.
    for (const org of readyOrganizations()) {
      behaviorOrganization.run(org, () => setMeta(INITIAL_REVIEW_BASELINE_KEY, '1'))
    }
  }).immediate()
}

async function initializeReviewBaseline(): Promise<boolean> {
  if (hasSeen('review-new-prs', snapshotTarget())) return false
  if (getMeta(INITIAL_REVIEW_BASELINE_KEY) === '1') {
    await snapshotReviewNewPrs()
    return true
  }
  // Coverage expanded after automation was established: open PRs in the newly
  // covered account are eligible, rather than silently absorbed into a baseline.
  recordSeen('review-new-prs', snapshotTarget())
  return false
}

async function snapshotReviewNewPrs(): Promise<void> {
  // A missing marker is the sole readiness predicate. Clear it before work so
  // a concurrent tick (including one in another local server process) takes
  // the safe snapshot path instead of firing against a partial snapshot.
  releaseSeen('review-new-prs', snapshotTarget())
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    if (!isEnabled('review-new-prs')) return
    for (const p of prs) {
      if (behaviorAborted()) {
        throw behaviorSignal()?.reason ?? new Error('review snapshot aborted')
      }
      recordSeen('review-new-prs', `${p.repo}#${p.number}`)
    }
    // A real marker distinguishes an intentionally empty snapshot from
    // "snapshot has never completed". Without it, the first PR created in
    // an initially empty repository was silently absorbed by a later
    // snapshot instead of triggering the behavior.
    recordSeen('review-new-prs', snapshotTarget())
    setMeta(INITIAL_REVIEW_BASELINE_KEY, '')
  } catch (err) {
    releaseSeen('review-new-prs', snapshotTarget())
    console.error('[behaviors] snapshot failed:', err)
    throw err
  }
}

function migrateReviewNewPrsLedger(): void {
  const version = getMeta('behavior_review_new_prs_keyver')
  if (version === '3') return

  // A completed v2 snapshot is authoritative for what was already known.
  // Copy its per-head targets to PR-level targets and retain the originals:
  // launch metadata on those rows is downstream approval evidence.
  if (version === '2') {
    const legacyTargets = listSeenTargets('review-new-prs').filter((target) => target === LEGACY_REVIEW_SNAPSHOT_TARGET || organizationOwns(target))
    if (legacyTargets.includes(LEGACY_REVIEW_SNAPSHOT_TARGET)) {
      for (const target of legacyTargets) {
        const separator = target.indexOf('@')
        if (separator > 0) recordSeen('review-new-prs', target.slice(0, separator))
      }
      recordSeen('review-new-prs', snapshotTarget())
    }
  }
  setMeta('behavior_review_new_prs_keyver', '3')
}

const FAILED_SNAPSHOT_RECOVERY_META = 'behavior_review_new_prs_failed_snapshot_recovery_v1'
const SNAPSHOT_RECOVERY_META = 'behavior_review_new_prs_snapshot_recovery_v2'

async function recoverSnapshotReviews(
  prs: DatastorePr[],
  reviewer: string,
): Promise<void> {
  if (currentOrganization()?.managed || getMeta(SNAPSHOT_RECOVERY_META) === '1') return
  const previousRecoveryComplete = getMeta(FAILED_SNAPSHOT_RECOVERY_META) === '1'
  const open = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`))
  const candidates = listSnapshotOnlySeen('review-new-prs')
    .filter((row) => row.target !== snapshotTarget() && open.has(row.target))
  if (candidates.length > 0) {
    const snapshot = await readBehaviorLogSnapshot()
    const logs = snapshot.entries
    let uncertain = false
    for (const candidate of candidates) {
      const separator = candidate.target.lastIndexOf('#')
      const repo = candidate.target.slice(0, separator)
      const prId = candidate.target.slice(separator + 1)
      const matching = logs.filter((entry) =>
        entry.behavior === 'pr_review'
        && entry.repo === repo
        && entry.pr_id === prId
        && entry.actor?.toLowerCase() === reviewer.toLowerCase())
      if (logQuarantine(snapshot, { repo, prId, behavior: 'pr_review' })
        || matching.some((entry) => logQuarantine(snapshot, {
          id: entry.id, correlationId: entry.correlation_id,
        }, true))) {
        db.transaction(() => {
          const changed = db.prepare(`
            UPDATE behavior_seen SET launch_quarantine = 'unreadable', launch_error = 'snapshot review evidence is unreadable'
            WHERE key = 'review-new-prs' AND target = ? AND seen_at = ?
              AND claim_id = '' AND launch_requested_at IS NULL AND launch_quarantine IS NULL
          `).run(candidate.target, candidate.seenAt)
          if (changed.changes) db.prepare(`
            INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, actor, source, correlation_id, error, created_at)
            VALUES(?, 'review-new-prs', ?, ?, ?, ?, 'poise:snapshot-recovery', ?, 'snapshot review evidence is unreadable', ?)
          `).run(randomUUID(), candidate.target, repo, Number(prId), reviewer,
            `snapshot:${candidate.target}:${candidate.seenAt}`, new Date().toISOString())
        })()
        uncertain = true
        continue
      }
      const completed = matching.some((entry) => entry.status === 'completed')
      const previouslyUnreadable = db.prepare(`
        SELECT 1 FROM behavior_seen WHERE key = 'review-new-prs' AND target = ? AND seen_at = ?
          AND claim_id = '' AND launch_requested_at IS NULL AND launch_quarantine IS NOT NULL
      `).get(candidate.target, candidate.seenAt)
      if (previouslyUnreadable) {
        if (!completed) { uncertain = true; continue }
        db.prepare(`
          UPDATE behavior_seen SET launch_quarantine = NULL, launch_error = NULL
          WHERE key = 'review-new-prs' AND target = ? AND seen_at = ?
            AND claim_id = '' AND launch_requested_at IS NULL AND launch_quarantine = 'unreadable'
        `).run(candidate.target, candidate.seenAt)
        db.prepare(`
          UPDATE behavior_dead_letters SET retired_at = ?
          WHERE behavior = 'review-new-prs' AND target = ? AND source = 'poise:snapshot-recovery'
            AND correlation_id = ? AND retired_at IS NULL
        `).run(new Date().toISOString(), candidate.target, `snapshot:${candidate.target}:${candidate.seenAt}`)
      }
      const failedBeforeSnapshot = matching.some((entry) =>
        entry.status === 'failed'
        && Date.parse(entry.started_at) <= Date.parse(candidate.seenAt))
      const matureRuntime = logs.some((entry) =>
        entry.behavior === 'pr_review'
        && entry.actor?.toLowerCase() === reviewer.toLowerCase()
        && Date.parse(entry.started_at) < Date.parse(candidate.seenAt))
      if (!completed && (failedBeforeSnapshot
        || (matching.length === 0 && previousRecoveryComplete && matureRuntime))) {
        releaseSeen('review-new-prs', candidate.target)
      }
    }
    if (uncertain) return
  }
  setMeta(SNAPSHOT_RECOVERY_META, '1')
}

async function tickReviewNewPrs(): Promise<void> {
  if (!isEnabled('review-new-prs')) return
  const author = getMeta('me') || ''
  if (!author) return
  const reviewer = configuredReviewer()

  // keyver=3 restores one initial review per PR. Convert a complete v2 ledger
  // in place so a PR opened during downtime is not absorbed by a deploy-time
  // snapshot, while historical launch evidence remains available to approval.
  migrateReviewNewPrsLedger()

  if (await initializeReviewBaseline()) return
  try {
    const panel = await reviewPanel(getReviewers('review-new-prs'))
    const slots = availableReviewSlots(panel)
    if (slots.length === 0) return
    const prs = await listOpenPrsByAuthor(author)
    await recoverSnapshotReviews(prs, reviewer)
    let failure: unknown
    await Promise.all(prs.flatMap((pr) => {
      const key = `${pr.repo}#${pr.number}`
      // A fresh primary admits the current panel; already handled PRs do
      // not gain new reviewers when the configured panel grows.
      const primaryFresh = !hasSeen('review-new-prs', key) || !!getFailedBehaviorLaunch('review-new-prs', key)
      // Remember the original panel even if one provider cannot start yet.
      // Its admitted reviewers still run after a sibling finishes; increasing
      // the panel later must not add reviewers to historical PRs.
      const panelKey = `${META_PREFIX}review_new_prs_panel:${key}`
      let admitted = parseJsonMeta(panelKey)
      if (!Array.isArray(admitted)) {
        admitted = primaryFresh ? panel.reviewers.map(({ slot }) => slot) : []
        if (primaryFresh) setMeta(panelKey, JSON.stringify(admitted))
      }
      const admittedSlots = new Set(admitted as ReviewerSlot[])
      return slots.filter((slot) => {
        const target = reviewSlotTarget(key, slot)
        if (slot === 'primary') return primaryFresh
        return (admittedSlots.has(slot) && !hasSeen('review-new-prs', target)) || !!getFailedBehaviorLaunch('review-new-prs', target)
      }).map((slot) => [pr, key, slot] as const)
    }).map(async ([pr, key, slot]) => {
      if (!isEnabled('review-new-prs') || behaviorAborted()) return
      const target = reviewSlotTarget(key, slot)
      const checkTarget = `${target}:check`
      if (!behaviorRetryDue('review-new-prs', target) || !behaviorRetryDue('review-new-prs', checkTarget)) return
      let operationId: string | null = null
      let launched = false
      let checked = false
      try {
        if (await packetBlocked('review-new-prs', pr.repo, pr.number)) {
          checked = true
          return
        }
        operationId = await claimEligiblePrOperation('review-new-prs', target)
        if (!operationId) {
          console.log(`[behaviors] review-new-prs deferred for ${key}: PR operation busy`)
          return
        }
        // Atomic claim: exactly one caller succeeds for any given key
        // across all concurrent runtimes. Losers skip silently.
        let claimId = claimSeenOwnedAs('review-new-prs', target, operationId)
        if (!claimId) {
          const recovered = await releaseFailedBehaviorIfNoAction(
            'review-new-prs',
            pr.repo,
            pr.number,
            target,
          )
          if (!recovered) return
          claimId = claimSeenOwnedAs('review-new-prs', target, operationId)
        }
        if (!claimId) return
        trackClaim('review-new-prs', target, claimId)

        try {
          // Guard against double-firing with approve-prs: if bit-mis has
          // an outstanding CHANGES_REQUESTED on this PR, the follow-up
          // loop is approve-prs's job. This is an intentional terminal skip,
          // so its claim is retained.
          if (reviewer) {
            try {
              const ch = await checkChangesAddressed(pr.repo, pr.number, reviewer)
              if (!isEnabled('review-new-prs')) {
                releaseOwnedClaim('review-new-prs', target, claimId)
                return
              }
              if (ch.hasChangeRequest) {
                checked = true
                completeOwnedClaim('review-new-prs', target, claimId)
                console.log(`[behaviors] review-new-prs skipped for ${pr.repo}#${pr.number} — outstanding CHANGES_REQUESTED, approve-prs owns it`)
                return
              }
            } catch (err) {
              if (behaviorAborted()) {
                releaseOwnedClaim('review-new-prs', target, claimId)
                return
              }
              releaseOwnedClaim('review-new-prs', target, claimId)
              throw err
            }
          }

          const accepted = await fireReview(pr, target, claimId, slot)
          if (!accepted) {
            releaseOwnedClaim('review-new-prs', target, claimId)
            return
          }
          launched = true
          checked = true
          console.log(`[behaviors] review-new-prs fired for ${pr.repo}#${pr.number} (p=${getSetting('review-new-prs')}, ${slot})`)
        } catch (err) {
          // Pre-launch work and spawn acknowledgement are part of the claim.
          // Release on failure so the next tick can retry this exact target.
          releaseOwnedClaim('review-new-prs', target, claimId)
          throw err
        }
      } catch (err) {
        checked = false
        if (behaviorAborted()) return
        console.error(`[behaviors] review-new-prs step failed for ${pr.repo}#${pr.number} (${slot}):`, err)
        if (err instanceof BehaviorLogFeedError) failure ??= err
        else recordBehaviorFailure('review-new-prs', 'operation', err, checkTarget)
      } finally {
        if (checked && !behaviorAborted()) clearBehaviorFailure('review-new-prs', checkTarget)
        if (!launched && operationId) releasePrOperationOwned(operationId)
      }
    }))
    if (failure) throw failure
  } catch (err) {
    console.error('[behaviors] tick failed:', err)
    throw err
  }
}

// ── approve-prs implementation ──────────────────────────────────────────
//
// For each open PR by the configured user, re-evaluate either an addressed
// change request left by the configured review agent or a clean PR that
// explicitly requests that identity's initial approval.
//
// Follow-ups dedupe by request timestamp + response count. A clean initial
// review becomes eligible on the next scheduler scan and dedupes by head SHA.

interface ChangesAddressedResult {
  hasChangeRequest: boolean
  latestRequestAt: string | null
  headSha: string
  commitsAfterRequest: number
  authorInlineRepliesAfterRequest: number
  responseCount: number
}

interface ReviewActivityResult {
  state: string
  draft: boolean
  headSha: string
  reviewerRequested: boolean
  activeChangeRequestAuthors: string[]
  unresolvedConversationCount: number
  unresolvedLiveConversationCount: number
  unresolvedConversationAuthors: string[]
  unresolvedLiveConversationAuthors: string[]
  reviewerLatestState: string | null
  reviewerLatestCommit: string | null
  reviewerReviewsSince: number
  // The ids of those reviews, once github-interface reports them; null from
  // an older github-interface, when only the count is known.
  reviewerReviewIdsSince: number[] | null
  reviewerPendingReviews: number
  latestActivityAt: string | null
}

async function checkReviewActivity(
  repo: string,
  number: number,
  reviewer: string,
  since: string,
): Promise<ReviewActivityResult> {
  const [owner, name] = repo.split('/', 2)
  if (!owner || !name) throw new Error(`invalid GitHub repository: ${repo}`)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await runFile(
    GH_INTERFACE,
    [
      '--review-activity-since',
      `#${number}`,
      '--username',
      reviewer,
      '--since',
      since,
      '--token-user',
      reviewer,
    ],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = objectValue(
    parseJson(stdout, 'github-interface --review-activity-since'),
    'github-interface --review-activity-since',
  )
  const unresolvedConversationCount = safeInteger(
    data.unresolved_conversation_count,
    'review-activity-since unresolved_conversation_count',
  )
  const unresolvedLiveConversationCount = safeInteger(
    data.unresolved_live_conversation_count,
    'review-activity-since unresolved_live_conversation_count',
  )
  if (data.action !== 'review_activity_since'
    || data.repository !== repo
    || data.pull_number !== number
    || String(data.username || '').toLowerCase() !== reviewer.toLowerCase()
    || typeof data.state !== 'string'
    || typeof data.draft !== 'boolean'
    || typeof data.reviewer_requested !== 'boolean'
    || !Array.isArray(data.active_change_request_authors)
    || data.active_change_request_authors.some((value) => typeof value !== 'string')
    || !Array.isArray(data.unresolved_conversation_authors)
    || data.unresolved_conversation_authors.some((value) => typeof value !== 'string')
    || !Array.isArray(data.unresolved_live_conversation_authors)
    || data.unresolved_live_conversation_authors.some(
      (value) => typeof value !== 'string',
    )) {
    throw new Error('github-interface --review-activity-since returned malformed state')
  }
  const headSha = String(data.head_sha || '').toLowerCase()
  if (!SHA_PATTERN.test(headSha)) {
    throw new Error('github-interface --review-activity-since returned invalid head SHA')
  }
  const latestActivityAt = data.latest_activity_at === null
    ? null
    : String(data.latest_activity_at || '')
  if (latestActivityAt !== null && !Number.isFinite(Date.parse(latestActivityAt))) {
    throw new Error('github-interface --review-activity-since returned invalid activity timestamp')
  }
  const reviewerLatestState = data.reviewer_latest_state === null
    ? null
    : String(data.reviewer_latest_state || '')
  if (reviewerLatestState !== null
    && !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(reviewerLatestState)) {
    throw new Error('github-interface --review-activity-since returned invalid latest review state')
  }
  const reviewerLatestCommit = data.reviewer_latest_commit === null
    ? null
    : String(data.reviewer_latest_commit || '').toLowerCase()
  if (reviewerLatestCommit !== null && !SHA_PATTERN.test(reviewerLatestCommit)) {
    throw new Error('github-interface --review-activity-since returned invalid latest review head')
  }
  const reviewerReviewsSince = safeInteger(
    data.reviewer_reviews_since,
    'review-activity-since reviewer_reviews_since',
  )
  const reviewerPendingReviews = safeInteger(
    data.reviewer_pending_reviews,
    'review-activity-since reviewer_pending_reviews',
  )
  let reviewerReviewIdsSince: number[] | null = null
  if (Array.isArray(data.reviewer_reviews_since_items)) {
    reviewerReviewIdsSince = data.reviewer_reviews_since_items.map((item: any) => {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || Number(item.id) <= 0) {
        throw new Error('github-interface --review-activity-since returned an invalid review id')
      }
      return Number(item.id)
    })
    if (reviewerReviewIdsSince!.length !== reviewerReviewsSince) {
      throw new Error('github-interface --review-activity-since review ids do not match their count')
    }
  }
  return {
    state: data.state,
    draft: data.draft,
    headSha: headSha.toLowerCase(),
    reviewerRequested: data.reviewer_requested,
    activeChangeRequestAuthors: data.active_change_request_authors.map(String),
    unresolvedConversationCount,
    unresolvedLiveConversationCount,
    unresolvedConversationAuthors: data.unresolved_conversation_authors.map(String),
    unresolvedLiveConversationAuthors: data.unresolved_live_conversation_authors.map(String),
    reviewerLatestState,
    reviewerLatestCommit,
    reviewerReviewsSince,
    reviewerReviewIdsSince,
    reviewerPendingReviews,
    latestActivityAt,
  }
}

function packetBlockKey(behavior: string, repo: string, number: number): string {
  return `packet_block:${behavior}:${repo}#${number}`
}

async function packetBlocked(
  behavior: ActiveClaim['behavior'], repo: string, number: number, head?: string,
): Promise<boolean> {
  const key = packetBlockKey(behavior, repo, number)
  const blockedHead = getMeta(key)
  if (!blockedHead) return false
  const current = head ?? await currentHeadSha(repo, number, configuredReviewer())
  if (current === blockedHead) return true
  // A changed head is new input. The old launch remains in the audit trail;
  // initial-review recovery still verifies its exact no-action provenance.
  setMeta(key, '')
  return false
}

// Held like the bounded failures: a run the user stopped from Swarm must not
// be relaunched on the same head by the next tick; a new head or a replay is
// a fresh decision.
function boundedReviewFailure(call: LogEntry): boolean {
  return call.review_policy === REVIEW_POLICY
    && ['model_output_limit', 'review_budget_exhausted', 'review_recovery_failed', 'stopped'].includes(call.error_code || '')
}

async function releaseFailedBehaviorIfNoAction(
  behavior: ActiveClaim['behavior'],
  repo: string,
  number: number,
  target: string,
): Promise<boolean> {
  const launchBehavior = upstreamBehavior(behavior)
  const source = `poise:${behavior}`
  const failed = getFailedBehaviorLaunch(behavior, target)
  if (!failed?.launchCallId
    || failed.launchQuarantine
    || failed.launchBehavior !== launchBehavior
    || failed.launchRepo !== repo
    || failed.launchPr !== number
    || failed.launchSource !== source) {
    return false
  }
  const snapshot = await readBehaviorLogSnapshot()
  if (quarantineFailedLog(snapshot, failed)) return false
  const logs = snapshot.entries
  const call = logs.find((row) => row.id === failed.launchCallId)
  if (!call
    || !FAILED_AGENT_STATUSES.has(call.status.toLowerCase())
    || call.behavior !== launchBehavior
    || call.repo !== repo
    || String(call.pr_id || '') !== String(number)
    || String(call.actor || '').toLowerCase() !== failed.launchActor.toLowerCase()
    || call.source !== failed.launchSource
    || call.correlation_id !== failed.launchCorrelationId
    || call.expected_head !== failed.launchExpectedHead
    || call.head_sha !== null) {
    return false
  }
  // A bounded attempt already used its recovery. Hold this input across
  // restarts; a different head or an explicit model change can be reconsidered.
  const configuredModel = launchBehavior === 'pr_approve'
    ? (await reviewChoice('pr_approve')).model
    : (await slotModel(reviewSlotOfTarget(target)))?.model
  if (boundedReviewFailure(call) && call.model === configuredModel
    && await currentHeadSha(repo, number, failed.launchActor) === failed.launchExpectedHead) return false
  const blockedPacket = call.action === 'not_started'
    && call.outcome === 'preflight_failed'
    && call.error_code === 'review_packet_too_large'
  if (blockedPacket) {
    if (await currentHeadSha(repo, number, failed.launchActor) === failed.launchExpectedHead) return false
    return releaseFailedBehaviorLaunch(behavior, target, failed.launchCallId, failed.launchExpectedHead)
  }
  // Older Caller logs were closed before their no-action outcome was typed.
  // Apply the same preflight recovery rule used for active claims above; exact
  // identity, bounded-failure and oversized-packet holds have already passed.
  if (call.action === 'not_started' && call.outcome === 'preflight_failed') {
    return releaseFailedBehaviorLaunch(behavior, target, failed.launchCallId, failed.launchExpectedHead)
  }
  if (call.action !== null || call.outcome !== null) return false
  const startedAt = agentCallStartedAt(call)
  if (!Number.isFinite(Date.parse(startedAt))) return false
  const activity = await checkReviewActivity(
    repo,
    number,
    failed.launchActor,
    startedAt,
  )
  // Reviews the other reviewers of this pull request claim as their own
  // (Caller's receipts) are not this run's; only an unclaimed one could be
  // the dead run's own review, posted a moment before it died.
  const claimed = new Set(logs
    .filter((row) => row.id !== call.id && row.repo === repo && String(row.pr_id || '') === String(number) && typeof row.review_id === 'number')
    .map((row) => row.review_id as number))
  const unclaimed = activity.reviewerReviewIdsSince === null
    ? activity.reviewerReviewsSince
    : activity.reviewerReviewIdsSince.filter((id) => !claimed.has(id)).length
  if (unclaimed !== 0 || activity.reviewerPendingReviews !== 0) {
    return false
  }
  if (behavior === 'approve-prs' && activity.headSha !== failed.launchExpectedHead) {
    return false
  }
  const released = releaseFailedBehaviorLaunch(
    behavior,
    target,
    failed.launchCallId,
    failed.launchExpectedHead,
  )
  if (released) {
    console.log(`[behaviors] ${behavior} recovered failed no-action launch for ${repo}#${number}`)
  }
  return released
}

async function checkChangesAddressed(repo: string, number: number, reviewer: string): Promise<ChangesAddressedResult> {
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await runFile(
    GH_INTERFACE,
    [
      '--requested-changes-addressed',
      `#${number}`,
      '--username',
      reviewer,
      '--token-user',
      reviewer,
    ],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = objectValue(
    parseJson(stdout, 'github-interface --requested-changes-addressed'),
    'github-interface --requested-changes-addressed',
  )
  const hasChangeRequest = data.has_change_request
  const status = data.status
  const headSha = String(data.head_sha || '').toLowerCase()
  const commitsAfterRequest = safeInteger(
    data.commits_after_request,
    'requested-changes-addressed commits_after_request',
  )
  const authorInlineRepliesAfterRequest = safeInteger(
    data.author_inline_replies_after_request,
    'requested-changes-addressed author_inline_replies_after_request',
  )
  const responseCount = safeInteger(
    data.response_count,
    'requested-changes-addressed response_count',
  )
  const latestRequestAt = data.latest_request_at === null
    ? null
    : String(data.latest_request_at || '')
  const latestState = data.reviewer_latest_state === null
    ? null
    : String(data.reviewer_latest_state || '')
  if (data.action !== 'requested_changes_addressed'
    || data.repository !== repo
    || data.pull_number !== number
    || String(data.username || '').toLowerCase() !== reviewer.toLowerCase()
    || typeof hasChangeRequest !== 'boolean'
    || typeof status !== 'boolean'
    || !SHA_PATTERN.test(headSha)
    || responseCount !== commitsAfterRequest + authorInlineRepliesAfterRequest
    || (hasChangeRequest
      ? latestState !== 'CHANGES_REQUESTED'
        || latestRequestAt === null
        || !Number.isFinite(Date.parse(latestRequestAt))
      : latestRequestAt !== null)) {
    throw new Error('github-interface --requested-changes-addressed returned malformed state')
  }
  return {
    hasChangeRequest,
    latestRequestAt,
    headSha,
    commitsAfterRequest,
    authorInlineRepliesAfterRequest,
    responseCount,
  }
}

async function fireApprove(
  pr: DatastorePr,
  claimTarget: string,
  claimId: string,
  expectedHead: string,
): Promise<boolean> {
  if (!isEnabled('approve-prs')) return false
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const { model, recovery, catalog } = await waitForBehavior(reviewChoice('pr_approve'))
  const claude = needsClaude(catalog, model)
  const actor = configuredReviewer()
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  await waitForBehavior(prepareModelClis(catalog, [model, recovery]))
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('approve-prs')) return false
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('approve-prs') || behaviorAborted()) return false
  const currentHead = await currentHeadSha(pr.repo, pr.number, actor)
  // The head-SHA lookup above is a subprocess with a 30s timeout, so the user
  // has a real window to turn the behaviour off while it is out. Nothing
  // re-read the flag between it returning and the spawn below, so a toggle-off
  // in that window still posted on the pull request it was meant to stop.
  if (!isEnabled('approve-prs') || behaviorAborted()) return false
  if (currentHead !== expectedHead) {
    throw new Error(
      `approval head changed before launch: expected ${expectedHead}, got ${currentHead}`,
    )
  }
  const pwd = await localCheckoutPath(owner, repo, pr.number, expectedHead)
  if (!isEnabled('approve-prs') || behaviorAborted()) return false
  if ((await reviewChoice('pr_approve')).model !== model) return false
  const source = 'poise:approve-prs'
  const args = [
    '--pr-approve',
    `#${num}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    claimId,
    '--pwd',
    pwd,
    ...noteArgs('approve-prs'),
  ]
  if (!markLaunchIntent(
    'approve-prs',
    pr,
    claimTarget,
    claimId,
    expectedHead,
    actor,
  )) return false
  if (!renewPrOperationOwned(claimId, BEHAVIOR_CLAIM_RENEWAL_MS)) {
    throw new Error(`approval PR operation ownership was lost for ${pr.repo}#${pr.number}`)
  }
  await spawnDetached(AGENT_INTERFACE, args, {
    cwd: agentInterfaceCwd(),
    env: claudeSubscriptionEnvironment(),
    onExit: settleClaimAfterExit('approve-prs', claimTarget, claimId),
  })
  markClaimLaunched(claimId)
  return true
}

async function tickApprovePrs(): Promise<void> {
  if (!isEnabled('approve-prs')) return
  const author = getMeta('me') || ''
  // The reviewer is whoever left the change-requests we're checking
  // against — that's the bot identity threaded through from
  // cachePlugin.opts.reviewAgentUsername. Reading process.env here is
  // a trap: Vite's loadEnv populates the config-time options object
  // but doesn't propagate to process.env at runtime.
  if (!author) return
  const reviewer = configuredReviewer()
  try {
    const prs = await listOpenPrsByAuthor(author)
    let failure: unknown
    await Promise.all(prs.map(async (pr) => {
      if (!isEnabled('approve-prs') || behaviorAborted()) return
      const prTarget = `${pr.repo}#${pr.number}`
      if (invalidPrResultHeld(pr.repo, pr.number)) return
      const checkTarget = `${prTarget}:check`
      if (!behaviorRetryDue('approve-prs', checkTarget)) return
      let operationId: string | null = null
      let launched = false
      let checked = false
      try {
        const check = await checkChangesAddressed(pr.repo, pr.number, reviewer)
        if (await packetBlocked('approve-prs', pr.repo, pr.number, check.headSha)) {
          checked = true
          return
        }
        if (!check.hasChangeRequest && !latestApprovalBasisLaunch(pr.repo, pr.number)) {
          checked = true
          return
        }
        if (hasActiveAgentLaunchForPr(pr.repo, pr.number)) return
        operationId = await claimEligiblePrOperation('approve-prs', prTarget)
        if (!operationId) {
          console.log(`[behaviors] approve-prs deferred for ${prTarget}: PR operation busy`)
          return
        }
        if (!isEnabled('approve-prs')) return
        // Follow-up trigger: reviewer has at least one CHANGES_REQUESTED review
        // on the PR, AND the author has engaged with it at least once
        // since — either by pushing a commit OR by replying inline
        // on a review thread. A refutation reply ("FTL is internal,
        // everyone knows") is as much a "respond to this" signal as
        // a code change; the agent run that follows decides whether
        // it's convincing.
        //
        // Each subsequent author response (commit or reply) re-arms
        // the trigger — the dedupe key sums both counters, so every
        // increment produces a fresh seen-key. If the reviewer posts
        // another CHANGES_REQUESTED (latest_request_at advances),
        // both counters reset to 0 and a fresh round begins on the
        // next author response.
        let seenTarget = ''
        let firedReason = ''
        let expectedHead = ''
        if (check.hasChangeRequest) {
          if (check.responseCount < 1 || check.latestRequestAt === null) {
            checked = true
            return
          }
          const activity = await checkReviewActivity(
            pr.repo,
            pr.number,
            reviewer,
            check.latestRequestAt,
          )
          // An outdated thread is evidence to inspect, not a current-head veto.
          // The approval agent receives every thread in its immutable PR packet.
          if (activity.state !== 'OPEN'
            || activity.draft
            || activity.headSha !== check.headSha
            || activity.unresolvedLiveConversationAuthors.some(
              (author) => author.toLowerCase() !== reviewer.toLowerCase(),
            )) {
            checked = true
            return
          }
          expectedHead = check.headSha
          seenTarget = `${pr.repo}#${pr.number}@req=${check.latestRequestAt}/r=${check.responseCount}/head=${check.headSha}`
          firedReason = `req=${check.latestRequestAt}, r=${check.responseCount}: ${check.commitsAfterRequest}c+${check.authorInlineRepliesAfterRequest}reply, head=${check.headSha.slice(0, 8)}`
        } else {
          const review = latestApprovalBasisLaunch(pr.repo, pr.number)
          if (!review) {
            checked = true
            return
          }
          const activity = await checkReviewActivity(
            pr.repo,
            pr.number,
            reviewer,
            review.completedAt,
          )
          const reapprovalOwnsEveryUnresolvedConversation =
            activity.reviewerLatestState === 'APPROVED'
            && activity.reviewerLatestCommit !== null
            && activity.reviewerLatestCommit !== activity.headSha
            && activity.unresolvedConversationAuthors.length > 0
            && activity.unresolvedConversationAuthors.every(
              (author) => author.toLowerCase() === reviewer.toLowerCase(),
            )
          if (activity.state !== 'OPEN'
            || activity.draft
            || activity.activeChangeRequestAuthors.length > 0
            || (activity.unresolvedLiveConversationCount > 0
              && !reapprovalOwnsEveryUnresolvedConversation)
            || (activity.reviewerLatestState === 'APPROVED'
              && activity.reviewerLatestCommit === activity.headSha)) {
            checked = true
            return
          }
          if (activity.headSha !== review.headSha && activity.latestActivityAt === null) {
            throw new Error(`head changed without an activity watermark for ${pr.repo}#${pr.number}`)
          }
          expectedHead = activity.headSha
          seenTarget = `${pr.repo}#${pr.number}@head=${activity.headSha}`
          firedReason = `clean review ${review.callId.slice(0, 8)}, head=${activity.headSha.slice(0, 8)}`
        }
        if (!behaviorRetryDue('approve-prs', seenTarget)) return
        let claimId = claimSeenOwnedAs('approve-prs', seenTarget, operationId)
        if (!claimId) {
          const recovered = await releaseFailedBehaviorIfNoAction(
            'approve-prs',
            pr.repo,
            pr.number,
            seenTarget,
          )
          if (!recovered) return
          claimId = claimSeenOwnedAs('approve-prs', seenTarget, operationId)
        }
        if (!claimId) return
        trackClaim('approve-prs', seenTarget, claimId)
        try {
          const accepted = await fireApprove(pr, seenTarget, claimId, expectedHead)
          if (!accepted) {
            releaseOwnedClaim('approve-prs', seenTarget, claimId)
            return
          }
          launched = true
          checked = true
        } catch (err) {
          releaseOwnedClaim('approve-prs', seenTarget, claimId)
          throw err
        }
        console.log(`[behaviors] approve-prs fired for ${pr.repo}#${pr.number} (${firedReason})`)
      } catch (err) {
        checked = false
        if (behaviorAborted()) return
        console.error(`[behaviors] approve-prs check/fire failed for ${pr.repo}#${pr.number}:`, err)
        if (err instanceof BehaviorLogFeedError) failure ??= err
        else recordBehaviorFailure('approve-prs', 'operation', err, checkTarget)
      } finally {
        if (checked && !behaviorAborted()) clearBehaviorFailure('approve-prs', checkTarget)
        if (!launched && operationId) releasePrOperationOwned(operationId)
      }
    }))
    if (failure) throw failure
  } catch (err) {
    console.error('[behaviors] approve-prs tick failed:', err)
    throw err
  }
}

// ── resolve-unblocking implementation ──────────────────────────────────
//
// For each open PR by the configured user, ask github-interface to
// resolve any non-blocking review conversations IF the PR is otherwise
// green (approved + checks passing). This is the third in the trilogy
// — review-new-prs does the initial review, approve-prs handles the
// follow-up after the user addresses feedback, and this clears the
// "all conversations must be resolved" branch-protection gate so a
// human can step in and merge.
//
// Different shape from the first two:
//  * github-interface does the work directly — no agent-interface, no
//    spawn, no detached process. Synchronous CLI call per PR.
//  * The CLI is idempotent: when there's nothing to resolve it returns
//    resolved_count: 0 and changes nothing, so we don't need claimSeen
//    to gate fires. We simply call it every tick for every open PR
//    and record `last_fired` only when resolved_count > 0.

interface ResolveResult {
  ready_except_conversations: boolean
  headSha: string
  resolved_count: number
  unresolved_count: number
  blockers: string[]
  superseded: boolean
}

// Meta key holding the last real resolve-unblocking fire as JSON
// { at, target }. setMeta overwrites, so it always reflects the most
// recent resolve. Read back by the /api/behaviors handler.
const RESOLVE_LAST_FIRED_KEY = 'behavior_resolve_unblocking_last_fired'

// Last time resolve-unblocking actually resolved one or more
// conversations — null if it hasn't fired since persistence was
// added (the run history before that point was never recorded and
// can't be reconstructed). Shape matches the lastTriggered envelope
// the Behaviors view already consumes for the other two behaviors.
export function getResolveUnblockingLastFired(): { at: string, target: string } | null {
  if (behaviorOrganization.getStore() === undefined) {
    const events = readyOrganizations().map((org) => behaviorOrganization.run(org, getResolveUnblockingLastFired))
      .filter((event): event is { at: string, target: string } => event !== null)
    return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  }
  const raw = getMeta(RESOLVE_LAST_FIRED_KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)) && typeof p.target === 'string') {
      return { at: p.at, target: p.target }
    }
  } catch { /* corrupt value — treat as never-fired */ }
  return null
}

async function resolveNonblockingIfReady(repo: string, number: number): Promise<ResolveResult> {
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const reviewer = configuredReviewer()
  const expectedHead = await currentHeadSha(repo, number, reviewer)
  const { stdout } = await runFile(
    GH_INTERFACE,
    [
      '--resolve-nonblocking-conversations-if-ready',
      `#${number}`,
      '--username',
      reviewer,
      '--expected-head',
      expectedHead,
      '--token-user',
      reviewer,
    ],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = objectValue(
    parseJson(stdout, 'github-interface --resolve-nonblocking-conversations-if-ready'),
    'github-interface --resolve-nonblocking-conversations-if-ready',
  )
  const headSha = String(data.head_sha || '').toLowerCase()
  if (data.outcome === 'superseded') {
    const currentHeadSha = String(data.current_head_sha || '').toLowerCase()
    if (data.action !== 'resolved_nonblocking_conversations_if_ready'
      || data.repository !== repo
      || data.pull_number !== number
      || headSha !== expectedHead
      || !SHA_PATTERN.test(currentHeadSha)
      || currentHeadSha === expectedHead) {
      throw new Error('github-interface resolution returned malformed supersession')
    }
    return {
      ready_except_conversations: false,
      headSha: currentHeadSha,
      resolved_count: 0,
      unresolved_count: 0,
      blockers: [],
      superseded: true,
    }
  }
  const resolvedCount = safeInteger(data.resolved_count, 'resolve resolved_count')
  const unresolvedCount = safeInteger(data.unresolved_count, 'resolve unresolved_count')
  if (!Array.isArray(data.blockers)
    || data.blockers.some((value) => typeof value !== 'string')) {
    throw new Error('github-interface resolution returned malformed blockers')
  }
  if (data.action !== 'resolved_nonblocking_conversations_if_ready'
    || data.repository !== repo
    || data.pull_number !== number
    || headSha !== expectedHead
    || typeof data.ready_except_conversations !== 'boolean'
    || typeof data.reviewer_approved_current_head !== 'boolean'
    || typeof data.changes_requested !== 'boolean'
    || typeof data.statuses_green !== 'boolean'
    || typeof data.checks_green !== 'boolean'
    || typeof data.checks_present !== 'boolean'
    || !Array.isArray(data.conversations)
    || data.conversations.length !== resolvedCount
    || (resolvedCount > 0
      && (data.ready_except_conversations !== true
        || data.reviewer_approved_current_head !== true
        || data.changes_requested !== false
        || data.statuses_green !== true
        || data.checks_green !== true
        || data.checks_present !== true
        || unresolvedCount !== 0))) {
    throw new Error('github-interface resolution returned malformed or unsafe state')
  }
  return {
    ready_except_conversations: data.ready_except_conversations,
    headSha,
    resolved_count: resolvedCount,
    unresolved_count: unresolvedCount,
    blockers: data.blockers.map(String),
    superseded: false,
  }
}

async function tickResolveUnblocking(): Promise<void> {
  if (!isEnabled('resolve-unblocking')) return
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    await Promise.all(prs.map(async (pr) => {
      if (!isEnabled('resolve-unblocking') || behaviorAborted()) return
      const key = `${pr.repo}#${pr.number}`
      const checkTarget = `${key}:check`
      if (!behaviorRetryDue('resolve-unblocking', checkTarget)) return
      let checked = false
      let operationId: string | null = null
      try {
        // A read cannot resolve anything. Avoid occupying the mutation lock
        // when the PR has no unresolved conversations to act on.
        const activity = await checkReviewActivity(pr.repo, pr.number, configuredReviewer(), '1970-01-01T00:00:00Z')
        if (activity.state !== 'OPEN' || activity.draft || activity.unresolvedConversationCount === 0) {
          checked = true
          return
        }
        if (!isEnabled('resolve-unblocking') || behaviorAborted()) return
        operationId = claimPrOperationOwned(key, PR_OPERATION_EVALUATION_LEASE_MS)
        if (!operationId) return
        // This CLI performs the mutation itself. The synchronous flag check
        // immediately before invocation prevents a disabled behavior from
        // starting another resolve operation.
        if (!isEnabled('resolve-unblocking')) return
        const result = await resolveNonblockingIfReady(pr.repo, pr.number)
        checked = true
        if (result.superseded) {
          console.log(`[behaviors] resolve-unblocking superseded on ${pr.repo}#${pr.number} by head ${result.headSha}`)
        } else if (result.resolved_count > 0) {
          console.log(`[behaviors] resolve-unblocking cleared ${result.resolved_count} convo(s) on ${key}`)
          // github-interface doesn't write a log row for this call, so
          // unlike pr_review / pr_approve there's no agent-interface
          // surface to derive "last triggered" from. Persist it here:
          // a meta row that setMeta overwrites, so the Behaviors view
          // shows the most recent real resolve instead of a dash.
          setMeta(RESOLVE_LAST_FIRED_KEY, JSON.stringify({
            at: new Date().toISOString(),
            target: key,
          }))
        } else if (result.unresolved_count > 0) {
          console.log(
            `[behaviors] resolve-unblocking waiting on ${key}: ${result.blockers.join(', ')}`,
          )
        }
      } catch (err) {
        checked = false
        if (behaviorAborted()) return
        console.error(`[behaviors] resolve-unblocking failed for ${pr.repo}#${pr.number}:`, err)
        recordBehaviorFailure('resolve-unblocking', 'operation', err, checkTarget)
      } finally {
        if (checked && !behaviorAborted()) clearBehaviorFailure('resolve-unblocking', checkTarget)
        if (operationId) releasePrOperationOwned(operationId)
      }
    }))
  } catch (err) {
    console.error('[behaviors] resolve-unblocking tick failed:', err)
    throw err
  }
}

// ── review-new-issues implementation ────────────────────────────────────
//
// Opt-in per repository. A new issue in a selected repository, opened by a
// trusted author, gets an adversarial review from each reviewer of the Issue
// review place (Settings → Models) that Behaviors asks for. Caller runs every
// reviewer as its provider's own CLI with full access in a fresh checkout and
// posts the comments as the review agent, on the issue and its sub-issues.
//
// Each issue is reviewed once. A repository's backlog is never reviewed: an
// issue counts only when it was opened after its repository was selected, and
// an extra reviewer only for issues opened after the panel grew to include it.
// A sub-issue that its parent's review comments on gets no review of its own.

const ISSUES_KEY = 'review-new-issues' as const
export const ISSUE_REVIEW_SOURCE = 'poise:review-new-issues'
// Authors often add sub-issues and links right after opening an issue.
export const ISSUE_SETTLE_MS = 10 * 60_000
// Full-access reviewers build and run test suites on this machine.
export const MAX_ISSUE_REVIEW_RUNS = 3
// The first launch and one relaunch after a failure that posted nothing.
const ISSUE_REVIEW_ATTEMPTS = 2
// How long a claim may sit between being taken and its launch being recorded;
// a process that dies in between leaves the target free again after this.
const ISSUE_PRE_LAUNCH_LEASE_MS = 5 * 60_000
// Failures that are held for a person rather than relaunched: a time limit or
// failed recovery would repeat as expensively, a stop was the user's decision,
// and a run that began posting may already have commented.
const HELD_ISSUE_REVIEW_ERRORS = new Set([
  'review_budget_exhausted',
  'review_recovery_failed',
  'stopped',
  'review_packet_too_large',
  'posting_failed',
])
export const DEFAULT_ISSUE_AUTHORS = ['mikkokotila', 'zero-bang', 'bit-mis']
const MAX_ISSUE_AUTHORS = 20
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const ISSUE_REPOS_KEY = `${META_PREFIX}review_new_issues_repos`
const ISSUE_AUTHORS_KEY = `${META_PREFIX}review_new_issues_authors`
const ISSUE_SLOT_SINCE_KEY = `${META_PREFIX}review_new_issues_slot_since`

export interface IssueRepository {
  repo: string
  // When it was selected: only issues opened from then on are reviewed.
  since: string
}

function parseJsonMeta(key: string): unknown {
  const raw = getMeta(key)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function isValidRepository(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_PATTERN.test(value)
}

export function getIssueRepositories(): IssueRepository[] {
  const value = parseJsonMeta(ISSUE_REPOS_KEY)
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is IssueRepository =>
    !!entry && isValidRepository(entry.repo) && typeof entry.since === 'string' && Number.isFinite(Date.parse(entry.since)))
}

// A repository that stays selected keeps its date; a newly selected one starts
// now, so selecting it never reviews what was already open.
export function setIssueRepositories(repos: readonly string[]): IssueRepository[] {
  const current = new Map(getIssueRepositories().map((entry) => [entry.repo, entry.since]))
  const now = new Date().toISOString()
  const next = [...new Set(repos)].sort((a, b) => a.localeCompare(b))
    .map((repo) => ({ repo, since: current.get(repo) ?? now }))
  setMeta(ISSUE_REPOS_KEY, JSON.stringify(next))
  return next
}

export function isValidAuthorList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_ISSUE_AUTHORS
    && value.every((author) => typeof author === 'string' && GITHUB_USERNAME_PATTERN.test(author))
}

export function getIssueAuthors(): string[] {
  const value = parseJsonMeta(ISSUE_AUTHORS_KEY)
  return isValidAuthorList(value) ? value : [...DEFAULT_ISSUE_AUTHORS]
}

export function setIssueAuthors(authors: readonly string[]): string[] {
  const seen = new Set<string>()
  const next = authors.filter((author) => {
    const lower = author.toLowerCase()
    if (seen.has(lower)) return false
    seen.add(lower)
    return true
  })
  setMeta(ISSUE_AUTHORS_KEY, JSON.stringify(next))
  return next
}

// When each extra reviewer joined the panel. Raising the count gives the new
// reviewers a start date; lowering it forgets theirs.
function getIssueSlotSince(): Partial<Record<ReviewerSlot, string>> {
  const value = parseJsonMeta(ISSUE_SLOT_SINCE_KEY)
  const out: Partial<Record<ReviewerSlot, string>> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const slot of ['secondary', 'tertiary'] as const) {
      const since = (value as Record<string, unknown>)[slot]
      if (typeof since === 'string' && Number.isFinite(Date.parse(since))) out[slot] = since
    }
  }
  return out
}

function setIssueSlotSince(previous: ReviewerCount, next: ReviewerCount): void {
  const since = getIssueSlotSince()
  const now = new Date().toISOString()
  REVIEWER_SLOTS.forEach((slot, index) => {
    if (slot === 'primary') return
    if (index >= next) delete since[slot]
    else if (index >= previous) since[slot] = now
  })
  setMeta(ISSUE_SLOT_SINCE_KEY, JSON.stringify(since))
}

interface DatastoreIssue {
  repo: string
  number: number
  author: string
  createdAt: string
}

async function listOpenIssues(repo: string, since: string): Promise<DatastoreIssue[]> {
  const { stdout } = await runFile(
    DATASTORE,
    datastoreArgs(['view', 'issue', '--repo', repo, '--status', 'open', '--created-since-datetime', since, '--limit', '500', '--format', 'json']),
    { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024, signal: behaviorSignal() },
  )
  const parsed = parseJson(stdout, 'github-datastore view issue')
  if (!Array.isArray(parsed)) throw new Error('github-datastore view issue returned a non-array')
  return parsed.map((row, index) => {
    const value = objectValue(row, `github-datastore issue row ${index}`)
    const number = safeInteger(value.number, `github-datastore issue row ${index} number`)
    const author = String(value.author || '')
    const createdAt = String(value.created_at || '')
    if (value.repo !== repo
      || number < 1
      || value.status !== 'open'
      || !author
      || !Number.isFinite(Date.parse(createdAt))
      || value.url !== `https://github.com/${repo}/issues/${number}`) {
      throw new Error(`github-datastore issue row ${index} violates the candidate contract`)
    }
    return { repo, number, author, createdAt }
  })
}

// The issues this one makes its sub-issues, read the way Caller's review reads
// them: GitHub sub-issues and the links under its own Work Slices heading.
async function listSubIssues(repo: string, number: number): Promise<string[]> {
  const { stdout } = await runFile(
    GH_INTERFACE,
    ['--sub-issues', `#${number}`, '--repository', repo],
    { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = objectValue(parseJson(stdout, 'github-interface --sub-issues'), 'github-interface --sub-issues')
  if (data.action !== 'sub_issues'
    || String(data.repository || '').toLowerCase() !== repo.toLowerCase()
    || data.issue_number !== number
    || !Array.isArray(data.sub_issues)) {
    throw new Error(`github-interface --sub-issues returned a malformed result for ${repo}#${number}`)
  }
  // A link no issue can answer to, such as a `#0` placeholder, is no sub-issue:
  // the review cannot comment on it either.
  return data.sub_issues.flatMap((row) => {
    const value = row && typeof row === 'object' ? row as Record<string, unknown> : {}
    const repository = String(value.repository || '')
    const issue = value.issue_number
    return isValidRepository(repository) && Number.isSafeInteger(issue) && Number(issue) >= 1 && Number(issue) <= MAX_ISSUE_NUMBER
      ? [`${repository}#${issue}`]
      : []
  })
}

// Sub-issues are read a few at a time, inside the minute's budget. What
// failed last is kept so one broken issue is not reported every minute.
const SUB_ISSUE_READS_AT_ONCE = 4
const subIssueReadErrors = new Map<string, string>()

// The sub-issues of each issue that could be read. An issue whose read fails
// covers nothing and waits on its own retry timer; other issues keep running.
async function readSubIssues(entries: readonly EligibleIssue[]): Promise<Map<string, string[]>> {
  const subIssues = new Map<string, string[]>()
  let next = 0
  const reader = async () => {
    while (next < entries.length) {
      const { issue } = entries[next++]
      const ref = issueRef(`${issue.repo}#${issue.number}`)
      const checkTarget = `${issue.repo}#${issue.number}:sub-issues`
      if (!behaviorRetryDue(ISSUES_KEY, checkTarget)) continue
      try {
        subIssues.set(ref, await listSubIssues(issue.repo, issue.number))
        subIssueReadErrors.delete(ref)
        clearBehaviorFailure(ISSUES_KEY, checkTarget)
      } catch (error) {
        if (behaviorAborted()) throw error
        recordBehaviorFailure(ISSUES_KEY, 'operation', error, checkTarget)
        const message = error instanceof Error ? error.message : String(error)
        if (subIssueReadErrors.get(ref) !== message) {
          console.error(`[behaviors] review-new-issues cannot read the sub-issues of ${issue.repo}#${issue.number}: ${message}`)
        }
        subIssueReadErrors.set(ref, message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SUB_ISSUE_READS_AT_ONCE, entries.length) }, reader))
  return subIssues
}

// The largest issue number a launch record keeps.
const MAX_ISSUE_NUMBER = 9_999_999_999

// GitHub treats repository names case-insensitively.
function issueRef(issue: string): string {
  return issue.toLowerCase()
}

// Which of the issues whose review is still to come get a review of their
// own. `refs` lists them, oldest first. An issue that one of them makes
// its sub-issue is covered by that one's review. A sub-issue of a covered
// issue is not, since a review reaches only its own issue's sub-issues. In a
// loop of sub-issues the oldest issue is reviewed on its own.
export function reviewRoots(
  refs: readonly string[],
  subIssues: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const order = [...new Set(refs)]
  const members = new Set(order)
  const parents = new Map<string, string[]>()
  for (const parent of order) {
    for (const child of subIssues.get(parent) ?? []) {
      const ref = issueRef(child)
      if (ref === parent || !members.has(ref)) continue
      parents.set(ref, [...(parents.get(ref) ?? []), parent])
    }
  }
  const roots = new Set<string>()
  const covered = new Set<string>()
  while (roots.size + covered.size < order.length) {
    let decided = false
    for (const ref of order) {
      if (roots.has(ref) || covered.has(ref)) continue
      const of = parents.get(ref) ?? []
      if (of.some((parent) => roots.has(parent))) {
        covered.add(ref)
        decided = true
      } else if (of.every((parent) => covered.has(parent))) {
        roots.add(ref)
        decided = true
      }
    }
    if (!decided) roots.add(order.find((ref) => !roots.has(ref) && !covered.has(ref))!)
  }
  return roots
}

interface IssueCandidate {
  issue: DatastoreIssue
  slot: ReviewerSlot
  target: string
  order: number
}

interface EligibleIssue {
  issue: DatastoreIssue
  // Its reviewer targets, one per slot the panel gives it.
  targets: string[]
}

interface IssueReviewPlan {
  // The issues to launch now, each with the sub-issues its review covers.
  launch: Map<string, string[]>
  // Issues another review has already commented on, and which review.
  reviewed: Array<{ ref: string, by: string }>
}

// A sub-issue is reviewed once. A review comments on its issue and on that
// issue's sub-issues, so an issue that another review covers gets no review of
// its own. It waits while that review is still to come or running, and is
// settled once the review has commented on it. An issue that became a
// sub-issue only after its parent's review began, or that the review left
// without a comment, is reviewed on its own.
async function planIssueReviews(
  candidates: readonly IssueCandidate[],
  eligible: readonly EligibleIssue[],
  logs: () => Promise<AgentLogSnapshot>,
): Promise<IssueReviewPlan> {
  const plan: IssueReviewPlan = { launch: new Map(), reviewed: [] }
  const due = [...new Set(candidates.map(({ issue }) => issueRef(`${issue.repo}#${issue.number}`)))]
  if (due.length === 0) return plan

  const snapshot = await logs()
  const uncertainRefs = new Set<string>()
  const quarantinedClaims = quarantinedIssueReviews()
  for (const claim of quarantinedClaims) {
    // Absence is not a new running signal; only identified conflicting rows are.
    if (!claim.launchQuarantineMayRun && quarantineEvidence(snapshot, claim).hasLiveEvidence) {
      if (claim.claimId) quarantineClaim(claim, claim.launchQuarantine!, claim.launchError || 'agent result remains held', claim.launchCallId, true)
      else quarantineFailedClaim(claim, claim.launchQuarantine!, claim.launchError || 'agent result remains held', true)
    }

    uncertainRefs.add(issueRef(`${claim.launchRepo}#${claim.launchPr}`))
    for (const ref of claim.launchCovers) uncertainRefs.add(issueRef(ref))
  }
  for (const row of snapshot.quarantined) {
    // A review may comment across repositories. Only its durable launch
    // coverage bounds that uncertainty; its own repository alone cannot.
    // A valid duplicate may expose the correlation before reconciliation
    // can link its call ID. Include that identity without accepting its result.
    const identities = [row, ...snapshot.entries
      .filter((call) => (row.id && call.id === row.id)
        || (row.correlationId && call.correlation_id === row.correlationId))
      .map((call) => ({ id: call.id, correlationId: call.correlation_id }))]
    const launches = identities.flatMap((identity) => db.prepare(`
      SELECT launch_repo AS repo, launch_pr AS number, launch_covers AS covers
      FROM behavior_seen WHERE launch_behavior = 'issue_review'
        AND ((? IS NOT NULL AND launch_call_id = ?) OR (? IS NOT NULL AND launch_correlation_id = ?))
    `).all(identity.id, identity.id, identity.correlationId, identity.correlationId) as Array<{ repo: string, number: number, covers: string | null }>)
    if (launches.length === 0) {
      if (!quarantinedLogMayMatch(row, { behavior: ISSUE_REVIEW_BEHAVIOR })) continue
      throw new Error(`Issue review coverage is uncertain: ${row.error}`)
    }
    for (const launch of launches) {
      uncertainRefs.add(issueRef(`${launch.repo}#${launch.number}`))
      let covers: unknown
      try { covers = JSON.parse(launch.covers || '[]') } catch {
        throw new Error(`Issue review coverage is invalid for ${launch.repo}#${launch.number}`)
      }
      if (!Array.isArray(covers) || covers.some((ref) => typeof ref !== 'string')) {
        throw new Error(`Issue review coverage is invalid for ${launch.repo}#${launch.number}`)
      }
      for (const ref of covers as string[]) uncertainRefs.add(issueRef(ref))
    }
  }
  // What reviews have commented on besides their own issue.
  const commentedBy = new Map<string, string>()
  for (const call of snapshot.entries) {
    if (quarantinedClaims.some((claim) => claim.launchCallId === call.id
      || claim.launchCorrelationId === call.correlation_id)) continue
    if (logQuarantine(snapshot, { id: call.id, correlationId: call.correlation_id }, true)) continue
    if (call.behavior !== ISSUE_REVIEW_BEHAVIOR || !call.receipts) continue
    const reviewed = `${call.repo}#${call.pr_id}`
    for (const receipt of call.receipts) {
      if (issueRef(receipt.issue) !== issueRef(reviewed)) commentedBy.set(issueRef(receipt.issue), reviewed)
    }
  }
  // What running reviews will comment on besides their own issue.
  const runningFor = new Map<string, string>()
  for (const claim of listBehaviorLaunchClaims(ISSUES_KEY)) {
    const reviewed = `${claim.launchRepo}#${claim.launchPr}`
    for (const covered of claim.launchCovers) {
      if (issueRef(covered) !== issueRef(reviewed)) runningFor.set(issueRef(covered), reviewed)
    }
  }
  for (const ref of due) {
    const by = commentedBy.get(ref)
    if (by && !uncertainRefs.has(ref)) plan.reviewed.push({ ref, by })
  }

  // Every issue whose own review is still to come, settled or not, may cover
  // a due one; the roots among them are reviewed.
  const pending: EligibleIssue[] = []
  const pendingRefs = new Set<string>()
  for (const entry of eligible) {
    const ref = issueRef(`${entry.issue.repo}#${entry.issue.number}`)
    if (uncertainRefs.has(ref) || commentedBy.has(ref) || runningFor.has(ref)) continue
    for (const target of entry.targets) {
      if (await issueTargetLaunchable(target, logs)) {
        pending.push(entry)
        pendingRefs.add(ref)
        break
      }
    }
  }
  // A due issue held after a failure launches nothing, and while every
  // reviewer is busy nothing can launch: neither asks anything of GitHub.
  const open = due.filter((ref) => pendingRefs.has(ref))
  if (open.length === 0 || runningIssueReviewCount() >= MAX_ISSUE_REVIEW_RUNS) return plan
  pending.sort((a, b) => Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)
    || a.issue.repo.localeCompare(b.issue.repo)
    || a.issue.number - b.issue.number)
  const subIssues = await readSubIssues(pending)
  const readable = pending
    .map(({ issue }) => issueRef(`${issue.repo}#${issue.number}`))
    .filter((ref) => subIssues.has(ref))
  const roots = reviewRoots(readable, subIssues)
  for (const ref of open) {
    if (roots.has(ref)) plan.launch.set(ref, subIssues.get(ref) ?? [])
  }
  return plan
}

async function issueSlotModel(slot: ReviewerSlot): Promise<{ model: string, recovery: string, catalog: Catalog } | null> {
  const panel = await reviewPanel(getReviewers(ISSUES_KEY), 'issue_review')
  const reviewer = panel.reviewers.find((entry) => entry.slot === slot)
  return reviewer ? { model: reviewer.model, recovery: panel.recovery, catalog: panel.catalog } : null
}

async function fireIssueReview(
  issue: DatastoreIssue,
  target: string,
  claimId: string,
  slot: ReviewerSlot,
  covers: readonly string[],
): Promise<boolean> {
  if (!isEnabled(ISSUES_KEY)) return false
  const resolved = await waitForBehavior(issueSlotModel(slot))
  if (!resolved) return false
  const { model, recovery, catalog } = resolved
  const claude = needsClaude(catalog, model)
  const actor = configuredReviewer()
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  await waitForBehavior(prepareModelClis(catalog, [model, recovery]))
  // The CLI check and the model read can each take a while; turning the
  // behavior off, deselecting the repository or changing the panel meanwhile
  // must stop this launch, so these are the last checks before it.
  if ((await waitForBehavior(issueSlotModel(slot)))?.model !== model) return false
  if (!isEnabled(ISSUES_KEY) || behaviorAborted()) return false
  if (!getIssueRepositories().some((entry) => entry.repo === issue.repo)) return false
  if (!markBehaviorLaunchIntentOwned({
    key: ISSUES_KEY,
    target,
    claimId,
    launchBehavior: 'issue_review',
    repo: issue.repo,
    pr: issue.number,
    requestedAt: new Date().toISOString(),
    expectedHead: '',
    actor,
    source: ISSUE_REVIEW_SOURCE,
    correlationId: claimId,
    covers,
  })) return false
  await spawnDetached(AGENT_INTERFACE, [
    '--issue-review',
    `${issue.repo}#${issue.number}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--source',
    ISSUE_REVIEW_SOURCE,
    '--correlation-id',
    claimId,
    ...noteArgs(ISSUES_KEY),
  ], {
    cwd: agentInterfaceCwd(),
    env: claudeSubscriptionEnvironment(),
    onExit: settleClaimAfterExit(ISSUES_KEY, target, claimId),
  })
  markClaimLaunched(claimId)
  return true
}

// A failed reviewer runs again only when it provably posted nothing, the
// failure is not one held for a person, and it has not already had its retry.
// `logs` is shared by the whole scan: a held reviewer is looked at every
// tick, and each read of the agent log is a subprocess.
async function releasableIssueReviewFailure(
  target: string,
  logs: () => Promise<AgentLogSnapshot>,
): Promise<BehaviorLaunchClaim | null> {
  const failed = getFailedBehaviorLaunch(ISSUES_KEY, target)
  if (!failed?.launchCallId
    || failed.launchQuarantine
    || failed.launchBehavior !== 'issue_review'
    || failed.launchSource !== ISSUE_REVIEW_SOURCE
    || countBehaviorDeadLetters(ISSUES_KEY, target) >= ISSUE_REVIEW_ATTEMPTS) return null
  const snapshot = await logs()
  if (quarantineFailedLog(snapshot, failed)) return null
  const call = snapshot.entries.find((row) => row.id === failed.launchCallId)
  if (!call
    || !FAILED_AGENT_STATUSES.has(call.status.toLowerCase())
    || call.behavior !== ISSUE_REVIEW_BEHAVIOR
    || call.correlation_id !== failed.launchCorrelationId
    || (call.receipts !== null && call.receipts !== undefined)
    || HELD_ISSUE_REVIEW_ERRORS.has(call.error_code || '')) return null
  return failed
}

// Whether a reviewer's launch is still to come: never claimed, claimed by a
// process that died before launching, or failed in a way that runs once more.
async function issueTargetLaunchable(target: string, logs: () => Promise<AgentLogSnapshot>): Promise<boolean> {
  if (!hasSeen(ISSUES_KEY, target)) return countBehaviorDeadLetters(ISSUES_KEY, target) < ISSUE_REVIEW_ATTEMPTS
  if (hasExpiredPreLaunchClaim(ISSUES_KEY, target)) return true
  return !!await releasableIssueReviewFailure(target, logs)
}

async function releaseFailedIssueReviewIfSafe(target: string, logs: () => Promise<AgentLogSnapshot>): Promise<boolean> {
  const failed = await releasableIssueReviewFailure(target, logs)
  if (!failed?.launchCallId) return false
  const released = releaseFailedBehaviorLaunch(ISSUES_KEY, target, failed.launchCallId, failed.launchExpectedHead)
  if (released) console.log(`[behaviors] review-new-issues relaunching ${target} after a failure that posted nothing`)
  return released
}

async function launchIssueReview(
  issue: DatastoreIssue,
  slot: ReviewerSlot,
  target: string,
  logs: () => Promise<AgentLogSnapshot>,
  covers: readonly string[],
): Promise<boolean> {
  if (!behaviorRetryDue(ISSUES_KEY, target)) return false
  if (countBehaviorDeadLetters(ISSUES_KEY, target) >= ISSUE_REVIEW_ATTEMPTS && !hasSeen(ISSUES_KEY, target)) return false
  let claimId = claimSeenOwned(ISSUES_KEY, target, ISSUE_PRE_LAUNCH_LEASE_MS)
  if (!claimId) {
    if (!await releaseFailedIssueReviewIfSafe(target, logs)) return false
    claimId = claimSeenOwned(ISSUES_KEY, target, ISSUE_PRE_LAUNCH_LEASE_MS)
    if (!claimId) return false
  }
  trackClaim(ISSUES_KEY, target, claimId)
  try {
    if (!await fireIssueReview(issue, target, claimId, slot, covers)) {
      releaseOwnedClaim(ISSUES_KEY, target, claimId)
      return false
    }
  } catch (error) {
    releaseOwnedClaim(ISSUES_KEY, target, claimId)
    throw error
  }
  console.log(`[behaviors] review-new-issues fired for ${issue.repo}#${issue.number} (${slot})`)
  return true
}

async function tickReviewNewIssues(): Promise<void> {
  if (!isEnabled(ISSUES_KEY)) return
  const repositories = getIssueRepositories().filter((entry) => organizationOwns(entry.repo))
  if (repositories.length === 0) return
  const authors = new Set(getIssueAuthors().map((author) => author.toLowerCase()))
  const slots = availableReviewSlots(await reviewPanel(getReviewers(ISSUES_KEY), 'issue_review'))
  if (slots.length === 0) return
  const slotSince = getIssueSlotSince()
  await requireFreshDatastore()
  const open = new Set<string>()
  const eligible: EligibleIssue[] = []
  const candidates: IssueCandidate[] = []
  const now = Date.now()
  const unreadRepositories = new Set<string>()
  for (const { repo, since } of repositories) {
    const scanTarget = `${repo}:scan`
    if (!behaviorRetryDue(ISSUES_KEY, scanTarget)) {
      unreadRepositories.add(repo)
      continue
    }
    let issues: DatastoreIssue[]
    try {
      issues = await listOpenIssues(repo, since)
      clearBehaviorFailure(ISSUES_KEY, scanTarget)
    } catch (error) {
      if (behaviorAborted()) return
      unreadRepositories.add(repo)
      console.error(`[behaviors] review-new-issues cannot list ${repo}:`, error)
      recordBehaviorFailure(ISSUES_KEY, 'operation', error, scanTarget)
      continue
    }
    for (const issue of issues) {
      const key = `${issue.repo}#${issue.number}`
      open.add(key)
      const created = Date.parse(issue.createdAt)
      if (!authors.has(issue.author.toLowerCase()) || created < Date.parse(since)) continue
      const targets: string[] = []
      slots.forEach((slot, index) => {
        const joined = slot === 'primary' ? undefined : slotSince[slot]
        if (joined && created < Date.parse(joined)) return
        const target = reviewSlotTarget(key, slot)
        targets.push(target)
        if (now - created < ISSUE_SETTLE_MS) return
        if (hasSeen(ISSUES_KEY, target)
          && !getFailedBehaviorLaunch(ISSUES_KEY, target)
          && !hasExpiredPreLaunchClaim(ISSUES_KEY, target)) return
        candidates.push({ issue, slot, target, order: created * REVIEWER_SLOTS.length + index })
      })
      if (targets.length > 0) eligible.push({ issue, targets })
    }
  }
  // An unread repository is unknown, not empty: preserve its incidents.
  retireBehaviorDeadLettersForClosedPrs(open, [ISSUES_KEY], currentOrganization()?.login, unreadRepositories)
  retireClosedTargetFailures(open, [ISSUES_KEY], unreadRepositories)
  candidates.sort((a, b) => a.order - b.order)
  let logs: Promise<AgentLogSnapshot> | null = null
  const readLogs = () => (logs ??= readBehaviorLogSnapshot())
  const plan = await planIssueReviews(candidates, eligible, readLogs)
  for (const { ref, by } of plan.reviewed) {
    let settled: string | null = null
    for (const { issue, target } of candidates) {
      if (issueRef(`${issue.repo}#${issue.number}`) !== ref) continue
      // Exact parent receipts settle both launch and eligibility diagnostics.
      clearBehaviorFailure(ISSUES_KEY, `${target}:check`)
      clearBehaviorFailure(ISSUES_KEY, `${issue.repo}#${issue.number}:sub-issues`)
      // Its own review failing earlier is no longer an incident: it was reviewed.
      if (retireBehaviorDeadLettersForTarget(ISSUES_KEY, target) > 0) {
        clearBehaviorFailure(ISSUES_KEY, target)
        settled = `${issue.repo}#${issue.number}`
      }
      // A claim whose process died before launching gives way to the marker.
      if (hasExpiredPreLaunchClaim(ISSUES_KEY, target)) releaseSeen(ISSUES_KEY, target)
      if (hasSeen(ISSUES_KEY, target)) continue
      recordSeen(ISSUES_KEY, target)
      settled = `${issue.repo}#${issue.number}`
    }
    if (settled) console.log(`[behaviors] review-new-issues: ${settled} was reviewed as a sub-issue of ${by}`)
  }
  for (const { issue, slot, target } of candidates) {
    if (!isEnabled(ISSUES_KEY) || behaviorAborted()) return
    const covers = plan.launch.get(issueRef(`${issue.repo}#${issue.number}`))
    if (!covers) continue
    if (runningIssueReviewCount() >= MAX_ISSUE_REVIEW_RUNS) break
    const checkTarget = `${target}:check`
    if (!behaviorRetryDue(ISSUES_KEY, checkTarget)) continue
    try {
      if (await launchIssueReview(issue, slot, target, readLogs, covers)) {
        clearBehaviorFailure(ISSUES_KEY, checkTarget)
      }
    } catch (error) {
      if (behaviorAborted()) return
      console.error(`[behaviors] review-new-issues step failed for ${target}:`, error)
      if (error instanceof BehaviorLogFeedError) throw error
      recordBehaviorFailure(ISSUES_KEY, 'operation', error, checkTarget)
    }
  }
}

async function reconcileIssueReviewClaims(): Promise<void> {
  const claims = listBehaviorLaunchClaims(ISSUES_KEY).filter((claim) => {
    if (claim.launchQuarantine !== 'invalid_result') return true
    retainClaimSafely(claim, claim.launchError || 'invalid agent result remains held')
    return false
  })
  const deadLetters = listBehaviorDeadLetters(500).filter(
    (letter) => letter.behavior === ISSUES_KEY && letter.callId !== null
      && !quarantineBlocksLogCorrection(letter.behavior, letter.target),
  )
  const failedClaims = failedBehaviorLaunches(ISSUES_KEY).filter((claim) => claim.launchQuarantine !== 'invalid_result')
  if (claims.length === 0 && deadLetters.length === 0 && failedClaims.length === 0) return

  let snapshot: AgentLogSnapshot
  try {
    snapshot = await readBehaviorLogSnapshot()
  } catch (error) {
    const message = `agent log reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`
    for (const claim of claims) quarantineClaim(claim, 'unreadable', message)
    for (const failed of failedClaims) quarantineFailedClaim(failed, 'unreadable', message)
    throw error
  }
  const logs = snapshot.entries
  for (const failed of failedClaims) {
    const call = logs.find((row) => row.id === failed.launchCallId)
    if (!quarantineFailedLog(snapshot, failed, call)) restoreReadableFailedClaim(failed, call, snapshot)
  }
  const catalogForCalls: Catalog | null = await loadCatalog().catch(() => null)
  const commented = (call: LogEntry | undefined) => call?.status.toLowerCase() === 'completed'
    && call.behavior === ISSUE_REVIEW_BEHAVIOR
    && call.action === 'commented'
    && call.outcome === 'commented'
    && Number.isFinite(Date.parse(String(call.completed_at || '')))

  // A dead letter whose exact call finished after all was a false alarm.
  let recoveredDeadLetter = false
  for (const letter of deadLetters) {
    const call = logs.find((row) => row.status.toLowerCase() === 'completed'
      && (row.id === letter.callId || (!!letter.correlationId && row.correlation_id === letter.correlationId)))
      ?? logs.find((row) => row.id === letter.callId)
    const failed = getFailedBehaviorLaunch(letter.behavior, letter.target)
    if (failed?.launchCallId === letter.callId && failed.launchCorrelationId === letter.correlationId
      && quarantineFailedLog(snapshot, failed, call)) continue
    if (call?.status.toLowerCase() === 'completed' && failed?.launchCallId === letter.callId
      && failed.launchCorrelationId === letter.correlationId
      && !clearCompletedUnreadableHold(failed, call, snapshot)) continue
    if (commented(call)
      && !logQuarantine(snapshot, { id: call!.id, correlationId: call!.correlation_id }, true)
      && call!.repo === letter.repo
      && String(call!.pr_id || '') === String(letter.pr)
      && call!.correlation_id === letter.correlationId) {
      if (retireBehaviorDeadLetter(letter.id)) {
        clearBehaviorFailure(ISSUES_KEY, letter.target)
        recoveredDeadLetter = true
      }
    }
  }
  if (recoveredDeadLetter && !listBehaviorDeadLetters(500).some((letter) => letter.behavior === ISSUES_KEY)) {
    clearBehaviorFailure(ISSUES_KEY)
  }

  for (const claim of claims) {
    if (claim.launchBehavior !== 'issue_review'
      || !claim.launchRepo
      || !Number.isSafeInteger(claim.launchPr)
      || claim.launchPr <= 0
      || claim.launchExpectedHead !== ''
      || !GITHUB_USERNAME_PATTERN.test(claim.launchActor)
      || claim.launchSource !== ISSUE_REVIEW_SOURCE
      || claim.launchCorrelationId !== claim.claimId
      || (claim.launchCallId !== null && !/^[0-9a-f]{32}$/.test(claim.launchCallId))) {
      deadLetterClaim(claim, 'launch correlation metadata is invalid; retained to prevent duplicate launch')
      continue
    }
    const requestedAtMs = Date.parse(claim.launchRequestedAt)
    if (!Number.isFinite(requestedAtMs)) {
      deadLetterClaim(claim, 'launch watermark is invalid; retained to prevent duplicate launch')
      continue
    }
    const candidates = logs.filter((row) => row.correlation_id === claim.launchCorrelationId)
    let call = claim.launchCallId
      ? candidates.find((row) => row.id.toLowerCase() === claim.launchCallId)
      : undefined
    const observed = call ?? (candidates.length === 1 ? candidates[0] : undefined)
    const quarantine = logQuarantine(snapshot, {
      ...claimLogIdentity(claim), id: claim.launchCallId ?? observed?.id ?? null,
    }, observed !== undefined)
    const ambiguousCompletion = claim.launchQuarantine === 'unreadable'
      ? logs.find((row) => row.status.toLowerCase() === 'completed'
        && (row.correlation_id === claim.launchCorrelationId || row.id === claim.launchCallId)
        && (!unambiguousAgentCall(snapshot, row)
          || (!!claim.launchCallId && row.id !== claim.launchCallId)
          || row.correlation_id !== claim.launchCorrelationId))
      : undefined
    if (ambiguousCompletion) {
      quarantineClaim(claim, 'invalid_result',
        'completed agent evidence conflicts with another record for the same launch',
        claim.launchCallId ?? ambiguousCompletion.id, quarantineEvidence(snapshot, claim, ambiguousCompletion).mayRun)
      continue
    }
    if (quarantine) {
      const evidence = quarantineEvidence(snapshot, claim, observed)
      quarantineClaim(claim, evidence.terminal ? 'invalid_result' : 'unreadable',
        `agent log row quarantined: ${evidence.terminal?.error || quarantine.error}`,
        claim.launchCallId ?? observed?.id ?? evidence.terminal?.id ?? null, evidence.mayRun)
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && !observed) {
      retainClaimSafely(claim, claim.launchError || 'agent evidence remains unreadable')
      continue
    }
    if (!call) {
      if (claim.launchCallId) {
        if (Date.now() - requestedAtMs < BEHAVIOR_CLAIM_RENEWAL_MS) {
          retainClaimSafely(claim, 'awaiting linked agent call visibility')
        } else {
          deadLetterClaim(claim, 'linked agent call remained missing for the full launch lease; retained to prevent duplicate launch')
        }
        continue
      }
      if (candidates.length > 1) {
        deadLetterClaim(claim, `ambiguous correlation id matched ${candidates.length} agent calls; retained to prevent duplicate launch`)
        continue
      }
      if (candidates.length === 0) {
        if (Date.now() - requestedAtMs < BEHAVIOR_REGISTRATION_GRACE_MS) {
          retainClaimSafely(claim, 'awaiting agent call registration')
        } else if (activeClaims.get(claim.claimId)?.launched) {
          // The worker has not exited — a machine that slept can delay its
          // registration past the grace. Launching another now could post twice.
          retainClaimSafely(claim, 'worker still running; awaiting agent call registration')
        } else {
          // Nothing ran, so nothing was posted; the next scan may launch it
          // again, once.
          recordBehaviorDeadLetter(claim, 'agent call did not register before the launch deadline')
          if (releaseOwnedClaim(ISSUES_KEY, claim.target, claim.claimId)) {
            recordBehaviorFailure(ISSUES_KEY, 'worker', 'agent call did not register before the launch deadline', claim.target)
          }
        }
        continue
      }
      call = candidates[0]
      if (!linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, call.id)) continue
      claim.launchCallId = call.id
    }

    const startedAtMs = Date.parse(agentCallStartedAt(call))
    if (call.behavior !== ISSUE_REVIEW_BEHAVIOR
      || call.repo !== claim.launchRepo
      || String(call.pr_id || '') !== String(claim.launchPr)
      || String(call.actor || '').toLowerCase() !== claim.launchActor.toLowerCase()
      || call.source !== claim.launchSource
      || call.correlation_id !== claim.launchCorrelationId
      || !Number.isFinite(startedAtMs)
      || startedAtMs < requestedAtMs) {
      quarantineClaim(claim, terminalAgentStatus(call.status) ? 'invalid_result' : 'unreadable',
        'linked agent call does not match the persisted launch contract; retained to prevent duplicate launch', call.id,
        quarantineEvidence(snapshot, claim, call).mayRun)
      continue
    }

    const status = call.status.toLowerCase()
    if (status === 'invalid' || call.error_code === 'invalid_agent_result') {
      quarantineClaim(claim, 'invalid_result', call.error || 'agent result is invalid', call.id,
        quarantineEvidence(snapshot, claim, call).mayRun)
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && !unambiguousAgentCall(snapshot, call)) {
      retainClaimSafely(claim, claim.launchError || 'agent evidence remains ambiguous')
      continue
    }
    if (claim.launchQuarantine === 'unreadable' && status !== 'completed') {
      const recognized = RUNNING_AGENT_STATUSES.has(status) || FAILED_AGENT_STATUSES.has(status) || status === 'superseded'
      if (!recognized || !restoreReadableClaim(claim, call, snapshot)) {
        retainClaimSafely(claim, claim.launchError || 'agent evidence remains unreadable')
        continue
      }
    }
    if (status === 'completed') {
      if (!commented(call)) {
        const error = 'completed agent call is missing its commented outcome'
        quarantineClaim(claim, 'invalid_result', error, call.id, quarantineEvidence(snapshot, claim, call).mayRun)
        continue
      }
      activeClaims.delete(claim.claimId)
      if (completeIssueReviewLaunchOwned({
        key: claim.key,
        target: claim.target,
        claimId: claim.claimId,
        completedAt: String(call.completed_at),
      })) {
        if (claim.launchQuarantine === 'unreadable') retireQuarantineIncident(claim)
        clearBehaviorFailure(ISSUES_KEY, claim.target)
      }
      continue
    }
    if (FAILED_AGENT_STATUSES.has(status)) {
      const message = call.error || `agent call terminated with status ${status}`
      if (deadLetterClaim(claim, message)) {
        const posted = call.receipts !== null && call.receipts !== undefined
        if (call.error_code !== 'stopped' && (posted || !HELD_ISSUE_REVIEW_ERRORS.has(call.error_code || ''))) {
          recordBehaviorFailure(ISSUES_KEY, 'worker', message, claim.target)
        }
        if (call.error_code !== 'stopped' && needsClaude(catalogForCalls, call.model)) claudeAuth.observeProcessFailure(message)
      }
      continue
    }
    if (RUNNING_AGENT_STATUSES.has(status)) {
      if (Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
        const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
        if (deadLetterClaim(claim, message)) recordBehaviorFailure(ISSUES_KEY, 'worker', message, claim.target)
        continue
      }
      setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, null)
      renewSeenOwned(claim.key, claim.target, claim.claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
      continue
    }
    const message = `unrecognized agent call status "${status || 'missing'}"`
    if (deadLetterClaim(claim, message)) recordBehaviorFailure(ISSUES_KEY, 'worker', message, claim.target)
  }
}

// ── Public API ──────────────────────────────────────────────────────────

const enabledChanges = new Map<BehaviorKey, number>()

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  const lifecycle = behaviorAbortController?.signal
  const change = (enabledChanges.get(key) ?? 0) + 1
  enabledChanges.set(key, change)
  // Publish globally before waiting: every account's in-flight tick must see
  // disable at its next launch gate. A queued enable never republishes its
  // stale value after a newer settings request.
  setPersistedEnabled(key, enabled)
  if (enabled && key === 'review-new-prs') prepareInitialReviewBaselines()
  const organizations = enabled ? readyOrganizations() : getOrganizations()
  const pending = [...behaviorOperationTails.entries()]
    .filter(([scope]) => scope.endsWith(`:${key}`)).map(([, tail]) => tail)
  const updates = organizations.map((org) => behaviorOrganization.run(org, async () => {
    if (!enabled) clearBehaviorFailure(key)
    try {
      await serializeBehaviorOperation(key, async () => {
        await withBehaviorProcessLock(key, async () => {
          if (enabledChanges.get(key) !== change) return
          if (enabled && !isEnabled(key)) return
          if (key === 'review-new-prs' && enabled) {
            // Re-enabling resumes the completed ledger, including work opened
            // during the pause. Only a missing baseline needs initialization.
            migrateReviewNewPrsLedger()
            await initializeReviewBaseline()
            await reconcileBehaviorLaunchClaims(key)
          } else if (key === 'approve-prs') {
            if (enabled) await reconcileBehaviorLaunchClaims(key)
            else clearSeenExceptLaunched(key, org.login)
          } else if (key === 'review-new-issues' && enabled) {
            await reconcileIssueReviewClaims()
          }
        })
      })
    } catch (error) {
      if (lifecycle?.aborted === true || error instanceof BehaviorProcessLockContentionError || !enabled) throw error
      if (!isEnabled(key)) return
      recordBehaviorFailure(key, 'operation', error)
      console.error(`[behaviors] ${org.login} ${key} enable reconciliation failed:`, error)
    }
  }))
  // Include removed accounts' existing work too. Disable is acknowledged only
  // once every operation that could have observed the old flag has settled.
  const results = await Promise.allSettled([...pending, ...updates])
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

export function setSetting(key: BehaviorKey, setting: BehaviorSetting): void {
  setPersistedSetting(key, setting)
}

// Wall-clock-aligned ticker — mirrors src/config.ts startRefreshTicker.
// Fixed 60 s cadence here; the per-user UI refresh-rate (1m / 5m) is
// browser-only and not relevant to behavior cadence.
let tickerStarted = false
let tickTimer: ReturnType<typeof setTimeout> | null = null
let runtimeGeneration = 0
export const BEHAVIOR_TICK_MS = 60_000

export const BEHAVIOR_OPERATION_TIMEOUT_MS = 55_000
const BEHAVIOR_HEALTH_GRACE_MS = 5_000
let runtimeStartedAtMs: number | null = null
let lastTickAtMs: number | null = null
let lastTickCompletedAtMs: number | null = null

// Startup snapshots, enable snapshots, and ticks must not overtake each
// other. The database marker covers multiple processes; this tail also avoids
// needless duplicate CLI work inside one process.
const behaviorOperationTails = new Map<string, Promise<void>>()
const behaviorOperationStartedAt = new Map<string, number>()

function serializeBehaviorOperation<T>(
  key: BehaviorKey,
  operation: () => Promise<T>,
): Promise<T> {
  const scopeKey = operationKey(key)
  const releaseOperation = trackReleaseBackground()
  const previous = behaviorOperationTails.get(scopeKey) || Promise.resolve()
  const execute = async () => {
    const startedAt = Date.now()
    behaviorOperationStartedAt.set(scopeKey, startedAt)
    const deadline = AbortSignal.timeout(BEHAVIOR_OPERATION_TIMEOUT_MS)
    const lifecycle = behaviorAbortController?.signal
    const signal = lifecycle ? AbortSignal.any([lifecycle, deadline]) : deadline
    try {
      const result = await behaviorOperationSignal.run(signal, operation)
      if (signal.aborted) throw signal.reason
      return result
    } finally {
      if (behaviorOperationStartedAt.get(scopeKey) === startedAt) {
        behaviorOperationStartedAt.delete(scopeKey)
      }
    }
  }
  const run = previous.then(execute, execute).finally(releaseOperation)
  const tail = run.then(() => undefined, () => undefined)
  behaviorOperationTails.set(scopeKey, tail)
  void tail.finally(() => {
    if (behaviorOperationTails.get(scopeKey) === tail) behaviorOperationTails.delete(scopeKey)
  })
  return run
}

export interface RunEnabledBehaviorsOptions {
  /** Scheduled ticks coalesce instead of queuing behind a busy behavior. */
  skipBusy?: boolean
}

async function runBehaviorCycle(
  key: BehaviorKey,
  operation: () => Promise<boolean>,
): Promise<void> {
  const lifecycle = behaviorAbortController?.signal
  if (readBehaviorFailure(key)?.kind === 'worker') clearBehaviorFailure(key)
  try {
    const recovered = await serializeBehaviorOperation(key, operation)
    if (recovered || readBehaviorFailure(key)?.kind === 'operation') {
      clearBehaviorFailure(key)
    }
  } catch (error) {
    if (error instanceof BehaviorProcessLockContentionError) return
    if (lifecycle?.aborted !== true) {
      recordBehaviorFailure(key, 'operation', error)
      console.error(`[behaviors] ${key} operation failed:`, error)
    }
  }
}

export async function runEnabledBehaviorsOnce(
  options: RunEnabledBehaviorsOptions = {},
): Promise<void> {
  if (releaseBackgroundPaused()) return
  prepareInitialReviewBaselines()
  if (behaviorOrganization.getStore() === undefined) {
    await Promise.allSettled(readyOrganizations().map((org) =>
      behaviorOrganization.run(org, () => runEnabledBehaviorsOnce(options))))
    return
  }
  const org = currentOrganization()
  if (!org || !readyOrganizations().some((candidate) => candidate.login.toLowerCase() === org.login.toLowerCase()
    && candidate.datastorePath === org.datastorePath)) return
  const operations: Promise<void>[] = []
  if (isEnabled('review-new-prs')
    && (!options.skipBusy || !behaviorOperationTails.has(operationKey('review-new-prs')))) {
    operations.push(runBehaviorCycle('review-new-prs', async () => {
      return await withBehaviorProcessLock('review-new-prs', async () => {
        await reconcileBehaviorLaunchClaims('review-new-prs')
        await tickReviewNewPrs()
        return listBehaviorLaunchClaims('review-new-prs').length === 0
      })
    }))
  }
  if (isEnabled('approve-prs')
    && (!options.skipBusy || !behaviorOperationTails.has(operationKey('approve-prs')))) {
    operations.push(runBehaviorCycle('approve-prs', async () => {
      return await withBehaviorProcessLock('approve-prs', async () => {
        await reconcileBehaviorLaunchClaims('approve-prs')
        if (await reviewHeldByClaudeAuth('pr_approve')) return false
        await tickApprovePrs()
        return listBehaviorLaunchClaims('approve-prs').length === 0
      })
    }))
  }
  if (isEnabled('review-new-issues')
    && (!options.skipBusy || !behaviorOperationTails.has(operationKey('review-new-issues')))) {
    operations.push(runBehaviorCycle('review-new-issues', async () => {
      return await withBehaviorProcessLock('review-new-issues', async () => {
        await reconcileIssueReviewClaims()
        await tickReviewNewIssues()
        return listBehaviorLaunchClaims('review-new-issues').length === 0
      })
    }))
  }
  if (isEnabled('resolve-unblocking')
    && (!options.skipBusy || !behaviorOperationTails.has(operationKey('resolve-unblocking')))) {
    operations.push(runBehaviorCycle('resolve-unblocking', async () => {
      return await withBehaviorProcessLock('resolve-unblocking', async () => {
        await tickResolveUnblocking()
        return true
      })
    }))
  }
  await Promise.all(operations)
}

function scheduleNextTick(generation: number) {
  if (!tickerStarted || generation !== runtimeGeneration) return
  if (tickTimer) clearTimeout(tickTimer)
  const now = Date.now()
  const nextBoundary = Math.ceil((now + 1) / BEHAVIOR_TICK_MS) * BEHAVIOR_TICK_MS
  tickTimer = setTimeout(() => {
    tickTimer = null
    if (!tickerStarted || generation !== runtimeGeneration) return
    lastTickAtMs = Date.now()
    // Rearm before external work. One slow scan can no longer silence the
    // scheduler; the next tick skips only behaviors that are still busy.
    scheduleNextTick(generation)
    void runEnabledBehaviorsOnce({ skipBusy: true }).then(
      () => {
        if (tickerStarted && generation === runtimeGeneration) {
          lastTickCompletedAtMs = Date.now()
        }
      },
      (err) => {
        if (tickerStarted && generation === runtimeGeneration) {
          lastTickCompletedAtMs = Date.now()
        }
        console.error('[behaviors] tick handler error:', err)
      },
    )
  }, Math.max(0, nextBoundary - now))
}

export interface BehaviorsRuntimeHealth {
  status: 'ok' | 'degraded'
  running: boolean
  startedAt: string | null
  lastTickAt: string | null
  lastTickCompletedAt: string | null
  busy: Array<{ behavior: BehaviorKey, since: string, org?: string }>
  failures: Array<{
    org?: string
    behavior: BehaviorKey
    target?: string
    kind: BehaviorFailureKind
    consecutiveFailures: number
    lastFailureAt: string
    nextRetryAt: string
    error?: string
  }>
  datastore: DatastoreFreshness
  identity: {
    status: 'valid' | 'invalid'
    actor: string | null
    error: string | null
  }
  deadLetters: ReturnType<typeof listBehaviorIncidents>
}

function scopedBehaviorsRuntimeHealth(): BehaviorsRuntimeHealth {
  const now = Date.now()
  const busyEntries = [...behaviorOperationStartedAt.entries()].filter(([key]) => key.startsWith(`${currentOrganization()?.login.toLowerCase() ?? 'legacy'}:`))
  const busy = busyEntries.map(([key, since]) => ({
    behavior: key.slice(key.indexOf(':') + 1) as BehaviorKey,
    since: new Date(since).toISOString(),
  }))
  const heartbeatAt = lastTickAtMs ?? runtimeStartedAtMs
  const heartbeatStale = heartbeatAt === null
    || now - heartbeatAt > (2 * BEHAVIOR_TICK_MS) + BEHAVIOR_HEALTH_GRACE_MS
  const operationStale = busyEntries
    .some(([, startedAt]) => now - startedAt > BEHAVIOR_OPERATION_TIMEOUT_MS + BEHAVIOR_HEALTH_GRACE_MS)
  const failures = BEHAVIOR_KEYS.flatMap((behavior) => {
    if (!isEnabled(behavior)) return []
    return [undefined, ...behaviorFailureTargets(behavior)].flatMap((target) => {
      const failure = readBehaviorFailure(behavior, target)
      return failure ? [{
        behavior,
        ...(target ? { target } : {}),
        kind: failure.kind,
        consecutiveFailures: failure.consecutiveFailures,
        lastFailureAt: new Date(failure.lastFailureAtMs).toISOString(),
        nextRetryAt: new Date(failure.nextRetryAtMs).toISOString(),
        ...(failure.error ? { error: failure.error } : {}),
      }] : []
    })
  })
  const anyEnabled = BEHAVIOR_KEYS.some(isEnabled)
  let reviewer: string | null = null
  try {
    reviewer = getReviewAgentUsername()
  } catch {
    reviewer = null
  }
  // Every behaviour reads `me` to know whose pull requests to act on, and each
  // returns immediately when it is unset. So an enabled behaviour with no `me`
  // does nothing at all, tick after tick, while the view reported a healthy
  // runtime and an Active toggle — the user has no way to tell it is inert.
  // Every behaviour reads `me` to know whose pull requests to act on, and each
  // returns immediately when it is unset. So an enabled behaviour with no `me`
  // does nothing at all, tick after tick, while the view showed an Active
  // toggle and said nothing — the user has no way to tell it is inert. Report
  // it, but leave the overall status alone: the runtime itself is healthy, and
  // the production monitor alerts on that field.
  const author = getMeta('me') || ''
  // Review New Issues is scoped by repository and author list, not by `me`.
  const needsMe = BEHAVIOR_KEYS.some((key) => key !== 'review-new-issues' && isEnabled(key))
  const identityValid = reviewer !== null
  const identityError = reviewer === null
    ? 'REVIEW_AGENT_USERNAME is missing or invalid'
    : (needsMe && author === ''
      ? 'No GitHub username set in Settings — enabled behaviours cannot act until it is'
      : null)
  const identity = {
    status: identityValid ? 'valid' as const : 'invalid' as const,
    actor: reviewer,
    error: identityError,
  }
  const datastoreUnavailable = anyEnabled && datastoreFreshness().status === 'unavailable'
  return {
    status: tickerStarted
      && !heartbeatStale
      && !operationStale
      && !failures.some((failure) => !failure.target)
      && (!anyEnabled || identityValid)
      && !datastoreUnavailable
      ? 'ok'
      : 'degraded',
    running: tickerStarted,
    startedAt: runtimeStartedAtMs === null ? null : new Date(runtimeStartedAtMs).toISOString(),
    lastTickAt: lastTickAtMs === null ? null : new Date(lastTickAtMs).toISOString(),
    lastTickCompletedAt: lastTickCompletedAtMs === null
      ? null
      : new Date(lastTickCompletedAtMs).toISOString(),
    busy,
    failures,
    datastore: { ...datastoreFreshness() },
    identity,
    deadLetters: listBehaviorIncidents(),
  }
}

export function getBehaviorsRuntimeHealth(): BehaviorsRuntimeHealth {
  if (behaviorOrganization.getStore() !== undefined) return scopedBehaviorsRuntimeHealth()
  const health = readyOrganizations().map((org) => ({
    org: org.login,
    health: behaviorOrganization.run(org, scopedBehaviorsRuntimeHealth),
  }))
  if (health.length === 0) return scopedBehaviorsRuntimeHealth()
  const first = health[0].health
  if (health.length === 1) return first
  return {
    ...first,
    status: health.some((entry) => entry.health.status === 'degraded') ? 'degraded' : 'ok',
    busy: health.flatMap((entry) => entry.health.busy.map((item) => ({ ...item, org: entry.org }))),
    failures: health.flatMap((entry) => entry.health.failures.map((item) => ({ ...item, org: entry.org }))),
    deadLetters: health.flatMap((entry) => entry.health.deadLetters),
    datastore: health.find((entry) => entry.health.datastore.status === 'unavailable')?.health.datastore ?? first.datastore,
    identity: health.find((entry) => entry.health.identity.status === 'invalid')?.health.identity ?? first.identity,
  }
}

export interface BehaviorsRuntimeConfig {
  reviewAgentUsername?: string
}

export function startBehaviorsRuntime(config: BehaviorsRuntimeConfig = {}): void {
  if (config.reviewAgentUsername !== undefined) {
    setReviewAgentUsername(config.reviewAgentUsername)
  }
  if (tickerStarted) return
  tickerStarted = true
  behaviorAbortController = new AbortController()
  runtimeGeneration += 1
  const generation = runtimeGeneration
  runtimeStartedAtMs = Date.now()
  lastTickAtMs = null
  lastTickCompletedAtMs = null
  prepareInitialReviewBaselines()
  for (const org of readyOrganizations()) {
    behaviorOrganization.run(org, () => {
      // Preserve an existing completed ledger across restart. Otherwise a PR
      // opened while Poise was down is absorbed into a new snapshot and never
      // reviewed. Pending initial baselines survive failed startup snapshots.
      if (isEnabled('review-new-prs')) {
        void runBehaviorCycle('review-new-prs', async () => {
          return await withBehaviorProcessLock('review-new-prs', async () => {
            migrateReviewNewPrsLedger()
            await initializeReviewBaseline()
            await reconcileBehaviorLaunchClaims('review-new-prs')
            // Startup reconciliation can clear a breaker only by observing an
            // owned worker completion. An empty claim list does not prove that a
            // previously failing model has recovered.
            return false
          })
        })
      }
      if (isEnabled('approve-prs')) {
        void runBehaviorCycle('approve-prs', async () => {
          return await withBehaviorProcessLock('approve-prs', async () => {
            await reconcileBehaviorLaunchClaims('approve-prs')
            return false
          })
        })
      }
      if (isEnabled('review-new-issues')) {
        void runBehaviorCycle('review-new-issues', async () => {
          return await withBehaviorProcessLock('review-new-issues', async () => {
            await reconcileIssueReviewClaims()
            return false
          })
        })
      }
    })
  }
  scheduleNextTick(generation)
}

export async function stopBehaviorsRuntime(): Promise<void> {
  tickerStarted = false
  runtimeGeneration += 1
  if (tickTimer) clearTimeout(tickTimer)
  tickTimer = null
  behaviorAbortController?.abort()
  behaviorAbortController = null
  await Promise.allSettled([...behaviorOperationTails.values()])
  // Detached workers survive Poise itself, but spawn acceptance is not proof
  // of a successful side effect. Leave launched claims with their durable
  // identity so a later runtime reconciles exact log status before retrying;
  // release pre-launch work aborted during shutdown immediately.
  for (const [claimId, claim] of activeClaims) {
    if (claim.launched) activeClaims.delete(claimId)
    else releaseOwnedClaim(claim.behavior, claim.target, claimId)
  }
  runtimeStartedAtMs = null
  lastTickAtMs = null
  lastTickCompletedAtMs = null
}

// Snapshot for read-only callers (the GET /api/behaviors endpoint).
export function getEnabledMap(): Record<BehaviorKey, boolean> {
  const out: Record<BehaviorKey, boolean> = {} as any
  for (const k of BEHAVIOR_KEYS) out[k] = isEnabled(k)
  return out
}

export function getSettingMap(): Record<BehaviorKey, BehaviorSetting> {
  const out: Record<BehaviorKey, BehaviorSetting> = {} as any
  for (const k of BEHAVIOR_KEYS) out[k] = getSetting(k)
  return out
}

export function getScratchpadMap(): Record<BehaviorKey, string> {
  const out: Record<BehaviorKey, string> = {} as any
  for (const k of BEHAVIOR_KEYS) out[k] = getScratchpad(k)
  return out
}

// A review tick is held only while its resolved model needs the Claude.ai
// sign-in and that sign-in is not there; a fallback on another provider runs.
async function reviewHeldByClaudeAuth(place: ReviewPlace): Promise<boolean> {
  try {
    const { model, catalog } = await reviewChoice(place)
    return needsClaude(catalog, model) && claudeAuth.snapshot().status !== 'authenticated'
  } catch {
    // An unavailable catalog is reported by the tick itself.
    return false
  }
}

function availableReviewSlots(panel: Awaited<ReturnType<typeof reviewPanel>>): ReviewerSlot[] {
  return panel.reviewers.filter(({ model }) =>
    !needsClaude(panel.catalog, model) || claudeAuth.snapshot().status === 'authenticated',
  ).map(({ slot }) => slot)
}
