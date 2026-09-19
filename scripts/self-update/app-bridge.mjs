// The controller's view of the running application: readiness and drain
// through the release-key-protected endpoints, health and the Chat session
// list as the public proof that a release actually serves. The bridge key is
// a secret shared only between the controller root and the server; it is
// never sent to a browser or a model.
import { readFile } from 'node:fs/promises'
import { assertPrivateFile } from './atomic.mjs'
import { scrubEnvironment } from './environment.mjs'
import { PRODUCTION_SERVICE_LABEL } from './config.mjs'

export const RELEASE_KEY_HEADER = 'x-poise-release-key'
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/

export async function loadBridgeKey(path) {
  await assertPrivateFile(path, 'bridge key file')
  const key = (await readFile(path, 'utf8')).trim()
  if (!KEY_PATTERN.test(key)) throw new Error('bridge key file does not contain a usable key')
  return key
}

export class AppUnreachable extends Error {
  constructor(message) {
    super(message)
    this.name = 'AppUnreachable'
  }
}

export function createAppBridge({
  fetch = globalThis.fetch,
  port = 5555,
  host = '127.0.0.1',
  loadKey,
  timeoutMs = 5_000,
} = {}) {
  const base = `http://${host}:${port}`
  const hostHeader = `${host}:${port}`

  async function call(method, path, { body = undefined, authenticated = false } = {}) {
    const headers = { accept: 'application/json', host: hostHeader }
    if (authenticated) {
      if (typeof loadKey !== 'function') throw new Error('bridge key loader is not configured')
      headers[RELEASE_KEY_HEADER] = await loadKey()
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      })
    } catch (error) {
      throw new AppUnreachable(`${method} ${path}: ${error?.message || error}`)
    }
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: response.status, ok: response.ok, body: parsed }
  }

  return {
    baseUrl: base,
    /** Raw /api/health: status code plus body, or throws AppUnreachable. */
    health() {
      return call('GET', '/api/health')
    },
    chatSessions() {
      return call('GET', '/api/chat/sessions')
    },
    readiness() {
      return call('GET', '/api/self-update/readiness', { authenticated: true })
    },
    drain(releaseId) {
      return call('POST', '/api/self-update/drain', { authenticated: true, body: { releaseId } })
    },
    resume() {
      return call('POST', '/api/self-update/resume', { authenticated: true, body: {} })
    },
  }
}

/**
 * Judge a health response for a target build. A degraded status caused only
 * by external sign-in or Caller release state still proves the release runs;
 * a missing or mismatched build identity, a broken scheduler or a non-JSON
 * answer does not.
 */
export function assessHealth({ health, chat }, { sha, releaseId }) {
  if (!health || typeof health !== 'object' || !health.body || typeof health.body !== 'object') {
    return { healthy: false, reason: 'health endpoint returned no JSON body' }
  }
  const body = health.body
  const build = body.build
  if (!build || typeof build !== 'object') return { healthy: false, reason: 'health has no build identity' }
  if (build.sha !== sha) return { healthy: false, reason: `serving build ${build.sha ? String(build.sha).slice(0, 12) : 'unknown'}, expected ${sha.slice(0, 12)}` }
  if (build.releaseId !== releaseId) return { healthy: false, reason: `serving release ${build.releaseId ?? 'unknown'}, expected ${releaseId}` }
  if (body.status !== 'ok') {
    if (body.scheduler && body.scheduler.status !== 'ok') return { healthy: false, reason: `behaviour runtime is ${body.scheduler.status}` }
    if (body.status !== 'degraded') return { healthy: false, reason: `health status is ${body.status}` }
    // Degraded for external reasons only (Claude sign-in, Caller release): the
    // release itself is up.
  }
  if (!chat || chat.status !== 200 || !Array.isArray(chat.body?.sessions)) {
    return { healthy: false, reason: `chat session list is unavailable (${chat?.status ?? 'no response'})` }
  }
  return { healthy: true, reason: body.status === 'ok' ? 'healthy' : 'healthy (degraded by external services only)' }
}

/** Restart the production service through launchd; the launcher lands on the pointer. */
export function createLaunchdRestarter({ runner, label = PRODUCTION_SERVICE_LABEL, uid = process.getuid?.(), baseEnv = process.env }) {
  return async function restartProduction() {
    await runner.run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
      env: scrubEnvironment({ base: baseEnv }), timeoutMs: 30_000, purpose: 'restart production',
    })
  }
}
