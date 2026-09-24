import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { getModelSettings, getSettings, setSettings } from './settings'
import { MODEL_PLACES, loadCatalog, placeProviders, readCatalogReport, resolveChoice } from './models'
import { refreshModelCatalog } from './models-refresh'
import { claudeAuth, type ClaudeAuthSnapshot } from './claude-auth'
import { getCallerReleaseHealth } from './caller-release'
import { getProductionUpdateHealth } from './production-update'
import { listCards, createCard, setCardText, setCardRepo, moveCard, removeCard, type Lane } from './current'
import { handleGhBody, listOrgRepos, setReviewAgentUsername } from './gh'
import { fetchAgentLogs, fetchAgentResponse, fetchAgentReasoning, triggerPrReview, replayAgentJob, stopAgentJob } from './agent'
import { listChatHistory, sendChat, saveAttachment, runDebate } from './chat'
import { listDocs, readDoc, writeDoc, deleteDoc, newSlug, readAnnotations, writeAnnotations, getOrCreateChatSession, MAX_DOC_BYTES, MAX_ANNOTATIONS_BYTES, EditorConflictError } from './editor'
import { handleSnippetApi } from './snippet-api'
import { setEnabled as setBehaviorEnabled, setSetting as setBehaviorSetting, setScratchpad as setBehaviorScratchpad, setReviewers as setBehaviorReviewers, getEnabledMap, getSettingMap, getScratchpadMap, getReviewers, getBehaviorsRuntimeHealth, isValidSetting, isValidReviewers, isPanelBehavior, getIssueRepositories, setIssueRepositories, isValidRepository, getIssueAuthors, setIssueAuthors, isValidAuthorList, startBehaviorsRuntime, stopBehaviorsRuntime, getResolveUnblockingLastFired, BEHAVIOR_KEYS, type BehaviorKey } from './behaviors'
import { ContentLaunchPendingError, getContentJobResponse, launchAndEnqueueContentJob, startContentFinalizer, stopContentFinalizer } from './content-jobs'
import { ProcessLockError } from './process-lock'
import { ATTACHMENT_MAX_BYTES, enforceApiRequest, httpStatus, readBuffer, readJson, setApiHeaders } from './http'
import { ChatRuntime } from './chat/runtime'
import { ChatSocketServer, handleChatApi } from './chat/transport'
import { getChatSettings } from './settings'
import { buildIdentity } from './build-identity'
import { SelfUpdateService, createSelfUpdateBridge, drainAllowsPath, handleSelfUpdateApi, isSelfUpdateControlRoute, resolveSelfUpdateRoot, unconfiguredSelfUpdateBridge, type SelfUpdateBridge } from './self-update'
import type { Server } from 'node:http'

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
  /** Which Poise server this is; chat sessions are owned per instance and
   *  the dev and production servers never adopt each other's. */
  instanceLabel?: 'dev' | 'production'
  /** The self-update controller client. Omitted: resolved from
   *  POISE_SELF_UPDATE_ROOT / the production default root. `null`: never
   *  configured (tests). */
  selfUpdateBridge?: SelfUpdateBridge | null
}

// Chat v1: one runtime per server process. Sessions are keyed by instance
// (`poise-<label>:<db path>`), so the same database file never hosts two
// servers' sessions and two different databases never mix.
let chatRuntime: ChatRuntime | null = null
let chatSockets: ChatSocketServer | null = null
let selfUpdate: SelfUpdateService | null = null

export function getChatRuntime(): ChatRuntime {
  if (!chatRuntime) throw new Error('the chat runtime is not started')
  return chatRuntime
}

export function getSelfUpdateService(): SelfUpdateService {
  if (!selfUpdate) throw new Error('the chat runtime is not started')
  return selfUpdate
}

