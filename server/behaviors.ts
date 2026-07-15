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
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { fetchAgentLogs } from './agent'
import { claudeAuth } from './claude-auth'
import {
  claimSeenOwned,
  clearSeen,
  clearSeenExceptLaunched,
  completeSeenOwned,
  getMeta,
  hasSeen,
  linkBehaviorLaunchCallOwned,
  listBehaviorLaunchClaims,
  markBehaviorLaunchIntentOwned,
  recordSeen,
  releaseSeen,
  releaseSeenOwned,
  renewSeenOwned,
  setBehaviorLaunchErrorOwned,
  setMeta,
  type BehaviorAgentLaunch,
  type BehaviorLaunchClaim,
} from './db'
import { getHeadSha } from './gh'
import { HttpError } from './http'
import { claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'
import { withProcessLock } from './process-lock'

const DATASTORE = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const AGENT_INTERFACE = 'agent-interface'
const GH = 'gh'
const REVIEW_SNAPSHOT_TARGET = '__snapshot_v2__'
const BEHAVIOR_AUTH_FRESHNESS_MS = 60_000
const REQUESTED_REVIEW_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    state isDraft mergeable headRefOid
    reviewRequests(first:100){pageInfo{hasNextPage} nodes{requestedReviewer{... on User{login}}}}
    latestReviews(first:100){pageInfo{hasNextPage} nodes{author{login} state}}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  }}
}`

// Same cwd hack agent.ts uses — agent-interface infers the repo from
// cwd's last two path parts when no git remote is found.
const GH_INTERFACE_CWD_ROOT = join(tmpdir(), 'poise-gh-interface')
function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

function behaviorProcessLockPath(behavior: 'review-new-prs' | 'approve-prs'): string {
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
  behavior: 'review-new-prs' | 'approve-prs',
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
  return failure === null || Date.now() >= failure.nextRetryAtMs
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

function upstreamBehavior(behavior: ActiveClaim['behavior']): BehaviorAgentLaunch {
  return behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve'
}

function markLaunchIntent(
  behavior: ActiveClaim['behavior'],
  pr: DatastorePr,
  target: string,
  claimId: string,
): boolean {
  return markBehaviorLaunchIntentOwned({
    key: behavior,
    target,
    claimId,
    launchBehavior: upstreamBehavior(behavior),
    repo: pr.repo,
    pr: pr.number,
    requestedAt: new Date().toISOString(),
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
  return completeSeenOwned(claim.key, claim.target, claim.claimId)
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
      || (claim.launchCallId !== null && !/^[0-9a-f]{32}$/.test(claim.launchCallId))) {
      completeClaimSafely(claim, 'launch correlation metadata is invalid; retained to prevent duplicate launch')
      continue
    }
    const requestedAtMs = Date.parse(claim.launchRequestedAt)
    if (!Number.isFinite(requestedAtMs)) {
      completeClaimSafely(claim, 'launch watermark is invalid; retained to prevent duplicate launch')
      continue
    }
    let call = claim.launchCallId
      ? logs.find((row) => String(row.id || '').toLowerCase() === claim.launchCallId)
      : undefined

    if (claim.launchCallId && !call) {
      completeClaimSafely(claim, 'linked agent call is missing from the durable log; retained to prevent duplicate launch')
      continue
    }
    if (call) {
      const linkedStartedAtMs = Date.parse(String(call.started_at || ''))
      if (call.behavior !== claim.launchBehavior
        || call.repo !== claim.launchRepo
        || String(call.pr_id || '') !== String(claim.launchPr)
        || !Number.isFinite(linkedStartedAtMs)
        || linkedStartedAtMs < requestedAtMs) {
        completeClaimSafely(claim, 'linked agent call no longer matches launch correlation; retained to prevent duplicate launch')
        continue
      }
    }

    if (!call) {
      const candidates = new Map<string, (typeof logs)[number]>()
      for (const row of logs) {
        const callId = String(row.id || '').toLowerCase()
        const startedAtMs = Date.parse(String(row.started_at || ''))
        if (row.behavior !== claim.launchBehavior
          || row.repo !== claim.launchRepo
          || String(row.pr_id || '') !== String(claim.launchPr)
          || !/^[0-9a-f]{32}$/.test(callId)
          || !Number.isFinite(startedAtMs)
          || startedAtMs < requestedAtMs) continue
        candidates.set(callId, row)
      }

      if (candidates.size > 1) {
        completeClaimSafely(
          claim,
          `ambiguous agent call registration (${candidates.size} exact post-launch candidates); retained to prevent duplicate launch`,
        )
        continue
      }
      if (candidates.size === 0) {
        const ageMs = Date.now() - requestedAtMs
        if (ageMs < BEHAVIOR_REGISTRATION_GRACE_MS) {
          retainClaimSafely(claim, 'awaiting agent call registration')
        } else {
          if (releaseSeenOwned(claim.key, claim.target, claim.claimId)) {
            recordBehaviorFailure(behavior, 'worker')
          }
        }
        continue
      }

      const [callId, candidate] = candidates.entries().next().value as [
        string,
        (typeof logs)[number],
      ]
      if (!linkBehaviorLaunchCallOwned(claim.key, claim.target, claim.claimId, callId)) {
        continue
      }
      call = candidate
    }

    const status = String(call.status || '').toLowerCase()
    const terminal = status === 'completed' || FAILED_AGENT_STATUSES.has(status)
    if (!terminal && Date.now() - requestedAtMs >= BEHAVIOR_CLAIM_RENEWAL_MS) {
      const message = `behavior launch exceeded ${BEHAVIOR_CLAIM_RENEWAL_MS}ms running limit`
      if (releaseSeenOwned(claim.key, claim.target, claim.claimId)) {
        recordBehaviorFailure(behavior, 'worker')
        claudeAuth.observeProcessFailure({ code: 1, signal: null, error: new Error(message) })
      }
      continue
    }
    if (status === 'completed') {
      if (completeClaimSafely(claim)) clearBehaviorFailure(behavior)
    } else if (FAILED_AGENT_STATUSES.has(status)) {
      if (releaseSeenOwned(claim.key, claim.target, claim.claimId)) {
        recordBehaviorFailure(behavior, 'worker')
        claudeAuth.observeProcessFailure(String(call.error || status))
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
      retainClaimSafely(claim, `unrecognized agent call status "${status || 'missing'}"`)
    }
  }
}

// ── review-new-prs implementation ───────────────────────────────────────

interface DatastorePr {
  repo: string
  number: number
  url: string
}

async function listOpenPrsByAuthor(author: string): Promise<DatastorePr[]> {
  if (!author) return []
  const { stdout } = await runFile(
    DATASTORE,
    ['view', 'pr', '--status', 'open', '--author', author, '--limit', '500', '--format', 'json'],
    { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024, signal: behaviorSignal() },
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const list = JSON.parse(trimmed) as Array<{ repo: string, number: number, url: string }>
  return list.map((r) => ({ repo: r.repo, number: r.number, url: r.url }))
}

async function localCheckoutPath(owner: string, repo: string): Promise<string> {
  const { stdout } = await runFile(GH_INTERFACE, ['--local-checkout-path', owner, repo], {
    timeoutMs: 30_000,
    maxOutputBytes: 1 * 1024 * 1024,
    signal: behaviorSignal(),
  })
  const result = JSON.parse(stdout)
  if (!result.path) throw new Error('github-interface --local-checkout-path returned no path')
  return String(result.path)
}

function settleClaimAfterExit(
  behavior: 'review-new-prs' | 'approve-prs',
  target: string,
  claimId: string,
): (result: { code: number | null, signal: NodeJS.Signals | null, error?: Error }) => void {
  return ({ code, signal, error }) => {
    if (!error && signal === null && code === 0) {
      if (completeOwnedClaim(behavior, target, claimId)) clearBehaviorFailure(behavior)
      return
    }
    const released = releaseOwnedClaim(behavior, target, claimId)
    if (released) {
      recordBehaviorFailure(behavior, 'worker')
      claudeAuth.observeProcessFailure({ code, signal, error })
    }
    const outcome = error?.message || signal || `exit ${code ?? 'unknown'}`
    console.error(`[behaviors] ${behavior} worker failed for ${target}; ${released ? 'claim released' : 'claim already superseded'} (${outcome})`)
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
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  const pwd = await localCheckoutPath(owner, repo)
  // mkdir the cwd hack dir — agent-interface needs it to exist for
  // --pwd resolution behavior identical to triggerPrReview in agent.ts.
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('review-new-prs')) return false
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('review-new-prs') || behaviorAborted()) return false
  // Pass the priority ceiling through as `--p`. agent-interface forwards
  // it to github-interface as `--p <value>`; for review-new-prs the
  // possible values are p0 / p1 / p2.
  const args = ['--pr-review', `#${num}`, '--pwd', pwd, '--p', setting, ...noteArgs('review-new-prs')]
  if (!markLaunchIntent('review-new-prs', pr, claimTarget, claimId)) return false
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
    let complete = true
    let failure: unknown
    for (const p of prs) {
      if (behaviorAborted()) {
        complete = false
        failure = behaviorSignal()?.reason
        break
      }
      try {
        const sha = await getHeadSha(p.repo, p.number, { signal: behaviorSignal() })
        recordSeen('review-new-prs', `${p.repo}#${p.number}@${sha}`)
      } catch (err) {
        complete = false
        failure ??= err
        // Couldn't get head_sha right now — skip silently; the next
        // tick will re-attempt and either snapshot or claim. Better
        // to under-stamp the snapshot than to leave an unsuffixed key
        // that would never match the new format.
        console.warn(`[behaviors] snapshot head_sha failed for ${p.repo}#${p.number}:`, err)
      }
    }
    // A real marker distinguishes an intentionally empty snapshot from
    // "snapshot has never completed". Without it, the first PR created in
    // an initially empty repository was silently absorbed by a later
    // snapshot instead of triggering the behavior.
    if (complete) recordSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
    else {
      releaseSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
      throw failure ?? new Error('review snapshot did not complete')
    }
  } catch (err) {
    releaseSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)
    console.error('[behaviors] snapshot failed:', err)
    throw err
  }
}

