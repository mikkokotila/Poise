import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

// Poise's local SQLite holds five things only:
//   meta          — small key-value store for org / me / timezone settings
//   current_cards  — the manual Idea / Concept / Plan kanban cards
//   behavior_seen  — atomic automation dedupe claims
//   content_jobs   — durable /content finalization state and worker leases
//   content_launches — pre-spawn /content intent and call correlation
//
// Everything else (issues, PRs, reviews, files) lives in the user's external
// /github service. Older Poise versions kept a full mirror of GitHub data
// here in `prs` / `reviews` / `pr_files`. They are no longer read, but remain
// untouched so an upgrade never destroys user data.

const DEFAULT_DB_PATH = join(homedir(), '.poise', 'cache.db')
const DB_PATH = process.env.POISE_DB || DEFAULT_DB_PATH

function ensureDbDir() {
  if (DB_PATH === ':memory:') return
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Tighten the application-owned default directory. Never chmod an
  // arbitrary POISE_DB parent: it may intentionally be shared (for example
  // /tmp in a test environment).
  if (DB_PATH === DEFAULT_DB_PATH) chmodSync(dir, 0o700)
}

ensureDbDir()

export const db = new Database(DB_PATH)
if (DB_PATH !== ':memory:') chmodSync(DB_PATH, 0o600)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
// Deleted credential bytes must be overwritten rather than left on SQLite's
// freelist. Set this before the migration that removes the retired PAT row.
db.pragma('secure_delete = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS current_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    lane TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_current_cards_lane ON current_cards(lane, position);

  -- Per-behavior dedupe ledger. Each row is "behavior <key> has already
  -- claimed <target> at <seen_at>". Used by the server-side behavior
  -- runtime (server/behaviors.ts) so concurrent runtimes — multiple
  -- vite processes, accidental tick re-entry, datastore returning a
  -- duplicate row, etc. — can't fire the same review twice. INSERT OR
  -- IGNORE makes both claims and snapshots idempotent.
  CREATE TABLE IF NOT EXISTS behavior_seen (
    key TEXT NOT NULL,
    target TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    claim_id TEXT NOT NULL DEFAULT '',
    lease_until INTEGER,
    launch_behavior TEXT,
    launch_repo TEXT,
    launch_pr INTEGER,
    launch_requested_at TEXT,
    launch_call_id TEXT,
    launch_error TEXT,
    launch_outcome TEXT,
    launch_completed_at TEXT,
    launch_head_sha TEXT,
    launch_expected_head TEXT,
    launch_actor TEXT,
    launch_source TEXT,
    launch_correlation_id TEXT,
    launch_action TEXT,
    PRIMARY KEY (key, target)
  );

  CREATE TABLE IF NOT EXISTS behavior_dead_letters (
    id TEXT PRIMARY KEY,
    behavior TEXT NOT NULL,
    target TEXT NOT NULL,
    repo TEXT,
    pr INTEGER,
    actor TEXT,
    source TEXT,
    correlation_id TEXT,
    call_id TEXT,
    error TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS content_jobs (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    slug TEXT NOT NULL,
    response_hash TEXT,
    error TEXT,
    article_created INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS content_launches (
    launch_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    registration_deadline_at INTEGER NOT NULL DEFAULT 0,
    recovery_eligible INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'failed')),
    call_id TEXT UNIQUE,
    error TEXT,
    updated_at TEXT NOT NULL
  );
`)

// One-time migrations: the kanban table has been renamed twice.
//   pipe_cards   (when the view was called Pipe)
//   stream_cards (when it was Stream)
//   current_cards (now)
// Copying is idempotent and deliberately non-destructive: legacy tables stay
// in place as a recovery source. INSERT OR IGNORE means a restart cannot
// duplicate rows already copied into current_cards.
function migrateKanbanTable(legacy: string) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(legacy) as { name: string } | undefined
  if (!exists) return
  db.exec(`
    INSERT OR IGNORE INTO current_cards (id, text, lane, position, created_at, updated_at)
    SELECT id, text, lane, position, created_at, updated_at FROM ${legacy};
  `)
}

const LEGACY_KANBAN_MIGRATION_KEY = 'schema_migration_legacy_kanban_v1'

function migrateLegacyKanbanOnce() {
  const migrated = db.prepare('SELECT 1 AS x FROM meta WHERE key = ?').get(
    LEGACY_KANBAN_MIGRATION_KEY,
  ) as { x: number } | undefined
  if (migrated) return

  migrateKanbanTable('pipe_cards')
  migrateKanbanTable('stream_cards')
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
    LEGACY_KANBAN_MIGRATION_KEY,
    new Date().toISOString(),
  )
}

// Add the `repo` column if it's not there yet — manual cards can be
// linked to a repo (full owner/name, e.g. "Vaquum/foo") so the meta
// row reads consistently with the live PR/Issue lanes.
function ensureColumn(table: string, column: string, ddl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  return true
}

export const CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY = 'content_launch_recovery_watermark_v1'
export const CONTENT_LEGACY_MAPPING_KEY = 'content_legacy_short_slug_mapping_v1'
export const CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS = 2 * 60 * 1_000
const BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY = 'behavior_launch_tracking_v1'

// Serialize the read-before-write migration checks across server processes.
// The immediate transaction avoids a race where two fresh processes both
// observe a missing column and then issue the same ALTER TABLE.
const migrateSchema = db.transaction(() => {
  migrateLegacyKanbanOnce()
  ensureColumn('current_cards', 'repo', 'repo TEXT')
  ensureColumn('behavior_seen', 'claim_id', "claim_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('behavior_seen', 'lease_until', 'lease_until INTEGER')
  ensureColumn('behavior_seen', 'launch_behavior', 'launch_behavior TEXT')
  ensureColumn('behavior_seen', 'launch_repo', 'launch_repo TEXT')
  ensureColumn('behavior_seen', 'launch_pr', 'launch_pr INTEGER')
  ensureColumn('behavior_seen', 'launch_requested_at', 'launch_requested_at TEXT')
  ensureColumn('behavior_seen', 'launch_call_id', 'launch_call_id TEXT')
  ensureColumn('behavior_seen', 'launch_error', 'launch_error TEXT')
  ensureColumn('behavior_seen', 'launch_outcome', 'launch_outcome TEXT')
  ensureColumn('behavior_seen', 'launch_completed_at', 'launch_completed_at TEXT')
  ensureColumn('behavior_seen', 'launch_head_sha', 'launch_head_sha TEXT')
  ensureColumn('behavior_seen', 'launch_expected_head', 'launch_expected_head TEXT')
  ensureColumn('behavior_seen', 'launch_actor', 'launch_actor TEXT')
  ensureColumn('behavior_seen', 'launch_source', 'launch_source TEXT')
  ensureColumn('behavior_seen', 'launch_correlation_id', 'launch_correlation_id TEXT')
  ensureColumn('behavior_seen', 'launch_action', 'launch_action TEXT')
  const behaviorLaunchTrackingMigrated = db.prepare(
    'SELECT 1 FROM meta WHERE key = ?',
  ).get(BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY)
  if (!behaviorLaunchTrackingMigrated) {
    // Earlier builds could persist an accepted detached worker only as an
    // expiring claim, without enough identity to reconcile it after restart.
    // Terminalize that uncertain generation once: skipping a retry is safer
    // than launching a duplicate review or approval.
    db.prepare(`
      UPDATE behavior_seen
      SET claim_id = '', lease_until = NULL,
          launch_error = 'legacy in-flight claim retained to prevent duplicate launch'
      WHERE claim_id <> '' AND launch_requested_at IS NULL
    `).run()
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
      BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY,
      new Date().toISOString(),
    )
  }
  // CREATE TABLE IF NOT EXISTS does not evolve installs that already ran an
  // earlier production-readiness build. Keep every post-v1 job field additive
  // so those databases remain bootable and retryable.
  ensureColumn('content_jobs', 'session_id', "session_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'topic', "topic TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'started_at', "started_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'status', "status TEXT NOT NULL DEFAULT 'pending'")
  ensureColumn('content_jobs', 'slug', "slug TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'response_hash', 'response_hash TEXT')
  ensureColumn('content_jobs', 'error', 'error TEXT')
  ensureColumn('content_jobs', 'article_created', 'article_created INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'lease_owner', 'lease_owner TEXT')
  ensureColumn('content_jobs', 'lease_expires_at', 'lease_expires_at INTEGER')
  ensureColumn('content_jobs', 'next_attempt_at', 'next_attempt_at INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'error_count', 'error_count INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'created_at', "created_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'completed_at', 'completed_at TEXT')
  ensureColumn(
    'content_launches',
    'registration_deadline_at',
    'registration_deadline_at INTEGER NOT NULL DEFAULT 0',
  )
  const addedRecoveryEligibility = ensureColumn(
    'content_launches',
    'recovery_eligible',
    'recovery_eligible INTEGER NOT NULL DEFAULT 0',
  )
  const migrationNow = Date.now()
  db.prepare(`
    UPDATE content_launches
    SET registration_deadline_at = CASE
      WHEN CAST(strftime('%s', requested_at) AS INTEGER) > 0
        THEN (CAST(strftime('%s', requested_at) AS INTEGER) * 1000) + ?
      ELSE ?
    END
    WHERE registration_deadline_at <= 0
  `).run(
    CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
    migrationNow + CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
  )
  // A pending row from a pre-deadline build was persisted only after Poise
  // committed to spawning the worker, so it remains eligible for exact log
  // correlation. New rows opt in immediately before their spawn attempt.
  if (addedRecoveryEligibility) {
    db.prepare(`
      UPDATE content_launches
      SET recovery_eligible = 1
      WHERE status = 'pending'
    `).run()
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_content_jobs_reconcile
      ON content_jobs(status, next_attempt_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_content_launches_recovery
      ON content_launches(status, requested_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_launches_one_pending_session
      ON content_launches(session_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_behavior_seen_launch_claims
      ON behavior_seen(key, launch_requested_at)
      WHERE claim_id <> '' AND launch_requested_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_behavior_dead_letters_created
      ON behavior_dead_letters(created_at DESC);
  `)
  // Recovery may inspect agent-interface logs, but it must never claim calls
  // predating the feature installation. The first migration timestamp is a
  // permanent lower bound in addition to each intent's requested_at value.
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run(
    CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY,
    new Date().toISOString(),
  )
  // Old releases persisted a classic GitHub PAT in plaintext. It is no
  // longer read, and retaining it would keep an unnecessary credential on
  // disk forever. Content tables remain non-destructive; this retired secret
  // is the deliberate exception.
  db.prepare("DELETE FROM meta WHERE key = 'github_token'").run()
})
migrateSchema.immediate()

