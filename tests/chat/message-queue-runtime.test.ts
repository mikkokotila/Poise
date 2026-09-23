import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
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
  compactions: Array<{ turnId: string, memories: string }> = []
  modelChanges: string[] = []
  modeChanges: string[] = []
  constructor(readonly agent: AgentId, readonly host: AdapterHost, readonly c: Controls) { this.capabilities.modes = agent === 'claude'; c.adapters.push(this) }
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
  async compact(turnId: string, memories: string): Promise<TurnResult> { this.compactions.push({ turnId, memories }); return { stopReason: 'end_turn', compaction: { changed: true } } }
  async steer(text: string) { this.steered.push(text) }
  async cancel() { this.finish?.({ stopReason: 'cancelled' }) }
  async close() { this.alive = false; this.finish?.({ stopReason: 'cancelled' }) }
  async setModel(modelId: string, effort: string) { this.modelChanges.push(modelId); return { modelId, effort } }
  async setMode(mode: string) { this.modeChanges.push(mode) }
  async fork() { return randomUUID() }
  onExit() {}
}
async function world(options: { auto?: boolean, deferStart?: boolean, autoMerge?: boolean, prepareCli?: import('../../server/chat/runtime').RuntimeOptions['prepareCli'] } = {}) {
  const repo = join(root, randomUUID()); await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Queue test'); git(repo, 'config', 'user.email', 'queue@example.invalid')
  git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', '/dev/null')
  await writeFile(join(repo, 'README.md'), '# Queue fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  const instance = `queue-test:${randomUUID()}`
  const c: Controls = { auto: options.auto ?? true, calls: [], adapters: [], active: 0, maximum: 0 }
  function make() {
    const runtime = new Runtime({ instance, instanceLabel: 'queue-test', prepareCli: options.prepareCli, callerTurns: null, idleTimeoutMinutes: () => 0,
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
    // Six real git/SQLite lifecycles are six readiness steps, not one
    // eight-second performance budget for the entire batch under suite load.
    for (let completed = 1; completed <= 6; completed++) await until(() => w.turns().length >= completed)
    await until(() => w.runtime.get(w.s.id)?.status === 'idle')
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
    // Each native handoff has its own bounded readiness step, as in the
    // five-item FIFO test above; the batch is not a single startup deadline.
    for (let completed = 1; completed <= 5; completed++) await until(() => w.turns().length >= completed)
    await until(() => w.runtime.get(w.s.id)?.status === 'idle')
    expect(w.turns()).toHaveLength(5)
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

it('uses the latest shared memories at dispatch for normal messages, queued tasks, steering and mode updates', async () => {
  const memories = await import('../../server/chat/memories')
  const save = (text: string) => memories.saveMemories({ text, revision: memories.readMemories().revision })
  const w = await world({ auto: false, deferStart: true, autoMerge: true })
  try {
    save('First memory')
    await w.add('Queued later')
    w.runtime.prompt(w.s.id, input('First task'))
    await until(() => w.c.calls.length === 1)
    expect(w.c.calls[0].input.memories).toBe('First memory')
    expect(w.c.calls[0].input.text).toContain('Auto-merge')
    save('Latest memory')
    await w.runtime.steer(w.s.id, 'Extra instruction')
    expect(w.c.adapters[0].steered.at(-1)).toMatch(/Latest memory$/)
    await w.runtime.setAutoMerge(w.s.id, false)
    expect(w.c.adapters[0].steered.at(-1)).toMatch(/Latest memory$/)
    w.c.auto = true; w.finish()
    await until(() => w.turns().length === 2 && w.runtime.get(w.s.id)?.status === 'idle')
    expect(w.c.calls[1].input.memories).toBe('Latest memory')
    expect(w.runtime.events(w.s.id, 0).events.filter(e => e.event.type === 'turn.started').map(e => e.event.type === 'turn.started' && e.event.prompt.text)).toEqual(['First task', 'Queued later'])
    save('')
    w.runtime.prompt(w.s.id, input('Without memories'))
    await until(() => w.turns().length === 3)
    expect(w.c.calls[2].input.memories).toBe('')
  } finally { save('') }
}, 15_000)


it('QC: Stop cancels a first turn waiting for another checkout owner without later launching its agent', async () => {
  const w = await world({ auto: false })
  w.runtime.prompt(w.s.id, input('Keep working'))
  await until(() => w.c.calls.length === 1)
  const second = await w.runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: 'test/queue', branch: { new: randomUUID() }, deferStart: true })
  w.runtime.prompt(second.id, input('Do not start this after Stop'))
  await until(() => w.runtime.get(second.id)?.status === 'queued')
  const result = await w.runtime.cancel(second.id)
  expect(result.settled).toBe(true)
  expect(storage.getOpenTurn(second.id)).toBeNull()
  expect(w.c.adapters).toHaveLength(1)
  w.c.auto = true; w.finish(); await pause(120)
  expect(w.c.calls).toHaveLength(1)
}, 15_000)

it('QC: native effort limits from one model do not reject another model family', async () => {
  const w = await world()
  const s = await w.runtime.create({ agent: 'claude', model: 'opus-5-max', repo: 'test/queue', branch: { existing: w.s.branch.name } })
  await until(() => w.runtime.get(s.id)?.status === 'idle')
  // Previous model advertised a narrower effort list. New family must ask its own adapter.
  const live = (w.runtime as any).live.get(s.id)
  live.record.efforts = ['high']
  const updated = await w.runtime.setModel(s.id, 'fable-5.1-max')
  expect(updated).toMatchObject({ model: 'fable-5.1-max', effort: 'max' })
})


it('does not dispatch an armed queue when startup reconciliation fails', async () => {
  const w = await world({ deferStart: true }); await w.add('Only after successful recovery')
  const turnId = randomUUID(); storage.reserveQueueTurn(w.s.id, turnId)
  storage.finalizeTurn(w.s.id, { type: 'turn.finished', turnId, stopReason: 'end_turn' })
  const recovering = w.make()
  const probe = vi.spyOn(storage, 'listWorkers').mockImplementationOnce(() => { throw new Error('fixture recovery failure') })
  await expect(recovering.recover()).rejects.toThrow('fixture recovery failure')
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(w.c.calls).toHaveLength(0)
  expect(recovering.get(w.s.id)?.queue?.ready).toBe(true)
  probe.mockRestore()
  await recovering.recover()
  await until(() => recovering.get(w.s.id)?.queue?.items.length === 0)
  expect(w.c.calls).toHaveLength(1)
})

describe('Chained models and reply review', () => {
  it.each(['grok-4.6-high', 'opus-5-max', 'gpt-6-astra-max', 'muse-spark-1.3-contributor-max'])(
    'reviews the latest reply using the actual %s adapter', async model => {
      const w = await world({ autoMerge: true })
      w.runtime.prompt(w.s.id, input('Propose an implementation'))
      await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
      const command = `/model ${model} /review challenge the assumptions`
      w.runtime.prompt(w.s.id, input(command))
      await until(() => w.turns().length === 2 && w.runtime.get(w.s.id)?.status === 'idle')
      const call = w.c.calls[1]
      expect(call.agent).toBe(CATALOG.models.find(row => row.identity === model)!.provider)
      expect(call.input.text).toContain('adversarial critical review of the latest assistant reply')
      expect(call.input.text).toContain('Completed by grok')
      expect(call.input.text).toContain('Propose an implementation')
      expect(call.input.text).toContain('challenge the assumptions')
      expect(call.input.text).toContain('not limited to a Git diff')
      expect(call.input.text).toContain('Auto-merge ON')
      const starts = w.events.map(row => row.event).filter(event => event.type === 'turn.started')
      expect(starts[1].prompt.text).toBe(command)
      expect(starts[1]).toMatchObject({ model, agent: call.agent })
      expect(w.c.maximum).toBe(1); expect(git(w.repo, 'status', '--porcelain')).toBe('')
    }, 20_000)
  it('leaves a fresh conversation untouched when there is no reply to review', async () => {
    const w = await world({ deferStart: true })
    expect(() => w.runtime.prompt(w.s.id, input('/model opus-5-max /review'))).toThrow(/no assistant reply/)
    expect(w.c.calls).toEqual([]); expect(w.c.adapters).toEqual([])
    expect(w.runtime.get(w.s.id)?.agent).toBe('grok'); expect(w.turns()).toHaveLength(0)
  })

  it('queues a review before the initial task and uses the final reply and edited queue model', async () => {
    const w = await world({ auto: false, deferStart: true })
    const queue = await w.add('/model opus-5-max /review assess the result')
    expect(queue.items[0]).toMatchObject({ agent: 'claude', prompt: { text: '/review assess the result' } })
    await w.runtime.updateQueue(w.s.id, queue.items[0].id, 'muse-spark-1.3-contributor-max')
    expect(w.c.adapters).toEqual([])
    w.runtime.prompt(w.s.id, input('First propose the result'))
    await until(() => w.c.calls.length === 1)
    const first = w.c.calls[0]
    w.c.adapters[0].host.emit({ type: 'text.delta', turnId: first.turnId, messageId: 'final-answer', delta: 'The final proposed result.' })
    w.c.auto = true; w.finish()
    await until(() => w.turns().length === 2)
    expect(w.c.calls[1].agent).toBe('muse')
    expect(w.c.calls[1].input.text).toContain('The final proposed result.')
    expect(w.c.calls[1].input.text).toContain('assess the result')
    expect(w.c.adapters[0].steered).toEqual([])
  }, 20_000)
  it('makes the complete long reply and all earlier history pages available privately', async () => {
    const w = await world()
    w.runtime.prompt(w.s.id, input('Original request with essential context'))
    await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
    const host = w.c.adapters[0].host, turnId = w.c.calls[0].turnId
    for (let i = 0; i < 5100; i++) host.emit({ type: 'thought.delta', turnId, messageId: 'background', delta: `evidence ${i}\n` })
    const complete = `Latest reply\n${'x'.repeat(70_000)}\nImportant final qualification`
    host.emit({ type: 'text.delta', turnId, messageId: 'long-final', delta: complete })
    const through = w.runtime.get(w.s.id)!.lastSeq
    w.runtime.prompt(w.s.id, input('/review'))
    await until(() => w.events.filter(row => row.event.type === 'turn.finished').length === 2)
    const text = w.c.calls[1].input.text
    expect(text).toContain('Reply excerpt only')
    const path = /Full preceding history index: (\S+\.json)/.exec(text)![1]
    const index = JSON.parse(await readFile(join(w.repo, path), 'utf8')) as { throughSeq: number, target: { reply: string }, parts: Array<{ path: string }> }
    expect(index.throughSeq).toBe(through)
    expect(await readFile(join(w.repo, index.target.reply), 'utf8')).toBe(complete)
    const events = (await Promise.all(index.parts.map(part => readFile(join(w.repo, part.path), 'utf8')))).join('').trim().split('\n').map(line => JSON.parse(line) as ChatEnvelope)
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: through }, (_, i) => i + 1))
    expect(new Set(events.map(event => event.sessionId))).toEqual(new Set([w.s.id]))
    expect(git(w.repo, 'status', '--porcelain')).toBe('')
  }, 25_000)
  it('applies a model before passing the following native command without rewriting it', async () => {
    const w = await world()
    w.runtime.prompt(w.s.id, input('/model gpt-6-astra-max /context inspect architecture'))
    await until(() => w.turns().length === 1)
    expect(w.c.calls).toHaveLength(1); expect(w.c.calls[0].agent).toBe('codex')
    expect(w.c.calls[0].input.text).toContain('/context inspect architecture')
    expect(w.c.calls[0].input.text).not.toContain('/model gpt-6-astra-max')
  })

  it('does not fall back to the earlier agent or replay the proposal when a selected reviewer fails', async () => {
    const w = await world()
    w.runtime.prompt(w.s.id, input('Propose a plan'))
    await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
    w.c.failAgent = 'claude'
    w.runtime.prompt(w.s.id, input('/model opus-5-max /review'))
    await until(() => w.turns().length === 2)
    expect(w.c.calls).toHaveLength(1)
    expect(w.turns()[1].event).toMatchObject({ stopReason: 'error', error: expect.stringContaining('unavailable') })
  })
})

