// The runtime side of `/poise`: a dedicated change session in the
// controller-prepared checkout, one reserved implementing turn, a durable
// finish that reaches the controller only after the turn's cleanup, and the
// drain gate the controller uses before restarting the server. The
// controller itself is a fake here: no socket, no release, no production.
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatEnvelope, ChatEvent, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions } from '../../server/chat/adapters/types'
import type { SelfUpdateBridge } from '../../server/self-update-bridge'
import type { PreparedSelfChange, SelfChange, SelfUpdateStatus } from '../../src/self-update-types'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let storage: typeof import('../../server/chat/storage')
let outbox: typeof import('../../server/self-update-outbox')
let bridgeModule: typeof import('../../server/self-update-bridge')

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

interface FakeControls { hosts: AdapterHost[], adapters: FakeAdapter[], startCount: number, failStart?: string, stopWith?: 'error' | 'end_turn', /** Adapters created from now on wait for `finish()`. */ manual?: boolean }
class FakeAdapter implements Adapter {
  agent = 'grok' as const
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  inputs: PromptInput[] = []
  auto = true
  private finishTurn: ((stop?: 'end_turn' | 'cancelled' | 'error') => void) | null = null
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) { this.auto = !controls.manual }
  async start(options: AdapterStartOptions) {
    this.controls.startCount += 1
    if (this.controls.failStart) throw new Error(this.controls.failStart)
    this.alive = true
    this.nativeSessionId = options.resume || `native-${this.controls.startCount}`
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort }
  }
  async prompt(turnId: string, input: PromptInput, signal: AbortSignal) {
    this.inputs.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: 'working' })
    if (this.auto) return this.controls.stopWith === 'error' ? { stopReason: 'error' as const, error: 'the agent gave up' } : { stopReason: 'end_turn' as const }
    return new Promise<{ stopReason: 'end_turn' | 'cancelled' | 'error', error?: string }>((resolve) => {
      this.finishTurn = (stop = 'end_turn') => { this.finishTurn = null; resolve(stop === 'error' ? { stopReason: 'error', error: 'the agent gave up' } : { stopReason: stop }) }
      signal.addEventListener('abort', () => this.finishTurn?.('cancelled'), { once: true })
    })
  }
  finish(stop: 'end_turn' | 'error' = 'end_turn') { this.finishTurn?.(stop) }
  async steer() {}
  async cancel() { this.finishTurn?.('cancelled') }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() { throw new Error('unsupported') }
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.alive = false; for (const l of this.exitListeners) l(0, null) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
}

/** An in-memory controller: prepares a real clone on the change branch and
 *  records every call in order. */
