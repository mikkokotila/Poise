import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { getSettings, setSettings } from './settings'
import { claudeAuth, type ClaudeAuthSnapshot } from './claude-auth'
import { getCallerReleaseHealth } from './caller-release'
import { listCards, createCard, setCardText, setCardRepo, moveCard, removeCard, type Lane } from './current'
import { handleGhBody, listOrgRepos, setReviewAgentUsername } from './gh'
import { fetchAgentLogs, fetchAgentResponse, triggerPrReview, replayAgentJob } from './agent'
import { listChatHistory, sendChat, saveAttachment, runDebate } from './chat'
import { listDocs, readDoc, writeDoc, deleteDoc, newSlug, readAnnotations, writeAnnotations, getOrCreateChatSession, MAX_DOC_BYTES, MAX_ANNOTATIONS_BYTES, EditorConflictError } from './editor'
import { readSnippetState, saveSnippets, addSnippet, espansoDetected, SnippetConflictError } from './snippets'
import { setEnabled as setBehaviorEnabled, setSetting as setBehaviorSetting, setScratchpad as setBehaviorScratchpad, getEnabledMap, getSettingMap, getScratchpadMap, getBehaviorsRuntimeHealth, isValidSetting, startBehaviorsRuntime, stopBehaviorsRuntime, getResolveUnblockingLastFired, BEHAVIOR_KEYS, type BehaviorKey } from './behaviors'
import { ContentLaunchPendingError, getContentJobResponse, launchAndEnqueueContentJob, startContentFinalizer, stopContentFinalizer } from './content-jobs'
import { ProcessLockError } from './process-lock'
import { ATTACHMENT_MAX_BYTES, enforceApiRequest, httpStatus, readBuffer, readJson, setApiHeaders } from './http'

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export interface CachePluginOptions {
  /** GitHub username the review-agent acts as (from REVIEW_AGENT_USERNAME).
   *  Surfaced through /api/behaviors so the Behaviors view can show who
   *  the "Review New Pull Requests" automation will speak as. */
  reviewAgentUsername?: string
  /** Additional hostnames allowed to access the local API. */
  allowedHosts?: string[]
  /** Auth runtime override for isolated integration tests. */
  claudeAuth?: ClaudeAuthRuntime
}

export interface ClaudeAuthRuntime {
  start(): void
  stop(): Promise<void>
  snapshot(): ClaudeAuthSnapshot
  startLogin(): ClaudeAuthSnapshot
}

const activeClaudeAuthRuntimes = new Set<ClaudeAuthRuntime>()

export function startPoiseRuntime(opts: CachePluginOptions = {}): void {
  const auth = opts.claudeAuth ?? claudeAuth
  activeClaudeAuthRuntimes.add(auth)
  auth.start()
  setReviewAgentUsername(opts.reviewAgentUsername || '')
  startBehaviorsRuntime({ reviewAgentUsername: opts.reviewAgentUsername })
  startContentFinalizer()
}

export async function stopPoiseRuntime(): Promise<void> {
  const authStops = [...activeClaudeAuthRuntimes].map((auth) => auth.stop())
  activeClaudeAuthRuntimes.clear()
  await Promise.all([stopBehaviorsRuntime(), stopContentFinalizer(), ...authStops])
}

