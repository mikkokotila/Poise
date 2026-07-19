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
import { fetchAgentLogs } from './agent'
import { claudeAuth } from './claude-auth'
import {
  claimSeenOwned,
  clearSeenExceptLaunched,
  completeBehaviorLaunchOwned,
  completeSeenOwned,
  getMeta,
  hasSeen,
  latestCleanReviewLaunch,
  linkBehaviorLaunchCallOwned,
  listBehaviorLaunchClaims,
  listBehaviorDeadLetters,
  listSeenTargets,
  listSnapshotOnlySeen,
  markBehaviorLaunchIntentOwned,
  recordBehaviorDeadLetter,
  recordSeen,
  releaseSeen,
  releaseSeenOwned,
  renewSeenOwned,
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

export type BehaviorKey = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking'
export const BEHAVIOR_KEYS: BehaviorKey[] = ['review-new-prs', 'approve-prs', 'resolve-unblocking']

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
    }
  } catch {
    return null
  }
}

function recordBehaviorFailure(key: BehaviorKey, kind: BehaviorFailureKind): void {
  if (!isEnabled(key)) return
  const previous = readBehaviorFailure(key)
  const consecutiveFailures = Math.min((previous?.consecutiveFailures ?? 0) + 1, 31)
  const delayMs = Math.min(
    BEHAVIOR_RETRY_BASE_MS * (2 ** Math.min(consecutiveFailures - 1, 20)),
    BEHAVIOR_RETRY_MAX_MS,
  )
  const now = Date.now()
  setMeta(failureKey(key), JSON.stringify({
    kind,
    consecutiveFailures,
    lastFailureAtMs: now,
    nextRetryAtMs: now + delayMs,
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
  return note ? ['--note', note] : []
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
  behavior: 'review-new-prs' | 'approve-prs'
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
  return behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve'
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
  behavior: ActiveClaim['behavior'],
): Promise<void> {
  const claims = listBehaviorLaunchClaims(behavior)
  if (claims.length === 0) return

  let logs: Awaited<ReturnType<typeof fetchAgentLogs>>
  try {
    logs = await fetchAgentLogs({ signal: behaviorSignal() })
  } catch (error) {
    const message = `agent log reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`
    for (const claim of claims) retainClaimSafely(claim, message)
    throw error
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
        deadLetterClaim(
          claim,
          'linked agent call is missing from the durable log; retained to prevent duplicate launch',
        )
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
    const terminal = status === 'completed' || FAILED_AGENT_STATUSES.has(status)
    if (!terminal && Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
      const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker')
        claudeAuth.observeProcessFailure({ code: 1, signal: null, error: new Error(message) })
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
        claudeAuth.observeProcessFailure(message)
      }
    } else if (RUNNING_AGENT_STATUSES.has(status)) {
      setBehaviorLaunchErrorOwned(claim.key, claim.target, claim.claimId, null)
      renewSeenOwned(
        claim.key,
        claim.target,
        claim.claimId,
        BEHAVIOR_CLAIM_RENEWAL_MS,
      )
    } else {
      const message = `unrecognized agent call status "${status || 'missing'}"`
      if (deadLetterClaim(claim, message)) {
        recordBehaviorFailure(behavior, 'worker')
        claudeAuth.observeProcessFailure(message)
      }
    }
  }
}

// ── review-new-prs implementation ───────────────────────────────────────

interface DatastorePr {
  repo: string
  number: number
  url: string
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
    ['view', 'pr', '--status', 'open', '--author', author, '--format', 'json'],
    { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024, signal: behaviorSignal() },
  )
  const parsed = parseJson(stdout, 'github-datastore view pr')
  if (!Array.isArray(parsed)) throw new Error('github-datastore view pr returned a non-array')
  const seen = new Set<string>()
  return parsed.map((row, index) => {
    const value = objectValue(row, `github-datastore PR row ${index}`)
    const repo = String(value.repo || '')
    const number = safeInteger(value.number, `github-datastore PR row ${index} number`)
    const url = String(value.url || '')
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)
      || number < 1
      || value.status !== 'open'
      || value.author !== author
      || url !== `https://github.com/${repo}/pull/${number}`) {
      throw new Error(`github-datastore PR row ${index} violates the candidate contract`)
    }
    const key = `${repo}#${number}`
    if (seen.has(key)) throw new Error(`github-datastore returned duplicate PR ${key}`)
    seen.add(key)
    return { repo, number, url }
  })
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
  behavior: 'review-new-prs' | 'approve-prs',
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
    console.error(`[behaviors] ${behavior} worker exited for ${target}; awaiting durable result (${outcome})`)
  }
}