it('keeps a provider-resolved model alias when applying a catalogue effort', async () => {
  const w = await world()
  w.c.adapters[0].setModel = async (_modelId, effort) => ({ modelId: 'grok-4.6-resolved-revision', effort })
  await w.runtime.setModel(w.s.id, 'grok-4.6-xhigh')
  expect(w.runtime.get(w.s.id)).toMatchObject({ model: 'grok-4.6-xhigh', modelId: 'grok-4.6-resolved-revision', effort: 'xhigh' })
  expect(w.c.calls).toEqual([])
})

it('QC2: can select a work mode immediately after changing to an agent that supports it', async () => {
  const w = await world({ deferStart: true })
  await w.runtime.setModel(w.s.id, 'opus-5-max')
  expect(w.c.calls).toHaveLength(0)
  await expect(w.runtime.setMode(w.s.id, 'plan')).resolves.toBeUndefined()
  expect(w.runtime.get(w.s.id)?.mode).toBe('plan')
  expect(w.c.adapters.at(-1)?.modeChanges).toEqual(['plan'])
  expect(w.c.calls).toHaveLength(0)
  await w.runtime.stop()
  const revived = w.make(); await revived.recover()
  await revived.resume(w.s.id)
  expect(w.c.adapters.at(-1)?.options).toMatchObject({ mode: 'plan' })
  expect(revived.get(w.s.id)?.mode).toBe('plan')
  expect(w.c.calls).toHaveLength(0)
})

