import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import type { ChatEnvelope, ChatEvent, ClientFrame, SessionRecord } from '../../server/chat/protocol'

// The Chat view against a scripted server: REST through page.route, the
// socket through page.routeWebSocket. The mock says hello, acks every frame
// (unless a test holds the ack back), and lets a test push transcript events.

const NOW = '2026-09-18T09:00:00.000Z'

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1', agent: 'claude', model: 'opus-5-max', modelId: 'claude-opus-5', effort: 'max',
    repo: 'acme/app', checkout: '/tmp/app', branch: { name: 'chat/fix-login', origin: 'new', provisional: true },
    title: 'Fix the login bug', createdAt: NOW, updatedAt: NOW, status: 'idle',
    capabilities: { steer: true, fork: true, thought: true, plan: true, commands: true, modes: true, permissions: true, questions: true, resume: true, images: false },
    mode: 'default', modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
    commands: [{ name: 'review', description: 'Review the branch' }],
    efforts: ['max', 'xhigh'], lastSeq: 0, pendingRequests: [], instance: 'poise-dev:test',
    workspace: { currentBranch: 'chat/fix-login', onBranch: true, dirty: false, dirtyFiles: 0, checkedAt: NOW },
    ...overrides,
  }
}

const AGENTS: { agents: unknown[], defaults: { model: string, fallback: string, fallbackReason?: string }, settings: unknown } = {
  agents: [
    { id: 'claude', label: 'Claude Code', available: true, models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max' }, { identity: 'opus-5-xhigh', selector: 'claude-opus-5', effort: 'xhigh' }], efforts: ['max', 'xhigh'] },
    { id: 'codex', label: 'Codex', available: true, models: [{ identity: 'gpt-6-astra-ultra', selector: 'gpt-6-astra', effort: 'ultra' }, { identity: 'gpt-6-astra-max', selector: 'gpt-6-astra', effort: 'max' }], efforts: ['ultra', 'max'] },
    { id: 'grok', label: 'Grok Build', available: false, reason: 'not signed in', models: [{ identity: 'grok-4.6-xhigh', selector: 'grok-4.6', effort: 'xhigh' }], efforts: ['xhigh'] },
    { id: 'antigravity', label: 'Antigravity (Google)', available: false, reason: 'No interactive permission/question channel', models: [{ identity: 'gemini-3.8-flash-high', selector: 'gemini-3.8-flash', effort: 'high' }, { identity: 'gemini-3.8-flash-medium', selector: 'gemini-3.8-flash', effort: 'medium' }], efforts: ['high', 'medium'] },
    { id: 'muse', label: 'Muse', available: true, models: [{ identity: 'muse-spark-1.3-contributor-max', selector: 'muse-spark-1.3-contributor', effort: 'max' }, { identity: 'muse-spark-1.3-contributor-xhigh', selector: 'muse-spark-1.3-contributor', effort: 'xhigh' }], efforts: ['max', 'xhigh'] },
  ],
  defaults: { model: 'opus-5-max', fallback: 'gpt-6-astra-ultra' },
  settings: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 },
}

interface ServerState {
  sessions: SessionRecord[]
  history: Record<string, ChatEnvelope[]>
  calls: { method: string, path: string, body: unknown }[]
  settings: Record<string, unknown>
  agents?: typeof AGENTS
  /** Holds the POST /api/chat/sessions answer until released. */
  createDelay?: () => Promise<void>
}

