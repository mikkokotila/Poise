import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

// Poise's local SQLite holds two things only:
//   meta          — small key-value store for org / me / timezone settings
//   current_cards  — the manual Idea / Concept / Plan kanban cards
//
// Everything else (issues, PRs, reviews, files) lives in the user's external
// /github service. Older Poise versions kept a full mirror of GitHub data
// here in `prs` / `reviews` / `pr_files` — those tables are dropped on first
// load if they still exist.

const DB_PATH = process.env.POISE_DB || join(homedir(), '.poise', 'cache.db')

function ensureDbDir() {
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

ensureDbDir()

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

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
  -- duplicate row, etc. — can't fire the same review twice. claimSeen
  -- below is the only writer; INSERT OR IGNORE makes the claim atomic.
  CREATE TABLE IF NOT EXISTS behavior_seen (
    key TEXT NOT NULL,
    target TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (key, target)
  );
`)

// One-time migrations: the kanban table has been renamed twice.
//   pipe_cards   (when the view was called Pipe)
//   stream_cards (when it was Stream)
//   current_cards (now)
// Each block is idempotent — guarded by sqlite_master so it only runs
// while the legacy table still exists, and re-runs are no-ops.
function migrateKanbanTable(legacy: string) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(legacy) as { name: string } | undefined
  if (!exists) return
  db.exec(`
    INSERT OR IGNORE INTO current_cards (id, text, lane, position, created_at, updated_at)
    SELECT id, text, lane, position, created_at, updated_at FROM ${legacy};
    DROP TABLE ${legacy};
  `)
}
migrateKanbanTable('pipe_cards')
migrateKanbanTable('stream_cards')

// Add the `repo` column if it's not there yet — manual cards can be
// linked to a repo (full owner/name, e.g. "Vaquum/foo") so the meta
// row reads consistently with the live PR/Issue lanes.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
ensureColumn('current_cards', 'repo', 'repo TEXT')

// One-time cleanup: drop the legacy GitHub-mirror tables if they exist.
// Idempotent — runs once and the DROP is a no-op afterwards.
for (const t of ['pr_files', 'reviews', 'prs']) {
  db.exec(`DROP TABLE IF EXISTS ${t}`)
}
// And the meta keys that no longer matter
for (const k of ['github_token', 'last_sync_at', 'mig_status_v2']) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(k)
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ── Behavior dedupe (atomic across runtimes) ──────────────────────────
// All four functions are tiny wrappers around behavior_seen so any
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

// Mark a target as seen WITHOUT signalling "newly claimed" — used by
// the snapshot path where we just want to populate the ledger with
// current state so subsequent ticks don't fire on existing items.
export function recordSeen(key: string, target: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO behavior_seen(key, target, seen_at) VALUES(?, ?, ?)'
  ).run(key, target, new Date().toISOString())
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

// Wipe the ledger for a key — used when the user disables the
// behavior. Re-enabling will trigger a fresh snapshot.
export function clearSeen(key: string): void {
  db.prepare('DELETE FROM behavior_seen WHERE key = ?').run(key)
}