interface FakeBridge extends SelfUpdateBridge {
  calls: Array<{ op: string, at: number, changeId?: string, input?: any, sessionStatus?: string, openTurn?: unknown, workers?: number }>
  changes: Map<string, SelfChange>
  failFinish: string | null
  inspect: ((sessionId: string) => { status?: string, openTurn?: unknown, workers?: number }) | null
}
function fakeBridge(instance: string, options: { configured?: boolean } = {}): FakeBridge {
  const calls: FakeBridge['calls'] = []
  const changes = new Map<string, SelfChange>()
  const bridge: FakeBridge = {
    configured: options.configured ?? true,
    root: options.configured === false ? null : join(root, 'ctl'),
    calls, changes, failFinish: null, inspect: null,
    async status(): Promise<SelfUpdateStatus> {
      calls.push({ op: 'status', at: Date.now() })
      return { enabled: true, available: true, activeRelease: null, previousRelease: null, hold: null, changes: [...changes.values()] }
    },
    async prepareChange(input): Promise<PreparedSelfChange> {
      calls.push({ op: 'prepare', at: Date.now(), input })
      const workspace = join(root, 'ws', input.id)
      await mkdir(join(root, 'ws'), { recursive: true })
      git(['clone', '-q', repo, workspace])
      git(['switch', '-q', '-c', `poise/change-${input.id}`], workspace)
      const now = new Date().toISOString()
      const change: SelfChange = {
        id: input.id, sessionId: input.sessionId, instance, request: input.request, title: input.title || 'change', repository: 'mikkokotila/Poise',
        branch: `poise/change-${input.id}`, baseSha: git(['rev-parse', 'HEAD'], workspace), state: 'implementing', createdAt: now, updatedAt: now, canRevert: false,
      }
      changes.set(input.id, change)
      return { change, workspace, branch: change.branch, baseSha: change.baseSha }
    },
    async bindSession(changeId, input) {
      calls.push({ op: 'bind', at: Date.now(), changeId, input })
      const change = changes.get(changeId)!
      change.sessionId = input.sessionId
      return change
    },
    async finish(changeId, input) {
      const change = changes.get(changeId)
      const seen = bridge.inspect && change ? bridge.inspect(change.sessionId) : {}
      calls.push({ op: 'finish', at: Date.now(), changeId, input, sessionStatus: seen.status, openTurn: seen.openTurn, workers: seen.workers })
      if (bridge.failFinish) throw new bridgeModule.SelfUpdateUnavailableError(bridge.failFinish)
      if (!change) throw new bridgeModule.SelfUpdateBridgeError(404, 'unknown change')
      change.state = input.outcome === 'completed' ? 'checking' : 'failed'
      change.error = input.error
      return change
    },
    async rollback(changeId, input) { calls.push({ op: 'rollback', at: Date.now(), changeId, input }); return changes.get(changeId)! },
    async tick() { return bridge.status() },
    readBridgeKey: () => 'k'.repeat(40),
  }
  return bridge
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []

function makeRuntime(options: { instance?: string, controls?: FakeControls, bridge?: SelfUpdateBridge | null, leaseProbes?: import('../../server/chat/checkout-lock').CheckoutLeaseOptions } = {}) {
  const controls: FakeControls = options.controls ?? { hosts: [], adapters: [], startCount: 0 }
  const runtime = new runtimeModule.ChatRuntime({
    instance: options.instance ?? 'poise-test:db',
    instanceLabel: 'test',
    adapters: { grok: (host) => { const a = new FakeAdapter(host, controls); controls.hosts.push(host); controls.adapters.push(a); return a } },
    callerTurns: null,
    catalog: async () => CATALOG as any,
    resolveCheckout: async () => repo,
    idleTimeoutMinutes: () => 0,
    requireClaudeReady: async () => {},
    leaseProbes: options.leaseProbes,
    selfUpdate: options.bridge,
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, controls, events }
}

afterEach(async () => {
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
  root = await mkdtemp(join(tmpdir(), 'poise-self-update-rt-'))
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
  outbox = await import('../../server/self-update-outbox')
  bridgeModule = await import('../../server/self-update-bridge')
})

afterAll(async () => {
  const { closeDatabase } = await import('../../server/db')
  closeDatabase()
  delete process.env.POISE_DB
  delete process.env.POISE_LOCK_DIR
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

async function sourceSession(runtime: import('../../server/chat/runtime').ChatRuntime, events: ChatEnvelope[]) {
  const source = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
  await waitFor(() => lastStatus(events, source.id) === 'idle')
  return source
}

describe('/poise change sessions', () => {
  it('refuses actionably when no controller is configured and creates nothing', async () => {
    const { runtime, events } = makeRuntime({ bridge: null })
    const source = await sourceSession(runtime, events)
    const before = runtime.list().length
    await expect(runtime.startPoiseChange(source.id, 'add a button', randomUUID())).rejects.toMatchObject({ code: 'self_update_unavailable', statusCode: 503 })
    expect(runtime.list()).toHaveLength(before)
    const unconfigured = makeRuntime({ bridge: fakeBridge('poise-test:db', { configured: false }) })
    const src2 = await sourceSession(unconfigured.runtime, unconfigured.events)
    await expect(unconfigured.runtime.startPoiseChange(src2.id, 'add a button', randomUUID())).rejects.toMatchObject({ code: 'self_update_unavailable' })
  }, 20_000)

  it('prepares, binds, runs one runbook turn in the controller checkout, and finishes only after cleanup', async () => {
    const bridge = fakeBridge('poise-test:db')
    const { runtime, controls, events } = makeRuntime({ bridge })
    bridge.inspect = (sessionId) => ({ status: runtime.get(sessionId)?.status, openTurn: storage.getOpenTurn(sessionId), workers: storage.listWorkers().length })
    const source = await sourceSession(runtime, events)
    const changeId = randomUUID()
    const request = 'Add a Refresh button to the Chat header\n\nIt should reload the session list.'
    // A resend that arrives while the first is still preparing shares it.
    const inFlight = runtime.startPoiseChange(source.id, request, changeId)
    const conflicting = runtime.startPoiseChange(source.id, 'something else', changeId)
    await expect(conflicting).rejects.toMatchObject({ statusCode: 409 })
    const [first, second] = await Promise.all([inFlight, runtime.startPoiseChange(source.id, request, changeId.toUpperCase())])
    const { session, change } = first
    expect(second.session.id).toBe(session.id)

    // The session is the server's: controller checkout, change branch, the
    // source's model, no user repo choice, titled by the request.
    expect(session).toMatchObject({ workspaceKind: 'poise-change', selfChangeId: changeId, repo: 'mikkokotila/Poise', agent: 'grok', model: source.model, modelId: source.modelId, effort: source.effort })
    expect(session.branch).toMatchObject({ name: `poise/change-${changeId}`, origin: 'existing', provisional: false })
    expect(session.checkout).toContain(join('ws', changeId))
    expect(session.checkout).not.toBe(source.checkout)
    expect(session.title).toBe('Poise: Add a Refresh button to the Chat header')
    expect(session.context).toMatchObject({ kind: 'poise-change', body: request, fromSession: source.id })
    expect(change).toMatchObject({ id: changeId, sessionId: session.id, state: 'implementing' })
    // Controller order: prepare with the source session, bind with the new one.
    expect(bridge.calls.map((c) => c.op)).toEqual(['prepare', 'bind'])
    expect(bridge.calls[0].input).toEqual({ id: changeId, sessionId: source.id, instance: 'poise-test:db', request, title: 'Add a Refresh button to the Chat header' })
    expect(bridge.calls[1]).toMatchObject({ changeId, input: { sessionId: session.id, instance: 'poise-test:db' } })
    // The turn was reserved before the ack: a browser prompt cannot get in first.
    expect(() => runtime.prompt(session.id, { text: 'me first', attachments: [], mentions: [] })).toThrow(/already running/)

    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => bridge.calls.some((c) => c.op === 'finish'))
    const started = ofType(events, session.id, 'turn.started')
    expect(started).toHaveLength(1)
    // The transcript shows the request as typed; the agent got the runbook
    // around it (provider-side injection only).
    expect(started[0].prompt.text).toBe(request)
    const native = controls.adapters.at(-1)!.inputs
    expect(native).toHaveLength(1)
    expect(native[0].text).toMatch(/^\[Poise self-improvement change\]/)
    expect(native[0].text).toContain(`poise/change-${changeId}`)
    expect(native[0].text).toContain('npm run check')
    expect(native[0].text).toContain('Do NOT push')
    expect(native[0].text).toContain('front end (src/), server (server/)')
    expect(native[0].text).not.toMatch(/off limits|only files under/i)
    expect(native[0].text.endsWith(`Request:\n${request}`)).toBe(true)
    expect(controls.adapters.at(-1)!.host.checkout).toBe(session.checkout)
    expect(runtime.get(session.id)?.title).toBe('Poise: Add a Refresh button to the Chat header')
    // Finish reached the controller once, as completed, after the turn was
    // closed out (no open turn, no worker, session already idle).
    const finishes = bridge.calls.filter((c) => c.op === 'finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ changeId, input: { outcome: 'completed' }, sessionStatus: 'idle', openTurn: null, workers: 0 })
    expect(finishes[0].at).toBeGreaterThanOrEqual(new Date(events.find((e) => e.sessionId === session.id && e.event.type === 'turn.finished')!.at).getTime())
    expect(outbox.getFinish(changeId)).toMatchObject({ outcome: 'completed', deliveredAt: expect.any(String), sessionId: session.id })
    expect(ofType(events, session.id, 'status.changed').some((e) => /handed to the release controller/.test(e.detail || ''))).toBe(true)

    // The session stays an ordinary chat afterwards: follow-up discussion
    // runs as a normal turn, shown as typed, and never touches the recorded
    // outcome or the controller again. Fork/handoff of the controller's
    // checkout are the only things refused.
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'why did you pick that colour?', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(ofType(events, session.id, 'turn.started')[1].prompt.text).toBe('why did you pick that colour?')
    expect(controls.adapters.at(-1)!.inputs.at(-1)!.text).toBe('why did you pick that colour?')
    expect(bridge.calls.filter((c) => c.op === 'finish')).toHaveLength(1)
    expect(outbox.getFinish(changeId)).toMatchObject({ outcome: 'completed', sessionId: session.id })
    expect(ofType(events, session.id, 'status.changed').filter((e) => /handed to the release controller/.test(e.detail || ''))).toHaveLength(1)
    await expect(runtime.fork(session.id)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(runtime.handoff(session.id, { agent: 'grok', model: 'grok-4.6-xhigh' })).rejects.toMatchObject({ code: 'unsupported' })
    runtime.prompt(source.id, { text: 'unrelated', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, source.id, 'turn.finished').length === 1)

    // The same change id, same session, same request is the same change:
    // the existing session comes back and nothing is prepared or bound
    // again. The id with a different request or from another session is a
    // conflict, never a silent reuse.
    const again = await runtime.startPoiseChange(source.id, request, changeId)
    expect(again.session.id).toBe(session.id)
    expect(bridge.calls.filter((c) => c.op === 'prepare')).toHaveLength(1)
    expect(bridge.calls.filter((c) => c.op === 'bind')).toHaveLength(1)
    await expect(runtime.startPoiseChange(source.id, `${request} and more`, changeId)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already used for a different request/) })
    const otherSource = await sourceSession(runtime, events)
    await expect(runtime.startPoiseChange(otherSource.id, request, changeId)).rejects.toMatchObject({ statusCode: 409 })
    expect(bridge.calls.filter((c) => c.op === 'prepare')).toHaveLength(1)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main') // the source checkout was never switched
  }, 40_000)

  it('validates the request and the controller answer before anything is created', async () => {
    const bridge = fakeBridge('poise-test:db')
    const { runtime, events } = makeRuntime({ bridge })
    const source = await sourceSession(runtime, events)
    await expect(runtime.startPoiseChange(source.id, '   ', randomUUID())).rejects.toMatchObject({ code: 'invalid' })
    await expect(runtime.startPoiseChange(source.id, 'x', 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid' })
    await expect(runtime.startPoiseChange(randomUUID(), 'x', randomUUID())).rejects.toMatchObject({ code: 'unknown_session' })
    expect(bridge.calls).toEqual([])
    // A controller answering for another instance is refused and the change
    // failed at the controller so its lane frees up.
    const foreign = fakeBridge('poise-other:db')
    const other = makeRuntime({ bridge: foreign })
    const src = await sourceSession(other.runtime, other.events)
    const id = randomUUID()
    await expect(other.runtime.startPoiseChange(src.id, 'x', id)).rejects.toMatchObject({ statusCode: 502 })
    expect(foreign.calls.map((c) => c.op)).toEqual(['prepare', 'finish'])
    expect(foreign.calls[1]).toMatchObject({ changeId: id, input: { outcome: 'failed' } })
    expect(other.runtime.list().some((s) => s.selfChangeId === id)).toBe(false)
  }, 20_000)

  it('reports a failed turn as failed, never as completed', async () => {
    const bridge = fakeBridge('poise-test:db')
    const controls: FakeControls = { hosts: [], adapters: [], startCount: 0, stopWith: 'error' }
    const { runtime, events } = makeRuntime({ bridge, controls })
    const source = await sourceSession(runtime, events)
    const changeId = randomUUID()
    const { session } = await runtime.startPoiseChange(source.id, 'break things', changeId)
    await waitFor(() => bridge.calls.some((c) => c.op === 'finish'))
    expect(bridge.calls.filter((c) => c.op === 'finish')[0]).toMatchObject({ input: { outcome: 'failed', error: 'the agent gave up' } })
    expect(outbox.getFinish(changeId)).toMatchObject({ outcome: 'failed', sessionId: session.id })
    // A cancelled change is failed too.
    const second = fakeBridge('poise-test:db')
    const slow = makeRuntime({ bridge: second })
    const src2 = await sourceSession(slow.runtime, slow.events)
    slow.controls.manual = true
    const id2 = randomUUID()
    const { session: s2 } = await slow.runtime.startPoiseChange(src2.id, 'slow one', id2)
    await waitFor(() => lastStatus(slow.events, s2.id) === 'running')
    // The change turn shows up in the busy count while it runs.
    expect(slow.runtime.busy()).toBeGreaterThan(0)
    await slow.runtime.cancel(s2.id)
    await waitFor(() => second.calls.some((c) => c.op === 'finish'))
    expect(second.calls.filter((c) => c.op === 'finish')[0]).toMatchObject({ input: { outcome: 'failed' } })
  }, 40_000)

  it('keeps an undelivered finish in the outbox and delivers it exactly once later', async () => {
    const bridge = fakeBridge('poise-test:db')
    bridge.failFinish = 'controller down'
    const { runtime, events } = makeRuntime({ bridge })
    const source = await sourceSession(runtime, events)
    const changeId = randomUUID()
    const { session } = await runtime.startPoiseChange(source.id, 'deliver later', changeId)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => bridge.calls.some((c) => c.op === 'finish'))
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(outbox.getFinish(changeId)).toMatchObject({ outcome: 'completed', deliveredAt: null, attempts: 1, lastError: 'controller down' })
    // Discussion goes on meanwhile; the recorded outcome is final regardless.
    runtime.prompt(session.id, { text: 'and now?', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(outbox.getFinish(changeId)).toMatchObject({ outcome: 'completed', deliveredAt: null })
    bridge.failFinish = null
    await runtime.flushSelfUpdateOutbox()
    await runtime.flushSelfUpdateOutbox()
    expect(bridge.calls.filter((c) => c.op === 'finish')).toHaveLength(2) // one refused, one delivered; the second flush had nothing to send
    expect(outbox.getFinish(changeId)?.deliveredAt).toBeTruthy()
    expect(bridge.changes.get(changeId)?.state).toBe('checking')
  }, 40_000)

  it('after a crash mid-turn recovery fails the change without replaying and delivers from the outbox', async () => {
    const bridge = fakeBridge('poise-crash:db')
    const deadPid = spawnSync('true').pid
    const crashed = makeRuntime({ instance: 'poise-crash:db', bridge, leaseProbes: { hostPid: deadPid, now: () => Date.now() - 120_000 } })
    const source = await sourceSession(crashed.runtime, crashed.events)
    crashed.controls.manual = true
    const changeId = randomUUID()
    const { session } = await crashed.runtime.startPoiseChange(source.id, 'never finishes', changeId)
    await waitFor(() => lastStatus(crashed.events, session.id) === 'running')
    crashed.runtime.removeAllListeners('event')
    const revived = makeRuntime({ instance: 'poise-crash:db', bridge })
    await revived.runtime.recover()
    expect(revived.runtime.get(session.id)?.status).toBe('interrupted')
    expect(revived.controls.startCount).toBe(0)
    expect(revived.runtime.events(session.id, 0).events.filter((e) => e.event.type === 'turn.started')).toHaveLength(1)
    const finishes = bridge.calls.filter((c) => c.op === 'finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ changeId, input: { outcome: 'failed', error: expect.stringMatching(/Poise restarted/) } })
    expect(outbox.getFinish(changeId)?.deliveredAt).toBeTruthy()
    // Recovery of the revived server counts as busy only while it runs.
    expect(revived.runtime.busy()).toBe(0)
    crashed.controls.adapters.at(-1)?.finish()
    await crashed.runtime.stop().catch(() => undefined)
  }, 40_000)
})

describe('drain and readiness', () => {
  it('refuses new work atomically, closes idle agents gracefully, lets running turns finish, and reaches ready', async () => {
    const bridge = fakeBridge('poise-test:db')
    const { runtime, controls, events } = makeRuntime({ bridge })
    const session = await sourceSession(runtime, events)
    const idle = await sourceSession(runtime, events)
    // Idle sessions still hold live agent processes: not quiescent yet.
    expect(runtime.busy()).toBe(2)
    const idleAdapter = controls.adapters[1]
    const idleNative = runtime.get(idle.id)!.nativeSessionId
    expect(idleNative).toBeTruthy()
    controls.adapters.forEach((a) => { a.auto = false })
    runtime.prompt(session.id, { text: 'long running', attachments: [], mentions: [] })
    await waitFor(() => lastStatus(events, session.id) === 'running')
    expect(runtime.busy()).toBeGreaterThan(0)

    expect(runtime.draining).toBeNull()
    runtime.startDrain('rel-1')
    expect(runtime.draining).toMatchObject({ releaseId: 'rel-1' })
    // New work of every kind is refused with one code.
    await expect(runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })).rejects.toMatchObject({ code: 'draining', statusCode: 503 })
    expect(() => runtime.prompt(idle.id, { text: 'new', attachments: [], mentions: [] })).toThrow(/installing an update/)
    await expect(runtime.saveAttachment(idle.id, 'a.txt', Buffer.from('x'))).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.setModel(idle.id, 'grok-4.6-high')).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.resume(idle.id)).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.fork(idle.id)).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.rename(idle.id, 'x')).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.delete(idle.id)).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.steer(session.id, 'more')).rejects.toMatchObject({ code: 'draining' })
    await expect(runtime.startPoiseChange(idle.id, 'x', randomUUID())).rejects.toMatchObject({ code: 'draining' })
    expect(bridge.calls).toEqual([])
    // The idle agent was closed in its own lifecycle queue: verifiably gone,
    // native id kept, session still idle (not interrupted, not closed).
    await waitFor(() => idleAdapter.alive === false)
    await waitFor(() => ofType(events, idle.id, 'status.changed').some((e) => /closed for the Poise update/.test(e.detail || '')))
    expect(runtime.get(idle.id)).toMatchObject({ status: 'idle', nativeSessionId: idleNative })
    // The running turn was not touched; the agent's own requests still work;
    // and it can be ended by hand.
    expect(runtime.get(session.id)?.status).toBe('running')
    expect(controls.adapters[0].alive).toBe(true)
    const host = controls.hosts[0]
    const permission = host.requestPermission({ title: 'Execute `x`', options: [{ id: 'y', name: 'y', kind: 'allow_once' }, { id: 'n', name: 'n', kind: 'reject_once' }] })
    await waitFor(() => ofType(events, session.id, 'permission.requested').length === 1)
    runtime.respondPermission(session.id, ofType(events, session.id, 'permission.requested')[0].id, 'y')
    expect(await permission).toBe('y')
    expect(runtime.busy()).toBeGreaterThan(0)
    // A turn that finishes during the drain closes its process afterwards
    // and readiness reaches zero with ordinary idle sessions around.
    controls.adapters[0].finish()
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => runtime.busy() === 0)
    expect(controls.adapters[0].alive).toBe(false)
    expect(runtime.get(session.id)).toMatchObject({ status: 'idle', nativeSessionId: 'native-1' })
    // Close is settlement, so it is allowed while draining.
    await runtime.close(idle.id)
    expect(runtime.get(idle.id)?.status).toBe('closed')
    await waitFor(() => runtime.busy() === 0)
    // Resuming reopens the gate; the next prompt resumes the same native session.
    runtime.endDrain()
    expect(runtime.draining).toBeNull()
    controls.manual = false
    runtime.prompt(session.id, { text: 'after', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    expect(controls.adapters.at(-1)!.nativeSessionId).toBe('native-1')
    expect(ofType(events, session.id, 'turn.finished')[1].stopReason).toBe('end_turn')
  }, 40_000)

  it('counts a session start and a cancel in flight, and a change turn running under a drain still settles', async () => {
    const bridge = fakeBridge('poise-test:db')
    const { runtime, controls, events } = makeRuntime({ bridge })
    const creating = runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    expect(runtime.busy()).toBeGreaterThan(0)
    const session = await creating
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.busy()).toBe(1) // the idle agent process
    expect(await runtime.cancel(session.id)).toEqual({ settled: true })
    await runtime.close(session.id)
    await waitFor(() => runtime.busy() === 0)
    // A change turn that is running when the drain starts finishes, is
    // reported, and only then is its agent closed.
    const source = await sourceSession(runtime, events)
    controls.manual = true
    const changeId = randomUUID()
    const { session: change } = await runtime.startPoiseChange(source.id, 'drain me', changeId)
    await waitFor(() => lastStatus(events, change.id) === 'running')
    runtime.startDrain('rel-9')
    await waitFor(() => controls.adapters.at(-2)!.alive === false) // the source's idle agent
    expect(controls.adapters.at(-1)!.alive).toBe(true)
    controls.adapters.at(-1)!.finish()
    await waitFor(() => bridge.calls.some((c) => c.op === 'finish'))
    expect(bridge.calls.filter((c) => c.op === 'finish')[0]).toMatchObject({ changeId, input: { outcome: 'completed' } })
    await waitFor(() => runtime.busy() === 0)
    expect(controls.adapters.at(-1)!.alive).toBe(false)
    runtime.endDrain()
  }, 40_000)
})