for (const model of ['grok-4.6-high', 'opus-5-max', 'gpt-6-astra-max', 'muse-spark-1.3-contributor-max']) {
  it(`context: reset starts ${model} with no native resume or previous transcript`, async () => {
    const w = await world({ autoMerge: true })
    await w.runtime.setModel(w.s.id, model)
    w.runtime.prompt(w.s.id, input('An old conversation secret'))
    await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
    const original = w.runtime.get(w.s.id)!
    const native = original.nativeSessionId
    const oldHost = w.c.adapters.at(-1)!.host
    const title = original.title
    await writeFile(join(w.repo, 'keep.txt'), 'User work remains')
    const reset = await w.runtime.reset(w.s.id)
    expect(reset).toMatchObject({ id: w.s.id, title, model, autoMerge: true, status: 'idle' })
    expect(reset.nativeSessionId).toBeUndefined(); expect(reset.context).toBeUndefined()
    oldHost.emit({ type: 'text.delta', turnId: 'old-turn', messageId: 'late', delta: 'A stale reply' })
    await expect(oldHost.readTextFile('README.md')).rejects.toThrow(/conversation was reset/)
    await expect(oldHost.requestPermission({ title: 'Old permission', options: [] })).rejects.toThrow(/conversation was reset/)
    expect(w.runtime.events(w.s.id, 0).events.some(e => e.event.type === 'text.delta')).toBe(false)
    expect(w.runtime.events(w.s.id, 0).events[0].event.type).toBe('session.reset')
    expect(reset.contextResetSeq).toBeGreaterThan(1)
    expect(await readFile(join(w.repo, 'keep.txt'), 'utf8')).toBe('User work remains')
    expect(() => w.runtime.prompt(w.s.id, input('/review'))).toThrow(/no assistant reply/i)
    w.runtime.prompt(w.s.id, input('Fresh task'))
    await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
    expect(w.c.adapters.at(-1)?.options?.resume).toBeUndefined()
    expect(w.runtime.get(w.s.id)?.nativeSessionId).not.toBe(native)
    expect(w.c.calls.at(-1)?.input.text).not.toContain('An old conversation secret')
    expect(w.c.calls.at(-1)?.input.text).not.toContain('[Handoff')
    expect(w.runtime.get(w.s.id)?.title).toBe(title)
  })
}