async function tickReviewNewPrs(): Promise<void> {
  if (!isEnabled('review-new-prs')) return
  const author = getMeta('me') || ''
  if (!author) return
  const reviewer = reviewAgentUsername

  // The dedupe key shape changed in keyver=2: from `${repo}#${number}`
  // to `${repo}#${number}@${head_sha}`, so a force-push (or any new
  // commit) is recognised as a fresh target for re-review. Without
  // this migration, every currently-open PR would fire on the very
  // next tick after deploy (their old keys don't match the new
  // shape). Wipe + re-snapshot brings the ledger in sync with the
  // current head of each open PR; subsequent ticks then only see new
  // shas as new work.
  if (getMeta('behavior_review_new_prs_keyver') !== '2') {
    clearSeen('review-new-prs')
    setMeta('behavior_review_new_prs_keyver', '2')
    await snapshotReviewNewPrs()
    return
  }

  // First tick after boot/enable with no snapshot — take one and bail.
  if (!hasSeen('review-new-prs', REVIEW_SNAPSHOT_TARGET)) {
    await snapshotReviewNewPrs()
    return
  }
  const setting = getSetting('review-new-prs')
  try {
    const prs = await listOpenPrsByAuthor(author)
    let failure: unknown
    for (const pr of prs) {
      if (!isEnabled('review-new-prs') || behaviorAborted()) return
      try {
        const sha = await getHeadSha(pr.repo, pr.number, { signal: behaviorSignal() })
        if (!isEnabled('review-new-prs') || behaviorAborted()) return
        const key = `${pr.repo}#${pr.number}@${sha}`
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
              if (ch.has_change_request) {
                completeOwnedClaim('review-new-prs', key, claimId)
                console.log(`[behaviors] review-new-prs skipped for ${pr.repo}#${pr.number}@${sha.slice(0, 8)} — outstanding CHANGES_REQUESTED, approve-prs owns it`)
                continue
              }
            } catch (err) {
              if (behaviorAborted()) {
                releaseOwnedClaim('review-new-prs', key, claimId)
                return
              }
              // If the check itself fails (rate-limit / network), fall
              // through and fire — over-reviewing is the safer regression.
              console.warn(`[behaviors] checkChangesAddressed failed for ${pr.repo}#${pr.number}, firing anyway:`, err)
            }
          }

          const launched = await fireReview(pr, setting, key, claimId)
          if (!launched) {
            releaseOwnedClaim('review-new-prs', key, claimId)
            return
          }
          console.log(`[behaviors] review-new-prs fired for ${pr.repo}#${pr.number}@${sha.slice(0, 8)} (p=${setting})`)
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
// Follow-ups dedupe by request timestamp + response count; initial requests
// dedupe by configured reviewer + head SHA. We do NOT take a snapshot on
// enable: already-eligible PRs should fire immediately. claimSeen prevents
// repeats and the runtime permits only one durable worker at a time.

interface ChangesAddressedResult {
  has_change_request: boolean
  latest_request_at: string
  // Both counters reset to 0 whenever the reviewer posts another
  // review (latest_request_at advances) and strictly increase as the
  // author engages — either by pushing a commit or by replying to a
  // review thread. Either kind of engagement counts as a "response"
  // worth re-evaluating, so the dedupe key keys off the sum.
  author_commits_after_request: number
  author_inline_replies_after_request: number
}

interface RequestedReviewResult {
  requested: boolean
  headSha: string
}

async function resolveReviewAgentToken(reviewer: string): Promise<string> {
  const { stdout } = await runFile(
    GH,
    ['auth', 'token', '--hostname', 'github.com', '--user', reviewer],
    {
      env: {
        GH_HOST: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined,
        GITHUB_ENTERPRISE_TOKEN: undefined,
      },
      timeoutMs: 15_000,
      maxOutputBytes: 1 * 1024 * 1024,
      signal: behaviorSignal(),
    },
  )
  const token = stdout.trim()
  if (!token) throw new Error(`gh returned no github.com token for ${reviewer}`)
  return token
}

function reviewAgentGhEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    GH_HOST: 'github.com',
    GH_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  }
}

