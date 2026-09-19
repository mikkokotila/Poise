import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { ChatRuntime as RuntimeType } from '../server/chat/runtime'
import type { Capabilities, ChatEnvelope, PromptInput } from '../server/chat/protocol'

let root = ''
let checkout = ''
let Runtime: typeof RuntimeType
let runtime: RuntimeType
let host: AdapterHost
let startupBranch = ''
let currentFinish: ((result: TurnResult) => void) | null = null
let promptCount = 0
let autoFinish = false
const capabilities: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const input: PromptInput = { text: 'fixture task', attachments: [], mentions: [] }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function git(...args: string[]) { return execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await pause(20) }
  throw new Error('fixture state deadline')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-runtime-review-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
})
beforeEach(async () => {
  checkout = join(root, randomUUID())
  await mkdir(checkout)
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.name', 'Poise test')
  git('config', 'user.email', 'poise-test@example.invalid')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture')
  git('branch', 'topic')
  promptCount = 0
  autoFinish = false
  currentFinish = null
  startupBranch = ''
  runtime = new Runtime({ instance: `review:${randomUUID()}`, instanceLabel: 'test', adapters: { grok: fakeAdapter }, callerTurns: null, catalog: async () => CATALOG, resolveCheckout: async () => checkout, idleTimeoutMinutes: () => 0 })
})
afterEach(async () => { autoFinish = true; currentFinish?.({ stopReason: 'cancelled' }); await runtime?.stop(); await pause(30) })
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function fakeAdapter(h: AdapterHost): Adapter {
  host = h
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = (result: TurnResult) => { const pending = currentFinish; currentFinish = null; pending?.(result) }
  return {
    agent: 'grok', nativeSessionId, capabilities, get alive() { return alive },
    async start(options) { startupBranch = git('branch', '--show-current'); alive = true; return { nativeSessionId, capabilities, modelId: options.modelId, effort: options.effort } },
    async prompt() { promptCount++; if (autoFinish) return { stopReason: 'cancelled' }; return new Promise<TurnResult>(resolve => { currentFinish = resolve }) },
    async cancel() { finish({ stopReason: 'cancelled' }) },
    async close() { alive = false; finish({ stopReason: 'cancelled' }) },
    async steer() { /* fixture */ },
    async setMode() { /* fixture */ },
    async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() },
    onExit() { /* no real native process */ },
  }
}
async function session() {
  const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: 'fixture/repo', branch: { existing: 'topic' } })
  await until(() => runtime.get(record.id)?.status === 'idle')
  return record.id
}

describe('Chat runtime lifecycle regression cases', () => {
  it('initializes the native agent only after selecting the bound branch', async () => {
    await session()
    expect(startupBranch).toBe('topic')
  })

  it('reserves a turn before acknowledging two simultaneous prompts', async () => {
    const id = await session()
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => runtime.prompt(id, input)), Promise.resolve().then(() => runtime.prompt(id, input))])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('closes a running session without waiting behind the entire coding turn', async () => {
    const id = await session()
    await runtime.prompt(id, input)
    await until(() => promptCount === 1)
    // The fake turn can finish only when close reaches adapter.cancel().
    // Await it without manually resolving the turn: queueing close behind
    // the coding turn would deadlock and fail the test timeout. A 400 ms
    // stopwatch instead measured unrelated concurrent build/disk contention.
    const closed = await runtime.close(id)
    expect(closed.status).toBe('closed')
    expect(currentFinish).toBeNull()
  })

  it('refuses agent filesystem writes while its session is idle and holds no lease', async () => {
    await session()
    await expect(host.writeTextFile('unexpected.txt', 'must not be written')).rejects.toThrow()
  })

  it('does not reuse an always-grant for different nested command inputs', async () => {
    const id = await session()
    await runtime.prompt(id, input)
    await until(() => promptCount === 1)
    const events: ChatEnvelope[] = []
    runtime.on('event', event => events.push(event))
    const options = [
      { id: 'once', name: 'Once', kind: 'allow_once' as const },
      { id: 'always', name: 'Session', kind: 'allow_always' as const },
      { id: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ]
    const first = host.requestPermission({ title: 'Execute', input: { command: { text: 'first' } }, options })
    await until(() => events.some(e => e.event.type === 'permission.requested'))
    const firstEvent = events.find(e => e.event.type === 'permission.requested')!.event
    if (firstEvent.type !== 'permission.requested') throw new Error('missing first permission')
    runtime.respondPermission(id, firstEvent.id, 'always')
    await first
    const second = host.requestPermission({ title: 'Execute', input: { command: { text: 'different' } }, options })
    await pause(20)
    const automatic = events.filter(e => e.event.type === 'permission.resolved' && e.event.by === 'session')
    const secondEvent = [...events].reverse().find(e => e.event.type === 'permission.requested')!.event
    if (secondEvent.type === 'permission.requested') {
      try { runtime.respondPermission(id, secondEvent.id, 'reject') } catch { /* buggy implementation may have answered automatically */ }
    }
    await second.catch(() => undefined)
    expect(automatic).toHaveLength(0)
  })
})


