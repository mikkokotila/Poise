import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import type { ChatEnvelope, ChatEvent, ClientFrame, SessionRecord } from '../../server/chat/protocol'
import type { SelfChange, SelfUpdateStatus } from '../../src/self-update-types'

// The browser side of a Poise self-change against a scripted server: the
// typed `/poise` entrypoint, the deploy card that follows the supervisor's
// status independently of the agent, one-click rollback bound to the exact
// release, and the draft snapshot a safe reload leaves behind for the next
// page. REST goes through page.route, the socket through page.routeWebSocket.

const NOW = '2026-09-19T09:00:00.000Z'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1', agent: 'claude', model: 'opus-5-max', modelId: 'claude-opus-5', effort: 'max',
    repo: '', checkout: '/poise/.poise-chat/workspace', workspaceKind: 'poise-local', branch: { name: 'chat/generated', origin: 'new', provisional: true },
    title: 'Talking about Poise', createdAt: NOW, updatedAt: NOW, status: 'idle',
    capabilities: { steer: true, fork: true, thought: true, plan: true, commands: true, modes: true, permissions: true, questions: true, resume: true, images: false },
    mode: 'default', modes: [{ id: 'default', name: 'Default' }],
    commands: [{ name: 'review', description: 'Review the branch' }],
    efforts: ['max', 'xhigh'], lastSeq: 0, pendingRequests: [], instance: 'poise-prod:test',
    workspace: { currentBranch: 'chat/generated', onBranch: true, dirty: false, dirtyFiles: 0, checkedAt: NOW },
    ...overrides,
  }
}

function change(overrides: Partial<SelfChange> = {}): SelfChange {
  return {
    id: '00000000-0000-4000-8000-000000000000', sessionId: 's1', instance: 'poise-prod:test', request: 'Add a Stop button to the Swarm header', title: 'Add a Stop button to the Swarm header',
    repository: 'mikkokotila/Poise', branch: 'poise/change-0000', baseSha: SHA_A, state: 'implementing', createdAt: NOW, updatedAt: NOW, canRevert: false,
    ...overrides,
  }
}

const AGENTS = {
  agents: [
    { id: 'claude', label: 'Claude Code', available: true, models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max' }, { identity: 'opus-5-high', selector: 'claude-opus-5', effort: 'high' }], efforts: ['max', 'high'] },
    { id: 'codex', label: 'Codex', available: true, models: [{ identity: 'gpt-6-astra-max', selector: 'gpt-6-astra', effort: 'max' }], efforts: ['max'] },
  ],
  defaults: { model: 'opus-5-max', fallback: 'gpt-6-astra-max' },
  settings: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 },
}

interface ServerState {
  sessions: SessionRecord[]
  history: Record<string, ChatEnvelope[]>
  calls: { method: string, path: string, query: Record<string, string>, body: unknown }[]
  /** `null` plays an older server: `{}` for every unknown route. */
  status: SelfUpdateStatus | null
  revert: (body: { changeId: string, expectedReleaseId: string }) => { status: number, json: unknown }
  /** `/api/health` body; `{}` (no build identity) unless a test sets it. */
  health: unknown
  /** Editor API, for the tests that open a document. */
  editor?: (path: string, method: string, route: Route) => Promise<void>
}

function makeState(sessions: SessionRecord[]): ServerState {
  return {
    sessions, history: Object.fromEntries(sessions.map((s) => [s.id, []])), calls: [], status: null,
    revert: () => ({ status: 500, json: { error: 'not scripted' } }),
    health: {},
  }
}