// Earlier builds (and earlier runs of this migration branch) may already
// have logically deleted github_token while its bytes remained in free
// pages. Rebuild the database once, outside any transaction, then truncate
// the WAL before recording completion. No retired credential value is read.
const SECURE_DELETE_REBUILD_KEY = 'schema_secure_delete_rebuild_v1'
const secureDeleteRebuilt = db.prepare(
  'SELECT value FROM meta WHERE key = ?',
).pluck().get(SECURE_DELETE_REBUILD_KEY)
if (secureDeleteRebuilt !== 'complete') {
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SECURE_DELETE_REBUILD_KEY, 'complete')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

// Older mirror tables are ignored, not dropped. Keeping dormant content is
// cheap and makes schema initialization safe to repeat.

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ── Behavior dedupe (atomic across runtimes) ──────────────────────────
// These functions are tiny wrappers around behavior_seen so any
// server module that needs the ledger can use them without re-deriving
// the schema or the locking semantics.

// Atomically claim a (key, target) pair. Returns true if this caller
// inserted a new row (i.e. nobody had claimed it yet — caller should
// proceed with the side effect). Returns false if the row already
// existed (caller must skip). Race-safe: SQLite serializes concurrent
// INSERT OR IGNORE statements, so out of N callers exactly ONE gets
// `true` for any given (key, target).
export function claimSeen(key: string, target: string): boolean {
  const info = db.prepare(
    'INSERT OR IGNORE INTO behavior_seen(key, target, seen_at) VALUES(?, ?, ?)'
  ).run(key, target, new Date().toISOString())
  return info.changes === 1
}