it('preserves failed Caller finish records across later turns, session deletion and restart', async () => {
  await runtime.stop()
  const instance = `finish-review:${randomUUID()}`
  let available = false
  let sequence = 0
  const completed: Array<{ id: string, status: string }> = []
  const caller: import('../server/chat/caller-turns').CallerTurns = {
    async start() { return String(++sequence).repeat(32) },
    async finish(id, status) {
      if (!available) throw new Error('fixture Caller temporarily unavailable')
      completed.push({ id, status })
      return { id, status }
    },
  }
  const makeRuntime = () => new Runtime({ instance, instanceLabel: 'test', adapters: { grok: fakeAdapter }, callerTurns: caller, catalog: async () => CATALOG, resolveCheckout: async () => checkout, idleTimeoutMinutes: () => 0 })
  runtime = makeRuntime()
  const id = await session()
  runtime.prompt(id, input)
  await until(() => promptCount === 1)
  currentFinish?.({ stopReason: 'end_turn' })
  await until(() => runtime.get(id)?.status === 'idle')
  runtime.prompt(id, { ...input, text: 'second turn' })
  await until(() => promptCount === 2)
  currentFinish?.({ stopReason: 'cancelled' })
  await until(() => runtime.get(id)?.status === 'idle')
  await runtime.delete(id)
  await runtime.stop()
  available = true
  runtime = makeRuntime()
  await runtime.recover()
  expect(completed).toEqual([
    { id: '1'.repeat(32), status: 'completed' },
    { id: '2'.repeat(32), status: 'cancelled' },
  ])
})


it('keeps the checkout locked while a Poise filesystem write outlives the service grace period', async () => {
  const files = await import('../server/chat/client-fs')
  const { CheckoutLease } = await import('../server/chat/checkout-lock')
  const id = await session()
  runtime.prompt(id, input)
  await until(() => promptCount === 1)
  let entered = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const write = vi.spyOn(files, 'writeCheckoutTextFile').mockImplementation(async () => {
    entered = true
    await held
  })
  let pending: Promise<void> | undefined
  try {
    pending = host.writeTextFile('held.txt', 'fixture')
    await until(() => entered)
    currentFinish?.({ stopReason: 'end_turn' })
    // The runtime's grace is 5 s. Killing the native agent cannot cancel a
    // filesystem operation already executing inside the Poise process.
    await pause(5_400)
    const observer = new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'observer', ownerLabel: 'test observer', instance: 'observer' })
    expect(observer.read()).not.toBeNull()
  } finally {
    release()
    await pending
    write.mockRestore()
  }
}, 15_000)


it('does not replace an already recorded terminal outcome with an interruption on recovery', async () => {
  const storage = await import('../server/chat/storage')
  const id = await session()
  const callId = 'f'.repeat(32)
  const completed = { callId, instance: runtime.instance, sessionId: id, status: 'completed' as const, error: null }
  storage.queueFinish(completed)
  storage.queueFinish({ ...completed, status: 'failed', error: 'Interrupted by Poise restart' })
  const pending = storage.listFinishOutbox(runtime.instance).find(row => row.callId === callId)
  expect(pending).toMatchObject({ status: 'completed', error: null })
  storage.finishDelivered(callId)
})


