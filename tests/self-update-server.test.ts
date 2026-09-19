// The HTTP side of self-improvement: the bounded Unix socket client, the
// public status/revert routes with session ownership, the controller's
// key-protected drain/readiness/resume, the drain gate on API mutations,
// and the build identity on /api/health. Nothing here touches a real
// controller root, release or production server.
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SelfUpdateBridge } from '../server/self-update-bridge'
import type { PreparedSelfChange, SelfChange, SelfUpdateStatus } from '../src/self-update-types'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

let root = ''

beforeAll(async () => {
  // Short: a Unix socket path must fit in sun_path.
  root = await mkdtemp(join(tmpdir(), 'psu-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('self-update bridge client', () => {
  let socketServer: Server | null = null
  afterEach(async () => {
    if (socketServer) await new Promise<void>((resolve) => socketServer!.close(() => resolve()))
    socketServer = null
  })

  it('is inert without a root and reports a missing controller actionably', async () => {
    const { createSelfUpdateBridge, resolveSelfUpdateRoot, SelfUpdateUnavailableError } = await import('../server/self-update-bridge')
    const none = createSelfUpdateBridge({ root: null })
    expect(none.configured).toBe(false)
    await expect(none.status()).rejects.toBeInstanceOf(SelfUpdateUnavailableError)
    await expect(none.status()).rejects.toThrow(/not set up on this server/)
    expect(none.readBridgeKey()).toBeNull()
    const ctl = join(root, 'missing')
    await mkdir(ctl)
    const bridge = createSelfUpdateBridge({ root: ctl })
    expect(bridge.configured).toBe(true)
    await expect(bridge.status()).rejects.toThrow(/controller is not running/)
    await expect(bridge.finish('nope', { outcome: 'failed' })).rejects.toThrow(/must be a UUID/)
    // Only an explicit root or the production label configures a bridge.
    expect(resolveSelfUpdateRoot('dev', {})).toBeNull()
    expect(resolveSelfUpdateRoot('production', {})).toMatch(/\.poise\/self-update$/)
    expect(resolveSelfUpdateRoot('dev', { POISE_SELF_UPDATE_ROOT: '/tmp/x' })).toBe('/tmp/x')
  })

  it('reads the bridge key only from a private regular file', async () => {
    const { createSelfUpdateBridge } = await import('../server/self-update-bridge')
    const ctl = join(root, 'keys')
    await mkdir(ctl)
    const bridge = createSelfUpdateBridge({ root: ctl })
    expect(bridge.readBridgeKey()).toBeNull()
    await writeFile(join(ctl, 'bridge.key'), `${'a'.repeat(48)}\n`, { mode: 0o644 })
    expect(bridge.readBridgeKey()).toBeNull() // group/world readable
    await chmod(join(ctl, 'bridge.key'), 0o600)
    expect(bridge.readBridgeKey()).toBe('a'.repeat(48))
    await writeFile(join(ctl, 'bridge.key'), 'short', { mode: 0o600 })
    expect(bridge.readBridgeKey()).toBeNull()
  })

  it('talks JSON over the socket with bounded responses and typed errors', async () => {
    const { createSelfUpdateBridge, SelfUpdateBridgeError, SelfUpdateUnavailableError } = await import('../server/self-update-bridge')
    const ctl = join(root, 'sock')
    await mkdir(ctl)
    const seen: Array<{ method: string, url: string, body: string }> = []
    socketServer = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, body })
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/status') return res.end(JSON.stringify({ enabled: true, available: true, activeRelease: null, previousRelease: null, hold: null, changes: [] }))
        if (req.url === '/changes') { res.statusCode = 409; return res.end(JSON.stringify({ error: 'another change is in flight' })) }
        if (req.url === '/tick') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'boom' })) }
        if (req.url?.endsWith('/rollback')) return res.end(JSON.stringify({ id: 'x' }))
        if (req.url?.endsWith('/finish')) return res.end('x'.repeat(2 * 1024 * 1024))
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'no' }))
      })
    })
    await new Promise<void>((resolve) => socketServer!.listen(join(ctl, 'control.sock'), resolve))
    const bridge = createSelfUpdateBridge({ root: ctl, timeoutMs: 2_000 })
    await expect(bridge.status()).resolves.toMatchObject({ enabled: true })
    const id = randomUUID()
    await expect(bridge.prepareChange({ id, sessionId: id, instance: 'i', request: 'r' })).rejects.toMatchObject({ name: 'SelfUpdateBridgeError', statusCode: 409, message: 'another change is in flight' })
    await expect(bridge.tick()).rejects.toBeInstanceOf(SelfUpdateUnavailableError)
    await expect(bridge.rollback(id, { expectedReleaseId: 'rel' })).resolves.toEqual({ id: 'x' })
    await expect(bridge.finish(id, { outcome: 'completed' })).rejects.toThrow(/exceeds 1 MiB|connection failed/)
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', '/status'], ['POST', '/changes'], ['POST', '/tick'], ['POST', `/changes/${id}/rollback`], ['POST', `/changes/${id}/finish`],
    ])
    expect(JSON.parse(seen[1].body)).toEqual({ id, sessionId: id, instance: 'i', request: 'r' })
    expect(SelfUpdateBridgeError.name).toBe('SelfUpdateBridgeError')
  })
})

