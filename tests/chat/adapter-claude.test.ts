// The Claude adapter against a stream-json fake of the CLI (fake-claude.mjs):
// the SDK is the real pinned one, the process is scripted. These cover the
// queue guarantees the runtime relies on — a Poise turn ends only when
// nothing native can still run for it — without a sign-in or a model.

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import type { Adapter } from '../../server/chat/adapters/types'
import type { TurnResult } from '../../server/chat/adapters/types'
import { createFakeHost, prompt, until, type FakeHost } from './adapter-harness'

const FAKE = 'fake-claude.mjs'
const MODEL = { modelId: 'claude-opus-5', effort: 'high' }

describe('Claude adapter', () => {
  const hosts: FakeHost[] = []
  const adapters: Adapter[] = []

  function setup(): { host: FakeHost, adapter: Adapter } {
    const host = createFakeHost(FAKE)
    const adapter = createClaudeAdapter(host, { exitGraceMs: 1_500, queueSettleMs: 800 })
    hosts.push(host)
    adapters.push(adapter)
    return { host, adapter }
  }

  function child(host: FakeHost) {
    return host.children[0]
  }

  function exited(host: FakeHost): boolean {
    const c = child(host)
    return !!c && (c.exitCode !== null || c.signalCode !== null)
  }

  /** Resolves with the time the fake's process exited. */
  function exitTime(host: FakeHost): Promise<number> {
    return new Promise((resolve) => {
      const c = child(host)
      if (!c) throw new Error('no child')
      if (c.exitCode !== null || c.signalCode !== null) resolve(Date.now())
      else c.once('exit', () => resolve(Date.now()))
    })
  }

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => {})))
    for (const host of hosts.splice(0)) host.dispose()
  })

  it('initializes through the SDK handshake and takes models, efforts and commands from it', async () => {
    const { host, adapter } = setup()
    const started = await adapter.start(MODEL)
    expect(host.spawns).toHaveLength(1)
    expect(host.spawns[0].command).toBe(process.execPath)
    expect(host.spawns[0].args.some((a) => a.endsWith('claude-subscription.mjs'))).toBe(true)
    expect(host.spawns[0].args).toContain('--input-format')
    expect(started.modelId).toBe('claude-opus-5')
    expect(started.effort).toBe('high')
    expect(started.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(started.commands?.map((c) => c.name)).toEqual(['compact', 'context'])
    expect(started.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(adapter.alive).toBe(true)
  })

  it('refuses an effort the CLI does not offer for the model', async () => {
    const { adapter } = setup()
    await expect(adapter.start({ modelId: 'claude-sonnet-5', effort: 'max' })).rejects.toThrow(/offers efforts low, medium, high for claude-sonnet-5, not max/)
  })

  it('runs a turn to its result and reports usage', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('t1', prompt('echo hi'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(host.ofType('text.delta').map((e) => e.delta).join('')).toBe('echo: hi')
    expect(adapter.alive).toBe(true)
  })

  it('keeps a steered turn open until the queued message ran as its own native turn', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    let settled: TurnResult | null = null
    const turn = adapter.prompt('t1', prompt('slow'), new AbortController().signal).then((r) => { settled = r; return r })
    await host.waitFor((e) => e.type === 'text.delta')
    await adapter.steer('echo second')
    // The first native result arrives with queued_turn_count 1; the Poise
    // turn must not settle on it.
    await until(() => host.ofType('text.delta').some((e) => e.delta === 'echo: second'))
    const result = await turn
    expect(settled).toBe(result)
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    const deltas = host.ofType('text.delta')
    expect(deltas.map((e) => e.delta)).toEqual(['working…', 'echo: second'])
    // The second native turn's text is a new message in the same turn.
    expect(new Set(deltas.map((e) => e.messageId)).size).toBe(2)
    expect(deltas.every((e) => e.turnId === 't1')).toBe(true)
    expect(adapter.alive).toBe(true)
  })

  it('keeps the turn open when the result reports no queue for a send still in flight (claude 2.1.274)', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const turn = adapter.prompt('t1', prompt('slow-zero'), new AbortController().signal)
    await host.waitFor((e) => e.type === 'text.delta')
    await adapter.steer('echo second')
    const result = await turn
    expect(result.stopReason).toBe('end_turn')
    expect(result.error).toBeUndefined()
    expect(host.ofType('text.delta').map((e) => e.delta)).toEqual(['working…', 'echo: second'])
    expect(adapter.alive).toBe(true)
  })

  it('ends the process when a send of the turn never runs', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const turn = adapter.prompt('t1', prompt('slow-drop'), new AbortController().signal)
    await host.waitFor((e) => e.type === 'text.delta')
    await adapter.steer('echo never')
    const result = await turn
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/did not run a message of this turn/)
    expect(exited(host)).toBe(true)
    expect(adapter.alive).toBe(false)
  })

  it('Stop ends the process and resolves only after the exit is verified', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    let settledAt = 0
    const turn = adapter.prompt('t1', prompt('slow'), new AbortController().signal).then((r) => { settledAt = Date.now(); return r })
    await host.waitFor((e) => e.type === 'text.delta')
    const exitedAt = exitTime(host)
    await adapter.steer('echo never runs')
    await adapter.cancel()
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    expect(result.terminate).toBeUndefined()
    expect(exited(host)).toBe(true)
    expect(settledAt).toBeGreaterThanOrEqual(await exitedAt)
    expect(adapter.alive).toBe(false)
    expect(host.ofType('text.delta').map((e) => e.delta)).toEqual(['working…'])
  })

  it('Stop waits for the verified exit even when the result frame precedes the interrupt receipt', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    let settledAt = 0
    const turn = adapter.prompt('t1', prompt('result-first'), new AbortController().signal).then((r) => { settledAt = Date.now(); return r })
    await host.waitFor((e) => e.type === 'text.delta')
    const exitedAt = exitTime(host)
    await adapter.cancel()
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    expect(exited(host)).toBe(true)
    expect(settledAt).toBeGreaterThanOrEqual(await exitedAt)
    expect(adapter.alive).toBe(false)
  })

  it('cancels through the abort signal the runtime hands the turn', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const abort = new AbortController()
    const turn = adapter.prompt('t1', prompt('slow'), abort.signal)
    await host.waitFor((e) => e.type === 'text.delta')
    abort.abort()
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    expect(exited(host)).toBe(true)
  })

  it('fails closed on a result that does not account for the queue', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    // An older producer names no consumed uuids: the prompt stays pending,
    // nothing follows, and the process is ended within the settle window.
    const result = await adapter.prompt('t1', prompt('old-cli'), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/did not run a message of this turn/)
    expect(exited(host)).toBe(true)
    expect(adapter.alive).toBe(false)
  })

  it('asks the runtime to terminate when the ended process does not exit in time', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const turn = adapter.prompt('t1', prompt('linger'), new AbortController().signal)
    await host.waitFor((e) => e.type === 'text.delta')
    await adapter.cancel()
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    expect(result.terminate).toBe(true)
    // The adapter never claims an exit it did not see.
    expect(exited(host)).toBe(false)
    expect(adapter.alive).toBe(true)
  })

  it('captures a Write pre-image through the PreToolUse hook and emits a revertible diff', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const path = join(host.checkout, 'notes.txt')
    writeFileSync(path, 'old content\n')
    const result = await adapter.prompt('t1', prompt(`write ${path}`), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(host.permissions).toHaveLength(1)
    expect(host.permissions[0].title).toBe(`Write ${path}`)
    const diffs = host.ofType('diff')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ path, oldText: 'old content\n', newText: 'new content\n', oldExists: true, newExists: true })
    expect(diffs[0].unified).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('new content\n')
    expect(host.ofType('tool.finished')[0]).toMatchObject({ id: expect.stringMatching(/^toolu-/), status: 'completed' })
  })

  it('records a created file as new only when the pre-image read said it did not exist', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const path = join(host.checkout, 'fresh.txt')
    await adapter.prompt('t1', prompt(`write ${path}`), new AbortController().signal)
    const diffs = host.ofType('diff')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ path, oldText: '', newText: 'new content\n', oldExists: false, newExists: true })
  })

  it('denies a tool the user rejected without ending the turn', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    host.answerPermission = (request) => request.options.find((o) => o.kind === 'reject_once')!.id
    const path = join(host.checkout, 'kept.txt')
    writeFileSync(path, 'kept\n')
    const result = await adapter.prompt('t1', prompt(`write ${path}`), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(readFileSync(path, 'utf8')).toBe('kept\n')
    expect(host.ofType('diff')).toHaveLength(0)
    expect(host.ofType('tool.finished')[0]).toMatchObject({ status: 'failed' })
  })
})
