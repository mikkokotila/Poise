import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatEnvelope, ChatEvent, PromptInput, SessionRecord } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let storage: typeof import('../../server/chat/storage')
let worker: typeof import('../../server/chat/worker')

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

// A scripted agent: turns run until `finish()` is called (or at once when
// `auto` is set), and it can ask for permissions/questions on demand.
interface FakeControls {
  hosts: AdapterHost[]
  adapters: FakeAdapter[]
  startCount: number
  failStart?: string
}
class FakeAdapter implements Adapter {
  agent = 'grok' as const
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: true, commands: true, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  steered: string[] = []
  inputs: PromptInput[] = []
  cancelled = 0
  closed = 0
  auto = true
  private finishTurn: ((stop?: 'end_turn' | 'cancelled') => void) | null = null
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) {}
  async start(options: AdapterStartOptions) {
    this.controls.startCount += 1
    if (this.controls.failStart) throw new Error(this.controls.failStart)
    this.alive = true
    this.nativeSessionId = options.resume || options.forkFrom || `native-${this.controls.startCount}`
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort, efforts: ['high', 'xhigh'], commands: [{ name: 'compact' }] }
  }
  async prompt(turnId: string, input: PromptInput, signal: AbortSignal) {
    this.inputs.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text}` })
    if (this.auto) return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
    return new Promise<{ stopReason: 'end_turn' | 'cancelled' }>((resolve) => {
      this.finishTurn = (stop = 'end_turn') => { this.finishTurn = null; resolve({ stopReason: stop }) }
      signal.addEventListener('abort', () => this.finishTurn?.('cancelled'), { once: true })
    })
  }
  finish() { this.finishTurn?.('end_turn') }
  async steer(text: string) { this.steered.push(text) }
  async cancel() { this.cancelled += 1; this.finishTurn?.('cancelled') }
  async setModel(modelId: string, effort: string) { return { modelId, effort, efforts: ['high', 'xhigh'] } }
  async setMode() { throw new Error('unsupported') }
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.closed += 1; this.alive = false; for (const l of this.exitListeners) l(0, null) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
}

function fakeCaller(): CallerTurns & { starts: any[], finishes: any[] } {
  const starts: any[] = []
  const finishes: any[] = []
  return {
    starts,
    finishes,
    async start(input) { starts.push(input); return 'a'.repeat(32) },
    async finish(callId, status, error) { finishes.push({ callId, status, error }); return { id: callId, status } },
  }
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []

function makeRuntime(options: { instance?: string, controls?: FakeControls, caller?: CallerTurns | null, leaseProbes?: import('../../server/chat/checkout-lock').CheckoutLeaseOptions } = {}) {
  const controls: FakeControls = options.controls ?? { hosts: [], adapters: [], startCount: 0 }
  const runtime = new runtimeModule.ChatRuntime({
    instance: options.instance ?? 'poise-test:db',
    instanceLabel: 'test',
    adapters: { grok: (host) => { const a = new FakeAdapter(host, controls); controls.hosts.push(host); controls.adapters.push(a); return a } },
    callerTurns: options.caller === undefined ? fakeCaller() : options.caller,
    catalog: async () => CATALOG as any,
    resolveCheckout: async () => repo,
    idleTimeoutMinutes: () => 0,
    requireClaudeReady: async () => {},
    leaseProbes: options.leaseProbes,
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, controls, events }
}

afterEach(async () => {
  // A failed assertion must not leave a held lease or a dirty tree for the next test.
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined)
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo })
  spawnSync('git', ['clean', '-fdq'], { cwd: repo })
  spawnSync('git', ['switch', '-q', 'main'], { cwd: repo })
})

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const ofType = (events: ChatEnvelope[], id: string, type: ChatEvent['type']) => events.filter((e) => e.sessionId === id && e.event.type === type).map((e) => e.event as any)
const lastStatus = (events: ChatEnvelope[], id: string) => ofType(events, id, 'status.changed').at(-1)?.status

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-runtime-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  repo = join(root, 'repo')
  await mkdir(repo)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  vi.resetModules()
  runtimeModule = await import('../../server/chat/runtime')
  storage = await import('../../server/chat/storage')
  worker = await import('../../server/chat/worker')
})

afterAll(async () => {
  const { closeDatabase } = await import('../../server/db')
  closeDatabase()
  delete process.env.POISE_DB
  delete process.env.POISE_LOCK_DIR
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function ensureBranch(name: string) {
  if (spawnSync('git', ['rev-parse', '--verify', `refs/heads/${name}`], { cwd: repo }).status !== 0) git(['branch', name, 'main'])
}

describe('chat runtime', () => {
  it('creates a session on a new branch, runs a turn, records it with Caller, and never wakes the agent for history', async () => {
    const caller = fakeCaller()
    const { runtime, controls, events } = makeRuntime({ caller })
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'alpha' } })
    expect(session.branch).toMatchObject({ name: 'chat/alpha', origin: 'new', provisional: true })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(git(['rev-parse', '--verify', 'refs/heads/chat/alpha'])).toBeTruthy()
    expect(runtime.get(session.id)?.capabilities.steer).toBe(true)
    expect(runtime.get(session.id)?.branch.baseSha).toBe(git(['rev-parse', 'main']))

    const { turnId } = await runtime.prompt(session.id, { text: 'hello there', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('chat/alpha')
    const finished = ofType(events, session.id, 'turn.finished')[0]
    expect(finished).toMatchObject({ turnId, stopReason: 'end_turn', usage: { totalTokens: 3 } })
    expect(ofType(events, session.id, 'text.delta').map((e) => e.delta)).toEqual(['echo: hello there'])
    expect(runtime.get(session.id)?.title).toBe('hello there')
    expect(caller.starts).toEqual([{ model: 'grok-4.6-xhigh', sessionId: session.id, repo: 'acme/repo', pr: undefined, correlationId: turnId }])
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(caller.finishes).toEqual([{ callId: 'a'.repeat(32), status: 'completed', error: undefined }])
    expect(runtime.get(session.id)?.workspace).toMatchObject({ currentBranch: 'chat/alpha', onBranch: true, dirty: false })

    // History is served from the mirror; no adapter is started for it.
    const before = controls.startCount
    const history = runtime.events(session.id, 0)
    expect(history.events.some((e) => e.event.type === 'turn.started')).toBe(true)
    expect(controls.startCount).toBe(before)

    // Steering while nothing runs is refused; a second prompt during a turn too.
    await expect(runtime.steer(session.id, 'x')).rejects.toMatchObject({ code: 'no_turn' })
    controls.adapters[0].auto = false
    await runtime.prompt(session.id, { text: 'long one', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, session.id) === 'running')
    expect(() => runtime.prompt(session.id, { text: 'again', attachments: [], mentions: [] })).toThrow(/already running/)
    await runtime.steer(session.id, 'also do this')
    expect(controls.adapters[0].steered).toEqual(['also do this'])
    expect(ofType(events, session.id, 'steer.sent')).toHaveLength(1)
    const stopped = await runtime.cancel(session.id)
    expect(stopped.settled).toBe(true)
    expect(ofType(events, session.id, 'turn.finished').at(-1).stopReason).toBe('cancelled')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(caller.finishes.at(-1).status).toBe('cancelled')
    await runtime.stop()
  }, 40_000)

  it('answers permissions and questions inline, remembers "always" only for the session, and clears them on cancel', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    const adapter = controls.adapters[0]
    adapter.auto = false
    await runtime.prompt(session.id, { text: 'needs permission', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, session.id) === 'running')
    const host = controls.hosts[0]
    const options = [{ id: 'once', name: 'Yes', kind: 'allow_once' as const }, { id: 'always', name: 'Always', kind: 'allow_always' as const }, { id: 'no', name: 'No', kind: 'reject_once' as const }]
    const first = host.requestPermission({ title: 'Execute `rm -f x`', input: { command: 'rm -f x' }, options })
    await waitFor(() => ofType(events, session.id, 'permission.requested').length === 1)
    expect(lastStatus(events, session.id)).toBe('waiting')
    expect(runtime.get(session.id)?.pendingRequests).toHaveLength(1)
    const requestId = ofType(events, session.id, 'permission.requested')[0].id
    await expect(() => runtime.respondPermission(session.id, requestId, 'bogus')).toThrow(/unknown option/)
    runtime.respondPermission(session.id, requestId, 'always')
    // The agent gets the once option; Poise keeps the grant.
    expect(await first).toBe('once')
    expect(ofType(events, session.id, 'permission.resolved')[0]).toMatchObject({ optionId: 'always', by: 'user' })
    const second = await host.requestPermission({ title: 'Execute `rm -f x`', input: { command: 'rm -f x' }, options })
    expect(second).toBe('once')
    expect(ofType(events, session.id, 'permission.resolved')[1]).toMatchObject({ by: 'session' })
    // A different command asks again.
    const third = host.requestPermission({ title: 'Execute `rm -rf y`', input: { command: 'rm -rf y' }, options })
    third.catch(() => undefined)
    await waitFor(() => ofType(events, session.id, 'permission.requested').length === 3)
    const question = host.askQuestion({ questions: [{ id: '0', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, freeText: false }] })
    await waitFor(() => ofType(events, session.id, 'question.asked').length === 1)
    const questionId = ofType(events, session.id, 'question.asked')[0].id
    runtime.answerQuestion(session.id, questionId, { '0': 'B' })
    expect(await question).toEqual({ '0': 'B' })
    // Cancel settles the still-pending permission with the reject path.
    await runtime.cancel(session.id)
    await expect(third).rejects.toThrow()
    expect(ofType(events, session.id, 'permission.resolved').at(-1)).toMatchObject({ by: 'cancelled' })
    expect(runtime.get(session.id)?.pendingRequests).toEqual([])
    await runtime.stop()
  }, 40_000)

  it('serializes turns on one checkout, checkpoints the outgoing session, and refuses unowned dirty state', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const a = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'beta' } })
    await waitFor(() => lastStatus(events, b.id) === 'idle')
    // A runs (and leaves uncommitted work on chat/alpha); B queues behind it.
    controls.adapters[0].auto = false
    await runtime.prompt(a.id, { text: 'work on alpha', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, a.id) === 'running')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('chat/alpha')
    await writeFile(join(repo, 'alpha.txt'), 'from a')
    await runtime.prompt(b.id, { text: 'work on beta', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, b.id) === 'queued')
    expect(runtime.get(b.id)?.queuedBehind).toContain('chat "work on alpha" on chat/alpha')
    controls.adapters[0].finish()
    await waitFor(() => ofType(events, b.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, b.id) === 'idle')
    // A's work was checkpointed on its own branch, B ran on its branch.
    expect(git(['log', '-1', '--format=%s', 'chat/alpha'])).toBe('wip(poise): checkpoint')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('chat/beta')
    expect(runtime.get(a.id)?.branch.provisional).toBe(false)
    expect(ofType(events, b.id, 'status.changed').some((e) => String(e.detail || '').includes('checkpointed'))).toBe(true)

    // Dirty state on a branch no session owns is refused by name.
    git(['switch', '-q', 'main'])
    await writeFile(join(repo, 'user.txt'), 'the user was here')
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    runtime.prompt(a.id, { text: 'try again', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    const refused = ofType(events, a.id, 'turn.finished').at(-1)
    expect(refused.stopReason).toBe('error')
    expect(refused.error).toMatch(/on main, which no chat session owns/)
    expect(await readFile(join(repo, 'user.txt'), 'utf8')).toBe('the user was here')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    await rm(join(repo, 'user.txt'))

    // Delete: beta's tip never moved from its base → deleted; alpha has a commit → kept.
    await runtime.delete(b.id)
    expect(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/chat/beta'], { cwd: repo }).status).not.toBe(0)
    await runtime.delete(a.id)
    expect(git(['rev-parse', '--verify', 'refs/heads/chat/alpha'])).toBeTruthy()
    expect(storage.getSession(a.id)).toBeNull()
    await runtime.stop()
  }, 40_000)

  it('keeps another Poise instance out of its sessions and behind its checkout lock', async () => {
    ensureBranch('chat/alpha')
    const first = makeRuntime({ instance: 'poise-one:db' })
    const second = makeRuntime({ instance: 'poise-two:db' })
    const mine = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(first.events, mine.id) === 'idle')
    expect(() => second.runtime.get(mine.id)).toThrow(/another Poise server/)
    expect(second.runtime.list()).toEqual([])
    expect(second.runtime.ownsSession(mine.id)).toBe(false)
    first.controls.adapters[0].auto = false
    await first.runtime.prompt(mine.id, { text: 'hold the checkout', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(first.events, mine.id) === 'running')
    // Starting a session needs the checkout too (its branch gets checked out
    // and its agent registered on the lease), so it waits behind the turn.
    const theirs = await second.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(second.events, theirs.id) === 'queued')
    expect(second.runtime.get(theirs.id)?.queuedBehind).toContain('(Poise test)')
    expect(second.controls.startCount).toBe(0)
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(second.events, theirs.id) === 'idle')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    await second.runtime.prompt(theirs.id, { text: 'wait for it', attachments: [], mentions: [] })
    await waitFor(() => ofType(second.events, theirs.id, 'turn.finished').length === 1)
    expect(ofType(second.events, theirs.id, 'turn.finished')[0].stopReason).toBe('end_turn')
    await first.runtime.stop()
    await second.runtime.stop()
  }, 40_000)

  it('marks an open turn interrupted after a restart, cancels its pending prompts, and replays nothing', async () => {
    ensureBranch('chat/alpha')
    const caller = fakeCaller()
    // The crashed server's lease must look like a dead process held it and
    // stopped renewing; in one test process that means lending it a pid that
    // has already exited and a clock that stays in the past.
    const deadPid = spawnSync('true').pid
    const crashed = makeRuntime({ instance: 'poise-crash:db', caller, leaseProbes: { hostPid: deadPid, now: () => Date.now() - 120_000 } })
    const session = await crashed.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(crashed.events, session.id) === 'idle')
    crashed.controls.adapters[0].auto = false
    await crashed.runtime.prompt(session.id, { text: 'never finishes', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(crashed.events, session.id) === 'running')
    const host = crashed.controls.hosts[0]
    void host.requestPermission({ title: 'Execute `x`', options: [{ id: 'y', name: 'y', kind: 'allow_once' }, { id: 'n', name: 'n', kind: 'reject_once' }] }).catch(() => undefined)
    await waitFor(() => ofType(crashed.events, session.id, 'permission.requested').length === 1)
    // "Crash": a new runtime for the same instance with no shutdown in between.
    crashed.runtime.removeAllListeners('event')
    const revived = makeRuntime({ instance: 'poise-crash:db', caller })
    await revived.runtime.recover()
    const record = revived.runtime.get(session.id)!
    expect(record.status).toBe('interrupted')
    expect(record.interruptedTurnId).toBeTruthy()
    const { events } = revived.runtime.events(session.id, 0)
    const finished = events.filter((e) => e.event.type === 'turn.finished').map((e) => e.event as any)
    expect(finished.at(-1)).toMatchObject({ stopReason: 'interrupted' })
    expect(events.filter((e) => e.event.type === 'permission.resolved').at(-1)?.event).toMatchObject({ by: 'cancelled' })
    expect(record.pendingRequests).toEqual([])
    expect(caller.finishes.at(-1)).toMatchObject({ status: 'failed', error: 'Interrupted by Poise restart' })
    // Nothing was replayed: no new turn.started, and no adapter was started by recovery.
    expect(events.filter((e) => e.event.type === 'turn.started')).toHaveLength(1)
    expect(revived.controls.startCount).toBe(0)
    // Explicit resume brings the agent back with its native session id.
    const resumed = await revived.runtime.resume(session.id)
    expect(resumed.status).toBe('idle')
    expect(revived.controls.startCount).toBe(1)
    expect(revived.controls.adapters[0].nativeSessionId).toBe('native-1')
    await revived.runtime.stop()
    crashed.controls.adapters[0].finish()
    await crashed.runtime.stop().catch(() => undefined)
  }, 40_000)

  it('reports a failed adapter start readably and surfaces Caller compatibility errors', async () => {
    ensureBranch('chat/alpha')
    const controls: FakeControls = { hosts: [], adapters: [], startCount: 0, failStart: 'Grok Build could not start: not signed in' }
    const { runtime, events } = makeRuntime({ controls })
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, session.id) === 'error')
    expect(ofType(events, session.id, 'error')[0].message).toMatch(/Grok Build could not start: not signed in/)
    await runtime.stop()

    const { CallerCompatError } = await import('../../server/chat/caller-turns')
    const compat = makeRuntime({ caller: { async start() { throw new CallerCompatError() }, async finish() { throw new Error('unreachable') } } })
    const s2 = await compat.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(compat.events, s2.id) === 'idle')
    compat.runtime.prompt(s2.id, { text: 'go', attachments: [], mentions: [] })
    await waitFor(() => ofType(compat.events, s2.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(compat.events, s2.id) === 'idle')
    expect(ofType(compat.events, s2.id, 'turn.finished')[0].error).toMatch(/Update Caller: recording chat turns is unavailable/)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('chat/alpha')
    await compat.runtime.stop()
  }, 40_000)

  it('forks, hands off with a labelled summary, and rejects model changes across agents', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'first', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    const fork = await runtime.fork(session.id)
    await waitFor(() => lastStatus(events, fork.id) === 'idle')
    expect(fork.forkedFrom).toBe(session.id)
    expect(fork.branch).toMatchObject({ name: 'chat/alpha', provisional: false })
    expect(controls.adapters.at(-1)?.nativeSessionId).toBe('native-1-fork')
    await expect(runtime.setModel(session.id, 'opus-5-max')).rejects.toMatchObject({ code: 'invalid' })
    await runtime.setModel(session.id, 'grok-4.6-high')
    expect(runtime.get(session.id)).toMatchObject({ model: 'grok-4.6-high', effort: 'high' })
    const handoff = await runtime.handoff(session.id, { agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => ofType(events, handoff.id, 'turn.finished').length === 1)
    const prompt = ofType(events, handoff.id, 'turn.started')[0].prompt.text
    expect(prompt).toMatch(/^\[Handoff from a Grok Build session/)
    expect(prompt).toContain('User: first')
    expect(prompt).toContain('branch chat/alpha')
    await runtime.stop()
  }, 40_000)

  it('terminates the real worker group when a session is closed', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    // The fake adapter never spawns; spawn a real worker through the host as
    // an agent would — which is only allowed while a turn holds the lease.
    await expect(controls.hosts[0].spawn('sh', ['-c', 'sleep 60 & wait'])).rejects.toThrow(/lease is not held/)
    controls.adapters[0].auto = false
    runtime.prompt(session.id, { text: 'spawn', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, session.id) === 'running')
    const child = await controls.hosts[0].spawn('sh', ['-c', 'sleep 60 & wait'])
    const pgid = child.pid!
    await waitFor(() => worker.pgidAlive(pgid))
    const workers = storage.listWorkers()
    expect(workers.map((w) => w.sessionId)).toContain(session.id)
    expect(workers.find((w) => w.sessionId === session.id)?.leaseToken).toBeTruthy()
    // File services work only for the running turn on the right branch.
    await expect(controls.hosts[0].readTextFile('README.md')).resolves.toContain('# repo')
    await expect(controls.hosts[0].readTextFile('../outside')).rejects.toThrow()
    await runtime.close(session.id)
    await waitFor(() => !worker.pgidAlive(pgid), 10_000)
    expect(storage.listWorkers().map((w) => w.sessionId)).not.toContain(session.id)
    expect(runtime.get(session.id)?.status).toBe('closed')
    await runtime.stop()
  }, 40_000)
})

describe('chat attachments and mentions', () => {
  it('stages uploads per session, checks a prompt against the records, and reads content itself', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const a = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(events, a.id) === 'idle' && lastStatus(events, b.id) === 'idle')
    const saved = await runtime.saveAttachment(a.id, '../evil/notes.txt', Buffer.from('hello from the user\n'))
    expect(saved.path).toBe(`.poise-chat/attachments/${a.id}/${saved.id}-notes.txt`)
    expect(saved.size).toBe(20)
    expect(await readFile(join(repo, saved.path), 'utf8')).toBe('hello from the user\n')
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.poise-chat/\n')
    expect(git(['status', '--porcelain'])).toBe('')
    // Client-supplied text is ignored; the file's own content goes to the agent.
    runtime.prompt(a.id, { text: 'look', attachments: [{ ...saved, text: 'forged' }], mentions: [{ path: 'README.md' }] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    expect(ofType(events, a.id, 'turn.finished')[0].stopReason).toBe('end_turn')
    const input = controls.adapters[0].inputs[0]
    expect(input.attachments).toEqual([{ id: saved.id, name: 'notes.txt', path: saved.path, size: 20, text: 'hello from the user\n' }])
    expect(input.mentions).toEqual([{ path: 'README.md' }])
    expect(ofType(events, a.id, 'turn.started')[0].prompt.attachments[0].text).toBeUndefined()

    // Another session's record, a tampered path, and a tampered size are refused before a turn is reserved.
    expect(() => runtime.prompt(b.id, { text: 'steal', attachments: [saved], mentions: [] })).toThrow(/does not belong to this session/)
    expect(() => runtime.prompt(a.id, { text: 'x', attachments: [{ ...saved, path: 'README.md' }], mentions: [] })).toThrow(/does not match its record/)
    expect(() => runtime.prompt(a.id, { text: 'x', attachments: [{ ...saved, size: 1 }], mentions: [] })).toThrow(/does not match its record/)
    expect(() => runtime.prompt(a.id, { text: 'x', attachments: [{ id: 'nope', name: 'n', path: 'p', size: 1 }], mentions: [] })).toThrow(/does not belong to this session/)
    expect(runtime.get(a.id)?.status).toBe('idle')

    // A mention outside the checkout or to a missing file fails the turn readably.
    runtime.prompt(a.id, { text: 'x', attachments: [], mentions: [{ path: '../outside' }] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    expect(ofType(events, a.id, 'turn.finished')[1]).toMatchObject({ stopReason: 'error', error: expect.stringMatching(/@\.\.\/outside is not a file in the checkout/) })
    runtime.prompt(a.id, { text: 'x', attachments: [], mentions: [{ path: 'missing.md' }] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    expect(ofType(events, a.id, 'turn.finished')[2].error).toMatch(/missing\.md is not a file/)

    // An attachment that changed or vanished on disk since the upload is not sent.
    await writeFile(join(repo, saved.path), 'tampered')
    runtime.prompt(a.id, { text: 'x', attachments: [saved], mentions: [] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 4)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    expect(ofType(events, a.id, 'turn.finished')[3].error).toMatch(/changed on disk since it was uploaded/)
    await rm(join(repo, saved.path))
    runtime.prompt(a.id, { text: 'x', attachments: [saved], mentions: [] })
    await waitFor(() => ofType(events, a.id, 'turn.finished').length === 5)
    await waitFor(() => lastStatus(events, a.id) === 'idle')
    expect(ofType(events, a.id, 'turn.finished')[4].error).toMatch(/no longer readable in the checkout/)
    expect(controls.adapters[0].inputs).toHaveLength(1)

    // Deleting the session removes its staging directory and records.
    await runtime.delete(a.id)
    expect(existsSync(join(repo, '.poise-chat', 'attachments', a.id))).toBe(false)
    expect(storage.getAttachment(saved.id)).toBeNull()
    await runtime.stop()
  }, 40_000)

  it('accepts an upload during the session\'s own turn and refuses one for a closed session', async () => {
    ensureBranch('chat/alpha')
    const { runtime, controls, events } = makeRuntime()
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'chat/alpha' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    controls.adapters[0].auto = false
    runtime.prompt(session.id, { text: 'hold', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, session.id) === 'running')
    // The turn holds the lease; the upload rides on it rather than waiting.
    const saved = await runtime.saveAttachment(session.id, 'mid-turn.txt', Buffer.from('later'))
    expect(await readFile(join(repo, saved.path), 'utf8')).toBe('later')
    controls.adapters[0].finish()
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    await runtime.close(session.id)
    await expect(runtime.saveAttachment(session.id, 'late.txt', Buffer.from('x'))).rejects.toThrow(/closed/)
    await runtime.stop()
  }, 40_000)
})

// Keep the SessionRecord import meaningful for the type checker.
export type _Record = SessionRecord