/** Serve /ws/chat on an HTTP server (production server or Vite's). */
export function attachChatSockets(server: Server): void {
  if (!chatSockets) throw new Error('the chat runtime is not started')
  chatSockets.attach(server)
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
  if (!chatRuntime) {
    const label = opts.instanceLabel ?? 'dev'
    // The self-update controller is separately installed; without a root
    // (development, tests) the bridge is inert and `/poise` says so.
    const bridge = opts.selfUpdateBridge === undefined
      ? createSelfUpdateBridge({ root: resolveSelfUpdateRoot(label) })
      : opts.selfUpdateBridge ?? unconfiguredSelfUpdateBridge()
    chatRuntime = new ChatRuntime({
      instance: `poise-${label}:${process.env.POISE_DB || 'default'}`,
      instanceLabel: label,
      idleTimeoutMinutes: () => getChatSettings().idleTimeoutMinutes,
      branchPrefix: () => getChatSettings().branchPrefix,
      selfUpdate: bridge,
    })
    chatRuntime.on('log', (line: string) => console.log(line))
    chatSockets = new ChatSocketServer(chatRuntime, { allowedHosts: opts.allowedHosts })
    selfUpdate = new SelfUpdateService(chatRuntime, bridge)
    void chatRuntime.recover().catch((error: unknown) => {
      console.error('[chat] startup reconciliation failed:', error)
    })
  }
}

export async function stopPoiseRuntime(): Promise<void> {
  const authStops = [...activeClaudeAuthRuntimes].map((auth) => auth.stop())
  activeClaudeAuthRuntimes.clear()
  const chatStop = chatRuntime?.stop() ?? Promise.resolve()
  const socketStop = chatSockets?.close() ?? Promise.resolve()
  selfUpdate?.reset()
  chatRuntime = null
  chatSockets = null
  selfUpdate = null
  await Promise.all([stopBehaviorsRuntime(), stopContentFinalizer(), chatStop, socketStop, ...authStops])
}