it('context: compaction completes before a chained task and keeps the transcript', async () => {
  const w = await world()
  w.runtime.prompt(w.s.id, input('Original proposal'))
  await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
  const adapter = w.c.adapters[0]
  let finish!: (value: TurnResult) => void
  adapter.compact = async () => new Promise<TurnResult>(resolve => { finish = resolve })
  w.runtime.prompt(w.s.id, input('/compact Continue with the same task'))
  await until(() => !!finish)
  await w.add('After compaction')
  expect(w.c.calls).toHaveLength(1)
  expect(w.runtime.get(w.s.id)?.contextCompacting).toBe(true)
  await expect(w.runtime.steer(w.s.id, 'Do not inject into compaction')).rejects.toThrow(/maintenance/i)
  finish({ stopReason: 'end_turn', compaction: { changed: true } })
  await until(() => w.turns().length === 3 && w.runtime.get(w.s.id)?.status === 'idle')
  expect(w.c.calls.map(call => call.input.text)).toEqual(['Original proposal', 'Continue with the same task', 'After compaction'])
  expect(w.runtime.events(w.s.id, 0).events.some(e => e.event.type === 'context.compacted')).toBe(true)
  expect(w.runtime.get(w.s.id)?.contextCompacting).toBe(false)
})

it('context: a fresh reset or compact never launches a provider', async () => {
  const w = await world({ deferStart: true })
  await w.runtime.reset(w.s.id)
  w.runtime.prompt(w.s.id, input('/compact'))
  await until(() => w.turns().length === 1)
  expect(w.c.adapters).toEqual([]); expect(w.c.calls).toEqual([])
})