async function installRoutes(page: Page, state: ServerState): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    const body = method === 'POST' || method === 'PATCH' ? (req.postDataJSON?.() ?? null) : null
    if (path.startsWith('/api/chat') || path === '/api/settings' || path === '/api/repos') state.calls.push({ method, path, body })
    if (path === '/api/settings') {
      if (method === 'POST') state.settings = { ...state.settings, ...(body as object) }
      await route.fulfill({ json: state.settings })
      return
    }
    if (path === '/api/models') { await route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } }); return }
    if (path === '/api/claude-auth') { await route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: NOW, verifiedAt: NOW, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false } }); return }
    if (path === '/api/repos') { await route.fulfill({ json: { repos: ['acme/app', 'acme/docs'] } }); return }
    if (path === '/api/chat/agents') { await route.fulfill({ json: state.agents || AGENTS }); return }
    if (path === '/api/chat/repo') {
      await route.fulfill({ json: { checkout: '/tmp/app', currentBranch: 'main', defaultBranch: 'main', dirty: false, dirtyFiles: 0, branches: ['main', 'feature/x'], prs: [{ number: 42, title: 'Add login', branch: 'feature/login' }] } })
      return
    }
    if (path === '/api/chat/files') { await route.fulfill({ json: { files: ['src/main.ts', 'src/menu.ts'].filter((f) => f.includes(url.searchParams.get('q') || '')) } }); return }
    if (path === '/api/chat/sessions' && method === 'GET') { await route.fulfill({ json: { sessions: state.sessions, instance: 'poise-dev:test' } }); return }
    if (path === '/api/chat/sessions' && method === 'POST') {
      if (state.createDelay) await state.createDelay()
      const req2 = body as { agent: SessionRecord['agent'], model: string, effort: string }
      const created = session({ id: `new-${state.sessions.length + 1}`, agent: req2.agent, model: req2.model, effort: req2.effort,
        repo: '', checkout: '/poise/.poise-chat/workspace', workspaceKind: 'poise-local', title: '', status: 'starting', createdAt: new Date().toISOString(),
        branch: { name: 'chat/generated', origin: 'new', provisional: true } })
      state.sessions.unshift(created)
      state.history[created.id] = []
      await route.fulfill({ status: 201, json: { session: created } })
      return
    }
    const m = /^\/api\/chat\/sessions\/([^/]+)(?:\/(resume|fork|close|handoff))?$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1])
      const s = state.sessions.find((x) => x.id === id)
      if (!s) { await route.fulfill({ status: 404, json: { error: 'unknown session' } }); return }
      if (m[2] === 'resume') { s.status = 'idle'; s.interruptedTurnId = undefined; await route.fulfill({ json: { session: s } }); return }
      if (m[2] === 'fork' || m[2] === 'handoff') {
        const forked = session({ ...s, id: `${id}-${m[2]}`, title: `${m[2]} of ${s.title}`, createdAt: new Date().toISOString(), forkedFrom: id })
        state.sessions.unshift(forked)
        state.history[forked.id] = []
        await route.fulfill({ json: { session: forked } })
        return
      }
      if (method === 'PATCH') { s.title = (body as { title: string }).title; await route.fulfill({ json: { session: s } }); return }
      if (method === 'DELETE') { state.sessions = state.sessions.filter((x) => x.id !== id); await route.fulfill({ json: { ok: true } }); return }
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
  autoAck: boolean
  held: ClientFrame[]
  seq: number
  push(sessionId: string, event: ChatEvent): ChatEnvelope
  ack(frame: ClientFrame, ok?: boolean, error?: string, code?: string): void
  ready(): Promise<void>
  /** Resolves once the page has subscribed to the session, so pushed
   *  events are not dropped as belonging to nobody. */
  subscribed(sessionId: string): Promise<void>
  framesOf(type: string): ClientFrame[]
}

async function installSocket(page: Page): Promise<Socket> {
  const sock: Socket = {
    frames: [], ws: null, autoAck: true, held: [], seq: 0,
    push(sessionId, event) {
      const envelope: ChatEnvelope = { seq: ++sock.seq, sessionId, at: new Date().toISOString(), event }
      sock.ws!.send(JSON.stringify({ kind: 'event', envelope }))
      return envelope
    },
    ack(frame, ok = true, error = 'failed', code) {
      sock.ws!.send(JSON.stringify(ok ? { kind: 'ack', id: frame.id, ok: true } : { kind: 'ack', id: frame.id, ok: false, error, code }))
    },
    async ready() { await expect.poll(() => sock.ws !== null).toBe(true) },
    async subscribed(sessionId) {
      await expect.poll(() => sock.frames.some((f) => f.command.type === 'subscribe' && f.command.sessionId === sessionId)).toBe(true)
    },
    framesOf(type) { return sock.frames.filter((f) => f.command.type === type) },
  }
  await page.routeWebSocket('**/ws/chat', (ws) => {
    sock.ws = ws
    ws.send(JSON.stringify({ kind: 'hello', instance: 'poise-dev:test', serverStartedAt: NOW }))
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as ClientFrame
      sock.frames.push(frame)
      if (sock.autoAck) sock.ack(frame)
      else sock.held.push(frame)
    })
  })
  return sock
}

function env(sessionId: string, seq: number, event: ChatEvent): ChatEnvelope {
  return { seq, sessionId, at: NOW, event }
}

function makeState(sessions: SessionRecord[], history: Record<string, ChatEnvelope[]> = {}): ServerState {
  return { sessions, history, calls: [], settings: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } } }
}

const input = (page: Page) => page.locator('.chat-v-composer .chat-input')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'chat')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

test('lists sessions, opens one on a delayed click, and renames on double-click', async ({ page }) => {
  const state = makeState([session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' }), session()])
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  const items = page.locator('.chat-session-item')
  await expect(items).toHaveCount(2)
  // Newest first, first one selected.
  await expect(items.nth(0)).toContainText('Second')
  await expect(items.nth(0)).toHaveClass(/active/)
  await expect(items.nth(0)).toContainText('Claude Code · opus-5-max')
  // A double-click on the other session renames it without opening it.
  await items.nth(1).dblclick()
  const rename = items.nth(1).locator('.chat-session-rename')
  await expect(rename).toBeVisible()
  await page.waitForTimeout(400)
  await expect(items.nth(1)).not.toHaveClass(/active/)
  await rename.fill('Login fix')
  await rename.press('Enter')
  await expect.poll(() => state.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ title: 'Login fix' }])
  await expect(items.nth(1)).toContainText('Login fix')
  // A single click opens after the 220 ms delay.
  await items.nth(1).click()
  await expect(items.nth(1)).not.toHaveClass(/active/)
  await expect(items.nth(1)).toHaveClass(/active/)
  await expect(page.locator('.chat-h-status')).toHaveText('idle')
  await expect(page.locator('.chat-h-repo')).toContainText('acme/app')
  await expect(page.locator('.chat-h-repo')).toContainText('clean')
})

