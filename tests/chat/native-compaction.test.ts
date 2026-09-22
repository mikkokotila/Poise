import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import { createCodexAdapter } from '../../server/chat/adapters/codex'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import type { Adapter } from '../../server/chat/adapters/types'
import { createFakeHost, until, sleep, type FakeHost } from './adapter-harness'
const cases = [
  { agent: 'claude', script: 'fake-claude.mjs', modelId: 'claude-opus-5', factory: createClaudeAdapter },
  { agent: 'codex', script: 'fake-codex.mjs', modelId: 'gpt-6-astra', factory: createCodexAdapter },
  { agent: 'grok', script: 'fake-compact-grok.mjs', modelId: 'grok-4.6', factory: createGrokAdapter },
  { agent: 'muse', script: 'fake-muse.mjs', modelId: 'muse-spark-1.3-contributor', factory: createMuseAdapter },
] as const
const hosts: FakeHost[] = [], adapters: Adapter[] = []
afterEach(async () => { await Promise.all(adapters.splice(0).map(a => a.close())); for (const h of hosts.splice(0)) h.dispose() })
async function setup(test: typeof cases[number], flags: string[] = [], timeout = 5000) {
  const host = createFakeHost(test.script, flags); hosts.push(host)
  const adapter = test.factory(host, { compactTimeoutMs: timeout }); adapters.push(adapter)
  await adapter.start({ modelId: test.modelId, effort: 'high', ...(test.agent === 'claude' ? { resume: 'a1b2c3d4-0000-4000-8000-000000000001' } : {}) })
  return { host, adapter }
}

for (const c of cases) {
  it(`compact: ${c.agent} waits for actual native completion and preserves its session`, async () => {
    const { host, adapter } = await setup(c, ['--compact-gated'])
    const native = adapter.nativeSessionId
    let finished = false
    const result = adapter.compact!('compact-1', 'Keep important decisions.', new AbortController().signal).then(r => { finished = true; return r })
    await until(() => existsSync(join(host.checkout, c.agent === 'codex' || c.agent === 'muse' ? 'compact-admitted' : 'compact-input')))
    expect(finished).toBe(false)
    writeFileSync(join(host.checkout, 'compact-release'), 'go')
    expect(await result).toMatchObject({ stopReason: 'end_turn', compaction: { changed: true } })
    expect(adapter.nativeSessionId).toBe(native)
    if (c.agent === 'grok' || c.agent === 'claude') {
      const sent = readFileSync(join(host.checkout, 'compact-input'), 'utf8')
      expect(sent.startsWith('/compact')).toBe(true)
      expect(sent.endsWith('[Memories]\nKeep important decisions.')).toBe(true)
    }
  })
  it(`compact: ${c.agent} reports a native summarizer failure`, async () => {
    const { adapter } = await setup(c, ['--compact-fail'])
    expect(await adapter.compact!('compact-failed', '', new AbortController().signal)).toMatchObject({ stopReason: 'error', error: expect.stringMatching(/summarizer/i) })
  })
  it(`compact: ${c.agent} Stop settles and asks the runtime to verify process termination`, async () => {
    const { adapter } = await setup(c, ['--compact-hold'])
    const controller = new AbortController()
    const result = adapter.compact!('compact-cancelled', '', controller.signal)
    await sleep(30); controller.abort()
    expect(await result).toMatchObject({ stopReason: 'cancelled', terminate: true })
  })
}

for (const c of cases.filter(c => c.agent === 'codex' || c.agent === 'muse')) {
  it(`compact: ${c.agent} accepts terminal events that arrive before the admission response`, async () => {
    const { adapter } = await setup(c, ['--compact-before-ack'])
    expect(await adapter.compact!('before-ack', '', new AbortController().signal)).toMatchObject({ stopReason: 'end_turn', compaction: { changed: true } })
  })
  it(`compact: ${c.agent} bounds a missing terminal event instead of reporting a false success`, async () => {
    const { adapter } = await setup(c, ['--compact-hold'], 200)
    expect(await adapter.compact!('timeout', '', new AbortController().signal)).toMatchObject({ stopReason: 'error', terminate: true })
  })
}
for (const c of cases.filter(c => c.agent === 'muse' || c.agent === 'claude')) {
  it(`compact: ${c.agent} distinguishes no-op from a new compaction`, async () => {
    const { adapter } = await setup(c, ['--compact-noop'])
    expect(await adapter.compact!('noop', '', new AbortController().signal)).toMatchObject({ stopReason: 'end_turn', compaction: { changed: false } })
  })
}
