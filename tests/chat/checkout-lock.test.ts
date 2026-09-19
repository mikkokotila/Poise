import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { CheckoutLease, LEASE_MS, canonicalCheckout, checkoutLockPath } from '../../server/chat/checkout-lock'
import { pgidAlive, pidAlive, spawnWorker, workerIdentityMatches } from '../../server/chat/worker'

const CONTENDER = resolve('tests/fixtures/chat/lock-contender.py')
let root = ''
let checkout = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-lock-test-'))
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  checkout = join(root, 'checkout')
  await mkdir(checkout)
})

afterAll(async () => {
  delete process.env.POISE_LOCK_DIR
  await rm(root, { recursive: true, force: true })
})

function lease(ownerId: string, options: ConstructorParameters<typeof CheckoutLease>[2] = {}): CheckoutLease {
  return new CheckoutLease(checkout, {
    ownerKind: 'poise:chat',
    ownerId,
    ownerLabel: `chat ${ownerId} (Poise test)`,
    instance: 'poise-test:db',
  }, options)
}

function readRow(): any {
  const db = new Database(checkoutLockPath(canonicalCheckout(checkout)))
  try { return db.prepare('SELECT * FROM lease WHERE id = 1').get() } finally { db.close() }
}

function python(args: string[]): Promise<{ code: number | null, stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('python3', [CONTENDER, ...args], { env: { ...process.env } })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('close', (code) => resolvePromise({ code, stdout }))
  })
}

// Members of a process group other than its leader, via ps (macOS and Linux).
async function groupMembers(pgid: number): Promise<number[]> {
  const { runFile } = await import('../../server/process')
  try {
    const { stdout } = await runFile('ps', ['-eo', 'pid=,pgid='], { timeoutMs: 5_000 })
    return stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => group === pgid && pid !== pgid).map(([pid]) => pid)
  } catch { return [] }
}

