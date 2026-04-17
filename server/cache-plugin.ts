import type { Plugin, Connect } from 'vite'
import { execSync } from 'child_process'
import { syncDelta, backfillFiles } from './sync'
import { listPrs, countPrs, getFlow, getTrust } from './queries'
import { getMeta } from './db'

function getGitHubToken(): string {
  try { return execSync('gh auth token', { encoding: 'utf-8' }).trim() } catch { return '' }
}

function json(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
  })
}

export function cachePlugin(): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      const mw: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url || ''

        // POST /api/cache/sync
        if (url.startsWith('/api/cache/sync') && req.method === 'POST') {
          const token = getGitHubToken()
          if (!token) return json(res, 401, { error: 'No GitHub token available (gh auth)' })
          const force = new URL(url, 'http://x').searchParams.get('force') === '1'
          try {
            const result = await syncDelta(token, force)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/prs?type=&status=&limit=&offset=
        if (url.startsWith('/api/cache/prs') && req.method === 'GET') {
          const p = new URL(url, 'http://x').searchParams
          const type = (p.get('type') || 'both') as 'both' | 'issue' | 'pr'
          const status = (p.get('status') || 'all') as 'all' | 'open'
          const limit = Math.min(Number(p.get('limit')) || 20, 200)
          const offset = Number(p.get('offset')) || 0
          try {
            const items = listPrs({ type, status, limit, offset })
            const total = countPrs({ type, status })
            const last_sync_at = getMeta('last_sync_at')
            return json(res, 200, { items, total, last_sync_at })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/flow?range=90
        if (url.startsWith('/api/cache/flow') && req.method === 'GET') {
          const p = new URL(url, 'http://x').searchParams
          const range = Math.min(Math.max(Number(p.get('range')) || 90, 7), 365)
          try {
            return json(res, 200, getFlow(range))
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/trust?range=90
        if (url.startsWith('/api/cache/trust') && req.method === 'GET') {
          const p = new URL(url, 'http://x').searchParams
          const range = Math.min(Math.max(Number(p.get('range')) || 90, 7), 365)
          try {
            return json(res, 200, getTrust(range))
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // POST /api/cache/backfill-files?limit=200
        if (url.startsWith('/api/cache/backfill-files') && req.method === 'POST') {
          const token = getGitHubToken()
          if (!token) return json(res, 401, { error: 'No GitHub token available (gh auth)' })
          const p = new URL(url, 'http://x').searchParams
          const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 600)
          try {
            const result = await backfillFiles(token, limit)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/meta
        if (url.startsWith('/api/cache/meta') && req.method === 'GET') {
          return json(res, 200, { last_sync_at: getMeta('last_sync_at') })
        }

        // POST /api/cache/comment — write-through comment for row expansion cache
        if (url.startsWith('/api/cache/last-comment') && req.method === 'POST') {
          // Reserved for future: per-PR latest comment fetch
          const body = await readBody(req)
          return json(res, 200, { received: body.length })
        }

        next()
      }
      server.middlewares.use(mw)
    },
  }
}
