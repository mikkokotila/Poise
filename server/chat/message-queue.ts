// Durable queue and delivery receipts. The browser never pumps this queue.
// Claiming and reserving a turn are one SQLite transaction; a crashed or
// failed attempt is visible, never silently re-executed. Idle enqueue does
// not arm anything: only a completed turn can advance the queue.
import { db } from '../db'
import type { MessageQueue, QueuedMessage } from './protocol'

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_message_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    request TEXT NOT NULL,
    record TEXT NOT NULL,
    state TEXT NOT NULL,
    turn_id TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_message_queue_session ON chat_message_queue(session_id, state);
  CREATE TABLE IF NOT EXISTS chat_message_queue_state (
    session_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    ready INTEGER NOT NULL DEFAULT 0,
    executor_session_id TEXT
  );
`)
// The queue follows an isolated Poise implementation session, rather than
// being stranded in the source chat when that workflow opens its own session.
export function queueOwner(sessionId: string): string {
  const row = db.prepare('SELECT session_id FROM chat_message_queue_state WHERE executor_session_id = ?').get(sessionId) as { session_id: string } | undefined
  return row?.session_id || sessionId
}
export function delegateQueue(sourceId: string, executorId: string): void {
  const owner = queueOwner(sourceId)
  if (!readQueue(owner).items.length) return
  db.prepare('UPDATE chat_message_queue_state SET executor_session_id = ?, ready = 0, revision = revision + 1 WHERE session_id = ?').run(executorId === owner ? null : executorId, owner)
}

interface Row { id: string, session_id: string, request: string, record: string, state: string, turn_id: string | null, error: string | null }
export class QueueError extends Error {
  constructor(message: string, readonly code = 'queue_conflict') { super(message) }
}
const rowFor = (id: string) => db.prepare('SELECT * FROM chat_message_queue WHERE id = ?').get(id) as Row | undefined
function bump(sessionId: string, ready?: boolean): void {
  db.prepare('INSERT OR IGNORE INTO chat_message_queue_state (session_id) VALUES (?)').run(sessionId)
  db.prepare(`UPDATE chat_message_queue_state SET revision = revision + 1${ready === undefined ? '' : ', ready = ?'} WHERE session_id = ?`)
    .run(...(ready === undefined ? [sessionId] : [Number(ready), sessionId]))
}
function publicRow(row: Row): QueuedMessage {
  return { ...JSON.parse(row.record), state: row.state, ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.error ? { error: row.error } : {}) }
}
export function readQueue(sessionId: string): MessageQueue {
  const head = db.prepare('SELECT revision, ready, executor_session_id FROM chat_message_queue_state WHERE session_id = ?').get(sessionId) as { revision: number, ready: number, executor_session_id: string | null } | undefined
  const rows = db.prepare("SELECT * FROM chat_message_queue WHERE session_id = ? AND state IN ('waiting', 'running', 'failed') ORDER BY rowid").all(sessionId) as Row[]
  return { revision: head?.revision ?? 0, ready: head?.ready === 1, items: rows.map(publicRow), ...(head?.executor_session_id ? { executorSessionId: head.executor_session_id } : {}) }
}
export const enqueueMessage = db.transaction((sessionId: string, item: QueuedMessage): MessageQueue => {
  const request = JSON.stringify({ prompt: item.prompt, sourceSessionId: item.sourceSessionId, agent: item.agent, model: item.model, effort: item.effort })
  const existing = rowFor(item.id)
  if (existing) {
    if (existing.session_id !== sessionId || existing.request !== request) throw new QueueError('This queue item ID already belongs to a different request.')
    return readQueue(sessionId) // also deduplicates already-completed/removed items
  }
  const queue = readQueue(sessionId)
  // The whole queue travels as a bounded WebSocket event, not one unbounded
  // array that can disconnect every client. This exceeds typical task batches.
  if (Buffer.byteLength(JSON.stringify(queue.items)) + Buffer.byteLength(JSON.stringify(item)) > 2 * 1024 * 1024) {
    throw new QueueError('The queued messages exceed 2 MiB; remove an item or shorten this message.', 'queue_full')
  }
  db.prepare("INSERT INTO chat_message_queue (id, session_id, request, record, state) VALUES (?, ?, ?, ?, 'waiting')")
    .run(item.id, sessionId, request, JSON.stringify(item))
  bump(sessionId) // never arm a queue by adding a task to an idle session
  return readQueue(sessionId)
})
export const updateQueuedModel = db.transaction((sessionId: string, id: string, target: Pick<QueuedMessage, 'agent' | 'model' | 'effort'>): MessageQueue => {
  const row = rowFor(id)
  if (!row || row.session_id !== sessionId || row.state !== 'waiting') throw new QueueError('Only a waiting queue item can change agent or model.')
  db.prepare('UPDATE chat_message_queue SET record = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.record), ...target }), id)
  bump(sessionId)
  return readQueue(sessionId)
})
/** Preserve the original add receipt while moving uploaded context to its executor. */
export const transferQueuedContext = db.transaction((sessionId: string, id: string, sourceSessionId: string, prompt: QueuedMessage['prompt']): MessageQueue => {
  const row = rowFor(id)
  if (!row || row.session_id !== sessionId || row.state !== 'waiting') return readQueue(sessionId)
  db.prepare('UPDATE chat_message_queue SET record = ? WHERE id = ?')
    .run(JSON.stringify({ ...JSON.parse(row.record), sourceSessionId, prompt }), id)
  bump(sessionId)
  return readQueue(sessionId)
})

export const removeQueuedMessage = db.transaction((sessionId: string, id: string): MessageQueue => {
  const row = rowFor(id)
  if (!row || row.session_id !== sessionId) throw new QueueError('Unknown queue item.')
  if (row.state === 'running') throw new QueueError('This queued message is already running; use Stop to end its turn.')
  if (row.state !== 'removed' && row.state !== 'done') {
    db.prepare("UPDATE chat_message_queue SET state = 'removed' WHERE id = ?").run(id)
    const waiting = db.prepare("SELECT 1 FROM chat_message_queue WHERE session_id = ? AND state = 'waiting' LIMIT 1").get(sessionId)
    bump(sessionId, waiting ? undefined : false)
  }
  return readQueue(sessionId)
})
/** Called inside the same transaction that persists the native open turn. */
export function claimQueuedMessage(sessionId: string, id: string, turnId: string): void {
  const queue = readQueue(sessionId)
  const first = queue.items.find(item => item.state === 'waiting')
  if (!queue.ready || first?.id !== id || queue.items.some(item => item.state === 'running')) throw new QueueError('The queue changed before this message could start.')
  db.prepare("UPDATE chat_message_queue SET state = 'running', turn_id = ? WHERE id = ?").run(turnId, id)
  bump(sessionId, false)
}
/** Called in finalizeTurn's transaction, only on its first terminal record. */
export function settleQueuedTurn(sessionId: string, turnId: string, completed: boolean, error?: string): void {
  const head = db.prepare('SELECT 1 FROM chat_message_queue_state WHERE session_id = ?').get(sessionId)
  if (!head) return
  db.prepare("UPDATE chat_message_queue SET state = ?, error = ? WHERE session_id = ? AND turn_id = ? AND state = 'running'")
    .run(completed ? 'done' : 'failed', completed ? null : error || 'The turn did not complete. This message will not be retried automatically.', sessionId, turnId)
  const waiting = db.prepare("SELECT 1 FROM chat_message_queue WHERE session_id = ? AND state = 'waiting' LIMIT 1").get(sessionId)
  bump(sessionId, completed && Boolean(waiting))
}
export function pauseQueue(sessionId: string): void {
  if (readQueue(sessionId).ready) bump(sessionId, false)
}
export function deleteMessageQueue(sessionId: string): void {
  const queue = readQueue(sessionId)
  if (queue.executorSessionId && queue.executorSessionId !== sessionId) {
    const executor = queue.executorSessionId
    db.prepare('UPDATE chat_message_queue SET session_id = ? WHERE session_id = ?').run(executor, sessionId)
    db.prepare('UPDATE chat_message_queue_state SET session_id = ?, executor_session_id = NULL, revision = revision + 1 WHERE session_id = ?').run(executor, sessionId)
    return
  }
  const owner = queueOwner(sessionId)
  if (owner !== sessionId) db.prepare('UPDATE chat_message_queue_state SET executor_session_id = NULL, ready = 0, revision = revision + 1 WHERE session_id = ?').run(owner)
  db.prepare('DELETE FROM chat_message_queue WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM chat_message_queue_state WHERE session_id = ?').run(sessionId)
}
