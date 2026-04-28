import type { Plugin, Connect } from 'vite'
import { syncDelta, backfillFiles, backfillAvatars } from './sync'
import { listPrs, countPrs, getFlow, getTrust } from './queries'
import { getMeta } from './db'
import { getToken, setToken, hasToken } from './auth'
import { getSettings, setSettings } from './settings'

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

// GitHub REST proxy — injects the configured token. Replaces the Vite built-in proxy
// so auth can come from the SQLite meta table instead of `gh` CLI.
async function proxyGitHub(req: any, res: any, url: string): Promise<void> {
  const token = getToken()
  if (!token) return json(res, 401, { error: 'No GitHub token configured' })

  const upstream = 'https://api.github.com' + url.slice('/api/github'.length)
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'poise',
    'Accept': 'application/vnd.github+json',
  }
  let body: string | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req)
    if (body) headers['Content-Type'] = 'application/json'
  }

  try {
    const upRes = await fetch(upstream, { method: req.method, headers, body })
    res.statusCode = upRes.status
    upRes.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'content-length') return
      res.setHeader(k, v)
    })
    const text = await upRes.text()
    res.end(text)
  } catch (err: any) {
    json(res, 502, { error: 'github fetch failed: ' + (err.message || String(err)) })
  }
}

export function cachePlugin(): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      const mw: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url || ''

        // ── GitHub REST proxy ──
        if (url.startsWith('/api/github/')) {
          await proxyGitHub(req, res, url)
          return
        }

        // ── Auth ──
        if (url.startsWith('/api/auth/status') && req.method === 'GET') {
          return json(res, 200, { configured: hasToken() })
        }

        if (url.startsWith('/api/auth/set-token') && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = body ? JSON.parse(body) : {}
            const token = (parsed.token || '').toString().trim()
            if (!token) {
              setToken(null)
              return json(res, 200, { configured: false, cleared: true })
            }
            // Light validation: GitHub classic PATs start with `ghp_`, fine-grained with `github_pat_`
            if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
              return json(res, 400, { error: 'Token does not look like a GitHub PAT' })
            }
            setToken(token)
            return json(res, 200, { configured: true })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // ── Settings ──
        if (url.startsWith('/api/settings') && req.method === 'GET') {
          return json(res, 200, getSettings())
        }
        if (url.startsWith('/api/settings') && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = body ? JSON.parse(body) : {}
            const next = setSettings(parsed)
            return json(res, 200, next)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // ── Cache ──
        // POST /api/cache/sync
        if (url.startsWith('/api/cache/sync') && req.method === 'POST') {
          const token = getToken()
          if (!token) return json(res, 401, { error: 'No GitHub token configured', code: 'NO_TOKEN' })
          const { org, me } = getSettings()
          if (!org || !me) return json(res, 400, { error: 'Org and username must be set in Settings', code: 'NO_SETTINGS' })
          const force = new URL(url, 'http://x').searchParams.get('force') === '1'
          try {
            const result = await syncDelta(org, me, token, force)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/prs?type=&status=&since=&until=&limit=&offset=
        if (url.startsWith('/api/cache/prs') && req.method === 'GET') {
          const p = new URL(url, 'http://x').searchParams
          const type = (p.get('type') || 'both') as 'both' | 'issue' | 'pr'
          const status = (p.get('status') || 'all') as 'all' | 'open'
          const since = p.get('since') || undefined
          const until = p.get('until') || undefined
          const limit = Math.min(Number(p.get('limit')) || 20, 200)
          const offset = Number(p.get('offset')) || 0
          try {
            const items = listPrs({ type, status, since, until, limit, offset })
            const total = countPrs({ type, status, since, until })
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
          const token = getToken()
          if (!token) return json(res, 401, { error: 'No GitHub token configured', code: 'NO_TOKEN' })
          const { org } = getSettings()
          if (!org) return json(res, 400, { error: 'Org must be set in Settings', code: 'NO_SETTINGS' })
          const p = new URL(url, 'http://x').searchParams
          const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 600)
          try {
            const result = await backfillFiles(org, token, limit)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // POST /api/cache/backfill-avatars?limit=200
        if (url.startsWith('/api/cache/backfill-avatars') && req.method === 'POST') {
          const token = getToken()
          if (!token) return json(res, 401, { error: 'No GitHub token configured', code: 'NO_TOKEN' })
          const { org } = getSettings()
          if (!org) return json(res, 400, { error: 'Org must be set in Settings', code: 'NO_SETTINGS' })
          const p = new URL(url, 'http://x').searchParams
          const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 1200)
          try {
            const result = await backfillAvatars(org, token, limit)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // GET /api/cache/meta
        if (url.startsWith('/api/cache/meta') && req.method === 'GET') {
          return json(res, 200, { last_sync_at: getMeta('last_sync_at') })
        }

        next()
      }
      server.middlewares.use(mw)
    },
  }
}