test('shows the pending entry the instant the first prompt is sent, and lifts the composer down', async ({ page }) => {
  const fresh = session({ id: 'fresh', title: '' })
  const state = makeState([fresh], { fresh: [] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('fresh')
  const main = page.locator('.chat-main')
  await expect(main).toHaveClass(/chat-empty-session/)
  await expect(page.locator('.chat-welcome')).toContainText('Claude Code')
  expect(await page.locator('.chat-dock').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.36s')
  expect(await page.locator('.chat-dock').evaluate((el) => getComputedStyle(el).transitionTimingFunction)).toBe('cubic-bezier(0.2, 0, 0, 1)')
  sock.autoAck = false
  await input(page).fill('Refactor the auth module')
  await input(page).press('Enter')
  // Before any ack: the sidebar title, the user pill and the dots are there.
  await expect(page.locator('.chat-session-item').first()).toContainText('Refactor the auth module')
  await expect(page.locator('.chat-msg-user')).toContainText('Refactor the auth module')
  await expect(page.locator('.chat-thinking')).toBeVisible()
  await expect(main).not.toHaveClass(/chat-empty-session/)
  expect(sock.framesOf('prompt')).toHaveLength(1)
  const prompt = sock.held.find((f) => f.command.type === 'prompt')!
  expect(prompt.command).toMatchObject({ type: 'prompt', sessionId: 'fresh', text: 'Refactor the auth module', attachments: [], mentions: [] })
  sock.ack(prompt)
  sock.push('fresh', { type: 'turn.started', turnId: 't1', prompt: { text: 'Refactor the auth module', attachments: [], mentions: [] } })
  sock.push('fresh', { type: 'status.changed', status: 'running' })
  await expect(page.locator('.chat-h-status')).toHaveText('running')
  await expect(page.locator('.chat-msg-user')).toHaveCount(1)
})

test('locks a slash command into a chip and unlocks it, and caps the textarea at 120px', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  const ta = input(page)
  const chip = page.locator('.chat-v-chip')
  await expect(ta).toBeEnabled()
  const basePad = await ta.evaluate((el) => getComputedStyle(el).paddingLeft)
  await ta.fill('/review')
  await expect(page.locator('.chat-popover')).toBeVisible()
  await expect(page.locator('.chat-pop-item')).toHaveCount(1)
  await ta.press('Space')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText('/review')
  await expect(ta).toHaveValue('')
  await expect(page.locator('.chat-input-wrap')).toHaveClass(/mode-locked/)
  const chipWidth = await chip.evaluate((el) => el.getBoundingClientRect().width)
  const lockedPad = parseFloat(await ta.evaluate((el) => getComputedStyle(el).paddingLeft))
  expect(lockedPad).toBeGreaterThan(parseFloat(basePad) + chipWidth)
  await ta.press('Backspace')
  await expect(chip).toBeHidden()
  await expect(ta).toHaveCSS('padding-left', basePad)
  // Poise's own commands are offered alongside the agent's.
  await ta.fill('/mo')
  await expect(page.locator('.chat-pop-label')).toHaveText(['/model', '/mode'])
  await ta.press('Escape')
  // Auto-resize: one line is line-height + padding; twenty lines cap at 120px.
  await ta.fill('')
  const single = await ta.evaluate((el) => el.getBoundingClientRect().height)
  expect(single).toBeLessThan(40)
  await ta.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
  await expect(page.locator('.chat-input-wrap')).toHaveClass(/multiline/)
  expect(await ta.evaluate((el) => el.getBoundingClientRect().height)).toBe(120)
  await expect(ta).toHaveCSS('overflow-y', 'auto')
  await ta.fill('one\ntwo')
  const two = await ta.evaluate((el) => el.getBoundingClientRect().height)
  expect(two).toBeGreaterThan(single)
  expect(two).toBeLessThan(120)
})

test('Enter sends, Shift+Enter breaks the line, Enter steers while running, and ⌘. stops', async ({ page }) => {
  const state = makeState([session()], { s1: [] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  const ta = input(page)
  await ta.fill('first')
  await ta.press('Shift+Enter')
  await ta.pressSequentially('second')
  await expect(ta).toHaveValue('first\nsecond')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await ta.press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ type: 'prompt', text: 'first\nsecond' })
  sock.push('s1', { type: 'turn.started', turnId: 't1', prompt: { text: 'first\nsecond', attachments: [], mentions: [] } })
  sock.push('s1', { type: 'status.changed', status: 'running' })
  await expect(page.locator('.chat-v-composer .chat-send')).toHaveAttribute('aria-label', 'Stop')
  await expect(page.locator('.chat-h-stop')).toBeVisible()
  await ta.fill('also check the tests')
  await ta.press('Enter')
  await expect.poll(() => sock.framesOf('steer').length).toBe(1)
  expect(sock.framesOf('steer')[0].command).toMatchObject({ type: 'steer', sessionId: 's1', text: 'also check the tests' })
  expect(sock.framesOf('prompt')).toHaveLength(1)
  await expect(page.locator('.chat-steer-hint')).toBeVisible()
  await expect(page.locator('.chat-steer-hint')).toHaveText('steering')
  sock.push('s1', { type: 'steer.sent', turnId: 't1', text: 'also check the tests' })
  await expect(page.locator('.chat-msg-steer')).toContainText('also check the tests')
  await ta.press('ControlOrMeta+.')
  await expect.poll(() => sock.framesOf('cancel').length).toBe(1)
  await expect(page.locator('.chat-h-status')).toHaveText('stopping…')
  sock.push('s1', { type: 'turn.finished', turnId: 't1', stopReason: 'cancelled', durationMs: 4200 })
  sock.push('s1', { type: 'status.changed', status: 'idle' })
  await expect(page.locator('.chat-turn-footer')).toContainText('Stopped')
  await expect(page.locator('.chat-turn-footer')).toContainText('4.2s')
  await expect(page.locator('.chat-v-composer .chat-send')).toHaveAttribute('aria-label', 'Send')
})

test('streams text, sticks to the bottom only when there, and never runs agent HTML', async ({ page }) => {
  const state = makeState([session({ status: 'running' })], { s1: [env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'go', attachments: [], mentions: [] } })] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = 1
  await expect(page.locator('.chat-thinking')).toBeVisible()
  sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: '# Plan\n\nHello <script>window.pwned = 1</script> **world**' })
  const msg = page.locator('.chat-item-text .chat-msg-md')
  await expect(msg).toContainText('Hello <script>window.pwned = 1</script> world')
  await expect(msg.locator('script')).toHaveCount(0)
  await expect(msg.locator('strong')).toHaveText('world')
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  await expect(page.locator('.chat-thinking')).toHaveCount(0)
  for (let i = 0; i < 80; i++) sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: `\n\nparagraph ${i}` })
  const scroll = page.locator('.chat-transcript-scroll')
  await expect(msg).toContainText('paragraph 79')
  const atBottom = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  await expect.poll(atBottom).toBeLessThan(2)
  await scroll.evaluate((el) => { el.scrollTop = 0 })
  sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: '\n\nlate line' })
  await expect(msg).toContainText('late line')
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0)
  // Copy button per message.
  await page.locator('.chat-item-text').hover()
  await page.locator('.chat-copy-btn').click()
  await expect(page.locator('.chat-copy-btn')).toContainText('Copied')
})