// Claim with a unique owner token. Detached workers retain the token so a
// late failure can only release the exact generation it launched. This
// prevents an old worker from deleting a newer claim after disable/re-enable.
const DEFAULT_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000

export type BehaviorAgentLaunch = 'pr_review' | 'pr_approve'

export interface BehaviorLaunchClaim {
  key: string
  target: string
  seenAt: string
  claimId: string
  leaseUntil: number | null
  launchBehavior: BehaviorAgentLaunch
  launchRepo: string
  launchPr: number
  launchRequestedAt: string
  launchCallId: string | null
  launchError: string | null
  launchExpectedHead: string
  launchActor: string
  launchSource: string
  launchCorrelationId: string
}

export function claimSeenOwned(
  key: string,
  target: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): string | null {
  return claimSeenOwnedAs(key, target, randomUUID(), leaseMs)
}

export function claimSeenOwnedAs(
  key: string,
  target: string,
  claimId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): string | null {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claimId)) {
    throw new Error('claimId must be a stable operation identifier')
  }
  const now = Date.now()
  const info = db.prepare(
    `INSERT INTO behavior_seen(key, target, seen_at, claim_id, lease_until)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(key, target) DO UPDATE SET
       seen_at = excluded.seen_at,
       claim_id = excluded.claim_id,
       lease_until = excluded.lease_until,
       launch_behavior = NULL,
       launch_repo = NULL,
       launch_pr = NULL,
       launch_requested_at = NULL,
       launch_call_id = NULL,
       launch_error = NULL,
       launch_outcome = NULL,
       launch_completed_at = NULL,
       launch_head_sha = NULL,
       launch_expected_head = NULL,
       launch_actor = NULL,
       launch_source = NULL,
       launch_correlation_id = NULL,
       launch_action = NULL
     WHERE behavior_seen.claim_id <> ''
       AND behavior_seen.lease_until IS NOT NULL
       AND behavior_seen.lease_until <= ?
       AND behavior_seen.launch_requested_at IS NULL`
  ).run(key, target, new Date(now).toISOString(), claimId, now + leaseMs, now)
  return info.changes === 1 ? claimId : null
}

