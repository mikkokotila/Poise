// The Grok adapter against recorded live ACP traces (grok 1.0.34), replayed
// by fake-grok.mjs: the frames are the real binary's, the process is not.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createGrokAdapter, GROK_ARGS } from '../../server/chat/adapters/grok'
import { assertRequiredCapabilities, type Adapter } from '../../server/chat/adapters/types'
import { FIXTURES, createFakeHost, prompt, until, sleep, type FakeHost } from './adapter-harness'

const MODEL = { modelId: 'grok-4.6', effort: 'high' }

describe('Grok adapter (recorded traces)', () => {
  const hosts: FakeHost[] = []
  const adapters: Adapter[] = []

  function setup(trace: string): { host: FakeHost, adapter: Adapter } {
    const host = createFakeHost('fake-grok.mjs', ['--replay', join(FIXTURES, trace)])
    const adapter = createGrokAdapter(host)
    hosts.push(host)
    adapters.push(adapter)
    return { host, adapter }
  }

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => {})))
    for (const host of hosts.splice(0)) host.dispose()
  })

  it('launches without the terminal capability and maps a permission request to a card', async () => {
    const { host, adapter } = setup('grok-permission.trace.json')
    const started = await adapter.start(MODEL)
    expect(host.spawns).toEqual([{ command: 'grok', args: [...GROK_ARGS] }])
    expect(started.nativeSessionId).toBe('01a0b4a1-679d-7ed2-ac8d-ffbc9be27599')
    expect(started.modelId).toBe('grok-4.6')
    expect(() => assertRequiredCapabilities('grok', adapter.capabilities)).not.toThrow()
    expect(adapter.capabilities).toMatchObject({ steer: true, fork: true, permissions: true, questions: true, resume: true, images: false, modes: false })
    expect(started.commands?.length).toBeGreaterThan(0)

    host.answerPermission = (request) => request.options.find((o) => o.kind === 'reject_once')!.id
    const result = await adapter.prompt('t1', prompt('Run the shell command `rm -f probe-dir/marker.txt` and report whether it succeeded.'), new AbortController().signal)
    expect(result.stopReason).toBe('cancelled')
    expect(host.permissions).toHaveLength(1)
    expect(host.permissions[0].title).toContain('rm -f probe-dir/marker.txt')
    expect(host.permissions[0].options.map((o) => o.kind).sort()).toEqual(['allow_always', 'allow_once', 'reject_always', 'reject_once'])
    const tool = host.ofType('tool.started')[0]
    expect(tool).toMatchObject({ kind: 'execute' })
    expect(host.ofType('tool.finished').find((e) => e.id === tool.id)).toMatchObject({ status: 'failed' })
    expect(host.ofType('thought.delta').map((e) => e.delta).join('')).toContain('remove a file')
  })

  it('routes an ask_user_question to the question card, steers through _x.ai/interject, and reports fork parameters', async () => {
    const { host, adapter } = setup('grok-question-steer-fork.trace.json')
    await adapter.start(MODEL)
    host.answerQuestion = (request) => ({ [request.questions[0].id]: ['A', 'B'] })
    const first = await adapter.prompt('t1', prompt('Use your ask_user_question tool…'), new AbortController().signal)
    expect(first.stopReason).toBe('end_turn')
    expect(host.questions).toHaveLength(1)
    expect(host.questions[0].questions[0]).toMatchObject({ question: 'Which letters?', multiSelect: true })
    expect(host.questions[0].questions[0].options.map((o) => o.label)).toEqual(['A', 'B', 'C'])
    expect(host.ofType('text.delta').filter((e) => e.turnId === 't1').map((e) => e.delta).join('')).toContain('A, B')

    const second = adapter.prompt('t2', prompt('Count from 1 to 40, one number per line, then say FINISHED.'), new AbortController().signal)
    // The recording interjected before the first token; the replay serves
    // the turn's frames behind the interject, as the live session did.
    await adapter.steer('Interjection: stop counting immediately and reply only with the word STEERED.')
    const result = await second
    expect(result.stopReason).toBe('end_turn')
    const text = host.ofType('text.delta').filter((e) => e.turnId === 't2').map((e) => e.delta).join('')
    expect(text).toContain('FINISHED')
    expect(text.endsWith('STEERED')).toBe(true)
  })

  it('serves fs requests inside the checkout, records the write as a diff, cancels within the turn, and resumes by id', async () => {
    const { host, adapter } = setup('grok-session-resume.trace.json')
    const started = await adapter.start(MODEL)
    const result = await adapter.prompt('t1', prompt('Create a file named hello2.txt…'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    // The recorded fs/read_text_file names a path inside the recorded
    // checkout, which is outside this test's: the read is refused, the
    // agent's write goes nowhere, and the transcript still carries the diff.
    // The in-progress update carried an empty pre-image (Grok had not read
    // the file yet); only the completing update's diff — with the real
    // pre-image — is recorded, so Revert can never truncate the file.
    expect(host.ofType('diff')).toHaveLength(1)
    expect(host.ofType('diff')[0]).toMatchObject({ toolId: expect.stringMatching(/^call-/), oldText: 'fixture file content\n', oldExists: true, newText: expect.stringContaining('hello') })
    expect(host.ofType('tool.finished')).toHaveLength(1)

    const cancelled = adapter.prompt('t2', prompt('Count slowly from 1 to 200, one number per line.'), new AbortController().signal)
    await adapter.cancel()
    expect((await cancelled).stopReason).toBe('cancelled')

    // A second process resumes the same native session and gets its models back.
    const resumed = createGrokAdapter(host)
    adapters.push(resumed)
    const again = await resumed.start({ ...MODEL, resume: started.nativeSessionId })
    expect(again.nativeSessionId).toBe(started.nativeSessionId)
    expect(again.modelId).toBe('grok-4.6')
    expect(host.spawns).toHaveLength(2)
  })
})

it.each([false, true])('QC2: Grok orders early steering behind file preparation and releases it on Stop (stop=%s)', async stopping => {
  const host = createFakeHost('queue-agent.mjs')
  const adapter = createGrokAdapter(host)
  const files = await import('../../server/chat/client-fs')
  let release!: () => void; let readStarted = false
  const read = new Promise<string>(resolve => { release = () => resolve('Mention context') })
  const spy = vi.spyOn(files, 'readCheckoutTextFile').mockImplementation(async () => { readStarted = true; return read })
  try {
    await adapter.start(MODEL)
    const response = adapter.prompt('early-steer', { ...prompt('QC steering task'), mentions: [{ path: 'README.md' }] }, new AbortController().signal)
    void response.catch(() => undefined)
    await until(() => readStarted)
    let delivered = false
    const steer = adapter.steer('Use the additional context').then(() => { delivered = true })
    void steer.catch(() => undefined)
    await sleep(40); expect(delivered).toBe(false)
    if (stopping) {
      await adapter.cancel()
      await expect(steer).rejects.toThrow(/turn ended/)
      expect(delivered).toBe(false)
      release()
      await expect(response).resolves.toMatchObject({ stopReason: 'cancelled' })
    } else {
      release(); await steer
      await expect(response).resolves.toMatchObject({ stopReason: 'end_turn' })
    }
  } finally { release(); spy.mockRestore(); await adapter.close(); host.dispose() }
})
