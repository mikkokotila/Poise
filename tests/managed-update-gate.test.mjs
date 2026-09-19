import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selfUpdateEnabled, supervisorRequest } from '../scripts/self-update-bridge.mjs'
import { reconcileRuntime } from '../scripts/update-caller.mjs'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-managed-update-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const sha = 'a'.repeat(40)
const callerSha = 'c'.repeat(40)
function harness(status) {
  let report
  const run = vi.fn(async () => { throw new Error('Legacy command must not run') })
  const options = { home: root, run, readState: async () => null,
    writeState: async (_path, value) => { report = value }, selfUpdateStatus: async () => status }
  return { options, run, report: () => report }
}
describe('legacy updater hands over release ownership', () => {
  it('does not install Poise or Caller when the controller is enabled', async () => {
    const h = harness({ enabled: true, activeRelease: { sha, callerSha }, hold: null })
    expect(await reconcileRuntime(h.options)).toEqual({ action: 'managed-self-update', poiseCommit: sha })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.report()).toMatchObject({ status: 'current', poise: { deployed: sha, installed: sha }, caller: callerSha })
  })
  it('preserves the promotion hold rather than reinstalling a rejected release', async () => {
    const h = harness({ enabled: true, activeRelease: { sha, callerSha }, hold: { sha, reason: 'User reverted' } })
    await expect(reconcileRuntime(h.options)).rejects.toThrow(/promotion held/)
    expect(h.run).not.toHaveBeenCalled()
  })
  it('fails closed when an enabled controller is unavailable', async () => {
    const h = harness(null)
    h.options.selfUpdateStatus = async () => { throw new Error('Controller offline') }
    await expect(reconcileRuntime(h.options)).rejects.toThrow(/offline/)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.report()).toMatchObject({ status: 'failed' })
  })
  it('refuses an unverified controller response', async () => {
    const h = harness({ enabled: true, activeRelease: null })
    await expect(reconcileRuntime(h.options)).rejects.toThrow(/verified active release/)
    expect(h.run).not.toHaveBeenCalled()
  })
  it('uses only an explicitly enabled private configuration', async () => {
    expect(await selfUpdateEnabled(root)).toBe(false)
    await writeFile(join(root, 'config.json'), '{"enabled":true}', { mode: 0o600 })
    expect(await selfUpdateEnabled(root)).toBe(true)
    await chmod(join(root, 'config.json'), 0o644)
    await expect(selfUpdateEnabled(root)).rejects.toThrow(/Unsafe/)
  })
  it('does not connect over the network as a fallback for a missing Unix socket', async () => {
    await mkdir(join(root, 'empty'))
    await expect(supervisorRequest(root, 'GET', '/status')).rejects.toThrow()
  })
})

describe('persistent controller ownership', () => {
  it('does not hand production back to the legacy installer if config disappears', async () => {
    await writeFile(join(root, 'installed.json'), '{}', { mode: 0o600 })
    await expect(selfUpdateEnabled(root)).rejects.toThrow(/configuration unavailable/)
  })
  it('keeps the legacy installer blocked in maintenance', async () => {
    await writeFile(join(root, 'installed.json'), '{}', { mode: 0o600 })
    await writeFile(join(root, 'config.json'), '{"enabled":false}', { mode: 0o600 })
    await expect(selfUpdateEnabled(root)).rejects.toThrow(/maintenance/)
  })
})
