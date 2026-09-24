// Poise self-improvement, as the running app sees it: the public status a
// Chat session may ask about and the one-click revert it may request, the
// private drain/readiness/resume endpoints the release controller calls with
// the bridge key before it restarts this server, and the drain gate the API
// middleware consults. Authority stays with the controller: the app never
// holds the release token, never chooses a repository and never decides a
// merge or a deploy; it reports what it observes and refuses what it must.
//
// Public routes carry the same trust boundary as every /api request (host,
// origin, fetch metadata) plus session ownership: a session id names which
// changes are visible, and a change belongs to a session only when the
// controller recorded it against this server's instance and that session.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildIdentity } from './build-identity'
import { HttpError, httpStatus, readJson } from './http'
import { ChatError, type ChatRuntime } from './chat/runtime'
import * as storage from './chat/storage'
import { pauseReleaseBackground, releaseBackgroundBusy, resumeReleaseBackground } from './release-background'
import {
  RELEASE_ID_PATTERN, SelfUpdateBridgeError, SelfUpdateUnavailableError, UUID_PATTERN,
  createSelfUpdateBridge, resolveSelfUpdateRoot, type SelfUpdateBridge,
} from './self-update-bridge'
import type { BuildIdentity, SelfChange, SelfUpdateStatus } from '../src/self-update-types'

export { createSelfUpdateBridge, resolveSelfUpdateRoot, unconfiguredSelfUpdateBridge, type SelfUpdateBridge } from './self-update-bridge'

export const RELEASE_KEY_HEADER = 'x-poise-release-key'
const CONTROL_ROUTES = new Set(['/api/self-update/readiness', '/api/self-update/drain', '/api/self-update/resume'])
/** Mutations still accepted while draining: they settle work or roll back. */
const DRAIN_ALLOWED = [
  /^\/api\/self-update\/revert$/,
  /^\/api\/chat\/sessions\/[0-9a-f-]{36}\/(cancel|close)$/,
  /^\/api\/agent-stop$/,
]
const OUTBOX_FLUSH_INTERVAL_MS = 15_000

export interface ReadinessReport {
  /** True only while draining and nothing that a restart would cut is running. */
  ready: boolean
  busy: number
  build: BuildIdentity
  draining: boolean
  releaseId?: string
}

export interface SelfUpdateHealthSummary { configured: boolean, draining: boolean }

/** The controller's own endpoints, never counted as API writes. */
export function isSelfUpdateControlRoute(path: string): boolean {
  return CONTROL_ROUTES.has(path)
}

export function drainAllowsPath(path: string): boolean {
  if (/^\/api\/jev\/runs\/[^/]+\/cancel$/.test(path)) return true
  return CONTROL_ROUTES.has(path) || DRAIN_ALLOWED.some((pattern) => pattern.test(path))
}

function disabledStatus(reason: string): SelfUpdateStatus {
  return { enabled: false, available: false, reason, activeRelease: null, previousRelease: null, hold: null, changes: [] }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const plain = address.replace(/^::ffff:/, '')
  return plain === '127.0.0.1' || plain === '::1'
}

