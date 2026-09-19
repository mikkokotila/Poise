import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  GATE_FLAG, SubprocessError, WORKER_GATE, WorkerRegistryError, createRunner, gateArgv, gateIdentityPrefix,
  pgidAlive, reapWorkers, reapWorkersDetailed,
} from '../scripts/self-update/safe-runner.mjs'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-worker-safety-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const env = () => ({ PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root })

function pidDead(pid) {
  try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}

async function waitFor(check, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** A registry that records call order and can be told to fail. */
function registry({ registerError = null, releaseError = null, registerDelayMs = 0 } = {}) {
  const calls = []
  const records = {}
  return {
    calls,
    records,
    async register(record) {
      calls.push(['register', record.pid])
      if (registerDelayMs) await new Promise((resolve) => setTimeout(resolve, registerDelayMs))
      if (registerError) throw registerError
      records[record.pid] = record
    },
    async release(pid) {
      calls.push(['release', pid])
      if (releaseError) throw releaseError
      delete records[pid]
    },
  }
}

describe('a registered, gated subprocess', () => {
  it('records the group durably before GO and only then runs the command', async () => {
    const marker = join(root, 'ran')
    const workers = registry({ registerDelayMs: 150 })
    let commandRanBeforeRegisterResolved = null
    const original = workers.register
    workers.register = async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      commandRanBeforeRegisterResolved = existsSync(marker)
      return original.call(workers, record)
    }
    const runner = createRunner({ workers })
    const result = await runner.run('sh', ['-c', `touch ${marker}; echo out; echo err >&2`], { env: env() })
    expect(commandRanBeforeRegisterResolved).toBe(false)
    expect(existsSync(marker)).toBe(true)
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'out\n', stderr: 'err\n', settled: true, tracked: true })
    expect(workers.calls).toEqual([['register', result.pid], ['release', result.pid]])
    expect(workers.records).toEqual({})
  })

  it('records an identity that is unique, exact and visible on the gate argv', async () => {
    const workers = registry()
    const runner = createRunner({ workers })
    let recordSeen
    const original = workers.register
    workers.register = async (record) => { recordSeen = record; return original.call(workers, record) }
    const first = await runner.run('true', [], { env: env() })
    expect(recordSeen).toMatchObject({ pid: first.pid, pgid: first.pid, ident: first.ident, command: 'true ', purpose: 'true' })
    expect(recordSeen.argv).toEqual([process.execPath, WORKER_GATE, GATE_FLAG, first.ident, '--', 'true'])
    expect(recordSeen.argv).toEqual(gateArgv({ ident: first.ident, command: 'true', args: [] }))
    expect(first.ident).toMatch(/^[0-9a-f-]{36}$/)
    const second = await runner.run('true', [], { env: env() })
    expect(second.ident).not.toBe(first.ident)
  })

  it('never starts the command when registration fails, and does not hide the failure', async () => {
    const marker = join(root, 'ran')
    const workers = registry({ registerError: new Error('journal disk full') })
    const runner = createRunner({ workers })
    let pid
    const original = workers.register
    workers.register = async (record) => { pid = record.pid; return original.call(workers, record) }
    const failure = await runner.run('sh', ['-c', `touch ${marker}`], { env: env() }).catch((error) => error)
    expect(failure).toBeInstanceOf(WorkerRegistryError)
    expect(failure.message).toMatch(/could not register worker.*journal disk full/)
    expect(failure.cause?.message).toBe('journal disk full')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(marker)).toBe(false)
    expect(pidDead(pid)).toBe(true)
    expect(workers.calls).toEqual([['register', pid]])
  })

  it('surfaces a failed release instead of swallowing it', async () => {
    const workers = registry({ releaseError: new Error('state write failed') })
    const runner = createRunner({ workers })
    const failure = await runner.run('true', [], { env: env() }).catch((error) => error)
    expect(failure).toBeInstanceOf(WorkerRegistryError)
    expect(failure.message).toMatch(/could not release worker \d+.*state write failed/)
    expect(failure.result).toMatchObject({ code: 0, settled: true })
  })

  it('does not report done until descendants the leader left behind are gone', async () => {
    const runner = createRunner({ workers: registry() })
    const started = Date.now()
    const result = await runner.run('sh', ['-c', 'sleep 30 & echo $!; exit 0'], { env: env() })
    const orphan = Number(result.stdout.trim())
    expect(orphan).toBeGreaterThan(1)
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(result.settled).toBe(true)
    expect(pgidAlive(result.pgid)).toBe(false)
    expect(await waitFor(() => pidDead(orphan), 2_000)).toBe(true)
  })

  it('kills the whole group on timeout and reports it as a failure', async () => {
    const workers = registry()
    const runner = createRunner({ workers })
    const started = Date.now()
    const failure = await runner.run('sh', ['-c', 'sleep 30 & echo $!; wait'], { env: env(), timeoutMs: 400 })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(SubprocessError)
    expect(failure.message).toMatch(/timed out after 400 ms/)
    expect(failure.result.timedOut).toBe(true)
    expect(failure.result.settled).toBe(true)
    expect(Date.now() - started).toBeLessThan(8_000)
    const orphan = Number(failure.result.stdout.trim())
    expect(pgidAlive(failure.result.pgid)).toBe(false)
    // The orphan is dead; launchd may still owe it a wait().
    expect(await waitFor(() => pidDead(orphan), 2_000)).toBe(true)
    // A settled group is released even when the run failed.
    expect(workers.calls).toEqual([['register', failure.result.pid], ['release', failure.result.pid]])
  })

  it('treats a non-zero exit as failure unless the caller allows it', async () => {
    const runner = createRunner({ workers: registry() })
    const failure = await runner.run('sh', ['-c', 'echo bad >&2; exit 3'], { env: env() }).catch((error) => error)
    expect(failure).toBeInstanceOf(SubprocessError)
    expect(failure.message).toMatch(/exited 3\nbad/)
    const allowed = await runner.run('sh', ['-c', 'exit 3'], { env: env(), allowFailure: true })
    expect(allowed.code).toBe(3)
  })

  it('pipes input through the gate to the command', async () => {
    const runner = createRunner({ workers: registry() })
    const result = await runner.run('cat', [], { env: env(), input: 'through the gate\n' })
    expect(result.stdout).toBe('through the gate\n')
  })

  it('bounds output in memory and in the log files separately', async () => {
    const runner = createRunner({ workers: registry() })
    const stdoutFile = join(root, 'logs', 'a', 'stdout.log')
    const stderrFile = join(root, 'logs', 'a', 'stderr.log')
    const result = await runner.run('sh', ['-c', 'yes 0123456789abcdef | head -c 200000'], {
      env: env(), maxOutputBytes: 1_000, maxLogBytes: 50_000, stdoutFile, stderrFile,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThan(1_000 + 70_000)
    expect(result.stdout.endsWith('\n[output truncated]\n')).toBe(true)
    expect(result.logs.stdout).toMatchObject({ file: stdoutFile, truncated: true })
    const size = (await stat(stdoutFile)).size
    expect(size).toBeLessThan(50_000 + 100)
    expect(await readFile(stdoutFile, 'utf8')).toMatch(/\[log truncated after \d+ bytes\]\n$/)
    expect((await stat(stdoutFile)).mode & 0o777).toBe(0o600)
    expect(result.logs.stderr).toMatchObject({ file: stderrFile, bytes: 0, truncated: false })
  })

  it('rejects an unusable invocation before spawning anything', async () => {
    const runner = createRunner({ workers: registry() })
    await expect(runner.run('true', [], {})).rejects.toThrow(/explicit environment/)
    await expect(runner.run('true', ['x', 1], { env: env() })).rejects.toThrow(/array of strings/)
    await expect(runner.run('', [], { env: env() })).rejects.toThrow(/requires a command/)
    await expect(runner.run('true', [], { env: env(), timeoutMs: 0 })).rejects.toThrow(/positive timeout/)
  })

  it('stops the group when the controlling process dies', async () => {
    // The command carries a one-off tag so the process table lookup cannot
    // pick up a gate that another test is still tearing down.
    const tag = `parent-death-${process.pid}-${Date.now()}`
    const script = `
      import { createRunner } from ${JSON.stringify(WORKER_GATE.replace(/worker-gate\.mjs$/, 'safe-runner.mjs'))}
      const runner = createRunner({ workers: { register: async () => {}, release: async () => {} } })
      runner.run('sh', ['-c', 'sleep 30 & echo $!; wait # ${tag}'], { env: ${JSON.stringify(env())}, timeoutMs: 60000 }).catch(() => {})
      setInterval(() => {}, 1000)
    `
    const controller = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    // Find the gate group by its unique argv, then take the controller down hard.
    let gate = null
    await waitFor(() => {
      const { stdout = '' } = spawnSync('ps', ['-eo', 'pid=,pgid=,command='], { encoding: 'utf8' })
      gate = stdout.split('\n').map((line) => line.trim())
        .find((line) => line.includes(`${GATE_FLAG} `) && line.includes(tag))
      return Boolean(gate)
    }, 8_000)
    expect(gate).toBeTruthy()
    const [gatePid, gatePgid] = gate.split(/\s+/).slice(0, 2).map(Number)
    expect(gatePid).toBeGreaterThan(1)
    expect(gatePgid).toBe(gatePid)
    expect(pgidAlive(gatePid)).toBe(true)
    controller.kill('SIGKILL')
    expect(await waitFor(() => !pgidAlive(gatePid), 10_000)).toBe(true)
  })
})

