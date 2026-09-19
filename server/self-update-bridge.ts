// The app's side of the private Unix socket to the self-update controller
// (scripts/self-update). The controller is installed separately and owns
// every release decision; this client only asks it questions and reports
// what the runtime observed. Every request is bounded in time and size, and
// nothing here reads the release token — the controller keeps that.
//
// Unconfigured is the default: with no root the client answers every call
// with `SelfUpdateUnavailableError`, so a server (or test) that was never
// bootstrapped performs no controller IO at all.

import { request as httpRequest } from 'node:http'
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PreparedSelfChange, SelfChange, SelfUpdateStatus } from '../src/self-update-types'

export const SELF_UPDATE_REPOSITORY = 'mikkokotila/Poise'
const SOCKET_NAME = 'control.sock'
const KEY_NAME = 'bridge.key'
const RESPONSE_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
/** Preparing a change clones the active source; that is not instant. */
const PREPARE_TIMEOUT_MS = 180_000
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,512}$/

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/

/** The controller is not installed, not enabled, or not answering. */
export class SelfUpdateUnavailableError extends Error {
  readonly code = 'self_update_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'SelfUpdateUnavailableError'
  }
}

/** The controller answered with an error of its own (policy, state, input). */
export class SelfUpdateBridgeError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SelfUpdateBridgeError'
  }
}

export interface SelfUpdateBridge {
  /** False when this server was not pointed at a controller root at all. */
  readonly configured: boolean
  readonly root: string | null
  status(): Promise<SelfUpdateStatus>
  prepareChange(input: { id: string, sessionId: string, instance: string, request: string, title?: string }): Promise<PreparedSelfChange>
  bindSession(changeId: string, input: { sessionId: string, instance: string }): Promise<SelfChange>
  finish(changeId: string, input: { outcome: 'completed' | 'failed', error?: string }): Promise<SelfChange>
  rollback(changeId: string, input: { expectedReleaseId: string }): Promise<SelfChange>
  tick(): Promise<SelfUpdateStatus>
  /** The shared secret the controller presents on the app's private
   *  endpoints; null when it is not installed or not private to this user. */
  readBridgeKey(): string | null
}

export interface SelfUpdateBridgeOptions {
  /** Controller root; null leaves the bridge unconfigured. */
  root: string | null
  timeoutMs?: number
  prepareTimeoutMs?: number
}

/** Where the controller lives for this server, or null when it is not
 *  wired up: an explicit `POISE_SELF_UPDATE_ROOT`, else the production
 *  server's default root. A development server never talks to the
 *  production controller unless told to. */
export function resolveSelfUpdateRoot(instanceLabel: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.POISE_SELF_UPDATE_ROOT?.trim()
  if (explicit) return resolve(explicit)
  return instanceLabel === 'production' ? join(homedir(), '.poise', 'self-update') : null
}

const NOT_CONFIGURED = 'Poise self-improvement is not set up on this server: install and enable the self-update controller (see docs) before using /poise'

export function createSelfUpdateBridge(options: SelfUpdateBridgeOptions): SelfUpdateBridge {
  const root = options.root
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS

  function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeout = timeoutMs): Promise<T> {
    if (!root) return Promise.reject(new SelfUpdateUnavailableError(NOT_CONFIGURED))
    const socketPath = join(root, SOCKET_NAME)
    try {
      const info = lstatSync(socketPath)
      if (!info.isSocket()) throw new Error('not a socket')
      if (process.getuid && info.uid !== process.getuid()) throw new Error('owned by another user')
    } catch (error: any) {
      return Promise.reject(new SelfUpdateUnavailableError(error?.code === 'ENOENT'
        ? `the self-update controller is not running (${socketPath} is missing); start or install it before using /poise`
        : `the self-update controller socket is unsafe: ${error instanceof Error ? error.message : String(error)}`))
    }
    return new Promise<T>((resolvePromise, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      const req = httpRequest({
        socketPath, method, path,
        headers: {
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.byteLength) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > RESPONSE_MAX_BYTES) res.destroy(new Error('the controller response exceeds 1 MiB'))
          else chunks.push(chunk)
        })
        res.on('error', (error) => reject(new SelfUpdateUnavailableError(`the self-update controller connection failed: ${error.message}`)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: any = null
          try { parsed = text ? JSON.parse(text) : null } catch { /* reported below */ }
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            const message = parsed && typeof parsed.error === 'string' ? parsed.error : `the self-update controller answered ${status || 'without a status'}`
            reject(status >= 500 || status === 0 ? new SelfUpdateUnavailableError(message) : new SelfUpdateBridgeError(status, message))
            return
          }
          if (parsed === null || typeof parsed !== 'object') { reject(new SelfUpdateUnavailableError('the self-update controller answered with something other than a JSON object')); return }
          resolvePromise(parsed as T)
        })
      })
      const timer = setTimeout(() => req.destroy(new Error(`the self-update controller did not answer within ${Math.round(timeout / 1000)}s`)), timeout)
      timer.unref()
      req.on('error', (error) => reject(new SelfUpdateUnavailableError(`the self-update controller is unavailable: ${error.message}`)))
      req.on('close', () => clearTimeout(timer))
      req.end(data)
    })
  }

  const changePath = (changeId: string, action: string) => {
    if (!UUID_PATTERN.test(changeId)) throw new SelfUpdateBridgeError(400, 'change id must be a UUID')
    return `/changes/${changeId.toLowerCase()}/${action}`
  }

  return {
    configured: !!root,
    root,
    status: () => call<SelfUpdateStatus>('GET', '/status'),
    prepareChange: (input) => call<PreparedSelfChange>('POST', '/changes', input, prepareTimeoutMs),
    bindSession: async (changeId, input) => call<SelfChange>('POST', changePath(changeId, 'session'), input),
    finish: async (changeId, input) => call<SelfChange>('POST', changePath(changeId, 'finish'), input),
    rollback: async (changeId, input) => call<SelfChange>('POST', changePath(changeId, 'rollback'), input),
    tick: () => call<SelfUpdateStatus>('POST', '/tick', {}),
    readBridgeKey: () => {
      if (!root) return null
      const path = join(root, KEY_NAME)
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink()) return null
        if ((info.mode & 0o077) !== 0) return null
        if (process.getuid && info.uid !== process.getuid()) return null
        const key = readFileSync(path, 'utf8').trim()
        return KEY_PATTERN.test(key) ? key : null
      } catch {
        return null
      }
    },
  }
}

/** A bridge that is never configured: the default for servers and tests
 *  that were not bootstrapped. */
export function unconfiguredSelfUpdateBridge(): SelfUpdateBridge {
  return createSelfUpdateBridge({ root: null })
}
