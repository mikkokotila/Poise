// Client for the control API over the Unix socket. Used by the CLI and
// available to the server bridge. Requests are bounded in time and size, and
// an unreachable daemon is reported as a distinct, expected condition so a
// normal application health check can show "disabled" rather than fail.
import { request as httpRequest } from 'node:http'

export class ControlUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'ControlUnavailable'
    this.code = 'unavailable'
  }
}

export class ControlError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'ControlError'
    this.status = status
    this.code = code
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export function createControlClient({ socketPath, timeoutMs = 10_000 }) {
  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body)
      const req = httpRequest({
        socketPath,
        method,
        path,
        headers: {
          accept: 'application/json',
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        timeout: timeoutMs,
      })
      req.on('timeout', () => req.destroy(new ControlUnavailable(`control socket timed out after ${timeoutMs} ms`)))
      req.on('error', (error) => {
        if (error instanceof ControlUnavailable) return reject(error)
        reject(new ControlUnavailable(`control socket ${socketPath}: ${error?.code || error?.message || error}`))
      })
      req.on('response', (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy()
            reject(new ControlError(502, 'control response too large', 'too_large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            return reject(new ControlError(502, 'control response was not JSON', 'invalid_response'))
          }
          if (res.statusCode >= 400) {
            return reject(new ControlError(res.statusCode, parsed?.error || `HTTP ${res.statusCode}`, parsed?.code || 'error'))
          }
          resolve(parsed)
        })
        res.on('error', (error) => reject(new ControlUnavailable(error.message)))
      })
      if (payload !== null) req.write(payload)
      req.end()
    })
  }

  return {
    request,
    status: () => request('GET', '/status'),
    health: () => request('GET', '/health'),
    tick: () => request('POST', '/tick', {}),
    prepareChange: (body) => request('POST', '/changes', body),
    bindSession: (id, body) => request('POST', `/changes/${encodeURIComponent(id)}/session`, body),
    finishChange: (id, body) => request('POST', `/changes/${encodeURIComponent(id)}/finish`, body),
    rollbackChange: (id, body) => request('POST', `/changes/${encodeURIComponent(id)}/rollback`, body),
    rollbackRelease: (body) => request('POST', '/rollback', body),
    clearHold: () => request('POST', '/hold/clear', {}),
  }
}

/** A Status shaped answer when the daemon is not running or not installed. */
export function disabledStatus(reason) {
  return { enabled: false, available: false, reason, activeRelease: null, previousRelease: null, hold: null, changes: [] }
}

/** Status from the daemon if reachable; otherwise a disabled Status, never a throw. */
export async function statusOrDisabled(client) {
  try {
    return await client.status()
  } catch (error) {
    if (error instanceof ControlUnavailable) return disabledStatus(`self-update controller is not running (${error.message})`)
    throw error
  }
}
