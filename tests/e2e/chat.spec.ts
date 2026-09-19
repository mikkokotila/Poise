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
    { id: 'claude', label: 'Claude Code', available: true, models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max' }, { identity: 'opus-5-xhigh', selector: 'claude-opus-5', effort: 'xhigh' }, { identity: 'opus-5-high', selector: 'claude-opus-5', effort: 'high' }], efforts: ['max', 'xhigh', 'high'] },
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
      const req2 = body as { agent: SessionRecord['agent'], model: string, effort: string, autoMerge?: boolean, deferStart?: boolean }
      const created = session({ id: `new-${state.sessions.length + 1}`, agent: req2.agent, model: req2.model, effort: req2.effort, autoMerge: req2.autoMerge,
        repo: '', checkout: '/poise/.poise-chat/workspace', workspaceKind: 'poise-local', title: '', status: req2.deferStart ? 'idle' : 'starting', createdAt: new Date().toISOString(),
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
  ack(frame: ClientFrame, ok?: boolean, error?: string, code?: string, result?: unknown): void
  ready(): Promise<void>
  /** Resolves once the page has subscribed to the session, so pushed
   *  events are not dropped as belonging to nobody. */
  subscribed(sessionId: string): Promise<void>
  framesOf(type: string): ClientFrame[]
}

async function installSocket(page: Page, state?: ServerState): Promise<Socket> {
  const sock: Socket = {
    frames: [], ws: null, autoAck: true, held: [], seq: 0,
    push(sessionId, event) {
      const envelope: ChatEnvelope = { seq: ++sock.seq, sessionId, at: new Date().toISOString(), event }
      sock.ws!.send(JSON.stringify({ kind: 'event', envelope }))
      return envelope
    },
    ack(frame, ok = true, error = 'failed', code, result) {
      sock.ws!.send(JSON.stringify(ok ? { kind: 'ack', id: frame.id, ok: true, result } : { kind: 'ack', id: frame.id, ok: false, error, code }))
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
      if (sock.autoAck && ['queue.add', 'queue.update', 'queue.remove'].includes(frame.command.type) && state) {
        const cmd = frame.command
        if (cmd.type !== 'queue.add' && cmd.type !== 'queue.update' && cmd.type !== 'queue.remove') throw new Error('Unexpected queue command')
        const s = state.sessions.find(s => s.id === cmd.sessionId)!
        const queue = structuredClone(s.queue || { revision: 0, ready: false, items: [] })
        if (cmd.type === 'queue.remove') queue.items = queue.items.filter(item => item.id !== cmd.itemId)
        else {
          const model = cmd.model || s.model
          const agent = (AGENTS.agents as Array<{ id: SessionRecord['agent'], models: Array<{ identity: string, effort: string }> }>).find(agent => agent.models.some(m => m.identity === model))!
          const effort = cmd.effort || agent.models.find(m => m.identity === model)!.effort
          if (cmd.type === 'queue.add') queue.items.push({ id: cmd.itemId, prompt: { text: cmd.text, attachments: cmd.attachments || [], mentions: cmd.mentions || [] },
            agent: agent.id, model, effort, state: 'waiting', createdAt: NOW })
          else queue.items = queue.items.map(item => item.id === cmd.itemId ? { ...item, agent: agent.id, model, effort } : item)
        }
        queue.revision++
        s.queue = queue
        sock.push(s.id, { type: 'queue.updated', queue })
        sock.ack(frame, true, '', undefined, { queue })
      } else if (sock.autoAck && frame.command.type === 'set_auto_merge' && state) {
        const command = frame.command
        const s = state.sessions.find(s => s.id === command.sessionId)!
        s.autoMerge = command.enabled
        s.lastSeq = sock.seq + 1
        sock.push(s.id, { type: 'session.updated', session: { ...s } })
        sock.ack(frame, true, '', undefined, { session: { ...s }, applies: 'current_turn' })
      } else if (sock.autoAck) sock.ack(frame)
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

// Hold view renders to expose the interval between a session-identity change
// and its next animation frame. Composer-owned uploads must still be correct.
async function pauseViewFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raf = window.requestAnimationFrame.bind(window)
    const queued: FrameRequestCallback[] = []
    window.requestAnimationFrame = callback => { queued.push(callback); return queued.length }
    ;(window as any).__resumeViewFrames = () => {
      window.requestAnimationFrame = raf
      queued.forEach(callback => raf(callback))
    }
  })
}
async function resumeViewFrames(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__resumeViewFrames())
}


test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('chat-fixture-initialized')) {
      localStorage.clear()
      localStorage.setItem('poise-view', 'chat')
      sessionStorage.setItem('chat-fixture-initialized', '1')
    }
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
  await expect(page.locator('.chat-welcome')).toHaveCount(0)
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
  // The fresh console keeps its taller writing floor; twenty lines still cap at 120px.
  await ta.fill('')
  const single = await ta.evaluate((el) => el.getBoundingClientRect().height)
  expect(single).toBe(104)
  await ta.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
  await expect(page.locator('.chat-input-wrap')).toHaveClass(/multiline/)
  expect(await ta.evaluate((el) => el.getBoundingClientRect().height)).toBe(120)
  await expect(ta).toHaveCSS('overflow-y', 'auto')
  await ta.fill('one\ntwo')
  const two = await ta.evaluate((el) => el.getBoundingClientRect().height)
  expect(two).toBeGreaterThanOrEqual(single)
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


