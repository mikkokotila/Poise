import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CATALOG } from '../model-catalog-fixture'
import type { ChatRuntime } from '../../server/chat/runtime'
import type { Adapter, TurnResult } from '../../server/chat/adapters/types'
import { ensureLocalWorkspace } from '../../server/chat/local-workspace'

let root: string, outer: string, Runtime: typeof ChatRuntime, runtime: ChatRuntime
const resolveCheckout = vi.fn(async () => { throw new Error('must not look up a repository') })
function git(...args: string[]): string { return execFileSync('git', args, { cwd: outer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!check()) { if (Date.now() > deadline) throw new Error('local session deadline'); await new Promise(r => setTimeout(r, 25)) }
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-local-chat-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.db'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../../server/chat/runtime'))
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
afterEach(async () => { await runtime?.stop() })
function fakeAdapter(): Adapter {
  let alive = false
  let finish: ((result: TurnResult) => void) | undefined
  const cancel = () => { finish?.({ stopReason: 'cancelled' }); finish = undefined }
  const capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  return { agent: 'grok', nativeSessionId: randomUUID(), capabilities, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId: randomUUID(), capabilities, modelId: options.modelId, effort: options.effort } },
    async prompt() { return new Promise<TurnResult>(resolve => { finish = resolve }) },
    async cancel() { cancel() }, async close() { alive = false; cancel() }, async steer() {}, async setMode() {},
    async setModel(modelId, effort) { return { modelId, effort } }, async fork() { return randomUUID() }, onExit() {},
  }
}
beforeEach(async () => {
  outer = join(root, randomUUID()); await mkdir(outer)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null')
  await writeFile(join(outer, '.gitignore'), '/.poise-chat/\n')
  await writeFile(join(outer, 'source.ts'), 'original\n')
  git('add', '.gitignore', 'source.ts'); git('commit', '-qm', 'fixture')
  await writeFile(join(outer, 'source.ts'), 'uncommitted user work\n')
  resolveCheckout.mockClear()
  runtime = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
    catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
    idleTimeoutMinutes: () => 0, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
})
describe('Poise-local session storage', () => {
  it('does not look up a repository or touch the outer branch, index or dirty files', async () => {
    const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain'), index = git('diff', '--cached')
    const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high' })
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(record).toMatchObject({ repo: '', workspaceKind: 'poise-local' })
    expect(record.checkout).toContain('/.poise-chat/workspace')
    expect(resolveCheckout).not.toHaveBeenCalled()
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('branch', '--show-current')).toBe('main')
    expect(git('status', '--porcelain')).toBe(status)
    expect(git('diff', '--cached')).toBe(index)
    expect(await readFile(join(outer, 'source.ts'), 'utf8')).toBe('uncommitted user work\n')
    expect(git('check-ignore', '.poise-chat/workspace')).toBe('.poise-chat/workspace')
  }, 30_000)

  it('records the catalogue identity matching the selected effort', async () => {
    const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', effort: 'xhigh' })
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(record).toMatchObject({ model: 'grok-4.6-xhigh', effort: 'xhigh' })
    await expect(runtime.create({ agent: 'grok', model: 'grok-4.6-high', effort: 'max' })).rejects.toMatchObject({ code: 'invalid' })
  }, 30_000)

  it('refuses symlinked local storage instead of writing elsewhere', async () => {
    const outside = join(root, randomUUID()); await mkdir(outside)
    await symlink(outside, join(outer, '.poise-chat'))
    await expect(ensureLocalWorkspace(join(outer, '.poise-chat'))).rejects.toThrow(/plain directory/)
    expect(await readdir(outside)).toEqual([])
  })
  it('creates a second session while the first runs, then queues its workspace access', async () => {
    const first = await runtime.create({ agent: 'grok', model: 'grok-4.6-high' })
    await until(() => runtime.get(first.id)?.status === 'idle')
    runtime.prompt(first.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(first.id)?.status === 'running')
    const second = await runtime.create({ agent: 'grok', model: 'grok-4.6-high' })
    expect(runtime.get(first.id)?.status).toBe('running')
    await until(() => runtime.get(second.id)?.status === 'queued')
    await runtime.cancel(first.id)
    await until(() => runtime.get(second.id)?.status === 'idle')
    expect(second.checkout).toBe(first.checkout)
    expect(second.branch.name).not.toBe(first.branch.name)
    expect(git('branch', '--show-current')).toBe('main')
  }, 30_000)
})

it('retains the initialization lease when a bootstrap worker cannot be verified stopped', async () => {
  const commands = await import('../../server/chat/git')
  const workers = await import('../../server/chat/worker')
  const held: { lease?: import('../../server/chat/checkout-lock').CheckoutLease } = {}
  const alive = vi.spyOn(workers, 'pgidAlive').mockReturnValue(true)
  const guarded = vi.spyOn(commands, 'runGuarded').mockImplementation(async lease => {
    held.lease = lease
    lease.registerWorker({ pid: 999999, pgid: 999999, ident: 'unsettled-fixture' })
    throw new Error('bootstrap worker did not settle')
  })
  try {
    await expect(ensureLocalWorkspace(join(outer, '.poise-chat'))).rejects.toThrow('did not settle')
    expect(held.lease?.held).toBe(true)
    expect(held.lease?.read()?.worker_pgid).toBe(999999)
  } finally {
    held.lease?.clearWorker()
    held.lease?.release()
    guarded.mockRestore()
    alive.mockRestore()
  }
})