// ── Routes through the real middleware with a fake controller ─────────────

interface FakeBridge extends SelfUpdateBridge { calls: Array<{ op: string, changeId?: string, input?: any }>, changes: SelfChange[], key: string | null, /** When set, `status()` waits for it (a slow controller). */ hold: Promise<void> | null }
function fakeBridge(configured = true): FakeBridge {
  const bridge: FakeBridge = {
    configured, root: configured ? '/nonexistent/ctl' : null, calls: [], changes: [], key: 'K'.repeat(40), hold: null,
    async status(): Promise<SelfUpdateStatus> {
      bridge.calls.push({ op: 'status' })
      if (bridge.hold) await bridge.hold
      return { enabled: true, available: true, activeRelease: { id: 'rel-2', sha: 'b'.repeat(40), root: '/r/2', createdAt: 'now', callerSha: 'c'.repeat(40) }, previousRelease: null, hold: null, changes: bridge.changes }
    },
    async prepareChange(): Promise<PreparedSelfChange> { throw new Error('not used here') },
    async bindSession(): Promise<SelfChange> { throw new Error('not used here') },
    async finish(changeId, input) { bridge.calls.push({ op: 'finish', changeId, input }); return bridge.changes[0] },
    async rollback(changeId, input) { bridge.calls.push({ op: 'rollback', changeId, input }); return { ...bridge.changes.find((c) => c.id === changeId)!, state: 'reverting' } },
    async tick() { return bridge.status() },
    readBridgeKey: () => bridge.key,
  }
  return bridge
}

function change(id: string, sessionId: string, instance: string): SelfChange {
  return { id, sessionId, instance, request: 'r', title: 't', repository: 'mikkokotila/Poise', branch: `poise/change-${id}`, baseSha: 'a'.repeat(40), state: 'live', createdAt: 'now', updatedAt: 'now', releaseId: 'rel-2', previousReleaseId: 'rel-1', canRevert: true }
}

