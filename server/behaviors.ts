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
import { getMeta, setMeta } from './db'

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

export type BehaviorKey = 'review-new-prs'
export const BEHAVIOR_KEYS: BehaviorKey[] = ['review-new-prs']

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
// "p0" / "p1" / "p2"). Default "p2" so a freshly-enabled behavior
// catches p0..p2 unless the user narrows it.
export type BehaviorSetting = 'p0' | 'p1' | 'p2'
const VALID_SETTINGS: BehaviorSetting[] = ['p0', 'p1', 'p2']
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

// ── Seen-sets (in-memory only) ──────────────────────────────────────────
const seenSets: Record<BehaviorKey, Set<string> | null> = {
  'review-new-prs': null,
}

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
    seenSets['review-new-prs'] = new Set(prs.map((p) => `${p.repo}#${p.number}`))
  } catch (err) {
    console.error('[behaviors] snapshot failed:', err)
  }
}

async function tickReviewNewPrs(): Promise<void> {
  const author = getMeta('me') || ''
  if (!author) return
  // First tick after boot/enable with no snapshot — take one and bail.
  if (!seenSets['review-new-prs']) {
    await snapshotReviewNewPrs()
    return
  }
  const setting = getSetting('review-new-prs')
  try {
    const prs = await listOpenPrsByAuthor(author)
    const seen = seenSets['review-new-prs']!
    for (const pr of prs) {
      const key = `${pr.repo}#${pr.number}`
      if (seen.has(key)) continue
      seen.add(key)
      try {
        await fireReview(pr, setting)
        console.log(`[behaviors] review-new-prs fired for ${key} (p=${setting})`)
      } catch (err) {
        console.error(`[behaviors] fireReview failed for ${key}:`, err)
      }
    }
  } catch (err) {
    console.error('[behaviors] tick failed:', err)
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
      seenSets[key] = null
    }
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
const TICK_MS = 60_000

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer)
  const now = Date.now()
  const nextBoundary = Math.ceil((now + 1) / TICK_MS) * TICK_MS
  tickTimer = setTimeout(async () => {
    try {
      if (isEnabled('review-new-prs')) await tickReviewNewPrs()
    } catch (err) {
      console.error('[behaviors] tick handler error:', err)
    }
    scheduleNextTick()
  }, Math.max(0, nextBoundary - now))
}

export function startBehaviorsRuntime(): void {
  if (tickerStarted) return
  tickerStarted = true
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
