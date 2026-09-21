import { readChatFile } from './file-preview'
import { readMemories, saveMemories } from './memories'
// The browser-facing side of Chat v1: the WebSocket at /ws/chat (events
// down, commands up) and the REST routes under /api/chat.
//
// The WebSocket upgrade is held to the same trust boundary as every API
// request — allowed host, no cross-site fetch metadata, an Origin that
// matches the host — before the socket is accepted; a browser always sends
// Origin on an upgrade, so a missing one is accepted only from loopback like
// a CLI probe. Each command frame carries a client request id: an id the
// server already answered is answered again from a bounded cache instead of
// being executed twice, which is what makes resending after a reconnect safe.
// A subscriber that falls too far behind is disconnected rather than buffered
// without limit; it comes back and asks for everything after its last seq.

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { ATTACHMENT_MAX_BYTES, HttpError, enforceApiRequest, httpStatus, readBuffer, readJson, type ApiRequestPolicy } from '../http'
import { runFile } from '../process'
import { handleGhBody } from '../gh'
import { getChatSettings } from '../settings'
import { inspectCheckout } from './git'
import { CHAT_LIMITS, WS_PATH, type Attachment, type ChatCommand, type ChatEnvelope, type ClientFrame, type ServerFrame } from './protocol'
import { ChatError, type ChatRuntime } from './runtime'
import * as storage from './storage'
import { executeCommandOnce } from './command-receipts'
import { clientEnvelope } from './event-preview'

const MAX_CONNECTION_COMMANDS = 64
const REPLAY_BATCH = 100
const MAX_SUBSCRIPTIONS = 64
const SOCKET_BUFFER_LIMIT = 8 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function errorBody(error: unknown): { error: string, code?: string } {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof ChatError ? { error: message, code: error.code } : { error: message }
}

function errorStatus(error: unknown): number {
  if (error instanceof ChatError) return error.statusCode
  return httpStatus(error, 400)
}

// ── WebSocket ──────────────────────────────────────────────────────────────

interface Connection {
  socket: WebSocket
  subscriptions: Map<string, number>
  replays: Map<string, symbol>
  activeCommands: number
}

export class ChatSocketServer {
  private readonly wss: WebSocketServer
  private readonly connections = new Set<Connection>()
  private readonly serverStartedAt = `${new Date().toISOString()}:${randomUUID()}`
  private closing: Promise<void> | null = null
  private readonly upgrades = new Map<Server, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>()
  private readonly onEvent = (envelope: ChatEnvelope) => this.broadcast(envelope)
  private readonly onDeleted = (sessionId: string) => {
    for (const connection of this.connections) {
      connection.subscriptions.delete(sessionId)
      connection.replays.delete(sessionId)
    }
  }

