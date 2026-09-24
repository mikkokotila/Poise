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
// Today's only behavior is "review-new-prs": list open PRs by the
// configured Poise user, find any not in the snapshot, spawn
// `agent-interface --pr-review '#<n>' --pwd <local-checkout>`
// directly — no HTTP roundtrip, no /api/pr-review hop.

import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { ISSUE_REVIEW_BEHAVIOR, fetchAgentLogs, type LogEntry } from './agent'
import { claudeAuth } from './claude-auth'
import { REVIEW_POLICY, needsClaude, reviewChoice, reviewPanel, type ReviewPlace } from './review-model'
import { type Catalog, type ReviewerSlot, REVIEWER_SLOTS, loadCatalog } from './models'
import {
  db,
  claimPrOperationOwned,
  claimSeenOwned,
  claimSeenOwnedAs,
  clearSeenExceptLaunched,
  completeBehaviorLaunchOwned,
  completeIssueReviewLaunchOwned,
  countBehaviorDeadLetters,
  hasExpiredPreLaunchClaim,
  completeSeenOwned,
  getFailedBehaviorLaunch,
  getMeta,
  hasSeen,
  latestApprovalBasisLaunch,
  linkBehaviorLaunchCallOwned,
  listBehaviorLaunchClaims,
  listBehaviorDeadLetters,
  listBehaviorIncidents,
  listSeenTargets,
  listSnapshotOnlySeen,
  markBehaviorLaunchIntentOwned,
  recordBehaviorDeadLetter,
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
  setMeta,
  type BehaviorAgentLaunch,
  type BehaviorLaunchClaim,
} from './db'
import { HttpError } from './http'
import { claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'
import { withProcessLock } from './process-lock'
import { getReviewAgentUsername, setReviewAgentUsername } from './gh'

const DATASTORE = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const AGENT_INTERFACE = 'agent-interface'
const LEGACY_REVIEW_SNAPSHOT_TARGET = '__snapshot_v2__'
const REVIEW_SNAPSHOT_TARGET = '__snapshot_v3__'
const BEHAVIOR_AUTH_FRESHNESS_MS = 60_000
const DATASTORE_MAX_AGE_SECONDS = 120
const SHA_PATTERN = /^[0-9a-f]{40}$/
const GITHUB_USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/

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
  return join(directory, `.poise-${behavior}-runtime-lock.sqlite3`)
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

function failureKey(key: BehaviorKey): string {
  return `${META_PREFIX}${key.replace(/-/g, '_')}_failure`
}

function readBehaviorFailure(key: BehaviorKey): PersistedBehaviorFailure | null {
  const raw = getMeta(failureKey(key))
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

function recordBehaviorFailure(key: BehaviorKey, kind: BehaviorFailureKind, cause?: unknown): void {
  if (!isEnabled(key)) return
  const previous = readBehaviorFailure(key)
  const consecutiveFailures = Math.min((previous?.consecutiveFailures ?? 0) + 1, 31)
  const delayMs = Math.min(
    BEHAVIOR_RETRY_BASE_MS * (2 ** Math.min(consecutiveFailures - 1, 20)),
    BEHAVIOR_RETRY_MAX_MS,
  )
  const now = Date.now()
  const error = cause === undefined ? undefined : (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
  setMeta(failureKey(key), JSON.stringify({
    kind,
    consecutiveFailures,
    lastFailureAtMs: now,
    nextRetryAtMs: now + delayMs,
    ...(error ? { error } : {}),
  } satisfies PersistedBehaviorFailure))
}

function clearBehaviorFailure(key: BehaviorKey): void {
  setMeta(failureKey(key), '')
}

function behaviorRetryDue(key: BehaviorKey): boolean {
  const failure = readBehaviorFailure(key)
  return failure === null
    || failure.kind === 'operation'
    || Date.now() >= failure.nextRetryAtMs
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
  setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, error)
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

function agentCallStartedAt(call: Awaited<ReturnType<typeof fetchAgentLogs>>[number]): string {
  return String(call.started_at_precise || call.started_at || '')
}

async function reconcileBehaviorLaunchClaims(
  behavior: 'review-new-prs' | 'approve-prs',
): Promise<void> {
  const claims = listBehaviorLaunchClaims(behavior)
  const deadLetters = listBehaviorDeadLetters(500).filter(
    (letter) => letter.behavior === behavior && letter.callId !== null,
  )
  if (claims.length === 0 && deadLetters.length === 0) return

  let logs: Awaited<ReturnType<typeof fetchAgentLogs>>
  try {
    logs = await fetchAgentLogs({ signal: behaviorSignal() })
  } catch (error) {
    const message = `agent log reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`
    for (const claim of claims) retainClaimSafely(claim, message)
    throw error
  }
  // Which sign-in a failed call counts against is decided by its model's
  // provider; a log row can name a model the catalog has since retired.
  const catalogForCalls: Catalog | null = await loadCatalog().catch(() => null)

  let recoveredDeadLetter = false
  const expectedActions = behavior === 'review-new-prs'
    ? new Map([['reviewed_clean', 'clean'], ['requested_changes', 'changes_requested']])
    : new Map([['approved', 'approved'], ['requested_changes', 'changes_requested']])
  for (const letter of deadLetters) {
    const call = logs.find((row) => row.id.toLowerCase() === letter.callId)
    const completedAt = String(call?.completed_at || '')
    const action = String(call?.action || '')
    const outcome = String(call?.outcome || '')
    if (call?.status.toLowerCase() === 'completed'
      && call.behavior === upstreamBehavior(behavior)
      && call.repo === letter.repo
      && String(call.pr_id || '') === String(letter.pr)
      && String(call.actor || '').toLowerCase() === String(letter.actor || '').toLowerCase()
      && call.source === letter.source
      && call.correlation_id === letter.correlationId
      && expectedActions.get(action) === outcome
      && SHA_PATTERN.test(String(call.head_sha || '').toLowerCase())
      && Number.isFinite(Date.parse(completedAt))) {
      recoveredDeadLetter = retireBehaviorDeadLetter(letter.id) || recoveredDeadLetter
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
            recordBehaviorFailure(behavior, 'worker')
          }
        }
        continue
      }

      call = candidates[0]
      if (!linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, call.id)) {
        continue
      }
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
      deadLetterClaim(
        claim,
        'linked agent call does not match the persisted launch contract; retained to prevent duplicate launch',
      )
      continue
    }

    const status = call.status.toLowerCase()
    const superseded = status === 'superseded'
      || String(call.outcome || '') === 'superseded'
      || call.error === SUPERSEDED_AGENT_ERROR
    if (superseded) {
      if (releaseOwnedClaim(behavior, claim.target, claim.claimId)) {
        clearBehaviorFailure(behavior)
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
          recordBehaviorFailure(behavior, 'worker')
        }
      }
      continue
    }
    const terminal = status === 'completed' || FAILED_AGENT_STATUSES.has(status)
    if (!terminal && Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
      const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker')
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
        if (deadLetterClaim(claim, error)) recordBehaviorFailure(behavior, 'worker')
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
        activeClaims.delete(claim.claimId)
        clearBehaviorFailure(behavior)
      } else {
        activeClaims.delete(claim.claimId)
        const current = listBehaviorLaunchClaims(behavior).find(
          (candidate) => candidate.target === claim.target
            && candidate.claimId === claim.claimId,
        )
        if (current) {
          const error = 'terminal agent outcome could not complete its owned launch claim'
          if (deadLetterClaim(current, error)) recordBehaviorFailure(behavior, 'worker')
        }
      }
    } else if (FAILED_AGENT_STATUSES.has(status)) {
      const message = call.error || `agent call terminated with status ${status}`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker')
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
        recordBehaviorFailure(behavior, 'worker')
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

let datastoreFreshness: DatastoreFreshness = {
  status: 'unchecked',
  checkedAt: new Date(0).toISOString(),
  ageSeconds: null,
  lastSuccessAt: null,
  error: null,
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
    const { stdout } = await runFile(
      DATASTORE,
      ['health', '--max-age-seconds', String(DATASTORE_MAX_AGE_SECONDS)],
      { timeoutMs: 30_000, maxOutputBytes: 1 * 1024 * 1024, signal: behaviorSignal() },
    )
    const data = objectValue(parseJson(stdout, 'github-datastore health'), 'github-datastore health')
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
    datastoreFreshness = {
      status: 'healthy',
      checkedAt,
      ageSeconds,
      lastSuccessAt,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    datastoreFreshness = {
      status: 'unavailable',
      checkedAt,
      ageSeconds: null,
      lastSuccessAt: null,
      error: message,
    }
    throw new Error(`github-datastore freshness gate failed: ${message}`, { cause: error })
  }
}

async function listOpenPrsByAuthor(author: string): Promise<DatastorePr[]> {
  if (!author) return []
  await requireFreshDatastore()
  const { stdout } = await runFile(
    DATASTORE,
    ['view', 'pr', '--status', 'open', '--format', 'json'],
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
  retireBehaviorDeadLettersForClosedPrs(seen)
  return prs.filter((pr) => pr.author === author && !pr.draft)
}

async function localCheckoutPath(owner: string, repo: string): Promise<string> {
  const { stdout } = await runFile(GH_INTERFACE, ['--local-checkout-path', owner, repo], {
    timeoutMs: 30_000,
    maxOutputBytes: 1 * 1024 * 1024,
    signal: behaviorSignal(),
  })
  const result = objectValue(
    parseJson(stdout, 'github-interface --local-checkout-path'),
    'github-interface --local-checkout-path',
  )
  const repository = `${owner}/${repo}`
  const path = String(result.path || '')
  if (result.action !== 'local_checkout_path'
    || result.repository !== repository
    || !isAbsolute(path)) {
    throw new Error('github-interface --local-checkout-path returned malformed state')
  }
  return path
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
  const pwd = await localCheckoutPath(owner, repo)
  // mkdir the cwd hack dir — agent-interface needs it to exist for
  // --pwd resolution behavior identical to triggerPrReview in agent.ts.
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('review-new-prs')) return false
  if (claude) await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('review-new-prs') || behaviorAborted()) return false
  const expectedHead = await currentHeadSha(pr.repo, pr.number, actor)
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

async function snapshotReviewNewPrs(): Promise<void> {
  // A missing marker is the sole readiness predicate. Clear it before work so
  // a concurrent tick (including one in another local server process) takes
  // the safe snapshot path instead of firing against a partial snapshot.
  releaseSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
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
    recordSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
  } catch (err) {
    releaseSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
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
    const legacyTargets = listSeenTargets('review-new-prs')
    if (legacyTargets.includes(LEGACY_REVIEW_SNAPSHOT_TARGET)) {
      for (const target of legacyTargets) {
        const separator = target.indexOf('@')
        if (separator > 0) recordSeen('review-new-prs', target.slice(0, separator))
      }
      recordSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
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
  if (getMeta(SNAPSHOT_RECOVERY_META) === '1') return
  const previousRecoveryComplete = getMeta(FAILED_SNAPSHOT_RECOVERY_META) === '1'
  const open = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`))
  const candidates = listSnapshotOnlySeen('review-new-prs')
    .filter((row) => row.target !== REVIEW_SNAPSHOT_TARGET && open.has(row.target))
  if (candidates.length > 0) {
    const logs = await fetchAgentLogs({ signal: behaviorSignal() })
    for (const candidate of candidates) {
      const separator = candidate.target.lastIndexOf('#')
      const repo = candidate.target.slice(0, separator)
      const prId = candidate.target.slice(separator + 1)
      const matching = logs.filter((entry) =>
        entry.behavior === 'pr_review'
        && entry.repo === repo
        && entry.pr_id === prId
        && entry.actor?.toLowerCase() === reviewer.toLowerCase())
      const completed = matching.some((entry) => entry.status === 'completed')
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

  // First tick after boot/enable with no snapshot — take one and bail.
  if (!hasSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)) {
    await snapshotReviewNewPrs()
    return
  }
  try {
    const prs = await listOpenPrsByAuthor(author)
    await recoverSnapshotReviews(prs, reviewer)
    const slots = (await reviewPanel(getReviewers('review-new-prs'))).reviewers.map((entry) => entry.slot)
    let failure: unknown
    await Promise.all(prs.flatMap((pr) => {
      const key = `${pr.repo}#${pr.number}`
      // A pull request is new to the panel when its primary is: the extra
      // reviewers ride with a fresh primary and otherwise fire only to
      // recover their own failed launch, never for a pull request the
      // primary already handled before the panel grew.
      const primaryFresh = !hasSeen('review-new-prs', key) || !!getFailedBehaviorLaunch('review-new-prs', key)
      return slots.filter((slot) => {
        const target = reviewSlotTarget(key, slot)
        if (slot === 'primary') return primaryFresh
        return (primaryFresh && !hasSeen('review-new-prs', target)) || !!getFailedBehaviorLaunch('review-new-prs', target)
      }).map((slot) => [pr, key, slot] as const)
    }).map(async ([pr, key, slot]) => {
      if (!isEnabled('review-new-prs') || behaviorAborted()) return
      const target = reviewSlotTarget(key, slot)
      let operationId: string | null = null
      let launched = false
      try {
        if (await packetBlocked('review-new-prs', pr.repo, pr.number)) return
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
          console.log(`[behaviors] review-new-prs fired for ${pr.repo}#${pr.number} (p=${getSetting('review-new-prs')}, ${slot})`)
        } catch (err) {
          // Pre-launch work and spawn acknowledgement are part of the claim.
          // Release on failure so the next tick can retry this exact target.
          releaseOwnedClaim('review-new-prs', target, claimId)
          throw err
        }
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] review-new-prs step failed for ${pr.repo}#${pr.number} (${slot}):`, err)
        failure ??= err
      } finally {
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
    || failed.launchBehavior !== launchBehavior
    || failed.launchRepo !== repo
    || failed.launchPr !== number
    || failed.launchSource !== source) {
    return false
  }
  const logs = await fetchAgentLogs({ signal: behaviorSignal() })
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
  const pwd = await localCheckoutPath(owner, repo)
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
      let check: ChangesAddressedResult
      try {
        check = await checkChangesAddressed(pr.repo, pr.number, reviewer)
        if (await packetBlocked('approve-prs', pr.repo, pr.number, check.headSha)) return
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] approve-prs check failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
        return
      }
      if (!check.hasChangeRequest && !latestApprovalBasisLaunch(pr.repo, pr.number)) return
      if (hasActiveAgentLaunchForPr(pr.repo, pr.number)) return
      const operationId = await claimEligiblePrOperation('approve-prs', prTarget)
      if (!operationId) {
        console.log(`[behaviors] approve-prs deferred for ${prTarget}: PR operation busy`)
        return
      }
      let launched = false
      try {
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
          if (check.responseCount < 1 || check.latestRequestAt === null) return
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
            )) return
          expectedHead = check.headSha
          seenTarget = `${pr.repo}#${pr.number}@req=${check.latestRequestAt}/r=${check.responseCount}/head=${check.headSha}`
          firedReason = `req=${check.latestRequestAt}, r=${check.responseCount}: ${check.commitsAfterRequest}c+${check.authorInlineRepliesAfterRequest}reply, head=${check.headSha.slice(0, 8)}`
        } else {
          const review = latestApprovalBasisLaunch(pr.repo, pr.number)
          if (!review) return
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
              && activity.reviewerLatestCommit === activity.headSha)) return
          if (activity.headSha !== review.headSha && activity.latestActivityAt === null) {
            throw new Error(`head changed without an activity watermark for ${pr.repo}#${pr.number}`)
          }
          expectedHead = activity.headSha
          seenTarget = `${pr.repo}#${pr.number}@head=${activity.headSha}`
          firedReason = `clean review ${review.callId.slice(0, 8)}, head=${activity.headSha.slice(0, 8)}`
        }
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
        } catch (err) {
          releaseOwnedClaim('approve-prs', seenTarget, claimId)
          throw err
        }
        console.log(`[behaviors] approve-prs fired for ${pr.repo}#${pr.number} (${firedReason})`)
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] approve-prs check/fire failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
      } finally {
        if (!launched) releasePrOperationOwned(operationId)
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
  const raw = getMeta(RESOLVE_LAST_FIRED_KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (typeof p.at === 'string' && typeof p.target === 'string') {
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
    let failure: unknown
    await Promise.all(prs.map(async (pr) => {
      if (!isEnabled('resolve-unblocking') || behaviorAborted()) return
      const key = `${pr.repo}#${pr.number}`
      let operationId: string | null = null
      try {
        // A read cannot resolve anything. Avoid occupying the mutation lock
        // when the PR has no unresolved conversations to act on.
        const activity = await checkReviewActivity(pr.repo, pr.number, configuredReviewer(), '1970-01-01T00:00:00Z')
        if (activity.state !== 'OPEN' || activity.draft || activity.unresolvedConversationCount === 0) return
        if (!isEnabled('resolve-unblocking') || behaviorAborted()) return
        operationId = claimPrOperationOwned(key, PR_OPERATION_EVALUATION_LEASE_MS)
        if (!operationId) return
        // This CLI performs the mutation itself. The synchronous flag check
        // immediately before invocation prevents a disabled behavior from
        // starting another resolve operation.
        if (!isEnabled('resolve-unblocking')) return
        const result = await resolveNonblockingIfReady(pr.repo, pr.number)
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
        if (behaviorAborted()) return
        console.error(`[behaviors] resolve-unblocking failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
      } finally {
        if (operationId) releasePrOperationOwned(operationId)
      }
    }))
    if (failure) throw failure
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
    ['view', 'issue', '--repo', repo, '--status', 'open', '--created-since-datetime', since, '--limit', '500', '--format', 'json'],
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
// covers nothing and waits. Only several reads all failing, which is GitHub or
// the token rather than one issue, stops the minute.
async function readSubIssues(entries: readonly EligibleIssue[]): Promise<Map<string, string[]>> {
  const subIssues = new Map<string, string[]>()
  const failures: unknown[] = []
  let next = 0
  const reader = async () => {
    while (next < entries.length) {
      const { issue } = entries[next++]
      const ref = issueRef(`${issue.repo}#${issue.number}`)
      try {
        subIssues.set(ref, await listSubIssues(issue.repo, issue.number))
        subIssueReadErrors.delete(ref)
      } catch (error) {
        if (behaviorAborted()) throw error
        failures.push(error)
        const message = error instanceof Error ? error.message : String(error)
        if (subIssueReadErrors.get(ref) !== message) {
          console.error(`[behaviors] review-new-issues cannot read the sub-issues of ${issue.repo}#${issue.number}: ${message}`)
        }
        subIssueReadErrors.set(ref, message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SUB_ISSUE_READS_AT_ONCE, entries.length) }, reader))
  if (failures.length > 1 && subIssues.size === 0) throw failures[0]
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
  logs: () => Promise<LogEntry[]>,
): Promise<IssueReviewPlan> {
  const plan: IssueReviewPlan = { launch: new Map(), reviewed: [] }
  const due = [...new Set(candidates.map(({ issue }) => issueRef(`${issue.repo}#${issue.number}`)))]
  if (due.length === 0) return plan

  // What reviews have commented on besides their own issue.
  const commentedBy = new Map<string, string>()
  for (const call of await logs()) {
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
    if (by) plan.reviewed.push({ ref, by })
  }

  // Every issue whose own review is still to come, settled or not, may cover
  // a due one; the roots among them are reviewed.
  const pending: EligibleIssue[] = []
  const pendingRefs = new Set<string>()
  for (const entry of eligible) {
    const ref = issueRef(`${entry.issue.repo}#${entry.issue.number}`)
    if (commentedBy.has(ref) || runningFor.has(ref)) continue
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
  if (open.length === 0 || listBehaviorLaunchClaims(ISSUES_KEY).length >= MAX_ISSUE_REVIEW_RUNS) return plan
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
  logs: () => Promise<LogEntry[]>,
): Promise<BehaviorLaunchClaim | null> {
  const failed = getFailedBehaviorLaunch(ISSUES_KEY, target)
  if (!failed?.launchCallId
    || failed.launchBehavior !== 'issue_review'
    || failed.launchSource !== ISSUE_REVIEW_SOURCE
    || countBehaviorDeadLetters(ISSUES_KEY, target) >= ISSUE_REVIEW_ATTEMPTS) return null
  const call = (await logs()).find((row) => row.id === failed.launchCallId)
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
async function issueTargetLaunchable(target: string, logs: () => Promise<LogEntry[]>): Promise<boolean> {
  if (!hasSeen(ISSUES_KEY, target)) return countBehaviorDeadLetters(ISSUES_KEY, target) < ISSUE_REVIEW_ATTEMPTS
  if (hasExpiredPreLaunchClaim(ISSUES_KEY, target)) return true
  return !!await releasableIssueReviewFailure(target, logs)
}

async function releaseFailedIssueReviewIfSafe(target: string, logs: () => Promise<LogEntry[]>): Promise<boolean> {
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
  logs: () => Promise<LogEntry[]>,
  covers: readonly string[],
): Promise<void> {
  if (countBehaviorDeadLetters(ISSUES_KEY, target) >= ISSUE_REVIEW_ATTEMPTS && !hasSeen(ISSUES_KEY, target)) return
  let claimId = claimSeenOwned(ISSUES_KEY, target, ISSUE_PRE_LAUNCH_LEASE_MS)
  if (!claimId) {
    if (!await releaseFailedIssueReviewIfSafe(target, logs)) return
    claimId = claimSeenOwned(ISSUES_KEY, target, ISSUE_PRE_LAUNCH_LEASE_MS)
    if (!claimId) return
  }
  trackClaim(ISSUES_KEY, target, claimId)
  try {
    if (!await fireIssueReview(issue, target, claimId, slot, covers)) {
      releaseOwnedClaim(ISSUES_KEY, target, claimId)
      return
    }
  } catch (error) {
    releaseOwnedClaim(ISSUES_KEY, target, claimId)
    throw error
  }
  console.log(`[behaviors] review-new-issues fired for ${issue.repo}#${issue.number} (${slot})`)
}

async function tickReviewNewIssues(): Promise<void> {
  if (!isEnabled(ISSUES_KEY)) return
  const repositories = getIssueRepositories()
  if (repositories.length === 0) return
  const authors = new Set(getIssueAuthors().map((author) => author.toLowerCase()))
  const slots = (await reviewPanel(getReviewers(ISSUES_KEY), 'issue_review')).reviewers.map((entry) => entry.slot)
  const slotSince = getIssueSlotSince()
  await requireFreshDatastore()
  const open = new Set<string>()
  const eligible: EligibleIssue[] = []
  const candidates: IssueCandidate[] = []
  const now = Date.now()
  for (const { repo, since } of repositories) {
    for (const issue of await listOpenIssues(repo, since)) {
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
  // Every selected repository was read, so what is not open is closed or no
  // longer selected; its incidents are settled.
  retireBehaviorDeadLettersForClosedPrs(open, [ISSUES_KEY])
  candidates.sort((a, b) => a.order - b.order)
  let logs: Promise<LogEntry[]> | null = null
  const readLogs = () => (logs ??= fetchAgentLogs({ signal: behaviorSignal() }))
  const plan = await planIssueReviews(candidates, eligible, readLogs)
  for (const { ref, by } of plan.reviewed) {
    let settled: string | null = null
    for (const { issue, target } of candidates) {
      if (issueRef(`${issue.repo}#${issue.number}`) !== ref) continue
      // Its own review failing earlier is no longer an incident: it was reviewed.
      if (retireBehaviorDeadLettersForTarget(ISSUES_KEY, target) > 0) settled = `${issue.repo}#${issue.number}`
      // A claim whose process died before launching gives way to the marker.
      if (hasExpiredPreLaunchClaim(ISSUES_KEY, target)) releaseSeen(ISSUES_KEY, target)
      if (hasSeen(ISSUES_KEY, target)) continue
      recordSeen(ISSUES_KEY, target)
      settled = `${issue.repo}#${issue.number}`
    }
    if (settled) console.log(`[behaviors] review-new-issues: ${settled} was reviewed as a sub-issue of ${by}`)
  }
  let failure: unknown
  for (const { issue, slot, target } of candidates) {
    if (!isEnabled(ISSUES_KEY) || behaviorAborted()) return
    const covers = plan.launch.get(issueRef(`${issue.repo}#${issue.number}`))
    if (!covers) continue
    if (listBehaviorLaunchClaims(ISSUES_KEY).length >= MAX_ISSUE_REVIEW_RUNS) break
    try {
      await launchIssueReview(issue, slot, target, readLogs, covers)
    } catch (error) {
      if (behaviorAborted()) return
      console.error(`[behaviors] review-new-issues step failed for ${target}:`, error)
      failure ??= error
    }
  }
  if (failure) throw failure
}

async function reconcileIssueReviewClaims(): Promise<void> {
  const claims = listBehaviorLaunchClaims(ISSUES_KEY)
  const deadLetters = listBehaviorDeadLetters(500).filter(
    (letter) => letter.behavior === ISSUES_KEY && letter.callId !== null,
  )
  if (claims.length === 0 && deadLetters.length === 0) return

  let logs: LogEntry[]
  try {
    logs = await fetchAgentLogs({ signal: behaviorSignal() })
  } catch (error) {
    const message = `agent log reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`
    for (const claim of claims) retainClaimSafely(claim, message)
    throw error
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
    const call = logs.find((row) => row.id === letter.callId)
    if (commented(call)
      && call!.repo === letter.repo
      && String(call!.pr_id || '') === String(letter.pr)
      && call!.correlation_id === letter.correlationId) {
      recoveredDeadLetter = retireBehaviorDeadLetter(letter.id) || recoveredDeadLetter
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
            recordBehaviorFailure(ISSUES_KEY, 'worker', 'agent call did not register before the launch deadline')
          }
        }
        continue
      }
      call = candidates[0]
      if (!linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, call.id)) continue
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
      deadLetterClaim(claim, 'linked agent call does not match the persisted launch contract; retained to prevent duplicate launch')
      continue
    }

    const status = call.status.toLowerCase()
    if (status === 'completed') {
      if (!commented(call)) {
        const error = 'completed agent call is missing its commented outcome'
        if (deadLetterClaim(claim, error)) recordBehaviorFailure(ISSUES_KEY, 'worker', error)
        continue
      }
      activeClaims.delete(claim.claimId)
      if (completeIssueReviewLaunchOwned({
        key: claim.key,
        target: claim.target,
        claimId: claim.claimId,
        completedAt: String(call.completed_at),
      })) clearBehaviorFailure(ISSUES_KEY)
      continue
    }
    if (FAILED_AGENT_STATUSES.has(status)) {
      const message = call.error || `agent call terminated with status ${status}`
      if (deadLetterClaim(claim, message)) {
        const posted = call.receipts !== null && call.receipts !== undefined
        if (call.error_code !== 'stopped' && (posted || !HELD_ISSUE_REVIEW_ERRORS.has(call.error_code || ''))) {
          recordBehaviorFailure(ISSUES_KEY, 'worker', message)
        }
        if (call.error_code !== 'stopped' && needsClaude(catalogForCalls, call.model)) claudeAuth.observeProcessFailure(message)
      }
      continue
    }
    if (RUNNING_AGENT_STATUSES.has(status)) {
      if (Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
        const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
        if (deadLetterClaim(claim, message)) recordBehaviorFailure(ISSUES_KEY, 'worker', message)
        continue
      }
      setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, null)
      renewSeenOwned(claim.key, claim.target, claim.claimId, BEHAVIOR_CLAIM_RENEWAL_MS)
      continue
    }
    const message = `unrecognized agent call status "${status || 'missing'}"`
    if (deadLetterClaim(claim, message)) recordBehaviorFailure(ISSUES_KEY, 'worker', message)
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  const lifecycle = behaviorAbortController?.signal
  if (!enabled) {
    // Publish the stop flag immediately so an in-flight tick exits at its
    // next await boundary. Waiting on its operation tail below guarantees
    // the API cannot acknowledge disable while a later launch is possible.
    setPersistedEnabled(key, false)
    clearBehaviorFailure(key)
  }
  try {
    await serializeBehaviorOperation(key, async () => {
      const update = async () => {
        setPersistedEnabled(key, enabled)
        if (key === 'review-new-prs') {
          if (enabled) {
            // A first-ever enable needs an anti-flood baseline. Re-enabling is
            // a resume: preserving the ledger lets the next tick process PRs
            // that appeared while the behavior was paused.
            if (!hasSeen(key, REVIEW_SNAPSHOT_TARGET)) await snapshotReviewNewPrs()
            await reconcileBehaviorLaunchClaims(key)
          }
        } else if (key === 'approve-prs') {
          if (enabled) await reconcileBehaviorLaunchClaims(key)
          else clearSeenExceptLaunched(key)
        } else if (key === 'review-new-issues') {
          // No snapshot: each repository's selection date is the baseline.
          if (enabled) await reconcileIssueReviewClaims()
        }
        // resolve-unblocking has no seen ledger — github-interface is
        // idempotent so the tick handler can safely fire every minute.
      }
      await withBehaviorProcessLock(key, update)
    })
  } catch (error) {
    if (lifecycle?.aborted === true) throw error
    if (error instanceof BehaviorProcessLockContentionError) throw error
    if (!enabled || !isEnabled(key)) throw error
    recordBehaviorFailure(key, 'operation', error)
    console.error(`[behaviors] ${key} enable reconciliation failed:`, error)
  }
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
const behaviorOperationTails = new Map<BehaviorKey, Promise<void>>()
const behaviorOperationStartedAt = new Map<BehaviorKey, number>()

function serializeBehaviorOperation<T>(
  key: BehaviorKey,
  operation: () => Promise<T>,
): Promise<T> {
  const releaseOperation = trackReleaseBackground()
  const previous = behaviorOperationTails.get(key) || Promise.resolve()
  const execute = async () => {
    const startedAt = Date.now()
    behaviorOperationStartedAt.set(key, startedAt)
    const deadline = AbortSignal.timeout(BEHAVIOR_OPERATION_TIMEOUT_MS)
    const lifecycle = behaviorAbortController?.signal
    const signal = lifecycle ? AbortSignal.any([lifecycle, deadline]) : deadline
    try {
      const result = await behaviorOperationSignal.run(signal, operation)
      if (signal.aborted) throw signal.reason
      return result
    } finally {
      if (behaviorOperationStartedAt.get(key) === startedAt) {
        behaviorOperationStartedAt.delete(key)
      }
    }
  }
  const run = previous.then(execute, execute).finally(releaseOperation)
  const tail = run.then(() => undefined, () => undefined)
  behaviorOperationTails.set(key, tail)
  void tail.finally(() => {
    if (behaviorOperationTails.get(key) === tail) behaviorOperationTails.delete(key)
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
  if (!behaviorRetryDue(key)) return
  const lifecycle = behaviorAbortController?.signal
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
  const operations: Promise<void>[] = []
  if (isEnabled('review-new-prs')
    && (!options.skipBusy || !behaviorOperationTails.has('review-new-prs'))) {
    operations.push(runBehaviorCycle('review-new-prs', async () => {
      return await withBehaviorProcessLock('review-new-prs', async () => {
        await reconcileBehaviorLaunchClaims('review-new-prs')
        if (!behaviorRetryDue('review-new-prs')) return false
        if (await reviewHeldByClaudeAuth('pr_review')) return false
        await tickReviewNewPrs()
        return listBehaviorLaunchClaims('review-new-prs').length === 0
      })
    }))
  }
  if (isEnabled('approve-prs')
    && (!options.skipBusy || !behaviorOperationTails.has('approve-prs'))) {
    operations.push(runBehaviorCycle('approve-prs', async () => {
      return await withBehaviorProcessLock('approve-prs', async () => {
        await reconcileBehaviorLaunchClaims('approve-prs')
        if (!behaviorRetryDue('approve-prs')) return false
        if (await reviewHeldByClaudeAuth('pr_approve')) return false
        await tickApprovePrs()
        return listBehaviorLaunchClaims('approve-prs').length === 0
      })
    }))
  }
  if (isEnabled('review-new-issues')
    && (!options.skipBusy || !behaviorOperationTails.has('review-new-issues'))) {
    operations.push(runBehaviorCycle('review-new-issues', async () => {
      return await withBehaviorProcessLock('review-new-issues', async () => {
        await reconcileIssueReviewClaims()
        if (!behaviorRetryDue('review-new-issues')) return false
        if (await reviewHeldByClaudeAuth('issue_review')) return false
        await tickReviewNewIssues()
        return listBehaviorLaunchClaims('review-new-issues').length === 0
      })
    }))
  }
  if (isEnabled('resolve-unblocking')
    && (!options.skipBusy || !behaviorOperationTails.has('resolve-unblocking'))) {
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
  busy: Array<{ behavior: BehaviorKey, since: string }>
  failures: Array<{
    behavior: BehaviorKey
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

export function getBehaviorsRuntimeHealth(): BehaviorsRuntimeHealth {
  const now = Date.now()
  const busy = [...behaviorOperationStartedAt.entries()].map(([behavior, since]) => ({
    behavior,
    since: new Date(since).toISOString(),
  }))
  const heartbeatAt = lastTickAtMs ?? runtimeStartedAtMs
  const heartbeatStale = heartbeatAt === null
    || now - heartbeatAt > (2 * BEHAVIOR_TICK_MS) + BEHAVIOR_HEALTH_GRACE_MS
  const operationStale = [...behaviorOperationStartedAt.values()]
    .some((startedAt) => now - startedAt > BEHAVIOR_OPERATION_TIMEOUT_MS + BEHAVIOR_HEALTH_GRACE_MS)
  const failures = BEHAVIOR_KEYS.flatMap((behavior) => {
    if (!isEnabled(behavior)) return []
    const failure = readBehaviorFailure(behavior)
    return failure ? [{
      behavior,
      kind: failure.kind,
      consecutiveFailures: failure.consecutiveFailures,
      lastFailureAt: new Date(failure.lastFailureAtMs).toISOString(),
      nextRetryAt: new Date(failure.nextRetryAtMs).toISOString(),
      ...(failure.error ? { error: failure.error } : {}),
    }] : []
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
  const datastoreUnavailable = anyEnabled && datastoreFreshness.status === 'unavailable'
  return {
    status: tickerStarted
      && !heartbeatStale
      && !operationStale
      && failures.length === 0
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
    datastore: { ...datastoreFreshness },
    identity,
    deadLetters: listBehaviorIncidents(),
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
  // Preserve an existing completed ledger across restart. Otherwise a PR
  // opened while Poise was down is absorbed into a new snapshot and never
  // reviewed. A genuinely missing marker still takes the anti-flood snapshot.
  if (isEnabled('review-new-prs')) {
    void runBehaviorCycle('review-new-prs', async () => {
      return await withBehaviorProcessLock('review-new-prs', async () => {
        migrateReviewNewPrsLedger()
        if (!hasSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)) {
          await snapshotReviewNewPrs()
        }
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