it('context: reset stops a running task and pauses future queued tasks without deleting them', async () => {
  const w = await world({ auto: false })
  w.runtime.prompt(w.s.id, input('Still working'))
  await until(() => w.c.calls.length === 1)
  await w.add('Explicit future task')
  await w.runtime.reset(w.s.id)
  expect(w.runtime.get(w.s.id)?.status).toBe('idle')
  expect(w.runtime.get(w.s.id)?.queue).toMatchObject({ ready: false, items: [{ prompt: { text: 'Explicit future task' }, state: 'waiting' }] })
  await pause(50); expect(w.c.calls).toHaveLength(1)
  w.c.auto = true
  w.runtime.prompt(w.s.id, input('New initial task'))
  await until(() => w.turns().length === 2)
  expect(w.c.calls.at(-1)?.input.text).toBe('Explicit future task')
})

it('context: a queued reset clears its prefix history and the remaining queue starts fresh', async () => {
  const w = await world({ deferStart: true })
  await w.add('/reset'); await w.add('Next context')
  w.runtime.prompt(w.s.id, input('Before reset'))
  await until(() => w.c.calls.length === 2 && w.runtime.get(w.s.id)?.status === 'idle')
  expect(w.c.adapters).toHaveLength(2)
  expect(w.c.adapters[1].options?.resume).toBeUndefined()
  expect(w.c.calls.map(call => call.input.text)).toEqual(['Before reset', 'Next context'])
  expect(w.runtime.events(w.s.id, 0).events[0].event.type).toBe('session.reset')
  expect(w.runtime.events(w.s.id, 0).events.filter(e => e.event.type === 'turn.started').map(e => e.event)).not.toContainEqual(expect.objectContaining({ prompt: expect.objectContaining({ text: 'Before reset' }) }))
  expect(w.runtime.get(w.s.id)?.queue?.items).toEqual([])
})

it('context: reset transaction failure preserves history and a successful reset survives restart', async () => {
  const w = await world()
  w.runtime.prompt(w.s.id, input('Preserve this until reset commits'))
  await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
  const { db } = await import('../../server/db')
  db.exec("CREATE TRIGGER reset_receipt_failure BEFORE INSERT ON chat_events WHEN json_extract(NEW.event, '$.type') = 'session.reset' BEGIN SELECT RAISE(ABORT, 'reset receipt unavailable'); END")
  try { await expect(w.runtime.reset(w.s.id)).rejects.toThrow('reset receipt unavailable') }
  finally { db.exec('DROP TRIGGER reset_receipt_failure') }
  expect(JSON.stringify(w.runtime.events(w.s.id, 0))).toContain('Preserve this until reset commits')
  expect(w.runtime.get(w.s.id)?.contextResetting).toBe(false)
  await w.runtime.reset(w.s.id)
  await w.runtime.stop()
  const next = w.make(); await next.recover()
  expect(next.get(w.s.id)?.nativeSessionId).toBeUndefined()
  expect(next.events(w.s.id, 0).events.some(e => e.event.type === 'text.delta')).toBe(false)
  expect(() => next.prompt(w.s.id, input('/review'))).toThrow(/no assistant reply/i)
  next.prompt(w.s.id, input('After restart'))
  await until(() => w.c.calls.length === 2)
  expect(w.c.adapters.at(-1)?.options?.resume).toBeUndefined()
})

