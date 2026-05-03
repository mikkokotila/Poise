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
