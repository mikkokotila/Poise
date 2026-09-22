// SQLite mirror for Chat v1: the session table, the per-session event log
// that the browser renders history from, the unanswered requests that must
// survive a reload, and the worker gates this server spawned (for startup
// cleanup). Lives in Poise's own database (server/db.ts), so dev and
// production keep separate session tables; the checkout lock is what they
// share. Every write is one short transaction; nothing here talks to an
// agent.

import { db } from '../db'
import { claimQueuedMessage, delegateQueue, deleteMessageQueue, pauseQueue, settleQueuedTurn, queueOwner, readQueue } from './message-queue'
import type { ChatEnvelope, ChatEvent, SessionRecord, SessionStatus, MessageQueue } from './protocol'
import type { AttachmentRecord } from './attachments'

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    agent TEXT NOT NULL,
    repo TEXT NOT NULL,
    checkout TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    native_session_id TEXT,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    open_turn_id TEXT,
    open_call_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_instance ON chat_sessions(instance, updated_at DESC);

  CREATE TABLE IF NOT EXISTS chat_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS chat_pending (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('permission', 'question')),
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_pending_session ON chat_pending(session_id);

  CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id);

  CREATE TABLE IF NOT EXISTS chat_finish_outbox (
    call_id TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'cancelled', 'failed')),
    error TEXT,
    queued_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_finish_outbox_instance ON chat_finish_outbox(instance);

  CREATE TABLE IF NOT EXISTS chat_workers (
    session_id TEXT PRIMARY KEY,
    gate_pid INTEGER NOT NULL,
    gate_pgid INTEGER NOT NULL,
    ident TEXT NOT NULL,
    checkout TEXT NOT NULL,
    lease_token TEXT,
    command TEXT NOT NULL,
    started_at TEXT NOT NULL
  );