async function waitForChildren(pgid: number, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while ((await groupMembers(pgid)).length === 0) {
    if (Date.now() > deadline) throw new Error('worker never started its command')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('checkout lease', () => {
  it('acquires, re-enters by token only, and releases', () => {
    const a = lease('a')
    const first = a.tryAcquire()
    expect(first).toMatchObject({ acquired: true, recovered: false })
    // Re-entry by the same holder object (same token) refreshes.
    expect(a.tryAcquire()).toMatchObject({ acquired: true })
    // The same owner id from another process/object is a different holder.
    const impostor = lease('a')
    expect(impostor.tryAcquire()).toMatchObject({ acquired: false, reason: 'live_host' })
    expect(a.release()).toBe(true)
    expect(impostor.tryAcquire()).toMatchObject({ acquired: true })
    impostor.release()
  })

  it('blocks takeover while the host is alive even when the lease is stale', () => {
    const now = { value: Date.now() }
    const a = lease('a', { now: () => now.value })
    expect(a.tryAcquire().acquired).toBe(true)
    now.value += LEASE_MS * 3
    const b = lease('b', { now: () => now.value })
    expect(b.tryAcquire()).toMatchObject({ acquired: false, reason: 'live_host' })
    a.release()
  })

  it('recovers a stale row of a dead host with no live worker, and the old token cannot renew', () => {
    const now = { value: Date.now() }
    const a = lease('a', { now: () => now.value, hostPid: 999_999_9, pidAlive: () => false })
    expect(a.tryAcquire().acquired).toBe(true)
    const oldToken = a.currentToken!
    // Not stale yet: busy.
    const b = lease('b', { now: () => now.value, pidAlive: () => false })
    expect(b.tryAcquire()).toMatchObject({ acquired: false, reason: 'lease_valid' })
    now.value += LEASE_MS + 1
    expect(b.tryAcquire()).toMatchObject({ acquired: true, recovered: true })
    expect(readRow().token).not.toBe(oldToken)
    // ABA: the previous holder's renew/register/release all fail.
    expect(a.heartbeat()).toBe(false)
    expect(a.held).toBe(false)
    expect(a.registerWorker({ pid: 1, pgid: 1, ident: 'x' })).toBe(false)
    expect(a.release()).toBe(false)
    expect(readRow().token).toBe(b.currentToken)
    b.release()
  })

  it('keeps a dead host busy while its registered worker group lives', () => {
    const now = { value: Date.now() }
    const a = lease('a', { now: () => now.value, hostPid: 999_999_8, pidAlive: () => false })
    expect(a.tryAcquire().acquired).toBe(true)
    expect(a.registerWorker({ pid: 4242, pgid: 4242, ident: 'gate-ident' })).toBe(true)
    now.value += LEASE_MS + 1
    const b = lease('b', { now: () => now.value, pidAlive: () => false, pgidAlive: (pgid) => pgid === 4242 })
    expect(b.tryAcquire()).toMatchObject({ acquired: false, reason: 'orphan_worker', orphan: true })
    // Leader dead, group dead → recoverable.
    const c = lease('c', { now: () => now.value, pidAlive: () => false, pgidAlive: () => false })
    expect(c.tryAcquire()).toMatchObject({ acquired: true, recovered: true })
    c.release()
  })

  it('interoperates with a Python sqlite3 contender using the published schema', async () => {
    const a = lease('a')
    expect(a.tryAcquire().acquired).toBe(true)
    const busy = await python(['try', checkout])
    expect(busy.code).toBe(3)
    expect(busy.stdout).toContain('busy live_host chat a (Poise test)')
    a.release()

    // Python holds; TypeScript sees the label and waits until it releases.
    const holder = spawn('python3', [CONTENDER, 'acquire', checkout, 'stdin'], { env: { ...process.env } })
    let out = ''
    holder.stdout.on('data', (chunk) => { out += chunk })
    const closed = new Promise<number | null>(resolve => holder.once('close', resolve))
    const b = lease('b')
    try {
      await waitFor(() => out.includes('acquired'))
      const attempt = b.tryAcquire()
      expect(attempt).toMatchObject({ acquired: false, reason: 'live_host' })
      if (!attempt.acquired) expect(attempt.holder.owner_label).toBe('fix-failing-ci test (python)')
      const waiting = b.acquire()
      holder.stdin.end('release\n')
      const acquired = await waiting
      expect(acquired.acquired).toBe(true)
      // The SQLite release commits before Python's log reaches Node. `close`
      // proves stdout is drained; acquiring the lease alone does not.
      expect(await closed).toBe(0)
      expect(out).toContain('released')
    } finally {
      b.release()
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM')
      await closed
    }
  })

  it('refuses takeover from a dead Python holder whose worker pid is alive', async () => {
    // A live sleep stands in for a native worker whose leader died.
    const worker = spawn('sleep', ['30'], { detached: true })
    const python = lease('py', { hostPid: 999_999_7, pidAlive: (pid) => pid === worker.pid })
    const row = python.tryAcquire()
    expect(row.acquired).toBe(true)
    python.registerWorker({ pid: worker.pid!, pgid: worker.pid!, ident: 'py-worker' })
    const now = Date.now() + LEASE_MS * 2
    const b = lease('b', { now: () => now })
    expect(b.tryAcquire()).toMatchObject({ acquired: false, reason: 'orphan_worker' })
    worker.kill('SIGKILL')
    await new Promise((r) => worker.once('exit', r))
    expect(b.tryAcquire()).toMatchObject({ acquired: true, recovered: true })
    b.release()
  })
})

describe('worker gate', () => {
  it('runs nothing before GO and exits without spawning when the holder goes away', async () => {
    const marker = join(root, 'never-created')
    const worker = spawnWorker('sh', ['-c', `touch ${JSON.stringify(marker)}; sleep 5`], { cwd: root })
    expect(pidAlive(worker.pid)).toBe(true)
    // Close the control descriptor without GO: the gate must leave.
    ;(worker.child.stdio[3] as any).end()
    const exit = await worker.exited
    expect(exit.code).toBe(3)
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })

  it('registers before GO, verifies identity, and takes the group down when the holder dies', async () => {
    const a = lease('gate')
    expect(a.tryAcquire().acquired).toBe(true)
    // The command spawns a grandchild so the group outlives the direct child.
    const worker = spawnWorker('sh', ['-c', 'sleep 20 & wait'], { cwd: root })
    expect(a.registerWorker({ pid: worker.pid, pgid: worker.pgid, ident: worker.ident })).toBe(true)
    expect(await workerIdentityMatches(worker.pid, worker.ident)).toBe(true)
    expect(await workerIdentityMatches(worker.pid, 'not-the-ident-000')).toBe(false)
    worker.go()
    await waitForChildren(worker.pgid)
    // Holder "dies": the control pipe closes; the gate must terminate its group.
    ;(worker.child.stdio[3] as any).end()
    await worker.exited
    await waitFor(() => !pgidAlive(worker.pgid), 8_000)
    a.release()
  })

  it('keeps blocking other writers while a killed leader leaves a live child', async () => {
    const now = { value: Date.now() }
    const a = lease('gate2', { now: () => now.value, hostPid: 999_999_6, pidAlive: (pid) => pid !== 999_999_6 && pidAlive(pid) })
    expect(a.tryAcquire().acquired).toBe(true)
    const worker = spawnWorker('sh', ['-c', 'sleep 20 & wait'], { cwd: root })
    a.registerWorker({ pid: worker.pid, pgid: worker.pgid, ident: worker.ident })
    worker.go()
    await waitForChildren(worker.pgid)
    // Kill only the leader; descendants keep the group alive.
    process.kill(worker.pid, 'SIGKILL')
    await worker.exited
    await new Promise((r) => setTimeout(r, 100))
    expect(pidAlive(worker.pid)).toBe(false)
    expect(pgidAlive(worker.pgid)).toBe(true)
    now.value += LEASE_MS + 1
    const b = lease('b', { now: () => now.value, pidAlive: (pid) => pid !== 999_999_6 && pidAlive(pid) })
    expect(b.tryAcquire()).toMatchObject({ acquired: false, reason: 'orphan_worker' })
    try { process.kill(-worker.pgid, 'SIGKILL') } catch { /* gone */ }
    await waitFor(() => !pgidAlive(worker.pgid), 5_000)
    expect(b.tryAcquire()).toMatchObject({ acquired: true, recovered: true })
    b.release()
  })

  it('terminate() escalates and resolves once the group is gone', async () => {
    const worker = spawnWorker('sh', ['-c', 'trap "" TERM; sleep 30'], { cwd: root })
    worker.go()
    await waitForChildren(worker.pgid)
    const started = Date.now()
    await worker.terminate(300)
    expect(Date.now() - started).toBeLessThan(5_000)
    await waitFor(() => !pgidAlive(worker.pgid), 5_000)
  })
})