it('context: reset cannot be combined with a review of the erased reply', async () => {
  const w = await world({ deferStart: true })
  expect(() => w.runtime.prompt(w.s.id, input('/reset /review'))).toThrow(/reset removes the reply/i)
  await expect(w.add('/reset /review')).rejects.toThrow(/reset removes the reply/i)
  expect(w.c.calls).toEqual([])
})

it('context: reconnect replay cannot reset newly added conversation a second time', async () => {
  const w = await world({ deferStart: true })
  const { executeCommandOnce } = await import('../../server/chat/command-receipts')
  const requestId = randomUUID()
  let executions = 0
  const reset = () => executeCommandOnce(w.runtime.instance, requestId, { type: 'context.reset', sessionId: w.s.id }, async () => {
    executions++
    return { kind: 'ack' as const, id: requestId, ok: true as const, result: { session: await w.runtime.reset(w.s.id) } }
  })
  await reset()
  const barrier = w.runtime.get(w.s.id)?.contextResetSeq
  w.runtime.prompt(w.s.id, input('Keep this new conversation'))
  await until(() => w.turns().length === 1 && w.runtime.get(w.s.id)?.status === 'idle')
  await reset()
  expect(executions).toBe(1)
  expect(w.runtime.get(w.s.id)?.contextResetSeq).toBe(barrier)
  expect(w.turns()).toHaveLength(1)
  expect(w.c.calls.at(-1)?.input.text).toBe('Keep this new conversation')
})

for (const model of ['grok-4.6-high', 'opus-5-max', 'gpt-6-astra-max', 'muse-spark-1.3-contributor-max']) {
  it(`saved switches: ${model} receives the selected definition without executing its slash text`, async () => {
    const w = await world({ deferStart: true })
    const name = `voice-${randomUUID()}`
    await w.runtime.createSwitch({ name, content: '/reset\nUse a warm precise voice.\n/model not-a-real-model', revision: 0 })
    expect(w.c.adapters).toHaveLength(0)
    expect(w.turns()).toHaveLength(0)
    w.runtime.prompt(w.s.id, input(`/model ${model} /${name} Write an introduction`))
    await until(() => w.turns().length === 1)
    expect(w.c.calls).toHaveLength(1)
    expect(w.c.calls[0].input.text).toContain(`[Saved switch: /${name}]\n/reset\nUse a warm precise voice.\n/model not-a-real-model`)
    expect(w.c.calls[0].input.text).toContain('Write an introduction')
    expect(w.runtime.events(w.s.id, 0).events.some(row => row.event.type === 'session.reset')).toBe(false)
    const shown = w.runtime.events(w.s.id, 0).events.find(row => row.event.type === 'turn.started')!.event
    expect(shown).toMatchObject({ prompt: { text: `/model ${model} /${name} Write an introduction` } })
    expect(JSON.stringify(shown)).not.toContain('warm precise voice')
  })
}

it('saved switches: creation during work leaves the running agent alone; queued tasks use the latest save', async () => {
  const w = await world({ auto: false })
  const name = `voice-${randomUUID()}`
  w.runtime.prompt(w.s.id, input('First task')); await until(() => w.c.calls.length === 1)
  await w.runtime.createSwitch({ name, content: 'Original voice', revision: 0 })
  await w.add(`/${name} Follow-up`)
  await w.runtime.createSwitch({ name, content: 'Revised voice', revision: 1 })
  expect(w.c.calls).toHaveLength(1); expect(w.c.adapters[0].steered).toEqual([])
  w.finish(); await until(() => w.c.calls.length === 2)
  expect(w.c.calls[1].input.text).toContain('Revised voice')
  expect(w.c.calls[1].input.text).not.toContain('Original voice')
  w.finish(); await until(() => w.turns().length === 2)
})