function sameSecret(provided: string, expected: string): boolean {
  // Hash both so the comparison length never depends on what was sent.
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export class SelfUpdateService {
  private apiWrites = 0
  private lastFlush = 0

  constructor(
    private readonly runtime: ChatRuntime,
    private readonly bridge: SelfUpdateBridge,
    private readonly build: () => BuildIdentity = buildIdentity,
  ) {}

  get configured(): boolean {
    return this.bridge.configured
  }

  get draining(): boolean {
    return this.runtime.draining !== null
  }

  /** For /api/health: no controller IO, only what this process knows. */
  summary(): SelfUpdateHealthSummary {
    return { configured: this.bridge.configured, draining: this.draining }
  }

  /** Count one mutating API request until its handler has finished — not
   *  until the response closed, since a client can go away while the
   *  handler's writes are still settling. The returned release is
   *  idempotent. Called before the drain gate, so a request that got in
   *  just before the drain is always part of `busy`. */
  beginApiWrite(): () => void {
    this.apiWrites += 1
    let done = false
    return () => {
      if (done) return
      done = true
      this.apiWrites -= 1
    }
  }

  // ── Private: the controller with the bridge key ────────────────────────

  authorize(req: IncomingMessage): void {
    if (!this.bridge.configured) throw new HttpError(503, 'the self-update bridge is not configured on this server')
    const expected = this.bridge.readBridgeKey()
    if (!expected) throw new HttpError(503, 'the self-update bridge key is not installed')
    if (!isLoopback(req.socket?.remoteAddress)) throw new HttpError(403, 'release control is accepted from loopback only')
    const raw = req.headers[RELEASE_KEY_HEADER]
    const provided = Array.isArray(raw) ? raw[0] : raw
    if (typeof provided !== 'string' || !provided || !sameSecret(provided, expected)) throw new HttpError(401, 'invalid release key')
  }

  /** Busy is everything a restart would cut: the chat runtime's turns,
   *  startups and live agent processes, mutating API handlers still
   *  running, and process-owned background operations (behaviors,
   *  /content finalizer) that were admitted before the pause. */
  readiness(): ReadinessReport {
    const drain = this.runtime.draining
    const busy = this.runtime.busy() + this.apiWrites + releaseBackgroundBusy()
    return { ready: drain !== null && busy === 0, busy, build: this.build(), draining: drain !== null, ...(drain ? { releaseId: drain.releaseId } : {}) }
  }

  /** Stop admitting new work everywhere at once: background admission is
   *  paused before the runtime gate flips, so nothing admitted after this
   *  returns can start. Neither cancels anything already in progress. */
  drain(releaseId: string): ReadinessReport {
    if (!RELEASE_ID_PATTERN.test(releaseId)) throw new HttpError(400, 'releaseId is required')
    pauseReleaseBackground()
    this.runtime.startDrain(releaseId)
    return this.readiness()
  }

  resume(): ReadinessReport {
    this.runtime.endDrain()
    resumeReleaseBackground()
    return this.readiness()
  }

  /** On runtime stop: a paused background must not outlive the server
   *  object that paused it. */
  reset(): void {
    this.runtime.endDrain()
    resumeReleaseBackground()
  }

  // ── Public: a session's view ───────────────────────────────────────────

  /** Status for the browser. Without a session only the release facts are
   *  returned; with one, the changes it started or runs. A controller that
   *  is not installed or not answering is a disabled status, never an error. */
  async status(sessionId: string | null): Promise<SelfUpdateStatus> {
    const record = sessionId ? this.requireSession(sessionId) : null
    if (!this.bridge.configured) return disabledStatus('Poise self-improvement is not set up on this server: install and enable the self-update controller before using /poise')
    let status: SelfUpdateStatus
    try {
      status = await this.bridge.status()
    } catch (error) {
      if (error instanceof SelfUpdateUnavailableError) return disabledStatus(error.message)
      throw error
    }
    this.flushOutboxSoon()
    return { ...status, changes: record ? this.visibleChanges(status.changes, record.id, record.selfChangeId) : [] }
  }

  /** One-click rollback of the release a change produced. The change must
   *  be this instance's and this session's; the expected release id makes a
   *  stale card unable to roll back a newer change. */
  async revert(sessionId: string, changeId: string, expectedReleaseId: string): Promise<SelfChange> {
    if (!UUID_PATTERN.test(changeId)) throw new ChatError(400, 'changeId must be a UUID', 'invalid')
    if (!RELEASE_ID_PATTERN.test(expectedReleaseId)) throw new ChatError(400, 'expectedReleaseId is required', 'invalid')
    const record = this.requireSession(sessionId)
    if (!this.bridge.configured) throw new ChatError(503, 'Poise self-improvement is not set up on this server', 'self_update_unavailable')
    const status = await this.call(() => this.bridge.status())
    const change = this.visibleChanges(status.changes, record.id, record.selfChangeId).find((c) => c.id.toLowerCase() === changeId.toLowerCase())
    if (!change) throw new ChatError(404, 'this change does not belong to the session', 'invalid')
    return this.call(() => this.bridge.rollback(change.id, { expectedReleaseId }))
  }

  private requireSession(sessionId: string) {
    if (!UUID_PATTERN.test(sessionId)) throw new ChatError(400, 'session must be a session id', 'invalid')
    const record = this.runtime.get(sessionId) // throws for another instance's session
    if (!record) throw new ChatError(404, 'unknown session', 'unknown_session')
    return record
  }

  /** Changes recorded for this instance that the session started (its id is
   *  the change's source or bound session) or that a change session it
   *  spawned implements. */
  private visibleChanges(changes: SelfChange[], sessionId: string, selfChangeId: string | undefined): SelfChange[] {
    const linked = new Set<string>()
    if (selfChangeId) linked.add(selfChangeId.toLowerCase())
    for (const session of storage.listSessions(this.runtime.instance)) {
      if (session.selfChangeId && session.context?.kind === 'poise-change' && session.context.fromSession === sessionId) linked.add(session.selfChangeId.toLowerCase())
    }
    return changes.filter((change) => change.instance === this.runtime.instance
      && (change.sessionId === sessionId || linked.has(String(change.id).toLowerCase())))
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof SelfUpdateUnavailableError) throw new ChatError(503, error.message, 'self_update_unavailable')
      if (error instanceof SelfUpdateBridgeError) throw new ChatError(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502, error.message, 'agent_error')
      throw error
    }
  }

  /** Status polls double as the retry trigger for undelivered outcomes. */
  private flushOutboxSoon(): void {
    const now = Date.now()
    if (now - this.lastFlush < OUTBOX_FLUSH_INTERVAL_MS) return
    this.lastFlush = now
    void this.runtime.flushSelfUpdateOutbox().catch(() => undefined)
  }
}

