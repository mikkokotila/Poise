import type { Plugin, Connect } from 'vite'
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

export function cachePlugin(): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      const mw: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url || ''

        // ── Settings ──
        // Org / username / timezone (the few user-facing knobs Poise still
        // needs locally). Persisted in ~/.poise/cache.db meta table.
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

        // ── /github bridge ──
        // POST /api/gh forwards to the user's local /github API (default
        // http://127.0.0.1:8788/github, override via GITHUB_API_URL). Every
        // GitHub-related call from Poise — reads (list / green_pr / new) and
        // writes (open_issue / post_comment) — flows through here so the
        // host lives in one place and the views stay agnostic.
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

        // ── Stream (kanban) — manual cards (idea / concept / plan) ──
        // Stays Poise-local. The Issue + PR lanes pull from /api/gh.
        if (url === '/api/stream' && req.method === 'GET') {
          return json(res, 200, { cards: listCards() })
        }
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