export function claimPrOperationOwned(target: string, leaseMs: number): string | null {
  return claimSeenOwned('pr-operation', target, leaseMs)
}

export function renewPrOperationOwned(claimId: string, leaseMs: number): boolean {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  const info = db.prepare(`
    UPDATE behavior_seen
    SET lease_until = ?
    WHERE key = 'pr-operation' AND claim_id = ? AND claim_id <> ''
  `).run(Date.now() + leaseMs, claimId)
  return info.changes === 1
}

export function releasePrOperationOwned(claimId: string): boolean {
  const info = db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = 'pr-operation' AND claim_id = ? AND claim_id <> ''
  `).run(claimId)
  return info.changes === 1
}

export function markBehaviorLaunchIntentOwned(input: {
  key: string
  target: string
  claimId: string
  launchBehavior: BehaviorAgentLaunch
  repo: string
  pr: number
  requestedAt: string
  expectedHead: string
  actor: string
  source: string
  correlationId: string
  leaseMs?: number
}): boolean {
  const leaseMs = input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  if (!['pr_review', 'pr_approve'].includes(input.launchBehavior)) {
    throw new Error('invalid behavior launch type')
  }
  if (!input.repo || input.repo.length > 512) throw new Error('invalid behavior launch repo')
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) throw new Error('invalid behavior launch PR')
  if (!Number.isFinite(Date.parse(input.requestedAt))) throw new Error('invalid behavior launch timestamp')
  if (!/^[0-9a-f]{40}$/.test(input.expectedHead)) throw new Error('invalid behavior expected head')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(input.actor)) {
    throw new Error('invalid behavior actor')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.source)) {
    throw new Error('invalid behavior source')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.correlationId)) {
    throw new Error('invalid behavior correlation id')
  }
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_behavior = ?, launch_repo = ?, launch_pr = ?,
        launch_requested_at = ?, launch_call_id = NULL, launch_error = NULL,
        launch_outcome = NULL, launch_completed_at = NULL, launch_head_sha = NULL,
        launch_expected_head = ?, launch_actor = ?, launch_source = ?,
        launch_correlation_id = ?, launch_action = NULL,
        lease_until = ?
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
  `).run(
    input.launchBehavior,
    input.repo,
    input.pr,
    input.requestedAt,
    input.expectedHead,
    input.actor,
    input.source,
    input.correlationId,
    Date.now() + leaseMs,
    input.key,
    input.target,
    input.claimId,
  )
  return info.changes === 1
}