async function installRoutes(page: Page, state: ServerState): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    const body = method === 'POST' || method === 'PATCH' ? (req.postDataJSON?.() ?? null) : null
    state.calls.push({ method, path, query: Object.fromEntries(url.searchParams), body })
    if (path === '/api/health') { await route.fulfill({ json: state.health }); return }
    if (state.editor && path.startsWith('/api/editor/')) { await state.editor(path, method, route); return }
    if (path === '/api/settings') { await route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } } }); return }
    if (path === '/api/models') { await route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } }); return }
    if (path === '/api/claude-auth') { await route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: NOW, verifiedAt: NOW, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false } }); return }
    if (path === '/api/repos') { await route.fulfill({ json: { repos: [] } }); return }
    if (path === '/api/chat/agents') { await route.fulfill({ json: AGENTS }); return }
    if (path === '/api/chat/sessions' && method === 'GET') { await route.fulfill({ json: { sessions: state.sessions, instance: 'poise-prod:test' } }); return }
    if (path === '/api/chat/sessions' && method === 'POST') {
      const req2 = body as { agent: SessionRecord['agent'], model: string, effort: string, title?: string }
      const created = session({ id: `new-${state.sessions.length + 1}`, agent: req2.agent, model: req2.model, effort: req2.effort, title: req2.title || '', status: 'starting', createdAt: new Date().toISOString() })
      state.sessions.unshift(created)
      state.history[created.id] = []
      await route.fulfill({ status: 201, json: { session: created } })
      return
    }
    if (path === '/api/self-update' && method === 'GET') {
      if (!state.status) { await route.fulfill({ json: {} }); return }
      await route.fulfill({ json: state.status })
      return
    }
    if (path === '/api/self-update/revert' && method === 'POST') {
      const answer = state.revert(body as { changeId: string, expectedReleaseId: string })
      await route.fulfill({ status: answer.status, json: answer.json })
      return
    }
    const m = /^\/api\/chat\/sessions\/([^/]+)$/.exec(path)
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1])
      const s = state.sessions.find((x) => x.id === id)
      if (!s) { await route.fulfill({ status: 404, json: { error: 'unknown session' } }); return }
      const after = Number(url.searchParams.get('after') || 0)
      await route.fulfill({ json: { session: s, events: (state.history[id] || []).filter((e) => e.seq > after) } })
      return
    }
    await route.fulfill({ json: {} })
  })
}

interface Socket {
  frames: ClientFrame[]
  ws: WebSocketRoute | null
  /** Answer for `poise.change`; every other frame is acked plainly. */
  onPoiseChange: (frame: ClientFrame) => { ok: true, result: unknown } | { ok: false, error: string, code?: string }
  seq: number
  push(sessionId: string, event: ChatEvent): void
  framesOf(type: string): ClientFrame[]
  subscribed(sessionId: string): Promise<void>
}

async function installSocket(page: Page): Promise<Socket> {
  const sock: Socket = {
    frames: [], ws: null, seq: 0,
    onPoiseChange: () => ({ ok: false, error: 'not scripted' }),
    push(sessionId, event) {
      const envelope: ChatEnvelope = { seq: ++sock.seq, sessionId, at: new Date().toISOString(), event }
      sock.ws!.send(JSON.stringify({ kind: 'event', envelope }))
    },
    framesOf(type) { return sock.frames.filter((f) => f.command.type === type) },
    async subscribed(sessionId) {
      await expect.poll(() => sock.frames.some((f) => f.command.type === 'subscribe' && f.command.sessionId === sessionId)).toBe(true)
    },
  }
  await page.routeWebSocket('**/ws/chat', (ws) => {
    sock.ws = ws
    ws.send(JSON.stringify({ kind: 'hello', instance: 'poise-prod:test', serverStartedAt: NOW }))
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as ClientFrame
      sock.frames.push(frame)
      if (frame.command.type === 'poise.change') {
        const answer = sock.onPoiseChange(frame)
        ws.send(JSON.stringify(answer.ok ? { kind: 'ack', id: frame.id, ok: true, result: answer.result } : { kind: 'ack', id: frame.id, ok: false, error: answer.error, code: answer.code }))
        return
      }
      ws.send(JSON.stringify({ kind: 'ack', id: frame.id, ok: true }))
    })
  })
  return sock
}

const input = (page: Page) => page.locator('.chat-v-composer .chat-input')
const card = (page: Page) => page.locator('.chat-deploy')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('self-update-fixture-initialized')) {
      localStorage.clear()
      localStorage.setItem('poise-view', 'chat')
      sessionStorage.setItem('self-update-fixture-initialized', '1')
    }
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

