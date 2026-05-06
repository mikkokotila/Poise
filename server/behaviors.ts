// Server-side behavior runtime. Lives in the Vite dev-server middleware
// so the toggle keeps working when the browser tab is closed,
// reloaded, or backgrounded — none of which the original
// browser-side runtime survived.
//
// Mirrors the browser's wall-clock-aligned ticker (see src/config.ts
// `startRefreshTicker`) but in Node. On every tick, each enabled
// behavior runs its check; the seen-set lives in process memory so
// the dev server snapshots the current world on first run after boot
// and only fires for items that appear AFTER.
//
// Today's only behavior is "review-new-prs": list open PRs by the
// configured Poise user, find any not in the snapshot, spawn
// `agent-interface --pr-review '#<n>' --pwd <local-checkout>`
// directly — no HTTP roundtrip, no /api/pr-review hop.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { getMeta, setMeta, claimSeen, recordSeen, hasSeenAny, clearSeen } from './db'

const execFileP = promisify(execFile)
const DATASTORE = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const AGENT_INTERFACE = 'agent-interface'

// Same cwd hack agent.ts uses — agent-interface infers the repo from
// cwd's last two path parts when no git remote is found.
const GH_INTERFACE_CWD_ROOT = join(tmpdir(), 'poise-gh-interface')
function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

export type BehaviorKey = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking'
export const BEHAVIOR_KEYS: BehaviorKey[] = ['review-new-prs', 'approve-prs', 'resolve-unblocking']

// ── Persistence ─────────────────────────────────────────────────────────
// Enabled flag survives dev-server restarts via the meta table in
// cache.db. The seen-set does NOT persist — a restart re-snapshots so
// PRs that opened during downtime aren't all flooded.

const META_PREFIX = 'behavior_'

function enabledKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_enabled' }
function settingKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_setting' }
function lastFiredAtKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_last_at' }
function lastFiredTargetKey(k: BehaviorKey): string { return META_PREFIX + k.replace(/-/g, '_') + '_last_target' }

export function isEnabled(key: BehaviorKey): boolean {
  return getMeta(enabledKey(key)) === '1'
}

