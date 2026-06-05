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
import { getHeadSha } from './gh'

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
// behavior has no memory set. agent-interface ALREADY plumbs a `note`
// end-to-end into the agent prompt (run_pr_review → run_behavior →
// mod.run → prompt(cmd, tools, note)); the one missing link is that its
// main() doesn't yet read a `--note` flag, so today this fragment is
// accepted-but-ignored (agent-interface skips unknown trailing flags).
// Wiring `--note` there is a ~2-line change but lives in a separate repo
// — until it lands, the note is passed but does not reach the agent.
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
  const args = ['--pr-review', `#${num}`, '--pwd', pwd, '--p', setting, ...noteArgs('review-new-prs')]
  const child = spawn(AGENT_INTERFACE, args, {
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
      try {
        const sha = await getHeadSha(p.repo, p.number)
        recordSeen('review-new-prs', `${p.repo}#${p.number}@${sha}`)
      } catch (err) {
        // Couldn't get head_sha right now — skip silently; the next
        // tick will re-attempt and either snapshot or claim. Better
        // to under-stamp the snapshot than to leave an unsuffixed key
        // that would never match the new format.
        console.warn(`[behaviors] snapshot head_sha failed for ${p.repo}#${p.number}:`, err)
      }
    }
  } catch (err) {
    console.error('[behaviors] snapshot failed:', err)
  }
}

async function tickReviewNewPrs(): Promise<void> {
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
  if (!hasSeenAny('review-new-prs')) {
    await snapshotReviewNewPrs()
    return
  }
  const setting = getSetting('review-new-prs')
  try {
    const prs = await listOpenPrsByAuthor(author)
    for (const pr of prs) {
      try {
        const sha = await getHeadSha(pr.repo, pr.number)
        const key = `${pr.repo}#${pr.number}@${sha}`
        // Atomic claim: exactly one caller succeeds for any given key
        // across all concurrent runtimes. Losers skip silently.
        if (!claimSeen('review-new-prs', key)) continue

        // Guard against double-firing with approve-prs: if bit-mis has
        // an outstanding CHANGES_REQUESTED on this PR, the follow-up
        // loop is approve-prs's job. The claim still consumed the key,
        // so we don't try again on the same head; approve-prs will
        // re-evaluate as the author commits accumulate.
        if (reviewer) {
          try {
            const ch = await checkChangesAddressed(pr.repo, pr.number, reviewer)
            if (ch.has_change_request) {
              console.log(`[behaviors] review-new-prs skipped for ${pr.repo}#${pr.number}@${sha.slice(0, 8)} — outstanding CHANGES_REQUESTED, approve-prs owns it`)
              continue
            }
          } catch (err) {
            // If the check itself fails (rate-limit / network), fall
            // through and fire — over-reviewing is the safer regression.
            console.warn(`[behaviors] checkChangesAddressed failed for ${pr.repo}#${pr.number}, firing anyway:`, err)
          }
        }

        await fireReview(pr, setting)
        console.log(`[behaviors] review-new-prs fired for ${pr.repo}#${pr.number}@${sha.slice(0, 8)} (p=${setting})`)
      } catch (err) {
        console.error(`[behaviors] review-new-prs step failed for ${pr.repo}#${pr.number}:`, err)
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
  latest_request_at: string
  // Both counters reset to 0 whenever the reviewer posts another
  // review (latest_request_at advances) and strictly increase as the
  // author engages — either by pushing a commit or by replying to a
  // review thread. Either kind of engagement counts as a "response"
  // worth re-evaluating, so the dedupe key keys off the sum.
  author_commits_after_request: number
  author_inline_replies_after_request: number
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
    latest_request_at: String(data.latest_request_at || ''),
    author_commits_after_request: Number(data.author_commits_after_request || 0),
    author_inline_replies_after_request: Number(data.author_inline_replies_after_request || 0),
  }
}

async function fireApprove(pr: DatastorePr): Promise<void> {
  const m = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url: ' + pr.url)
  const [, owner, repo, num] = m
  const pwd = await localCheckoutPath(owner, repo)
  await mkdir(join(GH_INTERFACE_CWD_ROOT, owner, repo), { recursive: true })
  const args = ['--pr-approve', `#${num}`, '--pwd', pwd, ...noteArgs('approve-prs')]
  const child = spawn(AGENT_INTERFACE, args, {
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
        // Trigger: reviewer has at least one CHANGES_REQUESTED review
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
        if (!check.has_change_request) continue
        const responses = check.author_commits_after_request + check.author_inline_replies_after_request
        if (responses < 1) continue
        const seenTarget = `${pr.repo}#${pr.number}@req=${check.latest_request_at}/r=${responses}`
        if (!claimSeen('approve-prs', seenTarget)) continue
        await fireApprove(pr)
        console.log(`[behaviors] approve-prs fired for ${pr.repo}#${pr.number} (req=${check.latest_request_at}, r=${responses}: ${check.author_commits_after_request}c+${check.author_inline_replies_after_request}reply)`)
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

export function getScratchpadMap(): Record<BehaviorKey, string> {
  const out: Record<BehaviorKey, string> = {} as any
  for (const k of BEHAVIOR_KEYS) out[k] = getScratchpad(k)
  return out
}
