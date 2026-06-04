import type { Plugin, Connect } from 'vite'
import { getSettings, setSettings } from './settings'
import { listCards, createCard, setCardText, setCardRepo, moveCard, removeCard, type Lane } from './current'
import { handleGhBody, listOrgRepos, setReviewAgentUsername } from './gh'
import { fetchAgentLogs, fetchAgentResponse, triggerPrReview, replayAgentJob } from './agent'
import { listChatHistory, sendChat, saveAttachment, startAuthorContent, authorContentStatus, contentSlugForCallId, runDebate } from './chat'
import { listDocs, readDoc, writeDoc, deleteDoc, newSlug, readAnnotations, writeAnnotations, getOrCreateChatSession } from './editor'
import { setEnabled as setBehaviorEnabled, setSetting as setBehaviorSetting, getEnabledMap, getSettingMap, isValidSetting, startBehaviorsRuntime, getResolveUnblockingLastFired, BEHAVIOR_KEYS, type BehaviorKey } from './behaviors'

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
      // server/behaviors.ts for details. The reviewAgentUsername is
      // threaded through here (via Vite's loadEnv at config time) so
      // approve-prs can pass it as `--username` to github-interface;
      // process.env is unreliable inside Vite plugins.
      startBehaviorsRuntime({ reviewAgentUsername: opts.reviewAgentUsername })

      // Same identity, threaded into the /api/gh bridge: the involvement
      // scope in server/gh.ts unions the review-agent's footprint with
      // the user's so Current shows issues/PRs the agent opened. Like the
      // behaviors runtime, this must come from the plugin opts — process.env
      // is empty for this var inside the Vite plugin.
      setReviewAgentUsername(opts.reviewAgentUsername || '')

      // /content finalization marker — set of call_ids we've already
      // written articles for, so repeated status polls don't re-write
      // the same file. The slug is derived from the call_id (see
      // contentSlugForCallId in chat.ts) so no mapping is stored —
      // this is purely a "have we already done it" guard. Server
      // restart clears it; the next poll just safely re-writes the
      // file at the same slug (idempotent overwrite of identical
      // content).
      const contentFinalizedCalls = new Set<string>()
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
        // GET returns owner (from server env), enabled flag, and the
        // per-behavior setting (e.g. "p2") from cache.db meta. Owner is
        // who the agent acts as; enabled is whether the server-side
        // runtime is running this behavior; setting is the threshold
        // value passed to agent-interface as `--p`.
        //
        // `lastTriggered` is NOT persisted by Poise — it's derived
        // straight from `agent-interface --logs` (the canonical record
        // of every pr_review / pr_approve run). Each behavior maps to
        // a `behavior` field value in that log: review-new-prs ↔
        // pr_review, approve-prs ↔ pr_approve. resolve-unblocking has
        // no log surface (github-interface doesn't persist its calls)
        // so its lastTriggered stays null — the dash in the Behaviors
        // view reflects the actual state of the world.
        if (url === '/api/behaviors' && req.method === 'GET') {
          const enabled = getEnabledMap()
          const settings = getSettingMap()
          let logs: Awaited<ReturnType<typeof fetchAgentLogs>> = []
          try { logs = await fetchAgentLogs() } catch { /* logs unavailable — lastTriggered nulls */ }
          // fetchAgentLogs returns newest-first, so .find() picks the
          // most recent matching row. We only consider rows that have
          // both a repo and pr_id so the link to Swarm works.
          const lastFor = (cliBehavior: string) => {
            const r = logs.find((e) => e.behavior === cliBehavior && e.repo && e.pr_id)
            return r ? { at: r.started_at, target: `${r.repo}#${r.pr_id}` } : null
          }
          return json(res, 200, {
            'review-new-prs': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['review-new-prs'],
              setting: settings['review-new-prs'],
              lastTriggered: lastFor('pr_review'),
            },
            // approve-prs has no priority setting — `setting: null` so
            // the Behaviors view can render an em dash instead of a
            // dropdown for that row.
            'approve-prs': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['approve-prs'],
              setting: null,
              lastTriggered: lastFor('pr_approve'),
            },
            // resolve-unblocking calls github-interface directly (no
            // agent), so it has no agent-interface log surface. Its
            // lastTriggered is instead persisted by the behavior
            // itself in cache.db meta whenever it actually resolves a
            // conversation — getResolveUnblockingLastFired reads it.
            'resolve-unblocking': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['resolve-unblocking'],
              setting: null,
              lastTriggered: getResolveUnblockingLastFired(),
            },
          })
        }

        // POST /api/behaviors/<key> { enabled?: bool, setting?: 'p0'|'p1'|'p2' }
        // — either field optional; both can be sent in one call.
        const behaviorMatch = url.match(/^\/api\/behaviors\/([a-z0-9-]+)(?:\?|$)/)
        if (behaviorMatch && req.method === 'POST') {
          const key = behaviorMatch[1] as BehaviorKey
          if (!(BEHAVIOR_KEYS as string[]).includes(key)) {
            return json(res, 400, { error: 'unknown behavior: ' + key })
          }
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            if ('enabled' in body) await setBehaviorEnabled(key, !!body.enabled)
            if ('setting' in body) {
              if (!isValidSetting(body.setting)) {
                return json(res, 400, { error: 'invalid setting: ' + String(body.setting) })
              }
              setBehaviorSetting(key, body.setting)
            }
            return json(res, 200, {
              ok: true,
              enabled: getEnabledMap()[key],
              setting: getSettingMap()[key],
            })
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

        // ── /api/chat — per-card long-lived chats via agent-interface ──
        // GET /api/chat?session=<id> returns the chat transcript for
        // that session (oldest-first; each entry has the user prompt
        // and a response hash for fetching the reply body).
        // POST /api/chat { session, message } spawns
        // `agent-interface --chat <message> --model gpt --session <id>`
        // detached and returns immediately; the front-end polls GET
        // for status updates.
        // The path-only check (split on `?`) keeps this from greedily
        // intercepting /api/chat-attachment, /api/chat-content, etc.
        if (url?.split('?')[0] === '/api/chat' && req.method === 'GET') {
          const qs = new URLSearchParams(url.split('?')[1] || '')
          const session = qs.get('session') || ''
          try {
            const messages = await listChatHistory(session)
            return json(res, 200, { messages })
          } catch (err: any) {
            return json(res, 502, { error: 'chat history failed: ' + (err.message || String(err)) })
          }
        }
        if (url === '/api/chat' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const result = await sendChat(
              String(body.session || ''),
              String(body.message || ''),
              body.model ? String(body.model) : undefined,
              Array.isArray(body.attachments) ? body.attachments.map(String) : [],
            )
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }

        // POST /api/chat-attachment?session=<id>&filename=<name>
        // Raw request body is the file bytes. The server sanitizes the
        // filename and writes it under chatPwd(session) so the agent
        // sees the attachment in its cwd. Returns the sanitized name
        // the front-end should reference when it sends the chat
        // message that uses these files.
        if (url?.startsWith('/api/chat-attachment') && req.method === 'POST') {
          try {
            const qs = new URLSearchParams(url.split('?')[1] || '')
            const session = qs.get('session') || ''
            const filename = qs.get('filename') || ''
            const chunks: Buffer[] = []
            await new Promise<void>((resolve, reject) => {
              req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              req.on('end', () => resolve())
              req.on('error', reject)
            })
            const body = Buffer.concat(chunks)
            const result = await saveAttachment(session, filename, body)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }

        // ── /api/chat-content — /content slash command bridge ──
        // POST starts agent-interface --author-content --session-id
        // <session> and returns the freshly-minted call_id once the
        // row shows up in --logs. GET /api/chat-content/status?call_id=…
        // polls for completion; when the call lands, the server
        // fetches the response body and writes a new editor article
        // at slug `content-<8charCallId>`. Because the slug derives
        // from the call_id, NO mapping ledger is needed: the chat
        // history (filtered to behavior='author_content' for this
        // session) tells us which call_ids exist, and the slug is a
        // pure function of each.
        if (url === '/api/chat-content' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const topic   = String(body.topic   || '')
            const session = String(body.session || '')
            const result = await startAuthorContent(topic, session)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 502, { error: '/content trigger failed: ' + (err.message || String(err)) })
          }
        }
        if (url?.startsWith('/api/chat-content/status') && req.method === 'GET') {
          try {
            const qs = new URLSearchParams(url.split('?')[1] || '')
            const callId = qs.get('call_id') || ''
            if (!callId) return json(res, 400, { error: 'call_id is required' })
            const slug = contentSlugForCallId(callId)
            // Already written? Return without re-fetching.
            if (contentFinalizedCalls.has(callId)) {
              return json(res, 200, { status: 'completed', slug })
            }
            const status = await authorContentStatus(callId)
            if (status.status === 'completed' && status.response_hash) {
              try {
                const { body: contentBody } = await fetchAgentResponse(status.response_hash)
                const written = await writeDoc(slug, String(contentBody || ''))
                contentFinalizedCalls.add(callId)
                return json(res, 200, { status: 'completed', slug: written.slug })
              } catch (err: any) {
                return json(res, 500, { error: 'finalize failed: ' + (err.message || String(err)) })
              }
            }
            return json(res, 200, status)
          } catch (err: any) {
            return json(res, 502, { error: 'status check failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/debate — wraps agent-interface --debate ──
        // Routed here by the chat-pane's `/consensus` slash command.
        // Synchronous: blocks until the local multi-model debate
        // completes, then returns the parsed JSON {synthesis, rounds}.
        // agent-interface logs the call so it appears in Swarm.
        if (url === '/api/debate' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const result = await runDebate(String(body.topic || ''), Number(body.rounds || 1))
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err?.message || String(err) })
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

        // ── /api/agent-replay — re-run an existing agent-interface job ─
        // Body: { behavior, repo, pr_id }. Server maps behavior to the
        // CLI flag (--pr-review / --pr-approve) and re-spawns. A new
        // row appears in `agent-interface --logs`; the original row is
        // untouched. Used by the Swarm view's Replay column.
        if (url === '/api/agent-replay' && req.method === 'POST') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const result = await replayAgentJob(body)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, 400, { error: 'agent-replay failed: ' + msg })
          }
        }

        // ── /api/editor — markdown editor docs ──
        // Each doc is a plain .md file under ~/.poise/editor/ (or
        // $POISE_EDITOR_DIR). server/editor.ts owns sanitization and
        // the on-disk layout; this just bridges HTTP to those calls.
        if (url === '/api/editor/docs' && req.method === 'GET') {
          try {
            const docs = await listDocs()
            return json(res, 200, { docs })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (url === '/api/editor/docs' && req.method === 'POST') {
          // Create a new blank doc with a server-minted slug.
          try {
            const result = await writeDoc(newSlug(), '')
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        const editorDocMatch = url.match(/^\/api\/editor\/doc\/([A-Za-z0-9._-]+)$/)
        if (editorDocMatch && req.method === 'GET') {
          try {
            const result = await readDoc(editorDocMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' })
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (editorDocMatch && req.method === 'PUT') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const result = await writeDoc(editorDocMatch[1], String(body.content || ''))
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }
        if (editorDocMatch && req.method === 'DELETE') {
          try {
            const result = await deleteDoc(editorDocMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // ── /api/editor/doc/:slug/annotations — side-car notes per doc ──
        // GET returns the full list; PUT replaces it. The front-end owns
        // ids/snippets and decides when to add/remove; we just persist.
        const editorAnnMatch = url.match(/^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/annotations$/)
        if (editorAnnMatch && req.method === 'GET') {
          try {
            const result = await readAnnotations(editorAnnMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (editorAnnMatch && req.method === 'PUT') {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const annotations = Array.isArray(body.annotations) ? body.annotations : []
            const result = await writeAnnotations(editorAnnMatch[1], { annotations })
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 400, { error: err.message || String(err) })
          }
        }

        // ── /api/editor/doc/:slug/chat-session — per-doc long-lived chat ──
        // GET returns the doc's chat session (minting on first call),
        // so the editor can dispatch `poise:open-chat` against the
        // existing chat-pane with a stable session_id. The transcript
        // itself lives in agent-interface's DB — we only persist the
        // session_id (in <slug>.chat.json) so we can resume the same
        // conversation forever.
        const editorChatMatch = url.match(/^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/chat-session$/)
        if (editorChatMatch && req.method === 'GET') {
          try {
            const result = await getOrCreateChatSession(editorChatMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
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
