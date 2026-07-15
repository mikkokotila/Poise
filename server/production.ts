import { createReadStream, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, readBuffer, setApiHeaders } from './http'
import { assertSecureDotenv, loadSecureDotenv, validateConfabUrl } from './runtime-config'
import type { ClaudeAuthRuntime } from './cache-plugin'

// Security validation must run before dotenv reads the file and before modules
// that derive database/runtime paths from process.env are evaluated.
await loadSecureDotenv()
const { createPoiseMiddleware, stopPoiseRuntime } = await import('./cache-plugin')
const { closeDatabase } = await import('./db')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5555
const CONFAB_BODY_MAX_BYTES = 4 * 1024 * 1024
const CONFAB_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
export const PRODUCTION_SHUTDOWN_TIMEOUT_MS = 10_000

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export interface ProductionServerOptions {
  host?: string
  port?: number
  staticDir?: string
  confabUrl?: string
  confabApiKey?: string
  reviewAgentUsername?: string
  /** Auth runtime override for isolated integration tests. */
  claudeAuth?: ClaudeAuthRuntime
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setApiHeaders(res)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function sendFailure(res: ServerResponse, statusCode: number, error: unknown): void {
  if (res.writableEnded || res.destroyed) return
  if (res.headersSent) {
    // A partial static response cannot be replaced with JSON. Terminate the
    // response without triggering ERR_HTTP_HEADERS_SENT in the catch path.
    res.destroy()
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, statusCode, { error: message })
}

function setStaticSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' https://rsms.me https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://rsms.me https://fonts.googleapis.com",
  ].join('; '))
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
}

async function readFetchResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks, size)
    const chunk = Buffer.from(value)
    size += chunk.byteLength
    if (size > CONFAB_RESPONSE_MAX_BYTES) {
      await reader.cancel('response too large')
      throw new HttpError(502, 'Confab response exceeded the local size limit')
    }
    chunks.push(chunk)
  }
}

async function proxyConfab(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  const incoming = new URL(req.url || '/', 'http://localhost')
  const rewritten = incoming.pathname.replace(/^\/api\/confab/, '/api')
  const target = new URL(rewritten + incoming.search, baseUrl)
  const method = req.method || 'GET'
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await readBuffer(req, CONFAB_BODY_MAX_BYTES)
  const requestBody = body ? Uint8Array.from(body) : undefined
  const headers = new Headers()
  const contentType = req.headers['content-type']
  const accept = req.headers.accept
  if (contentType) headers.set('Content-Type', Array.isArray(contentType) ? contentType[0] : contentType)
  if (accept) headers.set('Accept', Array.isArray(accept) ? accept[0] : accept)
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)

  const upstream = await fetch(target, {
    method,
    headers,
    body: requestBody,
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  })
  const responseBody = await readFetchResponse(upstream)
  res.statusCode = upstream.status
  setApiHeaders(res)
  const responseType = upstream.headers.get('content-type')
  if (responseType) res.setHeader('Content-Type', responseType)
  res.end(responseBody)
}

function safeStaticPath(staticDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) return null
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(staticDir, requested)
  const fromRoot = relative(staticDir, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
    ? candidate
    : null
}

interface ResolvedStaticFile {
  path: string
  root: string
  fileStat: Stats
}