describe('a run that cannot settle', () => {
  it('rejects, keeps the record and never releases the worker', async () => {
    // A fake spawn whose gate "exits" while its group refuses to die.
    const workers = registry()
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdio = [null, child.stdout, child.stderr, { write: () => true, end() {}, destroy() {}, on() {} }]
    const spawnFake = () => child
    const runner = createRunner({ spawn: spawnFake, workers, log: () => {} })
    const alive = { value: true }
    const original = globalThis.process.kill
    globalThis.process.kill = (pid, signal) => {
      if (pid === -424242) {
        if (signal === 0 && alive.value) return true
        if (signal === 0) { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
        return true
      }
      return original.call(globalThis.process, pid, signal)
    }
    try {
      const run = runner.run('npm', ['ci'], { env: env() })
      await waitFor(() => workers.calls.length === 1)
      child.emit('exit', 70, null)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 70, null)
      const failure = await run.catch((error) => error)
      expect(failure).toBeInstanceOf(SubprocessError)
      expect(failure.message).toMatch(/left processes running/)
      expect(failure.result.settled).toBe(false)
      expect(workers.calls).toEqual([['register', 424242]])
      expect(Object.keys(workers.records)).toEqual(['424242'])
    } finally {
      globalThis.process.kill = original
    }
  }, 15_000)

  it('does not send GO until the registry resolved', async () => {
    const workers = registry()
    const child = new EventEmitter()
    child.pid = 515151
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const control = []
    child.stdio = [null, child.stdout, child.stderr, { write: (line) => { control.push(line); return true }, end() {}, destroy() {}, on() {} }]
    let resolveRegister
    workers.register = () => new Promise((resolve) => { resolveRegister = resolve })
    const original = globalThis.process.kill
    globalThis.process.kill = (pid, signal) => {
      if (pid === -515151) { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
      return original.call(globalThis.process, pid, signal)
    }
    try {
      const runner = createRunner({ spawn: () => child, workers })
      const run = runner.run('git', ['push'], { env: env() })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(control).toEqual([])
      resolveRegister()
      await waitFor(() => control.length === 1)
      expect(control).toEqual(['GO\n'])
      child.emit('exit', 0, null)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0, null)
      await expect(run).resolves.toMatchObject({ code: 0, settled: true })
      expect(workers.calls).toEqual([['release', 515151]])
    } finally {
      globalThis.process.kill = original
    }
  })
})