test('starts a fresh console with Opus 5 High on first send, exactly once', async ({ page }) => {
  const state = makeState([])
  let release = () => {}
  state.createDelay = () => new Promise<void>(resolve => { release = resolve })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await expect(input(page)).toBeEnabled()
  await expect(page.getByText('Pick a session on the left, or start a new one.')).toHaveCount(0)
  await expect(page.locator('.chat-default-model')).toHaveText('Opus 5 · High')
  await input(page).fill('First line')
  await input(page).press('Shift+Enter')
  await input(page).pressSequentially('Second line')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  await input(page).press('Enter')
  await expect(page.locator('.chat-session-item.pending')).toHaveCount(1)
  await expect(page.locator('.chat-msg-user')).toHaveText('First line\nSecond line')
  await expect(input(page)).toBeDisabled()
  await page.locator('.chat-v-composer').dispatchEvent('submit')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  expect(state.calls.filter(c => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(1)
  expect(state.calls.find(c => c.method === 'POST')?.body).toMatchObject({ agent: 'claude', model: 'opus-5-high', effort: 'high' })
  expect(state.calls.find(c => c.method === 'POST')?.body).not.toHaveProperty('repo')
  release()
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ sessionId: 'new-1', text: 'First line\nSecond line', attachments: [], mentions: [] })
  await expect(page.locator('.chat-msg-user')).toHaveCount(1)
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden()
})

test('keeps a failed fresh message editable without switching model or opening a dialog', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  let attempts = 0
  await page.route('**/api/chat/sessions', async route => {
    if (route.request().method() === 'POST' && attempts++ === 0) {
      await route.fulfill({ status: 503, json: { error: 'Temporary startup failure' } })
    } else await route.fallback()
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await input(page).fill('Keep this message')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toContainText('Temporary startup failure')
  await expect(input(page)).toHaveValue('Keep this message')
  await expect(input(page)).toBeEnabled()
  await expect(page.locator('.chat-session-item')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(attempts).toBe(2)
})

test('keeps a fresh message when its default provider is unavailable', async ({ page }) => {
  const state = makeState([])
  state.agents = structuredClone(AGENTS)
  Object.assign(state.agents.agents[0] as object, { available: false, reason: 'Sign-in required' })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await input(page).fill('No silent fallback')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toContainText('Sign-in required')
  await expect(input(page)).toHaveValue('No silent fallback')
  await expect(input(page)).toBeEnabled()
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  // Choosing another model is explicit and carries the unsent text with it.
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await dialog.getByLabel('Model', { exact: true }).selectOption('gpt-6-astra-ultra')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(input(page)).toBeEnabled()
  await expect(input(page)).toHaveValue('No silent fallback')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
})

test('accepts a file from a fresh console and retains its text in the same session', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  const attachment = { id: 'file-1', name: 'note.txt', path: '.poise-chat/uploads/new-1/note.txt', size: 4 }
  await page.route('**/api/chat/attachments?**', async route => {
    expect(new URL(route.request().url()).searchParams.get('session')).toBe('new-1')
    await route.fulfill({ json: { attachment } })
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Attach file' })).toBeEnabled()
  await input(page).fill('Read this note')
  await pauseViewFrames(page)
  await page.locator('.chat-file-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
  await expect(page.locator('.chat-attachment-chip')).toContainText('note.txt')
  await resumeViewFrames(page)
  await expect(input(page)).toHaveValue('Read this note')
  await expect(input(page)).toBeEnabled()
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ sessionId: 'new-1', text: 'Read this note', attachments: [attachment] })
  expect(state.calls.filter(c => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(1)
})

test('leaves a writable fresh console after the final session is deleted', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  const remove = page.locator('.chat-session-delete')
  await page.locator('.chat-session-item').hover()
  await remove.click()
  await remove.click()
  await expect(page.locator('.chat-session-item')).toHaveCount(0)
  await expect(input(page)).toBeEnabled()
  await expect(input(page)).toHaveValue('')
  await input(page).fill('A fresh start')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(state.calls.find(c => c.method === 'POST' && c.path === '/api/chat/sessions')?.body).toMatchObject({ model: 'opus-5-high', effort: 'high' })
})

test('resizes the sessions pane from its edge and remembers width across reload and collapse', async ({ page }) => {
  await installRoutes(page, makeState([session()]))
  await installSocket(page)
  await page.goto('/')
  const pane = page.locator('.chat-sidebar')
  const handle = page.getByRole('separator', { name: 'Resize sessions pane' })
  const edge = (await handle.boundingBox())!
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 80)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 + 96, edge.y + 80, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(356)
  expect(await page.evaluate(() => localStorage.getItem('poise-chat-sidebar-width'))).toBe('356')
  await page.reload()
  await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(356)
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(0)
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(356)
  await handle.focus()
  await handle.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '372')
  await handle.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '200')
  await handle.press('End')
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await handle.dblclick()
  await expect(handle).toHaveAttribute('aria-valuenow', '260')
  await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(260)
  await page.setViewportSize({ width: 680, height: 720 })
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeLessThanOrEqual(360)
})