for (const prefix of ['', '/poise ']) test(`${prefix ? '/poise' : 'A natural request'} sends one change and follows it to one-click rollback`, async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  const dedicated = session({ id: 'change-session', title: 'Poise change: Add a Stop button', workspaceKind: 'poise-change', selfChangeId: change().id, repo: 'mikkokotila/Poise', checkout: '/tmp/poise-change', branch: { name: 'poise/change-0000', origin: 'existing', provisional: false }, status: 'running' })
  sock.onPoiseChange = (frame) => {
    const cmd = frame.command as { sessionId: string, text: string, changeId: string }
    state.sessions.unshift(dedicated)
    state.history[dedicated.id] = [{ seq: 1, sessionId: dedicated.id, at: NOW, event: { type: 'turn.started', turnId: 't1', prompt: { text: cmd.text, attachments: [], mentions: [] } } }]
    state.status = { enabled: true, available: true, activeRelease: { id: 'r1', sha: SHA_A, root: '/r/r1', createdAt: NOW, callerSha: 'c' }, previousRelease: null, hold: null, changes: [change({ id: cmd.changeId, sessionId: cmd.sessionId, request: cmd.text })] }
    return { ok: true, result: { session: dedicated, change: change({ id: cmd.changeId, sessionId: cmd.sessionId, request: cmd.text }) } }
  }
  await page.goto('/')
  await sock.subscribed('s1')
  // Nothing about updates is on screen for a session without a change.
  await expect(card(page)).toHaveCount(0)
  await expect(page.locator('.self-update-banner')).toHaveCount(0)

  await input(page).fill(`${prefix}Add a Stop button to the Swarm header`)
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('poise.change').length).toBe(1)
  const cmd = sock.framesOf('poise.change')[0].command as { type: string, sessionId: string, text: string, changeId: string }
  expect(cmd).toMatchObject({ type: 'poise.change', sessionId: 's1', text: 'Add a Stop button to the Swarm header' })
  expect(cmd.changeId).toMatch(UUID)
  // No ordinary prompt travelled alongside the command.
  expect(sock.framesOf('prompt')).toHaveLength(0)

  // The dedicated session is selected and subscribed; its first turn is the request.
  await sock.subscribed('change-session')
  await expect(page.locator('.chat-session-item.active')).toContainText('Poise change')
  await expect(page.locator('.chat-h-repo')).toContainText('Poise · change')
  await expect(page.locator('.chat-msg-user')).toContainText('Add a Stop button to the Swarm header')
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toHaveAttribute('data-state', 'implementing')
  await expect(card(page)).toContainText('Add a Stop button to the Swarm header')
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/self-update').map((c) => c.query.session)).toContain('change-session')

  // The card keeps following the supervisor without any agent event.
  state.status = { ...state.status!, changes: [change({ id: cmd.changeId, request: cmd.text, state: 'awaiting_ci', prNumber: 91, prUrl: 'https://github.com/mikkokotila/Poise/pull/91', headSha: SHA_B })] }
  await expect(card(page)).toHaveAttribute('data-state', 'awaiting_ci', { timeout: 10_000 })
  await expect(card(page).locator('a[href="https://github.com/mikkokotila/Poise/pull/91"]')).toHaveText('PR #91')
  await expect(card(page)).toContainText('bbbbbbb')
  await expect(card(page).locator('.chat-deploy-revert')).toHaveCount(0)

  state.status = {
    ...state.status!,
    activeRelease: { id: 'r2', sha: SHA_B, root: '/r/r2', createdAt: NOW, callerSha: 'c' },
    previousRelease: { id: 'r1', sha: SHA_A, root: '/r/r1', createdAt: NOW, callerSha: 'c' },
    changes: [change({ id: cmd.changeId, request: cmd.text, state: 'live', prNumber: 91, prUrl: 'https://github.com/mikkokotila/Poise/pull/91', headSha: SHA_B, mergeSha: SHA_B, releaseId: 'r2', previousReleaseId: 'r1', canRevert: true })],
  }
  await expect(card(page)).toHaveAttribute('data-state', 'live', { timeout: 10_000 })
  await expect(card(page)).toContainText('r2')
  // Hiding activity leaves the card in place.
  await page.locator('.chat-h-activity').click()
  await expect(page.locator('.chat-h-activity')).toHaveAttribute('aria-pressed', 'false')
  await expect(card(page)).toBeVisible()

  const revert = card(page).locator('.chat-deploy-revert')
  await expect(revert).toBeVisible()
  await expect(revert).toHaveText('Revert')
  if (!prefix) await page.screenshot({ path: test.info().outputPath('self-update-live.png') })
  state.revert = (body) => {
    const reverting = change({ id: body.changeId, request: cmd.text, state: 'reverting', releaseId: 'r2', previousReleaseId: 'r1', canRevert: false })
    state.status = { ...state.status!, changes: [reverting] }
    return { status: 200, json: { change: reverting } }
  }
  await revert.click()
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/self-update/revert').map((c) => c.body)).toEqual([{ changeId: cmd.changeId, expectedReleaseId: 'r2' }])
  await expect(card(page)).toHaveAttribute('data-state', 'reverting')
  await expect(card(page)).toContainText('Revert requested')
  await expect(revert).toHaveCount(0)
})