async function fireReview(
  pr: DatastorePr,
  setting: BehaviorSetting,
  claimTarget: string,
  claimId: string,
): Promise<boolean> {
  if (!isEnabled('review-new-prs')) return false
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const actor = configuredReviewer()
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  const pwd = await localCheckoutPath(owner, repo)
  // mkdir the cwd hack dir — agent-interface needs it to exist for
  // --pwd resolution behavior identical to triggerPrReview in agent.ts.
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('review-new-prs')) return false
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('review-new-prs') || behaviorAborted()) return false
  const expectedHead = await currentHeadSha(pr.repo, pr.number, actor)
  // Pass the priority ceiling through as `--p`. agent-interface forwards
  // it to github-interface as `--p <value>`; for review-new-prs the
  // possible values are p0 / p1 / p2.
  const source = 'poise:review-new-prs'
  const args = [
    '--pr-review',
    `#${num}`,
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

async function recoverFailedSnapshotReviews(
  prs: DatastorePr[],
  reviewer: string,
): Promise<void> {
  if (getMeta(FAILED_SNAPSHOT_RECOVERY_META) === '1') return
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
      if (!completed && failedBeforeSnapshot) {
        releaseSeen('review-new-prs', candidate.target)
      }
    }
  }
  setMeta(FAILED_SNAPSHOT_RECOVERY_META, '1')
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
  const setting = getSetting('review-new-prs')
  try {
    const prs = await listOpenPrsByAuthor(author)
    await recoverFailedSnapshotReviews(prs, reviewer)
    let failure: unknown
    for (const pr of prs) {
      if (!isEnabled('review-new-prs') || behaviorAborted()) return
      try {
        const key = `${pr.repo}#${pr.number}`
        // Atomic claim: exactly one caller succeeds for any given key
        // across all concurrent runtimes. Losers skip silently.
        const claimId = claimSeenOwned('review-new-prs', key)
        if (!claimId) continue
        trackClaim('review-new-prs', key, claimId)

        try {
          // Guard against double-firing with approve-prs: if bit-mis has
          // an outstanding CHANGES_REQUESTED on this PR, the follow-up
          // loop is approve-prs's job. This is an intentional terminal skip,
          // so its claim is retained.
          if (reviewer) {
            try {
              const ch = await checkChangesAddressed(pr.repo, pr.number, reviewer)
              if (!isEnabled('review-new-prs')) {
                releaseOwnedClaim('review-new-prs', key, claimId)
                return
              }
              if (ch.hasChangeRequest) {
                completeOwnedClaim('review-new-prs', key, claimId)
                console.log(`[behaviors] review-new-prs skipped for ${pr.repo}#${pr.number} — outstanding CHANGES_REQUESTED, approve-prs owns it`)
                continue
              }
            } catch (err) {
              if (behaviorAborted()) {
                releaseOwnedClaim('review-new-prs', key, claimId)
                return
              }
              releaseOwnedClaim('review-new-prs', key, claimId)
              throw err
            }
          }

          const launched = await fireReview(pr, setting, key, claimId)
          if (!launched) {
            releaseOwnedClaim('review-new-prs', key, claimId)
            return
          }
          console.log(`[behaviors] review-new-prs fired for ${pr.repo}#${pr.number} (p=${setting})`)
          // Keep one durable in-flight worker per behavior. The next target is
          // considered only after reconciliation observes completion.
          return
        } catch (err) {
          // Pre-launch work and spawn acknowledgement are part of the claim.
          // Release on failure so the next tick can retry this exact target.
          releaseOwnedClaim('review-new-prs', key, claimId)
          throw err
        }
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] review-new-prs step failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
      }
    }
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
// review starts a ten-minute quiet window; later PR activity moves that window
// forward, and the approval generation dedupes by its final anchor + head SHA.