test('eases the sidebar closed without detaching it or losing the composer draft', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await installRoutes(page, makeState([]))
  await installSocket(page)
  await page.goto('/')
  await input(page).fill('Unsent draft')
  const widths = await page.evaluate(async () => {
    const sidebar = document.querySelector<HTMLElement>('.chat-sidebar')!
    const samples = [sidebar.getBoundingClientRect().width]
    document.querySelector<HTMLButtonElement>('.chat-sidebar-toggle')!.click()
    const start = performance.now()
    await new Promise<void>(resolve => {
      const frame = () => {
        samples.push(sidebar.getBoundingClientRect().width)
        if (performance.now() - start < 400) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    return samples
  })
  expect(widths.some(width => width > 0 && width < widths[0])).toBe(true)
  expect(widths.at(-1)).toBe(0)
  await expect(page.locator('.chat-sidebar')).toHaveCount(1)
  expect(await page.locator('.chat-sidebar').evaluate(el => (el as HTMLElement).inert)).toBe(true)
  await expect(input(page)).toHaveValue('Unsent draft')
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await expect.poll(() => page.locator('.chat-sidebar').evaluate(el => el.getBoundingClientRect().width)).toBe(260)
  await expect(input(page)).toHaveValue('Unsent draft')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.locator('.chat-sidebar').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(.001)
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await expect.poll(() => page.locator('.chat-sidebar').evaluate(el => el.getBoundingClientRect().width)).toBe(0)
  expect(errors).toEqual([])
})

test('gives the fresh console a narrower taller low-contrast surface in both themes', async ({ page }, info) => {
  await installRoutes(page, makeState([]))
  await installSocket(page)
  await page.goto('/')
  await expect(input(page)).toBeEnabled()
  const composer = page.locator('.chat-v-composer')
  await expect.poll(() => composer.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(640)
  const box = (await composer.boundingBox())!
  const main = (await page.locator('.chat-main').boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(130)
  await expect.poll(() => composer.evaluate(el => el.getBoundingClientRect().y)).toBeLessThan(main.y + main.height * .45)
  const surface = page.locator('.chat-v-composer .chat-input-wrap')
  expect(await surface.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none')
  const border = await surface.evaluate(el => getComputedStyle(el).borderTopColor)
  expect(border).toMatch(/(?:0\.38|0\.3[0-9]+)/)
  await page.screenshot({ path: info.outputPath('fresh-console-light.png'), animations: 'disabled' })
  await input(page).focus()
  expect(await surface.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: info.outputPath('fresh-console-dark.png'), animations: 'disabled' })
})


test('keeps a slow attachment with its original session when another session is selected', async ({ page }) => {
  const state = makeState([session({ id: 's1' }), session({ id: 's2', title: 'Other conversation' })])
  await installRoutes(page, state)
  let release = () => {}
  let uploading = false
  const attachment = { id: 'file-s1', name: 'slow.txt', path: '.poise-chat/uploads/s1/slow.txt', size: 4 }
  await page.route('**/api/chat/attachments?**', async route => {
    uploading = true
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { attachment } })
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  await input(page).fill('Original draft')
  await page.locator('.chat-file-input').setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
  await expect.poll(() => uploading).toBe(true)
  await pauseViewFrames(page)
  await page.locator('.chat-session-item[data-id="s2"]').dispatchEvent('keydown', { key: 'Enter' })
  await sock.subscribed('s2')
  await input(page).fill('Other draft')
  release()
  await expect(page.getByRole('button', { name: 'Attach file' })).toBeEnabled()
  await expect(page.locator('.chat-attachment-chip')).toHaveCount(0)
  await expect(input(page)).toHaveValue('Other draft')
  await resumeViewFrames(page)
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(input(page)).toHaveValue('Original draft')
  await expect(page.locator('.chat-attachment-chip')).toContainText('slow.txt')
})


const consolePicker = (page: Page) => page.getByRole('listbox', { name: 'Console model', exact: true })
async function chooseConsoleModel(page: Page, identity: string): Promise<void> {
  await page.locator('.chat-default-model').click()
  await consolePicker(page).locator(`[data-identity="${identity}"]`).click()
}

test('chooses any available catalogue model and effort from the console without creating a session', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await input(page).fill('Keep this draft while I choose')
  await page.locator('.chat-default-model').click()
  const picker = consolePicker(page)
  await expect(picker.locator('.chat-model-provider')).toHaveText(['Claude Code', 'Codex', 'Grok Build', 'Antigravity (Google)', 'Muse'])
  await expect(picker.getByRole('option')).toHaveCount(10)
  await expect(picker.locator('[data-identity="opus-5-high"]')).toHaveAttribute('aria-selected', 'true')
  await expect(picker.locator('[data-identity="gemini-3.8-flash-high"]')).toBeDisabled()
  await expect(picker).toContainText('No interactive permission/question channel')
  await picker.locator('[data-identity="muse-spark-1.3-contributor-xhigh"]').click()
  await expect(picker).toBeHidden()
  await expect(page.locator('.chat-default-model')).toHaveText('Muse Spark 1.3 Contributor · Extra high')
  await expect(input(page)).toHaveValue('Keep this draft while I choose')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden()
  await page.locator('.chat-default-model').click()
  await expect(picker.locator('[data-identity="muse-spark-1.3-contributor-xhigh"]')).toHaveAttribute('aria-selected', 'true')
  await picker.press('Escape')
  await expect(page.locator('.chat-default-model')).toBeFocused()
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  const creates = state.calls.filter(c => c.method === 'POST' && c.path === '/api/chat/sessions')
  expect(creates).toHaveLength(1)
  expect(creates[0].body).toMatchObject({ agent: 'muse', model: 'muse-spark-1.3-contributor-xhigh', effort: 'xhigh' })
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text: 'Keep this draft while I choose', sessionId: 'new-1' })
})

test('navigates console models with the keyboard and dismisses without changing the draft', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  await input(page).fill('Unsent')
  const button = page.locator('.chat-default-model')
  await button.focus()
  await button.press('ArrowDown')
  const picker = consolePicker(page)
  await expect(picker.locator('[data-identity="opus-5-high"]')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(picker.locator('[data-identity="gpt-6-astra-ultra"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(button).toHaveText('GPT 6 Astra · Ultra')
  await expect(button).toBeFocused()
  await button.click()
  await expect(picker.getByRole('option')).toHaveCount(10)
  await input(page).click({ position: { x: 600, y: 20 } })
  await expect(picker).toBeHidden()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await expect(input(page)).toHaveValue('Unsent')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
})

test('retains the chosen console model and draft after session creation fails', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  let attempts = 0
  await page.route('**/api/chat/sessions', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return }
    attempts++
    expect(route.request().postDataJSON()).toMatchObject({ model: 'gpt-6-astra-max', effort: 'max', agent: 'codex' })
    if (attempts === 1) await route.fulfill({ status: 503, json: { error: 'Temporary startup failure' } })
    else await route.fallback()
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await chooseConsoleModel(page, 'gpt-6-astra-max')
  await input(page).fill('Retry with my choice')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toContainText('Temporary startup failure')
  await expect(page.locator('.chat-default-model')).toHaveText('GPT 6 Astra · Max')
  await expect(input(page)).toHaveValue('Retry with my choice')
  await expect(input(page)).toBeEnabled()
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(attempts).toBe(2)
})

test('uses the selected console model for the first attachment as well as the message', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  const attachment = { id: 'chosen-file', name: 'note.txt', path: '.poise-chat/uploads/new-1/note.txt', size: 4 }
  await page.route('**/api/chat/attachments?**', async route => {
    expect(new URL(route.request().url()).searchParams.get('session')).toBe('new-1')
    await route.fulfill({ json: { attachment } })
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await input(page).fill('Read this with Muse')
  await chooseConsoleModel(page, 'muse-spark-1.3-contributor-max')
  await page.locator('.chat-file-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
  await expect(page.locator('.chat-attachment-chip')).toContainText('note.txt')
  await expect(input(page)).toHaveValue('Read this with Muse')
  await expect(input(page)).toBeEnabled()
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  const creates = state.calls.filter(c => c.method === 'POST' && c.path === '/api/chat/sessions')
  expect(creates).toHaveLength(1)
  expect(creates[0].body).toMatchObject({ agent: 'muse', model: 'muse-spark-1.3-contributor-max', effort: 'max' })
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ sessionId: 'new-1', text: 'Read this with Muse', attachments: [attachment] })
})

test('revalidates an explicit console choice on send instead of silently falling back', async ({ page }) => {
  const state = makeState([])
  state.agents = structuredClone(AGENTS)
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await chooseConsoleModel(page, 'muse-spark-1.3-contributor-xhigh')
  for (const agent of state.agents.agents as Array<{ models: Array<{ identity: string }> }>) {
    agent.models = agent.models.filter(model => model.identity !== 'muse-spark-1.3-contributor-xhigh')
  }
  await input(page).fill('Do not use a different model')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toContainText('not in the current catalogue')
  await expect(input(page)).toHaveValue('Do not use a different model')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await chooseConsoleModel(page, 'muse-spark-1.3-contributor-max')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(state.calls.find(c => c.method === 'POST' && c.path === '/api/chat/sessions')?.body).toMatchObject({ model: 'muse-spark-1.3-contributor-max' })
})

test('does not reopen a dismissed model dropdown when the catalogue arrives late, and permits retry', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  await installSocket(page)
  let mode = 'ready'
  let release: () => void = () => {}
  await page.route('**/api/chat/agents', async route => {
    if (mode === 'hold') await new Promise<void>(resolve => { release = resolve })
    await route.fulfill(mode === 'error' ? { status: 503, json: { error: 'Catalogue offline' } } : { json: AGENTS })
  })
  await page.goto('/')
  await expect(input(page)).toBeEnabled()
  mode = 'hold'
  const button = page.locator('.chat-default-model')
  await button.click()
  await expect(consolePicker(page)).toContainText('Loading models')
  await page.keyboard.press('Escape')
  await expect(consolePicker(page)).toBeHidden()
  mode = 'ready'
  const arrived = page.waitForResponse('**/api/chat/agents')
  release()
  await arrived
  await expect(consolePicker(page)).toBeHidden()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  mode = 'error'
  await button.click()
  await expect(consolePicker(page)).toContainText('Could not load')
  mode = 'ready'
  await consolePicker(page).getByRole('button', { name: 'Try again' }).click()
  await expect(consolePicker(page).getByRole('option')).toHaveCount(10)
  await page.keyboard.press('Escape')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
})

test('keeps the console model dropdown within the conversation in light and dark themes', async ({ page }, info) => {
  const state = makeState([])
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  const picker = consolePicker(page)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    await page.locator('.chat-default-model').click()
    await expect(picker.getByRole('option')).toHaveCount(10)
    const menuBox = await picker.boundingBox()
    const mainBox = await page.locator('.chat-main').boundingBox()
    expect(menuBox!.y).toBeGreaterThanOrEqual(mainBox!.y)
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width)
    await page.screenshot({ path: info.outputPath(`console-models-${theme}.png`) })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 600, height: 500 })
  await page.locator('.chat-default-model').click()
  await expect(picker.getByRole('option')).toHaveCount(10)
  const box = await picker.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(600)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(500)
})

