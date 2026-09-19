// The self-update finish outbox: the first terminal outcome of a `/poise`
// change session is written here — after its worker is verifiably gone and
// the checkout released — before the controller is told, and the row is kept
// (marked delivered) once it was. It outlives the session, so a controller
// that was unavailable is told the actual outcome later, never a made-up
// one, and a change can never be reported twice with two outcomes.

import { db } from './db'

db.exec(`
  CREATE TABLE IF NOT EXISTS self_update_finish_outbox (
    change_id TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    session_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
    error TEXT,
    queued_at TEXT NOT NULL,
    delivered_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_self_update_finish_outbox_pending ON self_update_finish_outbox(instance, delivered_at);
`)

export interface FinishOutboxRow {
  changeId: string
  instance: string
  sessionId: string
  outcome: 'completed' | 'failed'
  error: string | null
  queuedAt: string
  deliveredAt: string | null
  attempts: number
  lastError: string | null
}

const ERROR_CHARS = 4_000

/** Record the outcome once; a later call for the same change changes nothing
 *  and reports that. */
export function queueFinish(row: { changeId: string, instance: string, sessionId: string, outcome: 'completed' | 'failed', error?: string | null }): { fresh: boolean } {
  const result = db.prepare(`
    INSERT INTO self_update_finish_outbox (change_id, instance, session_id, outcome, error, queued_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(change_id) DO NOTHING
  `).run(row.changeId, row.instance, row.sessionId, row.outcome, row.error ? row.error.slice(0, ERROR_CHARS) : null, new Date().toISOString())
  return { fresh: result.changes === 1 }
}

export function getFinish(changeId: string): FinishOutboxRow | null {
  const row = db.prepare('SELECT * FROM self_update_finish_outbox WHERE change_id = ?').get(changeId) as RawRow | undefined
  return row ? parse(row) : null
}

export function listUndelivered(instance: string): FinishOutboxRow[] {
  return (db.prepare('SELECT * FROM self_update_finish_outbox WHERE instance = ? AND delivered_at IS NULL ORDER BY queued_at').all(instance) as RawRow[]).map(parse)
}

export function markDelivered(changeId: string): void {
  db.prepare('UPDATE self_update_finish_outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE change_id = ? AND delivered_at IS NULL')
    .run(new Date().toISOString(), changeId)
}

export function markAttempt(changeId: string, error: string): void {
  db.prepare('UPDATE self_update_finish_outbox SET attempts = attempts + 1, last_error = ? WHERE change_id = ? AND delivered_at IS NULL')
    .run(error.slice(0, ERROR_CHARS), changeId)
}

interface RawRow {
  change_id: string, instance: string, session_id: string, outcome: 'completed' | 'failed', error: string | null,
  queued_at: string, delivered_at: string | null, attempts: number, last_error: string | null
}

function parse(row: RawRow): FinishOutboxRow {
  return {
    changeId: row.change_id, instance: row.instance, sessionId: row.session_id, outcome: row.outcome, error: row.error,
    queuedAt: row.queued_at, deliveredAt: row.delivered_at, attempts: row.attempts, lastError: row.last_error,
  }
}
