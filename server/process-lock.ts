import Database from 'better-sqlite3'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_TIMEOUT_MS = 10_000
const RETRY_MIN_MS = 8
const RETRY_JITTER_MS = 17

export class ProcessLockError extends Error {
  readonly code = 'PROCESS_LOCK_UNAVAILABLE'
  readonly statusCode = 503

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProcessLockError'
  }
}

export interface ProcessLockOptions {
  path: string
  timeoutMs?: number
  unavailableMessage?: string
  timeoutMessage?: string
  errorFactory?: (message: string, cause: unknown) => Error
}

type LockDatabase = InstanceType<typeof Database>

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string'
    && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockError(options: ProcessLockOptions, message: string, cause: unknown): Error {
  return options.errorFactory?.(message, cause) ?? new ProcessLockError(message, { cause })
}

// SQLite supplies an OS-backed lock with automatic crash release. Holding an
// IMMEDIATE transaction across the callback makes its read/compare/write work
// indivisible from every process using the same lock path. Acquisition errors
// fail closed: the callback is never invoked without ownership.
async function acquireProcessLock(options: ProcessLockOptions): Promise<LockDatabase> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  await mkdir(dirname(options.path), { recursive: true })

  while (true) {
    let lock: LockDatabase | undefined
    try {
      lock = new Database(options.path, { timeout: 0 })
      await chmod(options.path, 0o600)
      lock.exec('BEGIN IMMEDIATE')
      return lock
    } catch (error) {
      try { if (lock?.open) lock.close() } catch { /* preserve acquisition error */ }
      if (!isSqliteContention(error)) {
        throw lockError(
          options,
          options.unavailableMessage ?? 'process lock is unavailable',
          error,
        )
      }
      if (Date.now() >= deadline) {
        throw lockError(
          options,
          options.timeoutMessage ?? 'timed out waiting for process lock',
          error,
        )
      }
      await delay(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS)
    }
  }
}

export async function withProcessLock<T>(
  options: ProcessLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireProcessLock(options)
  try {
    const result = await operation()
    lock.exec('COMMIT')
    return result
  } catch (error) {
    if (lock.inTransaction) {
      try { lock.exec('ROLLBACK') }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'operation and process-lock rollback failed')
      }
    }
    throw error
  } finally {
    if (lock.open) lock.close()
  }
}
