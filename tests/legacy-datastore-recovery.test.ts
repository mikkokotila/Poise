import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../server/organizations'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
let root: string
let database: typeof import('../server/db')
let recovery: typeof import('../server/legacy-datastore-recovery')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const bin = '/poise/caller/venv/bin'
const path = "/legacy/owner's github.sqlite"
const org: Organization = {
  login: 'Vaquum', datastorePath: path, managed: false, status: 'ready', stage: 'ready',
  error: null, activatedAt: null, retryAt: null,
}
const shell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const job = () => ({
  Label: 'com.vaquum.github-datastore.sync',
  ProgramArguments: ['/bin/zsh', '-lc', `set -euo pipefail; exec '${bin}/github-datastore' --db ${shell(path)} 'sync' '--loop' '--interval' '60' '--workers' '12'`],
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-legacy-recovery-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('CALLER_BIN_ROOT', bin)
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  vi.resetModules()
  database = await import('../server/db')
  recovery = await import('../server/legacy-datastore-recovery')
  mocks.runFile.mockReset().mockImplementation(async (command: string) => ({
    stdout: command === '/usr/bin/plutil' ? JSON.stringify(job()) : '', stderr: '',
  }))
})
afterEach(async () => {
  database.closeDatabase()
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
describe('legacy datastore sync recovery', () => {
  it('coalesces parallel gates, retains cooldown over module restart, and never kills a sync', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const results = await Promise.all(Array.from({ length: 4 }, () => recovery.recoverLegacyDatastore(org)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    expect(mocks.runFile.mock.calls[1][1]).toEqual(['kickstart', `gui/${process.getuid!()}/com.vaquum.github-datastore.sync`])
    database.closeDatabase()
    vi.resetModules()
    database = await import('../server/db')
    recovery = await import('../server/legacy-datastore-recovery')
    expect(await recovery.recoverLegacyDatastore(org)).toBe(false)
    now.mockReturnValue(70_000)
    expect(await recovery.recoverLegacyDatastore(org)).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
  })
  it('also wakes the matching pre-loop installation during an upgrade', async () => {
    const previous = job()
    previous.ProgramArguments[2] = previous.ProgramArguments[2].replace(" '--loop' '--interval' '60'", '')
    mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify(previous), stderr: '' })
    expect(await recovery.recoverLegacyDatastore(org)).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
  })
  it.each(['database', 'binary', 'label', 'arguments'] as const)('does not wake an unmatched %s job', async (field) => {
    const changed = job()
    if (field === 'database') changed.ProgramArguments[2] = changed.ProgramArguments[2].replace(shell(path), "'/other.sqlite'")
    if (field === 'binary') changed.ProgramArguments[2] = changed.ProgramArguments[2].replace(bin, '/other/bin')
    if (field === 'label') changed.Label = 'external.sync'
    if (field === 'arguments') changed.ProgramArguments = ['/bin/zsh', '-c', changed.ProgramArguments[2]]
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(changed), stderr: '' })
    expect(await recovery.recoverLegacyDatastore(org)).toBe(false)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('leaves managed accounts and unmanaged runtime installations alone', async () => {
    expect(await recovery.recoverLegacyDatastore({ ...org, managed: true })).toBe(false)
    vi.stubEnv('CALLER_BIN_ROOT', '')
    expect(await recovery.recoverLegacyDatastore(org)).toBe(false)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
  it('bounds failed recovery attempts and preserves the failure for the caller', async () => {
    mocks.runFile.mockRejectedValue(new Error('service unavailable'))
    await expect(recovery.recoverLegacyDatastore(org)).rejects.toThrow('service unavailable')
    expect(await recovery.recoverLegacyDatastore(org)).toBe(false)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
})
