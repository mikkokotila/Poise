import type { ChildProcess } from 'node:child_process'
import type { TurnResult } from './types'

/** Admission is not completion. Stop, disconnection and a missing terminal
 * notification all settle, and require worker termination before lease release. */
export function compactionWaiter(child: ChildProcess, signal: AbortSignal, timeoutMs = 10 * 60_000) {
  let done = false
  let resolve!: (result: TurnResult) => void
  const result = new Promise<TurnResult>(settle => { resolve = settle })
  const finish = (value: TurnResult) => {
    if (done) return
    done = true; clearTimeout(timer)
    signal.removeEventListener('abort', abort); child.removeListener('exit', exit)
    resolve(value)
  }
  const abort = () => finish({ stopReason: 'cancelled', terminate: true })
  const exit = () => finish({ stopReason: 'error', error: 'The agent exited before confirming context compaction.', terminate: true })
  const timer = setTimeout(() => finish({ stopReason: 'error', error: 'The agent did not confirm context compaction before its deadline.', terminate: true }), timeoutMs)
  signal.addEventListener('abort', abort, { once: true }); child.once('exit', exit)
  if (signal.aborted) abort()
  else if (child.exitCode !== null || child.signalCode !== null) exit()
  return { result, finish, get done() { return done } }
}
