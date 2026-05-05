import type { Plugin, Connect } from 'vite'
import { getSettings, setSettings } from './settings'
import { listCards, createCard, setCardText, setCardRepo, moveCard, removeCard, type Lane } from './current'
import { handleGhBody, listOrgRepos } from './gh'
import { fetchAgentLogs, fetchAgentResponse, triggerPrReview } from './agent'
import { setEnabled as setBehaviorEnabled, getEnabledMap, startBehaviorsRuntime, BEHAVIOR_KEYS, type BehaviorKey } from './behaviors'

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

export interface CachePluginOptions {
  /** GitHub username the review-agent acts as (from REVIEW_AGENT_USERNAME).
   *  Surfaced through /api/behaviors so the Behaviors view can show who
   *  the "Review New Pull Requests" automation will speak as. */
  reviewAgentUsername?: string
}

export function cachePlugin(opts: CachePluginOptions = {}): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      // Server-side behavior runtime — wall-clock-aligned ticker that
      // runs whether the browser tab is open or not. See
      // server/behaviors.ts for details.
      startBehaviorsRuntime()
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

        // ── /api/agent-logs — Swarm's data source ──
        // Wraps `agent-interface --logs`. Returns the JSON array as-is
        // under a `logs` envelope so the front-end can extend it later
        // without a breaking change.
        if (url === '/api/agent-logs' && req.method === 'GET') {
          try {
            const logs = await fetchAgentLogs()
            return json(res, 200, { logs })
          } catch (err: any) {
            return json(res, 502, { error: 'agent-interface --logs failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/behaviors — state + metadata for behavior automations ──
        // GET returns owner (from server env) AND enabled flag (from
        // cache.db meta) per behavior. Owner is who the agent acts
        // as; enabled is whether the server-side runtime is currently
        // running this behavior on every tick.
        if (url === '/api/behaviors' && req.method === 'GET') {
          const enabled = getEnabledMap()
          return json(res, 200, {
            'review-new-prs': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['review-new-prs'],
            },
          })
        }

        // POST /api/behaviors/<key> { enabled: bool } toggles the
        // server-side runtime for one behavior.
        const behaviorMatch = url.match(/^\/api\/behaviors\/([a-z0-9-]+)(?:\?|$)/)
        if (behaviorMatch && req.method === 'POST') {
          const key = behaviorMatch[1] as BehaviorKey
          if (!(BEHAVIOR_KEYS as string[]).includes(key)) {
            return json(res, 400, { error: 'unknown behavior: ' + key })
          }
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const enabled = !!body.enabled
            await setBehaviorEnabled(key, enabled)
            return json(res, 200, { ok: true, enabled })
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }

        // ── /api/repos — every repo in the org with any PR/issue ──
        // Cached 5 min server-side. Used by Current's repo selectors so
        // the user can pick from every Vaquum repo, not just the ones
        // they've personally touched.
        if (url === '/api/repos' && req.method === 'GET') {
          try {
            const repos = await listOrgRepos()
            return json(res, 200, { repos })
          } catch (err: any) {
            return json(res, 502, { error: 'listOrgRepos failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/pr-review — kick off agent-interface --pr-review ──
        // Body: { url } where url is a github PR URL. Resolves the
        // local checkout path via github-interface, then spawns the
        // CLI detached. The frontend gets an immediate 200; the actual
        // run lands in Swarm as a new agent-interface log entry.
        if (url === '/api/pr-review' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const result = await triggerPrReview(String(body.url || ''))
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, 502, { error: 'pr-review trigger failed: ' + msg })
          }
        }

        // ── /api/agent-response/:hash — body of one agent call ──
        // Hash is the 8-char `response` value from --logs;
        // agent-interface --read-response resolves it back to the full
        // body. On demand (only when the user clicks View on a row).
        const agentRespMatch = url.match(/^\/api\/agent-response\/([0-9a-fA-F]+)(?:\?|$)/)
        if (agentRespMatch && req.method === 'GET') {
          const hash = agentRespMatch[1]
          try {
            const result = await fetchAgentResponse(hash)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, 502, { error: 'agent-interface --read-response failed: ' + msg })
          }
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
            const card = createCard(String(parsed.text ?? ''), parsed.lane as Lane, parsed.repo)
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
              // PATCH accepts any combination of {text}, {repo}, or
              // {lane, position}. Multiple fields in one call apply in
              // order so the edit form can save text + repo together.
              let card = null
              if (typeof parsed.text === 'string') card = setCardText(id, parsed.text)
              if ('repo' in parsed)                card = setCardRepo(id, parsed.repo)
              if (typeof parsed.lane === 'string' && typeof parsed.position === 'number') {
                card = moveCard(id, parsed.lane as Lane, parsed.position)
              }
              if (card) return json(res, 200, card)
              return json(res, 400, { error: 'Provide one or more of { text }, { repo }, { lane, position }' })
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
