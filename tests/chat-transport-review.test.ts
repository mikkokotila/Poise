import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatSocketServer as SocketServerType } from '../server/chat/transport'

let root = ''
let ChatSocketServer: typeof SocketServerType
let http: Server
let transport: SocketServerType
const sockets: WebSocket[] = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-transport-review-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatSocketServer } = await import('../server/chat/transport'))
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await transport?.close()
  await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve())
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function serve(create: (request: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const runtime = Object.assign(new EventEmitter(), { instance: 'transport-review', create, ...extra })
  transport = new ChatSocketServer(runtime as unknown as ChatRuntime)
  http = createServer((_req, res) => { res.statusCode = 404; res.end() })
  transport.attach(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address() as { port: number }
  const url = `ws://127.0.0.1:${address.port}/ws/chat`
  return async () => {
    const socket = new WebSocket(url, { origin: `http://127.0.0.1:${address.port}` })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return socket
  }
}
function command(id: string, title = 'one') {
  return JSON.stringify({ id, command: { type: 'session.new', agent: 'grok', model: 'fixture', repo: 'fixture/repo', branch: { existing: 'main' }, title } })
}
function ack(socket: WebSocket, id: string): Promise<{ ok: boolean, error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('ack deadline')) }, 1500)
    const listener = (raw: import('ws').RawData) => {
      const frame = JSON.parse(raw.toString())
      if (frame.kind === 'ack' && frame.id === id) { clearTimeout(timer); socket.off('message', listener); resolve(frame) }
    }
    socket.on('message', listener)
  })
}

describe('Chat command replay safety over real WebSockets', () => {
  it('coalesces identical commands received while the first is still in flight', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const create = vi.fn(() => pending)
    const connect = await serve(create)
    const socket = await connect()
    const response = ack(socket, 'inflight')
    socket.send(command('inflight'))
    socket.send(command('inflight'))
    await new Promise(resolve => setTimeout(resolve, 50))
    finish({ id: 'created' })
    await response
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a mutation when its request id is resent on a new connection', async () => {
    const create = vi.fn(async () => ({ id: 'created' }))
    const connect = await serve(create)
    const first = await connect()
    const original = ack(first, 'reconnect')
    first.send(command('reconnect'))
    expect((await original).ok).toBe(true)
    first.terminate()
    const second = await connect()
    const retried = ack(second, 'reconnect')
    second.send(command('reconnect'))
    expect((await retried).ok).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects reuse of an acknowledged id for a different mutation payload', async () => {
    const create = vi.fn(async () => ({ id: 'created' }))
    const connect = await serve(create)
    const socket = await connect()
    const original = ack(socket, 'conflict')
    socket.send(command('conflict', 'original'))
    expect((await original).ok).toBe(true)
    const conflicting = ack(socket, 'conflict')
    socket.send(command('conflict', 'different'))
    expect((await conflicting).ok).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
  })
})

it('preserves completed mutation receipts across a new socket-server instance', async () => {
  const create = vi.fn(async () => ({ id: 'created' }))
  const connect = await serve(create)
  const first = await connect()
  const original = ack(first, 'server-restart')
  first.send(command('server-restart'))
  expect((await original).ok).toBe(true)
  first.terminate()
  await transport.close()
  await new Promise<void>(resolve => http.close(() => resolve()))
  const reconnect = await serve(create)
  const second = await reconnect()
  const retried = ack(second, 'server-restart')
  second.send(command('server-restart'))
  expect((await retried).ok).toBe(true)
  expect(create).toHaveBeenCalledTimes(1)
})


it('does not replay a durable command whose outcome is unknown', async () => {
  const { executeCommandOnce } = await import('../server/chat/command-receipts')
  const frame = JSON.parse(command('orphaned-receipt'))
  const uncertain = await executeCommandOnce('transport-review', frame.id, frame.command, async () => {
    throw new Error('simulated interruption before outcome persistence')
  })
  expect(uncertain).toMatchObject({ ok: false, code: 'command_in_doubt' })
  const create = vi.fn(async () => ({ id: 'must-not-execute' }))
  const connect = await serve(create)
  const socket = await connect()
  const response = ack(socket, frame.id)
  socket.send(JSON.stringify(frame))
  expect(await response).toMatchObject({ ok: false, code: 'command_in_doubt' })
  expect(create).not.toHaveBeenCalled()
})


it('rejects a cross-origin browser before accepting a Chat WebSocket', async () => {
  const create = vi.fn(async () => ({}))
  await serve(create)
  const { port } = http.address() as { port: number }
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, { origin: 'https://example.invalid' })
  sockets.push(socket)
  socket.on('error', () => undefined)
  const status = await new Promise<number>(resolve => {
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode || 0)
      response.destroy()
      socket.terminate()
    })
  })
  expect(status).toBe(403)
  expect(create).not.toHaveBeenCalled()
})


it('bounds server shutdown when a WebSocket peer does not read the close handshake', async () => {
  const connect = await serve(vi.fn(async () => ({})))
  const socket = await connect()
  ;(socket as unknown as { _socket: import('node:net').Socket })._socket.pause()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const closed = await Promise.race([
      transport.close().then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000) }),
    ])
    expect(closed).toBe(true)
  } finally {
    if (timer) clearTimeout(timer)
    socket.terminate()
  }
})