export const APPROVAL_QUIET_WINDOW_MS = 10 * 60_000

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
  unresolvedConversationAuthors: string[]
  reviewerLatestState: string | null
  reviewerLatestCommit: string | null
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
    || data.unresolved_conversation_authors.some((value) => typeof value !== 'string')) {
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
  return {
    state: data.state,
    draft: data.draft,
    headSha: headSha.toLowerCase(),
    reviewerRequested: data.reviewer_requested,
    activeChangeRequestAuthors: data.active_change_request_authors.map(String),
    unresolvedConversationCount,
    unresolvedConversationAuthors: data.unresolved_conversation_authors.map(String),
    reviewerLatestState,
    reviewerLatestCommit,
    latestActivityAt,
  }
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
  const actor = configuredReviewer()
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  const pwd = await localCheckoutPath(owner, repo)
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('approve-prs')) return false
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('approve-prs') || behaviorAborted()) return false
  const currentHead = await currentHeadSha(pr.repo, pr.number, actor)
  if (currentHead !== expectedHead) {
    throw new Error(
      `approval head changed before launch: expected ${expectedHead}, got ${currentHead}`,
    )
  }
  const source = 'poise:approve-prs'
  const args = [
    '--pr-approve',
    `#${num}`,
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
    for (const pr of prs) {
      if (!isEnabled('approve-prs') || behaviorAborted()) return
      try {
        const check = await checkChangesAddressed(pr.repo, pr.number, reviewer)
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
          if (check.responseCount < 1 || check.latestRequestAt === null) continue
          const activity = await checkReviewActivity(
            pr.repo,
            pr.number,
            reviewer,
            check.latestRequestAt,
          )
          if (activity.state !== 'OPEN'
            || activity.draft
            || activity.headSha !== check.headSha
            || activity.unresolvedConversationAuthors.some(
              (author) => author.toLowerCase() !== reviewer.toLowerCase(),
            )) continue
          expectedHead = check.headSha
          seenTarget = `${pr.repo}#${pr.number}@req=${check.latestRequestAt}/r=${check.responseCount}/head=${check.headSha}`
          firedReason = `req=${check.latestRequestAt}, r=${check.responseCount}: ${check.commitsAfterRequest}c+${check.authorInlineRepliesAfterRequest}reply, head=${check.headSha.slice(0, 8)}`
        } else {
          const review = latestCleanReviewLaunch(pr.repo, pr.number)
          if (!review) continue
          const completedAtMs = Date.parse(review.completedAt)
          if (!Number.isFinite(completedAtMs)) {
            throw new Error(`invalid completed review timestamp for ${pr.repo}#${pr.number}`)
          }
          const activity = await checkReviewActivity(
            pr.repo,
            pr.number,
            reviewer,
            review.completedAt,
          )
          if (activity.state !== 'OPEN'
            || activity.draft
            || activity.activeChangeRequestAuthors.length > 0
            || activity.unresolvedConversationCount > 0
            || (activity.reviewerLatestState === 'APPROVED'
              && activity.reviewerLatestCommit === activity.headSha)) continue
          if (activity.headSha !== review.headSha && activity.latestActivityAt === null) {
            throw new Error(`head changed without an activity watermark for ${pr.repo}#${pr.number}`)
          }
          const latestActivityAtMs = activity.latestActivityAt === null
            ? completedAtMs
            : Date.parse(activity.latestActivityAt)
          const quietAnchorMs = Math.max(completedAtMs, latestActivityAtMs)
          if (Date.now() - quietAnchorMs < APPROVAL_QUIET_WINDOW_MS) continue
          const quietAnchor = new Date(quietAnchorMs).toISOString()
          expectedHead = activity.headSha
          seenTarget = `${pr.repo}#${pr.number}@quiet=${quietAnchor}/head=${activity.headSha}`
          firedReason = `clean review ${review.callId.slice(0, 8)}, quiet since ${quietAnchor}, head=${activity.headSha.slice(0, 8)}`
        }
        const claimId = claimSeenOwned('approve-prs', seenTarget)
        if (!claimId) continue
        trackClaim('approve-prs', seenTarget, claimId)
        try {
          const launched = await fireApprove(pr, seenTarget, claimId, expectedHead)
          if (!launched) {
            releaseOwnedClaim('approve-prs', seenTarget, claimId)
            return
          }
        } catch (err) {
          releaseOwnedClaim('approve-prs', seenTarget, claimId)
          throw err
        }
        console.log(`[behaviors] approve-prs fired for ${pr.repo}#${pr.number} (${firedReason})`)
        return
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] approve-prs check/fire failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
      }
    }
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
  const resolvedCount = safeInteger(data.resolved_count, 'resolve resolved_count')
  const unresolvedCount = safeInteger(data.unresolved_count, 'resolve unresolved_count')
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
  }
}