async function checkRequestedReview(
  repo: string,
  number: number,
  reviewer: string,
  token: string,
): Promise<RequestedReviewResult> {
  const [owner, name] = repo.split('/', 2)
  if (!owner || !name) throw new Error(`invalid GitHub repository: ${repo}`)
  const env = reviewAgentGhEnvironment(token)
  try {
    const { stdout } = await runFile(
      GH,
      [
        'api', 'graphql',
        '-f', `query=${REQUESTED_REVIEW_QUERY}`,
        '-f', `owner=${owner}`,
        '-f', `repo=${name}`,
        '-F', `number=${number}`,
      ],
      {
        env,
        timeoutMs: 30_000,
        maxOutputBytes: 1 * 1024 * 1024,
        signal: behaviorSignal(),
      },
    )
    const pull = JSON.parse(stdout.trim() || '{}')?.data?.repository?.pullRequest
    if (!pull) throw new Error(`GitHub returned no pull request for ${repo}#${number}`)
    const requests = pull.reviewRequests
    const reviews = pull.latestReviews
    const reviewerLower = reviewer.toLowerCase()
    const requested = pull.state === 'OPEN'
      && pull.isDraft === false
      && pull.mergeable === 'MERGEABLE'
      && requests?.pageInfo?.hasNextPage === false
      && reviews?.pageInfo?.hasNextPage === false
      && requests.nodes.some((node: any) => String(node?.requestedReviewer?.login || '').toLowerCase() === reviewerLower)
    const headSha = String(pull.headRefOid || '')
    if (requested && !headSha) throw new Error('GitHub returned a requested review without a head SHA')
    if (!requested) return { requested: false, headSha }

    // A request for this identity is a separate trigger; another identity's
    // CHANGES_REQUESTED must never be treated as this reviewer's feedback.
    // Fail closed while any other reviewer still has an active blocking
    // review. Once that review is dismissed/superseded, the explicit request
    // can progress without inheriting the other account's state.
    const blockedByOtherReviewer = reviews.nodes.some(
      (review: any) => String(review?.author?.login || '').toLowerCase() !== reviewerLower
        && review?.state === 'CHANGES_REQUESTED',
    )
    const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup
    const ciGreen = !rollup || rollup.state === 'SUCCESS'
    return { requested: !blockedByOtherReviewer && ciGreen, headSha }
  } catch (error: any) {
    const raw = error?.stderr?.toString?.() || error?.message || String(error)
    throw new Error(String(raw).split(token).join('***'))
  }
}