test('keeps the request in the composer, sends no prompt and opens nothing when the feature is not set up', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  sock.onPoiseChange = () => ({ ok: false, error: 'install the self-update controller first (npm run install:self-update)', code: 'self_update_unavailable' })
  await page.goto('/')
  await sock.subscribed('s1')
  await input(page).fill('/poise Rename the Swarm view')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('poise.change').length).toBe(1)
  const notice = page.locator('.chat-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('not set up on this server')
  await expect(notice).toContainText('install the self-update controller first')
  await expect(notice).toContainText('nothing was sent to a model')
  await expect(input(page)).toHaveValue('/poise Rename the Swarm view')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await expect(page.locator('.chat-session-item')).toHaveCount(1)
  await expect(page.locator('.chat-msg-user')).toHaveCount(0)
  await expect(card(page)).toHaveCount(0)
  // Only the prefix: nothing goes anywhere.
  await input(page).fill('Poise:')
  await input(page).press('Enter')
  await expect(notice).toContainText('Type the change after /poise')
  expect(sock.framesOf('poise.change')).toHaveLength(1)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await expect(input(page)).toHaveValue('Poise:')
})

test('Poise: from a fresh console first creates an ordinary session on the chosen model, then only the command', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  const dedicated = session({ id: 'change-session', title: 'Poise change', workspaceKind: 'poise-change', selfChangeId: change().id })
  sock.onPoiseChange = (frame) => {
    const cmd = frame.command as { sessionId: string, text: string, changeId: string }
    state.sessions.unshift(dedicated)
    state.history[dedicated.id] = []
    return { ok: true, result: { session: dedicated, change: change({ id: cmd.changeId, sessionId: cmd.sessionId, request: cmd.text }) } }
  }
  await page.goto('/')
  await expect(page.locator('.chat-main')).toHaveClass(/chat-empty-session/)
  await page.locator('.chat-default-model').click()
  await page.locator('#chat-console-models [data-identity="gpt-6-astra-max"]').click()
  await expect(page.locator('.chat-default-model')).toHaveText('GPT 6 Astra · Max')
  await input(page).fill('Poise: Make the Behaviors table sortable')
  await input(page).press('Enter')
  await expect.poll(() => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions').map((c) => c.body)).toEqual([
    { agent: 'codex', model: 'gpt-6-astra-max', effort: 'max', title: 'Poise: Make the Behaviors table sortable', safeMode: false },
  ])
  await expect.poll(() => sock.framesOf('poise.change').length).toBe(1)
  expect(sock.framesOf('poise.change')[0].command).toMatchObject({ sessionId: 'new-1', text: 'Make the Behaviors table sortable' })
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await sock.subscribed('change-session')
  await expect(page.locator('.chat-session-item.active')).toContainText('Poise change')
  await expect(card(page)).toBeVisible()
  // An ordinary message still goes the ordinary way, mentions of Poise included.
  await page.locator('.chat-session-item', { hasText: 'Poise: Make the Behaviors table sortable' }).click()
  await expect(page.locator('.chat-session-item.active')).toContainText('Poise: Make')
  await input(page).fill('What does Poise: mean in the docs?')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('poise.change')).toHaveLength(1)
})

test('the /poise command is offered in the palette and locks into a chip that runs the command', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  sock.onPoiseChange = () => ({ ok: false, error: 'nope', code: 'self_update_unavailable' })
  await page.goto('/')
  await sock.subscribed('s1')
  await input(page).fill('/po')
  await expect(page.locator('.chat-pop-label')).toHaveText(['/poise'])
  await input(page).fill('/poise')
  await input(page).press('Space')
  await expect(page.locator('.chat-v-chip')).toHaveText('/poise')
  await input(page).fill('Tidy the menu')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('poise.change').length).toBe(1)
  expect(sock.framesOf('poise.change')[0].command).toMatchObject({ sessionId: 's1', text: 'Tidy the menu' })
  expect(sock.framesOf('prompt')).toHaveLength(0)
  // Refused: the whole command comes back editable.
  await expect(input(page)).toHaveValue('Tidy the menu')
  await expect(page.locator('.chat-v-chip')).toHaveText('/poise')
})