export function createPoiseMiddleware(opts: CachePluginOptions = {}): Connect.NextHandleFunction {
      startPoiseRuntime(opts)
      const auth = opts.claudeAuth ?? claudeAuth
      return async (req, res, next) => {
        const url = req.url || ''

        if (!url.startsWith('/api/')) return next()
        setApiHeaders(res)
        try {
          enforceApiRequest(req, { allowedHosts: opts.allowedHosts })
        } catch (err) {
          return json(res, httpStatus(err, 403), { error: (err as Error).message })
        }
        if (req.method === 'OPTIONS') {
          return json(res, 405, { error: 'cross-origin preflight is not supported' })
        }
        if (url === '/api/health' && req.method === 'GET') {
          const scheduler = getBehaviorsRuntimeHealth()
          const claudeAuthState = auth.snapshot()
          const callerRelease = await getCallerReleaseHealth()
          const enabled = getEnabledMap()
          const claudeBackedEnabled = enabled['review-new-prs'] || enabled['approve-prs']
          const healthy = scheduler.status === 'ok'
            && (!claudeBackedEnabled || claudeAuthState.status === 'authenticated')
            && callerRelease.status !== 'invalid'
          return json(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            scheduler,
            claudeAuth: claudeAuthState,
            callerRelease,
          })
        }

        // Claude Code owns credentials. Poise exposes only sanitized health
        // metadata and can start the subscription login flow; no token or
        // provider output crosses this API boundary.
        if (url === '/api/claude-auth' && req.method === 'GET') {
          return json(res, 200, auth.snapshot())
        }
        if (url === '/api/claude-auth/login' && req.method === 'POST') {
          const before = auth.snapshot()
          const state = auth.startLogin()
          return json(res, before.status === 'authenticated' ? 200 : 202, state)
        }

        // ── Settings ──
        // Org / username / timezone (the few user-facing knobs Poise still
        // needs locally). Persisted in ~/.poise/cache.db meta table.
        if (url.startsWith('/api/settings') && req.method === 'GET') {
          return json(res, 200, getSettings())
        }
        if (url.startsWith('/api/settings') && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const settings = setSettings(body)
            return json(res, 200, settings)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
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
            const body = await readJson<any>(req)
            const { status, body: respBody } = await handleGhBody(body)
            return json(res, status, respBody)
          } catch (err: any) {
            return json(res, httpStatus(err, 502), { error: 'github-datastore call failed: ' + (err.message || String(err)) })
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
          const scratch = getScratchpadMap()
          let logs: Awaited<ReturnType<typeof fetchAgentLogs>> = []
          let agentLogsError: string | null = null
          try { logs = await fetchAgentLogs() }
          catch (error) {
            agentLogsError = error instanceof Error ? error.message : String(error)
          }
          // fetchAgentLogs returns newest-first, so .find() picks the
          // most recent matching row. We only consider rows that have
          // both a repo and pr_id so the link to Swarm works.
          const lastFor = (cliBehavior: string, source: string) => {
            const r = logs.find((e) =>
              e.behavior === cliBehavior
              && e.source === source
              && e.repo
              && e.pr_id)
            return r ? {
              at: r.started_at_precise || r.started_at,
              target: `${r.repo}#${r.pr_id}`,
            } : null
          }
          const runtime = getBehaviorsRuntimeHealth()
          return json(res, 200, {
            'review-new-prs': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['review-new-prs'],
              setting: settings['review-new-prs'],
              scratchpad: scratch['review-new-prs'],
              lastTriggered: lastFor('pr_review', 'poise:review-new-prs'),
            },
            // approve-prs has no priority setting — `setting: null` so
            // the Behaviors view can render an em dash instead of a
            // dropdown for that row.
            'approve-prs': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['approve-prs'],
              setting: null,
              scratchpad: scratch['approve-prs'],
              lastTriggered: lastFor('pr_approve', 'poise:approve-prs'),
            },
            // resolve-unblocking calls github-interface directly (no
            // agent), so it has no agent-interface log surface. Its
            // lastTriggered is instead persisted by the behavior
            // itself in cache.db meta whenever it actually resolves a
            // conversation — getResolveUnblockingLastFired reads it.
            // `scratchpad: null` because there's no agent prompt to
            // inject memory into — the view renders no memory control.
            'resolve-unblocking': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['resolve-unblocking'],
              setting: null,
              scratchpad: null,
              lastTriggered: getResolveUnblockingLastFired(),
            },
            diagnostics: {
              status: runtime.status,
              agentLogsError,
              datastore: runtime.datastore,
              identity: runtime.identity,
              failures: runtime.failures,
              deadLetters: runtime.deadLetters,
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
            const body = await readJson<any>(req)
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json(res, 400, { error: 'behavior update must be an object' })
            }
            // Validate the complete update before applying any field. A bad
            // setting must never leave an automation enabled as a partial
            // side effect, and string values are not booleans.
            if ('enabled' in body && typeof body.enabled !== 'boolean') {
              return json(res, 400, { error: 'enabled must be a boolean' })
            }
            if ('setting' in body) {
              if (!isValidSetting(body.setting)) {
                return json(res, 400, { error: 'invalid setting: ' + String(body.setting) })
              }
            }
            if ('scratchpad' in body) {
              if (typeof body.scratchpad !== 'string') {
                return json(res, 400, { error: 'scratchpad must be a string' })
              }
            }
            // Persist passive configuration first; enabling last guarantees
            // the first tick observes the submitted setting and memory.
            if ('setting' in body) setBehaviorSetting(key, body.setting)
            if ('scratchpad' in body) setBehaviorScratchpad(key, body.scratchpad)
            if ('enabled' in body) await setBehaviorEnabled(key, body.enabled)
            return json(res, 200, {
              ok: true,
              enabled: getEnabledMap()[key],
              setting: getSettingMap()[key],
              scratchpad: getScratchpadMap()[key],
            })
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
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
            const body = await readJson<any>(req)
            const result = await sendChat(
              String(body.session || ''),
              String(body.message || ''),
              body.model ? String(body.model) : undefined,
              Array.isArray(body.attachments) ? body.attachments.map(String) : [],
            )
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
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
            const body = await readBuffer(req, ATTACHMENT_MAX_BYTES)
            const result = await saveAttachment(session, filename, body)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }

        // ── /api/chat-content — /content slash command bridge ──
        // POST launches agent-interface and commits a durable pending job
        // before returning. A leased server-side reconciler owns completion,
        // so browser polling is observational only and restart-safe.
        if (url === '/api/chat-content' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const topic   = String(body.topic   || '')
            const session = String(body.session || '')
            const job = await launchAndEnqueueContentJob(topic, session)
            return json(res, 200, job)
          } catch (err: any) {
            const status = err instanceof ProcessLockError
              ? 503
              : err instanceof ContentLaunchPendingError
                ? 409
                : httpStatus(err, 502)
            return json(res, status, {
              error: '/content trigger failed: ' + (err.message || String(err)),
            })
          }
        }
        if (url?.startsWith('/api/chat-content/status') && req.method === 'GET') {
          try {
            const qs = new URLSearchParams(url.split('?')[1] || '')
            const callId = qs.get('call_id') || ''
            if (!callId) return json(res, 400, { error: 'call_id is required' })
            const job = getContentJobResponse(callId)
            if (!job) return json(res, 404, { error: 'author-content job not found' })
            return json(res, 200, job)
          } catch (err: any) {
            return json(res, 500, { error: 'status check failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/debate — wraps agent-interface --debate ──
        // Routed here by the chat-pane's `/consensus` slash command.
        // Synchronous: blocks until the local multi-model debate
        // completes, then returns the parsed JSON {synthesis, rounds}.
        // agent-interface logs the call so it appears in Swarm.
        if (url === '/api/debate' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await runDebate(String(body.topic || ''), Number(body.rounds || 1))
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, httpStatus(err, 500), { error: err?.message || String(err) })
          }
        }

        // ── /api/pr-review — kick off agent-interface --pr-review ──
        // Body: { url } where url is a github PR URL. Resolves the
        // local checkout path via github-interface, then spawns the
        // CLI detached. The frontend gets an immediate 200; the actual
        // run lands in Swarm as a new agent-interface log entry.
        if (url === '/api/pr-review' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await triggerPrReview(String(body.url || ''))
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, httpStatus(err, 502), { error: 'pr-review trigger failed: ' + msg })
          }
        }

        // ── /api/agent-replay — re-run an existing agent-interface job ─
        // Body: { behavior, repo, pr_id }. Server maps behavior to the
        // CLI flag (--pr-review / --pr-approve) and re-spawns. A new
        // row appears in `agent-interface --logs`; the original row is
        // untouched. Used by the Swarm view's Replay column.
        if (url === '/api/agent-replay' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await replayAgentJob(body)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, httpStatus(err, 400), { error: 'agent-replay failed: ' + msg })
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
        if (editorDocMatch && (req.method === 'PUT' || req.method === 'POST')) {
          try {
            // JSON string escaping can expand control-heavy Markdown by up to
            // six bytes per decoded byte. writeDoc still enforces 5 MiB after
            // parsing; this envelope cap preserves that domain limit.
            const body = await readJson<any>(req, MAX_DOC_BYTES * 6 + 1024)
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.content !== 'string') {
              return json(res, 400, { error: 'content must be a string' })
            }
            if (body.client_id === undefined && body.revision === undefined && body.base_version === undefined) {
              return json(res, 428, { error: 'editor write precondition is required; reload the document' })
            }
            const writeContext = body.client_id === undefined
                && body.revision === undefined
                && body.base_version === undefined
              ? undefined
              : {
                  clientId: body.client_id,
                  revision: body.revision,
                  baseVersion: body.base_version,
                }
            const result = await writeDoc(editorDocMatch[1], body.content, writeContext)
            return json(res, 200, result)
          } catch (err: any) {
            const conflict = err instanceof EditorConflictError
            return json(res, conflict ? 409 : httpStatus(err, 400), {
              error: err.message || String(err),
              ...(conflict ? { current_version: err.currentVersion } : {}),
            })
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
        if (editorAnnMatch && (req.method === 'PUT' || req.method === 'POST')) {
          try {
            const body = await readJson<any>(req, MAX_ANNOTATIONS_BYTES + 1024)
            if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.annotations)) {
              return json(res, 400, { error: 'annotations must be an array' })
            }
            if (body.client_id === undefined && body.revision === undefined && body.base_version === undefined) {
              return json(res, 428, { error: 'editor write precondition is required; reload annotations' })
            }
            const annotations = body.annotations
            const writeContext = body.client_id === undefined
                && body.revision === undefined
                && body.base_version === undefined
              ? undefined
              : {
                  clientId: body.client_id,
                  revision: body.revision,
                  baseVersion: body.base_version,
                }
            const result = await writeAnnotations(editorAnnMatch[1], { annotations }, writeContext)
            return json(res, 200, result)
          } catch (err: any) {
            const conflict = err instanceof EditorConflictError
            return json(res, conflict ? 409 : httpStatus(err, 400), {
              error: err.message || String(err),
              ...(conflict ? { current_version: err.currentVersion } : {}),
            })
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

        // ── /api/agent-response/:id — body of one agent call ──
        // Only a full 32-hex call id is accepted. The short `response` marker
        // from --logs is not an identity and can become ambiguous.
        const agentRespMatch = url.match(/^\/api\/agent-response\/([0-9a-fA-F]{32})(?:\?|$)/)
        if (agentRespMatch && req.method === 'GET') {
          const callId = agentRespMatch[1]
          try {
            const result = await fetchAgentResponse(callId)
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
            const parsed = await readJson<any>(req)
            const card = createCard(String(parsed.text ?? ''), parsed.lane as Lane, parsed.repo)
            return json(res, 200, card)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }
        const currentMatch = url.match(/^\/api\/current\/(\d+)(?:\?|$)/)
        if (currentMatch) {
          const id = Number(currentMatch[1])
          if (req.method === 'PATCH') {
            try {
              const parsed = await readJson<any>(req)
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
              return json(res, httpStatus(err, 400), { error: err.message || String(err) })
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

        // ── /api/snippets — espanso text-expansion pairs ──
        // Poise manages one espanso match file (<match>/poise.yml) as the
        // single source of truth. GET returns the current pairs, their
        // source-byte version, and whether espanso looks installed (drives a
        // UI hint). PUT conditionally replaces
        // the whole set. See server/snippets.ts. espanso hot-reloads the
        // file, so a successful PUT makes the `;trigger` expansions live
        // immediately — no restart.
        if (url === '/api/snippets' && req.method === 'GET') {
          try {
            const state = await readSnippetState()
            return json(res, 200, { ...state, espansoDetected: espansoDetected() })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (url === '/api/snippets' && req.method === 'PUT') {
          try {
            const body = await readJson<any>(req)
            if (body?.base_version === undefined) {
              return json(res, 428, { error: 'snippet write precondition is required; reload snippets' })
            }
            const state = await saveSnippets(body.snippets, body.base_version)
            return json(res, 200, state)
          } catch (err: any) {
            const conflict = err instanceof SnippetConflictError
            const lockUnavailable = err instanceof ProcessLockError
            return json(res, conflict ? 409 : lockUnavailable ? 503 : httpStatus(err, 400), {
              error: err.message || String(err),
              ...(conflict ? { current_version: err.currentVersion } : {}),
            })
          }
        }
        // POST appends a single pair — used by the editor's "save
        // selection as snippet" action so it needn't hold the full list.
        if (url === '/api/snippets' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await addSnippet(body)
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, err instanceof ProcessLockError ? 503 : httpStatus(err, 400), {
              error: err.message || String(err),
            })
          }
        }

        return next()
      }
}

export function cachePlugin(opts: CachePluginOptions = {}): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      server.middlewares.use(createPoiseMiddleware(opts))
    },
  }
}
