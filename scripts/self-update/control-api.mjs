// The private control API on a Unix socket. Only same-user processes can
// reach it (the socket is 0600 inside a 0700 root); the server bridge and the
// CLI are its clients. Responses follow src/self-update-types.ts.
import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { ControllerError } from './controller.mjs'
import { isUuid } from './paths.mjs'

export const MAX_BODY_BYTES = 64 * 1024

export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (rejected) {
        // Drain a modest overrun so the 413 can be delivered; cut off anything absurd.
        if (size > limit * 4) req.destroy()
        return
      }
      if (size > limit) {
        rejected = true
        chunks.length = 0
        reject(new ControllerError(413, 'request body too large', 'too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function readJsonBody(req, limit) {
  const text = await readBody(req, limit)
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new ControllerError(400, 'body must be a JSON object', 'invalid')
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...(status === 413 ? { connection: 'close' } : {}),
  })
  res.end(payload)
}

/** Route one request. Exported for tests that drive it without a socket. */
export async function routeControlRequest(controller, req, { log = () => {} } = {}) {
  const url = new URL(req.url || '/', 'http://control.sock')
  const path = url.pathname
  const method = req.method || 'GET'
  if (method === 'GET' && path === '/status') return { status: 200, body: await controller.status() }
  if (method === 'GET' && path === '/health') return { status: 200, body: { ok: true, pid: process.pid, reconciling: controller.reconciling } }
  if (method === 'POST' && path === '/tick') {
    await readBody(req)
    controller.kick()
    return { status: 200, body: await controller.status() }
  }
  if (method === 'POST' && path === '/changes') {
    const body = await readJsonBody(req)
    return { status: 201, body: await controller.prepareChange(body) }
  }
  if (method === 'POST' && path === '/rollback') {
    const body = await readJsonBody(req)
    const result = await controller.rollbackRelease(body)
    controller.kick()
    return { status: 202, body: result }
  }
  if (method === 'POST' && path === '/hold/clear') {
    await readBody(req)
    return { status: 200, body: await controller.clearHold() }
  }
  const match = path.match(/^\/changes\/([0-9a-fA-F-]{36})\/(session|finish|rollback)$/)
  if (match && method === 'POST') {
    const id = match[1].toLowerCase()
    if (!isUuid(id)) throw new ControllerError(400, 'change id must be a UUID', 'invalid')
    const body = await readJsonBody(req)
    if (match[2] === 'session') return { status: 200, body: await controller.bindSession(id, body) }
    // Queue the follow-up work in the daemon and answer immediately; the
    // caller never waits on a check, a merge or a switch.
    if (match[2] === 'finish') {
      const finished = await controller.finishChange(id, body)
      controller.kick()
      return { status: 202, body: finished }
    }
    const rolledBack = await controller.rollbackChange(id, body)
    controller.kick()
    return { status: 202, body: rolledBack }
  }
  log(`[self-update] control api: no route for ${method} ${path}`)
  throw new ControllerError(404, `no route for ${method} ${path}`, 'not_found')
}

export function createControlHandler(controller, options = {}) {
  return async (req, res) => {
    try {
      const { status, body } = await routeControlRequest(controller, req, options)
      send(res, status, body)
    } catch (error) {
      if (error instanceof ControllerError) return send(res, error.status, { error: error.message, code: error.code })
      options.log?.(`[self-update] control api error: ${error?.stack || error}`)
      send(res, 500, { error: error?.message || String(error), code: 'internal' })
    }
  }
}

export function createControlServer(controller, { socketPath, log = () => {} }) {
  const server = createServer(createControlHandler(controller, { log }))
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  return {
    server,
    async listen() {
      await unlink(socketPath).catch(() => {})
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ path: socketPath, exclusive: true }, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(socketPath, 0o600)
      log(`[self-update] control api listening on ${socketPath}`)
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await unlink(socketPath).catch(() => {})
    },
  }
}
