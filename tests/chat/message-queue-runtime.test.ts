import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentId, ChatEnvelope, PromptInput, StopReason } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions, TurnResult } from '../../server/chat/adapters/types'
import { CATALOG } from '../model-catalog-fixture'

let root: string
let Runtime: typeof import('../../server/chat/runtime').ChatRuntime
let storage: typeof import('../../server/chat/storage')
let queues: typeof import('../../server/chat/message-queue')
const runtimes: InstanceType<typeof Runtime>[] = []
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('Queue condition did not settle'); await pause() }
}
const input = (text: string): PromptInput => ({ text, attachments: [], mentions: [] })
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
interface Controls { auto: boolean, failAgent?: AgentId, calls: { agent: AgentId, input: PromptInput, turnId: string }[], adapters: Fake[], active: number, maximum: number }
class Fake implements Adapter {
  alive = false
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  options?: AdapterStartOptions
  finish?: (result: TurnResult) => void
  steered: string[] = []
  modelChanges: string[] = []
  constructor(readonly agent: AgentId, readonly host: AdapterHost, readonly c: Controls) { c.adapters.push(this) }
  async start(options: AdapterStartOptions) {
    if (this.c.failAgent === this.agent) throw new Error(`${this.agent} is unavailable`)
    this.options = options; this.nativeSessionId = options.resume || randomUUID(); this.alive = true
    return { ...options, nativeSessionId: this.nativeSessionId, capabilities: this.capabilities }
  }
  async prompt(turnId: string, prompt: PromptInput, signal: AbortSignal): Promise<TurnResult> {
    this.c.active++; this.c.maximum = Math.max(this.c.maximum, this.c.active)
    this.c.calls.push({ agent: this.agent, input: prompt, turnId })
    this.host.emit({ type: 'text.delta', turnId, messageId: turnId, delta: `Completed by ${this.agent}` })
    try {
      if (this.c.auto) return { stopReason: 'end_turn' }
      return await new Promise<TurnResult>(resolve => {
        this.finish = result => { this.finish = undefined; resolve(result) }
        signal.addEventListener('abort', () => this.finish?.({ stopReason: 'cancelled' }), { once: true })
      })
    } finally { this.c.active-- }
  }
  async steer(text: string) { this.steered.push(text) }
  async cancel() { this.finish?.({ stopReason: 'cancelled' }) }
  async close() { this.alive = false; this.finish?.({ stopReason: 'cancelled' }) }
  async setModel(modelId: string, effort: string) { this.modelChanges.push(modelId); return { modelId, effort } }
  async setMode() {}
  async fork() { return randomUUID() }
  onExit() {}
}
async function world(options: { auto?: boolean, deferStart?: boolean, autoMerge?: boolean } = {}) {
  const repo = join(root, randomUUID()); await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Queue test'); git(repo, 'config', 'user.email', 'queue@example.invalid')
  git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', '/dev/null')
  await writeFile(join(repo, 'README.md'), '# Queue fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  const instance = `queue-test:${randomUUID()}`
  const c: Controls = { auto: options.auto ?? true, calls: [], adapters: [], active: 0, maximum: 0 }
  function make() {
    const runtime = new Runtime({ instance, instanceLabel: 'queue-test', callerTurns: null, idleTimeoutMinutes: () => 0,
      catalog: async () => CATALOG, resolveCheckout: async () => repo, requireClaudeReady: async () => {},
      adapters: Object.fromEntries((['grok', 'claude', 'codex', 'muse'] as AgentId[]).map(agent => [agent, (host: AdapterHost) => new Fake(agent, host, c)])),
    })
    runtimes.push(runtime); return runtime
  }
  const runtime = make()
  const events: ChatEnvelope[] = []; runtime.on('event', event => events.push(event))
  const s = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: 'test/queue', branch: { new: randomUUID() }, deferStart: options.deferStart, autoMerge: options.autoMerge })
  await until(() => runtime.get(s.id)?.status === 'idle')
  const add = (text: string, model?: string) => runtime.enqueue(s.id, randomUUID(), input(text), model)
  const finish = (stopReason: StopReason = 'end_turn') => [...c.adapters].reverse().find(adapter => adapter.finish)?.finish?.({ stopReason })
  const turns = () => runtime.events(s.id, 0).events.filter(e => e.event.type === 'turn.finished')
  return { runtime, c, s, add, finish, make, turns, repo, events }
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-message-queue-'))
  vi.stubEnv('POISE_DB', join(root, 'db.sqlite3')); vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks')); vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  ;({ ChatRuntime: Runtime } = await import('../../server/chat/runtime'))
  storage = await import('../../server/chat/storage'); queues = await import('../../server/chat/message-queue')
})
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop() })
afterAll(async () => { (await import('../../server/db')).closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('deferred message execution', () => {
  it('stores five tasks without starting an agent, then runs the manual task followed by FIFO items exactly once', async () => {
    const w = await world({ deferStart: true })
    for (let i = 1; i <= 5; i++) await w.add(`Queue ${i}`)
    expect(w.c.adapters).toHaveLength(0); expect(w.c.calls).toHaveLength(0)
    expect(w.runtime.get(w.s.id)?.queue?.ready).toBe(false)
    expect(w.runtime.events(w.s.id, 0).events.some(e => e.event.type === 'turn.started')).toBe(false)
    w.runtime.prompt(w.s.id, input('Do this first'))
    await until(() => w.turns().length === 6 && w.runtime.get(w.s.id)?.status === 'idle')
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Do this first', 'Queue 1', 'Queue 2', 'Queue 3', 'Queue 4', 'Queue 5'])
    expect(w.c.maximum).toBe(1); expect(w.runtime.get(w.s.id)?.queue?.items).toEqual([])
    await w.add('A later idle task'); await pause(100)
    expect(w.c.calls).toHaveLength(6)
  }, 25_000)

  it('enqueues during an active turn without steering it and waits through real pending questions', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Current'))
    await until(() => w.c.calls.length === 1)
    const answer = w.c.adapters[0].host.askQuestion({ questions: [{ id: 'q', question: 'A needed fact?', options: [{ label: 'Answer' }], freeText: true, multiSelect: false }] })
    await w.add('Follow-up'); await pause(80)
    expect(w.c.calls).toHaveLength(1); expect(w.c.adapters[0].steered).toEqual([])
    expect(w.runtime.get(w.s.id)?.status).toBe('waiting')
    const question = w.runtime.events(w.s.id, 0).events.find(e => e.event.type === 'question.asked')!
    if (question.event.type !== 'question.asked') throw new Error('question missing')
    w.runtime.answerQuestion(w.s.id, question.event.id, { q: 'Answer' }); await answer
    w.c.auto = true; w.finish()
    await until(() => w.turns().length === 2)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Current', 'Follow-up'])
  })

  it('selects a real native agent for each item, preserves the conversation, and never changes the active agent early', async () => {
    const w = await world({ auto: false, autoMerge: true })
    w.runtime.prompt(w.s.id, input('First task')); await until(() => w.c.calls.length === 1)
    await w.add('Claude task', 'opus-5-max'); await w.add('Codex task', 'gpt-6-astra-max'); await w.add('Muse task', 'muse-spark-1.3-contributor-max')
    const last = (await w.add('Grok task')).items.at(-1)!
    await w.runtime.updateQueue(w.s.id, last.id, 'grok-4.6-xhigh')
    expect(w.runtime.get(w.s.id)?.agent).toBe('grok'); expect(w.c.adapters).toHaveLength(1)
    w.c.auto = true; w.finish()
    await until(() => w.turns().length === 5 && w.runtime.get(w.s.id)?.status === 'idle')
    expect(w.c.calls.map(call => call.agent)).toEqual(['grok', 'claude', 'codex', 'muse', 'grok'])
    expect(w.c.calls[1].input.text).toContain('[Handoff from a Grok Build session')
    expect(w.c.calls[1].input.text).toContain('First task')
    for (const call of w.c.calls) expect(call.input.text).toContain('Auto-merge')
    const starts = w.runtime.events(w.s.id, 0).events.map(e => e.event).filter(e => e.type === 'turn.started')
    expect(starts.slice(1).map(e => e.prompt.text)).toEqual(['Claude task', 'Codex task', 'Muse task', 'Grok task'])
    expect(starts.slice(1).map(e => e.agent)).toEqual(['claude', 'codex', 'muse', 'grok'])
    expect(w.runtime.get(w.s.id)?.effort).toBe('xhigh'); expect(w.c.maximum).toBe(1)
  }, 20_000)

  it('retains validated attachments until the item is dispatched, including a native handoff', async () => {
    const w = await world({ deferStart: true })
    const file = await w.runtime.saveAttachment(w.s.id, 'notes.txt', Buffer.from('Important attached text'))
    await w.runtime.enqueue(w.s.id, randomUUID(), { text: 'Use the attachment', attachments: [file], mentions: [{ path: 'README.md' }] }, 'opus-5-max')
    w.runtime.prompt(w.s.id, input('First'))
    await until(() => w.turns().length === 2)
    expect(w.c.calls[1].input.attachments[0].text).toBe('Important attached text')
    expect(w.c.calls[1].input.mentions).toEqual([{ path: 'README.md' }])
    await expect(w.runtime.enqueue(w.s.id, randomUUID(), { text: 'Forged', attachments: [{ ...file, size: 100 }], mentions: [] })).rejects.toMatchObject({ code: 'invalid' })
  })

  it.each(['cancelled', 'error'] as const)('does not drain after a %s turn; later successful work continues the untouched tail', async reason => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Current')); await until(() => w.c.calls.length === 1)
    await w.add('Later 1'); await w.add('Later 2')
    if (reason === 'cancelled') await w.runtime.cancel(w.s.id); else w.finish('error')
    await until(() => w.turns().length === 1); await pause(80)
    expect(w.c.calls).toHaveLength(1); expect(w.runtime.get(w.s.id)?.queue?.ready).toBe(false)
    w.c.auto = true; w.runtime.prompt(w.s.id, input('Next successful activity'))
    await until(() => w.turns().length === 4)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Current', 'Next successful activity', 'Later 1', 'Later 2'])
  })

  it('shows a failed queued provider instead of replaying or silently falling back', async () => {
    const w = await world()
    w.c.failAgent = 'claude'
    await w.add('Unavailable Claude task', 'opus-5-max'); await w.add('Tail')
    w.runtime.prompt(w.s.id, input('First'))
    await until(() => w.turns().length === 2)
    expect(w.c.calls).toHaveLength(1)
    expect(w.runtime.get(w.s.id)?.queue?.items.map(item => item.state)).toEqual(['failed', 'waiting'])
    expect(w.runtime.get(w.s.id)?.queue?.items[0].error).toContain('unavailable')
    w.c.failAgent = undefined
    w.runtime.prompt(w.s.id, input('Continue'))
    await until(() => w.turns().length === 4)
    expect(w.c.calls).toHaveLength(3)
    expect(w.c.calls[1].input.text).toContain('First') // handoff summary survived the failed startup
  })

  it('leaves a draining server idle and resumes the confirmed queue after drain is released', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Current')); await until(() => w.c.calls.length === 1)
    await w.add('After deployment')
    w.runtime.startDrain('candidate'); w.c.auto = true; w.finish()
    await until(() => w.runtime.busy() === 0)
    expect(w.c.calls).toHaveLength(1); expect(w.runtime.get(w.s.id)?.queue?.ready).toBe(true)
    w.runtime.endDrain(); await until(() => w.turns().length === 2)
    expect(w.c.calls).toHaveLength(2)
  })

  it('recovers an armed but unclaimed item without rerunning the preceding completed task', async () => {
    const w = await world({ deferStart: true }); await w.add('First queued'); await w.add('Second queued')
    const preceding = randomUUID(); storage.reserveQueueTurn(w.s.id, preceding)
    storage.finalizeTurn(w.s.id, { type: 'turn.finished', turnId: preceding, stopReason: 'end_turn' })
    const next = w.make(); await next.recover()
    await until(() => next.get(w.s.id)?.queue?.items.length === 0)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['First queued', 'Second queued'])
    await next.recover(); expect(w.c.calls).toHaveLength(2)
  })

  it('marks a claimed task interrupted after a crash and does not execute it again', async () => {
    const w = await world({ deferStart: true }); const queue = await w.add('Claimed'); await w.add('Still waiting')
    const preceding = randomUUID(); storage.reserveQueueTurn(w.s.id, preceding)
    storage.finalizeTurn(w.s.id, { type: 'turn.finished', turnId: preceding, stopReason: 'end_turn' })
    const turnId = randomUUID(); storage.reserveQueueTurn(w.s.id, turnId, queue.items[0].id)
    const next = w.make(); await next.recover(); await pause(80)
    expect(next.get(w.s.id)?.queue?.items.map(item => item.state)).toEqual(['failed', 'waiting'])
    expect(w.c.calls).toHaveLength(0)
    next.prompt(w.s.id, input('Recovery task'))
    await until(() => next.get(w.s.id)?.queue?.items.length === 1)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Recovery task', 'Still waiting'])
  })

  it('deduplicates item IDs across removal/completion and keeps forks and unrelated sessions independent', async () => {
    const w = await world(); const id = randomUUID()
    await w.runtime.enqueue(w.s.id, id, input('Only once'))
    await w.runtime.enqueue(w.s.id, id, input('Only once'))
    await expect(w.runtime.enqueue(w.s.id, id, input('Different'))).rejects.toMatchObject({ code: 'queue_conflict' })
    const fork = await w.runtime.fork(w.s.id)
    expect(w.runtime.get(fork.id)?.queue?.items || []).toEqual([])
    w.runtime.removeQueue(w.s.id, id)
    expect((await w.runtime.enqueue(w.s.id, id, input('Only once'))).items).toEqual([])
    const q = await w.add('Complete once'); w.runtime.prompt(w.s.id, input('First'))
    await until(() => w.turns().length === 2)
    expect((await w.runtime.enqueue(w.s.id, q.items[0].id, input('Complete once'))).items).toEqual([])
    expect(w.c.calls).toHaveLength(2)
  })

  it('removing the last waiting item clears its old completion signal', async () => {
    const w = await world({ deferStart: true }); const q = await w.add('Remove me')
    const turnId = randomUUID(); storage.reserveQueueTurn(w.s.id, turnId)
    storage.finalizeTurn(w.s.id, { type: 'turn.finished', turnId, stopReason: 'end_turn' })
    w.runtime.removeQueue(w.s.id, q.items[0].id)
    expect(queues.readQueue(w.s.id).ready).toBe(false)
    await w.add('Must wait for a new activity')
    const next = w.make(); await next.recover(); await pause(80)
    expect(w.c.calls).toHaveLength(0)
  })

  it('rolls back an enqueue whose durable transcript receipt could not be recorded', async () => {
    const w = await world({ deferStart: true }); const { db } = await import('../../server/db')
    db.exec("CREATE TRIGGER queue_receipt_failure BEFORE INSERT ON chat_events WHEN json_extract(NEW.event, '$.type') = 'queue.updated' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
    try {
      await expect(w.add('Must not be half-added')).rejects.toThrow('receipt failed')
      expect(queues.readQueue(w.s.id).items).toEqual([])
    } finally { db.exec('DROP TRIGGER queue_receipt_failure') }
    await w.add('Now recorded'); expect(queues.readQueue(w.s.id).items).toHaveLength(1)
  })

  it('Stop on an executing queue item pauses the remaining items without replaying the stopped task', async () => {
    const w = await world({ auto: false })
    await w.add('Queue one'); await w.add('Queue two')
    w.runtime.prompt(w.s.id, input('Manual task')); await until(() => w.c.calls.length === 1)
    w.finish(); await until(() => w.c.calls.length === 2)
    await w.runtime.cancel(w.s.id); await until(() => w.turns().length === 2)
    expect(w.runtime.get(w.s.id)?.queue?.items.map(item => item.state)).toEqual(['failed', 'waiting'])
    await pause(100); expect(w.c.calls).toHaveLength(2)
    w.c.auto = true; w.runtime.prompt(w.s.id, input('Continue later'))
    await until(() => w.turns().length === 4)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Manual task', 'Queue one', 'Continue later', 'Queue two'])
  })

})
