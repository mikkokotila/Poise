// The per-checkout writer lease shared by every process that mutates a
// repository checkout: this Poise server, the other one (dev vs production),
// and Caller's fix-failing-ci worker. The protocol is published in
// /tmp/poise-chat-v1/poise-contract.md §1 and docs/Chat-v1.md; Caller
// implements the same file, table and rules in Python, so nothing here may
// change without the document changing first.
//
// One SQLite file per checkout under ~/.poise/locks (never under the
// database directory: dev and production must share it). One row. Every
// operation is a BEGIN IMMEDIATE transaction, which SQLite serializes across
// processes with OS locks that die with the process.
//
// Ownership is a random token, never an id: the same session id from a
// restarted server is a different holder. A live host blocks takeover no
// matter what its row says. A dead host's row stays busy while the worker
// group it registered is alive — a surviving child never shares the checkout
// with a new writer — and only its own instance may clean that up, after
// verifying the worker is still the gate it recorded.

import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pgidAlive, pidAlive } from './worker'

export const LEASE_MS = 90_000
export const HEARTBEAT_MS = 20_000
export const ACQUIRE_POLL_MS = 1_000
const BUSY_TIMEOUT_MS = 10_000

export function lockDirectory(): string {
  return process.env.POISE_LOCK_DIR || join(homedir(), '.poise', 'locks')
}

/** realpath of the checkout: symlinks resolved, no trailing slash. */
export function canonicalCheckout(path: string): string {
  return realpathSync(path).replace(/\/+$/, '') || '/'
}

export function checkoutLockKey(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32)
}

export function checkoutLockPath(canonical: string): string {
  return join(lockDirectory(), `checkout-${checkoutLockKey(canonical)}.sqlite3`)
}

export interface LeaseRow {
  token: string
  checkout: string
  owner_kind: string
  owner_id: string
  owner_label: string
  instance: string
  host_pid: number
  worker_pid: number | null
  worker_pgid: number | null
  worker_ident: string | null
  branch: string | null
  acquired_at: string
  heartbeat_at: string
  lease_until: number
}

export interface LeaseOwner {
  ownerKind: string
  ownerId: string
  ownerLabel: string
  instance: string
  branch?: string
}