export function listBehaviorLaunchClaims(key: string): BehaviorLaunchClaim[] {
  const rows = db.prepare(`
    SELECT key, target, seen_at, claim_id, lease_until, launch_behavior,
           launch_repo, launch_pr, launch_requested_at, launch_call_id, launch_error,
           launch_expected_head, launch_actor, launch_source, launch_correlation_id
    FROM behavior_seen
    WHERE key = ? AND claim_id <> '' AND launch_requested_at IS NOT NULL
    ORDER BY launch_requested_at, target
  `).all(key) as Array<{
    key: string
    target: string
    seen_at: string
    claim_id: string
    lease_until: number | null
    launch_behavior: BehaviorAgentLaunch
    launch_repo: string
    launch_pr: number
    launch_requested_at: string
    launch_call_id: string | null
    launch_error: string | null
    launch_expected_head: string
    launch_actor: string
    launch_source: string
    launch_correlation_id: string
  }>
  return rows.map((row) => ({
    key: row.key,
    target: row.target,
    seenAt: row.seen_at,
    claimId: row.claim_id,
    leaseUntil: row.lease_until,
    launchBehavior: row.launch_behavior,
    launchRepo: row.launch_repo,
    launchPr: row.launch_pr,
    launchRequestedAt: row.launch_requested_at,
    launchCallId: row.launch_call_id,
    launchError: row.launch_error,
    launchExpectedHead: row.launch_expected_head,
    launchActor: row.launch_actor,
    launchSource: row.launch_source,
    launchCorrelationId: row.launch_correlation_id,
  }))
}

export function getFailedBehaviorLaunch(
  key: string,
  target: string,
): BehaviorLaunchClaim | null {
  const row = db.prepare(`
    SELECT key, target, seen_at, claim_id, lease_until, launch_behavior,
           launch_repo, launch_pr, launch_requested_at, launch_call_id, launch_error,
           launch_expected_head, launch_actor, launch_source, launch_correlation_id
    FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_requested_at IS NOT NULL
      AND launch_call_id IS NOT NULL
      AND launch_error IS NOT NULL
      AND launch_outcome IS NULL
  `).get(key, target) as {
    key: string
    target: string
    seen_at: string
    claim_id: string
    lease_until: number | null
    launch_behavior: BehaviorAgentLaunch
    launch_repo: string
    launch_pr: number
    launch_requested_at: string
    launch_call_id: string
    launch_error: string
    launch_expected_head: string
    launch_actor: string
    launch_source: string
    launch_correlation_id: string
  } | undefined
  return row ? {
    key: row.key,
    target: row.target,
    seenAt: row.seen_at,
    claimId: row.claim_id,
    leaseUntil: row.lease_until,
    launchBehavior: row.launch_behavior,
    launchRepo: row.launch_repo,
    launchPr: row.launch_pr,
    launchRequestedAt: row.launch_requested_at,
    launchCallId: row.launch_call_id,
    launchError: row.launch_error,
    launchExpectedHead: row.launch_expected_head,
    launchActor: row.launch_actor,
    launchSource: row.launch_source,
    launchCorrelationId: row.launch_correlation_id,
  } : null
}

export function releaseFailedBehaviorLaunch(
  key: string,
  target: string,
  callId: string,
  expectedHead: string,
): boolean {
  const info = db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_call_id = ? AND launch_expected_head = ?
      AND launch_error IS NOT NULL AND launch_outcome IS NULL
  `).run(key, target, callId, expectedHead)
  return info.changes === 1
}

export function linkBehaviorLaunchCallOwned(
  key: string,
  target: string,
  claimId: string,
  callId: string,
): boolean {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) throw new Error('invalid behavior launch call id')
  const normalizedCallId = callId.toLowerCase()
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_call_id = ?, launch_error = NULL
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
      AND (launch_call_id IS NULL OR launch_call_id = ?)
  `).run(normalizedCallId, key, target, claimId, normalizedCallId)
  return info.changes === 1
}