test('answers a permission with the keyboard and a question with its options', async ({ page }) => {
  const state = makeState([session({ status: 'running' })], { s1: [env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'go', attachments: [], mentions: [] } })] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = 1
  sock.push('s1', { type: 'permission.requested', id: 'p1', turnId: 't1', title: 'Run npm test', description: 'Execute a command', input: { command: 'npm test' },
    options: [{ id: 'once', name: 'Allow once', kind: 'allow_once' }, { id: 'always', name: 'Allow for this session', kind: 'allow_always' }, { id: 'no', name: 'Reject', kind: 'reject_once' }] })
  sock.push('s1', { type: 'status.changed', status: 'waiting' })
  const card = page.locator('.chat-permission')
  await expect(card).toHaveClass(/pending/)
  await expect(card.locator('.chat-card-btn')).toHaveText(['1Allow once', '2Allow for this session', '3Reject'])
  await expect(page.locator('.chat-h-status')).toHaveText('waiting for you')
  // While the composer is focused the digits are typing, not answers.
  await input(page).focus()
  await page.keyboard.press('1')
  expect(sock.framesOf('permission.respond')).toHaveLength(0)
  await page.locator('.chat-transcript-scroll').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('1')
  await expect.poll(() => sock.framesOf('permission.respond').length).toBe(1)
  expect(sock.framesOf('permission.respond')[0].command).toMatchObject({ type: 'permission.respond', sessionId: 's1', id: 'p1', optionId: 'once' })
  sock.push('s1', { type: 'permission.resolved', id: 'p1', optionId: 'once', by: 'user' })
  await expect(card).toHaveClass(/resolved/)
  await expect(card).toContainText('Allow once')
  // Question card.
  sock.push('s1', { type: 'question.asked', id: 'q1', turnId: 't1', questions: [
    { id: 'lib', question: 'Which library?', options: [{ label: 'zod' }, { label: 'yup' }], multiSelect: false, freeText: false },
    { id: 'notes', question: 'Anything else?', options: [], multiSelect: false, freeText: true },
  ] })
  const q = page.locator('.chat-question')
  await expect(q).toContainText('Which library?')
  await page.keyboard.press('2')
  await expect(q.locator('input[value="yup"]')).toBeChecked()
  await q.locator('.chat-q-text').fill('keep it small')
  await q.locator('.chat-q-submit').click()
  await expect.poll(() => sock.framesOf('question.answer').length).toBe(1)
  expect(sock.framesOf('question.answer')[0].command).toMatchObject({ type: 'question.answer', id: 'q1', answers: { lib: 'yup', notes: 'keep it small' } })
  sock.push('s1', { type: 'question.answered', id: 'q1', answers: { lib: 'yup', notes: 'keep it small' }, by: 'user' })
  await expect(q).toHaveClass(/resolved/)
})

