// Bounded, registered subprocesses. Every git, npm and launchctl invocation
// the controller makes goes through here. Compared with a plain spawn the
// runner guarantees, in order:
//
//   1. Nothing runs before its process group is recorded durably. The command
//      is started under scripts/self-update/worker-gate.mjs, a detached group
//      leader that waits for `GO` on a control descriptor; GO is sent only
//      after `workers.register()` has resolved. A registry failure is an
//      error of the run, never swallowed, and the gate exits without having
//      spawned anything.
//   2. The record carries an identity that is unique per run and visible in
//      the process table (`--self-update-worker <uuid>` on the gate's argv),
//      so a controller resuming after a crash can prove a recorded pid is
//      still its worker before it signals it, and never kills a reused pid.
//   3. Controller death stops the group: the gate tears its group down when
//      the control pipe closes, and a normal exit of this process SIGTERMs
//      every group it still owns.
//   4. A run is not finished when the command exits. The gate settles its
//      descendants first, and the runner then checks the group itself;
//      a group that survives SIGKILL keeps its record for reapWorkers and
//      the run rejects rather than pretending the checkout is free.
//   5. Wall-clock time, in-memory output and on-disk logs are all bounded.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024
export const GATE_FLAG = '--self-update-worker'
export const WORKER_GATE = join(dirname(fileURLToPath(import.meta.url)), 'worker-gate.mjs')

// How long the runner waits for a group to die after SIGKILL, for the gate's
// stdio pipes to drain once the group is dead, and for log files to flush.
const GROUP_KILL_WAIT_MS = 5_000
const PIPE_DRAIN_WAIT_MS = 2_000
const LOG_FLUSH_WAIT_MS = 5_000
const IDENT_PATTERN = /^[A-Za-z0-9-]{8,64}$/

export class SubprocessError extends Error {
  constructor(message, result) {
    super(message)
    this.name = 'SubprocessError'
    this.result = result
  }
}

/** The worker registry failed to record or release a process group. */
export class WorkerRegistryError extends Error {
  constructor(message, { cause, result = null } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'WorkerRegistryError'
    this.result = result
  }
}

function summarise(result) {
  const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-12).join('\n')
  const how = result.timedOut
    ? `timed out after ${result.timeoutMs} ms`
    : !result.settled ? 'left processes running that did not die'
      : result.signal ? `killed by ${result.signal}` : `exited ${result.code}`
  return `${result.command} ${how}${tail ? `\n${tail}` : ''}`
}

/** `kill(pid, 0)`: only ESRCH proves death; EPERM and anything else read as alive. */
export function pgidAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal) } catch { /* group already gone */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntilGroupDead(pgid, ms, alive = pgidAlive) {
  const deadline = Date.now() + ms
  while (alive(pgid)) {
    if (Date.now() >= deadline) return false
    await sleep(25)
  }
  return true
}

/** Resolve when `event` fires on `emitter`, or with `fallback` after `ms`. */
function eventOrTimeout(emitter, event, ms, fallback = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

// Groups this process owns and has sent GO. A normal exit must not leave them
// running; the gate covers the crash case through its control pipe.
const ownedGroups = new Set()
let exitHookInstalled = false
function ensureExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const pgid of ownedGroups) signalGroup(pgid, 'SIGTERM')
  })
}

/** Exact argv the gate is spawned with for `ident`; the identity reapWorkers checks. */
export function gateArgv({ ident, command, args, execPath = process.execPath, gate = WORKER_GATE }) {
  return [execPath, gate, GATE_FLAG, ident, '--', command, ...args]
}

/** The prefix of the process-table command line that only this run's gate can have. */
export function gateIdentityPrefix(record) {
  const argv = Array.isArray(record?.argv) ? record.argv : null
  const ident = typeof record?.ident === 'string' ? record.ident : null
  if (!argv || argv.length < 5 || !ident || !IDENT_PATTERN.test(ident)) return null
  if (argv[2] !== GATE_FLAG || argv[3] !== ident || argv[4] !== '--') return null
  return argv.slice(0, 5).join(' ')
}

/** Open a bounded log file, failing before anything is spawned when it cannot be opened. */
async function openLog(file, maxBytes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const stream = createWriteStream(file, { mode: 0o600, flags: 'w' })
  let failed = null
  stream.on('error', (error) => { failed = error })
  const opened = await eventOrTimeout(stream, 'open', LOG_FLUSH_WAIT_MS, null)
  if (failed) throw failed
  if (!opened) throw new Error(`could not open log file ${file}`)
  let written = 0
  let truncated = false
  return {
    file,
    write(chunk) {
      if (failed || truncated) return
      const bytes = Buffer.byteLength(chunk)
      if (written + bytes > maxBytes) {
        truncated = true
        stream.write(`\n[log truncated after ${written} bytes]\n`)
        return
      }
      written += bytes
      stream.write(chunk)
    },
    async close() {
      stream.end()
      await eventOrTimeout(stream, 'close', LOG_FLUSH_WAIT_MS, null)
      return { file, bytes: written, truncated, error: failed ? failed.message : null }
    },
  }
}