test('restores every draft, the fresh model and the active session from the snapshot a safe reload left behind, once', async ({ page }) => {
  const state = makeState([session({ id: 'newer', title: 'Newer', createdAt: '2026-09-19T10:00:00.000Z' }), session({ id: 'older', title: 'Older' })])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('snapshot-seeded')) return
    sessionStorage.setItem('snapshot-seeded', '1')
    sessionStorage.setItem('poise-chat-draft-snapshot', JSON.stringify({
      version: 1, savedAt: Date.now(), fromSha: null, activeSessionId: 'older',
      fresh: { draft: { text: 'fresh thought', attachments: [], mentions: [], mode: null }, modelIdentity: 'gpt-6-astra-max' },
      sessions: {
        older: { text: 'resume me', attachments: [{ id: 'a1', name: 'notes.txt', path: '.poise-chat/notes.txt', size: 12 }], mentions: [], mode: null },
        newer: { text: 'other draft', attachments: [], mentions: [], mode: 'review' },
        gone: { text: 'nobody', attachments: [], mentions: [], mode: null },
      },
    }))
  })
  await page.goto('/')
  await sock.subscribed('older')
  await expect(page.locator('.chat-session-item.active')).toContainText('Older')
  await expect(input(page)).toHaveValue('resume me')
  await expect(page.locator('.chat-attachment-chip')).toContainText('notes.txt')
  expect(await page.evaluate(() => localStorage.getItem('poise-chat-draft-snapshot'))).toBeNull()
  await page.locator('.chat-session-item', { hasText: 'Newer' }).click()
  await expect(page.locator('.chat-session-item.active')).toContainText('Newer')
  await expect(input(page)).toHaveValue('other draft')
  await expect(page.locator('.chat-v-chip')).toHaveText('/review')
  // The old update snapshot is consumed once; ordinary refresh keeps the
  // current tab draft, not the old contents of that snapshot.
  await input(page).fill('A newer review draft')
  await page.reload()
  await sock.subscribed('newer')
  await expect(page.locator('.chat-session-item.active')).toContainText('Newer')
  await expect(input(page)).toHaveValue('A newer review draft')
  await expect(page.locator('.chat-v-chip')).toHaveText('/review')
  expect(await page.evaluate(() => localStorage.getItem('poise-chat-draft-snapshot'))).toBeNull()
})

test('restores the fresh console draft and model choice without opening a session', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  await installSocket(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fresh-snapshot-seeded')) return
    sessionStorage.setItem('fresh-snapshot-seeded', '1')
    sessionStorage.setItem('poise-chat-draft-snapshot', JSON.stringify({
      version: 1, savedAt: Date.now(), fromSha: null, activeSessionId: null,
      fresh: { draft: { text: 'fresh thought', attachments: [], mentions: [], mode: null }, modelIdentity: 'gpt-6-astra-max' },
      sessions: {},
    }))
  })
  await page.goto('/')
  await expect(page.locator('.chat-main')).toHaveClass(/chat-empty-session/)
  await expect(input(page)).toHaveValue('fresh thought')
  await expect(page.locator('.chat-default-model')).toHaveText('GPT 6 Astra · Max')
  await expect(page.locator('.chat-session-item.active')).toHaveCount(0)
  expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  // A normal refresh preserves newer writing without selecting an unrelated
  // existing session or replaying the already-consumed update snapshot.
  await input(page).fill('A newer fresh thought')
  await page.reload()
  await expect(page.locator('.chat-session-item.active')).toHaveCount(0)
  await expect(input(page)).toHaveValue('A newer fresh thought')
  await expect(page.locator('.chat-default-model')).toHaveText('GPT 6 Astra · Max')
  expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(0)
})

test('an older server that knows nothing about updates leaves the view exactly as it was', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  await input(page).fill('Ordinary message')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  await expect(page.locator('.chat-msg-user')).toContainText('Ordinary message')
  await expect(card(page)).toHaveCount(0)
  await expect(page.locator('.self-update-banner')).toHaveCount(0)
  await expect(page.locator('.chat-notice')).toBeHidden()
})