test('shows tool cards with diffs, reverts one by its diffId, and folds consecutive reads', async ({ page }) => {
  const state = makeState([session({ status: 'running' })], { s1: [env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'go', attachments: [], mentions: [] } })] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = 1
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'r1', kind: 'read', title: 'src/a.ts' })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'r1', status: 'completed', durationMs: 20 })
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'r2', kind: 'read', title: 'src/b.ts' })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'r2', status: 'completed', durationMs: 20 })
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'r3', kind: 'read', title: 'src/c.ts' })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'r3', status: 'completed', durationMs: 20 })
  const group = page.locator('.chat-read-group')
  await expect(group).toHaveCount(1)
  await expect(group).toContainText('read 3 files')
  await expect(page.locator('.chat-tool')).toHaveCount(1)
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'e1', kind: 'edit', title: 'Edit src/a.ts', input: { path: 'src/a.ts' } })
  const tool = page.locator('.chat-tool[data-status="running"]')
  await expect(tool).toHaveCount(1)
  await expect(tool.locator('.chat-tool-status.run')).toBeVisible()
  sock.push('s1', { type: 'diff', turnId: 't1', toolId: 'e1', diffId: 'd1', path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2', oldExists: true, newExists: true })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'e1', status: 'completed', durationMs: 340 })
  const edit = page.locator('.chat-tool').nth(1)
  await expect(edit.locator('.chat-tool-status.ok')).toBeVisible()
  await expect(edit).toContainText('0.3s')
  await edit.locator('.chat-tool-head').click()
  await expect(edit.locator('.chat-edit-card-old')).toContainText('const a = 1')
  await expect(edit.locator('.chat-edit-card-new')).toContainText('const a = 2')
  await edit.locator('.chat-revert-btn').click()
  await expect.poll(() => sock.framesOf('revert').length).toBe(1)
  expect(sock.framesOf('revert')[0].command).toMatchObject({ type: 'revert', sessionId: 's1', diffId: 'd1' })
  await expect(edit).toContainText('Reverting…')
  sock.push('s1', { type: 'diff.reverted', diffId: 'd1', path: 'src/a.ts', ok: true })
  await expect(edit).toContainText('Reverted')
  await expect(edit.locator('.chat-revert-btn')).toHaveCount(0)
  // A terminal block keeps its exit code; a unified diff tints its lines.
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'x1', kind: 'execute', title: 'npm test' })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'x1', status: 'failed', content: [{ type: 'terminal', text: 'FAIL src/a.test.ts', exitCode: 1 }] })
  const exec = page.locator('.chat-tool').nth(2)
  await expect(exec.locator('.chat-tool-status.bad')).toBeVisible()
  await exec.locator('.chat-tool-head').click()
  await expect(exec.locator('.chat-tool-term')).toContainText('FAIL src/a.test.ts')
  await expect(exec.locator('.chat-tool-exit')).toHaveText('exit 1')
  sock.push('s1', { type: 'diff', turnId: 't1', toolId: 'x1', diffId: 'd2', path: 'src/new.ts', oldText: '', newText: '@@ -0,0 +1 @@\n+export {}', oldExists: false, newExists: true, unified: true })
  await expect(exec.locator('.chat-diff-marker')).toHaveText('new file')
  await expect(exec.locator('.chat-diff-line.add')).toHaveText('+export {}')
  // Plan card updates in place; thinking stays collapsed until opened.
  sock.push('s1', { type: 'plan.updated', turnId: 't1', entries: [{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }] })
  await expect(page.locator('.chat-plan-entry')).toHaveCount(2)
  sock.push('s1', { type: 'plan.updated', turnId: 't1', entries: [{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'completed' }, { content: 'Test', status: 'pending' }] })
  await expect(page.locator('.chat-plan')).toHaveCount(1)
  await expect(page.locator('.chat-plan-entry')).toHaveCount(3)
  sock.push('s1', { type: 'thought.delta', turnId: 't1', messageId: 'th1', delta: 'Considering the options' })
  await expect(page.locator('.chat-thought-body')).toBeHidden()
  await page.locator('.chat-thought-toggle').click()
  await expect(page.locator('.chat-thought-body')).toContainText('Considering the options')
})