test('uses accessible icon controls for New session, Fork and Hand off', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  for (const name of ['New session', 'Fork', 'Hand off…']) {
    const button = page.getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await expect(button).toHaveText('')
    await expect(button.locator('svg')).toHaveCount(1)
    await expect(button).toHaveAttribute('title', /.+/)
  }
  expect(await page.locator('.chat-h-fork').evaluate(el => el.nextElementSibling?.classList.contains('chat-h-activity'))).toBe(true)
  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await expect.poll(() => state.calls.filter(call => call.path.endsWith('/fork')).length).toBe(1)
})

test('hides activity without hiding messages, errors or required interactions', async ({ page }, info) => {
  const events: ChatEvent[] = [
    { type: 'turn.started', turnId: 't1', prompt: { text: 'Review the code', attachments: [], mentions: [] } },
    { type: 'tool.started', turnId: 't1', id: 'read', kind: 'execute', title: 'Inspect package', input: { command: 'cat package.json' } },
    { type: 'tool.finished', turnId: 't1', id: 'read', status: 'completed', content: [{ type: 'terminal', text: 'package contents', exitCode: 0 }] },
    { type: 'thought.delta', turnId: 't1', messageId: 'thought', delta: 'Thinking about the package' },
    { type: 'plan.updated', turnId: 't1', entries: [{ content: 'Review', status: 'in_progress' }] },
    { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: 'Here is the actual reply.' },
    { type: 'permission.requested', turnId: 't1', id: 'p1', title: 'Write file', options: [{ id: 'yes', name: 'Allow', kind: 'allow_once' }] },
    { type: 'question.asked', turnId: 't1', id: 'q1', questions: [{ id: 'answer', question: 'How should I proceed?', options: [], multiSelect: false, freeText: true }] },
    { type: 'error', message: 'A visible failure', recoverable: true },
  ]
  const state = makeState([session({ status: 'waiting', lastSeq: events.length })], { s1: events.map((event, i) => env('s1', i + 1, event)) })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = events.length
  await page.locator('.chat-tool-head').click()
  await expect(page.locator('.chat-tool-body')).toContainText('package contents')
  await page.locator('.chat-q-text').fill('Keep this answer')
  await page.getByRole('button', { name: 'Hide activity', exact: true }).click()
  await expect(page.locator('.chat-tool')).toBeHidden()
  await expect(page.locator('.chat-thought-toggle')).toBeHidden()
  await expect(page.locator('.chat-plan')).toBeHidden()
  await expect(page.locator('.chat-msg-user')).toContainText('Review the code')
  await expect(page.locator('.chat-transcript')).toContainText('Here is the actual reply.')
  await expect(page.locator('.chat-msg-error')).toContainText('A visible failure')
  await expect(page.locator('.chat-permission')).toBeVisible()
  await expect(page.locator('.chat-q-text')).toBeVisible()
  await expect(page.locator('.chat-q-text')).toHaveValue('Keep this answer')
  await page.screenshot({ path: info.outputPath('messages-only.png') })
  await page.getByRole('button', { name: 'Show activity', exact: true }).click()
  await expect(page.locator('.chat-tool-body')).toBeVisible()
  await expect(page.locator('.chat-q-text')).toHaveValue('Keep this answer')
  await page.getByRole('button', { name: 'Hide activity', exact: true }).click()
  sock.push('s1', { type: 'permission.resolved', id: 'p1', optionId: 'yes', by: 'user' })
  await expect(page.locator('.chat-permission')).toBeHidden()
  sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: ' Still streaming.' })
  await expect(page.locator('.chat-msg-agent').first()).toContainText('Still streaming.')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show activity', exact: true })).toBeVisible()
  await expect(page.locator('.chat-tool')).toBeHidden()
  await expect(page.locator('.chat-permission')).toBeVisible()
})