it('does not let WebSocket session creation choose a repository or branch', async () => {
  const create = vi.fn(async (_request: unknown) => ({ id: 'created-local' }))
  const connect = await serve(create)
  const socket = await connect()
  const response = ack(socket, 'local-only')
  socket.send(command('local-only'))
  expect((await response).ok).toBe(true)
  const request = create.mock.calls[0][0]
  expect(request).toMatchObject({ agent: 'grok', model: 'fixture', title: 'one' })
  expect(request).not.toHaveProperty('repo')
  expect(request).not.toHaveProperty('branch')
})

it('does not let REST session creation choose a repository, branch or filesystem path', async () => {
  const { Readable } = await import('node:stream')
  const { handleChatApi } = await import('../server/chat/transport')
  const create = vi.fn(async (_request: unknown) => ({ id: 'created-local-rest' }))
  const req = Object.assign(Readable.from([JSON.stringify({ agent: 'grok', model: 'fixture', repo: 'other/repo', branch: { existing: 'main' }, checkout: '/outside' })]),
    { method: 'POST', headers: { 'content-type': 'application/json' } })
  const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
  await handleChatApi(req as unknown as import('node:http').IncomingMessage, res as unknown as import('node:http').ServerResponse, '/api/chat/sessions', { create } as unknown as ChatRuntime)
  expect(res.statusCode).toBe(201)
  const request = create.mock.calls[0][0]
  expect(request).not.toHaveProperty('repo')
  expect(request).not.toHaveProperty('branch')
  expect(request).not.toHaveProperty('checkout')
})

it('records the Auto-merge mutation once across reconnect and rejects conflicting reuse of its id', async () => {
  const setAutoMerge = vi.fn(async (sessionId: string, enabled: boolean) => ({ session: { id: sessionId, autoMerge: enabled }, applies: 'next_turn' }))
  const connect = await serve(async () => ({}), { setAutoMerge })
  const frame = (enabled: boolean) => JSON.stringify({ id: 'auto-merge-on', command: { type: 'set_auto_merge', sessionId: 's1', enabled } })
  const first = await connect()
  const initial = ack(first, 'auto-merge-on')
  first.send(frame(true))
  expect((await initial).ok).toBe(true)
  first.terminate()
  const second = await connect()
  const repeated = ack(second, 'auto-merge-on')
  second.send(frame(true))
  expect((await repeated).ok).toBe(true)
  expect(setAutoMerge).toHaveBeenCalledExactlyOnceWith('s1', true)
  const conflict = ack(second, 'auto-merge-on')
  second.send(frame(false))
  expect((await conflict).ok).toBe(false)
  expect(setAutoMerge).toHaveBeenCalledTimes(1)
})


it('deduplicates queue commands on reconnect and never turns an enqueue into a prompt or steering', async () => {
  const enqueue = vi.fn(async () => ({ revision: 1, ready: false, items: [] }))
  const prompt = vi.fn(); const steer = vi.fn()
  const connect = await serve(vi.fn(), { enqueue, prompt, steer })
  const packet = JSON.stringify({ id: 'queue-reconnect', command: { type: 'queue.add', sessionId: 'one', itemId: '11111111-1111-4111-8111-111111111111', text: 'Later', model: 'grok-4.6-high', attachments: [], mentions: [] } })
  const first = await connect(); const firstAck = ack(first, 'queue-reconnect'); first.send(packet)
  expect((await firstAck).ok).toBe(true); first.terminate()
  const second = await connect(); const secondAck = ack(second, 'queue-reconnect'); second.send(packet)
  expect((await secondAck).ok).toBe(true)
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue).toHaveBeenCalledWith('one', '11111111-1111-4111-8111-111111111111', { text: 'Later', attachments: [], mentions: [] }, 'grok-4.6-high', undefined)
  expect(prompt).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled()
})

it('records Safe mode once across reconnect and rejects conflicting request IDs', async () => {
  const setSafeMode = vi.fn(async (sessionId: string, enabled: boolean) => ({ session: { id: sessionId, safeMode: enabled }, applies: 'next_turn' }))
  const connect = await serve(async () => ({}), { setSafeMode })
  const frame = (enabled: boolean) => JSON.stringify({ id: 'safe-mode-on', command: { type: 'set_safe_mode', sessionId: 's1', enabled } })
  const first = await connect(); const initial = ack(first, 'safe-mode-on'); first.send(frame(true))
  expect((await initial).ok).toBe(true)
  first.terminate()
  const second = await connect(); const repeated = ack(second, 'safe-mode-on'); second.send(frame(true))
  expect((await repeated).ok).toBe(true)
  expect(setSafeMode).toHaveBeenCalledExactlyOnceWith('s1', true)
  const conflict = ack(second, 'safe-mode-on'); second.send(frame(false))
  expect((await conflict).ok).toBe(false)
  expect(setSafeMode).toHaveBeenCalledTimes(1)
})