test('renders an unanswered permission from history after a reload, and an interrupted turn with Resume', async ({ page }) => {
  const history: Record<string, ChatEnvelope[]> = {
    s1: [
      env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'deploy', attachments: [], mentions: [] } }),
      env('s1', 2, { type: 'permission.requested', id: 'p9', turnId: 't1', title: 'Run deploy.sh', options: [{ id: 'ok', name: 'Allow', kind: 'allow_once' }, { id: 'no', name: 'Reject', kind: 'reject_once' }] }),
    ],
    s2: [env('s2', 1, { type: 'turn.started', turnId: 'tx', prompt: { text: 'refactor', attachments: [], mentions: [] } })],
  }
  const state = makeState([
    session({ status: 'waiting', pendingRequests: ['p9'], lastSeq: 2 }),
    session({ id: 's2', title: 'Interrupted one', status: 'interrupted', interruptedTurnId: 'tx', createdAt: '2026-09-17T09:00:00.000Z' }),
  ], history)
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.ready()
  await expect(page.locator('.chat-permission.pending')).toContainText('Run deploy.sh')
  await page.reload()
  await expect(page.locator('.chat-permission.pending')).toContainText('Run deploy.sh')
  await expect(page.locator('.chat-permission .chat-card-btn')).toHaveCount(2)
  // The socket re-subscribed from the last seq the history gave.
  await expect.poll(() => sock.framesOf('subscribe').map((f) => f.command)).toContainEqual({ type: 'subscribe', sessionId: 's1', afterSeq: 2 })
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-turn-footer')).toHaveText('Interrupted')
  await expect(page.locator('.chat-h-status')).toHaveText('interrupted')
  await expect(input(page)).toBeDisabled()
  await expect(input(page)).toHaveAttribute('placeholder', /resume/)
  await page.locator('.chat-resume-btn').click()
  await expect.poll(() => state.calls.filter((c) => c.path.endsWith('/resume')).length).toBe(1)
  await expect(page.locator('.chat-h-status')).toHaveText('idle')
  await expect(input(page)).toBeEnabled()
})

test('deletes a session only after confirming, and keeps a draft per session', async ({ page }) => {
  const state = makeState([session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' }), session()], { s1: [], s2: [] })
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  await expect(page.locator('.chat-session-item')).toHaveCount(2)
  await input(page).fill('draft for second')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)
  await expect(input(page)).toHaveValue('')
  await input(page).fill('draft for first')
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item[data-id="s2"]')).toHaveClass(/active/)
  await expect(input(page)).toHaveValue('draft for second')
  const first = page.locator('.chat-session-item[data-id="s2"]')
  await first.hover()
  await first.locator('.chat-session-delete').click()
  await expect(first.locator('.chat-session-delete')).toHaveText('Sure?')
  expect(state.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  await first.locator('.chat-session-delete').click()
  await expect.poll(() => state.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/chat/sessions/s2'])
  await expect(page.locator('.chat-session-item')).toHaveCount(1)
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)
  await expect(input(page)).toHaveValue('draft for first')
})

test('creates a session from the dialog with a pending entry before the server answers', async ({ page }) => {
  const state = makeState([], {})
  let release: () => void = () => {}
  state.createDelay = () => new Promise<void>((r) => { release = r })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await expect(page.locator('.chat-sidebar-empty')).toContainText('No sessions yet')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog.getByLabel('Agent')).toHaveCount(0)
  await expect(dialog.getByLabel('Repository')).toHaveCount(0)
  await expect(dialog.locator('input[name="branch"]')).toHaveCount(0)
  await expect(dialog.getByLabel('Model').locator('optgroup')).toHaveCount(5)
  await expect(dialog.getByLabel('Model')).toHaveValue('opus-5-max')
  await expect(dialog.getByLabel('Effort')).toHaveValue('max')
  await dialog.getByLabel('Model').selectOption('gpt-6-astra-ultra')
  await expect(dialog.getByLabel('Effort').locator('option')).toHaveText(['ultra', 'max'])
  await dialog.getByLabel('Effort').selectOption('max')
  await dialog.getByRole('button', { name: 'Create' }).click()
  // Pending entry, selected, before the POST resolves.
  await expect(page.locator('.chat-session-item.pending')).toHaveCount(1)
  await expect(page.locator('.chat-session-item.pending')).toHaveClass(/active/)
  await expect(input(page)).toBeDisabled()
  await expect(input(page)).toHaveAttribute('placeholder', 'Starting the session…')
  release()
  await expect(page.locator('.chat-session-item.pending')).toHaveCount(0)
  await expect(page.locator('.chat-session-item')).toHaveCount(1)
  const created = state.calls.find((c) => c.method === 'POST' && c.path === '/api/chat/sessions')!.body
  expect(created).toMatchObject({ agent: 'codex', model: 'gpt-6-astra-max', effort: 'max' })
  expect(created).not.toHaveProperty('repo')
  expect(created).not.toHaveProperty('branch')
  expect(state.calls.filter(c => c.path === '/api/chat/repo')).toHaveLength(0)
  await expect.poll(() => sock.framesOf('subscribe').map((f) => f.command)).toContainEqual({ type: 'subscribe', sessionId: 'new-1', afterSeq: 0 })
  await expect(page.locator('.chat-h-status')).toHaveText('starting…')
  sock.push('new-1', { type: 'session.updated', session: { ...state.sessions[0], status: 'idle' } })
  await expect(page.locator('.chat-h-status')).toHaveText('idle')
  await expect(input(page)).toBeEnabled()
})

test('offers an explicit fallback choice when the default provider is not signed in, and shows create errors', async ({ page }) => {
  const state = makeState([], {})
  state.agents = { ...AGENTS, defaults: { ...AGENTS.defaults, fallbackReason: 'Claude is not signed in' } }
  await installRoutes(page, state)
  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return }
    await route.fulfill({ status: 409, json: { error: 'checkout has uncommitted changes on main', code: 'checkout_dirty' } })
  })
  await installSocket(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog.locator('.chat-dialog-fallback')).toContainText('Claude is not signed in')
  await expect(dialog.locator('input[name="fallback"][value="default"]')).toBeChecked()
  await dialog.locator('input[name="fallback"][value="fallback"]').check()
  await expect(dialog.getByLabel('Model')).toHaveValue('gpt-6-astra-ultra')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog', { name: 'New session' }).getByRole('alert')).toContainText('uncommitted changes')
  await expect(page.locator('.chat-session-item')).toHaveCount(0)
})

