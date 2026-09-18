import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexAdapter, reverseUnifiedDiff } from '../../server/chat/adapters/codex'
import { AdapterError, assertRequiredCapabilities } from '../../server/chat/adapters/types'
import type { Adapter } from '../../server/chat/adapters/types'
import { CHAT_LIMITS } from '../../server/chat/protocol'
import type { ChatEvent } from '../../server/chat/protocol'
import { FIXTURES, createFakeHost, prompt, sleep, until, type FakeHost } from './adapter-harness'

const FAKE = 'fake-codex.mjs'
const MODEL = { modelId: 'gpt-6-astra', effort: 'high' }

describe('reverseUnifiedDiff', () => {
  it('rebuilds the pre-image from the post-image and the diff', () => {
    expect(reverseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n', 'a\nB\nc\n')).toBe('a\nb\nc\n')
    expect(reverseUnifiedDiff('@@ -2,2 +2,3 @@\n two\n+two and a half\n three\n', 'one\ntwo\ntwo and a half\nthree\nfour\n')).toBe('one\ntwo\nthree\nfour\n')
    expect(reverseUnifiedDiff('@@ -1,2 +1 @@\n-gone\n keep\n@@ -5 +4,2 @@\n last\n+added\n', 'keep\nx\ny\nlast\nadded\n')).toBe('gone\nkeep\nx\ny\nlast\n')
  })

  it('handles created and deleted files and missing trailing newlines', () => {
    expect(reverseUnifiedDiff('--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n', 'a\nb\n')).toBe('')
    expect(reverseUnifiedDiff('--- a/g\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n', '')).toBe('a\nb\n')
    expect(reverseUnifiedDiff('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n', 'new\n')).toBe('old')
    expect(reverseUnifiedDiff('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n', 'new')).toBe('old\n')
  })

  it('refuses a diff that does not fit the file', () => {
    expect(reverseUnifiedDiff('@@ -1 +1 @@\n-weird\n+odd\n', 'strange\n')).toBeNull()
    expect(reverseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c\n', 'x\nc\n')).toBeNull()
    expect(reverseUnifiedDiff('not a diff', 'x')).toBeNull()
    expect(reverseUnifiedDiff('@@ -9 +9 @@\n-a\n+b\n', 'b\n')).toBeNull()
  })
})

describe('Codex adapter', () => {
  const hosts: FakeHost[] = []
  const adapters: Adapter[] = []

  function setup(extraArgs: string[] = []): { host: FakeHost, adapter: Adapter } {
    const host = createFakeHost(FAKE, extraArgs)
    const adapter = createCodexAdapter(host)
    hosts.push(host)
    adapters.push(adapter)
    return { host, adapter }
  }

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => {})))
    for (const host of hosts.splice(0)) host.dispose()
  })

  it('launches app-server on stdio and advertises its capabilities', async () => {
    const { host, adapter } = setup()
    const result = await adapter.start(MODEL)
    expect(host.spawns).toEqual([{ command: 'codex', args: ['app-server', '--listen', 'stdio://'] }])
    expect(adapter.capabilities).toEqual({ steer: true, fork: true, thought: true, plan: true, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false })
    expect(() => assertRequiredCapabilities('codex', adapter.capabilities)).not.toThrow()
    expect(result.nativeSessionId).toMatch(/^thread-/)
    expect(adapter.nativeSessionId).toBe(result.nativeSessionId)
    expect(result.modelId).toBe('gpt-6-astra')
    expect(result.effort).toBe('high')
    expect(result.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(adapter.alive).toBe(true)
  })

  it('rejects a model Codex does not list, naming the agent', async () => {
    const { adapter } = setup()
    await expect(adapter.start({ modelId: 'gpt-nope', effort: 'low' })).rejects.toMatchObject({ name: 'AdapterError', agent: 'codex', code: 'start_failed' })
    await expect(createCodexAdapter(createFakeHost(FAKE)).start({ modelId: 'gpt-nope', effort: 'low' })).rejects.toThrow(/Codex does not offer model "gpt-nope"/)
  })

  it('falls back to the model default when the effort is not supported', async () => {
    const { host, adapter } = setup()
    const result = await adapter.start({ modelId: 'gpt-5.6-sol', effort: 'ultra' })
    expect(result.effort).toBe('medium')
    expect(host.logs.some((line) => line.includes('does not support effort "ultra"'))).toBe(true)
  })

  it('translates a full scripted turn into transcript events', async () => {
    const { host, adapter } = setup()
    host.answerPermission = (request) => request.title.startsWith('Grant') ? 'acceptForSession' : 'accept'
    host.answerQuestion = () => ({ letter: 'B' })
    writeFileSync(join(host.checkout, 'README.md'), 'old\n')
    writeFileSync(join(host.checkout, 'GONE.md'), 'bye\n')
    writeFileSync(join(host.checkout, 'BIG.md'), 'big\n')
    writeFileSync(join(host.checkout, 'WEIRD.md'), 'weird\n')
    const readTextFile = host.readTextFile
    host.readTextFile = (path, options) => path.endsWith('BIG.md') ? Promise.reject(new Error('file too large (limit 2 MB)')) : readTextFile(path, options)
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    expect(result).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } })

    const types = host.events.map((event) => event.type)
    expect(types.slice(0, 4)).toEqual(['text.delta', 'text.delta', 'text.delta', 'thought.delta'])
    for (const event of host.events) expect((event as { turnId?: string }).turnId ?? 'turn-1').toBe('turn-1')

    const text = host.ofType('text.delta')
    expect(text.slice(0, 3).map((event) => event.delta).join('')).toBe('Hello from fake Codex')
    expect(new Set(text.slice(0, 3).map((event) => event.messageId)).size).toBe(1)
    expect(host.ofType('thought.delta')).toEqual([{ type: 'thought.delta', turnId: 'turn-1', messageId: expect.stringMatching(/^reasoning-/), delta: 'thinking…' }])

    // Reasoning that came whole becomes a think card.
    const think = host.ofType('tool.started').find((event) => event.kind === 'think')
    expect(think).toBeDefined()
    expect(host.ofType('tool.finished').find((event) => event.id === think!.id)).toMatchObject({ status: 'completed', content: [{ type: 'text', text: 'whole reasoning' }] })

    // Command execution: approval, streamed output, terminal result.
    const command = host.ofType('tool.started').find((event) => event.kind === 'execute')!
    expect(command).toMatchObject({ id: expect.stringMatching(/^cmd-/), title: 'rm -f marker.txt', input: { command: 'rm -f marker.txt', cwd: '/tmp/fixture' } })
    expect(host.permissions[0]).toMatchObject({
      toolId: command.id,
      title: 'rm -f marker.txt',
      description: 'needs approval',
      options: [
        { id: 'accept', name: 'Allow once', kind: 'allow_once' },
        { id: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
        { id: 'decline', name: 'Reject', kind: 'reject_once' },
        { id: 'cancel', name: 'Reject and stop', kind: 'reject_always' },
      ],
    })
    const updated = host.ofType('tool.updated').find((event) => event.id === command.id)
    expect(updated).toMatchObject({ status: 'running', content: [{ type: 'terminal', text: 'removed marker\n', exitCode: null }] })
    expect(host.ofType('tool.finished').find((event) => event.id === command.id)).toMatchObject({ status: 'completed', content: [{ type: 'terminal', text: 'removed marker\n', exitCode: 0 }], durationMs: 15 })
    expect(text.some((event) => event.delta === 'decision:accept')).toBe(true)
    expect(types.indexOf('permission.requested')).toBe(-1) // the runtime emits those, not the adapter

    // File change: one full-contents diff per path (modified, created,
    // deleted); a file whose pre-image could not be read falls back to the
    // unified text Codex sent and says why.
    const edit = host.ofType('tool.started').find((event) => event.kind === 'edit')!
    const paths = ['README.md', 'NEW.md', 'GONE.md', 'BIG.md', 'WEIRD.md'].map((name) => join(host.checkout, name))
    expect(edit).toMatchObject({ title: 'Edit 5 files', locations: paths.map((path) => ({ path })) })
    expect(host.permissions[1]).toMatchObject({ toolId: edit.id, title: 'Apply file changes' })
    expect(readFileSync(paths[0], 'utf8')).toBe('new\n')
    const diffs = host.ofType('diff')
    expect(diffs).toEqual([
      { type: 'diff', turnId: 'turn-1', toolId: edit.id, diffId: expect.stringMatching(/^[0-9a-f-]{36}$/), path: paths[0], oldText: 'old\n', newText: 'new\n', oldExists: true, newExists: true },
      { type: 'diff', turnId: 'turn-1', toolId: edit.id, diffId: expect.any(String), path: paths[1], oldText: '', newText: 'hello\n', oldExists: false, newExists: true },
      { type: 'diff', turnId: 'turn-1', toolId: edit.id, diffId: expect.any(String), path: paths[2], oldText: 'bye\n', newText: '', oldExists: true, newExists: false },
      { type: 'diff', turnId: 'turn-1', toolId: edit.id, diffId: expect.any(String), path: paths[3], oldText: '', newText: expect.stringContaining('+bigger'), oldExists: true, newExists: true, unified: true },
      // The diff Codex sent does not describe what landed, so no pre-image
      // can be vouched for: the change is shown as Codex's own diff and is
      // not revertible (a started-time read could be half-written).
      { type: 'diff', turnId: 'turn-1', toolId: edit.id, diffId: expect.any(String), path: paths[4], oldText: '', newText: expect.stringContaining('+odd'), oldExists: true, newExists: true, unified: true },
    ])
    expect(new Set(diffs.map((event) => event.diffId)).size).toBe(5)
    expect(host.logs.some((line) => line.includes('BIG.md as a unified diff') && line.includes('file too large'))).toBe(true)
    expect(host.logs.some((line) => line.includes('WEIRD.md as a unified diff') && line.includes('does not fit the file on disk'))).toBe(true)
    const finishedEdit = host.ofType('tool.finished').find((event) => event.id === edit.id)
    expect(finishedEdit).toMatchObject({ status: 'completed' })
    expect(host.events.indexOf(diffs[4])).toBeLessThan(host.events.indexOf(finishedEdit!))

    // MCP tool call.
    const mcp = host.ofType('tool.started').find((event) => event.title === 'github: search')!
    expect(mcp).toMatchObject({ kind: 'other', input: { q: 'poise' } })
    expect(host.ofType('tool.finished').find((event) => event.id === mcp.id)).toMatchObject({ status: 'completed', content: [{ type: 'text', text: expect.stringContaining('one hit') }] })

    // Permission profile echoed back as granted with the chosen scope.
    expect(host.permissions[2]).toMatchObject({ title: 'Grant additional permissions', description: 'needs network', input: { permissions: { network: { enabled: true } } } })
    expect(text.some((event) => event.delta.includes('permission:{"permissions":{"network":{"enabled":true}},"scope":"session"}'))).toBe(true)

    // Question round-trip.
    expect(host.questions[0]).toMatchObject({
      toolId: expect.stringMatching(/^question-/),
      questions: [{ id: 'letter', header: 'Letter', question: 'Which letter?', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }], multiSelect: false, freeText: true }],
    })
    expect(text.some((event) => event.delta.startsWith('answer:B'))).toBe(true)

    // Plan.
    expect(host.ofType('plan.updated')).toEqual([{
      type: 'plan.updated',
      turnId: 'turn-1',
      explanation: 'the plan',
      entries: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'three', status: 'pending' }],
    }])

    // Every started tool finished, including the web search Codex never closed.
    const started = host.ofType('tool.started').map((event) => event.id)
    const finished = host.ofType('tool.finished').map((event) => event.id)
    expect(finished.sort()).toEqual([...started].sort())
    expect(host.ofType('tool.started').find((event) => event.kind === 'fetch')).toMatchObject({ title: 'Search: never completes' })

    // Nothing after the prompt resolved.
    const count = host.events.length
    await sleep(100)
    expect(host.events.length).toBe(count)
  })

  it('answers with cancel when the permission request is rejected by the host', async () => {
    const { host, adapter } = setup()
    host.answerPermission = () => { throw new Error('turn cancelled') }
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    expect(result.stopReason).toBe('cancelled')
    expect(host.ofType('tool.finished').find((event) => event.id.startsWith('cmd-'))).toMatchObject({ status: 'cancelled' })
  })

  it('records no diff for a declined file change', async () => {
    const { host, adapter } = setup()
    host.answerPermission = (request) => request.title === 'Apply file changes' ? 'decline' : 'accept'
    writeFileSync(join(host.checkout, 'README.md'), 'old\n')
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('hello'), new AbortController().signal)
    expect(readFileSync(join(host.checkout, 'README.md'), 'utf8')).toBe('old\n')
    expect(host.ofType('diff')).toEqual([])
    expect(host.ofType('tool.finished').find((event) => event.id.startsWith('patch-'))).toMatchObject({ status: 'cancelled' })
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
    await expect(adapter.prompt('turn-2', prompt('x'), controller.signal)).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('steers the running turn with the active turn id', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await expect(adapter.steer('too early')).rejects.toBeInstanceOf(AdapterError)
    const turn = adapter.prompt('turn-1', prompt('steer'), new AbortController().signal)
    await host.waitFor((event) => event.type === 'text.delta')
    await adapter.steer('go left')
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(host.ofType('text.delta').some((event) => event.delta === 'steered: go left')).toBe(true)
  })

  it('resolves the turn with an error naming Codex when the process dies', async () => {
    const { adapter } = setup()
    await adapter.start(MODEL)
    const exits: Array<number | null> = []
    adapter.onExit((code) => exits.push(code))
    const result = await adapter.prompt('turn-1', prompt('exit'), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/^Codex exited \(1\)/)
    expect(result.error).toContain('simulated crash')
    await until(() => exits.length === 1)
    expect(exits).toEqual([1])
    expect(adapter.alive).toBe(false)
    await expect(adapter.prompt('turn-2', prompt('again'), new AbortController().signal)).rejects.toMatchObject({ code: 'exited' })
  })

  it('answers unknown or unsupported server requests instead of hanging', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('unknown-request'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    const deltas = host.ofType('text.delta').map((event) => event.delta).join('')
    expect(deltas).toContain('attestation:-32601')
    expect(deltas).toContain('elicitation:decline')
    expect(deltas).toContain('legacy:{"denied"')
  })

  it('drops malformed frames without failing the turn', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('malformed'), new AbortController().signal)
    expect(result.stopReason).toBe('end_turn')
    expect(host.ofType('text.delta').map((event) => event.delta).join('')).toBe('survived')
    expect(host.logs.filter((line) => line.includes('not JSON-RPC'))).toHaveLength(1)
    expect(host.logs.some((line) => line.includes('nobody was waiting for'))).toBe(true)
    expect(adapter.alive).toBe(true)
  })

  it('surfaces a usage limit as a readable error naming Codex', async () => {
    const { adapter } = setup()
    await adapter.start(MODEL)
    const result = await adapter.prompt('turn-1', prompt('usage-limit'), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/^Codex usage limit reached: You've hit your usage limit/)
  })

  it('bounds streamed command output and marks it truncated', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('big-output'), new AbortController().signal)
    const finished = host.ofType('tool.finished')[0]
    expect(finished.status).toBe('completed')
    const block = finished.content?.[0]
    expect(block?.type).toBe('terminal')
    if (block?.type !== 'terminal') throw new Error('expected terminal block')
    expect(block.truncated).toBe(true)
    expect(block.exitCode).toBe(0)
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(CHAT_LIMITS.toolOutputBytes + 64)
    expect(block.text.endsWith('[output truncated by Poise]')).toBe(true)
    for (const update of host.ofType('tool.updated')) {
      const content = update.content?.[0]
      if (content?.type === 'terminal') expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(CHAT_LIMITS.toolOutputBytes + 64)
    }
  })

  it('remembers model and effort for the next turn and refuses modes', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await expect(adapter.setModel('gpt-5.6-sol', 'high')).resolves.toEqual({ modelId: 'gpt-5.6-sol', effort: 'high', efforts: ['low', 'medium', 'high'] })
    await expect(adapter.setModel('gpt-none', 'high')).rejects.toThrow(/Codex does not offer model "gpt-none"/)
    await expect(adapter.setMode('plan')).rejects.toMatchObject({ code: 'unsupported' })
    await adapter.prompt('turn-1', prompt('echo-input'), new AbortController().signal)
    const echoed = JSON.parse(host.ofType('text.delta')[0].delta)
    expect(echoed).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' })
  })

  it('maps mentions and attachments onto Codex user input', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', {
      text: 'echo-input',
      attachments: [
        { id: 'a1', name: 'notes.txt', path: 'uploads/notes.txt', size: 5, text: 'hello' },
        { id: 'a2', name: 'photo.png', path: 'uploads/photo.png', size: 1024 },
        { id: 'a3', name: 'evil.png', path: '../outside.png', size: 1 },
      ],
      mentions: [{ path: 'src/index.ts' }, { path: '../../etc/passwd' }],
    }, new AbortController().signal)
    const echoed = JSON.parse(host.ofType('text.delta')[0].delta)
    expect(echoed.input).toEqual([
      { type: 'text', text: 'echo-input\n\nnotes.txt (uploads/notes.txt):\n```\nhello\n```', text_elements: [] },
      { type: 'mention', name: 'photo.png', path: join(host.checkout, 'uploads/photo.png') },
      { type: 'mention', name: 'index.ts', path: join(host.checkout, 'src/index.ts') },
    ])
    expect(host.logs.filter((line) => line.includes('outside the checkout'))).toHaveLength(2)
  })

  it('resumes and forks threads by id', async () => {
    const resumed = setup()
    const start = await resumed.adapter.start({ ...MODEL, resume: 'thread-existing' })
    expect(start.nativeSessionId).toBe('thread-existing')
    const forkId = await resumed.adapter.fork()
    expect(forkId).toMatch(/^fork-/)
    expect(resumed.adapter.nativeSessionId).toBe('thread-existing')

    const forked = setup()
    const forkStart = await forked.adapter.start({ ...MODEL, forkFrom: 'thread-existing' })
    expect(forkStart.nativeSessionId).toMatch(/^fork-/)
  })

  it('logs ignored notifications once and closes cleanly', async () => {
    const { host, adapter } = setup()
    await adapter.start(MODEL)
    await adapter.prompt('turn-1', prompt('usage-limit'), new AbortController().signal)
    await adapter.prompt('turn-2', prompt('usage-limit'), new AbortController().signal)
    expect(host.logs.filter((line) => line.includes('ignoring deprecationNotice'))).toHaveLength(1)
    expect(host.logs.filter((line) => line.includes('ignoring mcpServer/startupStatus/updated'))).toHaveLength(1)
    expect(host.logs.filter((line) => line.includes('ignoring thread/status/changed'))).toHaveLength(1)
    const exited = new Promise<void>((resolve) => adapter.onExit(() => resolve()))
    await adapter.close()
    await exited
    expect(adapter.alive).toBe(false)
  })

  it('replays the recorded live handshake and surfaces the usage-limit failure', async () => {
    const { host, adapter } = setup(['--replay', join(FIXTURES, 'codex-handshake.trace.json')])
    const start = await adapter.start({ modelId: 'gpt-6-astra', effort: 'low' })
    expect(start.nativeSessionId).toBe('01a0b4a5-a8ee-7a10-bb70-04b994562487')
    expect(start.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    const result = await adapter.prompt('turn-1', prompt('Reply with the single word OK.'), new AbortController().signal)
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('Codex usage limit reached')
    expect(result.error).toContain('usage limit')
    const kinds = host.events.map((event: ChatEvent) => event.type)
    expect(kinds).not.toContain('text.delta')
    expect(host.logs.some((line) => line.includes('ignoring remoteControl/status/changed'))).toBe(true)
    // thread/resume and thread/fork were recorded too.
    expect(await adapter.fork()).toBe('01a0b4a5-c1b2-73d3-9743-a92f735a005a')
  })

  it('replays the recorded resume', async () => {
    const { adapter } = setup(['--replay', join(FIXTURES, 'codex-handshake.trace.json')])
    const start = await adapter.start({ modelId: 'gpt-6-astra', effort: 'low', resume: '01a0b4a5-a8ee-7a10-bb70-04b994562487' })
    expect(start.nativeSessionId).toBe('01a0b4a5-a8ee-7a10-bb70-04b994562487')
  })
})