async function checkChangesAddressed(repo: string, number: number, reviewer: string): Promise<ChangesAddressedResult> {
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await runFile(
    GH_INTERFACE,
    ['--requested-changes-addressed', `#${number}`, '--username', reviewer],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = JSON.parse(stdout.trim() || '{}')
  return {
    has_change_request: !!data.has_change_request,
    latest_request_at: String(data.latest_request_at || ''),
    author_commits_after_request: Number(data.author_commits_after_request || 0),
    author_inline_replies_after_request: Number(data.author_inline_replies_after_request || 0),
  }
}

async function fireApprove(pr: DatastorePr, claimTarget: string, claimId: string): Promise<boolean> {
  if (!isEnabled('approve-prs')) return false
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  const pwd = await localCheckoutPath(owner, repo)
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  if (!isEnabled('approve-prs')) return false
  await waitForBehavior(claudeAuth.requireReady({ liveWithinMs: BEHAVIOR_AUTH_FRESHNESS_MS }))
  if (!isEnabled('approve-prs') || behaviorAborted()) return false
  const args = ['--pr-approve', `#${num}`, '--pwd', pwd, ...noteArgs('approve-prs')]
  if (!markLaunchIntent('approve-prs', pr, claimTarget, claimId)) return false
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
  const reviewer = reviewAgentUsername
  if (!author || !reviewer) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    let failure: unknown
    let reviewAgentToken: Promise<string> | null = null
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
        if (check.has_change_request) {
          const responses = check.author_commits_after_request + check.author_inline_replies_after_request
          if (responses < 1) continue
          seenTarget = `${pr.repo}#${pr.number}@req=${check.latest_request_at}/r=${responses}`
          firedReason = `req=${check.latest_request_at}, r=${responses}: ${check.author_commits_after_request}c+${check.author_inline_replies_after_request}reply`
        } else {
          // Initial approval trigger: this exact configured identity must be
          // explicitly requested. Require a conflict-free head and fully green
          // CI before spending a model run; the agent still performs the final
          // correctness review and owns the approve/request-changes decision.
          reviewAgentToken ??= resolveReviewAgentToken(reviewer)
          const requested = await checkRequestedReview(
            pr.repo,
            pr.number,
            reviewer,
            await reviewAgentToken,
          )
          if (!requested.requested) continue
          seenTarget = `${pr.repo}#${pr.number}@requested=${reviewer.toLowerCase()}/head=${requested.headSha}`
          firedReason = `requested=${reviewer}, head=${requested.headSha.slice(0, 8)}, ci=green`
        }
        const claimId = claimSeenOwned('approve-prs', seenTarget)
        if (!claimId) continue
        trackClaim('approve-prs', seenTarget, claimId)
        try {
          const launched = await fireApprove(pr, seenTarget, claimId)
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
  const { stdout } = await runFile(
    GH_INTERFACE,
    ['--resolve-nonblocking-conversations-if-ready', `#${number}`],
    { cwd, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal: behaviorSignal() },
  )
  const data = JSON.parse(stdout.trim() || '{}')
  return {
    ready_except_conversations: !!data.ready_except_conversations,
    resolved_count: Number(data.resolved_count || 0),
    unresolved_count: Number(data.unresolved_count || 0),
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
      if (key === 'resolve-unblocking') await update()
      else await withBehaviorProcessLock(key, update)
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

// Identity the bot uses on GitHub — passed through from cachePlugin's
// opts (which read it via Vite's loadEnv at config time). We can NOT
// pull it from process.env here: Vite's loadEnv populates the plugin
// options object but does not inject the var into process.env, so a
// tickApprovePrs reading process.env.REVIEW_AGENT_USERNAME silently
// finds it empty and never fires. This module-level slot is the
// single source of truth at runtime — set once by startBehaviorsRuntime.
let reviewAgentUsername = ''

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
    if (recovered) clearBehaviorFailure(key)
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
      await tickResolveUnblocking()
      return true
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
  return {
    status: tickerStarted && !heartbeatStale && !operationStale && failures.length === 0
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
  }
}

export interface BehaviorsRuntimeConfig {
  reviewAgentUsername?: string
}

export function startBehaviorsRuntime(config: BehaviorsRuntimeConfig = {}): void {
  if (tickerStarted) return
  tickerStarted = true
  behaviorAbortController = new AbortController()
  runtimeGeneration += 1
  const generation = runtimeGeneration
  runtimeStartedAtMs = Date.now()
  lastTickAtMs = null
  lastTickCompletedAtMs = null
  reviewAgentUsername = String(config.reviewAgentUsername || '')
  // Preserve an existing completed ledger across restart. Otherwise a PR
  // opened while Poise was down is absorbed into a new snapshot and never
  // reviewed. A genuinely missing marker still takes the anti-flood snapshot.
  if (isEnabled('review-new-prs')) {
    void runBehaviorCycle('review-new-prs', async () => {
      return await withBehaviorProcessLock('review-new-prs', async () => {
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