test('hands a Current card and an Editor document off to a prefilled New session dialog', async ({ page }) => {
  const state = makeState([], {})
  await installRoutes(page, state)
  await page.route('**/api/gh', (route) => route.fulfill({ json: { records: [
    { kind: 'pr', repo: 'acme/app', number: 42, state: 'open', title: 'Add login', url: 'https://github.com/acme/app/pull/42', created_at: NOW, updated_at: NOW, merged_at: null },
    { kind: 'issue', repo: 'acme/app', number: 7, state: 'open', title: 'Broken logout', url: 'https://github.com/acme/app/issues/7', created_at: NOW, updated_at: NOW, merged_at: null },
  ] } }))
  await page.route('**/api/current', (route) => route.fulfill({ json: { cards: [] } }))
  await installSocket(page)
  await page.addInitScript(() => localStorage.setItem('poise-view', 'current'))
  await page.goto('/')
  const pr = page.locator('.card-live', { hasText: 'Add login' })
  await pr.hover()
  await pr.getByRole('button', { name: 'Open in Chat' }).click()
  await expect(page.locator('#view-chat')).toBeVisible()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog).toContainText('Add login')
  await expect(dialog.getByLabel('Repository')).toHaveCount(0)
  await expect(dialog.locator('input[name="branch"]')).toHaveCount(0)
  await expect(dialog.getByLabel('Model')).toHaveValue('opus-5-max')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  const issue = page.locator('.card-live', { hasText: 'Broken logout' })
  await issue.hover()
  await issue.getByRole('button', { name: 'Open in Chat' }).click()
  await expect(dialog.locator('input[name="branch"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions').map((c) => c.body)).toEqual([
    expect.objectContaining({ context: { kind: 'card', title: 'Broken logout', body: '', url: 'https://github.com/acme/app/issues/7' } }),
  ])
})

test('shows and saves the chat settings in General', async ({ page }) => {
  const state = makeState([], {})
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  const prefix = page.getByLabel('Branch prefix for new chat sessions')
  const idle = page.getByLabel('Idle timeout (minutes)')
  await expect(prefix).toHaveValue('chat/')
  await expect(idle).toHaveValue('120')
  await prefix.fill('bad prefix')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Branch prefix must be')
  await prefix.fill('agent/')
  await idle.fill('45')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  const saved = state.calls.find((c) => c.method === 'POST' && c.path === '/api/settings')!.body as { chat: unknown }
  expect(saved.chat).toEqual({ branchPrefix: 'agent/', idleTimeoutMinutes: 45 })
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.getByLabel('Branch prefix for new chat sessions')).toHaveValue('agent/')
  await expect(page.getByLabel('Idle timeout (minutes)')).toHaveValue('45')
})