/**
 * Create a runner. `workers` is an optional registry with
 * `register(record)` and `release(pid)`; both must resolve only once their
 * effect is durable (the controller backs them with the store). A record is
 * `{pid, pgid, ident, argv, command, purpose, startedAt}`.
 */
export function createRunner({ spawn = nodeSpawn, workers = null, log = null } = {}) {
  async function run(command, args = [], options = {}) {
    const {
      cwd,
      env,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
      maxLogBytes = DEFAULT_MAX_LOG_BYTES,
      purpose = command,
      stdoutFile = null,
      stderrFile = null,
      input = null,
      allowFailure = false,
    } = options
    if (typeof command !== 'string' || !command) throw new Error('runner requires a command')
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('runner requires arguments as an array of strings')
    }
    if (!env || typeof env !== 'object') throw new Error('runner requires an explicit environment')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('runner requires a positive timeout')

    const label = `${command} ${args.join(' ')}`.slice(0, 200)
    const files = {
      stdout: stdoutFile ? await openLog(stdoutFile, maxLogBytes) : null,
      stderr: stderrFile ? await openLog(stderrFile, maxLogBytes) : null,
    }
    const ident = randomUUID()
    const argv = gateArgv({ ident, command, args })
    log?.(`[self-update] run ${purpose}: ${label}`)

    const result = {
      command: label, purpose, ident, argv, code: null, signal: null, stdout: '', stderr: '',
      truncated: false, timedOut: false, timeoutMs, pid: null, pgid: null,
      tracked: Boolean(workers), settled: false, logs: { stdout: null, stderr: null },
    }

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const spawnFailure = new Promise((resolve) => child.once('error', (error) => resolve(error)))
    if (!child.pid) {
      // Either the spawn already failed or the pid arrives with 'spawn'.
      const outcome = await Promise.race([spawnFailure, eventOrTimeout(child, 'spawn', LOG_FLUSH_WAIT_MS, null)])
      if (outcome instanceof Error || !child.pid) {
        await Promise.all([files.stdout?.close(), files.stderr?.close()])
        throw outcome instanceof Error ? outcome : new Error(`could not spawn the worker gate for ${label}`)
      }
    }
    const control = child.stdio[3]
    if (!control) {
      signalGroup(child.pid, 'SIGKILL')
      await Promise.all([files.stdout?.close(), files.stderr?.close()])
      throw new Error('worker gate started without a control descriptor')
    }
    control.on('error', () => { /* the gate is gone; exit handling covers it */ })
    result.pid = child.pid
    result.pgid = child.pid
    let recorded = false

    // Output collection is wired before GO so no byte can be missed.
    let total = 0
    const collect = (stream, key) => {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk) => {
        files[key]?.write(chunk)
        total += chunk.length
        if (total <= maxOutputBytes) result[key] += chunk
        else if (!result.truncated) {
          result.truncated = true
          result[key] += '\n[output truncated]\n'
        }
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve({ code: null, signal: null }))
    })
    const closed = new Promise((resolve) => child.once('close', () => resolve(true)))

    // Registration first; the gate refuses to start once its control pipe
    // closes, so a registry failure leaves nothing running.
    if (workers) {
      try {
        await workers.register({
          pid: child.pid, pgid: child.pid, ident, argv, command: label, purpose, startedAt: new Date().toISOString(),
        })
        recorded = true
      } catch (error) {
        try { control.end() } catch { /* already closed */ }
        signalGroup(child.pid, 'SIGKILL')
        await exited
        await Promise.all([files.stdout?.close(), files.stderr?.close()])
        throw new WorkerRegistryError(`could not register worker for ${label}: ${error?.message ?? error}`, { cause: error, result })
      }
    }

    ensureExitHook()
    ownedGroups.add(child.pid)
    try {
      control.write('GO\n')
    } catch (error) {
      // The gate died before GO; the exit path below reports it.
      log?.(`[self-update] ${purpose}: gate rejected GO (${error.message})`)
    }
    if (input !== null && child.stdin) {
      child.stdin.on('error', () => { /* the command closed stdin early */ })
      child.stdin.end(input)
    }

    const timer = setTimeout(() => {
      result.timedOut = true
      log?.(`[self-update] ${purpose}: timed out after ${timeoutMs} ms; killing group ${child.pid}`)
      try { control.write('KILL\n') } catch { /* gate already gone */ }
      signalGroup(child.pid, 'SIGKILL')
    }, timeoutMs)
    timer.unref?.()

    try {
      const { code, signal } = await exited
      result.code = code
      result.signal = signal
    } finally {
      clearTimeout(timer)
    }

    // The leader is gone; the group is finished only when nothing else in it
    // is alive. The gate settles descendants itself, so this normally passes
    // at once, but a gate that gave up (exit 70) or was SIGKILLed cannot have.
    result.settled = !pgidAlive(child.pid)
    if (!result.settled) {
      signalGroup(child.pid, 'SIGKILL')
      result.settled = await waitUntilGroupDead(child.pid, GROUP_KILL_WAIT_MS)
    }
    await Promise.race([closed, sleep(PIPE_DRAIN_WAIT_MS)])
    try { control.destroy() } catch { /* already closed */ }
    const [stdoutLog, stderrLog] = await Promise.all([files.stdout?.close(), files.stderr?.close()])
    result.logs = { stdout: stdoutLog ?? null, stderr: stderrLog ?? null }

    if (!result.settled) {
      // Keep the record: the reaper on the next start owns this group now.
      log?.(`[self-update] ${purpose}: process group ${child.pid} survived SIGKILL; record retained`)
      throw new SubprocessError(summarise(result), result)
    }
    ownedGroups.delete(child.pid)
    if (recorded) {
      try {
        await workers.release(child.pid)
      } catch (error) {
        throw new WorkerRegistryError(`could not release worker ${child.pid} for ${label}: ${error?.message ?? error}`, { cause: error, result })
      }
    }
    if (result.code === 0 && !result.timedOut) return result
    if (allowFailure && !result.timedOut) return result
    throw new SubprocessError(summarise(result), result)
  }
  return { run }
}