async function tickResolveUnblocking(): Promise<void> {
  if (!isEnabled('resolve-unblocking')) return
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    let failure: unknown
    for (const pr of prs) {
      if (!isEnabled('resolve-unblocking') || behaviorAborted()) return
      try {
        // This CLI performs the mutation itself. The synchronous flag check
        // immediately before invocation prevents a disabled behavior from
        // starting another resolve operation.
        if (!isEnabled('resolve-unblocking')) return
        const result = await resolveNonblockingIfReady(pr.repo, pr.number)
        if (result.resolved_count > 0) {
          const key = `${pr.repo}#${pr.number}`
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
        }
      } catch (err) {
        if (behaviorAborted()) return
        console.error(`[behaviors] resolve-unblocking failed for ${pr.repo}#${pr.number}:`, err)
        failure ??= err
      }
    }
    if (failure) throw failure
  } catch (err) {
    console.error('[behaviors] resolve-unblocking tick failed:', err)
    throw err
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
            // Snapshot first so an active launch row survives INSERT OR IGNORE;
            // reconciliation may then release a known failure for the next tick.
            await snapshotReviewNewPrs()
            await reconcileBehaviorLaunchClaims(key)
          } else {
            clearSeenExceptLaunched(key)
          }
        } else if (key === 'approve-prs') {
          if (enabled) await reconcileBehaviorLaunchClaims(key)
          else clearSeenExceptLaunched(key)
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
    recordBehaviorFailure(key, 'operation')
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
  const run = previous.then(execute, execute)
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
      recordBehaviorFailure(key, 'operation')
      console.error(`[behaviors] ${key} operation failed:`, error)
    }
  }
}

export async function runEnabledBehaviorsOnce(
  options: RunEnabledBehaviorsOptions = {},
): Promise<void> {
  const operations: Promise<void>[] = []
  if (isEnabled('review-new-prs')
    && (!options.skipBusy || !behaviorOperationTails.has('review-new-prs'))) {
    operations.push(runBehaviorCycle('review-new-prs', async () => {
      return await withBehaviorProcessLock('review-new-prs', async () => {
        await reconcileBehaviorLaunchClaims('review-new-prs')
        if (!behaviorRetryDue('review-new-prs')) return false
        if (listBehaviorLaunchClaims('review-new-prs').length > 0) return false
        if (claudeAuth.snapshot().status !== 'authenticated') return false
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
        if (listBehaviorLaunchClaims('approve-prs').length > 0) return false
        if (claudeAuth.snapshot().status !== 'authenticated') return false
        await tickApprovePrs()
        return listBehaviorLaunchClaims('approve-prs').length === 0
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
  }>
  datastore: DatastoreFreshness
  identity: {
    status: 'valid' | 'invalid'
    actor: string | null
    error: string | null
  }
  deadLetters: ReturnType<typeof listBehaviorDeadLetters>
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
    }] : []
  })
  const anyEnabled = BEHAVIOR_KEYS.some(isEnabled)
  let reviewer: string | null = null
  try {
    reviewer = getReviewAgentUsername()
  } catch {
    reviewer = null
  }
  const identityValid = reviewer !== null
  const identity = {
    status: identityValid ? 'valid' as const : 'invalid' as const,
    actor: reviewer,
    error: identityValid ? null : 'REVIEW_AGENT_USERNAME is missing or invalid',
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
    deadLetters: listBehaviorDeadLetters(),
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