it('saved switches: multiple definitions reach review and attachment-bearing steering before Memories', async () => {
  const w = await world()
  const name = `voice-${randomUUID()}`, other = `detail-${randomUUID()}`
  await w.runtime.createSwitch({ name, content: 'Be particularly skeptical.', revision: 0 })
  await w.runtime.createSwitch({ name: other, content: 'Report concrete evidence.', revision: 0 })
  w.runtime.prompt(w.s.id, input('Proposal')); await until(() => w.turns().length === 1)
  w.runtime.prompt(w.s.id, input(`/${name} /review /${other}`)); await until(() => w.turns().length === 2)
  expect(w.c.calls[1].input.text).toContain('adversarial critical review')
  expect(w.c.calls[1].input.text).toContain('Be particularly skeptical.')
  expect(w.c.calls[1].input.text).toContain('Report concrete evidence.')
  const memories = await import('../../server/chat/memories'), before = memories.readMemories()
  memories.saveMemories({ text: 'Always last.', revision: before.revision })
  try {
    w.c.auto = false
    w.runtime.prompt(w.s.id, input('Current task')); await until(() => w.c.calls.length === 3)
    const file = await w.runtime.saveAttachment(w.s.id, 'notes.txt', Buffer.from('Extra context'))
    await w.runtime.steer(w.s.id, `/${name} Check this`, { attachments: [file], mentions: [{ path: 'README.md' }] })
    const sent = w.c.adapters.at(-1)!.steered.at(-1)!
    expect(sent).toContain('Extra context'); expect(sent).toContain('README.md')
    expect(sent).toContain('Be particularly skeptical.')
    expect(sent.endsWith('[Memories]\nAlways last.')).toBe(true)
  } finally { memories.saveMemories({ text: before.text, revision: memories.readMemories().revision }); w.finish() }
})

it('saved switches: definitions survive reset and are usable in another conversation after restart', async () => {
  const w = await world({ deferStart: true }), name = `voice-${randomUUID()}`
  await w.runtime.createSwitch({ name, content: 'Stable shared instructions.', revision: 0 })
  w.runtime.prompt(w.s.id, input(`/${name}`)); await until(() => w.turns().length === 1)
  await w.runtime.reset(w.s.id)
  await w.runtime.stop()
  const restarted = w.make(); await restarted.recover()
  const next = await restarted.create({ agent: 'grok', model: 'grok-4.6-high', repo: 'test/queue', branch: { existing: w.s.branch.name }, deferStart: true })
  restarted.prompt(next.id, input(`/${name} Another chat`))
  await until(() => w.c.calls.length === 2)
  expect(w.c.calls[1].input.text).toContain('Stable shared instructions.')
  expect(w.c.calls[1].input.text).not.toContain('[Handoff')
  expect(w.c.adapters.at(-1)!.options?.resume).toBeUndefined()
})

it('saved switches: malformed creation and queued definitions never create native turns', async () => {
  const w = await world({ deferStart: true })
  expect(() => w.runtime.prompt(w.s.id, input('/create /voice Instructions'))).toThrow(/create command/)
  await expect(w.add('/create /voice Instructions')).rejects.toThrow(/directly/)
  expect(w.c.adapters).toEqual([]); expect(w.c.calls).toEqual([])
})