describe('reaping recorded groups after a crash', () => {
  const record = (pid, ident = '11111111-2222-3333-4444-555555555555') => ({
    pid, pgid: pid, ident, argv: gateArgv({ ident, command: 'npm', args: ['ci'] }), command: 'npm ci', purpose: 'release build',
  })
  const prefixOf = (entry) => `${process.execPath} ${WORKER_GATE} ${GATE_FLAG} ${entry.ident} --`

  it('signals only a live pid whose command line is exactly the recorded gate', () => {
    const entry = record(1001)
    const kills = []
    let alive = true
    const outcome = reapWorkersDetailed({ 1001: entry }, {
      alive: () => alive,
      commandLine: () => `${prefixOf(entry)} npm ci`,
      kill: (pid, signal) => { kills.push([pid, signal]); if (signal === 'SIGTERM') alive = false },
      wait: () => {},
    })
    expect(kills).toEqual([[1001, 'SIGTERM']])
    expect(outcome).toEqual({ killed: [{ pid: 1001, reason: 'killed' }], cleared: [], retained: [] })
  })

  it('escalates to SIGKILL and retains a group that survives it', () => {
    const entry = record(1002)
    const kills = []
    const outcome = reapWorkersDetailed({ 1002: entry }, {
      alive: () => true,
      commandLine: () => prefixOf(entry) + ' npm ci',
      kill: (pid, signal) => kills.push([pid, signal]),
      wait: () => {},
      graceMs: 1,
      killWaitMs: 1,
    })
    expect(kills).toEqual([[1002, 'SIGTERM'], [1002, 'SIGKILL']])
    expect(outcome.retained).toEqual([{ pid: 1002, reason: 'survived SIGKILL' }])
    expect(reapWorkers({ 1002: entry }, { alive: () => true, commandLine: () => prefixOf(entry), kill: () => {}, wait: () => {}, graceMs: 1, killWaitMs: 1 }))
      .toEqual([])
  })

  it('never signals a reused pid, a different ident or a record without identity', () => {
    const entry = record(1003)
    const kills = []
    const options = { alive: () => true, kill: (pid, signal) => kills.push([pid, signal]), wait: () => {} }
    const reused = reapWorkersDetailed({ 1003: entry }, { ...options, commandLine: () => '/usr/bin/ssh-agent -l' })
    expect(reused.cleared).toEqual([{ pid: 1003, reason: 'pid reused by another process' }])
    const other = record(1003, '99999999-2222-3333-4444-555555555555')
    const different = reapWorkersDetailed({ 1003: entry }, { ...options, commandLine: () => `${prefixOf(other)} npm ci` })
    expect(different.cleared).toEqual([{ pid: 1003, reason: 'pid reused by another process' }])
    const legacy = reapWorkersDetailed({ 1003: { pid: 1003, command: 'npm ci' } }, { ...options, commandLine: () => `${prefixOf(entry)} npm ci` })
    expect(legacy.retained).toEqual([{ pid: 1003, reason: 'no identity recorded; not signalled' }])
    const unreadable = reapWorkersDetailed({ 1003: entry }, { ...options, commandLine: () => null })
    expect(unreadable.retained).toEqual([{ pid: 1003, reason: 'process table unreadable' }])
    expect(kills).toEqual([])
  })

  it('clears dead records and skips nonsense pids without signalling', () => {
    const kills = []
    const outcome = reapWorkersDetailed({ a: record(1004), b: { pid: 'x' }, c: { pid: 1 }, d: null }, {
      alive: () => false, commandLine: () => { throw new Error('must not be consulted') }, kill: (...args) => kills.push(args), wait: () => {},
    })
    expect(outcome).toEqual({ killed: [], cleared: [{ pid: 1004, reason: 'dead' }], retained: [] })
    expect(kills).toEqual([])
    expect(reapWorkers({ a: record(1004) }, { alive: () => false })).toEqual([1004])
  })

  it('kills a real orphaned gate group only after verifying its argv', async () => {
    // Start a gate by hand, as a crashed controller would have left it, then
    // reap it from its record.
    // The gate is started through a short-lived intermediary so that, like a
    // real crash survivor, it is reparented to init rather than being this
    // process's child (a dead child stays a zombie until the event loop
    // reaps it, and a zombie still answers kill(-pgid, 0)).
    const ident = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const argv = gateArgv({ ident, command: 'sh', args: ['-c', 'sleep 30 & wait'] })
    const launcher = `
      import { spawn } from 'node:child_process'
      const gate = spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 3] })
      gate.unref()
      process.stdout.write(String(gate.pid))
    `
    const intermediary = spawn(process.execPath, ['--input-type=module', '-e', launcher], {
      env: env(), stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
    })
    const control = intermediary.stdio[3]
    let printed = ''
    intermediary.stdout.on('data', (chunk) => { printed += chunk })
    await new Promise((resolve) => intermediary.once('exit', resolve))
    const gatePid = Number(printed.trim())
    expect(gatePid).toBeGreaterThan(1)
    control.write('GO\n')
    await waitFor(() => spawnSync('ps', ['-o', 'command=', '-p', String(gatePid)], { encoding: 'utf8' }).stdout.includes(ident))
    const entry = { pid: gatePid, pgid: gatePid, ident, argv, command: 'sh -c sleep 30 & wait', purpose: 'test' }
    expect(gateIdentityPrefix(entry)).toBe(`${process.execPath} ${WORKER_GATE} ${GATE_FLAG} ${ident} --`)
    const outcome = reapWorkersDetailed({ [gatePid]: entry })
    expect(outcome).toEqual({ killed: [{ pid: gatePid, reason: 'killed' }], cleared: [], retained: [] })
    expect(pgidAlive(gatePid)).toBe(false)
    control.destroy()
  }, 15_000)
})
