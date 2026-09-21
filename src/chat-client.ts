// Chat view's connection to the session runtime: one WebSocket for events and
// commands, REST for everything that is a plain request/response (session
// list, creation, history, catalog). The wire vocabulary is
// server/chat/protocol.ts, imported as types only.
//
// The socket is treated as unreliable on purpose. Every command keeps its
// request id until an ack arrives, so a reconnect can resend it with the same
// id and the server answers from its cache instead of running it twice. Each
// open session remembers the last `seq` it saw and re-subscribes from there,
// so a browser that dropped off mid-turn re-joins the turn instead of
// replaying it. A `gap` frame means the server dropped events for a slow
// subscriber; the missing range is refetched over REST.

import type {
  Attachment,
  MessageQueue,
  ChatCommand,
  ChatEnvelope,
  ClientFrame,
  NewSessionRequest,
  ServerFrame,
  SessionRecord,
  AgentId,
  PoiseChangeAck,
  AutoMergeAck,
  SafeModeAck,
} from '../server/chat/protocol'
import type { SelfChange, SelfUpdateStatus } from './self-update-types'
import { parseMessageQueue } from './chat-queue'
import { parseChange, parseSelfUpdateStatus } from './self-update-state'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface AgentModel { identity: string, selector: string, effort: string }
export interface AgentInfo {
  id: string
  label: string
  available: boolean
  reason?: string
  models: AgentModel[]
  efforts: string[]
}
export interface AgentsResponse {
  agents: AgentInfo[]
  defaults: { model: string, fallback: string, fallbackReason?: string }
  settings: { branchPrefix: string, idleTimeoutMinutes: number }
}
export interface RepoInfo {
  checkout: string
  currentBranch: string
  defaultBranch: string
  dirty: boolean
  dirtyFiles: number
  branches: string[]
  prs: { number: number, title: string, branch: string }[]
}

export class ChatCommandError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

