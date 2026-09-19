// A stand-in for the Poise production server with exactly the surface the
// release controller relies on: /api/health with a build identity, the Chat
// session list, and the bridge-key-protected readiness/drain/resume
// endpoints. It is started by the journey test from a release directory the
// controller staged, with the environment the stable launcher resolves.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { greeting } from './greeting.mjs'

// Replaced by scripts/build.mjs with the SHA the release was built for.
const BUILD_SHA = typeof __POISE_BUILD_SHA__ === 'string' ? __POISE_BUILD_SHA__ : null

const port = Number(process.env.POISE_PORT)
if (!Number.isInteger(port) || port <= 0) {
  console.error('[fixture] POISE_PORT is required')
  process.exit(78)
}
const instance = process.env.POISE_INSTANCE || 'journey'
const keyFile = process.env.POISE_BRIDGE_KEY_FILE || null
const releaseId = process.env.POISE_RELEASE_ID || null

let draining = null
let busy = 0

function build() {
  return { sha: BUILD_SHA, releaseId: BUILD_SHA && releaseId ? releaseId : null }
}

function readiness() {
  return { ready: draining !== null && busy === 0, busy, build: build(), draining: draining !== null, ...(draining ? { releaseId: draining } : {}) }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function keyAccepted(req, res) {
  if (!keyFile) {
    send(res, 503, { error: 'bridge key is not configured' })
    return false
  }
  let expected
  try {
    expected = readFileSync(keyFile, 'utf8').trim()
  } catch {
    send(res, 503, { error: 'bridge key file is unreadable' })
    return false
  }
  if (req.headers['x-poise-release-key'] !== expected) {
    send(res, 401, { error: 'release key rejected' })
    return false
  }
  return true
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  const path = url.pathname
  try {
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, {
        status: 'ok',
        scheduler: { status: 'ok' },
        build: build(),
        selfUpdate: { configured: Boolean(keyFile), draining: draining !== null },
        release: { id: releaseId, sha: process.env.POISE_RELEASE_SHA || null, root: process.env.POISE_RELEASE_ROOT || null },
        greeting: greeting('Poise'),
        pid: process.pid,
        cwd: process.cwd(),
      })
    }
    if (req.method === 'GET' && path === '/api/chat/sessions') return send(res, 200, { sessions: [], instance })
    if (path === '/api/self-update/readiness' && req.method === 'GET') {
      if (!keyAccepted(req, res)) return undefined
      return send(res, 200, readiness())
    }
    if (path === '/api/self-update/drain' && req.method === 'POST') {
      if (!keyAccepted(req, res)) return undefined
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' })
      const body = JSON.parse((await readBody(req)) || '{}')
      if (typeof body.releaseId !== 'string' || !body.releaseId) return send(res, 400, { error: 'releaseId is required' })
      draining = body.releaseId
      return send(res, 200, readiness())
    }
    if (path === '/api/self-update/resume' && req.method === 'POST') {
      if (!keyAccepted(req, res)) return undefined
      await readBody(req)
      draining = null
      return send(res, 200, readiness())
    }
    // Test-only hook: pretend a number of turns are running so drain waits.
    if (path === '/__fixture/busy' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      busy = Number.isInteger(body.busy) && body.busy >= 0 ? body.busy : 0
      return send(res, 200, readiness())
    }
    if (req.method === 'GET' && path === '/') {
      const text = `${greeting('Poise')}\n`
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      return res.end(text)
    }
    return send(res, 404, { error: 'not found' })
  } catch (error) {
    return send(res, 500, { error: error?.message || String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fixture] serving ${BUILD_SHA ? BUILD_SHA.slice(0, 12) : 'development'} release ${releaseId ?? 'none'} on ${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
