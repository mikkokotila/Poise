// Line-delimited JSON-RPC 2.0 over a child's stdio, as Grok (ACP), Codex
// (app-server) and Muse (MSP) all speak it. Bounded and cancellation-aware:
//
// - a frame longer than `maxLineBytes` — complete or a partial tail — fails
//   the link and terminates the peer; a frame that is not a JSON object is
//   dropped and counted;
// - every outbound request has a deadline and an optional AbortSignal; when
//   the link fails every pending request is rejected at once. `exit` alone
//   does not fail the link: stdout is read to EOF first so a final response
//   written just before exit is still delivered, and a peer that closes its
//   stdout while staying alive is treated as gone;
// - requests from the peer must carry a string or finite-number id, an id
//   already in flight is refused, and at most `maxInboundRequests` may be
//   outstanding; a method nobody registered is answered with -32601 so the
//   agent never waits forever; handlers still running when the link fails
//   get an aborted signal and their late answers are discarded;
// - writes honour stdin backpressure: a single frame over the bound is
//   refused before it is queued, and when the aggregate queue exceeds
//   `maxPendingWriteBytes` the peer is considered stuck and the link fails.
//
// Failing the link terminates the child (SIGTERM through the worker gate).
// Releasing the checkout the child was writing to is the runtime's job and
// happens only after the gate's process group is gone.

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface JsonRpcError { code: number, message: string, data?: unknown }

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'RpcError'
  }
}

export class RpcClosedError extends Error {
  constructor(message = 'peer exited') {
    super(message)
    this.name = 'RpcClosedError'
  }
}

export type RpcRequestHandler = (params: unknown, id: number | string, signal: AbortSignal) => Promise<unknown> | unknown
export type RpcNotificationHandler = (params: unknown) => void

export interface RpcOptions {
  /** Longest single frame accepted from, or sent to, the peer. */
  maxLineBytes?: number
  /** Bytes queued to the peer's stdin before the link is declared stuck. */
  maxPendingWriteBytes?: number
  /** Default per-request deadline; adapters pass their own for turns. */
  requestTimeoutMs?: number
  /** Inbound requests that may be outstanding at once. */
  maxInboundRequests?: number
  /** Name for error messages. */
  label?: string
  /** Called with each stderr chunk. */
  onStderr?: (text: string) => void
  /** Grace after `exit` for stdout to reach EOF before the link fails. */
  exitDrainMs?: number
}

const DEFAULT_MAX_LINE = 8 * 1024 * 1024
const DEFAULT_MAX_PENDING_WRITE = 16 * 1024 * 1024
const DEFAULT_TIMEOUT = 5 * 60_000
const DEFAULT_MAX_INBOUND = 64
const DEFAULT_EXIT_DRAIN_MS = 500
const STDERR_TAIL = 8 * 1024

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

function validId(value: unknown): value is number | string {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256)
    || (typeof value === 'number' && Number.isFinite(value))
}