/** Command line of `pid` from the process table, or null when unreadable. */
export function processCommandLine(pid) {
  const result = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  if (result.error || result.status !== 0) return null
  return result.stdout.replace(/\n$/, '').trim()
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Kill process groups recorded by a controller that did not shut down cleanly,
 * and report which records may be dropped.
 *
 * A record is only ever signalled when the process table still shows its
 * gate with the identity the record carries; a live pid with any other
 * command line is a reused pid and is left alone. Returned pids are those
 * whose record is now safe to delete: the group is dead (already, or after
 * SIGTERM/SIGKILL), or the pid belongs to someone else. A group that stays
 * alive after SIGKILL, or a record without an identity whose pid is alive,
 * is retained — the caller must keep treating it as an active worker.
 * `reapWorkersDetailed` returns the same partition with the reasons.
 */
export function reapWorkersDetailed(workers, {
  alive = pgidAlive,
  commandLine = processCommandLine,
  kill = signalGroup,
  wait = sleepSync,
  graceMs = 2_000,
  killWaitMs = GROUP_KILL_WAIT_MS,
} = {}) {
  const outcome = { killed: [], cleared: [], retained: [] }
  for (const record of Object.values(workers || {})) {
    const pid = Number(record?.pid)
    if (!Number.isInteger(pid) || pid <= 1) continue
    if (!alive(pid)) {
      outcome.cleared.push({ pid, reason: 'dead' })
      continue
    }
    const prefix = gateIdentityPrefix(record)
    if (!prefix) {
      outcome.retained.push({ pid, reason: 'no identity recorded; not signalled' })
      continue
    }
    const line = commandLine(pid)
    if (line === null) {
      outcome.retained.push({ pid, reason: 'process table unreadable' })
      continue
    }
    if (line !== prefix && !line.startsWith(`${prefix} `)) {
      outcome.cleared.push({ pid, reason: 'pid reused by another process' })
      continue
    }
    kill(pid, 'SIGTERM')
    let deadline = Date.now() + graceMs
    while (alive(pid) && Date.now() < deadline) wait(25)
    if (alive(pid)) {
      kill(pid, 'SIGKILL')
      deadline = Date.now() + killWaitMs
      while (alive(pid) && Date.now() < deadline) wait(25)
    }
    if (alive(pid)) outcome.retained.push({ pid, reason: 'survived SIGKILL' })
    else outcome.killed.push({ pid, reason: 'killed' })
  }
  return outcome
}

export function reapWorkers(workers, options = {}) {
  const outcome = reapWorkersDetailed(workers, options)
  return [...outcome.killed, ...outcome.cleared].map((entry) => entry.pid)
}