export function setBehaviorLaunchErrorOwned(
  key: string,
  target: string,
  claimId: string,
  error: string | null,
): boolean {
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_error = ?
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
  `).run(error ? error.slice(0, 4_000) : null, key, target, claimId)
  return info.changes === 1
}

export function renewSeenOwned(
  key: string,
  target: string,
  claimId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): boolean {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  const info = db.prepare(`
    UPDATE behavior_seen
    SET lease_until = ?
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
  `).run(Date.now() + leaseMs, key, target, claimId)
  return info.changes === 1
}

// Mark a target as seen WITHOUT signalling "newly claimed" — used by
// the snapshot path where we just want to populate the ledger with
// current state so subsequent ticks don't fire on existing items.
export function recordSeen(key: string, target: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO behavior_seen(key, target, seen_at) VALUES(?, ?, ?)'
  ).run(key, target, new Date().toISOString())
}

// Release a claim when its side effect could not be launched. The exact
// target predicate prevents one failed worker from clearing another target.
export function releaseSeen(key: string, target: string): void {
  db.prepare('DELETE FROM behavior_seen WHERE key = ? AND target = ?').run(key, target)
}

export function releaseSeenOwned(key: string, target: string, claimId: string): boolean {
  return db.transaction(() => {
    const info = db.prepare(
      'DELETE FROM behavior_seen WHERE key = ? AND target = ? AND claim_id = ?'
    ).run(key, target, claimId)
    if (info.changes === 1) releasePrOperationOwned(claimId)
    return info.changes === 1
  })()
}

// Convert an in-flight owned claim into the durable terminal seen marker.
// The owner predicate makes a late callback harmless after lease recovery.
export function completeSeenOwned(key: string, target: string, claimId: string): boolean {
  return db.transaction(() => {
    const info = db.prepare(
      `UPDATE behavior_seen
       SET claim_id = '', lease_until = NULL, seen_at = ?
       WHERE key = ? AND target = ? AND claim_id = ?`
    ).run(new Date().toISOString(), key, target, claimId)
    if (info.changes === 1) releasePrOperationOwned(claimId)
    return info.changes === 1
  })()
}

export type ReviewLaunchOutcome = 'clean' | 'changes_requested'
export type BehaviorLaunchOutcome = ReviewLaunchOutcome | 'approved'
export type BehaviorLaunchAction = 'reviewed_clean' | 'requested_changes' | 'approved'

export function completeBehaviorLaunchOwned(input: {
  key: string
  target: string
  claimId: string
  outcome: BehaviorLaunchOutcome
  action: BehaviorLaunchAction
  completedAt: string
  headSha: string
}): boolean {
  if (!Number.isFinite(Date.parse(input.completedAt))) {
    throw new Error('invalid review completion timestamp')
  }
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) {
    throw new Error('invalid review completion head SHA')
  }
  const expectedPair: Record<BehaviorLaunchAction, BehaviorLaunchOutcome> = {
    reviewed_clean: 'clean',
    requested_changes: 'changes_requested',
    approved: 'approved',
  }
  if (expectedPair[input.action] !== input.outcome) {
    throw new Error('behavior completion action/outcome mismatch')
  }
  return db.transaction(() => {
    const info = db.prepare(`
      UPDATE behavior_seen
      SET claim_id = '', lease_until = NULL, seen_at = ?, launch_error = NULL,
          launch_outcome = ?, launch_completed_at = ?, launch_head_sha = ?,
          launch_action = ?
      WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
        AND launch_expected_head = ?
    `).run(
      new Date().toISOString(),
      input.outcome,
      input.completedAt,
      input.headSha,
      input.action,
      input.key,
      input.target,
      input.claimId,
      input.headSha,
    )
    if (info.changes === 1) releasePrOperationOwned(input.claimId)
    return info.changes === 1
  })()
}

export function completeReviewLaunchOwned(input: {
  key: string
  target: string
  claimId: string
  outcome: ReviewLaunchOutcome
  completedAt: string
  headSha: string
}): boolean {
  return completeBehaviorLaunchOwned({
    ...input,
    headSha: input.headSha.toLowerCase(),
    action: input.outcome === 'clean' ? 'reviewed_clean' : 'requested_changes',
  })
}

export interface BehaviorDeadLetter {
  id: string
  behavior: string
  target: string
  repo: string | null
  pr: number | null
  actor: string | null
  source: string | null
  correlationId: string | null
  callId: string | null
  error: string
  createdAt: string
}

export function recordBehaviorDeadLetter(
  claim: BehaviorLaunchClaim,
  error: string,
  callId: string | null = claim.launchCallId,
): string {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO behavior_dead_letters(
      id, behavior, target, repo, pr, actor, source, correlation_id,
      call_id, error, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    claim.key,
    claim.target,
    claim.launchRepo || null,
    claim.launchPr || null,
    claim.launchActor || null,
    claim.launchSource || null,
    claim.launchCorrelationId || null,
    callId,
    String(error).slice(0, 4_000),
    createdAt,
  )
  return id
}

export function listBehaviorDeadLetters(limit = 50): BehaviorDeadLetter[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('dead-letter limit must be between 1 and 500')
  }
  const rows = db.prepare(`
    SELECT id, behavior, target, repo, pr, actor, source, correlation_id,
           call_id, error, created_at
    FROM behavior_dead_letters
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string
    behavior: string
    target: string
    repo: string | null
    pr: number | null
    actor: string | null
    source: string | null
    correlation_id: string | null
    call_id: string | null
    error: string
    created_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    behavior: row.behavior,
    target: row.target,
    repo: row.repo,
    pr: row.pr,
    actor: row.actor,
    source: row.source,
    correlationId: row.correlation_id,
    callId: row.call_id,
    error: row.error,
    createdAt: row.created_at,
  }))
}