export type AcquireResult =
  | { acquired: true, token: string, recovered: boolean }
  | { acquired: false, holder: LeaseRow, orphan: boolean, reason: 'live_host' | 'lease_valid' | 'orphan_worker' }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lease (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  token          TEXT    NOT NULL,
  checkout       TEXT    NOT NULL,
  owner_kind     TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL,
  owner_label    TEXT    NOT NULL,
  instance       TEXT    NOT NULL,
  host_pid       INTEGER NOT NULL,
  worker_pid     INTEGER,
  worker_pgid    INTEGER,
  worker_ident   TEXT,
  branch         TEXT,
  acquired_at    TEXT    NOT NULL,
  heartbeat_at   TEXT    NOT NULL,
  lease_until    INTEGER NOT NULL
)`

type LockDb = InstanceType<typeof Database>

function openLock(path: string): LockDb {
  mkdirSync(lockDirectory(), { recursive: true, mode: 0o700 })
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS })
  try { chmodSync(path, 0o600) } catch { /* not ours to tighten */ }
  db.exec(SCHEMA)
  return db
}

function withLock<T>(path: string, operation: (db: LockDb) => T): T {
  const db = openLock(path)
  try {
    return db.transaction(operation).immediate(db)
  } finally {
    db.close()
  }
}

function newToken(): string {
  return randomBytes(16).toString('hex')
}

export interface CheckoutLeaseOptions {
  /** Liveness probes, replaceable in tests. */
  pidAlive?: (pid: number) => boolean
  pgidAlive?: (pgid: number) => boolean
  hostPid?: number
  now?: () => number
}

/** One holder's view of one checkout's lease. Instances are cheap: the
 *  database is opened per operation, never kept open. */
export class CheckoutLease {
  readonly path: string
  readonly canonical: string
  private token: string | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lostListeners: Array<() => void> = []
  private readonly probes: Required<CheckoutLeaseOptions>

  constructor(checkout: string, readonly owner: LeaseOwner, options: CheckoutLeaseOptions = {}) {
    this.canonical = canonicalCheckout(checkout)
    this.path = checkoutLockPath(this.canonical)
    this.probes = {
      pidAlive: options.pidAlive ?? pidAlive,
      pgidAlive: options.pgidAlive ?? pgidAlive,
      hostPid: options.hostPid ?? process.pid,
      now: options.now ?? Date.now,
    }
  }

  get held(): boolean { return this.token !== null }
  get currentToken(): string | null { return this.token }

  /** Peek at the current row without changing anything. */
  read(): LeaseRow | null {
    return withLock(this.path, (db) => (db.prepare('SELECT * FROM lease WHERE id = 1').get() as LeaseRow | undefined) ?? null)
  }

  /** One attempt, per contract §1.5. */
  tryAcquire(): AcquireResult {
    const now = this.probes.now()
    const nowIso = new Date(now).toISOString()
    return withLock(this.path, (db) => {
      const row = db.prepare('SELECT * FROM lease WHERE id = 1').get() as LeaseRow | undefined
      const mine = {
        token: this.token ?? newToken(),
        checkout: this.canonical,
        owner_kind: this.owner.ownerKind,
        owner_id: this.owner.ownerId,
        owner_label: this.owner.ownerLabel,
        instance: this.owner.instance,
        host_pid: this.probes.hostPid,
        branch: this.owner.branch ?? null,
        acquired_at: nowIso,
        heartbeat_at: nowIso,
        lease_until: now + LEASE_MS,
      }
      const insert = () => {
        db.prepare(`
          INSERT OR REPLACE INTO lease (id, token, checkout, owner_kind, owner_id, owner_label, instance, host_pid,
            worker_pid, worker_pgid, worker_ident, branch, acquired_at, heartbeat_at, lease_until)
          VALUES (1, @token, @checkout, @owner_kind, @owner_id, @owner_label, @instance, @host_pid,
            NULL, NULL, NULL, @branch, @acquired_at, @heartbeat_at, @lease_until)
        `).run(mine)
        this.token = mine.token
      }
      if (!row) {
        insert()
        return { acquired: true, token: mine.token, recovered: false }
      }
      if (this.token && row.token === this.token) {
        db.prepare('UPDATE lease SET heartbeat_at = ?, lease_until = ? WHERE id = 1 AND token = ?')
          .run(nowIso, now + LEASE_MS, this.token)
        return { acquired: true, token: this.token, recovered: false }
      }
      if (this.probes.pidAlive(row.host_pid)) {
        return { acquired: false, holder: row, orphan: false, reason: 'live_host' }
      }
      if (row.lease_until >= now) {
        return { acquired: false, holder: row, orphan: false, reason: 'lease_valid' }
      }
      if ((row.worker_pgid && this.probes.pgidAlive(row.worker_pgid)) || (row.worker_pid && this.probes.pidAlive(row.worker_pid))) {
        return { acquired: false, holder: row, orphan: true, reason: 'orphan_worker' }
      }
      // A stale row from a dead host with no living worker: take it over. A
      // token this holder used before is never reused, so a stale copy of an
      // old token cannot renew what it lost.
      this.token = null
      mine.token = newToken()
      insert()
      return { acquired: true, token: mine.token, recovered: true }
    })
  }

  /** Wait until acquired or the signal aborts. `onBusy` is told who holds it. */
  async acquire(options: { signal?: AbortSignal, onBusy?: (result: Extract<AcquireResult, { acquired: false }>) => void } = {}): Promise<AcquireResult & { acquired: true }> {
    while (true) {
      // A cancelled wait must not take the lock on its way out.
      if (options.signal?.aborted) throw new Error('lock wait aborted')
      const result = this.tryAcquire()
      if (result.acquired) {
        this.startHeartbeat()
        return result
      }
      options.onBusy?.(result)
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve() }
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ACQUIRE_POLL_MS)
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /** Renew; false means the lease was recovered by someone else. A database
   *  error is uncertainty, which is treated as loss: the owner is told to
   *  stop its worker before the error propagates. */
  heartbeat(): boolean {
    if (!this.token) return false
    const now = this.probes.now()
    let ok: boolean
    try {
      ok = withLock(this.path, (db) => db.prepare('UPDATE lease SET heartbeat_at = ?, lease_until = ? WHERE id = 1 AND token = ?')
        .run(new Date(now).toISOString(), now + LEASE_MS, this.token).changes === 1)
    } catch (error) {
      this.lose()
      throw error
    }
    if (!ok) this.lose()
    return ok
  }

  /** Record the gate before it may start (contract §1.6). Zero matching rows
   *  or a database error means the lease is not ours any more. */
  registerWorker(worker: { pid: number, pgid: number, ident: string }): boolean {
    if (!this.token) return false
    let ok: boolean
    try {
      ok = withLock(this.path, (db) => db.prepare('UPDATE lease SET worker_pid = ?, worker_pgid = ?, worker_ident = ? WHERE id = 1 AND token = ?')
        .run(worker.pid, worker.pgid, worker.ident, this.token).changes === 1)
    } catch (error) {
      this.lose()
      throw error
    }
    if (!ok) this.lose()
    return ok
  }

  clearWorker(): boolean {
    if (!this.token) return false
    return withLock(this.path, (db) => db.prepare('UPDATE lease SET worker_pid = NULL, worker_pgid = NULL, worker_ident = NULL WHERE id = 1 AND token = ?')
      .run(this.token).changes === 1)
  }

  setBranch(branch: string): boolean {
    if (!this.token) return false
    const ok = withLock(this.path, (db) => db.prepare('UPDATE lease SET branch = ? WHERE id = 1 AND token = ?').run(branch, this.token).changes === 1)
    if (!ok) this.lose()
    return ok
  }

  /** Delete the row if still ours. Ownership state is kept until the delete
   *  committed: a transient database error leaves the lease held so it can
   *  be released again instead of leaking a row that blocks everyone. */
  release(): boolean {
    const token = this.token
    if (!token) return false
    const deleted = withLock(this.path, (db) => db.prepare('DELETE FROM lease WHERE id = 1 AND token = ?').run(token).changes === 1)
    this.stopHeartbeat()
    this.token = null
    return deleted
  }

  /** Delete a row by token without holding it — startup cleanup of our own
   *  leftover after the worker was verified and terminated. */
  static releaseByToken(checkout: string, token: string): boolean {
    const path = checkoutLockPath(canonicalCheckout(checkout))
    return withLock(path, (db) => db.prepare('DELETE FROM lease WHERE id = 1 AND token = ?').run(token).changes === 1)
  }

  onLost(listener: () => void): void {
    this.lostListeners.push(listener)
  }

  private lose(): void {
    this.stopHeartbeat()
    this.token = null
    for (const listener of this.lostListeners.splice(0)) {
      try { listener() } catch { /* observer */ }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      try { this.heartbeat() } catch (error) { console.error('[chat-lock] heartbeat failed:', error) }
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }
}

/** Human summary of who holds a lease, for `queued behind …`. */
export function describeHolder(row: LeaseRow): string {
  return row.owner_label || `${row.owner_kind} ${row.owner_id}`
}
