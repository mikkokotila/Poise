import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveReviewCheckout } from '../server/review-checkout'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
const owner = 'autonomio', repo = 'autonomio', actor = 'bit-mis', head = 'a'.repeat(40)
const remote = `https://github.com/${owner}/${repo}.git`
let root: string
let wrongHead = false
let dirty = false
let failedFetch = false
const resolveCheckout = (signal?: AbortSignal) => resolveReviewCheckout(owner, repo, 146, actor, head, signal)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-review-checkout-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  wrongHead = dirty = failedFetch = false
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      throw Object.assign(new Error('Command failed (1): github-interface'), {
        code: 1, stderr: `error: checkout not found under /dev: ${owner}/${repo}\n`,
      })
    }
    if (command === 'github-interface' && args[0] === '--checkout-repo') {
      if (failedFetch) throw new Error('reviewer cannot read repository')
      await mkdir(args[3], { recursive: true })
      return { stdout: JSON.stringify({ action: 'checkout_repo', repository: `${owner}/${repo}`, path: args[3] }), stderr: '' }
    }
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { stdout: remote, stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: wrongHead ? 'b'.repeat(40) : head, stderr: '' }
    if (command === 'git' && args[0] === 'status') return { stdout: dirty ? ' M file.ts' : '', stderr: '' }
    return { stdout: '', stderr: '' }
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
describe('review checkout provisioning through Caller', () => {
  it('uses an existing user checkout without changing it', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ action: 'local_checkout_path', repository: `${owner}/${repo}`, path: root }), stderr: '' })
    expect(await resolveCheckout()).toBe(root)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('coalesces concurrent provisioning, pins the head and uses only the reviewer identity', async () => {
    const paths = await Promise.all([resolveCheckout(), resolveCheckout(), resolveCheckout()])
    expect(new Set(paths).size).toBe(1)
    expect(paths[0]).toBe(join(root, 'review-checkouts', head, owner, repo))
    const fetches = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--checkout-repo')
    expect(fetches).toHaveLength(1)
    expect(fetches[0][1].slice(0, 3)).toEqual(['--checkout-repo', `${owner}/${repo}`, '--path'])
    expect(mocks.runFile).toHaveBeenCalledWith('git', ['checkout', '--quiet', '--detach', head], expect.any(Object))
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })
  it.each(['head changed', 'denied access', 'dirty checkout'] as const)('does not publish or retain staging after %s', async (cause) => {
    wrongHead = cause === 'head changed'
    failedFetch = cause === 'denied access'
    dirty = cause === 'dirty checkout'
    await expect(resolveCheckout()).rejects.toThrow()
    expect(await readdir(join(root, 'review-checkouts', head, owner))).toEqual([`${repo}.lock`])
  })
  it('does not overwrite a managed checkout that was subsequently changed', async () => {
    const path = await resolveCheckout()
    await writeFile(join(path, 'user-work'), 'keep')
    dirty = true
    await expect(resolveCheckout()).rejects.toThrow('local changes')
    expect(await readFile(join(path, 'user-work'), 'utf8')).toBe('keep')
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--checkout-repo')).toHaveLength(1)
  })
  it.each(['timeout', 'GitHub 404', 'malformed response'] as const)('does not provision on %s', async (cause) => {
    if (cause === 'malformed response') mocks.runFile.mockResolvedValueOnce({ stdout: 'null', stderr: '' })
    else mocks.runFile.mockRejectedValueOnce(Object.assign(new Error(cause), { code: 1, stderr: cause }))
    await expect(resolveCheckout()).rejects.toThrow()
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('never substitutes the fixed checkout identity for another reviewer', async () => {
    await expect(resolveReviewCheckout(owner, repo, 146, 'other-reviewer', head)).rejects.toThrow('explicit checkout identity')
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('rejects path traversal before invoking any process', async () => {
    await expect(resolveReviewCheckout(owner, '..', 146, actor, head)).rejects.toThrow('Invalid review')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})