export class ChatHttpError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Pending {
  frame: ClientFrame
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ChatClientEvents {
  /** A transcript event for a subscribed session, in seq order, never repeated. */
  event: (envelope: ChatEnvelope) => void
  connection: (state: ConnectionState) => void
  /** The server's start time changed between hellos: it restarted, and the
   *  session list may have changed underneath us. */
  restart: () => void
}

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 10_000
const MAX_PENDING = 128
const MAX_BUFFERED_EVENTS = 2_000
const COMMAND_TIMEOUT_MS = 120_000

function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function readError(res: Response): Promise<ChatHttpError> {
  let message = `HTTP ${res.status}`
  let code: string | undefined
  try {
    const data = await res.json()
    if (data && typeof data.error === 'string') message = data.error
    if (data && typeof data.code === 'string') code = data.code
  } catch { /* keep the status */ }
  return new ChatHttpError(res.status, message, code)
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw await readError(res)
  return res.json() as Promise<T>
}

function post<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return jsonFetch<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export class ChatClient {
  private socket: WebSocket | null = null
  private state: ConnectionState = 'closed'
  private backoff = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private pending = new Map<string, Pending>()
  /** Sessions the view wants live events for, with the last seq seen. */
  private subscriptions = new Map<string, number>()
  private serverStartedAt: string | null = null
  private serverInstance: string | null = null
  private handshakeReady = false
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private bufferedEvents = new Map<string, Map<number, ChatEnvelope>>()
  private listeners: { [K in keyof ChatClientEvents]: Set<ChatClientEvents[K]> } = {
    event: new Set(),
    connection: new Set(),
    restart: new Set(),
  }
  /** Gap refills in flight, so one slow subscriber does not fan out fetches. */
  private refilling = new Set<string>()

  on<K extends keyof ChatClientEvents>(name: K, fn: ChatClientEvents[K]): () => void {
    const set = this.listeners[name] as Set<ChatClientEvents[K]>
    set.add(fn)
    return () => { set.delete(fn) }
  }

  connectionState(): ConnectionState { return this.state }

  // ── Socket lifecycle ───────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    const s = this.socket
    this.socket = null
    if (s) { s.onclose = null; s.close() }
    this.clearHandshake()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new ChatCommandError('Chat disconnected before the command was acknowledged; check the session before repeating it', 'command_in_doubt'))
    }
    this.pending.clear()
    this.bufferedEvents.clear()
    this.setState('closed')
  }

  private open(): void {
    if (this.stopped) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket
    try {
      socket = new WebSocket(`${proto}://${location.host}/ws/chat`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.setState('connecting')
    this.clearHandshake()
    socket.onopen = () => {
      if (this.socket !== socket) return
      // The TCP/WebSocket connection is not the application handshake.
      // Never resend a mutation until the server identifies its instance.
      this.handshakeTimer = setTimeout(() => {
        if (this.socket === socket && !this.handshakeReady) socket.close(4000, 'Chat handshake timed out')
      }, 10_000)
    }
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      let frame: ServerFrame
      try { frame = JSON.parse(String(ev.data)) } catch { return }
      if (frame && typeof frame === 'object' && typeof frame.kind === 'string') this.handleFrame(frame)
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearHandshake()
      this.setState('closed')
      this.scheduleReconnect()
    }
    socket.onerror = () => { /* onclose follows and schedules the retry */ }
  }

  private clearHandshake(): void {
    this.handshakeReady = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    for (const fn of this.listeners.connection) fn(next)
  }

  private sendFrame(frame: ClientFrame): boolean {
    const s = this.socket
    if (!s || s.readyState !== WebSocket.OPEN || !this.handshakeReady) return false
    try { s.send(JSON.stringify(frame)); return true } catch { return false }
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.kind) {
      case 'hello': {
        if (this.handshakeReady || typeof frame.serverStartedAt !== 'string' || typeof frame.instance !== 'string') return
        const restarted = this.serverStartedAt !== null && this.serverStartedAt !== frame.serverStartedAt
        const changedInstance = this.serverInstance !== null && this.serverInstance !== frame.instance
        this.serverStartedAt = frame.serverStartedAt
        this.serverInstance = frame.instance
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        this.handshakeReady = true
        this.backoff = BACKOFF_MIN_MS
        if (changedInstance) {
          // Another database cannot have this server's receipts. Refuse to
          // transplant unacknowledged commands into an unrelated runtime.
          for (const p of this.pending.values()) {
            clearTimeout(p.timer)
            p.reject(new ChatCommandError('the Chat server instance changed; the previous command was not replayed', 'command_in_doubt'))
          }
          this.pending.clear()
          this.bufferedEvents.clear()
        }
        if (restarted || changedInstance) for (const fn of this.listeners.restart) fn()
        for (const [sessionId, afterSeq] of this.subscriptions) {
          this.sendFrame({ id: requestId(), command: { type: 'subscribe', sessionId, afterSeq } })
        }
        // Durable server receipts return the prior result, or an explicit
        // in-doubt result after a crash; a retry can never start work twice.
        for (const p of this.pending.values()) this.sendFrame(p.frame)
        this.setState('open')
        return
      }
      case 'ack': {
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.result)
        else p.reject(new ChatCommandError(frame.error, frame.code))
        return
      }
      case 'event': {
        this.deliver(frame.envelope)
        return
      }
      case 'gap': {
        void this.refill(frame.sessionId)
        return
      }
    }
  }

  private deliver(envelope: ChatEnvelope): void {
    if (!envelope || !Number.isSafeInteger(envelope.seq) || envelope.seq < 1) return
    const last = this.subscriptions.get(envelope.sessionId)
    if (last === undefined || envelope.seq <= last) return
    let buffered = this.bufferedEvents.get(envelope.sessionId)
    if (!buffered) { buffered = new Map(); this.bufferedEvents.set(envelope.sessionId, buffered) }
    buffered.set(envelope.seq, envelope)
    if (buffered.size > MAX_BUFFERED_EVENTS) {
      // Keep the contiguous watermark and replay from there on reconnect.
      this.bufferedEvents.delete(envelope.sessionId)
      this.socket?.close(4001, 'transcript replay required')
      return
    }
    let cursor = last
    while (buffered.has(cursor + 1)) {
      const next = buffered.get(++cursor)!
      buffered.delete(cursor)
      this.subscriptions.set(envelope.sessionId, cursor)
      for (const fn of this.listeners.event) fn(next)
    }
    if (buffered.size) void this.refill(envelope.sessionId)
    else this.bufferedEvents.delete(envelope.sessionId)
  }

  /** Pull everything after the last seen seq over REST and deliver it in order. */
  private async refill(sessionId: string): Promise<void> {
    if (this.refilling.has(sessionId) || !this.subscriptions.has(sessionId)) return
    this.refilling.add(sessionId)
    try {
      for (let guard = 0; guard < 50; guard++) {
        const after = this.subscriptions.get(sessionId)
        if (after === undefined) return
        const page = await this.fetchSession(sessionId, after)
        for (const env of page.events) this.deliver(env)
        if (!page.truncated || !page.events.length) {
          if (this.bufferedEvents.get(sessionId)?.size) this.socket?.close(4002, 'transcript gap remains; reconnecting')
          return
        }
      }
    } catch (err) {
      console.error('[chat] gap refill failed:', err)
      this.socket?.close(4002, 'transcript refill failed; reconnecting')
    } finally {
      this.refilling.delete(sessionId)
    }
  }

  // ── Commands and subscriptions ─────────────────────────────────────────

  send(command: ChatCommand): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new ChatCommandError('too many commands are awaiting acknowledgement', 'overloaded'))
    return new Promise((resolve, reject) => {
      const frame: ClientFrame = { id: requestId(), command }
      const timer = setTimeout(() => {
        if (!this.pending.delete(frame.id)) return
        reject(new ChatCommandError('the command was not acknowledged; it may have reached the agent. Check the session before repeating it', 'command_in_doubt'))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(frame.id, { frame, resolve, reject, timer })
      this.sendFrame(frame)
      if (this.stopped) this.start()
    })
  }

  /** Commands sent and not yet acknowledged; a reload while any exist could
   *  lose the answer to something that already reached the agent. */
  pendingCount(): number {
    return this.pending.size
  }

  /** Start one Poise self-change from `sessionId`. `changeId` is minted once
   *  in the browser and kept for any retry, so the durable receipt answers a
   *  resend instead of preparing a second change. The ack carries the new
   *  dedicated session and the change record; anything else is an error. */
  async startPoiseChange(sessionId: string, text: string, changeId: string, context?: Pick<import('../server/chat/protocol').PromptInput, 'attachments' | 'mentions'>): Promise<PoiseChangeAck> {
    const result = await this.send({ type: 'poise.change', sessionId, text, changeId, ...(context?.attachments.length || context?.mentions.length ? context : {}) }) as { session?: unknown, change?: unknown } | null
    const change = parseChange(result?.change)
    const session = result?.session && typeof result.session === 'object' ? result.session as SessionRecord : null
    if (!session || typeof session.id !== 'string' || !change) {
      throw new ChatCommandError('the server accepted the change but did not describe it; check the session list before repeating it', 'command_in_doubt')
    }
    return { session, change }
  }

  async queueCommand(command: Extract<ChatCommand, { type: 'queue.add' | 'queue.update' | 'queue.remove' }>): Promise<MessageQueue> {
    const answer = await this.send(command) as { queue?: unknown } | null
    const queue = parseMessageQueue(answer?.queue)
    if (!queue) throw new ChatCommandError('The queue was not acknowledged. Your message has been kept; retrying uses the same item ID.', 'command_in_doubt')
    return queue
  }

  /** Whether a session is subscribed, and from which seq. */
  subscribedAfter(sessionId: string): number | undefined {
    return this.subscriptions.get(sessionId)
  }

  /** Start receiving events for a session from `afterSeq` (exclusive). Events
   *  already delivered for the session are never repeated. */
  subscribe(sessionId: string, afterSeq: number): void {
    const current = this.subscriptions.get(sessionId)
    if (current !== undefined && current >= afterSeq) return
    this.subscriptions.set(sessionId, afterSeq)
    this.bufferedEvents.delete(sessionId)
    this.sendFrame({ id: requestId(), command: { type: 'subscribe', sessionId, afterSeq } })
    if (this.stopped) this.start()
  }

  unsubscribe(sessionId: string): void {
    if (!this.subscriptions.delete(sessionId)) return
    this.bufferedEvents.delete(sessionId)
    this.sendFrame({ id: requestId(), command: { type: 'unsubscribe', sessionId } })
  }

  /** Forget every subscription; the caller re-subscribes from its own state. */
  resetSubscriptions(): void {
    this.subscriptions.clear()
    this.bufferedEvents.clear()
  }

  // ── REST ───────────────────────────────────────────────────────────────

  listSessions(): Promise<{ sessions: SessionRecord[], instance: string }> {
    return jsonFetch('/api/chat/sessions')
  }

  createSession(req: NewSessionRequest): Promise<{ session: SessionRecord }> {
    return post('/api/chat/sessions', req)
  }

  filePreview(sessionId: string, reference: string): Promise<import('./chat-file-reference').ChatFilePreview> {
    return jsonFetch(`/api/chat/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(reference)}`)
  }

  async fetchDiff(sessionId: string, diffId: string): Promise<Extract<ChatEnvelope['event'], { type: 'diff' }>> {
    const result = await jsonFetch<{ diff: Extract<ChatEnvelope['event'], { type: 'diff' }> }>(
      `/api/chat/diff?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(diffId)}`)
    return result.diff
  }

  fetchSession(id: string, after: number): Promise<{ session: SessionRecord, events: ChatEnvelope[], truncated?: boolean }> {
    return jsonFetch(`/api/chat/sessions/${encodeURIComponent(id)}?after=${after}`)
  }

  async setAutoMerge(sessionId: string, enabled: boolean): Promise<AutoMergeAck> {
    const result = await this.send({ type: 'set_auto_merge', sessionId, enabled }) as AutoMergeAck | undefined
    if (result?.session?.id !== sessionId || typeof result.session.autoMerge !== 'boolean') throw new Error('The server did not confirm the Auto-merge setting')
    return result
  }

  async setSafeMode(sessionId: string, enabled: boolean): Promise<SafeModeAck> {
    const result = await this.send({ type: 'set_safe_mode', sessionId, enabled }) as SafeModeAck | undefined
    if (result?.session?.id !== sessionId || typeof result.session.safeMode !== 'boolean') throw new Error('The server did not confirm Safe mode')
    return result
  }

  renameSession(id: string, title: string): Promise<{ session: SessionRecord }> {
    return post(`/api/chat/sessions/${encodeURIComponent(id)}`, { title }, 'PATCH')
  }

  deleteSession(id: string): Promise<{ ok: true }> {
    return jsonFetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  resumeSession(id: string): Promise<{ session: SessionRecord }> {
    return post(`/api/chat/sessions/${encodeURIComponent(id)}/resume`)
  }

  forkSession(id: string): Promise<{ session: SessionRecord }> {
    return post(`/api/chat/sessions/${encodeURIComponent(id)}/fork`)
  }

  closeSession(id: string): Promise<{ session: SessionRecord }> {
    return post(`/api/chat/sessions/${encodeURIComponent(id)}/close`)
  }

  handoffSession(id: string, to: { agent: AgentId, model: string, effort?: string }): Promise<{ session: SessionRecord }> {
    return post(`/api/chat/sessions/${encodeURIComponent(id)}/handoff`, to)
  }

  agents(): Promise<AgentsResponse> {
    return jsonFetch('/api/chat/agents')
  }

  repos(): Promise<{ repos: string[] }> {
    return jsonFetch('/api/repos')
  }

  repo(name: string): Promise<RepoInfo> {
    return jsonFetch(`/api/chat/repo?repo=${encodeURIComponent(name)}`)
  }

  files(sessionId: string, q: string): Promise<{ files: string[] }> {
    return jsonFetch(`/api/chat/files?session=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`)
  }

  // ── Self-improvement ────────────────────────────────────────────────────

  /** Status for the changes visible to one session. `null` means the feature
   *  is not there at all (older server, no bridge) — never an exception, so a
   *  missing supervisor leaves the view untouched. */
  async selfUpdateStatus(sessionId: string): Promise<SelfUpdateStatus | null> {
    const res = await fetch(`/api/self-update?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
    if (res.status === 404 || res.status === 501) return null
    if (!res.ok) throw await readError(res)
    let body: unknown = null
    try { body = await res.json() } catch { return null }
    return parseSelfUpdateStatus(body)
  }

  /** One-click rollback, bound to the exact release the card showed. The
   *  server deduplicates by change id; a repeated click shares the operation. */
  async revertSelfChange(changeId: string, expectedReleaseId: string): Promise<SelfChange> {
    const result = await post<{ change?: unknown }>('/api/self-update/revert', { changeId, expectedReleaseId })
    const change = parseChange(result?.change)
    if (!change) throw new ChatHttpError(200, 'the rollback was accepted but the server did not describe the change', 'invalid')
    return change
  }

  async uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
    const res = await fetch(
      `/api/chat/attachments?session=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    )
    if (!res.ok) throw await readError(res)
    const data = await res.json() as { attachment: Attachment }
    return data.attachment
  }
}

/** One client for the app; the view starts it when first shown. */
export const chatClient = new ChatClient()