// Whether any rows exist for this behavior — proxy for "snapshot has
// been taken at least once". Used to differentiate a fresh enable
// (no rows yet → take snapshot, don't fire on first tick) from a
// running behavior (rows exist → fire on net-new targets).
export function hasSeenAny(key: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM behavior_seen WHERE key = ? LIMIT 1'
  ).get(key) as { x: number } | undefined
  return !!row
}

export function hasSeen(key: string, target: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM behavior_seen WHERE key = ? AND target = ?',
  ).get(key, target) as { x: number } | undefined
  return !!row
}

export function listSeenTargets(key: string): string[] {
  return (db.prepare(
    'SELECT target FROM behavior_seen WHERE key = ? ORDER BY target',
  ).all(key) as Array<{ target: string }>).map((row) => row.target)
}

export function listSnapshotOnlySeen(key: string): Array<{ target: string, seenAt: string }> {
  return (db.prepare(`
    SELECT target, seen_at
    FROM behavior_seen
    WHERE key = ?
      AND claim_id = ''
      AND launch_requested_at IS NULL
    ORDER BY target
  `).all(key) as Array<{ target: string, seen_at: string }>).map((row) => ({
    target: row.target,
    seenAt: row.seen_at,
  }))
}

export interface CompletedApprovalBasisLaunch {
  callId: string
  completedAt: string
  headSha: string
}

export function latestApprovalBasisLaunch(
  repo: string,
  pr: number,
): CompletedApprovalBasisLaunch | null {
  const row = db.prepare(`
    SELECT launch_call_id, launch_completed_at, launch_head_sha
    FROM behavior_seen
    WHERE claim_id = ''
      AND launch_repo = ?
      AND launch_pr = ?
      AND launch_error IS NULL
      AND (
        (key = 'review-new-prs'
          AND launch_behavior = 'pr_review'
          AND launch_action = 'reviewed_clean'
          AND launch_outcome = 'clean')
        OR
        (key = 'approve-prs'
          AND launch_behavior = 'pr_approve'
          AND launch_action = 'approved'
          AND launch_outcome = 'approved')
      )
      AND launch_call_id IS NOT NULL
      AND launch_completed_at IS NOT NULL
      AND launch_head_sha IS NOT NULL
    ORDER BY launch_completed_at DESC
    LIMIT 1
  `).get(repo, pr) as {
    launch_call_id: string
    launch_completed_at: string
    launch_head_sha: string
  } | undefined
  return row ? {
    callId: row.launch_call_id,
    completedAt: row.launch_completed_at,
    headSha: row.launch_head_sha,
  } : null
}

// Wipe the ledger for a key — used when the user disables the
// behavior. Re-enabling will trigger a fresh snapshot.
export function clearSeen(key: string): void {
  db.prepare('DELETE FROM behavior_seen WHERE key = ?').run(key)
}

// Disabling removes snapshots/skips but retains every accepted detached launch.
// Otherwise disable/re-enable could duplicate completed work or erase the proof
// that approval must wait for a successful initial review.
export function clearSeenExceptLaunched(key: string): void {
  db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = ?
      AND launch_requested_at IS NULL
  `).run(key)
}

// Production servers call this during graceful shutdown. Kept explicit
// rather than installing process-level signal handlers in a data module.
export function closeDatabase(): void {
  if (!db.open) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}
