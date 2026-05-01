import type { Plugin, Connect } from 'vite'
import { syncDelta, backfillFiles, backfillAvatars } from './sync'
import { listPrs, countPrs } from './queries'
import { getMeta } from './db'
import { getToken, setToken, hasToken } from './auth'
import { getSettings, setSettings } from './settings'
import { listCards, createCard, setCardText, moveCard, removeCard, type Lane } from './stream'

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

        // GET /api/cache/prs?type=&status=&since=&until=&q=&limit=&offset=
        if (url.startsWith('/api/cache/prs') && req.method === 'GET') {
          const p = new URL(url, 'http://x').searchParams
          const type = (p.get('type') || 'both') as 'both' | 'issue' | 'pr'
          const status = (p.get('status') || 'all') as 'all' | 'open'
          const since = p.get('since') || undefined
          const until = p.get('until') || undefined
          const q = (p.get('q') || '').trim() || undefined
          const limit = Math.min(Number(p.get('limit')) || 20, 200)
          const offset = Number(p.get('offset')) || 0
          try {
            const items = listPrs({ type, status, since, until, q, limit, offset })
            const total = countPrs({ type, status, since, until, q })
            const last_sync_at = getMeta('last_sync_at')
            return json(res, 200, { items, total, last_sync_at })
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

        // ── /github bridge ──
        // POST /api/gh forwards to the user's local /github API (default
        // http://127.0.0.1:8788/github, override via GITHUB_API_URL). Every
        // GitHub-related call from Poise — reads (list / green_pr / new) and
        // any future writes — flows through here, so the host + auth live in
        // one place and the views stay agnostic.
        if (url === '/api/gh' && req.method === 'POST') {
          const body = await readBody(req)
          const upstream = process.env.GITHUB_API_URL || 'http://127.0.0.1:8788/github'
          try {
            const upRes = await fetch(upstream, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
            const text = await upRes.text()
            res.statusCode = upRes.status
            res.setHeader('Content-Type', upRes.headers.get('content-type') || 'application/json')
            res.end(text)
          } catch (err: any) {
            return json(res, 502, { error: 'github bridge unreachable: ' + (err.message || String(err)) })
          }
          return
        }

        // ── Swarm proxy ──
        // Proxies to the local hermes swarm-events service. Swallowing the
        // host here so the browser never has to know the upstream URL.
        if (url.startsWith('/api/swarm/events')) {
          const qs = url.slice('/api/swarm/events'.length)
          const upstream = 'http://127.0.0.1:7878/events' + qs
          try {
            const upRes = await fetch(upstream)
            const text = await upRes.text()
            res.statusCode = upRes.status
            res.setHeader('Content-Type', upRes.headers.get('content-type') || 'application/json')
            res.end(text)
          } catch (err: any) {
            return json(res, 502, { error: 'swarm-events service unreachable: ' + (err.message || String(err)) })
          }
          return
        }

        // ── Stream (kanban) ──
        // GET /api/stream — list all cards
        if (url === '/api/stream' && req.method === 'GET') {
          return json(res, 200, { cards: listCards() })
        }

        // POST /api/stream — { text, lane }
        if (url === '/api/stream' && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = body ? JSON.parse(body) : {}
            const card = createCard(String(parsed.text ?? ''), parsed.lane as Lane)
            return json(res, 200, card)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }

        // PATCH /api/stream/:id — { text? } or { lane?, position? } (move)
        // DELETE /api/stream/:id
        const streamMatch = url.match(/^\/api\/stream\/(\d+)(?:\?|$)/)
        if (streamMatch) {
          const id = Number(streamMatch[1])
          if (req.method === 'PATCH') {
            try {
              const body = await readBody(req)
              const parsed = body ? JSON.parse(body) : {}
              if (typeof parsed.text === 'string') {
                const card = setCardText(id, parsed.text)
                return json(res, 200, card)
              }
              if (typeof parsed.lane === 'string' && typeof parsed.position === 'number') {
                const card = moveCard(id, parsed.lane as Lane, parsed.position)
                return json(res, 200, card)
              }
              return json(res, 400, { error: 'Provide either { text } or { lane, position }' })
            } catch (err: any) {
              return json(res, 400, { error: err.message || String(err) })
            }
          }
          if (req.method === 'DELETE') {
            try {
              removeCard(id)
              return json(res, 200, { ok: true })
            } catch (err: any) {
              return json(res, 400, { error: err.message || String(err) })
            }
          }
        }

        next()
      }
      server.middlewares.use(mw)
    },
  }
}