describe('self-update routes', () => {
  let server: Server
  let base = ''
  let cache: typeof import('../server/cache-plugin')
  let bridge: FakeBridge
  const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR']

  async function start(withBridge: FakeBridge | null) {
    const dir = await mkdtemp(join(root, 'srv-'))
    process.env.POISE_DB = join(dir, 'cache.db')
    process.env.POISE_EDITOR_DIR = join(dir, 'editor')
    process.env.POISE_CHAT_ATTACHMENTS_DIR = join(dir, 'chat')
    process.env.POISE_LOCK_DIR = join(dir, 'locks')
    process.env.AGENT_INTERFACE_ROOT = join(dir, 'agent-interface')
    process.env.POISE_ESPANSO_MATCH_DIR = dir
    vi.resetModules()
    cache = await import('../server/cache-plugin')
    const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: withBridge })
    server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end() }) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    base = `http://127.0.0.1:${address.port}`
  }
  afterEach(async () => {
    await cache?.stopPoiseRuntime()
    const { closeDatabase } = await import('../server/db')
    closeDatabase()
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    for (const key of envKeys) delete process.env[key]
  })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('health carries the build identity, and an unconfigured server answers /poise status as disabled', async () => {
    await start(null)
    const health = await (await fetch(`${base}/api/health`)).json() as any
    expect(health.build).toEqual({ sha: null, releaseId: null }) // a development build never looks like a release
    expect(health.selfUpdate).toEqual({ configured: false, draining: false })
    const status = await (await fetch(`${base}/api/self-update`)).json() as SelfUpdateStatus
    expect(status).toMatchObject({ enabled: false, available: false, changes: [], reason: expect.stringMatching(/not set up on this server/) })
    // The controller's endpoints exist but nothing can authorize to them.
    expect((await fetch(`${base}/api/self-update/readiness`)).status).toBe(503)
    expect((await post('/api/self-update/drain', { releaseId: 'rel' })).status).toBe(503)
    // Nothing is gated: an ordinary mutation still works.
    expect((await post('/api/current', { text: 'card', lane: 'idea' })).status).toBe(200)
  })

  it('shows a session only its own instance\'s changes and reverts only through them', async () => {
    bridge = fakeBridge()
    await start(bridge)
    const runtime = cache.getChatRuntime()
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', title: 'mine' }).catch(() => null)
    // A local session needs the local workspace, which this environment may
    // not provide; the ownership checks only need a stored record.
    const storage = await import('../server/chat/storage')
    const mine = session?.id ?? randomUUID()
    if (!session) {
      storage.insertSession({ id: mine, agent: 'grok', model: 'grok-4.6-xhigh', modelId: 'grok-4.6', effort: 'xhigh', repo: '', checkout: root, branch: { name: 'main', origin: 'existing', provisional: false }, title: 'mine', createdAt: 'now', updatedAt: 'now', status: 'idle', capabilities: { steer: false, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: false, questions: false, resume: false, images: false }, lastSeq: 0, pendingRequests: [], instance: runtime.instance })
    }
    const other = randomUUID()
    storage.insertSession({ id: other, agent: 'grok', model: 'grok-4.6-xhigh', modelId: 'grok-4.6', effort: 'xhigh', repo: '', checkout: root, branch: { name: 'main', origin: 'existing', provisional: false }, title: 'theirs', createdAt: 'now', updatedAt: 'now', status: 'idle', capabilities: { steer: false, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: false, questions: false, resume: false, images: false }, lastSeq: 0, pendingRequests: [], instance: 'poise-elsewhere:db' })
    const visible = change(randomUUID(), mine, runtime.instance)
    const otherSession = change(randomUUID(), randomUUID(), runtime.instance)
    const otherInstance = change(randomUUID(), mine, 'poise-elsewhere:db')
    bridge.changes = [visible, otherSession, otherInstance]

    const status = await (await fetch(`${base}/api/self-update?session=${mine}`)).json() as SelfUpdateStatus
    expect(status.enabled).toBe(true)
    expect(status.activeRelease?.id).toBe('rel-2')
    expect(status.changes.map((c) => c.id)).toEqual([visible.id])
    expect((await (await fetch(`${base}/api/self-update`)).json() as SelfUpdateStatus).changes).toEqual([])
    expect((await fetch(`${base}/api/self-update?session=${randomUUID()}`)).status).toBe(404)
    expect((await fetch(`${base}/api/self-update?session=${other}`)).status).toBe(409) // another Poise server's session
    expect((await fetch(`${base}/api/self-update?session=nope`)).status).toBe(400)

    // Revert: the change must be the session's, the release id required.
    expect((await post('/api/self-update/revert', { sessionId: mine, changeId: otherSession.id, expectedReleaseId: 'rel-2' })).status).toBe(404)
    expect((await post('/api/self-update/revert', { sessionId: mine, changeId: otherInstance.id, expectedReleaseId: 'rel-2' })).status).toBe(404)
    expect((await post('/api/self-update/revert', { sessionId: other, changeId: visible.id, expectedReleaseId: 'rel-2' })).status).toBe(409)
    expect((await post('/api/self-update/revert', { sessionId: mine, changeId: visible.id })).status).toBe(400)
    expect((await post('/api/self-update/revert', { sessionId: mine, changeId: 'x', expectedReleaseId: 'rel-2' })).status).toBe(400)
    expect(bridge.calls.filter((c) => c.op === 'rollback')).toEqual([])
    const reverted = await post('/api/self-update/revert', { sessionId: mine, changeId: visible.id, expectedReleaseId: 'rel-2' })
    expect(reverted.status).toBe(200)
    expect(await reverted.json()).toMatchObject({ change: { id: visible.id, state: 'reverting' } })
    expect(bridge.calls.filter((c) => c.op === 'rollback')).toEqual([{ op: 'rollback', changeId: visible.id, input: { expectedReleaseId: 'rel-2' } }])
    // The session may be named in the query too.
    expect((await post(`/api/self-update/revert?session=${mine}`, { changeId: visible.id, expectedReleaseId: 'rel-2' })).status).toBe(200)
  }, 20_000)

  it('protects drain/readiness/resume with the bridge key and gates mutations while draining', async () => {
    bridge = fakeBridge()
    await start(bridge)
    const key = { 'x-poise-release-key': bridge.key! }
    expect((await fetch(`${base}/api/self-update/readiness`)).status).toBe(401)
    expect((await fetch(`${base}/api/self-update/readiness`, { headers: { 'x-poise-release-key': 'wrong' } })).status).toBe(401)
    expect((await post('/api/self-update/drain', { releaseId: 'rel-3' }, { 'x-poise-release-key': 'K'.repeat(39) })).status).toBe(401)
    bridge.key = null
    expect((await fetch(`${base}/api/self-update/readiness`, { headers: { 'x-poise-release-key': 'K'.repeat(40) } })).status).toBe(503)
    bridge.key = 'K'.repeat(40)

    const before = await (await fetch(`${base}/api/self-update/readiness`, { headers: key })).json() as any
    expect(before).toEqual({ ready: false, busy: 0, build: { sha: null, releaseId: null }, draining: false })
    expect((await post('/api/self-update/drain', {}, key)).status).toBe(400)

    // A mutation still in flight when the drain lands is counted until it ends.
    const slow = httpRequest(`${base}/api/current`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } })
    const slowDone = new Promise<number>((resolve) => slow.on('response', (res) => { res.resume(); resolve(res.statusCode!) }))
    slow.write('{"text":"late"')
    await new Promise((r) => setTimeout(r, 100))
    const drained = await (await post('/api/self-update/drain', { releaseId: 'rel-3' }, key)).json() as any
    expect(drained).toMatchObject({ ready: false, busy: 1, draining: true, releaseId: 'rel-3' })
    expect((await (await fetch(`${base}/api/health`)).json() as any).selfUpdate).toEqual({ configured: true, draining: true })
    slow.end(',"lane":"idea"}')
    expect(await slowDone).toBe(200) // it was in before the drain: finished, not cut
    const ready = await (await fetch(`${base}/api/self-update/readiness`, { headers: key })).json() as any
    expect(ready).toMatchObject({ ready: true, busy: 0, draining: true })

    // From now on: reads fine, new mutations refused, settlement allowed.
    expect((await fetch(`${base}/api/current`)).status).toBe(200)
    const refused = await post('/api/current', { text: 'card', lane: 'idea' })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ code: 'draining' })
    expect((await post('/api/chat/sessions', { agent: 'grok', model: 'grok-4.6-xhigh' })).status).toBe(503)
    expect((await post('/api/settings', { org: 'x' })).status).toBe(503)
    const cancel = await post(`/api/chat/sessions/${randomUUID()}/cancel`, {})
    expect(cancel.status).toBe(404) // reached the chat routes: not gated
    expect((await post('/api/self-update/revert', { sessionId: randomUUID(), changeId: randomUUID(), expectedReleaseId: 'r' })).status).toBe(404)
    // Drain again for another release replaces the intent; resume opens the gate.
    expect((await (await post('/api/self-update/drain', { releaseId: 'rel-4' }, key)).json() as any).releaseId).toBe('rel-4')
    const resumed = await (await post('/api/self-update/resume', {}, key)).json() as any
    expect(resumed).toMatchObject({ ready: false, draining: false })
    expect((await post('/api/current', { text: 'card', lane: 'idea' })).status).toBe(200)
    // Cross-site callers never reach the key check.
    expect((await fetch(`${base}/api/self-update/readiness`, { headers: { ...key, Origin: 'http://evil.example' } })).status).toBe(403)
  }, 20_000)

  it('keeps counting a mutation whose client disconnected until its handler has finished', async () => {
    bridge = fakeBridge()
    await start(bridge)
    const key = { 'x-poise-release-key': bridge.key! }
    const storage = await import('../server/chat/storage')
    const runtime = cache.getChatRuntime()
    const mine = randomUUID()
    storage.insertSession({ id: mine, agent: 'grok', model: 'grok-4.6-xhigh', modelId: 'grok-4.6', effort: 'xhigh', repo: '', checkout: root, branch: { name: 'main', origin: 'existing', provisional: false }, title: 'mine', createdAt: 'now', updatedAt: 'now', status: 'idle', capabilities: { steer: false, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: false, questions: false, resume: false, images: false }, lastSeq: 0, pendingRequests: [], instance: runtime.instance })
    const visible = change(randomUUID(), mine, runtime.instance)
    bridge.changes = [visible]
    // The revert handler is held inside the controller call; the client
    // sends its whole request and goes away before the handler ends.
    let releaseHold!: () => void
    bridge.hold = new Promise<void>((resolve) => { releaseHold = resolve })
    const gone = httpRequest(`${base}/api/self-update/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    gone.on('error', () => undefined)
    gone.end(JSON.stringify({ sessionId: mine, changeId: visible.id, expectedReleaseId: 'rel-2' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(bridge.calls.filter((c) => c.op === 'status')).toHaveLength(1) // the handler is inside the controller call
    gone.destroy()
    await new Promise((r) => setTimeout(r, 100))
    const during = await (await fetch(`${base}/api/self-update/readiness`, { headers: key })).json() as any
    expect(during.busy).toBe(1) // still counted although the response can never be delivered
    releaseHold()
    await new Promise((r) => setTimeout(r, 100))
    expect(bridge.calls.filter((c) => c.op === 'rollback')).toHaveLength(1) // the write happened after the disconnect
    const after = await (await fetch(`${base}/api/self-update/readiness`, { headers: key })).json() as any
    expect(after.busy).toBe(0)
  }, 20_000)

  it('pauses and resumes process-owned background admission with the drain and counts admitted operations', async () => {
    bridge = fakeBridge()
    await start(bridge)
    const key = { 'x-poise-release-key': bridge.key! }
    const background = await import('../server/release-background')
    expect(background.releaseBackgroundPaused()).toBe(false)
    const finish = background.trackReleaseBackground() // admitted before the drain, e.g. a behavior tick already running
    const drained = await (await post('/api/self-update/drain', { releaseId: 'rel-5' }, key)).json() as any
    expect(background.releaseBackgroundPaused()).toBe(true)
    expect(drained).toMatchObject({ ready: false, draining: true })
    expect(drained.busy).toBeGreaterThanOrEqual(1) // ours, plus whatever startup work is still settling
    const readiness = async () => (await fetch(`${base}/api/self-update/readiness`, { headers: key })).json() as Promise<any>
    for (let n = 0; n < 100 && (await readiness()).busy > 1; n++) await new Promise((r) => setTimeout(r, 20))
    expect(await readiness()).toMatchObject({ ready: false, busy: 1 })
    finish()
    expect(await readiness()).toMatchObject({ ready: true, busy: 0 })
    await post('/api/self-update/resume', {}, key)
    expect(background.releaseBackgroundPaused()).toBe(false)
    // A stop while drained must not leave the background paused for the next server.
    await post('/api/self-update/drain', { releaseId: 'rel-6' }, key)
    expect(background.releaseBackgroundPaused()).toBe(true)
    await cache.stopPoiseRuntime()
    expect(background.releaseBackgroundPaused()).toBe(false)
  }, 20_000)
})
