import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatClient, ChatCommandError } from '../src/chat-client'
import type { ChatEnvelope, ServerFrame, SessionRecord } from '../server/chat/protocol'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  sent: Array<{ id: string, command: { type: string, sessionId?: string, afterSeq?: number } }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_url: string) { Socket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(frame: ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3; this.onclose?.() }
}
let client: ChatClient
beforeEach(() => {
  vi.useFakeTimers()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5556' })
  client = new ChatClient()
})
afterEach(() => { client.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function latest() { return Socket.instances.at(-1)! }
function hello(socket = latest(), startedAt = 'start-1', instance = 'dev') {
  socket.receive({ kind: 'hello', instance, serverStartedAt: startedAt })
}
function event(seq: number): ChatEnvelope {
  return { sessionId: 'session', seq, at: '2026-09-18T14:00:00Z', event: { type: 'text.delta', turnId: 'turn', messageId: 'message', delta: String(seq) } }
}
function acknowledge(socket: Socket, id: string) { socket.receive({ kind: 'ack', id, ok: true, result: {} }) }

describe('Chat client reconnect and transcript safety', () => {
  it('does not send commands before hello, even after WebSocket open', async () => {
    const pending = client.send({ type: 'cancel', sessionId: 'session' })
    latest().open()
    expect(client.connectionState()).toBe('connecting')
    expect(latest().sent).toEqual([])
    hello()
    expect(client.connectionState()).toBe('open')
    expect(latest().sent).toHaveLength(1)
    acknowledge(latest(), latest().sent[0].id)
    await pending
  })

  it('re-subscribes before retrying an unacknowledged command, preserving its ID', async () => {
    client.subscribe('session', 7)
    latest().open(); hello()
    const pending = client.send({ type: 'cancel', sessionId: 'session' })
    const id = latest().sent.at(-1)!.id
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    latest().open()
    expect(latest().sent).toEqual([])
    hello(latest(), 'start-2')
    expect(latest().sent.map(f => f.command.type)).toEqual(['subscribe', 'cancel'])
    expect(latest().sent[0].command.afterSeq).toBe(7)
    expect(latest().sent[1].id).toBe(id)
    acknowledge(latest(), id)
    await pending
  })

  it('does not transplant unacknowledged work into a different server instance', async () => {
    const pending = client.send({ type: 'cancel', sessionId: 'session' }).catch(error => error)
    latest().open(); hello()
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    latest().open(); hello(latest(), 'other-start', 'production')
    expect(latest().sent).toEqual([])
    expect(await pending).toMatchObject({ code: 'command_in_doubt' })
  })

  it('does not skip missing events when a future event overtakes an asynchronous gap refill', async () => {
    client.subscribe('session', 0)
    latest().open(); hello()
    const seen: number[] = []
    client.on('event', e => seen.push(e.seq))
    let finish!: (page: { session: SessionRecord, events: ChatEnvelope[], truncated: boolean }) => void
    vi.spyOn(client, 'fetchSession').mockReturnValue(new Promise(resolve => { finish = resolve }))
    latest().receive({ kind: 'gap', sessionId: 'session', fromSeq: 0, toSeq: 3 })
    latest().receive({ kind: 'event', envelope: event(3) })
    expect(seen).toEqual([])
    expect(client.subscribedAfter('session')).toBe(0)
    finish({ session: {} as SessionRecord, events: [event(1), event(2)], truncated: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1, 2, 3])
    expect(client.subscribedAfter('session')).toBe(3)
    latest().receive({ kind: 'event', envelope: event(2) })
    expect(seen).toEqual([1, 2, 3])
  })

  it('notices out-of-order events even without a gap frame', async () => {
    client.subscribe('session', 0)
    latest().open(); hello()
    const seen: number[] = []
    client.on('event', e => seen.push(e.seq))
    const refill = vi.spyOn(client, 'fetchSession').mockResolvedValue({ session: {} as SessionRecord, events: [event(1), event(2)] })
    latest().receive({ kind: 'event', envelope: event(3) })
    await vi.advanceTimersByTimeAsync(0)
    expect(refill).toHaveBeenCalledWith('session', 0)
    expect(seen).toEqual([1, 2, 3])
  })

  it('drops an in-flight refill after the session is unsubscribed', async () => {
    client.subscribe('session', 0)
    latest().open(); hello()
    let finish!: (page: { session: SessionRecord, events: ChatEnvelope[] }) => void
    vi.spyOn(client, 'fetchSession').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const seen: number[] = []
    client.on('event', e => seen.push(e.seq))
    latest().receive({ kind: 'event', envelope: event(2) })
    client.unsubscribe('session')
    finish({ session: {} as SessionRecord, events: [event(1)] })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([])
    expect(client.subscribedAfter('session')).toBeUndefined()
  })

  it('reports a durable in-doubt acknowledgement without sending the command again', async () => {
    const pending = client.send({ type: 'cancel', sessionId: 'session' }).catch(error => error)
    latest().open(); hello()
    latest().receive({ kind: 'ack', id: latest().sent[0].id, ok: false, code: 'command_in_doubt', error: 'not replayed' })
    expect(await pending).toBeInstanceOf(ChatCommandError)
    latest().close()
    await vi.advanceTimersByTimeAsync(500)
    latest().open(); hello(latest(), 'start-2')
    expect(latest().sent).toEqual([])
  })

  it('bounds an unacknowledged command and never represents timeout as cancellation', async () => {
    const pending = client.send({ type: 'cancel', sessionId: 'session' }).catch(error => error)
    latest().open(); hello()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await pending).toMatchObject({ code: 'command_in_doubt' })
  })
})