export function createPoiseMiddleware(opts: CachePluginOptions = {}): Connect.NextHandleFunction {
      startPoiseRuntime(opts)
      const auth = opts.claudeAuth ?? claudeAuth
      return async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/')) return next()
        // A mutating request counts towards release readiness from before
        // the drain gate until its handler has actually finished — not until
        // the response closed, since a client can disconnect while a
        // handler's writes are still settling. The controller's own
        // readiness/drain/resume calls are the one exemption.
        const path = url.split('?')[0]
        const mutating = req.method !== 'GET' && req.method !== 'HEAD'
        const release = selfUpdate && mutating && !isSelfUpdateControlRoute(path) ? selfUpdate.beginApiWrite() : null
        try {
          return await handleApi(req, res, next, url, path, mutating)
        } finally {
          release?.()
        }
      }

      async function handleApi(req: Parameters<Connect.NextHandleFunction>[0], res: ServerResponse, next: Connect.NextFunction, url: string, path: string, mutating: boolean): Promise<void> {
        setApiHeaders(res)
        try {
          enforceApiRequest(req, { allowedHosts: opts.allowedHosts })
        } catch (err) {
          return json(res, httpStatus(err, 403), { error: (err as Error).message })
        }
        if (req.method === 'OPTIONS') {
          return json(res, 405, { error: 'cross-origin preflight is not supported' })
        }

        // ── Self-update: the controller's private endpoints and the public
        // status/revert, ahead of the drain gate they are exempt from ──
        if (selfUpdate && (path === '/api/self-update' || path.startsWith('/api/self-update/'))) {
          if (await handleSelfUpdateApi(req, res, url, selfUpdate)) return
        }
        // Every other mutating request is refused once the controller drains
        // this server, except the few that settle work (cancel, close, stop).
        // It was registered before this check, so a request that was in
        // before the drain is never missed by readiness.
        if (selfUpdate && mutating && selfUpdate.draining && !drainAllowsPath(path)) {
          return json(res, 503, { error: 'Poise is installing an update; try again after it restarts', code: 'draining' })
        }

        if (url === '/api/health' && req.method === 'GET') {
          const scheduler = getBehaviorsRuntimeHealth()
          const claudeAuthState = auth.snapshot()
          const [callerRelease, production] = await Promise.all([
            getCallerReleaseHealth(),
            getProductionUpdateHealth(),
          ])
          const enabled = getEnabledMap()
          const claudeBackedEnabled = enabled['review-new-prs'] || enabled['approve-prs'] || enabled['review-new-issues']
          const healthy = scheduler.status === 'ok'
            && (!claudeBackedEnabled || claudeAuthState.status === 'authenticated')
            && callerRelease.status !== 'invalid'
          // `production` is informational: a stalled updater leaves the
          // running service healthy, so it does not turn this degraded — the
          // health monitor raises that on its own and Settings shows it.
          // `build` is what the release controller verifies after a switch
          // and what the browser compares its own bundle against; both come
          // from the compiled bundle, never from a checkout on disk.
          return json(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            scheduler,
            claudeAuth: claudeAuthState,
            callerRelease,
            production,
            build: buildIdentity(),
            selfUpdate: selfUpdate?.summary() ?? { configured: false, draining: false },
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
            const catalog = body && typeof body === 'object' && 'models' in body ? await loadCatalog() : undefined
            const settings = setSettings(body, catalog)
            return json(res, 200, settings)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }

        // ── Models ──
        // The catalog Caller exports, the default and fallback resolved for
        // every place Poise launches a model, the places Caller decides on its
        // own, and the last daily refresh report.
        if (url === '/api/models' && req.method === 'GET') {
          try {
            const catalog = await loadCatalog()
            const stored = getModelSettings()
            const places = MODEL_PLACES.map((place) => ({
              ...place,
              ...resolveChoice(catalog, place.key, stored[place.key]),
              stored: stored[place.key] || null,
              // Which providers this place may launch; null means all of them.
              providers: placeProviders(catalog, place.key),
            }))
            const fixed = [
              { key: 'content', label: '/content', model: catalog.behaviors.author_content, why: 'Authors content in your voice; set by the Caller catalog.' },
              { key: 'consensus', label: '/consensus', model: catalog.behaviors.debate_moderator, why: `Moderates the debate; participants: ${catalog.debate_participants.join(', ')}.` },
              { key: 'fix_failing_ci', label: 'Fix failing CI', model: catalog.behaviors.fix_failing_ci, why: 'Caller behavior; set by the Caller catalog.' },
              { key: 'issue_simplify', label: 'Simplify issue', model: catalog.behaviors.issue_simplify, why: 'Caller behavior; set by the Caller catalog.' },
              { key: 'canary', label: 'Sign-in check', model: 'haiku', why: 'One minimal Claude request that proves the Claude.ai sign-in; fixed.' },
            ]
            return json(res, 200, { catalog, places, fixed, refresh: await readCatalogReport() })
          } catch (err: any) {
            return json(res, httpStatus(err, 503), { error: err.message || String(err) })
          }
        }
        if (url === '/api/models/refresh' && req.method === 'POST') {
          try {
            const report = await refreshModelCatalog()
            return json(res, 200, report)
          } catch (err: any) {
            return json(res, httpStatus(err, 502), { error: err.message || String(err) })
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
              // How many of the PR review place's reviewers (Settings →
              // Models) review each new pull request, in parallel.
              reviewers: getReviewers('review-new-prs'),
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
              reviewers: null,
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
              reviewers: null,
              scratchpad: null,
              lastTriggered: getResolveUnblockingLastFired(),
            },
            // Review New Issues is opt-in per repository: nothing triggers
            // until `repos` names one. `authors` are the trusted accounts
            // whose issues it reviews.
            'review-new-issues': {
              owner: opts.reviewAgentUsername || null,
              enabled: enabled['review-new-issues'],
              setting: null,
              reviewers: getReviewers('review-new-issues'),
              repos: getIssueRepositories().map((entry) => entry.repo),
              authors: getIssueAuthors(),
              scratchpad: scratch['review-new-issues'],
              lastTriggered: lastFor('issue_review', 'poise:review-new-issues'),
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

        // POST /api/behaviors/<key> { enabled?, setting?, reviewers?: 1|2|3, repos?: string[], authors?: string[], scratchpad? }
        // — every field optional; several can be sent in one call.
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
            if ('reviewers' in body) {
              if (!isPanelBehavior(key)) {
                return json(res, 400, { error: 'only the review behaviors have a reviewer count' })
              }
              if (!isValidReviewers(body.reviewers)) {
                return json(res, 400, { error: 'reviewers must be 1, 2 or 3' })
              }
            }
            if (('repos' in body || 'authors' in body) && key !== 'review-new-issues') {
              return json(res, 400, { error: 'only review-new-issues takes repositories and authors' })
            }
            if ('repos' in body) {
              if (!Array.isArray(body.repos) || body.repos.length > 200 || !body.repos.every(isValidRepository)) {
                return json(res, 400, { error: 'repos must be a list of owner/name repositories' })
              }
              // Only a repository being added needs proving: it must be one
              // the configured organization has.
              const selected = new Set(getIssueRepositories().map((entry) => entry.repo))
              const added = (body.repos as string[]).filter((repo) => !selected.has(repo))
              if (added.length) {
                let known: Set<string>
                try {
                  known = new Set(await listOrgRepos())
                } catch (err: any) {
                  return json(res, 502, { error: 'could not list the organization repositories: ' + (err.message || String(err)) })
                }
                const unknown = added.filter((repo) => !known.has(repo))
                if (unknown.length) return json(res, 400, { error: 'not a repository of the organization: ' + unknown.join(', ') })
              }
            }
            if ('authors' in body && !isValidAuthorList(body.authors)) {
              return json(res, 400, { error: 'authors must be up to 20 GitHub usernames' })
            }
            if ('scratchpad' in body) {
              if (typeof body.scratchpad !== 'string') {
                return json(res, 400, { error: 'scratchpad must be a string' })
              }
              // A memory write is a blind overwrite of whatever is stored. Two
              // Poise windows editing the same behavior meant the later save
              // silently discarded the earlier one. When the client says what
              // it believed was stored, hold it to that and let it re-read.
              if (typeof body.scratchpadPrevious === 'string'
                && getScratchpadMap()[key] !== body.scratchpadPrevious) {
                return json(res, 409, {
                  error: 'the memory changed since it was loaded',
                  scratchpad: getScratchpadMap()[key],
                })
              }
            }
            // Persist passive configuration first; enabling last guarantees
            // the first tick observes the submitted setting and memory.
            if ('setting' in body) setBehaviorSetting(key, body.setting)
            if ('reviewers' in body && isPanelBehavior(key)) setBehaviorReviewers(body.reviewers, key)
            if ('repos' in body) setIssueRepositories(body.repos)
            if ('authors' in body) setIssueAuthors(body.authors)
            if ('scratchpad' in body) setBehaviorScratchpad(key, body.scratchpad)
            if ('enabled' in body) await setBehaviorEnabled(key, body.enabled)
            return json(res, 200, {
              ok: true,
              enabled: getEnabledMap()[key],
              setting: getSettingMap()[key],
              reviewers: isPanelBehavior(key) ? getReviewers(key) : null,
              ...(key === 'review-new-issues' ? {
                repos: getIssueRepositories().map((entry) => entry.repo),
                authors: getIssueAuthors(),
              } : {}),
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

        // ── /api/chat/* — Chat v1 sessions (server/chat) ──
        // Handled before the legacy per-card chat below, whose matchers use
        // the exact `/api/chat` path or the `/api/chat-…` prefixes.
        if (url.startsWith('/api/chat/') && chatRuntime) {
          if (await handleChatApi(req, res, url, chatRuntime)) return
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
            // 202 when the agent is running but its call row has not been
            // identified yet — the recovery pass links it shortly. It is not a
            // failure and must not be reported as one.
            return json(res, (job as { pending?: boolean }).pending ? 202 : 200, job)
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

        // ── /api/agent-stop — interrupt a running agent-interface call ─
        // Body: { id }. Caller signals the call's process group and closes
        // the row as failed / "stopped"; the Swarm row settles on the next
        // poll. Used by the Swarm view's Stop column.
        if (url === '/api/agent-stop' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const id = String(body.id || '').toLowerCase()
            // A Chat turn has no Caller process to signal: Stop goes to the
            // runtime that owns the session, and only that one. A turn of the
            // other Poise server is reported, never touched.
            const chatTurn = chatRuntime && /^[0-9a-f]{32}$/.test(id) ? chatRuntime.describeTurn(id) : null
            if (chatTurn) {
              const { settled } = await chatRuntime!.cancel(chatTurn.sessionId)
              return json(res, 200, { id, stopped: settled, status: settled ? 'cancelled' : 'stopping', error_code: 'stopped' })
            }
            if (/^[0-9a-f]{32}$/.test(id)) {
              const row = (await fetchAgentLogs().catch(() => [])).find((entry) => entry.id === id)
              if (row && row.runner === 'external') {
                return json(res, 409, { error: 'this turn belongs to another Poise server; stop it from that server\'s Chat view' })
              }
            }
            const result = await stopAgentJob(id)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = (stderr || err?.message || String(err)).trim()
            return json(res, httpStatus(err, 502), { error: 'agent-stop failed: ' + msg })
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

        const reasoningMatch = url.match(/^\/api\/agent-reasoning\/([0-9a-fA-F]{32})(?:\?|$)/)
        if (reasoningMatch && req.method === 'GET') {
          try {
            return json(res, 200, await fetchAgentReasoning(reasoningMatch[1]))
          } catch (err: any) {
            return json(res, 502, { error: 'agent-interface --read-reasoning failed: ' + (err.message || String(err)) })
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

        if (await handleSnippetApi(req, res, url)) return

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