async function resolveStaticFile(staticDir: string, candidate: string): Promise<ResolvedStaticFile | null> {
  const [root, path] = await Promise.all([realpath(staticDir), realpath(candidate)])
  const fromRoot = relative(root, path)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return null
  const fileStat = await stat(path)
  return fileStat.isFile() ? { path, root, fileStat } : null
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' })
  }
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const requestedPath = safeStaticPath(staticDir, requestUrl.pathname)
  if (!requestedPath) return sendJson(res, 400, { error: 'invalid path' })

  let file: ResolvedStaticFile | null
  try {
    file = await resolveStaticFile(staticDir, requestedPath)
    // Existing directories and symlinks that escape the static root are not
    // SPA misses: do not replace them with index.html.
    if (!file) return sendJson(res, 404, { error: 'not found' })
  } catch {
    const acceptsHtml = (req.headers.accept || '').includes('text/html')
    if (!acceptsHtml || extname(requestUrl.pathname)) {
      return sendJson(res, 404, { error: 'not found' })
    }
    try {
      file = await resolveStaticFile(staticDir, resolve(staticDir, 'index.html'))
    } catch {
      return sendJson(res, 503, { error: 'client build is unavailable' })
    }
    if (!file) return sendJson(res, 503, { error: 'client build is unavailable' })
  }
  const { path, root, fileStat } = file

  const etag = `W/\"${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}\"`
  setStaticSecurityHeaders(res)
  res.setHeader('ETag', etag)
  res.setHeader('Content-Length', fileStat.size)
  res.setHeader('Content-Type', MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream')
  const relativePath = relative(root, path)
  res.setHeader('Cache-Control', relativePath.startsWith(`assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache')
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path)
    let settled = false
    const cleanup = () => {
      stream.off('error', onError)
      res.off('finish', onFinish)
      res.off('close', onClose)
    }
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectStream(error)
      else resolveStream()
    }
    const onError = (error: Error) => settle(error)
    const onFinish = () => settle()
    const onClose = () => {
      // A disconnected client may never emit `finish`. Destroy the file
      // stream so its descriptor is released and settle the request task.
      if (!res.writableFinished) stream.destroy()
      settle()
    }
    stream.once('error', onError)
    res.once('finish', onFinish)
    res.once('close', onClose)
    stream.pipe(res)
  })
}

let runtimeStopPromise: Promise<void> | null = null
let databaseClosed = false
const serverShutdowns = new WeakMap<Server, Promise<void>>()

function stopRuntimeOnce(): Promise<void> {
  runtimeStopPromise ??= Promise.resolve().then(() => stopPoiseRuntime())
  return runtimeStopPromise
}

async function settleRuntimeStop(): Promise<void> {
  try { await stopRuntimeOnce() }
  catch (error) { console.error('[poise] runtime shutdown failed:', error) }
}

function closeDatabaseOnce(): void {
  if (databaseClosed) return
  databaseClosed = true
  closeDatabase()
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

export function shutdownProductionServer(server: Server): Promise<void> {
  const existing = serverShutdowns.get(server)
  if (existing) return existing

  const shutdown = (async () => {
    const results = await Promise.allSettled([stopRuntimeOnce(), closeHttpServer(server)])
    // Runtime tasks can touch SQLite during their own teardown. Close the DB
    // only after both shutdown operations have settled.
    closeDatabaseOnce()
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'production shutdown failed')
  })()
  serverShutdowns.set(server, shutdown)
  return shutdown
}

export function createProductionShutdown(
  server: Server,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let started = false
  let finished = false
  return () => {
    if (started) return
    started = true
    const deadline = setTimeout(() => {
      if (finished) return
      finished = true
      try { closeDatabaseOnce() }
      finally { exit(1) }
    }, PRODUCTION_SHUTDOWN_TIMEOUT_MS)
    deadline.unref()

    void shutdownProductionServer(server).then(() => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      exit(0)
    }, (error: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      console.error('[poise] shutdown failed:', error)
      exit(1)
    })
  }
}

export function createProductionServer(options: ProductionServerOptions = {}): Server {
  const host = options.host || DEFAULT_HOST
  if (!isLoopbackHost(host)) {
    throw new Error('Poise is a local application and only binds to a loopback host')
  }
  const staticDir = resolve(options.staticDir || resolve(process.cwd(), 'dist/client'))
  const confabUrl = validateConfabUrl(
    options.confabUrl ?? process.env.CONFAB_URL ?? 'http://localhost:8000',
  )
  const confabApiKey = options.confabApiKey ?? process.env.CONFAB_API_KEY ?? ''
  // createPoiseMiddleware starts the shared runtime synchronously.
  runtimeStopPromise = null
  const api = createPoiseMiddleware({
    reviewAgentUsername: options.reviewAgentUsername ?? process.env.REVIEW_AGENT_USERNAME ?? '',
    claudeAuth: options.claudeAuth,
  })

  const server = createServer((req, res) => {
    void Promise.resolve(api(req, res, () => {
      if (res.writableEnded) return
      if ((req.url || '').startsWith('/api/confab')) {
        void proxyConfab(req, res, confabUrl, confabApiKey).catch((error: unknown) => {
          sendFailure(res, error instanceof HttpError ? error.statusCode : 502, error)
        })
        return
      }
      if ((req.url || '').startsWith('/api/')) {
        sendJson(res, 404, { error: 'API route not found' })
        return
      }
      void serveStatic(req, res, staticDir).catch((error: unknown) => {
        sendFailure(res, 500, error)
      })
    })).catch((error: unknown) => {
      sendFailure(res, 500, error)
    })
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000
  server.once('close', () => {
    void stopRuntimeOnce().catch((error: unknown) => {
      console.error('[poise] runtime shutdown failed:', error)
    })
  })
  return server
}

export async function startProductionServer(options: ProductionServerOptions = {}): Promise<Server> {
  await assertSecureDotenv()
  const host = options.host || process.env.POISE_HOST || DEFAULT_HOST
  if (!isLoopbackHost(host)) {
    throw new Error('Poise is a local application and only binds to a loopback host')
  }
  const port = options.port ?? Number(process.env.POISE_PORT || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('POISE_PORT must be an integer between 1 and 65535')
  }
  const confabUrl = validateConfabUrl(
    options.confabUrl ?? process.env.CONFAB_URL ?? 'http://localhost:8000',
  )
  const staticDir = resolve(options.staticDir || resolve(process.cwd(), 'dist/client'))
  await stat(resolve(staticDir, 'index.html'))
  let server: Server
  try {
    server = createProductionServer({ ...options, host, port, staticDir, confabUrl })
  } catch (error) {
    await settleRuntimeStop()
    throw error
  }
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, host, () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
  } catch (error) {
    await settleRuntimeStop()
    // close() also releases HTTP server bookkeeping created before a failed
    // bind; its ERR_SERVER_NOT_RUNNING callback is expected for EADDRINUSE.
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    throw error
  }
  console.log(`[poise] listening on http://${host}:${port}`)
  return server
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false
if (isEntrypoint) {
  startProductionServer().then((server) => {
    const shutdown = createProductionShutdown(server)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }).catch(async (error: unknown) => {
    await settleRuntimeStop()
    closeDatabaseOnce()
    console.error('[poise] failed to start:', error)
    process.exitCode = 1
  })
}