it('rolls back the whole terminal update if its Caller outbox write fails', async () => {
  const storage = await import('../server/chat/storage')
  const { db } = await import('../server/db')
  const id = await session()
  const turnId = randomUUID()
  const callId = 'e'.repeat(32)
  const terminal = { type: 'turn.finished' as const, turnId, stopReason: 'end_turn' as const }
  const ledger = { callId, instance: runtime.instance }
  storage.setOpenTurn(id, turnId, callId)
  db.exec(`CREATE TEMP TRIGGER fail_terminal_outbox BEFORE INSERT ON chat_finish_outbox
    WHEN NEW.call_id = '${callId}' BEGIN SELECT RAISE(ABORT, 'fixture outbox failure'); END`)
  try {
    expect(() => storage.finalizeTurn(id, terminal, ledger)).toThrow('fixture outbox failure')
    expect(storage.getOpenTurn(id)).toEqual({ turnId, callId })
    expect(storage.findEvent(id, event => event.type === 'turn.finished' && event.turnId === turnId)).toBeNull()
  } finally {
    db.exec('DROP TRIGGER fail_terminal_outbox')
  }
  const result = storage.finalizeTurn(id, terminal, ledger)
  expect(storage.getOpenTurn(id)).toBeNull()
  expect(storage.listFinishOutbox(runtime.instance).find(row => row.callId === callId)?.status).toBe('completed')
  const retried = storage.finalizeTurn(id, { ...terminal, stopReason: 'interrupted' }, ledger)
  expect(retried.seq).toBe(result.seq)
  expect(retried.event).toMatchObject({ stopReason: 'end_turn' })
  storage.finishDelivered(callId)
})


it('uses the actual recent turns for a handoff after a transcript exceeds one history page', async () => {
  const storage = await import('../server/chat/storage')
  const id = await session()
  storage.appendEvent(id, { type: 'turn.started', turnId: 'old', prompt: { text: 'old task outside retention', attachments: [], mentions: [] } })
  for (let index = 0; index < 1_050; index++) storage.appendEvent(id, { type: 'text.delta', turnId: 'old', messageId: 'old-message', delta: 'old output ' })
  for (let index = 0; index < 8; index++) {
    storage.appendEvent(id, { type: 'turn.started', turnId: `recent-${index}`, prompt: { text: `recent task ${index}`, attachments: [], mentions: [] } })
    storage.appendEvent(id, { type: 'text.delta', turnId: `recent-${index}`, messageId: `message-${index}`, delta: `recent outcome ${index}` })
  }
  const view = runtime as unknown as { handoffSummary(record: NonNullable<ReturnType<typeof runtime.get>>): string }
  const summary = view.handoffSummary(runtime.get(id)!)
  expect(summary).toContain('recent task 7')
  expect(summary).toContain('recent outcome 7')
  expect(summary).toContain('recent task 2')
  expect(summary).not.toContain('recent task 1')
  expect(summary).not.toContain('old task outside retention')
})

it('retrieves the full immutable diff by session and ID, independently of its bounded wire preview', async () => {
  const storage = await import('../server/chat/storage')
  const { clientEnvelope } = await import('../server/chat/event-preview')
  const id = await session()
  const original = { type: 'diff' as const, turnId: 'turn', toolId: 'tool', diffId: randomUUID(), path: 'large.txt', oldText: 'before\n'.repeat(20_000), newText: 'after\n'.repeat(20_000), oldExists: true, newExists: true }
  const envelope = storage.appendEvent(id, original)
  expect(clientEnvelope(envelope).event).toMatchObject({ previewOnly: true })
  expect(storage.getDiffEvent(id, original.diffId)).toEqual(original)
  expect(storage.getDiffEvent('another-session', original.diffId)).toBeNull()
  expect(storage.getDiffEvent(id, 'missing')).toBeNull()
})