`)

const EVENT_MAX_BYTES = 4 * 1024 * 1024

export function insertSession(record: SessionRecord): void {
  db.prepare(`
    INSERT INTO chat_sessions (id, record, agent, repo, checkout, branch, status, title, native_session_id, instance, created_at, updated_at, last_seq)
    VALUES (@id, @record, @agent, @repo, @checkout, @branch, @status, @title, @native, @instance, @created, @updated, 0)
  `).run({
    id: record.id,
    record: JSON.stringify({ ...record, queue: undefined }),
    agent: record.agent,
    repo: record.repo,
    checkout: record.checkout,
    branch: record.branch.name,
    status: record.status,
    title: record.title,
    native: record.nativeSessionId ?? null,
    instance: record.instance,
    created: record.createdAt,
    updated: record.updatedAt,
  })
}

export function saveSession(record: SessionRecord): void {
  db.prepare(`
    UPDATE chat_sessions
    SET record = @record, agent = @agent, repo = @repo, checkout = @checkout, branch = @branch,
        status = @status, title = @title, native_session_id = @native, updated_at = @updated
    WHERE id = @id
  `).run({
    id: record.id,
    record: JSON.stringify({ ...record, queue: undefined }),
    agent: record.agent,
    repo: record.repo,
    checkout: record.checkout,
    branch: record.branch.name,
    status: record.status,
    title: record.title,
    native: record.nativeSessionId ?? null,
    updated: record.updatedAt,
  })
}

function parseRecord(row: { record: string, last_seq: number, status: string }): SessionRecord {
  const record = JSON.parse(row.record) as SessionRecord
  record.lastSeq = row.last_seq
  record.status = row.status as SessionStatus
  record.pendingRequests = listPendingRequests(record.id).map((p) => p.requestId)
  return record
}

export function getSession(id: string): SessionRecord | null {
  const row = db.prepare('SELECT record, last_seq, status FROM chat_sessions WHERE id = ?').get(id) as { record: string, last_seq: number, status: string } | undefined
  return row ? parseRecord(row) : null
}

/** Which server owns the session, without parsing the record. */
export function sessionInstance(id: string): string | null {
  const row = db.prepare('SELECT instance FROM chat_sessions WHERE id = ?').get(id) as { instance: string } | undefined
  return row?.instance ?? null
}

export function listSessions(instance: string): SessionRecord[] {
  const rows = db.prepare('SELECT record, last_seq, status FROM chat_sessions WHERE instance = ? ORDER BY updated_at DESC, created_at DESC')
    .all(instance) as Array<{ record: string, last_seq: number, status: string }>
  return rows.map(parseRecord)
}

export function deleteSession(id: string): void {
  db.transaction(() => {
    deleteMessageQueue(id)
    db.prepare('DELETE FROM chat_events WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM chat_pending WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM chat_workers WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM chat_attachments WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
  })()
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  db.prepare('UPDATE chat_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
}

export function setOpenTurn(id: string, turnId: string | null, callId: string | null): void {
  db.prepare('UPDATE chat_sessions SET open_turn_id = ?, open_call_id = ? WHERE id = ?').run(turnId, callId, id)
}

export function getOpenTurn(id: string): { turnId: string, callId: string | null } | null {
  const row = db.prepare('SELECT open_turn_id, open_call_id FROM chat_sessions WHERE id = ?').get(id) as { open_turn_id: string | null, open_call_id: string | null } | undefined
  return row?.open_turn_id ? { turnId: row.open_turn_id, callId: row.open_call_id } : null
}

/** A queue mutation and its transcript receipt either both persist or neither does. */
export const commitQueueMutation = db.transaction((sessionId: string, mutate: () => MessageQueue): ChatEnvelope => {
  const queue = mutate()
  return appendEvent(sessionId, { type: 'queue.updated', queue })
})

/** Queue claim and open-turn reservation cannot be separated by a crash. */
export const reserveQueueTurn = db.transaction((sessionId: string, turnId: string, itemId?: string): void => {
  if (getOpenTurn(sessionId)) throw new Error('A turn is already recorded for this session')
  const owner = queueOwner(sessionId)
  if (itemId) claimQueuedMessage(owner, itemId, turnId)
  else {
    const queue = readQueue(owner)
    // A new manual activity can take the idle queue back from a completed
    // delegated change. Never take it away from an executing queued turn.
    if (queue.executorSessionId && queue.executorSessionId !== sessionId
      && !getOpenTurn(queue.executorSessionId) && !queue.items.some(item => item.state === 'running')) {
      delegateQueue(owner, sessionId)
    }
    pauseQueue(owner)
  }
  setOpenTurn(sessionId, turnId, null)
})

/** Sessions of this instance that had a turn open — a crash cut them. */
export function listOpenTurns(instance: string): Array<{ sessionId: string, turnId: string, callId: string | null }> {
  return (db.prepare('SELECT id, open_turn_id, open_call_id FROM chat_sessions WHERE instance = ? AND open_turn_id IS NOT NULL')
    .all(instance) as Array<{ id: string, open_turn_id: string, open_call_id: string | null }>)
    .map((row) => ({ sessionId: row.id, turnId: row.open_turn_id, callId: row.open_call_id }))
}

/** Append one event; returns its envelope. Sequence numbers are allocated
 *  inside the same transaction as the insert, so two writers cannot collide. */
export const appendEvent = db.transaction((sessionId: string, event: ChatEvent, at: string = new Date().toISOString()): ChatEnvelope => {
  const encoded = JSON.stringify(event)
  if (Buffer.byteLength(encoded, 'utf8') > EVENT_MAX_BYTES) {
    throw new Error(`chat event exceeds ${EVENT_MAX_BYTES} bytes`)
  }
  const row = db.prepare('SELECT last_seq FROM chat_sessions WHERE id = ?').get(sessionId) as { last_seq: number } | undefined
  if (!row) throw new Error(`unknown chat session ${sessionId}`)
  const seq = row.last_seq + 1
  db.prepare('INSERT INTO chat_events (session_id, seq, at, event) VALUES (?, ?, ?, ?)').run(sessionId, seq, at, encoded)
  db.prepare('UPDATE chat_sessions SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, at, sessionId)
  if (event.type === 'permission.requested') {
    db.prepare('INSERT OR REPLACE INTO chat_pending (request_id, session_id, kind, seq, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, sessionId, 'permission', seq, at)
  } else if (event.type === 'question.asked') {
    db.prepare('INSERT OR REPLACE INTO chat_pending (request_id, session_id, kind, seq, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, sessionId, 'question', seq, at)
  } else if (event.type === 'permission.resolved' || event.type === 'question.answered') {
    db.prepare('DELETE FROM chat_pending WHERE request_id = ? AND session_id = ?').run(event.id, sessionId)
  }
  return { seq, sessionId, at, event }
})

export const EVENT_PAGE_LIMIT = 5_000

export function listEvents(sessionId: string, afterSeq: number, limit: number = EVENT_PAGE_LIMIT): { events: ChatEnvelope[], truncated: boolean } {
  const bounded = Math.max(1, Math.min(limit, EVENT_PAGE_LIMIT))
  const rows = db.prepare('SELECT seq, at, event FROM chat_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(sessionId, afterSeq, bounded + 1) as Array<{ seq: number, at: string, event: string }>
  const truncated = rows.length > bounded
  return {
    events: rows.slice(0, bounded).map((row) => ({ seq: row.seq, sessionId, at: row.at, event: JSON.parse(row.event) as ChatEvent })),
    truncated,
  }
}

export function lastEvent(sessionId: string): ChatEnvelope | null {
  const row = db.prepare('SELECT seq, at, event FROM chat_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId) as { seq: number, at: string, event: string } | undefined
  return row ? { seq: row.seq, sessionId, at: row.at, event: JSON.parse(row.event) as ChatEvent } : null
}

export function findEvent(sessionId: string, predicate: (event: ChatEvent) => boolean): ChatEnvelope | null {
  const rows = db.prepare('SELECT seq, at, event FROM chat_events WHERE session_id = ? ORDER BY seq DESC').iterate(sessionId) as Iterable<{ seq: number, at: string, event: string }>
  for (const row of rows) {
    const event = JSON.parse(row.event) as ChatEvent
    if (predicate(event)) return { seq: row.seq, sessionId, at: row.at, event }
  }
  return null
}

export interface PendingRequest { requestId: string, sessionId: string, kind: 'permission' | 'question', seq: number }

export function listPendingRequests(sessionId: string): PendingRequest[] {
  return (db.prepare('SELECT request_id, session_id, kind, seq FROM chat_pending WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ request_id: string, session_id: string, kind: 'permission' | 'question', seq: number }>)
    .map((row) => ({ requestId: row.request_id, sessionId: row.session_id, kind: row.kind, seq: row.seq }))
}

export interface WorkerRow {
  sessionId: string
  gatePid: number
  gatePgid: number
  ident: string
  checkout: string
  leaseToken: string | null
  command: string
  startedAt: string
}

export function recordWorker(row: WorkerRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO chat_workers (session_id, gate_pid, gate_pgid, ident, checkout, lease_token, command, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.sessionId, row.gatePid, row.gatePgid, row.ident, row.checkout, row.leaseToken, row.command, row.startedAt)
}

export function setWorkerLeaseToken(sessionId: string, token: string | null): void {
  db.prepare('UPDATE chat_workers SET lease_token = ? WHERE session_id = ?').run(token, sessionId)
}

export function forgetWorker(sessionId: string): void {
  db.prepare('DELETE FROM chat_workers WHERE session_id = ?').run(sessionId)
}

export function listWorkers(): WorkerRow[] {
  return (db.prepare('SELECT * FROM chat_workers').all() as Array<{
    session_id: string, gate_pid: number, gate_pgid: number, ident: string, checkout: string, lease_token: string | null, command: string, started_at: string
  }>).map((row) => ({
    sessionId: row.session_id,
    gatePid: row.gate_pid,
    gatePgid: row.gate_pgid,
    ident: row.ident,
    checkout: row.checkout,
    leaseToken: row.lease_token,
    command: row.command,
    startedAt: row.started_at,
  }))
}

export function insertAttachment(row: AttachmentRecord): void {
  db.prepare('INSERT INTO chat_attachments (id, session_id, name, path, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.sessionId, row.name, row.path, row.size, row.sha256, row.createdAt)
}

export function getAttachment(id: string): AttachmentRecord | null {
  const row = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(id) as
    { id: string, session_id: string, name: string, path: string, size: number, sha256: string, created_at: string } | undefined
  return row ? { id: row.id, sessionId: row.session_id, name: row.name, path: row.path, size: row.size, sha256: row.sha256, createdAt: row.created_at } : null
}

// The Caller finish outbox: a turn's terminal outcome is written here before
// Caller is asked to record it and removed only once Caller did. It outlives
// later turns and the session itself, so a Caller that was unavailable is
// told the actual outcome later, never a made-up one.
export interface FinishOutboxRow {
  callId: string
  instance: string
  sessionId: string
  status: 'completed' | 'cancelled' | 'failed'
  error: string | null
  queuedAt: string
}

export function queueFinish(row: Omit<FinishOutboxRow, 'queuedAt'>): void {
  db.prepare('INSERT INTO chat_finish_outbox (call_id, instance, session_id, status, error, queued_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(call_id) DO NOTHING')
    .run(row.callId, row.instance, row.sessionId, row.status, row.error, new Date().toISOString())
}

export function finishDelivered(callId: string): void {
  db.prepare('DELETE FROM chat_finish_outbox WHERE call_id = ?').run(callId)
}

export function listFinishOutbox(instance: string): FinishOutboxRow[] {
  return (db.prepare('SELECT * FROM chat_finish_outbox WHERE instance = ? ORDER BY queued_at').all(instance) as Array<{
    call_id: string, instance: string, session_id: string, status: FinishOutboxRow['status'], error: string | null, queued_at: string
  }>).map((row) => ({ callId: row.call_id, instance: row.instance, sessionId: row.session_id, status: row.status, error: row.error, queuedAt: row.queued_at }))
}

/** The first terminal outcome is immutable. Commit its transcript event,
 * Caller delivery record and open-turn clearing together: a crash cannot
 * leave a completed turn looking open, or lose a pending Caller finish. */
export const finalizeTurn = db.transaction((
  sessionId: string,
  event: Extract<ChatEvent, { type: 'turn.finished' }>,
  ledger?: { callId: string, instance: string },
  canAdvanceQueue = true,
): ChatEnvelope => {
  const previous = findEvent(sessionId, candidate => candidate.type === 'turn.finished' && candidate.turnId === event.turnId)
  const envelope = previous ?? appendEvent(sessionId, event)
  const terminal = envelope.event as Extract<ChatEvent, { type: 'turn.finished' }>
  if (ledger) {
    const status = terminal.stopReason === 'cancelled' ? 'cancelled'
      : terminal.stopReason === 'error' || terminal.stopReason === 'interrupted' ? 'failed' : 'completed'
    queueFinish({ callId: ledger.callId, instance: ledger.instance, sessionId, status,
      error: terminal.stopReason === 'interrupted' ? 'Interrupted by Poise restart' : terminal.error ?? null })
  }
  const owner = queueOwner(sessionId)
  const executor = readQueue(owner).executorSessionId
  if (!previous && (!executor || executor === sessionId)) settleQueuedTurn(owner, terminal.turnId, canAdvanceQueue && terminal.stopReason === 'end_turn', terminal.error || (terminal.stopReason === 'cancelled' ? 'Stopped. This message was not retried.' : undefined))
  // Never clear another turn reserved after this one; callers publish the
  // completion only after this transaction is durable.
  db.prepare('UPDATE chat_sessions SET open_turn_id = NULL, open_call_id = NULL WHERE id = ? AND open_turn_id = ?')
    .run(sessionId, event.turnId)
  return envelope
})

/** Select one full immutable record without materializing the whole history. */
export function getDiffEvent(sessionId: string, diffId: string): Extract<ChatEvent, { type: 'diff' }> | null {
  const row = db.prepare(`SELECT event FROM chat_events WHERE session_id = ?
    AND json_extract(event, '$.type') = 'diff' AND json_extract(event, '$.diffId') = ? LIMIT 1`)
    .get(sessionId, diffId) as { event: string } | undefined
  return row ? JSON.parse(row.event) as Extract<ChatEvent, { type: 'diff' }> : null
}

/** Replace this chat's history atomically without reusing sequence numbers.
 * Receipts, queued future work, files and Caller outcomes remain independent. */
export const resetConversation = db.transaction((current: SessionRecord): { session: SessionRecord, envelope: ChatEnvelope } => {
  const row = db.prepare('SELECT last_seq FROM chat_sessions WHERE id = ?').get(current.id) as { last_seq: number } | undefined
  if (!row) throw new Error('unknown chat session')
  const session: SessionRecord = { ...current, status: 'idle', contextResetting: false, contextCompacting: false,
    contextResetSeq: row.last_seq + 1, lastSeq: row.last_seq + 1, pendingRequests: [],
    nativeSessionId: undefined, context: undefined, queuedHandoff: undefined,
    forkedFrom: undefined, staged: undefined, interruptedTurnId: undefined,
    orphanNotice: undefined, safeModePending: false, queuedBehind: undefined }
  db.prepare('DELETE FROM chat_events WHERE session_id = ?').run(session.id)
  db.prepare('DELETE FROM chat_pending WHERE session_id = ?').run(session.id)
  const envelope = appendEvent(session.id, { type: 'session.reset', session })
  saveSession(session)
  return { session, envelope }
})