// ── On a real release build ───────────────────────────────────────────────
// The e2e web server builds from this dirty checkout, so its bundle carries no
// BUILD_SHA and the build watch is inert by design. To prove the reload path
// the working tree is copied into a fresh repository and committed, which is a
// clean checkout at a real SHA — exactly what a release build is — and its
// client bundle is served statically. No product code knows about this.

interface ReleaseFixture { baseURL: string, sha: string, close(): Promise<void> }

async function buildCleanRelease(): Promise<ReleaseFixture> {
  const repo = process.cwd()
  const root = resolve(repo, 'test-results/e2e/release-source')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' })
    .split('\0').filter((f) => f && existsSync(resolve(repo, f)))
  for (const f of files) {
    mkdirSync(dirname(resolve(root, f)), { recursive: true })
    cpSync(resolve(repo, f), resolve(root, f))
  }
  symlinkSync(resolve(repo, 'node_modules'), resolve(root, 'node_modules'), 'dir')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'release fixture')
  const sha = git('rev-parse', 'HEAD')
  execFileSync(process.execPath, [resolve(repo, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], {
    cwd: root, env: { ...process.env, POISE_RELEASE_SHA: sha }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const clientRoot = resolve(root, 'dist/client')
  const bundle = readdirSync(resolve(clientRoot, 'assets')).find((f) => /^index-.*\.js$/.test(f))!
  if (!readFileSync(resolve(clientRoot, 'assets', bundle), 'utf8').includes(sha)) throw new Error('the release bundle does not carry its own SHA')
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname)
    let file = join(clientRoot, path)
    if (!file.startsWith(clientRoot) || !existsSync(file) || path === '/') file = join(clientRoot, 'index.html')
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { baseURL: `http://127.0.0.1:${port}`, sha, close: () => new Promise((done) => server.close(() => done())) }
}

test.describe('on a release build', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 })
  let release: ReleaseFixture

  test.beforeAll(async () => { release = await buildCleanRelease() })
  test.afterAll(async () => { await release?.close() })

  const NEW_BUILD = { status: 'ok', build: { sha: SHA_B, releaseId: 'r2' } }
  const openSettings = async (page: Page) => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('[data-action="settings"]').click()
    await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  }

  test('QC2: updating from another view preserves Chat drafts before Chat has mounted', async ({ page }) => {
    const state = makeState([session()]); state.health = NEW_BUILD
    await installRoutes(page, state); const sock = await installSocket(page)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('qc-cold-chat')) return
      sessionStorage.setItem('qc-cold-chat', '1')
      sessionStorage.setItem('self-update-fixture-initialized', '1')
      localStorage.setItem('poise-view', 'current')
      sessionStorage.setItem('poise-chat-draft-snapshot', JSON.stringify({ version: 1, savedAt: Date.now(), fromSha: null,
        activeSessionId: 's1', fresh: { draft: null, modelIdentity: null }, sessions: {
          s1: { text: 'Keep this unsent review', mode: 'review', model: 'gpt-6-astra-max', attachments: [], mentions: [] },
        } }))
    })
    let loads = 0; page.on('load', () => { loads++ })
    await page.goto(release.baseURL)
    const banner = page.locator('.self-update-banner'); await expect(banner).toBeVisible()
    expect(state.calls.some(call => call.path === '/api/chat/sessions')).toBe(false)
    await banner.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => loads).toBe(2)
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('poise-chat-draft-snapshot') || '{}'))
    expect(saved.sessions?.s1).toMatchObject({ text: 'Keep this unsent review', mode: 'review', model: 'gpt-6-astra-max' })
    await page.evaluate(() => localStorage.setItem('poise-view', 'chat')); await page.reload()
    await sock.subscribed('s1'); await expect(input(page)).toHaveValue('Keep this unsent review')
    await expect(page.locator('.chat-v-chip')).toHaveText('/review')
    expect(sock.framesOf('prompt')).toHaveLength(0)
  })

  test('reloads itself once onto the new build when idle — closed panels do not hold it — restores the draft, and never loops', async ({ page }) => {
    const state = makeState([session()])
    state.health = NEW_BUILD
    await installRoutes(page, state)
    const sock = await installSocket(page)
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.goto(`${release.baseURL}/`)
    await sock.subscribed('s1')
    expect(await page.evaluate(() => sessionStorage.getItem('poise-self-update-reloaded-release'))).toBeNull()
    // The bundle really is this SHA, and the server really reports another.
    await expect.poll(() => state.calls.filter((c) => c.path === '/api/health').length).toBeGreaterThan(0)
    const banner = page.locator('.self-update-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(`A new Poise build is live (${SHA_B.slice(0, 7)})`)
    // Every panel exists closed and off-screen from the first paint; open and
    // close Settings on top of that. None of it may hold the reload.
    await openSettings(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
    await input(page).fill('carry me over')
    // Ten seconds of idleness later the tab goes on its own, drafts first.
    await page.waitForFunction(() => sessionStorage.getItem('poise-self-update-reloaded-release') === 'r2', null, { timeout: 25_000 })
    await sock.subscribed('s1')
    await expect(input(page)).toHaveValue('carry me over')
    expect(loads).toBe(2)
    expect(await page.evaluate(() => localStorage.getItem('poise-chat-draft-snapshot'))).toBeNull()
    // Same bundle, same disagreement: the banner says so and the tab stays put.
    await expect(banner).toContainText('did not pick up the new Poise build')
    await expect(banner.locator('.self-update-refresh')).toBeEnabled()
    await page.waitForTimeout(13_000)
    expect(loads).toBe(2)
    await expect(input(page)).toHaveValue('carry me over')
  })

  test('an explicit Refresh keeps drafts, goes through an open clean panel, but waits for unsaved Settings text until it is cleared', async ({ page }) => {
    const state = makeState([session()])
    state.health = NEW_BUILD
    await installRoutes(page, state)
    const sock = await installSocket(page)
    // This tab already reloaded for r2 once: only a person can go now.
    await page.addInitScript(() => { sessionStorage.setItem('poise-self-update-reloaded-release', 'r2') })
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.goto(`${release.baseURL}/`)
    await sock.subscribed('s1')
    const banner = page.locator('.self-update-banner')
    await expect(banner).toContainText('did not pick up')
    await input(page).fill('explicit draft')
    await openSettings(page)
    const org = page.locator('#settings-panel input').first()
    await expect(org).toHaveValue('acme')
    await org.fill('acme-typed')
    await banner.locator('.self-update-refresh').click()
    await expect(banner).toContainText('Refresh is waiting for unsaved text on the page')
    await expect(banner.locator('.self-update-refresh')).toBeDisabled()
    await page.waitForTimeout(3_000)
    expect(loads).toBe(1)
    await expect(org).toHaveValue('acme-typed')
    // Back to what it was, focus elsewhere, panel still open: clean, so it goes.
    await org.fill('acme')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect(page.locator('#settings-panel')).toHaveClass(/open/)
    await page.waitForFunction(() => performance.getEntriesByType('navigation').some((e) => (e as PerformanceNavigationTiming).type === 'reload'), null, { timeout: 15_000 })
    await sock.subscribed('s1')
    expect(loads).toBe(2)
    await expect(input(page)).toHaveValue('explicit draft')
  })

  test('an explicit Refresh waits for an Editor save still in flight after the person left the Editor', async ({ page }) => {
    const state = makeState([session()])
    state.health = NEW_BUILD
    const VERSION = 'e'.repeat(64)
    let releaseSave: (() => void) | null = null
    const saved = new Promise<void>((done) => { releaseSave = done })
    let saves = 0
    state.editor = async (path, method, route) => {
      if (path === '/api/editor/docs') { await route.fulfill({ json: { docs: [{ slug: 'notes', title: 'Notes', updated_at: NOW, size: 12 }] } }); return }
      if (path === '/api/editor/doc/notes/annotations') { await route.fulfill({ json: { annotations: [], version: VERSION } }); return }
      if (path === '/api/editor/doc/notes' && method === 'GET') { await route.fulfill({ json: { slug: 'notes', content: '# Notes\n\nhello', version: VERSION } }); return }
      if (path === '/api/editor/doc/notes' && method === 'PUT') {
        saves += 1
        // The save hangs until the test lets it through.
        await saved
        await route.fulfill({ json: { version: VERSION, title: 'Notes', updated_at: NOW, size: 20 } })
        return
      }
      await route.fulfill({ json: {} })
    }
    await installRoutes(page, state)
    const sock = await installSocket(page)
    await page.addInitScript(() => { sessionStorage.setItem('poise-self-update-reloaded-release', 'r2') })
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.goto(`${release.baseURL}/`)
    await sock.subscribed('s1')
    await page.locator('.nav-item[data-view="editor"]').click()
    const doc = page.locator('#editor-doc')
    await expect(doc).toContainText('hello')
    await doc.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' and more')
    await expect(page.locator('#editor-meta')).toContainText(/Editing|Saving/)
    // Leaving the Editor flushes the save, which is now stuck on the wire.
    await page.locator('.nav-item[data-view="chat"]').click()
    await expect(page.locator('#view-editor')).toBeHidden()
    await expect.poll(() => saves).toBe(1)
    await expect(page.locator('#editor-meta')).toHaveText('Saving…')
    const banner = page.locator('.self-update-banner')
    await banner.locator('.self-update-refresh').click()
    await expect(banner).toContainText('Refresh is waiting for the document being saved')
    await page.waitForTimeout(3_000)
    expect(loads).toBe(1)
    releaseSave!()
    await expect(page.locator('#editor-meta')).toContainText('saved')
    await page.waitForFunction(() => performance.getEntriesByType('navigation').some((e) => (e as PerformanceNavigationTiming).type === 'reload'), null, { timeout: 15_000 })
    expect(loads).toBe(2)
  })

  test('an explicit Refresh goes past a pending question but not past a half-typed answer', async ({ page }) => {
    const state = makeState([session({ status: 'waiting', pendingRequests: ['q1'] })])
    state.history.s1 = [
      { seq: 1, sessionId: 's1', at: NOW, event: { type: 'turn.started', turnId: 't1', prompt: { text: 'Which colour?', attachments: [], mentions: [] } } },
      { seq: 2, sessionId: 's1', at: NOW, event: { type: 'question.asked', id: 'q1', turnId: 't1', questions: [{ id: 'c', question: 'Pick a colour', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false, freeText: true }] } },
    ]
    state.health = NEW_BUILD
    await installRoutes(page, state)
    const sock = await installSocket(page)
    await page.addInitScript(() => { sessionStorage.setItem('poise-self-update-reloaded-release', 'r2') })
    let loads = 0
    page.on('load', () => { loads += 1 })
    await page.goto(`${release.baseURL}/`)
    await sock.subscribed('s1')
    const answer = page.locator('.chat-question.pending .chat-q-text')
    await expect(answer).toBeVisible()
    await answer.fill('Teal, actually')
    const banner = page.locator('.self-update-banner')
    await banner.locator('.self-update-refresh').click()
    await expect(banner).toContainText('Refresh is waiting for')
    await page.waitForTimeout(3_000)
    expect(loads).toBe(1)
    await expect(answer).toHaveValue('Teal, actually')
    // The unanswered question itself is not unsaved work: history restores it.
    await answer.fill('')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.waitForFunction(() => performance.getEntriesByType('navigation').some((e) => (e as PerformanceNavigationTiming).type === 'reload'), null, { timeout: 15_000 })
    await sock.subscribed('s1')
    expect(loads).toBe(2)
    await expect(page.locator('.chat-question.pending')).toBeVisible()
  })
})


