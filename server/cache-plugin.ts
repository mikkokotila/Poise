import type { Plugin, Connect } from 'vite'
import { getSettings, setSettings } from './settings'
import { listCards, createCard, setCardText, moveCard, removeCard, type Lane } from './current'
import { handleGhBody } from './gh'

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

        // ── /api/gh — github-datastore bridge ──
        // POST /api/gh translates Poise's body shape ({ operation, record_type,
        // record_state, updated_since, ... }) to the local `github-datastore`
        // CLI and maps the result back to the legacy { records: [...] } envelope
        // the views consume. See server/gh.ts for the shape mapping and the
        // user-footprint scoping logic.
        if (url === '/api/gh' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const { status, body: respBody } = await handleGhBody(body)
            return json(res, status, respBody)
          } catch (err: any) {
            return json(res, 502, { error: 'github-datastore call failed: ' + (err.message || String(err)) })
          }
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

        // ── Current (kanban) — manual cards (idea / concept / plan) ──
        // Stays Poise-local. The Issue + PR lanes pull from /api/gh.
        if (url === '/api/current' && req.method === 'GET') {
          return json(res, 200, { cards: listCards() })
        }
        if (url === '/api/current' && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = body ? JSON.parse(body) : {}
            const card = createCard(String(parsed.text ?? ''), parsed.lane as Lane)
            return json(res, 200, card)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }
        const currentMatch = url.match(/^\/api\/current\/(\d+)(?:\?|$)/)
        if (currentMatch) {
          const id = Number(currentMatch[1])
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