it('shared library: removing a queued skill in Snippets preserves the queue and sends no incomplete task', async () => {
  const w = await world({ auto: false })
  const name = `queued-skill-${randomUUID()}`
  await w.runtime.createSwitch({ name, content: 'Required instructions', revision: 0 })
  w.runtime.prompt(w.s.id, input('First task')); await until(() => w.c.calls.length === 1)
  await w.add(`/${name} Later task`); await w.add('Independent tail')
  const library = await import('../../server/snippet-library')
  const state = await library.readSkillSnippets()
  await library.saveSkillSnippets(state.snippets.filter(snippet => snippet.trigger !== `;${name}`), state.version)
  w.finish(); await until(() => w.turns().length === 2)
  expect(w.c.calls).toHaveLength(1)
  expect(w.runtime.get(w.s.id)?.queue?.items.map(item => item.state)).toEqual(['failed', 'waiting'])
  expect(w.runtime.get(w.s.id)?.queue?.items[0].error).toContain('unavailable')
  expect(w.runtime.get(w.s.id)?.queue?.ready).toBe(false)
})

it('CLI updates: waits before native startup, leaves active work alone, and resumes on a newer CLI between turns', async () => {
  let release!: () => void, version = '1.0.0'
  const gate = new Promise<void>(resolve => { release = resolve })
  const prepareCli = vi.fn(async (provider: import('../../scripts/provider-cli-updates.mjs').Provider) => {
    await gate
    return { provider, status: 'current' as const, after: version, checkedAt: new Date().toISOString() }
  })
  const w = await world({ deferStart: true, auto: false, prepareCli })
  w.runtime.prompt(w.s.id, input('First task'))
  await until(() => prepareCli.mock.calls.length === 1)
  expect(w.c.adapters).toHaveLength(0); expect(w.c.calls).toHaveLength(0)
  release(); await until(() => w.c.calls.length === 1)
  const native = w.c.adapters[0].nativeSessionId
  version = '1.1.0'
  await w.add('Second task'); await w.runtime.steer(w.s.id, 'Finish the current task')
  expect(prepareCli).toHaveBeenCalledTimes(1); expect(w.c.adapters[0].alive).toBe(true)
  w.finish(); await until(() => w.c.calls.length === 2)
  expect(prepareCli).toHaveBeenCalledTimes(2); expect(w.c.adapters).toHaveLength(2)
  expect(w.c.adapters[0].alive).toBe(false)
  expect(w.c.adapters[1].options?.resume).toBe(native)
  expect(w.c.maximum).toBe(1)
  w.finish(); await until(() => w.turns().length === 2)
  w.runtime.prompt(w.s.id, input('Third task on the same CLI'))
  await until(() => w.c.calls.length === 3)
  expect(prepareCli).toHaveBeenCalledTimes(3); expect(w.c.adapters).toHaveLength(2)
  w.finish(); await until(() => w.turns().length === 3)
}, 20_000)

it('CLI updates: Stop cancels a waiting startup without launching the agent later', async () => {
  let release!: () => void
  const prepareCli = vi.fn((provider: import('../../scripts/provider-cli-updates.mjs').Provider, signal?: AbortSignal) => new Promise<import('../../scripts/provider-cli-updates.mjs').CliUpdate>((resolve, reject) => {
    release = () => resolve({ provider, status: 'current', after: '1.0.0', checkedAt: new Date().toISOString() })
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const w = await world({ deferStart: true, prepareCli })
  w.runtime.prompt(w.s.id, input('Do not start after Stop'))
  await until(() => prepareCli.mock.calls.length === 1)
  await w.runtime.cancel(w.s.id)
  await until(() => w.runtime.busy() === 0)
  release(); await pause(50)
  expect(w.c.adapters).toHaveLength(0); expect(w.c.calls).toHaveLength(0)
  expect(w.turns()).toHaveLength(1)
})

it('CLI updates: a failed latest check is visible and does not discard the task', async () => {
  const prepareCli = vi.fn(async (provider: import('../../scripts/provider-cli-updates.mjs').Provider) => ({ provider, status: 'unavailable' as const, before: '1.0.0', checkedAt: new Date().toISOString(), error: 'download unavailable' }))
  const w = await world({ deferStart: true, prepareCli })
  w.runtime.prompt(w.s.id, input('Keep my task'))
  await until(() => w.turns().length === 1)
  expect(w.c.calls[0].input.text).toBe('Keep my task')
  expect(w.events.some(row => row.event.type === 'status.changed' && row.event.detail?.includes('download unavailable'))).toBe(true)
})
