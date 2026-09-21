import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMuseAdapter, uuidv7 } from '../../server/chat/adapters/muse'
import { AdapterError, assertRequiredCapabilities } from '../../server/chat/adapters/types'
import type { Adapter } from '../../server/chat/adapters/types'
import { FIXTURES, createFakeHost, prompt, sleep, until, type FakeHost } from './adapter-harness'

const FAKE = 'fake-muse.mjs'
const MODEL = { modelId: 'muse-spark-1.3-contributor', effort: 'low' }
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

describe('Muse adapter', () => {
  const hosts: FakeHost[] = []
  const adapters: Adapter[] = []

  function setup(extraArgs: string[] = []): { host: FakeHost, adapter: Adapter } {
    const host = createFakeHost(FAKE, extraArgs)
    const adapter = createMuseAdapter(host)
    hosts.push(host)
    adapters.push(adapter)
    return { host, adapter }
  }

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => {})))
    for (const host of hosts.splice(0)) host.dispose()
  })

  it('mints RFC 9562 version-7 ids ordered by time', () => {
    const first = uuidv7(1_700_000_000_000)
    const second = uuidv7(1_700_000_000_001)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first < second).toBe(true)
    expect(first.slice(0, 12)).toBe(second.slice(0, 12))
    expect(uuidv7()).not.toBe(uuidv7())
  })

  it('launches muse serve, announces dialog support and advertises its capabilities', async () => {
    const { host, adapter } = setup(['--require-dialogs'])
    const result = await adapter.start(MODEL)
    expect(host.spawns).toEqual([{ command: 'muse', args: ['serve', '--disable-sandbox', '--trust-workspace'] }])
    expect(adapter.capabilities).toEqual({ steer: true, fork: true, thought: true, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false })
    expect(() => assertRequiredCapabilities('muse', adapter.capabilities)).not.toThrow()
    expect(result.nativeSessionId).toMatch(/^session-/)
    expect(result).toMatchObject({ modelId: 'muse-spark-1.3-contributor', effort: 'low', efforts: EFFORTS })
    // model.updated from session/reasoningEffortChanged during start.
    expect(host.ofType('model.updated').at(-1)).toMatchObject({ modelId: 'muse-spark-1.3-contributor', effort: 'low' })
    // --require-dialogs makes the fake fail any turn from a client that did not opt in.
    const turn = await adapter.prompt('turn-1', prompt('fail'), new AbortController().signal)
    expect(turn.error).toBe('Muse: provider returned 503')
  })

  it('rejects a model Muse does not list, naming the agent', async () => {
    const { adapter } = setup()
    await expect(adapter.start({ modelId: 'muse-nope', effort: 'low' })).rejects.toMatchObject({ name: 'AdapterError', agent: 'muse', code: 'start_failed' })
    await expect(createMuseAdapter(createFakeHost(FAKE)).start({ modelId: 'muse-nope', effort: 'low' })).rejects.toThrow(/Muse does not offer model "muse-nope"/)
  })

  it('translates a full scripted turn into transcript events', async () => {
    const { host, adapter } = setup()
    host.answerPermission = () => 'allow_once'
    host.answerQuestion = () => ({ letter: 'B', toppings: ['olives', 'anchovies'] })
    writeFileSync(join(host.checkout, 'README.md'), 'old\n')
    writeFileSync(join(host.checkout, 'GONE.md'), 'bye\n')
    writeFileSync(join(host.checkout, 'BIG.md'), 'big\n')
    const readTextFile = host.readTextFile
    host.readTextFile = (path, options) => path.endsWith('BIG.md') ? Promise.reject(new Error('file too large (limit 2 MB)')) : readTextFile(path, options)
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    expect(result).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } })
    for (const event of host.events) expect((event as { turnId?: string }).turnId ?? 'turn-1').toBe('turn-1')

    // Reminder children are native housekeeping, not user-facing tool work.
    expect(JSON.stringify(host.events)).not.toContain('Reminder child session')
    expect(JSON.stringify(host.events)).not.toContain('reminder-internal-output')

    expect(host.ofType('thought.delta')).toEqual([{ type: 'thought.delta', turnId: 'turn-1', messageId: expect.stringMatching(/^reasoning-/), delta: 'thinking…' }])

    // bash: approval with kinds derived from decision/scope, streamed output, terminal result.
    expect(host.permissions[0]).toMatchObject({
      toolId: expect.stringMatching(/^approval-/),
      title: 'rm -f marker.txt',
      input: { tool: 'bash', args: { command: 'rm -f marker.txt' } },
      options: [
        { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { id: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
        { id: 'allow_local_prefix', name: 'Always allow in this workspace: rm ...', kind: 'allow_always' },
        { id: 'abort', name: 'Reject', kind: 'reject_once' },
        { id: 'deny_local_prefix', name: 'Always reject in this workspace', kind: 'reject_always' },
      ],
    })
    const bash = host.ofType('tool.started').find((event) => event.kind === 'execute')!
    expect(bash).toMatchObject({ id: host.permissions[0].toolId, title: 'rm -f marker.txt', input: { command: 'rm -f marker.txt', description: 'Remove marker' } })
    expect(host.ofType('tool.updated').find((event) => event.id === bash.id)).toMatchObject({ status: 'running', content: [{ type: 'terminal', text: 'removed marker\n' }] })
    expect(host.ofType('tool.finished').find((event) => event.id === bash.id)).toMatchObject({ status: 'completed', content: [{ type: 'terminal', text: 'removed marker\n', exitCode: 0 }] })
    const text = host.ofType('text.delta').map((event) => event.delta)
    expect(text).toContain('decided:allow_once requirement:0')

    // Edit-family tools: a full-contents diff per touched path only when the
    // pre-image is exact — read while the edit waited for its approval. A
    // write applied without an approval round-trip gets no diff (there was
    // no moment before it to capture), nor does a file that could not be
    // read; both keep the patch summary and log why.
    const edits = host.ofType('tool.started').filter((event) => event.kind === 'edit')
    expect(edits.map((event) => event.title)).toEqual(['edit README.md', 'write NEW.md', 'patch GONE.md', 'edit BIG.md'])
    expect(edits[0]).toMatchObject({ locations: [{ path: 'README.md' }] })
    expect(host.permissions.filter((request) => request.title.startsWith('edit ') || request.title.startsWith('patch ')).map((request) => request.title)).toEqual(['edit README.md', 'patch GONE.md', 'edit BIG.md'])
    expect(readFileSync(join(host.checkout, 'README.md'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(host.checkout, 'NEW.md'), 'utf8')).toBe('hello\n')
    expect(host.ofType('diff')).toEqual([
      { type: 'diff', turnId: 'turn-1', toolId: edits[0].id, diffId: expect.stringMatching(/^[0-9a-f-]{36}$/), path: 'README.md', oldText: 'old\n', newText: 'new\n', oldExists: true, newExists: true },
      { type: 'diff', turnId: 'turn-1', toolId: edits[2].id, diffId: expect.any(String), path: 'GONE.md', oldText: 'bye\n', newText: '', oldExists: true, newExists: false },
    ])
    expect(host.logs.some((line) => line.includes('no reversible diff recorded for NEW.md') && line.includes('without an approval round-trip'))).toBe(true)
    expect(host.logs.some((line) => line.includes('no reversible diff recorded for BIG.md') && line.includes('file too large'))).toBe(true)
    expect(host.ofType('tool.finished').find((event) => event.id === edits[0].id)).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '1 file(s) changed, +1 −1' }] })
    expect(host.ofType('tool.finished').find((event) => event.id === edits[1].id)).toMatchObject({ status: 'completed' })
    expect(host.ofType('tool.finished').find((event) => event.id === edits[3].id)).toMatchObject({ status: 'completed', content: [{ type: 'text', text: '1 file(s) changed, +1 −1' }] })
    for (const [index, edit] of [edits[0], edits[2]].entries()) {
      const diff = host.ofType('diff')[index]
      expect(host.events.indexOf(diff)).toBeLessThan(host.events.indexOf(host.ofType('tool.finished').find((event) => event.id === edit.id)!))
    }

    // Question: single and multi select; answers off the option list are dropped.
    expect(host.questions[0]).toMatchObject({
      toolId: expect.stringMatching(/^input-/),
      questions: [
        { id: 'letter', header: 'Letter', question: 'Which letter?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, freeText: false },
        { id: 'toppings', header: 'Toppings', question: 'Which toppings?', options: [{ label: 'cheese' }, { label: 'olives' }], multiSelect: true, freeText: false },
      ],
    })
    expect(text).toContain('answers:[{"questionId":"letter","selectedLabel":"B"},{"questionId":"toppings","selectedLabels":["olives"]}] answered:1')
    const question = host.ofType('tool.started').find((event) => event.title === 'request_user_input')!
    expect(question.kind).toBe('other')
    expect(host.ofType('tool.finished').find((event) => event.id === question.id)).toMatchObject({ status: 'completed' })

    // Every started tool finished, including the subagent Muse never closed.
    const started = host.ofType('tool.started').map((event) => event.id)
    const finished = host.ofType('tool.finished').map((event) => event.id)
    expect(finished.sort()).toEqual([...started].sort())
    expect(host.ofType('tool.started').find((event) => event.title === 'never finishes')).toMatchObject({ kind: 'other' })

    const count = host.events.length
    await sleep(100)
    expect(host.events.length).toBe(count)
  })

  it('sends the once-only approval when the user picks an allow-always option', async () => {
    const { host, adapter } = setup()
    host.answerPermission = () => 'allow_local_prefix'
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    const text = host.ofType('text.delta').map((event) => event.delta)
    expect(text).toContain('decided:allow_once requirement:0')
    expect(text.some((delta) => delta.includes('allow_local_prefix'))).toBe(false)
  })

  it('rejects on the wire when the host rejects the permission, and cancels the question', async () => {
    const { host, adapter } = setup()
    host.answerPermission = () => { throw new Error('turn cancelled') }
    host.answerQuestion = () => { throw new Error('turn cancelled') }
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    const text = host.ofType('text.delta').map((event) => event.delta)
    expect(text).toContain('decided:abort requirement:0')
    expect(host.ofType('tool.finished').find((event) => event.id === host.permissions[0].toolId)).toMatchObject({ status: 'cancelled', content: [{ type: 'text', text: 'rejected by user' }] })
    expect(text.some((delta) => delta.startsWith('answers:null answered:1'))).toBe(true)
  })

  it('answers each request exactly once when both the request and the notification arrive', async () => {
    const { host, adapter } = setup(['--require-dialogs'])
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    // The shell approval arrives as both a request and a notification; it
    // is asked once. (The edit approvals are notification-only.)
    expect(host.permissions.filter((request) => request.title === 'rm -f marker.txt')).toHaveLength(1)
    expect(host.permissions).toHaveLength(4)
    expect(host.questions).toHaveLength(1)
    expect(host.ofType('text.delta').some((event) => event.delta.endsWith('answered:1'))).toBe(true)
    expect(host.logs.some((line) => line.includes('already settled') || line.includes('already resolved'))).toBe(false)
  })

  it('cancels a running turn within two seconds', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const turn = adapter.prompt('turn-1', prompt('slow'), new AbortController().signal)
    await host.waitFor((event) => event.type === 'text.delta')
    const started = Date.now()
    await adapter.cancel()
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(adapter.alive).toBe(true)
  })

  it('treats an aborted signal like cancel', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const controller = new AbortController()
    const turn = adapter.prompt('turn-1', prompt('slow'), controller.signal)
    await host.waitFor((event) => event.type === 'text.delta')
    controller.abort()
    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('steers the running turn and keeps the Poise turn open until the steered native turn ran', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await expect(adapter.steer('too early')).rejects.toBeInstanceOf(AdapterError)
    const turn = adapter.prompt('turn-1', prompt('steer'), new AbortController().signal)
    await host.waitFor((event) => event.type === 'text.delta')
    await adapter.steer('go left')
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
    // Muse completes the first native turn and runs the steer as a second
    // one; both belong to turn-1 and the result arrives after the second.
    const steered = host.ofType('text.delta').find((event) => event.delta === 'steered: go left')
    expect(steered).toMatchObject({ turnId: 'turn-1' })
    expect(adapter.alive).toBe(true)
  })

  it('ends the process when a steered message never starts its native turn', async () => {
    const host = createFakeHost(FAKE, ['--drop-steer'])
    const adapter = createMuseAdapter(host, { steerSettleMs: 500 })
    hosts.push(host)
    adapters.push(adapter)
    await adapter.start(MODEL)
    const turn = adapter.prompt('turn-1', prompt('steer'), new AbortController().signal)
    await host.waitFor((event) => event.type === 'text.delta')
    await adapter.steer('go left')
    const result = await turn
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/did not run a steered message/)
    await until(() => !adapter.alive)
  })

  it('reclaims queued steering before a cancelled foreground turn can release the checkout', async () => {
    const { host, adapter } = setup(['--hold-after-steer'])
    await adapter.start(MODEL)
    const pending = adapter.prompt('turn-1', prompt('steer'), new AbortController().signal)
    await host.waitFor(event => event.type === 'text.delta')
    await adapter.steer('must not execute')
    await adapter.cancel()
    expect(await pending).toMatchObject({ stopReason: 'cancelled' })
    await sleep(60)
    expect(host.ofType('text.delta').map(event => event.delta).join('')).not.toContain('steered:')
    await expect(adapter.steer('too late')).rejects.toBeInstanceOf(AdapterError)
  })

  it('keeps the Poise turn open when queue reclaim loses to launch, and interrupts the new native turn', async () => {
    const { host, adapter } = setup(['--hold-after-steer', '--reclaim-race'])
    await adapter.start(MODEL)
    const pending = adapter.prompt('turn-1', prompt('steer'), new AbortController().signal)
    await host.waitFor(event => event.type === 'text.delta')
    await adapter.steer('must be stopped')
    await adapter.cancel()
    expect(await pending).toMatchObject({ stopReason: 'cancelled' })
    expect(host.ofType('text.delta').map(event => event.delta).join('')).toContain('queued turn stopped')
    expect(host.ofType('text.delta').map(event => event.delta).join('')).not.toContain('queued turn escaped')
  })

  it('requires verified worker termination when closing an active protocol session', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const pending = adapter.prompt('turn-1', prompt('slow'), new AbortController().signal)
    await host.waitFor(event => event.type === 'text.delta')
    const closing = adapter.close()
    expect(await pending).toMatchObject({ stopReason: 'cancelled', terminate: true })
    await closing
    expect(adapter.alive).toBe(false)
  })

  it('rejects unsupported effort before changing the native model', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await expect(adapter.setModel('muse-spark-1.3', 'made-up-effort')).rejects.toThrow('does not support reasoning effort')
    expect(host.ofType('model.updated').at(-1)).toMatchObject({ modelId: MODEL.modelId, effort: MODEL.effort })
  })

  it('resolves the turn with an error naming Muse when the process dies', async () => {
    const { adapter } = setup()
    await adapter.start(MODEL)
    const exits: Array<number | null> = []
    adapter.onExit((code) => exits.push(code))
    const result = await adapter.prompt('turn-1', prompt('exit'), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/^Muse exited \(2\)/)
    expect(result.error).toContain('simulated crash')
    await until(() => exits.length === 1)
    expect(exits).toEqual([2])
    expect(adapter.alive).toBe(false)
  })

  it('reports a failed turn with the Muse error message', async () => {
    const { adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('fail'), new AbortController().signal)
    expect(result).toEqual({ stopReason: 'error', error: 'Muse: provider returned 503' })
  })

  it('answers an unknown server request with a JSON-RPC error instead of hanging', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('unknown-request'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(host.ofType('text.delta').map((event) => event.delta).join('')).toBe('unknown:-32601')
    expect(host.logs.some((line) => line.includes('session/nonexistent'))).toBe(true)
  })

  it('drops malformed frames without failing the turn', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('malformed'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(host.ofType('text.delta').map((event) => event.delta).join('')).toBe('survived')
    expect(host.logs.filter((line) => line.includes('not JSON-RPC'))).toHaveLength(1)
    expect(adapter.alive).toBe(true)
  })

  it('switches model and effort on the session and refuses modes', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await expect(adapter.setModel('muse-spark-1.3', 'high')).resolves.toEqual({ modelId: 'muse-spark-1.3', effort: 'high', efforts: EFFORTS })
    expect(host.ofType('model.updated').at(-1)).toMatchObject({ modelId: 'muse-spark-1.3', effort: 'high' })
    await expect(adapter.setModel('muse-none', 'high')).rejects.toThrow(/Muse does not offer model "muse-none"/)
    await expect(adapter.setMode('plan')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('folds mentions and attachments into the text part and passes the effort', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', {
      text: 'echo-input',
      attachments: [
        { id: 'a1', name: 'notes.txt', path: 'uploads/notes.txt', size: 5, text: 'hello' },
        { id: 'a2', name: 'photo.png', path: 'uploads/photo.png', size: 1024 },
        { id: 'a3', name: 'evil.png', path: '../outside.png', size: 1 },
      ],
      mentions: [{ path: 'src/index.ts' }],
    }, new AbortController().signal)
    const echoed = JSON.parse(host.ofType('text.delta')[0].delta)
    expect(echoed.effort).toBe('low')
    expect(echoed.input).toEqual([{
      type: 'text',
      text: `echo-input\n\nnotes.txt (uploads/notes.txt):\n\`\`\`\nhello\n\`\`\`\n\nReferenced files:\n- ${join(host.checkout, 'uploads/photo.png')}\n- ${join(host.checkout, 'src/index.ts')}`,
    }])
    expect(host.logs.filter((line) => line.includes('outside the checkout'))).toHaveLength(1)
  })

  it('resumes and forks sessions by id', async () => {
    const resumed = setup()
    const start = await resumed.adapter.start({ ...MODEL, resume: 'session-existing' })
    expect(start.nativeSessionId).toBe('session-existing')
    // The resumed session ran a different model; the adapter switched it.
    expect(resumed.host.ofType('model.updated').some((event) => event.modelId === 'muse-spark-1.3-contributor')).toBe(true)
    const forkId = await resumed.adapter.fork()
    expect(forkId).toMatch(/^fork-/)
    expect(resumed.adapter.nativeSessionId).toBe('session-existing')

    const forked = setup()
    const forkStart = await forked.adapter.start({ ...MODEL, forkFrom: 'session-existing' })
    expect(forkStart.nativeSessionId).toMatch(/^fork-/)
  })

  it('logs ignored notifications once and closes cleanly', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('fail'), new AbortController().signal)
    await adapter.prompt('turn-2', prompt('fail'), new AbortController().signal)
    expect(host.logs.filter((line) => line.includes('ignoring session/branchChanged'))).toHaveLength(1)
    expect(host.logs.filter((line) => line.includes('no handler for session/started'))).toHaveLength(1)
    const exited = new Promise<void>((resolve) => adapter.onExit(() => resolve()))
    await adapter.close()
    await exited
    expect(adapter.alive).toBe(false)
  })

  it('replays the recorded live session: approval, tool output, interrupt', async () => {
    const { host, adapter } = setup(['--replay', join(FIXTURES, 'muse-session.trace.json')])
    host.answerPermission = () => 'allow_local_prefix'
    const start = await adapter.start({ modelId: 'muse-spark-1.3-contributor', effort: 'low' })
    expect(start.nativeSessionId).toBe('01a0b4a9-cf48-7a92-84ef-d9af8b6bca85')

    const first = await adapter.prompt('turn-1', prompt('Run the shell command `rm -f probe-dir/marker.txt`.'), new AbortController().signal)
    expect(first.stopReason).toBe('end_turn')
    expect(first.usage).toEqual({ inputTokens: 20650, outputTokens: 49, totalTokens: 20699 })
    expect(host.permissions).toHaveLength(1)
    expect(host.permissions[0]).toMatchObject({
      title: 'rm -f probe-dir/marker.txt',
      options: [
        { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { id: 'allow_local_prefix', name: 'Always allow in this workspace: rm ...', kind: 'allow_always' },
        { id: 'abort', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const bash = host.ofType('tool.started').find((event) => event.kind === 'execute')!
    expect(bash).toMatchObject({ id: '01a0b4a9-e2ad-7ab2-91ae-65ea5b562afc', title: 'rm -f probe-dir/marker.txt' })
    expect(host.ofType('tool.finished').find((event) => event.id === bash.id)).toMatchObject({ status: 'completed', content: [{ type: 'terminal', text: '', exitCode: 0 }] })
    expect(host.ofType('text.delta')).toEqual([{ type: 'text.delta', turnId: 'turn-1', messageId: '8dcafdc6-38a2-47bb-943b-b4f8ee066289', delta: 'done' }])

    // Synchronize with the native protocol, not a reminder card that should
    // never have been part of the visible transcript.
    let nativeOutput = ''
    const observe = (chunk: Buffer) => { nativeOutput += chunk.toString() }
    host.children[0].stdout!.on('data', observe)
    const second = adapter.prompt('turn-2', prompt('Count from 1 to 100, one number per line.'), new AbortController().signal)
    try {
      await until(() => nativeOutput.includes('"method":"turn/started"'))
      await adapter.cancel()
      await expect(second).resolves.toMatchObject({ stopReason: 'cancelled' })
    } finally { host.children[0].stdout!.off('data', observe) }
    expect(host.ofType('tool.finished').filter((event) => event.turnId === 'turn-2')).toHaveLength(0)
    expect(JSON.stringify(host.events)).not.toContain('Reminder child session')
  })
})