test('omits legacy Muse reminder cards without removing messages or real tools', async ({ page }) => {
  const events: ChatEvent[] = [
    { type: 'turn.started', turnId: 't1', prompt: { text: 'Work on the code', attachments: [], mentions: [] } },
    { type: 'tool.started', turnId: 't1', id: 'internal', kind: 'other', title: 'Reminder child session' },
    { type: 'tool.finished', turnId: 't1', id: 'internal', status: 'completed' },
    { type: 'tool.started', turnId: 't1', id: 'real', kind: 'other', title: 'Review subagent' },
    { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: 'Reminder child session is internal bookkeeping.' },
  ]
  await installRoutes(page, makeState([session({ agent: 'muse' })], { s1: events.map((event, i) => env('s1', i + 1, event)) }))
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  await expect(page.locator('.chat-tool', { hasText: 'Reminder child session' })).toBeHidden()
  await expect(page.locator('.chat-tool', { hasText: 'Review subagent' })).toBeVisible()
  await expect(page.locator('.chat-msg-agent')).toContainText('Reminder child session is internal bookkeeping.')
  await page.getByRole('button', { name: 'Hide activity', exact: true }).click()
  await page.getByRole('button', { name: 'Show activity', exact: true }).click()
  await expect(page.locator('.chat-tool', { hasText: 'Reminder child session' })).toBeHidden()
})

test('renders local Markdown links and opens safe text previews without navigating or launching work', async ({ page }, info) => {
  const path = '/Users/example/dev/Poise/README.md#L2'
  const events: ChatEvent[] = [
    { type: 'turn.started', turnId: 't1', prompt: { text: 'Show the readme', attachments: [], mentions: [] } },
    { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: `[README.md](${path}) and [web](https://example.com).` },
  ]
  const state = makeState([session()], { s1: events.map((event, i) => env('s1', i + 1, event)) })
  await installRoutes(page, state)
  const requests: string[] = []
  await page.route('**/api/chat/file?**', async route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('session')).toBe('s1')
    requests.push(url.searchParams.get('path')!)
    await route.fulfill({ json: { path: path.split('#')[0], text: '# Readme\n<script>window.fileExecuted = true</script>\nSafe content', line: 2, endLine: 2, truncated: false } })
  })
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  const link = page.locator('.chat-msg-agent').getByRole('link', { name: 'README.md', exact: true })
  await expect(link).toBeVisible()
  expect(requests).toEqual([])
  const before = page.url()
  await link.click()
  const preview = page.getByRole('dialog', { name: 'File preview' })
  await expect(preview).toBeVisible()
  await expect(preview.locator('.chat-file-line.selected')).toHaveText('<script>window.fileExecuted = true</script>')
  expect(await page.evaluate(() => (window as any).fileExecuted)).toBeUndefined()
  await page.screenshot({ path: info.outputPath('file-preview-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: info.outputPath('file-preview-dark.png') })
  expect(page.url()).toBe(before)
  expect(requests).toEqual([path])
  expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await expect(link).toBeFocused()
  await expect(page.getByRole('link', { name: 'web', exact: true })).toHaveAttribute('href', 'https://example.com')
})

test('shows file-preview errors and ignores late responses after closing', async ({ page }) => {
  const events: ChatEvent[] = [
    { type: 'turn.started', turnId: 't1', prompt: { text: 'Read a file', attachments: [], mentions: [] } },
    { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: '[file](README.md)' },
  ]
  await installRoutes(page, makeState([session()], { s1: events.map((event, i) => env('s1', i + 1, event)) }))
  await installSocket(page)
  let release!: () => void
  let delayed = false
  await page.route('**/api/chat/file?**', async route => {
    if (delayed) await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ status: 403, json: { error: 'Private files cannot be previewed' } })
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'file', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'File preview' })
  await expect(preview).toContainText('Private files cannot be previewed')
  await preview.getByRole('button', { name: 'Close file preview' }).click()
  delayed = true
  await page.getByRole('link', { name: 'file', exact: true }).click()
  await expect(preview).toContainText('Loading file')
  await expect.poll(() => !!release).toBe(true)
  await page.keyboard.press('Escape')
  release()
  await expect(preview).toBeHidden()
})