test('a change explicitly targeting another package stays in ordinary chat', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  await input(page).fill('Add a session list filter in the Caller repository')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('poise.change')).toHaveLength(0)
  await expect(card(page)).toHaveCount(0)
})


for (const form of ['chip', 'pasted']) test(`QC: ${form} Poise requests carry uploaded attachments through the release command`, async ({ page }) => {
  const state = makeState([session()]); await installRoutes(page, state)
  const sock = await installSocket(page)
  const attachment = { id: '11111111-1111-4111-8111-111111111111', name: 'requirements.txt', path: '.poise-chat/uploads/s1/requirements.txt', size: 16 }
  await page.route('**/api/chat/attachments?**', route => route.fulfill({ json: { attachment } }))
  await page.goto('/'); await sock.subscribed('s1')
  await page.locator('.chat-v-composer input[type="file"]').setInputFiles({ name: 'requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('The requirements') })
  await expect(page.locator('.chat-attachment-chip')).toHaveCount(1)
  if (form === 'chip') {
    await input(page).fill('/poise'); await input(page).press('Space'); await input(page).fill('Implement the attached requirements')
  } else await input(page).fill('/poise Implement the attached requirements')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('poise.change').length).toBe(1)
  expect(sock.framesOf('poise.change')[0].command).toMatchObject({ text: 'Implement the attached requirements', attachments: [attachment], mentions: [] })
  expect(sock.framesOf('prompt')).toHaveLength(0)
})