  constructor(private readonly runtime: ChatRuntime, private readonly policy: ApiRequestPolicy = {}) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CHAT_LIMITS.frameBytes, perMessageDeflate: false })
    runtime.on('event', this.onEvent)
    runtime.on('deleted', this.onDeleted)
  }

  /** Attach to an HTTP server's upgrade event. Other upgrades (Vite HMR)
   *  are left alone. */
  attach(server: Server): void {
    if (this.upgrades.has(server)) return
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => { this.handleUpgrade(req, socket, head) }
    this.upgrades.set(server, listener)
    server.on('upgrade', listener)
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url || '').split('?')[0]
    if (path !== WS_PATH) return false
    if (this.closing) { socket.destroy(); return true }
    try {
      enforceApiRequest(req, this.policy)
      // enforceApiRequest lets an origin-less request through from loopback;
      // a browser always sends Origin on an upgrade, so that path is a CLI.
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 403
      socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : 'forbidden'}`)
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    return true
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = { socket, subscriptions: new Map(), replays: new Map(), activeCommands: 0 }
    this.connections.add(connection)
    this.send(connection, { kind: 'hello', instance: this.runtime.instance, serverStartedAt: this.serverStartedAt })
    socket.on('message', (data, isBinary) => {
      if (isBinary) { socket.close(1003, 'binary frames are not accepted'); return }
      if (connection.activeCommands >= MAX_CONNECTION_COMMANDS) { socket.close(1008, 'too many commands in flight'); return }
      connection.activeCommands++
      void this.onFrame(connection, data.toString('utf8'))
        .catch(() => socket.close(1011, 'command handling failed'))
        .finally(() => { connection.activeCommands-- })
    })
    socket.on('close', () => this.connections.delete(connection))
    socket.on('error', () => this.connections.delete(connection))
  }

  private send(connection: Connection, frame: ServerFrame): boolean {
    const { socket } = connection
    if (socket.readyState !== WebSocket.OPEN) return false
    const encoded = JSON.stringify(frame.kind === 'event' ? { ...frame, envelope: clientEnvelope(frame.envelope) } : frame)
    if (socket.bufferedAmount + Buffer.byteLength(encoded) > SOCKET_BUFFER_LIMIT) {
      socket.close(1013, 'subscriber is too far behind; reconnect and resubscribe from your last seq')
      return false
    }
    socket.send(encoded, error => { if (error) socket.terminate() })
    return true
  }

  private broadcast(envelope: ChatEnvelope): void {
    for (const connection of this.connections) {
      const last = connection.subscriptions.get(envelope.sessionId)
      if (last === undefined || connection.replays.has(envelope.sessionId)) continue
      if (envelope.seq <= last) continue
      if (envelope.seq > last + 1) {
        this.send(connection, { kind: 'gap', sessionId: envelope.sessionId, fromSeq: last, toSeq: envelope.seq })
      }
      if (this.send(connection, { kind: 'event', envelope })) connection.subscriptions.set(envelope.sessionId, envelope.seq)
    }
  }

  private async onFrame(connection: Connection, text: string): Promise<void> {
    let frame: ClientFrame
    try {
      frame = JSON.parse(text)
    } catch {
      connection.socket.close(1007, 'frame is not JSON')
      return
    }
    if (!frame || Array.isArray(frame) || typeof frame !== 'object' || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128
      || !frame.command || Array.isArray(frame.command) || typeof frame.command !== 'object' || typeof (frame.command as any).type !== 'string') {
      connection.socket.close(1007, 'malformed command frame')
      return
    }
    const execute = async (): Promise<Extract<ServerFrame, { kind: 'ack' }>> => {
      try {
        const result = await this.execute(connection, frame.command)
        return { kind: 'ack', id: frame.id, ok: true, result }
      } catch (error) {
        const body = errorBody(error)
        return { kind: 'ack', id: frame.id, ok: false, error: body.error, code: body.code }
      }
    }
    // Subscription state belongs to a socket and must be registered again
    // after reconnect; only mutations use durable at-most-once receipts.
    const local = ['subscribe', 'unsubscribe', 'session.list'].includes(frame.command.type)
    const ack = await (local ? execute() : executeCommandOnce(this.runtime.instance, frame.id, frame.command, execute))
    this.send(connection, ack)
  }

  private async execute(connection: Connection, command: ChatCommand): Promise<unknown> {
    const runtime = this.runtime
    switch (command.type) {
      case 'subscribe': {
        const sessionId = String(command.sessionId || '')
        const afterSeq = Number.isSafeInteger(command.afterSeq) && command.afterSeq >= 0 ? command.afterSeq : 0
        const session = runtime.get(sessionId)
        if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
        if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS && !connection.subscriptions.has(sessionId)) {
          throw new ChatError(429, 'too many subscriptions on one connection', 'invalid')
        }
        if (afterSeq > session.lastSeq) throw new ChatError(400, 'subscription sequence is beyond the transcript', 'invalid')
        const generation = Symbol(sessionId)
        connection.replays.set(sessionId, generation)
        connection.subscriptions.set(sessionId, afterSeq)
        let cursor = afterSeq
        try {
          while (connection.socket.readyState === WebSocket.OPEN && connection.replays.get(sessionId) === generation) {
            const page = storage.listEvents(sessionId, cursor, REPLAY_BATCH)
            for (const envelope of page.events) {
              if (!this.send(connection, { kind: 'event', envelope })) return { session, lastSeq: cursor }
              cursor = envelope.seq
              connection.subscriptions.set(sessionId, cursor)
            }
            // No await between the final page and live registration. Events
            // arriving while we yielded are read from the mirror next time.
            if (!page.truncated) break
            await new Promise<void>(resolve => setImmediate(resolve))
          }
        } finally {
          if (connection.replays.get(sessionId) === generation) connection.replays.delete(sessionId)
        }
        return { session, lastSeq: cursor }
      }
      case 'unsubscribe':
        connection.subscriptions.delete(String(command.sessionId || ''))
        connection.replays.delete(String(command.sessionId || ''))
        return {}
      case 'session.list':
        return { sessions: runtime.list() }
      case 'session.new': {
        return { session: await runtime.create(localSessionRequest(command)) }
      }
      case 'session.resume':
        return { session: await runtime.resume(String(command.id || '')) }
      case 'session.fork':
        return { session: await runtime.fork(String(command.id || '')) }
      case 'session.close':
        return { session: await runtime.close(String(command.id || '')) }
      case 'session.delete':
        await runtime.delete(String(command.id || ''))
        return {}
      case 'session.rename':
        return { session: await runtime.rename(String(command.id || ''), String(command.title || '')) }
      case 'prompt':
        return await runtime.prompt(String(command.sessionId || ''), {
          text: String(command.text || ''),
          attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter((m) => m && typeof m.path === 'string').slice(0, 50) : [],
        })
      case 'queue.add':
        return { queue: await runtime.enqueue(String(command.sessionId || ''), String(command.itemId || ''), {
          text: String(command.text || ''), attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter(m => m && typeof m.path === 'string').slice(0, 50) : [],
        }, command.model, command.effort) }
      case 'queue.update':
        return { queue: await runtime.updateQueue(String(command.sessionId || ''), String(command.itemId || ''), String(command.model || ''), command.effort) }
      case 'queue.remove':
        return { queue: runtime.removeQueue(String(command.sessionId || ''), String(command.itemId || '')) }
      case 'steer':
        await runtime.steer(String(command.sessionId || ''), String(command.text || ''))
        return {}
      case 'cancel':
        return await runtime.cancel(String(command.sessionId || ''))
      case 'permission.respond':
        runtime.respondPermission(String(command.sessionId || ''), String(command.id || ''), String(command.optionId || ''))
        return {}
      case 'question.answer':
        runtime.answerQuestion(String(command.sessionId || ''), String(command.id || ''), command.answers)
        return {}
      case 'set_model':
        return { session: await runtime.setModel(String(command.sessionId || ''), String(command.model || ''), command.effort ? String(command.effort) : undefined) }
      case 'set_safe_mode':
        return await runtime.setSafeMode(String(command.sessionId || ''), command.enabled)
      case 'set_auto_merge':
        return await runtime.setAutoMerge(String(command.sessionId || ''), command.enabled)
      case 'set_mode':
        await runtime.setMode(String(command.sessionId || ''), String(command.mode || ''))
        return {}
      case 'revert':
        await runtime.revert(String(command.sessionId || ''), String(command.diffId || ''))
        return {}
      case 'poise.change': {
        // Only these three fields exist: the browser never names a
        // repository, branch or path for a change — the controller does.
        const changeId = String(command.changeId || '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(changeId)) throw new ChatError(400, 'changeId must be a UUID', 'invalid')
        const result: import('./protocol').PoiseChangeAck = await runtime.startPoiseChange(String(command.sessionId || ''), String(command.text || ''), changeId, {
          attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter(m => m && typeof m.path === 'string').slice(0, 50) : [],
        })
        return result
      }
      default:
        throw new ChatError(400, `unknown command ${String((command as any).type)}`, 'invalid')
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.runtime.off('event', this.onEvent)
    this.runtime.off('deleted', this.onDeleted)
    for (const [server, listener] of this.upgrades) server.off('upgrade', listener)
    this.upgrades.clear()
    this.closing = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        for (const connection of this.connections) connection.socket.terminate()
      }, 500)
      timer.unref()
      for (const connection of this.connections) connection.socket.close(1001, 'server shutting down')
      this.wss.close(() => { clearTimeout(timer); this.connections.clear(); resolve() })
    })
    return this.closing
  }

}

function validAttachments(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw new ChatError(400, 'attachments must be an array of at most 20 uploaded files', 'invalid')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new ChatError(400, 'invalid attachment', 'invalid')
    const a = item as Record<string, unknown>
    if (typeof a.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.id)
      || typeof a.name !== 'string' || !a.name || a.name.length > 200
      || typeof a.path !== 'string' || !a.path || a.path.length > 1024
      || typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > CHAT_LIMITS.attachmentBytes) {
      throw new ChatError(400, 'attachment must match a file uploaded to this session', 'invalid')
    }
    // The runtime looks up this server-issued ID and reads the authoritative
    // bytes under its checkout lease. Never forward browser-supplied text.
    return { id: a.id, name: a.name, path: a.path, size: a.size }
  })
}

// ── REST ───────────────────────────────────────────────────────────────────

async function listFiles(checkout: string, query: string): Promise<string[]> {
  const q = query.trim().toLowerCase()
  const tracked = (await runFile('git', ['ls-files', '-z'], { cwd: checkout, timeoutMs: 15_000, maxOutputBytes: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout.split('\0')
  const untracked = (await runFile('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: checkout, timeoutMs: 15_000, maxOutputBytes: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout.split('\0')
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of [tracked, untracked]) {
    for (const path of list) {
      if (!path || seen.has(path) || path.startsWith('.poise-chat/')) continue
      seen.add(path)
      if (!q || path.toLowerCase().includes(q)) out.push(path)
      if (out.length >= 50) return out
    }
  }
  return out
}

/** Handle /api/chat/* routes; returns false when the url is not ours. */
export async function handleChatApi(req: IncomingMessage, res: ServerResponse, url: string, runtime: ChatRuntime): Promise<boolean> {
  const path = url.split('?')[0]
  const query = new URLSearchParams(url.split('?')[1] || '')
  if (!path.startsWith('/api/chat/')) return false
  try {
    if (path === '/api/chat/memories') {
      if (req.method === 'GET') return json(res, 200, readMemories()), true
      if (req.method === 'PUT') return json(res, 200, saveMemories(await readJson(req))), true
      return json(res, 405, { error: 'Use GET or PUT for memories.' }), true
    }
    if (path === '/api/chat/agents' && req.method === 'GET') {
      const { agents, catalog } = await runtime.agents()
      const { resolveChoice } = await import('../models')
      const { getModelSettings } = await import('../settings')
      const { launchable } = await import('../review-model')
      const { claudeAuth } = await import('../claude-auth')
      const choice = resolveChoice(catalog, 'chat', getModelSettings().chat)
      const effective = launchable(catalog, undefined, choice)
      const fallbackReason = effective !== choice.default
        ? `${choice.default} needs the Claude.ai sign-in (${claudeAuth.snapshot().status}); ${choice.fallback} is available`
        : undefined
      const settings = getChatSettings()
      return json(res, 200, {
        agents: agents.map((a) => ({ id: a.id, label: a.label, available: a.available, reason: a.reason, models: a.models, efforts: a.efforts })),
        defaults: { model: choice.default, fallback: choice.fallback, fallbackReason },
        settings,
      }), true
    }
    if (path === '/api/chat/repo' && req.method === 'GET') {
      const repo = query.get('repo') || ''
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ChatError(400, 'repo must be owner/name', 'invalid')
      const checkout = await runtime.checkoutFor(repo)
      const state = await inspectCheckout(checkout)
      let prs: Array<{ number: number, title: string, branch: string }> = []
      try {
        const result = await handleGhBody({ operation: 'list', record_type: 'pull_request', record_state: 'open', limit: 200 })
        const records = ((result.body as any)?.records || []) as Array<{ repo: string, number: number, title: string }>
        prs = records.filter((r) => r.repo === repo).map((r) => ({ number: r.number, title: r.title, branch: `github-interface-pr-${r.number}` }))
      } catch { /* the datastore is optional here */ }
      return json(res, 200, { checkout, currentBranch: state.currentBranch, defaultBranch: state.defaultBranch, dirty: state.dirty, dirtyFiles: state.dirtyFiles, branches: state.branches, prs }), true
    }
    if (path === '/api/chat/files' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      return json(res, 200, { files: await listFiles(session.checkout, query.get('q') || '') }), true
    }
    if (path === '/api/chat/file' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      return json(res, 200, await readChatFile(session.checkout, query.get('path') || '')), true
    }
    if (path === '/api/chat/diff' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      const diffId = query.get('id') || ''
      if (!diffId || diffId.length > 200) throw new ChatError(400, 'invalid diff ID', 'invalid')
      const diff = storage.getDiffEvent(session.id, diffId)
      if (!diff) throw new ChatError(404, 'unknown diff', 'unknown_diff')
      return json(res, 200, { diff }), true
    }
    if (path === '/api/chat/attachments' && req.method === 'POST') {
      const body = await readBuffer(req, ATTACHMENT_MAX_BYTES)
      const attachment = await runtime.saveAttachment(query.get('session') || '', query.get('filename') || '', body)
      return json(res, 200, { attachment }), true
    }
    if (path === '/api/chat/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: runtime.list(), instance: runtime.instance }), true
    }
    if (path === '/api/chat/sessions' && req.method === 'POST') {
      const body = await readJson<any>(req)
      const session = await runtime.create(localSessionRequest(body))
      return json(res, 201, { session }), true
    }
    const match = path.match(/^\/api\/chat\/sessions\/([0-9a-f-]{36})(?:\/([a-z]+))?$/)
    if (match) {
      const [, id, action] = match
      if (!action && req.method === 'GET') {
        const session = runtime.get(id)
        if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
        const after = Number(query.get('after') || 0)
        const { events, truncated } = runtime.events(id, Number.isSafeInteger(after) && after >= 0 ? after : 0)
        return json(res, 200, { session, events: events.map(clientEnvelope), truncated }), true
      }
      if (!action && req.method === 'PATCH') {
        const body = await readJson<any>(req)
        return json(res, 200, { session: await runtime.rename(id, String(body.title || '')) }), true
      }
      if (!action && req.method === 'DELETE') {
        await runtime.delete(id)
        return json(res, 200, { ok: true }), true
      }
      if (action && req.method === 'POST') {
        if (action === 'resume') return json(res, 200, { session: await runtime.resume(id) }), true
        if (action === 'fork') return json(res, 200, { session: await runtime.fork(id) }), true
        if (action === 'close') return json(res, 200, { session: await runtime.close(id) }), true
        if (action === 'cancel') return json(res, 200, await runtime.cancel(id)), true
        if (action === 'handoff') {
          const body = await readJson<any>(req)
          return json(res, 200, { session: await runtime.handoff(id, { agent: body.agent, model: String(body.model || ''), effort: body.effort ? String(body.effort) : undefined }) }), true
        }
      }
    }
    return json(res, 404, { error: 'chat route not found' }), true
  } catch (error) {
    return json(res, errorStatus(error), errorBody(error)), true
  }
}

function sanitizeContext(value: any): import('./protocol').SessionContext | undefined {
  const kind = value.kind
  if (kind !== 'card' && kind !== 'document' && kind !== 'handoff') return undefined
  return {
    kind,
    title: String(value.title || '').slice(0, 300),
    body: typeof value.body === 'string' ? value.body.slice(0, 64 * 1024) : undefined,
    url: typeof value.url === 'string' && /^https:\/\/github\.com\//.test(value.url) ? value.url.slice(0, 500) : undefined,
    headSha: typeof value.headSha === 'string' && /^[0-9a-f]{40}$/.test(value.headSha) ? value.headSha : undefined,
    slug: typeof value.slug === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/.test(value.slug) ? value.slug : undefined,
    fromSession: typeof value.fromSession === 'string' && /^[0-9a-f-]{36}$/.test(value.fromSession) ? value.fromSession : undefined,
  }
}

/** Browser requests never choose a repository, branch or filesystem path. */
function localSessionRequest(body: any): import('./protocol').NewSessionRequest {
  return {
    agent: body.agent,
    model: String(body.model || ''),
    effort: body.effort ? String(body.effort) : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    context: body.context && typeof body.context === 'object' ? sanitizeContext(body.context) : undefined,
    deferStart: body.deferStart,
    fallbackModel: typeof body.fallbackModel === 'string' ? body.fallbackModel : undefined,
    ...(body.autoMerge !== undefined ? { autoMerge: body.autoMerge } : {}),
    ...(body.safeMode !== undefined ? { safeMode: body.safeMode } : {}),
  }
}