function setPersistedEnabled(key: BehaviorKey, enabled: boolean) {
  setMeta(enabledKey(key), enabled ? '1' : '0')
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

// Last-fired metadata — lets the Behaviors view show "X minutes ago"
// and link to the matching row in Swarm. Recorded immediately after a
// successful spawn; stored as ISO timestamp + a "repo#num" target
// string for cross-referencing the agent-interface log.
export interface LastFired { at: string; target: string }

export function getLastFired(key: BehaviorKey): LastFired | null {
  const at = getMeta(lastFiredAtKey(key))
  const target = getMeta(lastFiredTargetKey(key))
  if (!at || !target) return null
  return { at, target }
}

function recordLastFired(key: BehaviorKey, target: string) {
  setMeta(lastFiredAtKey(key), new Date().toISOString())
  setMeta(lastFiredTargetKey(key), target)
}

export function getLastFiredMap(): Record<BehaviorKey, LastFired | null> {
  const out: Record<BehaviorKey, LastFired | null> = {} as any
  for (const k of BEHAVIOR_KEYS) out[k] = getLastFired(k)
  return out
}

// ── Dedupe ledger ──────────────────────────────────────────────────────
// Lives in SQLite (db.behavior_seen) instead of process memory so the
// claim is atomic across whatever runs the runtime: multiple vite dev
// servers, accidental tick re-entry inside one process, or even a
// datastore query that hands the same PR back twice. INSERT OR IGNORE
// on a (key,target) primary key makes "claim if new" a single atomic
// statement — exactly one caller wins, the rest skip.

// ── review-new-prs implementation ───────────────────────────────────────

interface DatastorePr {
  repo: string
  number: number
  url: string
}

async function listOpenPrsByAuthor(author: string): Promise<DatastorePr[]> {
  if (!author) return []
  const { stdout } = await execFileP(
    DATASTORE,
    ['view', 'pr', '--status', 'open', '--author', author, '--limit', '500', '--format', 'json'],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const list = JSON.parse(trimmed) as Array<{ repo: string, number: number, url: string }>
  return list.map((r) => ({ repo: r.repo, number: r.number, url: r.url }))
}

async function localCheckoutPath(owner: string, repo: string): Promise<string> {
  const { stdout } = await execFileP(GH_INTERFACE, ['--local-checkout-path', owner, repo], {
    maxBuffer: 1 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (!result.path) throw new Error('github-interface --local-checkout-path returned no path')
  return String(result.path)
}

async function fireReview(pr: DatastorePr, setting: BehaviorSetting): Promise<void> {
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const pwd = await localCheckoutPath(owner, repo)
  // mkdir the cwd hack dir — agent-interface needs it to exist for
  // --pwd resolution behavior identical to triggerPrReview in agent.ts.
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  // Pass the priority ceiling through as `--p`. agent-interface forwards
  // it to github-interface as `--p <value>`; for review-new-prs the
  // possible values are p0 / p1 / p2.
  const child = spawn(AGENT_INTERFACE, ['--pr-review', `#${num}`, '--pwd', pwd, '--p', setting], {
    cwd: agentInterfaceCwd(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function snapshotReviewNewPrs(): Promise<void> {
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    for (const p of prs) {
      recordSeen('review-new-prs', `${p.repo}#${p.number}`)
    }
  } catch (err) {
    console.error('[behaviors] snapshot failed:', err)
  }
}

async function tickReviewNewPrs(): Promise<void> {
  const author = getMeta('me') || ''
  if (!author) return
  // First tick after boot/enable with no snapshot — take one and bail.
  if (!hasSeenAny('review-new-prs')) {
    await snapshotReviewNewPrs()
    return
  }
  const setting = getSetting('review-new-prs')
  try {
    const prs = await listOpenPrsByAuthor(author)
    for (const pr of prs) {
      const key = `${pr.repo}#${pr.number}`
      // Atomic claim: exactly one caller succeeds for any given key
      // across all concurrent runtimes. Losers skip silently.
      if (!claimSeen('review-new-prs', key)) continue
      try {
        await fireReview(pr, setting)
        recordLastFired('review-new-prs', key)
        console.log(`[behaviors] review-new-prs fired for ${key} (p=${setting})`)
      } catch (err) {
        console.error(`[behaviors] fireReview failed for ${key}:`, err)
      }
    }
  } catch (err) {
    console.error('[behaviors] tick failed:', err)
  }
}

// ── approve-prs implementation ──────────────────────────────────────────
//
// For each open PR by the configured user, ask github-interface whether
// the review-agent's request-for-changes has been addressed since it was
// left. If yes, kick off `agent-interface --pr-approve` so the agent
// re-evaluates and (if happy) actually approves on GitHub.
//
// Dedupe target is `${repo}#${num}@${latest_request_at}` — the agent
// can leave a fresh round of change requests at any time, which bumps
// the timestamp and re-arms the behavior. We do NOT take a snapshot on
// enable: the user explicitly wants approval to fire for any
// already-addressed PR right away. claimSeen prevents repeats.

interface ChangesAddressedResult {
  has_change_request: boolean
  status: boolean
  latest_request_at: string
}

async function checkChangesAddressed(repo: string, number: number, reviewer: string): Promise<ChangesAddressedResult> {
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await execFileP(
    GH_INTERFACE,
    ['--requested-changes-addressed', `#${number}`, '--username', reviewer],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  )
  const data = JSON.parse(stdout.trim() || '{}')
  return {
    has_change_request: !!data.has_change_request,
    status: !!data.status,
    latest_request_at: String(data.latest_request_at || ''),
  }
}

async function fireApprove(pr: DatastorePr): Promise<void> {
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const pwd = await localCheckoutPath(owner, repo)
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  const child = spawn(AGENT_INTERFACE, ['--pr-approve', `#${num}`, '--pwd', pwd], {
    cwd: agentInterfaceCwd(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function tickApprovePrs(): Promise<void> {
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
    for (const pr of prs) {
      try {
        const check = await checkChangesAddressed(pr.repo, pr.number, reviewer)
        if (!check.has_change_request) continue   // nothing pending from reviewer
        if (!check.status)              continue   // pending but not addressed yet
        // Encode the request timestamp into the seen target so a new
        // round of change-requests (which moves latest_request_at)
        // re-arms approval — we want to re-evaluate, not stay quiet.
        const seenTarget = `${pr.repo}#${pr.number}@${check.latest_request_at}`
        if (!claimSeen('approve-prs', seenTarget)) continue
        await fireApprove(pr)
        // Last-triggered uses the bare repo#num so the link from the
        // Behaviors view still routes to Swarm correctly.
        recordLastFired('approve-prs', `${pr.repo}#${pr.number}`)
        console.log(`[behaviors] approve-prs fired for ${pr.repo}#${pr.number}`)
      } catch (err) {
        console.error(`[behaviors] approve-prs check/fire failed for ${pr.repo}#${pr.number}:`, err)
      }
    }
  } catch (err) {
    console.error('[behaviors] approve-prs tick failed:', err)
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

async function resolveNonblockingIfReady(repo: string, number: number): Promise<ResolveResult> {
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const { stdout } = await execFileP(
    GH_INTERFACE,
    ['--resolve-nonblocking-conversations-if-ready', `#${number}`],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  )
  const data = JSON.parse(stdout.trim() || '{}')
  return {
    ready_except_conversations: !!data.ready_except_conversations,
    resolved_count: Number(data.resolved_count || 0),
    unresolved_count: Number(data.unresolved_count || 0),
  }
}

async function tickResolveUnblocking(): Promise<void> {
  const author = getMeta('me') || ''
  if (!author) return
  try {
    const prs = await listOpenPrsByAuthor(author)
    for (const pr of prs) {
      try {
        const result = await resolveNonblockingIfReady(pr.repo, pr.number)
        if (result.resolved_count > 0) {
          const key = `${pr.repo}#${pr.number}`
          recordLastFired('resolve-unblocking', key)
          console.log(`[behaviors] resolve-unblocking cleared ${result.resolved_count} convo(s) on ${key}`)
        }
      } catch (err) {
        console.error(`[behaviors] resolve-unblocking failed for ${pr.repo}#${pr.number}:`, err)
      }
    }
  } catch (err) {
    console.error('[behaviors] resolve-unblocking tick failed:', err)
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export async function setEnabled(key: BehaviorKey, enabled: boolean): Promise<void> {
  setPersistedEnabled(key, enabled)
  if (key === 'review-new-prs') {
    if (enabled) {
      // Snapshot on enable so existing PRs don't all flood the agent.
      await snapshotReviewNewPrs()
    } else {
      // Wipe the ledger so a future re-enable starts from a fresh
      // snapshot, matching the previous in-memory behavior.
      clearSeen(key)
    }
  } else if (key === 'approve-prs') {
    // No snapshot on enable — the user wants approval to fire for
    // already-addressed PRs immediately. On disable, wipe the seen
    // ledger so a re-enable doesn't think it's already approved this
    // round of changes.
    if (!enabled) clearSeen(key)
  }
  // resolve-unblocking has no seen ledger — github-interface is
  // idempotent so the tick handler can safely fire every minute.
}

export function setSetting(key: BehaviorKey, setting: BehaviorSetting): void {
  setPersistedSetting(key, setting)
}

// Wall-clock-aligned ticker — mirrors src/config.ts startRefreshTicker.
// Fixed 60 s cadence here; the per-user UI refresh-rate (1m / 5m) is
// browser-only and not relevant to behavior cadence.
let tickerStarted = false
let tickTimer: ReturnType<typeof setTimeout> | null = null
const TICK_MS = 60_000

// Identity the bot uses on GitHub — passed through from cachePlugin's
// opts (which read it via Vite's loadEnv at config time). We can NOT
// pull it from process.env here: Vite's loadEnv populates the plugin
// options object but does not inject the var into process.env, so a
// tickApprovePrs reading process.env.REVIEW_AGENT_USERNAME silently
// finds it empty and never fires. This module-level slot is the
// single source of truth at runtime — set once by startBehaviorsRuntime.
let reviewAgentUsername = ''

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer)
  const now = Date.now()
  const nextBoundary = Math.ceil((now + 1) / TICK_MS) * TICK_MS
  tickTimer = setTimeout(async () => {
    try {
      if (isEnabled('review-new-prs'))     await tickReviewNewPrs()
      if (isEnabled('approve-prs'))        await tickApprovePrs()
      if (isEnabled('resolve-unblocking')) await tickResolveUnblocking()
    } catch (err) {
      console.error('[behaviors] tick handler error:', err)
    }
    scheduleNextTick()
  }, Math.max(0, nextBoundary - now))
}

export interface BehaviorsRuntimeConfig {
  reviewAgentUsername?: string
}

export function startBehaviorsRuntime(config: BehaviorsRuntimeConfig = {}): void {
  if (tickerStarted) return
  tickerStarted = true
  reviewAgentUsername = String(config.reviewAgentUsername || '')
  // If a behavior was on from a prior dev-server run, take a fresh
  // snapshot so PRs that opened during downtime aren't auto-reviewed.
  if (isEnabled('review-new-prs')) {
    void snapshotReviewNewPrs()
  }
  scheduleNextTick()
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