test('opens a Chat session from a Swarm chat row, and changes model, mode and handoff from the header', async ({ page }) => {
  const state = makeState([session()], { s1: [] })
  await installRoutes(page, state)
  const now = new Date().toISOString()
  await page.route('**/api/agent-logs', (route) => route.fulfill({ json: { logs: [
    { id: 'a'.repeat(32), model: 'opus-5-max', behavior: 'chat', source: 'poise:chat', session_id: 's1', repo: null, pr_id: null, actor: null, prompt: '',
      status: 'running', started_at: now, started_at_precise: now, completed_at: null, time_elapsed: '', outcome: null, response: '', error: '' },
  ] } }))
  const sock = await installSocket(page)
  await page.addInitScript(() => localStorage.setItem('poise-view', 'swarm'))
  await page.goto('/')
  await expect(page.locator('.agent-row')).toHaveCount(1)
  await page.locator('.agent-chat-session').click()
  await expect(page.locator('#view-chat')).toBeVisible()
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)
  await sock.ready()
  await page.locator('.chat-model-select').selectOption('opus-5-xhigh')
  await expect.poll(() => sock.framesOf('set_model').map((f) => f.command)).toEqual([{ type: 'set_model', sessionId: 's1', model: 'opus-5-xhigh', effort: 'max' }])
  await page.locator('.chat-mode-select').selectOption('plan')
  await expect.poll(() => sock.framesOf('set_mode').map((f) => f.command)).toEqual([{ type: 'set_mode', sessionId: 's1', mode: 'plan' }])
  sock.push('s1', { type: 'model.updated', model: 'opus-5-xhigh', modelId: 'claude-opus-5', effort: 'max' })
  await expect(page.locator('.chat-model-select')).toHaveValue('opus-5-xhigh')
  await page.locator('.chat-h-handoff').click()
  await page.getByLabel('Handoff agent').selectOption('codex')
  await expect(page.getByLabel('Handoff model')).toHaveValue('gpt-6-astra-ultra')
  await page.locator('.chat-ho-go').click()
  await expect.poll(() => state.calls.filter((c) => c.path.endsWith('/handoff')).map((c) => c.body)).toEqual([{ agent: 'codex', model: 'gpt-6-astra-ultra', effort: 'ultra' }])
  await expect(page.locator('.chat-session-item.active')).toContainText('handoff of Fix the login bug')
})


test('loads a complete large diff on demand before enabling Revert', async ({ page }) => {
  const state = makeState([session({ status: 'running' })], { s1: [env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'edit', attachments: [], mentions: [] } })] })
  await installRoutes(page, state)
  let fullLoads = 0
  await page.route('**/api/chat/diff?**', async route => {
    fullLoads++
    expect(new URL(route.request().url()).searchParams.get('session')).toBe('s1')
    expect(new URL(route.request().url()).searchParams.get('id')).toBe('large-diff')
    await route.fulfill({ json: { diff: { type: 'diff', turnId: 't1', toolId: 'edit', diffId: 'large-diff', path: 'large.txt', oldText: 'complete old contents', newText: 'complete new contents', oldExists: true, newExists: true } } })
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = 1
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'edit', kind: 'edit', title: 'Edit large.txt' })
  sock.push('s1', { type: 'diff', turnId: 't1', toolId: 'edit', diffId: 'large-diff', path: 'large.txt', oldText: 'old preview', newText: 'new preview', oldExists: true, newExists: true, previewOnly: true })
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'edit', status: 'completed' })
  const tool = page.locator('.chat-tool')
  await tool.locator('.chat-tool-head').click()
  await expect(tool).toContainText('Large diff preview')
  await expect(tool.locator('.chat-revert-btn')).toBeDisabled()
  expect(fullLoads).toBe(0)
  await tool.getByRole('button', { name: 'Load complete diff', exact: true }).click()
  await expect(tool.locator('.chat-edit-card-old')).toContainText('complete old contents')
  await expect(tool.locator('.chat-edit-card-new')).toContainText('complete new contents')
  await expect(tool.locator('.chat-revert-btn')).toBeEnabled()
  expect(fullLoads).toBe(1)
  await tool.locator('.chat-revert-btn').click()
  await expect.poll(() => sock.framesOf('revert').length).toBe(1)
  expect(sock.framesOf('revert')[0].command).toMatchObject({ sessionId: 's1', diffId: 'large-diff' })
})

test('shows all five catalogue providers and keeps efforts specific to each model', async ({ page }) => {
  const state = makeState([], {})
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  const model = dialog.getByLabel('Model'), effort = dialog.getByLabel('Effort')
  expect(await model.locator('optgroup').evaluateAll(groups => groups.map(group => group.getAttribute('label'))))
    .toEqual(['Claude Code', 'Codex', 'Grok Build', 'Antigravity (Google)', 'Muse'])
  await model.selectOption('gemini-3.8-flash-high')
  await expect(effort.locator('option')).toHaveText(['high', 'medium'])
  await effort.selectOption('medium')
  await expect(dialog.getByRole('status')).toContainText('permission/question')
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await model.selectOption('grok-4.6-xhigh')
  await expect(dialog.getByRole('status')).toContainText('not signed in')
  await expect(model.locator('option[data-provider="grok"]')).toHaveCount(1)
  await model.selectOption('muse-spark-1.3-contributor-max')
  await expect(effort.locator('option')).toHaveText(['max', 'xhigh'])
  await effort.selectOption('xhigh')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => state.calls.filter(c => c.path === '/api/chat/sessions' && c.method === 'POST').map(c => c.body)).toEqual([
    { agent: 'muse', model: 'muse-spark-1.3-contributor-xhigh', effort: 'xhigh' },
  ])
  await expect(page.locator('.chat-h-repo')).toHaveText(/Poise · local/)
})