/** The default service for a server: configured from the environment and
 *  the instance label, unconfigured (and silent) everywhere else. */
export function createSelfUpdateService(runtime: ChatRuntime, instanceLabel: string, bridge?: SelfUpdateBridge): SelfUpdateService {
  return new SelfUpdateService(runtime, bridge ?? createSelfUpdateBridge({ root: resolveSelfUpdateRoot(instanceLabel) }))
}

// ── Routes ─────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function errorResponse(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ChatError) return json(res, error.statusCode, { error: message, code: error.code })
  json(res, httpStatus(error, 400), { error: message })
}

/** Handle /api/self-update* routes; false when the url is not ours. The
 *  caller has already enforced the local trust boundary. */
export async function handleSelfUpdateApi(req: IncomingMessage, res: ServerResponse, url: string, service: SelfUpdateService): Promise<boolean> {
  const path = url.split('?')[0]
  const query = new URLSearchParams(url.split('?')[1] || '')
  if (path !== '/api/self-update' && !path.startsWith('/api/self-update/')) return false
  try {
    if (CONTROL_ROUTES.has(path)) {
      service.authorize(req)
      if (path === '/api/self-update/readiness' && req.method === 'GET') return json(res, 200, service.readiness()), true
      if (path === '/api/self-update/drain' && req.method === 'POST') {
        const body = await readJson<any>(req)
        return json(res, 200, service.drain(String(body?.releaseId || ''))), true
      }
      if (path === '/api/self-update/resume' && req.method === 'POST') {
        await readJson<any>(req).catch(() => ({})) // `{}` or nothing; the body carries no decision
        return json(res, 200, service.resume()), true
      }
      return json(res, 405, { error: 'method not allowed' }), true
    }
    if (path === '/api/self-update' && req.method === 'GET') {
      return json(res, 200, await service.status(query.get('session'))), true
    }
    if (path === '/api/self-update/revert' && req.method === 'POST') {
      const body = await readJson<any>(req)
      const sessionId = String(body?.sessionId || query.get('session') || '')
      const change = await service.revert(sessionId, String(body?.changeId || ''), String(body?.expectedReleaseId || ''))
      return json(res, 200, { change }), true
    }
    return json(res, 404, { error: 'self-update route not found' }), true
  } catch (error) {
    return errorResponse(res, error), true
  }
}