export class StdioRpc extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private readonly requestHandlers = new Map<string, RpcRequestHandler>()
  private readonly notificationHandlers = new Map<string, RpcNotificationHandler>()
  private readonly inbound = new Set<string>()
  private readonly inboundAbort = new AbortController()
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false
  private closeReason: Error | null = null
  private pendingWriteBytes = 0
  private stderrTail = ''
  private stdoutEnded = false
  private exitInfo: { code: number | null, signal: NodeJS.Signals | null } | null = null
  readonly droppedFrames = { count: 0 }
  private readonly options: Required<Omit<RpcOptions, 'onStderr'>> & Pick<RpcOptions, 'onStderr'>

  constructor(readonly child: ChildProcess, options: RpcOptions = {}) {
    super()
    this.options = {
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE,
      maxPendingWriteBytes: options.maxPendingWriteBytes ?? DEFAULT_MAX_PENDING_WRITE,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT,
      maxInboundRequests: options.maxInboundRequests ?? DEFAULT_MAX_INBOUND,
      label: options.label ?? 'agent',
      onStderr: options.onStderr,
      exitDrainMs: options.exitDrainMs ?? DEFAULT_EXIT_DRAIN_MS,
    }
    if (!child.stdout || !child.stdin) throw new Error('rpc peer must have piped stdio')
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stdout.on('error', (error) => this.fail(error))
    child.stdout.once('end', () => this.onStdoutEnd())
    child.stdout.once('close', () => this.onStdoutEnd())
    child.stdin.on('error', (error) => this.fail(error))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL)
      this.options.onStderr?.(text)
    })
    child.once('exit', (code, signal) => this.onExit(code, signal))
    child.once('error', (error) => this.fail(error))
  }

  get isClosed(): boolean { return this.closed }
  get stderr(): string { return this.stderrTail }

  onRequest(method: string, handler: RpcRequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: RpcNotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  /** Send a request and wait for its result. */
  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number, signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closeReason ?? new RpcClosedError())
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        reject(abortError(options.signal!))
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = null
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup })
      // A frame that cannot be serialized or is over the bound never reaches
      // the peer; the caller learns at once and nothing is left pending.
      const error = this.write({ jsonrpc: '2.0', id, method, params: params ?? {} })
      if (error) {
        this.pending.delete(id)
        cleanup()
        reject(error)
        return
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          reject(new RpcError(-32000, `${this.options.label}: ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  /** Answer a request the peer sent us. */
  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number | string, error: JsonRpcError): void {
    this.write({ jsonrpc: '2.0', id, error })
  }

  /** Returns the error instead of throwing so callers decide what to unwind. */
  private write(message: unknown): Error | null {
    if (this.closed) return this.closeReason ?? new RpcClosedError()
    if (!this.child.stdin || this.child.stdin.destroyed) return new RpcClosedError(`${this.options.label} stdin is closed`)
    let line: string
    try {
      line = JSON.stringify(message) + '\n'
    } catch (error) {
      return new RpcError(-32700, `${this.options.label}: frame is not serializable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const bytes = Buffer.byteLength(line)
    if (bytes > this.options.maxLineBytes) {
      return new RpcError(-32000, `${this.options.label}: outbound frame of ${bytes} bytes exceeds ${this.options.maxLineBytes}`)
    }
    this.pendingWriteBytes += bytes
    if (this.pendingWriteBytes > this.options.maxPendingWriteBytes) {
      const stuck = new RpcClosedError(`${this.options.label} stopped reading its stdin (${this.pendingWriteBytes} bytes queued)`)
      this.fail(stuck)
      return stuck
    }
    try {
      this.child.stdin.write(line, () => { this.pendingWriteBytes -= bytes })
    } catch (error) {
      this.pendingWriteBytes -= bytes
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fail(failure)
      return failure
    }
    return null
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let start = 0
    while (true) {
      const newline = this.buffer.indexOf(10, start)
      if (newline === -1) break
      const line = this.buffer.subarray(start, newline)
      start = newline + 1
      if (line.length > this.options.maxLineBytes) {
        this.fail(new RpcClosedError(`${this.options.label} sent a frame over ${this.options.maxLineBytes} bytes`))
        return
      }
      this.handleLine(line.toString('utf8'))
      if (this.closed) return
    }
    const tail = this.buffer.length - start
    // The unterminated remainder is bounded like a complete frame would be.
    if (tail > this.options.maxLineBytes) {
      this.fail(new RpcClosedError(`${this.options.label} sent a frame over ${this.options.maxLineBytes} bytes`))
      return
    }
    this.buffer = tail === 0 ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(start)) as Buffer
  }

  private onStdoutEnd(): void {
    if (this.stdoutEnded) return
    this.stdoutEnded = true
    if (this.closed) return
    this.fail(new RpcClosedError(this.exitInfo
      ? `${this.options.label} exited (${this.exitInfo.code ?? this.exitInfo.signal ?? 'unknown'})${this.stderrSuffix()}`
      : `${this.options.label} closed its stdout${this.stderrSuffix()}`))
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitInfo = { code, signal }
    if (this.closed || this.stdoutEnded) return
    // Let buffered stdout reach EOF first: a final answer written just
    // before exit must still settle its request. If EOF never comes, give up.
    const timer = setTimeout(() => this.onStdoutEnd(), this.options.exitDrainMs)
    timer.unref()
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail ? `: ${tail.split('\n').slice(-3).join(' | ')}` : ''
  }

  private handleLine(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    let message: any
    try { message = JSON.parse(trimmed) } catch {
      this.droppedFrames.count += 1
      this.emit('malformed', trimmed.slice(0, 200))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.droppedFrames.count += 1
      this.emit('malformed', trimmed.slice(0, 200))
      return
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) this.handleRequest(message)
      else this.handleNotification(message)
      return
    }
    if (message.id !== undefined && message.id !== null) {
      if (!validId(message.id)) {
        this.droppedFrames.count += 1
        this.emit('malformed', 'response with invalid id')
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        this.emit('orphan-response', message.id)
        return
      }
      this.pending.delete(message.id)
      pending.cleanup()
      if (message.error && typeof message.error === 'object') {
        pending.reject(new RpcError(Number(message.error.code) || -32000, String(message.error.message || 'rpc error'), message.error.data))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    this.droppedFrames.count += 1
    this.emit('malformed', trimmed.slice(0, 200))
  }

  private handleRequest(message: { id: unknown, method: string, params?: unknown }): void {
    if (!validId(message.id)) {
      this.droppedFrames.count += 1
      this.emit('malformed', `request ${message.method} with invalid id`)
      return
    }
    const id = message.id
    const key = `${typeof id}:${String(id)}`
    if (this.inbound.has(key)) {
      this.emit('duplicate-request', id)
      this.respondError(id, { code: -32600, message: `request id ${String(id)} is already in flight` })
      return
    }
    if (this.inbound.size >= this.options.maxInboundRequests) {
      this.respondError(id, { code: -32000, message: `too many outstanding requests (${this.options.maxInboundRequests})` })
      return
    }
    const handler = this.requestHandlers.get(message.method)
    if (!handler) {
      this.emit('unknown-method', message.method)
      this.respondError(id, { code: -32601, message: `Method not found: ${message.method}` })
      return
    }
    this.inbound.add(key)
    Promise.resolve()
      .then(() => handler(message.params, id, this.inboundAbort.signal))
      .then(
        (result) => {
          this.inbound.delete(key)
          if (!this.closed) this.respond(id, result ?? {})
        },
        (error: unknown) => {
          this.inbound.delete(key)
          if (this.closed) return
          const rpcError = error instanceof RpcError
            ? { code: error.code, message: error.message, data: error.data }
            : { code: -32000, message: error instanceof Error ? error.message : String(error) }
          this.respondError(id, rpcError)
        },
      )
  }

  private handleNotification(message: { method: string, params?: unknown }): void {
    const handler = this.notificationHandlers.get(message.method)
    if (handler) {
      try { handler(message.params) } catch (error) { this.emit('handler-error', error) }
      return
    }
    // Only the method name is surfaced: an unknown notification's params can
    // carry anything, including the user's MCP configuration and its secrets.
    this.emit('unhandled-notification', message.method)
  }

  /** Fail every pending request, abort running handlers, stop reading and
   *  terminate the peer. Idempotent. */
  fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = error
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
    this.inboundAbort.abort(error)
    this.inbound.clear()
    try { this.child.stdout?.removeAllListeners('data') } catch { /* closing */ }
    if (!this.exitInfo && !this.child.killed) {
      try { this.child.kill('SIGTERM') } catch { /* already gone */ }
    }
    this.emit('close', error)
  }

  /** Close stdin so a well-behaved peer exits on its own. */
  end(): void {
    try { this.child.stdin?.end() } catch { /* already closed */ }
  }
}

function abortError(signal: AbortSignal): Error {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}
