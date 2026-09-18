import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACQUIRE_POLL_MS, CheckoutLease } from '../server/chat/checkout-lock'
import { pgidAlive, pidAlive } from '../server/chat/worker'

let root = ''
const leases: CheckoutLease[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-lock-review-'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
})
afterEach(async () => {
  for (const lease of leases.splice(0)) { try { lease.release() } catch { /* test-injected failure */ } }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function makeLease(id: string) {
  const lease = new CheckoutLease(root, { ownerKind: 'poise:chat', ownerId: id, ownerLabel: id, instance: 'review' })
  leases.push(lease)
  return lease
}

describe('Chat lock failure regression cases', () => {
  it('does not acquire a checkout for an already-cancelled request', async () => {
    const lease = makeLease('cancelled')
    const controller = new AbortController()
    controller.abort()
    await expect(lease.acquire({ signal: controller.signal })).rejects.toThrow()
    expect(lease.read()).toBeNull()
  })

  it('keeps only the current wait listener while a checkout stays busy', async () => {
    vi.useFakeTimers()
    const holder = makeLease('holder')
    expect(holder.tryAcquire().acquired).toBe(true)
    const waiting = makeLease('waiting')
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = waiting.acquire({ signal: controller.signal }).catch(error => error)
    try {
      await vi.advanceTimersByTimeAsync(ACQUIRE_POLL_MS * 3 + 1)
      const active = add.mock.calls.filter(([event, listener]) => event === 'abort'
        && !remove.mock.calls.some(([name, callback]) => name === event && callback === listener))
      expect(active.length).toBeLessThanOrEqual(1)
    } finally {
      controller.abort()
      await result
    }
  })

  it('retains the acquisition identity when deleting the lease fails', () => {
    const lease = makeLease('release')
    expect(lease.tryAcquire().acquired).toBe(true)
    const token = lease.currentToken
    const db = new Database(lease.path)
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON lease BEGIN SELECT RAISE(ABORT, 'injected release failure'); END")
    try {
      expect(() => lease.release()).toThrow('injected release failure')
      expect(lease.currentToken).toBe(token)
      expect(lease.held).toBe(true)
    } finally {
      db.exec('DROP TRIGGER fail_delete')
      db.close()
    }
    expect(lease.release()).toBe(true)
  })

  it('notifies the owner when a heartbeat cannot verify or renew its lease', () => {
    const lease = makeLease('heartbeat')
    expect(lease.tryAcquire().acquired).toBe(true)
    const lost = vi.fn()
    lease.onLost(lost)
    const db = new Database(lease.path)
    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON lease BEGIN SELECT RAISE(ABORT, 'injected heartbeat failure'); END")
    try {
      try { lease.heartbeat() } catch { /* either throw or false may report failure */ }
      expect(lost).toHaveBeenCalled()
    } finally { db.exec('DROP TRIGGER fail_update'); db.close() }
  })

  it('does not interpret an unexpected liveness error as proof of death', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unavailable'), { code: 'EIO' }) })
    for (const probe of [pidAlive, pgidAlive]) {
      let couldBeAlive = true
      try { couldBeAlive = probe(123456) } catch { /* propagating uncertainty is fail-closed */ }
      expect(couldBeAlive).toBe(true)
    }
  })
})