test('Auto-merge stays beside Memories, follows the selected session, and persists through reload without sending a prompt', async ({ page }) => {
  const state = makeState([session(), session({ id: 's2', title: 'Other repository', repo: 'acme/tools' })])
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('s1')
  const toggle = page.getByRole('button', { name: 'Auto-merge', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle.locator('svg')).toHaveCount(1)
  expect(await toggle.textContent()).toBe('')
  expect(await toggle.evaluate(el => el.nextElementSibling?.getAttribute('aria-label'))).toBe('Memories')
  await input(page).fill('Keep this draft')
  await toggle.focus()
  await toggle.press('Space')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toBeFocused()
  expect(sock.framesOf('set_auto_merge')[0].command).toEqual({ type: 'set_auto_merge', sessionId: 's1', enabled: true })
  await expect(input(page)).toHaveValue('Keep this draft')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  state.sessions[0].status = 'running'
  sock.push('s1', { type: 'status.changed', status: 'running' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('Auto-merge can be chosen in the fresh console before sending a Poise batch, without routing it to the single-change controller', async ({ page }) => {
  const state = makeState([])
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Auto-merge', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(state.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const text = 'Add a search box to the session list in Poise. Complete and merge all the slices.'
  await input(page).fill(text)
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(state.calls.find(c => c.method === 'POST' && c.path === '/api/chat/sessions')?.body).toMatchObject({ autoMerge: true, agent: 'claude', model: 'opus-5-high' })
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text, sessionId: 'new-1' })
  expect(sock.framesOf('poise.change')).toHaveLength(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => sessionStorage.getItem('poise-chat-fresh-auto-merge'))).toBeNull()
  await page.screenshot({ path: test.info().outputPath('auto-merge-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: test.info().outputPath('auto-merge-dark.png') })
})

test('Auto-merge waits for its acknowledgement and preserves a message when the setting fails', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.autoAck = false
  await input(page).fill('Complete the next PRs')
  const toggle = page.getByRole('button', { name: 'Auto-merge', exact: true })
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await input(page).press('Enter')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  sock.ack(sock.framesOf('set_auto_merge')[0], false, 'Connection refused', 'unavailable')
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.chat-notice')).toContainText('Auto-merge failed')
  await expect(input(page)).toHaveValue('Complete the next PRs')
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('Auto-merge keeps a late acknowledgement bound to the original session', async ({ page }) => {
  const state = makeState([session(), session({ id: 's2', title: 'Second' })])
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.autoAck = false
  const toggle = page.getByRole('button', { name: 'Auto-merge', exact: true })
  await toggle.click()
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item.active')).toContainText('Second')
  const updated = { ...state.sessions[0], autoMerge: true, lastSeq: 1 }
  sock.ack(sock.framesOf('set_auto_merge')[0], true, '', undefined, { session: updated, applies: 'next_turn' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.chat-session-item.active')).toContainText('Second')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})


const queuedRows = (page: Page) => page.locator('.chat-queue-item')
const queuePanel = (page: Page) => page.locator('.chat-message-queue')

test('queues five idle messages before the first task, with an expanded collapsible panel above the console', async ({ page }, info) => {
  const state = makeState([]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/')
  await expect(queuePanel(page)).toBeHidden()
  for (let i = 1; i <= 5; i++) {
    await input(page).fill(`/queue Follow-up ${i}`); await input(page).press('Enter')
    await expect(queuedRows(page)).toHaveCount(i)
    await expect(queuedRows(page).last().locator('select')).toBeEnabled()
  }
  expect(sock.framesOf('prompt')).toHaveLength(0); expect(sock.framesOf('steer')).toHaveLength(0)
  expect(state.calls.filter(c => c.path === '/api/chat/sessions' && c.method === 'POST').map(c => c.body)).toEqual([{ agent: 'claude', model: 'opus-5-high', effort: 'high', deferStart: true }])
  await expect(queuePanel(page)).toHaveAttribute('open', '')
  expect((await queuePanel(page).boundingBox())!.y + (await queuePanel(page).boundingBox())!.height).toBeLessThanOrEqual((await page.locator('.chat-v-composer').boundingBox())!.y)
  await input(page).fill('The first real task')
  await queuePanel(page).locator('summary').click()
  await expect(queuePanel(page)).not.toHaveAttribute('open', '')
  await expect(input(page)).toHaveValue('The first real task')
  await queuePanel(page).locator('summary').click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    await page.screenshot({ path: info.outputPath(`queue-${theme}.png`), animations: 'disabled' })
  }
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text: 'The first real task' })
  expect(sock.framesOf('queue.add')).toHaveLength(5)
})

test('the /queue chip and pasted switch queue rather than steer or stop an active turn', async ({ page }) => {
  const state = makeState([session({ status: 'running' })]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1')
  await input(page).fill('/queue'); await input(page).press('Space')
  await expect(page.locator('.chat-v-chip')).toHaveText('/queue')
  await input(page).fill('Do this later')
  await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toBeVisible()
  await input(page).press('Enter')
  await expect(queuedRows(page)).toHaveCount(1)
  await input(page).fill('/queue Another follow-up')
  await page.getByRole('button', { name: 'Queue message', exact: true }).click()
  await expect(queuedRows(page)).toHaveCount(2)
  expect(sock.framesOf('steer')).toHaveLength(0); expect(sock.framesOf('cancel')).toHaveLength(0); expect(sock.framesOf('prompt')).toHaveLength(0)
  await expect(page.locator('.chat-v-chip')).toBeHidden()
  await input(page).fill('Regular steering still works'); await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('steer').length).toBe(1)
})

test('each queued row selects its agent, model and effort without changing the current agent', async ({ page }) => {
  const state = makeState([session()]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1')
  await input(page).fill('/queue Review with a different agent'); await input(page).press('Enter')
  const select = queuedRows(page).first().locator('select')
  await expect(select).toBeEnabled()
  await expect(select.locator('optgroup')).toHaveCount(5)
  await select.selectOption('gpt-6-astra-max')
  await expect(select).toHaveValue('gpt-6-astra-max')
  await expect(select.locator('option:checked')).toContainText('Codex')
  await expect(page.locator('.chat-h-agent')).toHaveText('Claude Code')
  await expect(select.locator('option[value="gemini-3.8-flash-high"]')).toBeDisabled()
  await page.reload(); await expect(queuedRows(page)).toHaveCount(1)
  await expect(queuedRows(page).first().locator('select')).toHaveValue('gpt-6-astra-max')
  await expect(queuePanel(page)).toHaveAttribute('open', '')
  await queuedRows(page).first().getByRole('button', { name: 'Remove queued message 1' }).click()
  await expect(queuePanel(page)).toBeHidden()
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('queue disclosure and agent selection survive streaming; completed rows disappear without browser dispatch', async ({ page }) => {
  const state = makeState([session({ status: 'running' })]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1')
  await input(page).fill('/queue One'); await input(page).press('Enter'); await expect(queuedRows(page)).toHaveCount(1)
  await input(page).fill('/queue Two'); await input(page).press('Enter'); await expect(queuedRows(page)).toHaveCount(2)
  await expect(queuedRows(page).last().locator('select')).toBeEnabled()
  await queuePanel(page).locator('summary').click()
  sock.push('s1', { type: 'text.delta', turnId: 'current', messageId: 'm', delta: 'Working on the original task' })
  await expect(queuePanel(page)).not.toHaveAttribute('open', '')
  const q = state.sessions[0].queue!
  sock.push('s1', { type: 'queue.updated', queue: { ...q, revision: q.revision + 1, items: q.items.slice(1) } })
  await queuePanel(page).locator('summary').click(); await expect(queuedRows(page)).toHaveCount(1)
  await expect(queuedRows(page).first()).toContainText('Two')
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('a failed queue acknowledgement restores the draft without sending it to an agent', async ({ page }) => {
  const state = makeState([session()]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1'); sock.autoAck = false
  await input(page).fill('/queue Keep this message'); await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('queue.add').length).toBe(1)
  await expect(queuedRows(page)).toHaveCount(1)
  sock.ack(sock.framesOf('queue.add')[0], false, 'Temporary storage failure', 'unavailable')
  await expect(input(page)).toHaveValue('Keep this message'); await expect(page.locator('.chat-v-chip')).toHaveText('/queue')
  await expect(page.locator('.chat-notice')).toContainText('Temporary storage failure')
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('late queue acknowledgements and removal stay bound to their original session', async ({ page }) => {
  const state = makeState([session({ id: 's2', title: 'Other', createdAt: '2026-09-17T10:00:00Z' }), session()])
  await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1'); sock.autoAck = false
  await input(page).fill('/queue Bound to the first'); await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('queue.add').length).toBe(1)
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item.active')).toContainText('Other')
  const cmd = sock.framesOf('queue.add')[0].command
  if (cmd.type !== 'queue.add') throw new Error('missing queue add')
  sock.ack(sock.framesOf('queue.add')[0], true, '', undefined, { queue: { revision: 1, ready: false, items: [{ id: cmd.itemId, prompt: { text: cmd.text, attachments: [], mentions: [] }, agent: 'claude', model: 'opus-5-max', effort: 'max', state: 'waiting', createdAt: NOW }] } })
  await expect(queuePanel(page)).toBeHidden()
  await expect(page.locator('.chat-session-item.active')).toContainText('Other')
  expect(cmd.sessionId).toBe('s1')
})


test('an enqueue error preserves a newer composer draft and leaves the unsent item visible', async ({ page }) => {
  const state = makeState([session()]); await installRoutes(page, state); const sock = await installSocket(page, state)
  await page.goto('/'); await sock.subscribed('s1'); sock.autoAck = false
  await input(page).fill('/queue Keep the unsent task'); await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('queue.add').length).toBe(1)
  await input(page).fill('A newer draft')
  sock.ack(sock.framesOf('queue.add')[0], false, 'The disk could not save the task', 'unavailable')
  await expect(input(page)).toHaveValue('A newer draft')
  await expect(queuedRows(page).first()).toContainText('Keep the unsent task')
  await expect(queuedRows(page).first()).toContainText('The disk could not save the task')
  await queuedRows(page).first().getByRole('button', { name: 'Remove queued message 1' }).click()
  await expect(queuePanel(page)).toBeHidden()
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('the expanded queue leaves the console usable in a small window', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 600, height: 500 })
  const state = makeState([session()]); await installRoutes(page, state); await installSocket(page, state)
  await page.goto('/')
  for (let i = 1; i <= 5; i++) {
    await input(page).fill(`/queue Small window follow-up ${i}`); await input(page).press('Enter')
    await expect(queuedRows(page)).toHaveCount(i)
    await expect(queuedRows(page).last().locator('select')).toBeEnabled()
  }
  await expect(input(page)).toBeVisible()
  const box = await page.locator('.chat-v-composer').boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(500)
  const panel = await queuePanel(page).boundingBox()
  const header = await page.locator('.chat-session-header').boundingBox()
  expect(panel!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1)
  expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(600)
  await page.screenshot({ path: info.outputPath('queue-small.png'), animations: 'disabled' })
})

async function installMemoryRoutes(page: Page) {
  const state = { text: '', revision: 0, writes: [] as string[], fail: false, wait: null as (() => Promise<void>) | null }
  await page.route('**/api/chat/memories', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { text: state.text, revision: state.revision } }); return }
    const body = route.request().postDataJSON() as { text: string, revision: number }
    state.writes.push(body.text)
    if (state.wait) await state.wait()
    if (state.fail) { await route.fulfill({ status: 503, json: { error: 'fixture save unavailable' } }); return }
    if (body.revision !== state.revision && body.text !== state.text) { await route.fulfill({ status: 409, json: { error: 'Memories changed in another tab.' } }); return }
    state.text = body.text; state.revision++
    await route.fulfill({ json: { text: state.text, revision: state.revision } })
  })
  return state
}
const memoryToggle = (page: Page) => page.getByRole('button', { name: 'Memories', exact: true })
const memoryText = (page: Page) => page.getByRole('textbox', { name: 'Memories text', exact: true })

test('Memories is the rightmost icon and opens a shared autosaved pane without starting a session', async ({ page }, info) => {
  const state = makeState([])
  await installRoutes(page, state); const sock = await installSocket(page, state)
  const saved = await installMemoryRoutes(page)
  await page.goto('/')
  const toggle = memoryToggle(page)
  expect(await toggle.evaluate(el => el.parentElement?.lastElementChild === el)).toBe(true)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(memoryText(page)).toBeEnabled()
  await memoryText(page).fill('Prefer small, tested changes.\nKeep Finnish text: äö.')
  await expect.poll(() => saved.text).toBe('Prefer small, tested changes.\nKeep Finnish text: äö.')
  await expect(page.locator('.chat-memories-status')).toHaveText('Saved automatically')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    await page.screenshot({ path: info.outputPath(`memories-${theme}.png`) })
  }
  await memoryText(page).press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#chat-memories-pane')).toHaveAttribute('aria-hidden', 'true')
  await toggle.click(); await expect(memoryText(page)).toHaveValue(saved.text)
  await page.reload(); await expect(memoryText(page)).toHaveValue(saved.text)
  expect(state.calls.filter(call => call.method === 'POST' && call.path === '/api/chat/sessions')).toHaveLength(0)
  expect(sock.framesOf('prompt')).toHaveLength(0)
})

test('Memories save finishes before a message is dispatched, including when the pane is closed', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state); const sock = await installSocket(page, state)
  const saved = await installMemoryRoutes(page)
  await page.goto('/'); await sock.subscribed('s1')
  await memoryToggle(page).click(); await expect(memoryText(page)).toBeEnabled()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  saved.wait = () => held
  await memoryText(page).fill('Always run the tests.')
  await page.getByRole('button', { name: 'Close memories' }).click()
  await input(page).fill('Implement the next slice'); await input(page).press('Enter')
  await expect.poll(() => saved.writes.length).toBe(1)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  release()
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text: 'Implement the next slice' })
  expect(saved.text).toBe('Always run the tests.')
})

test('a failed Memories save keeps both drafts and does not send a message missing its context', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state); const sock = await installSocket(page, state)
  const saved = await installMemoryRoutes(page)
  await page.goto('/'); await sock.subscribed('s1')
  await memoryToggle(page).click(); await expect(memoryText(page)).toBeEnabled()
  saved.fail = true
  await memoryText(page).fill('Remember this context')
  await input(page).fill('Do not lose my message'); await input(page).press('Enter')
  await expect(input(page)).toHaveValue('Do not lose my message')
  await expect(page.locator('.chat-notice')).toContainText('Message not sent')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  await expect(memoryText(page)).toHaveValue('Remember this context')
  saved.fail = false
  await page.getByRole('button', { name: 'Retry save' }).click()
  await expect(page.locator('.chat-memories-status')).toHaveText('Saved automatically')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
})

test('Memories stay editable across sessions and streaming, fit small windows, and clearing is saved', async ({ page }) => {
  const state = makeState([session(), session({ id: 's2', title: 'Second session' })])
  await installRoutes(page, state); const sock = await installSocket(page, state)
  const saved = await installMemoryRoutes(page)
  await page.goto('/'); await sock.subscribed('s1')
  await memoryToggle(page).click(); await expect(memoryText(page)).toBeEnabled()
  await memoryText(page).fill('Shared across all sessions')
  await expect.poll(() => saved.text).toBe('Shared across all sessions')
  const handle = await memoryText(page).elementHandle()
  sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: 'Streaming content' })
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(memoryText(page)).toHaveValue(saved.text)
  expect(await handle!.evaluate(el => el.isConnected)).toBe(true)
  await page.setViewportSize({ width: 600, height: 500 })
  await expect.poll(async () => { const b = await memoryText(page).boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= 600 && b.y + b.height <= 500 }).toBe(true)
  await memoryText(page).fill('')
  await expect.poll(() => saved.text).toBe('')
})
