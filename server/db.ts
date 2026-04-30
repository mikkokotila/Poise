import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const DB_PATH = process.env.POISE_DB || join(homedir(), '.poise', 'cache.db')

function ensureDbDir() {
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

ensureDbDir()

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Schema — repos, prs, reviews, comments, meta
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prs (
    id INTEGER PRIMARY KEY,
    org TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    html_url TEXT NOT NULL,
    author TEXT NOT NULL,
    is_pr INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    merged_at TEXT,
    comments_count INTEGER NOT NULL DEFAULT 0,
    additions INTEGER,
    deletions INTEGER,
    tag TEXT,
    first_review_at TEXT,
    iteration_count INTEGER,
    last_commenter TEXT,
    last_comment_body TEXT,
    last_comment_at TEXT,
    raw_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_prs_org ON prs(org);
  CREATE INDEX IF NOT EXISTS idx_prs_is_pr ON prs(is_pr);
  CREATE INDEX IF NOT EXISTS idx_prs_state ON prs(state);
  CREATE INDEX IF NOT EXISTS idx_prs_updated_at ON prs(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_prs_merged_at ON prs(merged_at);
  CREATE INDEX IF NOT EXISTS idx_prs_author ON prs(author);
  CREATE INDEX IF NOT EXISTS idx_prs_repo_number ON prs(repo, number);

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    pr_id INTEGER NOT NULL,
    reviewer TEXT NOT NULL,
    state TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (pr_id) REFERENCES prs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer);

  CREATE TABLE IF NOT EXISTS pr_files (
    pr_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pr_id, filename),
    FOREIGN KEY (pr_id) REFERENCES prs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pr_files_filename ON pr_files(filename);

  CREATE TABLE IF NOT EXISTS pipe_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    lane TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pipe_cards_lane ON pipe_cards(lane, position);
`)

// Migrations — add columns if missing
const prCols = db.prepare('PRAGMA table_info(prs)').all() as { name: string }[]
const hasCol = (name: string) => prCols.some((c) => c.name === name)
if (!hasCol('files_changed'))          db.exec('ALTER TABLE prs ADD COLUMN files_changed INTEGER')
if (!hasCol('last_commenter_avatar'))  db.exec('ALTER TABLE prs ADD COLUMN last_commenter_avatar TEXT')
if (!hasCol('author_avatar')) {
  db.exec('ALTER TABLE prs ADD COLUMN author_avatar TEXT')
  // Backfill from the stored raw_json so existing rows don't need a resync
  db.exec(`
    UPDATE prs
    SET author_avatar = json_extract(raw_json, '$.user.avatar_url')
    WHERE raw_json IS NOT NULL
  `)
}
if (!hasCol('status')) {
  db.exec('ALTER TABLE prs ADD COLUMN status TEXT')
  // Workflow status derived from labels. Cheap to backfill via LIKE since
  // GitHub label names are unique enough that "name":"ALLOCATION" only appears
  // for that label. IN_PROGRESS wins over ALLOCATION when both are present
  // (later workflow stage takes precedence).
  db.exec(`
    UPDATE prs
    SET status = CASE
      WHEN raw_json LIKE '%"name":"IN_PROGRESS"%' THEN 'BUILDING'
      WHEN raw_json LIKE '%"name":"ALLOCATION"%' THEN 'ALLOCATED'
      ELSE 'IN REVIEW'
    END
  `)
}
// Re-derive status for users whose DB was backfilled with the old priority
// (where ALLOCATION won over IN_PROGRESS). Idempotent and meta-gated.
const statusV2 = db.prepare('SELECT value FROM meta WHERE key = ?').get('mig_status_v2') as { value: string } | undefined
if (!statusV2) {
  db.exec(`
    UPDATE prs
    SET status = CASE
      WHEN raw_json LIKE '%"name":"IN_PROGRESS"%' THEN 'BUILDING'
      WHEN raw_json LIKE '%"name":"ALLOCATION"%' THEN 'ALLOCATED'
      ELSE 'IN REVIEW'
    END
    WHERE raw_json IS NOT NULL
  `)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('mig_status_v2', '1')
}
if (!hasCol('owner_login')) {
  db.exec('ALTER TABLE prs ADD COLUMN owner_login TEXT')
  db.exec('ALTER TABLE prs ADD COLUMN owner_avatar TEXT')
  // Backfill the first assignee from raw_json so existing rows show an owner
  // without a resync.
  db.exec(`
    UPDATE prs SET
      owner_login  = json_extract(raw_json, '$.assignees[0].login'),
      owner_avatar = json_extract(raw_json, '$.assignees[0].avatar_url')
    WHERE raw_json IS NOT NULL
  `)
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
