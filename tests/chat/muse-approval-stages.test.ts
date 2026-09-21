import { afterEach, describe, expect, it } from 'vitest'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import type { Adapter } from '../../server/chat/adapters/types'
import { createFakeHost, prompt, until, type FakeHost } from './adapter-harness'
const hosts: FakeHost[] = []
const adapters: Adapter[] = []
function setup() {
  const host = createFakeHost('fake-muse-approvals.mjs')
  const adapter = createMuseAdapter(host)
  hosts.push(host); adapters.push(adapter)
  return { host, adapter }
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close().catch(() => undefined)))
  hosts.splice(0).forEach(host => host.dispose())
})
const model = { modelId: 'muse-spark-1.3-contributor', effort: 'low', safeMode: true }
describe('Muse multi-stage approvals', () => {
  it.each(['stages', 'lost-update', 'stale-response'])('finishes all nine stages exactly once with %s', async scenario => {
    const { host, adapter } = setup()
    await adapter.start(model)
    const result = await adapter.prompt('t1', prompt(scenario), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(host.permissions).toHaveLength(9)
    expect(host.ofType('error')).toEqual([])
    expect(host.ofType('text.delta').map(e => e.delta).join('')).toContain('"decisions":[0,1,2,3,4,5,6,7,8]')
  })
  it.each(['delivery-failure', 'rejected-ack'])('surfaces %s and ends the worker instead of spinning forever', async scenario => {
    const { host, adapter } = setup()
    await adapter.start(model)
    const result = await adapter.prompt('t1', prompt(scenario), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(host.ofType('error').some(e => /approval delivery failed/.test(e.message))).toBe(true)
    await until(() => !adapter.alive)
  })
  it('cancels an obsolete approval when the native provider resolved it elsewhere', async () => {
    const { host, adapter } = setup()
    let aborted = false
    host.answerPermission = request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('superseded')) }, { once: true })
    })
    await adapter.start(model)
    const result = await adapter.prompt('t1', prompt('external'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(aborted).toBe(true)
    expect(host.ofType('error')).toEqual([])
    expect(host.ofType('text.delta').map(e => e.delta).join('')).toContain('"decisions":[]')
  })
})
