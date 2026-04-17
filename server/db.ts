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
`)

// Migrations — add columns if missing
const prCols = db.prepare('PRAGMA table_info(prs)').all() as { name: string }[]
const hasCol = (name: string) => prCols.some((c) => c.name === name)
if (!hasCol('files_changed'))          db.exec('ALTER TABLE prs ADD COLUMN files_changed INTEGER')
if (!hasCol('last_commenter_avatar'))  db.exec('ALTER TABLE prs ADD COLUMN last_commenter_avatar TEXT')

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
