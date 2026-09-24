import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, httpStatus } from '../http'
import { JevRuntime } from './runtime'
import { JEV_REQUEST_BYTES } from '../../src/jev-types'

let runtime: JevRuntime | null = null
export async function stopJev(): Promise<void> { const current = runtime; runtime = null; await current?.stop() }
/** The enclosing API middleware applies host/origin, no-store and release-drain checks. */
export async function handleJevApi(req: IncomingMessage, res: ServerResponse, url: string, instance?: JevRuntime): Promise<boolean> {
  const path = url.split('?')[0]
  if (!path.startsWith('/api/jev/')) return false
  const engine = instance ?? (runtime ??= new JevRuntime())
  const send = (status: number, body: unknown): true => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); return true }
  const body = () => readJson<any>(req, 4 * JEV_REQUEST_BYTES)
  try {
    if (path === '/api/jev/models' && req.method === 'GET') return send(200, { models: await engine.models() })
    if (path === '/api/jev/config' && req.method === 'GET') return send(200, { configured: engine.configured(), model: 'jev-latest' })
    if (path === '/api/jev/preview' && req.method === 'POST') return send(200, { request: engine.effective(await body()) })
    if (path === '/api/jev/sessions') {
      if (req.method === 'GET') return send(200, { sessions: engine.list() })
      if (req.method === 'POST') return send(201, { session: engine.create(await body()) })
    }
    const session = /^\/api\/jev\/sessions\/([^/]+)(\/runs)?$/.exec(path)
    if (session) {
      if (session[2]) {
        if (req.method === 'GET') return send(200, engine.runs(session[1], Number(new URLSearchParams(url.split('?')[1]).get('before')) || undefined))
        if (req.method === 'POST') { const input = await body(); return send(202, { run: engine.start(session[1], input.id, input.request) }) }
      } else {
        if (req.method === 'GET') return send(200, { session: engine.get(session[1]) })
        if (req.method === 'PATCH') return send(200, { session: engine.update(session[1], await body()) })
        if (req.method === 'DELETE') { engine.remove(session[1]); return send(200, { ok: true }) }
      }
    }
    const run = /^\/api\/jev\/runs\/([^/]+)(\/cancel)?$/.exec(path)
    if (run && run[2] && req.method === 'POST') return send(200, { run: await engine.cancel(run[1]) })
    if (run && !run[2] && req.method === 'GET') return send(200, { run: engine.run(run[1]) })
    return send(405, { error: 'Unsupported JEV operation.' })
  } catch (error) { return send(httpStatus(error, req.method === 'GET' ? 500 : 400), { error: error instanceof Error ? error.message : 'JEV operation failed.' }) }
}
