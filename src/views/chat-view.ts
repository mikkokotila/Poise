// Chat — one view for a full coding-agent conversation with any installed
// agent, running as itself under a Poise-native interface. Sessions live on
// the Poise server (server/chat/); this view is the window: a sidebar of
// sessions, a header describing the one on screen, the transcript folded
// from the event stream, and the composer.
//
// Everything here renders from the transcript mirror over the socket. A
// reload re-subscribes from the last seq seen and re-joins a running turn;
// unanswered permission and question cards come back from history alone.

import type {
  ChatEnvelope,
  NewSessionRequest,
  SessionContext,
  SessionRecord,
  SessionStatus,
  AgentId,
} from '../../server/chat/protocol'
import { AGENT_LABELS } from '../../server/chat/protocol'
import { chatClient, ChatCommandError, ChatHttpError, type AgentsResponse, type AgentInfo } from '../chat-client'
import { escapeHtml } from '../markdown'
import { renderNewSessionDialog } from './chat-new-session'
import {
  createModel, applyEvent, addOptimisticTurn, dropOptimisticTurns, focusedPending, createTranscriptView, pickQuestionOption,
  type TranscriptModel, type TranscriptView,
} from './chat-transcript'
import { createComposer, emptyDraft, type Composer, type ComposerDraft } from './chat-composer'
import { quickSessionRequest, QUICK_SESSION_MODEL, consoleModelLabel } from '../chat-catalog'
import { attachChatSidebar } from './chat-sidebar'

interface SessionEntry {
  record: SessionRecord
  model: TranscriptModel
  /** History fetched and the socket subscribed. */
  loaded: boolean
  loading: boolean
  /** Created locally; the server has not answered the POST yet. */
  pending: boolean
  draft: ComposerDraft | null
  error: string | null
}

let viewEl: HTMLElement
let initialized = false
let listEl: HTMLElement
let headerEl: HTMLElement
let mainEl: HTMLElement
let scrollEl: HTMLElement
let transcriptEl: HTMLElement
let dockEl: HTMLElement
let dialogEl: HTMLElement
let noticeEl: HTMLElement
let transcript: TranscriptView
let composer: Composer

const sessions = new Map<string, SessionEntry>()
let order: string[] = []
let activeId: string | null = null
let agentsInfo: AgentsResponse | null = null
let agentsPromise: Promise<AgentsResponse | null> | null = null
let renderQueued = false
let tickTimer: ReturnType<typeof setInterval> | null = null

let splitPane: ReturnType<typeof attachChatSidebar>
let freshDraft: ComposerDraft | null = null
let freshModelIdentity = QUICK_SESSION_MODEL
let quickSessionPromise: Promise<SessionEntry> | null = null
let firstPromptPending = false
/** A single click waits this long so a double-click renames without opening. */
const CLICK_DELAY_MS = 220
const STICK_TO_BOTTOM_PX = 40
const DELETE_ARM_MS = 4000

const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_SIDEBAR = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M5 2.5v9" stroke="currentColor" stroke-width="1.2"/></svg>'
const ICON_STOP = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionTitle(s: SessionRecord): string {
  return s.title || 'New session'
}

function statusText(s: SessionRecord): string {
  switch (s.status) {
    case 'starting': return 'starting…'
    case 'idle': return 'idle'
    case 'queued': return `queued behind ${s.queuedBehind || 'another session'}`
    case 'running': return 'running'
    case 'waiting': return 'waiting for you'
    case 'stopping': return 'stopping…'
    case 'interrupted': return 'interrupted'
    case 'closed': return 'closed'
    case 'error': return 'error'
  }
}

function isRunning(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting' || status === 'stopping' || status === 'queued'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function agentFor(id: string): AgentInfo | undefined {
  return agentsInfo?.agents.find((a) => a.id === id)
}

function loadAgents(force = false): Promise<AgentsResponse | null> {
  if (agentsPromise && !force) return agentsPromise
  agentsPromise = chatClient.agents().then((a) => { agentsInfo = a; return a }).catch((err) => {
    console.error('[chat] agents failed:', err)
    return null
  })
  return agentsPromise
}

function entry(id: string | null = activeId): SessionEntry | null {
  return id ? sessions.get(id) || null : null
}

function setNotice(text: string | null, cls: 'error' | 'info' = 'error'): void {
  if (!noticeEl) return
  noticeEl.hidden = !text
  noticeEl.textContent = text || ''
  noticeEl.className = `chat-notice st-help st-help-${cls}`
}

// ── Shell ──────────────────────────────────────────────────────────────────

function renderShell(): void {
  viewEl.innerHTML = `
    <header class="view-header">
      <div class="filter-cluster chat-view-controls">
        <button type="button" class="chat-icon-btn chat-sidebar-toggle" title="Toggle sessions" aria-label="Toggle sessions" aria-controls="chat-sessions-pane" aria-expanded="true" aria-pressed="true">${ICON_SIDEBAR}</button>
        <button type="button" class="chat-new-btn" title="New session">${ICON_PLUS}<span>New session</span></button>
        <span class="chat-conn" role="status" hidden></span>
      </div>
    </header>
    <main class="chat-shell">
      <div class="chat-layout">
        <aside id="chat-sessions-pane" class="chat-sidebar" aria-label="Sessions">
          <div class="chat-session-list" role="list"></div>
          <div class="chat-sidebar-resize" role="separator" aria-label="Resize sessions pane" aria-orientation="vertical" aria-controls="chat-sessions-pane" tabindex="0" title="Drag to resize; double-click to reset"></div>
        </aside>
        <section class="chat-main">
          <div class="chat-session-header" hidden></div>
          <div class="chat-notice st-help st-help-error" role="status" hidden></div>
          <div class="chat-transcript-scroll">
            <div class="chat-empty chat-transcript-loading" hidden>Loading…</div>
            <div class="chat-transcript"></div>
          </div>
          <div class="chat-dock"></div>
          <div class="chat-new-dialog" role="dialog" aria-label="New session" hidden></div>
        </section>
      </div>
    </main>
  `
  listEl = viewEl.querySelector<HTMLElement>('.chat-session-list')!
  headerEl = viewEl.querySelector<HTMLElement>('.chat-session-header')!
  mainEl = viewEl.querySelector<HTMLElement>('.chat-main')!
  scrollEl = viewEl.querySelector<HTMLElement>('.chat-transcript-scroll')!
  transcriptEl = viewEl.querySelector<HTMLElement>('.chat-transcript')!
  dockEl = viewEl.querySelector<HTMLElement>('.chat-dock')!
  dialogEl = viewEl.querySelector<HTMLElement>('.chat-new-dialog')!
  noticeEl = viewEl.querySelector<HTMLElement>('.chat-notice')!

  viewEl.querySelector<HTMLButtonElement>('.chat-new-btn')!.addEventListener('click', () => { void openNewSessionDialog() })

  transcript = createTranscriptView(transcriptEl, {
    onPermission: (id, optionId) => { void respondPermission(id, optionId) },
    onQuestion: (id, answers) => { void answerQuestion(id, answers) },
    onRevert: (diffId) => { void revertDiff(diffId) },
    onLoadDiff: (diffId) => { void loadCompleteDiff(diffId) },
  })
  transcriptEl.addEventListener('chat:rerender', () => queueRender())

  composer = createComposer({
    onSend: (draft) => { void sendPrompt(draft) },
    loadModels: async () => {
      const catalogue = await loadAgents(true)
      if (!catalogue) throw new Error('Could not load the model catalogue')
      return catalogue.agents
    },
    onModelSelect: (identity) => {
      if (entry() || quickSessionPromise || firstPromptPending) return
      freshModelIdentity = identity
      setNotice(null)
      composerStateFor(null)
    },
    onSteer: (text) => { void steer(text) },
    onStop: () => { void cancelTurn() },
    onResume: () => { void resumeActive() },
    onCommand: (name, arg) => { void runOwnCommand(name, arg) },
    prepareUpload: async () => (await ensureQuickSession()).record.id,
    upload: async (file, sessionId) => {
      const attachment = await chatClient.uploadAttachment(sessionId, file)
      // A slow upload belongs to its original draft, even if the user switched.
      if (activeId !== sessionId) {
        const target = sessions.get(sessionId)
        if (target) {
          const draft = target.draft || emptyDraft()
          target.draft = { ...draft, attachments: [...draft.attachments, attachment] }
        }
      }
      return attachment
    },
    searchFiles: async (q) => {
      if (!activeId) return []
      const r = await chatClient.files(activeId, q)
      return Array.isArray(r.files) ? r.files : []
    },
  })
  dockEl.appendChild(composer.el)
  splitPane = attachChatSidebar(viewEl, () => { composer.layout(); queueRender() })
  const layoutObserver = new ResizeObserver(() => queueRender())
  layoutObserver.observe(mainEl)
  layoutObserver.observe(dockEl)

  attachSidebar()
  attachHeader()
  attachKeys()
}

// ── Sessions list ──────────────────────────────────────────────────────────

function sortOrder(): void {
  order.sort((a, b) => {
    const ea = sessions.get(a)!, eb = sessions.get(b)!
    // A pending session is the newest thing there is.
    if (ea.pending !== eb.pending) return ea.pending ? -1 : 1
    return (eb.record.createdAt || '').localeCompare(ea.record.createdAt || '')
  })
}

function upsertRecord(record: SessionRecord, opts: { pending?: boolean } = {}): SessionEntry {
  let e = sessions.get(record.id)
  if (!e) {
    e = { record, model: createModel(), loaded: false, loading: false, pending: !!opts.pending, draft: null, error: null }
    sessions.set(record.id, e)
    order.push(record.id)
  } else {
    e.record = record
    if (opts.pending !== undefined) e.pending = opts.pending
  }
  sortOrder()
  return e
}

async function loadSessions(): Promise<void> {
  try {
    const { sessions: list } = await chatClient.listSessions()
    const seen = new Set<string>()
    for (const s of list) { upsertRecord(s); seen.add(s.id) }
    // Sessions gone from the server (deleted elsewhere) leave the list, but a
    // pending one the server has not answered for yet stays.
    for (const id of Array.from(sessions.keys())) {
      const e = sessions.get(id)!
      if (!seen.has(id) && !e.pending) {
        sessions.delete(id)
        order = order.filter((x) => x !== id)
        if (activeId === id) activeId = null
      }
    }
    sortOrder()
    setNotice(null)
  } catch (err) {
    setNotice(`Could not load sessions — ${(err as Error).message}`)
  }
  queueRender()
}

let armedDelete: { id: string, until: number } | null = null
let clickTimer: ReturnType<typeof setTimeout> | null = null
let lastSidebarHtml = ''

function renderSidebar(): void {
  // A rename in progress must survive a streaming re-render.
  if (listEl.querySelector('.chat-session-rename')) return
  const html = sidebarHtml()
  if (html === lastSidebarHtml) return
  lastSidebarHtml = html
  listEl.innerHTML = html
}

function sidebarHtml(): string {
  if (!order.length) {
    return '<div class="chat-empty chat-sidebar-empty">No sessions yet.</div>'
  }
  return order.map((id) => {
    const e = sessions.get(id)!
    const s = e.record
    const running = isRunning(s.status)
    const armed = armedDelete?.id === id && armedDelete.until > Date.now()
    const waiting = s.status === 'waiting' || (s.pendingRequests?.length || 0) > 0
    return `<div class="chat-session-item${id === activeId ? ' active' : ''}${e.pending ? ' pending' : ''}" role="listitem" data-id="${escapeHtml(id)}" tabindex="0">`
      + `<div class="chat-session-title" title="${escapeHtml(sessionTitle(s))}">${escapeHtml(sessionTitle(s))}</div>`
      + `<div class="chat-session-meta">`
      + `<span class="chat-pill">${escapeHtml(AGENT_LABELS[s.agent] || s.agent)} · ${escapeHtml(s.model)}</span>`
      + `<span class="chat-session-date">${escapeHtml(dateLabel(s.createdAt))}</span>`
      + (running ? `<span class="chat-session-running${waiting ? ' waiting' : ''}" title="${escapeHtml(statusText(s))}" aria-label="${escapeHtml(statusText(s))}"></span>` : '')
      + `</div>`
      + `<button type="button" class="chat-session-delete${armed ? ' armed' : ''}" data-id="${escapeHtml(id)}" title="${armed ? 'Confirm delete' : 'Delete session'}" aria-label="${armed ? 'Confirm deleting session' : 'Delete session'}">${armed ? 'Sure?' : '×'}</button>`
      + `</div>`
  }).join('')
}

function attachSidebar(): void {
  listEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const del = target.closest<HTMLButtonElement>('.chat-session-delete')
    if (del) {
      e.stopPropagation()
      const id = del.dataset.id!
      const armed = armedDelete?.id === id && armedDelete.until > Date.now()
      if (!armed) {
        armedDelete = { id, until: Date.now() + DELETE_ARM_MS }
        renderSidebar()
        window.setTimeout(() => {
          if (armedDelete?.id === id && armedDelete.until <= Date.now()) { armedDelete = null; renderSidebar() }
        }, DELETE_ARM_MS + 50)
        return
      }
      armedDelete = null
      void deleteSession(id)
      return
    }
    const item = target.closest<HTMLElement>('.chat-session-item')
    if (!item || item.querySelector('.chat-session-rename')) return
    const id = item.dataset.id!
    // A double-click renames; the single click waits so it never opens first.
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      clickTimer = null
      void selectSession(id)
    }, CLICK_DELAY_MS)
  })
  listEl.addEventListener('dblclick', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.chat-session-item')
    if (!item) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    e.preventDefault()
    startRename(item)
  })
  listEl.addEventListener('keydown', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.chat-session-item')
    if (!item || item !== e.target) return
    if (e.key === 'Enter') { e.preventDefault(); void selectSession(item.dataset.id!) }
    if (e.key === 'F2') { e.preventDefault(); startRename(item) }
  })
}

function startRename(item: HTMLElement): void {
  const id = item.dataset.id!
  const e = sessions.get(id)
  if (!e || e.pending) return
  const titleEl = item.querySelector<HTMLElement>('.chat-session-title')!
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'chat-session-rename'
  input.value = e.record.title
  input.setAttribute('aria-label', 'Session title')
  input.maxLength = 200
  titleEl.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (commit: boolean) => {
    if (done) return
    done = true
    // Put the title back first: the sidebar never re-renders over a rename
    // in progress, so the input has to go before the list can refresh.
    input.replaceWith(titleEl)
    const title = input.value.trim()
    if (commit && title && title !== e.record.title) {
      try {
        const r = await chatClient.renameSession(id, title)
        upsertRecord(r.session)
      } catch (err) {
        setNotice(`Rename failed — ${(err as Error).message}`)
      }
    }
    queueRender()
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); void finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); void finish(false) }
  })
  input.addEventListener('blur', () => { void finish(true) })
}

async function deleteSession(id: string): Promise<void> {
  const e = sessions.get(id)
  if (!e) return
  try {
    if (!e.pending) await chatClient.deleteSession(id)
    chatClient.unsubscribe(id)
    sessions.delete(id)
    order = order.filter((x) => x !== id)
    if (activeId === id) {
      // Nothing is on screen now; selecting the next session must treat it
      // as a switch (fresh transcript, its own draft), not a no-op.
      activeId = null
      composerStateFor(null)
      transcript.clear()
      if (order[0]) void selectSession(order[0])
      else { composer.setDraft(freshDraft); setNotice(null) }
    }
    queueRender()
  } catch (err) {
    setNotice(`Delete failed — ${(err as Error).message}`)
    queueRender()
  }
}

// ── Selecting and loading a session ────────────────────────────────────────

async function selectSession(id: string): Promise<void> {
  const e = sessions.get(id)
  if (!e) return
  if (!activeId) freshDraft = composer.getDraft()
  if (activeId && activeId !== id) {
    const prev = sessions.get(activeId)
    if (prev) prev.draft = composer.getDraft()
  }
  const switching = activeId !== id
  activeId = id
  closeDialog()
  if (switching) {
    transcript.clear()
    composer.setDraft(e.draft)
    e.draft = null
    setNotice(e.error)
    scrollToBottom(true)
  }
  // Identity changes are synchronous: an upload resolving before the next
  // animation frame must not attach itself to the newly selected draft.
  composerStateFor(e)
  queueRender()
  if (!e.loaded && !e.loading && !e.pending) await loadHistory(e)
  composer.focus()
}

async function loadHistory(e: SessionEntry): Promise<void> {
  e.loading = true
  queueRender()
  try {
    let after = chatClient.subscribedAfter(e.record.id) ?? 0
    for (let guard = 0; guard < 100; guard++) {
      const page = await chatClient.fetchSession(e.record.id, after)
      e.record = page.session
      for (const env of page.events) {
        if (env.seq > after) { applyEvent(e.model, env); after = env.seq }
      }
      if (!page.truncated || !page.events.length) break
    }
    chatClient.subscribe(e.record.id, after)
    e.loaded = true
    e.error = null
  } catch (err) {
    e.error = `Could not load this session — ${(err as Error).message}`
    if (activeId === e.record.id) setNotice(e.error)
  } finally {
    e.loading = false
    sortOrder()
    queueRender()
    if (activeId === e.record.id) scrollToBottom(true)
  }
}

function onEvent(env: ChatEnvelope): void {
  const e = sessions.get(env.sessionId)
  if (!e) return
  const ev = env.event
  if (ev.type === 'session.created' || ev.type === 'session.resumed' || ev.type === 'session.updated') {
    upsertRecord(ev.session, { pending: false })
  } else if (ev.type === 'status.changed') {
    e.record = { ...e.record, status: ev.status, queuedBehind: ev.queuedBehind }
  } else if (ev.type === 'commands.updated') {
    e.record = { ...e.record, commands: ev.commands }
  } else if (ev.type === 'mode.updated') {
    e.record = { ...e.record, mode: ev.mode, modes: ev.modes }
  } else if (ev.type === 'model.updated') {
    e.record = { ...e.record, model: ev.model, modelId: ev.modelId, effort: ev.effort, efforts: ev.efforts ?? e.record.efforts }
  } else if (ev.type === 'session.closed') {
    e.record = { ...e.record, status: 'closed' }
  } else if (ev.type === 'turn.started' && !e.record.title) {
    e.record = { ...e.record, title: ev.prompt.text.slice(0, 200) }
  }
  applyEvent(e.model, env)
  e.record = { ...e.record, lastSeq: Math.max(e.record.lastSeq || 0, env.seq) }
  queueRender()
}

// ── Commands ───────────────────────────────────────────────────────────────

function commandFailed(err: unknown, what: string): void {
  const code = err instanceof ChatCommandError ? err.code : undefined
  const message = (err as Error).message || String(err)
  setNotice(`${what} failed${code ? ` (${code})` : ''} — ${message}`)
}

/** One user action creates one session; neither focus nor typing launches an agent. */
function ensureQuickSession(firstPrompt?: ComposerDraft): Promise<SessionEntry> {
  if (quickSessionPromise) return quickSessionPromise
  const current = entry()
  if (current && !current.pending) return Promise.resolve(current)
  if (current) return Promise.reject(new Error('The session is still being created.'))
  const draft = firstPrompt ? null : composer.getDraft()
  const selectedModel = freshModelIdentity
  quickSessionPromise = (async () => {
    const catalogue = await loadAgents(true)
    if (!catalogue) throw new Error('Could not load the model catalogue. Your message has not been sent.')
    const request = quickSessionRequest(catalogue.agents, selectedModel)
    if (firstPrompt?.text) request.title = firstPrompt.text.slice(0, 200)
    const created = await createSessionEntry(request, draft, firstPrompt, null)
    freshModelIdentity = QUICK_SESSION_MODEL
    return created
  })().finally(() => { quickSessionPromise = null; queueRender() })
  queueRender()
  return quickSessionPromise
}

async function sendPrompt(draft: ComposerDraft): Promise<void> {
  let e = entry()
  if (!e || e.pending) {
    if (firstPromptPending) return
    firstPromptPending = true
    try {
      e = await ensureQuickSession(draft)
      freshDraft = null
    } catch (err) {
      freshDraft = draft
      if (!activeId) composer.setDraft(draft)
      commandFailed(err, 'Start session')
      queueRender()
      return
    } finally { firstPromptPending = false }
  }
  const prompt = { text: draft.text, attachments: draft.attachments, mentions: draft.mentions }
  // Reuse the immediate first-message preview made during session creation.
  dropOptimisticTurns(e.model)
  addOptimisticTurn(e.model, prompt)
  if (!e.record.title) e.record = { ...e.record, title: draft.text.slice(0, 200) }
  e.record = { ...e.record, status: 'running' }
  if (activeId === e.record.id) { setNotice(null); scrollToBottom(true) }
  queueRender()
  try {
    await chatClient.send({ type: 'prompt', sessionId: e.record.id, ...prompt })
  } catch (err) {
    dropOptimisticTurns(e.model)
    if (e.record.status === 'running' && !e.model.running) e.record = { ...e.record, status: 'idle' }
    if (activeId === e.record.id) { commandFailed(err, 'Send'); composer.setDraft(draft) }
    else { e.draft = draft; e.error = `Send failed — ${(err as Error).message}` }
    queueRender()
  }
}

async function steer(text: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await chatClient.send({ type: 'steer', sessionId: e.record.id, text })
  } catch (err) {
    commandFailed(err, 'Steer')
  }
}

async function cancelTurn(): Promise<void> {
  const e = entry()
  if (!e) return
  e.record = { ...e.record, status: 'stopping' }
  queueRender()
  try {
    await chatClient.send({ type: 'cancel', sessionId: e.record.id })
  } catch (err) {
    commandFailed(err, 'Stop')
  }
}

async function respondPermission(id: string, optionId: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await chatClient.send({ type: 'permission.respond', sessionId: e.record.id, id, optionId })
  } catch (err) {
    commandFailed(err, 'Permission')
  }
}

async function answerQuestion(id: string, answers: Record<string, string | string[]>): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await chatClient.send({ type: 'question.answer', sessionId: e.record.id, id, answers })
  } catch (err) {
    commandFailed(err, 'Answer')
  }
}

async function loadCompleteDiff(diffId: string): Promise<void> {
  const e = entry()
  const found = e?.model.diffs.get(diffId)
  if (!e || !found || found.diff.loadingFull) return
  found.diff.loadingFull = true
  found.diff.loadError = undefined
  found.tool.rev = ++e.model.rev
  queueRender()
  try {
    const full = await chatClient.fetchDiff(e.record.id, diffId)
    if (full.diffId !== diffId || full.path !== found.diff.path) throw new Error('The stored diff did not match this record')
    found.diff.oldText = full.oldText
    found.diff.newText = full.newText
    found.diff.previewOnly = false
  } catch (error) {
    found.diff.loadError = error instanceof Error ? error.message : String(error)
  } finally {
    found.diff.loadingFull = false
    found.tool.rev = ++e.model.rev
    queueRender()
  }
}

async function revertDiff(diffId: string): Promise<void> {
  const e = entry()
  if (!e) return
  const found = e.model.diffs.get(diffId)
  if (found) { found.diff.revert = { state: 'reverting' }; found.tool.rev = ++e.model.rev; queueRender() }
  try {
    await chatClient.send({ type: 'revert', sessionId: e.record.id, diffId })
  } catch (err) {
    if (found) { found.diff.revert = { state: 'error', error: (err as Error).message }; found.tool.rev = ++e.model.rev; queueRender() }
  }
}

async function setModel(model: string, effort?: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await chatClient.send({ type: 'set_model', sessionId: e.record.id, model, effort })
  } catch (err) {
    commandFailed(err, 'Model change')
    queueRender()
  }
}

async function setMode(mode: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await chatClient.send({ type: 'set_mode', sessionId: e.record.id, mode })
  } catch (err) {
    commandFailed(err, 'Mode change')
    queueRender()
  }
}

async function forkActive(): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    const r = await chatClient.forkSession(e.record.id)
    upsertRecord(r.session)
    await selectSession(r.session.id)
  } catch (err) {
    setNotice(`Fork failed — ${(err as Error).message}`)
  }
}

async function resumeActive(): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    const r = await chatClient.resumeSession(e.record.id)
    upsertRecord(r.session)
    queueRender()
  } catch (err) {
    setNotice(`Resume failed — ${(err as Error).message}`)
  }
}

async function runOwnCommand(name: string, arg: string): Promise<void> {
  const e = entry()
  if (!e) return
  if (name === 'model') await setModel(arg, e.record.effort)
  else if (name === 'mode') await setMode(arg)
  else if (name === 'fork') await forkActive()
}

async function handoff(agent: AgentId, model: string, effort?: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    const r = await chatClient.handoffSession(e.record.id, { agent, model, effort })
    upsertRecord(r.session)
    await selectSession(r.session.id)
  } catch (err) {
    setNotice(`Handoff failed — ${(err as Error).message}`)
  }
}

// ── Session header ─────────────────────────────────────────────────────────

function workspaceText(s: SessionRecord): { text: string, cls: string } {
  const w = s.workspace
  if (s.status === 'queued' && s.queuedBehind) return { text: `queued behind ${s.queuedBehind}`, cls: 'warn' }
  if (!w) return { text: '', cls: '' }
  if (w.lockedBy && s.status === 'queued') return { text: `queued behind ${w.lockedBy}`, cls: 'warn' }
  if (!w.onBranch) return { text: `off-branch (on ${w.currentBranch})`, cls: 'warn' }
  if (w.dirty) return { text: `dirty · ${w.dirtyFiles} file${w.dirtyFiles === 1 ? '' : 's'}`, cls: 'warn' }
  return { text: 'clean', cls: 'ok' }
}

let handoffOpen = false
let lastHeaderHtml = ''

function renderHeader(): void {
  const html = headerHtml()
  if (html === lastHeaderHtml) return
  lastHeaderHtml = html
  headerEl.hidden = !html
  headerEl.innerHTML = html
}

function headerHtml(): string {
  const e = entry()
  if (!e) return ''
  const s = e.record
  const agent = agentFor(s.agent)
  const between = !isRunning(s.status) && s.status !== 'starting' && s.status !== 'closed'
  const models = agent?.models.map((m) => m.identity) || []
  if (!models.includes(s.model)) models.unshift(s.model)
  const efforts = s.efforts?.length ? s.efforts : (agent?.efforts || [])
  const ws = workspaceText(s)
  const modeSel = s.capabilities?.modes && s.modes?.length
    ? `<select class="chat-h-select chat-mode-select" aria-label="Mode"${between ? '' : ' disabled'}>${s.modes.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === s.mode ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>`
    : ''
  const others = (agentsInfo?.agents || []).filter((a) => a.id !== s.agent)
  return `
    <div class="chat-h-row">
      <span class="chat-pill chat-h-agent">${escapeHtml(AGENT_LABELS[s.agent] || s.agent)}</span>
      <span class="chat-h-model">
        <select class="chat-h-select chat-model-select" aria-label="Model"${between ? '' : ' disabled'}>${models.map((m) => `<option value="${escapeHtml(m)}"${m === s.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select>
        ${efforts.length ? `<select class="chat-h-select chat-effort-select" aria-label="Effort"${between ? '' : ' disabled'}>${(efforts.includes(s.effort) ? efforts : [s.effort, ...efforts]).map((x) => `<option value="${escapeHtml(x)}"${x === s.effort ? ' selected' : ''}>${escapeHtml(x)}</option>`).join('')}</select>` : `<span class="chat-h-effort">${escapeHtml(s.effort)}</span>`}
      </span>
      <span class="chat-h-repo" title="${escapeHtml(s.checkout || '')}">${s.workspaceKind === 'poise-local' ? '<span>Poise · local</span>' : `<code>${escapeHtml(s.repo || 'local')}</code> · <code>${escapeHtml(s.branch?.name || '')}</code>`}${ws.text ? ` <span class="chat-h-ws ${ws.cls}">${escapeHtml(ws.text)}</span>` : ''}</span>
      ${modeSel}
      <span class="chat-h-status" data-status="${s.status}">${escapeHtml(statusText(s))}</span>
      <span class="chat-controls-spacer"></span>
      ${isRunning(s.status) ? `<button type="button" class="chat-h-btn chat-h-stop" title="Stop the turn (⌘.)">${ICON_STOP} Stop</button>` : ''}
      ${s.capabilities?.fork ? `<button type="button" class="chat-h-btn chat-h-fork"${between ? '' : ' disabled'}>Fork</button>` : ''}
      ${others.length ? `<span class="chat-h-handoff-wrap"><button type="button" class="chat-h-btn chat-h-handoff" aria-haspopup="true" aria-expanded="${handoffOpen}">Hand off…</button>${handoffOpen ? handoffMenu(others) : ''}</span>` : ''}
    </div>
    ${s.orphanNotice ? `<div class="st-help st-help-error">${escapeHtml(s.orphanNotice)}</div>` : ''}
  `
}

function handoffMenu(agents: AgentInfo[]): string {
  const first = agents.find((a) => a.available) || agents[0]
  return `<div class="chat-h-menu" role="menu">
    <label class="chat-h-menu-label">Agent
      <select class="chat-h-select chat-ho-agent" aria-label="Handoff agent">${agents.map((a) => `<option value="${a.id}"${a.id === first.id ? ' selected' : ''}${a.available ? '' : ' disabled'}>${escapeHtml(a.label)}${a.available ? '' : ` — ${escapeHtml(a.reason || 'unavailable')}`}</option>`).join('')}</select>
    </label>
    <label class="chat-h-menu-label">Model
      <select class="chat-h-select chat-ho-model" aria-label="Handoff model">${first.models.map((m) => `<option value="${escapeHtml(m.identity)}">${escapeHtml(m.identity)}</option>`).join('')}</select>
    </label>
    <div class="st-help st-help-info">Starts a new session for that agent with a labelled handoff summary of this one.</div>
    <button type="button" class="chat-h-btn chat-ho-go">Hand off</button>
  </div>`
}

function attachHeader(): void {
  headerEl.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement
    const s = entry()?.record
    if (!s) return
    if (t.classList.contains('chat-model-select')) void setModel(t.value, s.effort)
    else if (t.classList.contains('chat-effort-select')) void setModel(s.model, t.value)
    else if (t.classList.contains('chat-mode-select')) void setMode(t.value)
    else if (t.classList.contains('chat-ho-agent')) {
      const a = agentFor(t.value as AgentId)
      const modelSel = headerEl.querySelector<HTMLSelectElement>('.chat-ho-model')
      if (a && modelSel) modelSel.innerHTML = a.models.map((m) => `<option value="${escapeHtml(m.identity)}">${escapeHtml(m.identity)}</option>`).join('')
    }
  })
  headerEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.chat-h-stop')) { void cancelTurn(); return }
    if (t.closest('.chat-h-fork')) { void forkActive(); return }
    if (t.closest('.chat-h-handoff')) { handoffOpen = !handoffOpen; renderHeader(); return }
    if (t.closest('.chat-ho-go')) {
      const agent = headerEl.querySelector<HTMLSelectElement>('.chat-ho-agent')?.value as AgentId | undefined
      const model = headerEl.querySelector<HTMLSelectElement>('.chat-ho-model')?.value
      if (!agent || !model) return
      handoffOpen = false
      void handoff(agent, model, agentFor(agent)?.models.find((m) => m.identity === model)?.effort)
      return
    }
  })
  document.addEventListener('click', (e) => {
    if (handoffOpen && !(e.target as HTMLElement).closest('.chat-h-handoff-wrap')) { handoffOpen = false; renderHeader() }
  })
}

// ── Keyboard: permission and question cards ────────────────────────────────

function attachKeys(): void {
  document.addEventListener('keydown', (e) => {
    if (!viewEl || viewEl.hidden) return
    const active = document.activeElement as HTMLElement | null
    const tag = active?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const en = entry()
    if (!en) return
    const pending = focusedPending(en.model)
    if (!pending) return
    if (pending.kind === 'permission') {
      let option: string | undefined
      if (/^[1-4]$/.test(e.key)) option = pending.options[Number(e.key) - 1]?.id
      else if (e.key === 'y') option = pending.options.find((o) => o.kind === 'allow_once')?.id
      else if (e.key === 'n') option = pending.options.find((o) => o.kind === 'reject_once')?.id
      if (!option) return
      e.preventDefault()
      void respondPermission(pending.id, option)
    } else if (/^[1-4]$/.test(e.key)) {
      if (pickQuestionOption(transcriptEl, pending.id, Number(e.key))) e.preventDefault()
    }
  })
}

// ── Composer state and layout ──────────────────────────────────────────────

function composerStateFor(e: SessionEntry | null): void {
  if (!e) {
    composer.setCommands([], { model: false, modes: false, fork: false })
    composer.setState({ running: false, disabled: !!quickSessionPromise, placeholder: quickSessionPromise ? 'Starting the session…' : undefined, modelLabel: consoleModelLabel(freshModelIdentity), modelIdentity: freshModelIdentity, sessionId: null })
    return
  }
  const s = e.record
  const running = isRunning(s.status) || !!e.model.running
  let disabled = false
  let placeholder: string | undefined
  if (e.pending) { disabled = true; placeholder = 'Starting the session…' }
  else if (s.status === 'closed') { disabled = true; placeholder = 'This session is closed' }
  else if (s.status === 'interrupted') { disabled = true; placeholder = 'Interrupted by a restart — resume to continue' }
  else if (s.status === 'error') { disabled = true; placeholder = 'The session failed — resume to try again' }
  composer.setCommands(s.commands || [], { modes: !!s.capabilities?.modes, fork: !!s.capabilities?.fork })
  composer.setState({ running, disabled, placeholder, resume: s.status === 'interrupted' || s.status === 'error', sessionId: e.pending ? null : s.id })
}

// The next render pins the transcript to its end regardless of where the
// scroll was — used when a session opens or a prompt is sent.
let forceBottom = false

function scrollToBottom(force = false): void {
  if (force) forceBottom = true
  queueRender()
}

function queueRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

let lastEmpty: boolean | null = null

function render(): void {
  if (!viewEl || viewEl.hidden) return
  renderSidebar()
  renderHeader()
  const e = entry()
  composerStateFor(e)
  const empty = !e || (!e.model.blocks.length && !e.loading)
  mainEl.classList.toggle('chat-empty-session', empty)
  // The fresh console sits slightly above centre. Its own height participates
  // in the calculation, so a taller draft never pushes it off-screen.
  if (lastEmpty !== empty) { lastEmpty = empty; composer.layout() }
  mainEl.style.setProperty('--chat-dock-lift', `${Math.max(0, Math.round(mainEl.clientHeight * 0.58 - dockEl.offsetHeight / 2))}px`)
  viewEl.querySelector<HTMLElement>('.chat-transcript-loading')!.hidden = !(e && e.loading && !e.model.blocks.length)
  // Scrolling sticks to the bottom only for someone already reading there.
  const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
  const wasAtBottom = distance <= STICK_TO_BOTTOM_PX
  if (e) {
    transcript.render(e.model, { running: isRunning(e.record.status) || !!e.model.running, interruptedTurnId: e.record.interruptedTurnId })
  } else {
    transcript.clear()
  }
  if (wasAtBottom || forceBottom) scrollEl.scrollTop = scrollEl.scrollHeight
  forceBottom = false
}

// ── New session dialog ─────────────────────────────────────────────────────

export interface NewSessionPrefill { context?: SessionContext }

async function openNewSessionDialog(prefill: NewSessionPrefill = {}): Promise<void> {
  closeDialog()
  dialogEl.hidden = false
  dialogEl.innerHTML = '<div class="chat-dialog-body"><div class="chat-empty">Loading models…</div></div>'
  const agents = await loadAgents(true)
  if (dialogEl.hidden) return
  if (!agents) {
    dialogEl.innerHTML = '<div class="chat-dialog-body"><div class="st-help st-help-error">Could not load the model catalogue.</div><button type="button" class="st-clear chat-dialog-cancel">Close</button></div>'
    dialogEl.querySelector('.chat-dialog-cancel')!.addEventListener('click', closeDialog)
    return
  }
  renderNewSessionDialog(dialogEl, agents, prefill.context, (request, error) => { void createSession(request, error) }, closeDialog)
}

function closeDialog(): void {
  if (!dialogEl) return
  dialogEl.hidden = true
  dialogEl.innerHTML = ''
}

async function createSessionEntry(req: NewSessionRequest, draft: ComposerDraft | null = null,
  firstPrompt?: ComposerDraft, expectedActiveId = activeId): Promise<SessionEntry> {
  const tempId = `pending-${crypto.randomUUID()}`
  const placeholder: SessionRecord = {
    id: tempId, agent: req.agent, model: req.model, modelId: req.model, effort: req.effort || '', repo: '', checkout: '', workspaceKind: 'poise-local',
    branch: { name: '', origin: 'new', provisional: true },
    title: req.title || req.context?.title || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'starting',
    capabilities: { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false },
    lastSeq: 0, pendingRequests: [], instance: '', context: req.context,
  }
  const temporary = upsertRecord(placeholder, { pending: true })
  temporary.draft = draft
  if (firstPrompt) addOptimisticTurn(temporary.model, firstPrompt)
  if (activeId === expectedActiveId) await selectSession(tempId)
  queueRender()
  try {
    const r = await chatClient.createSession(req)
    sessions.delete(tempId)
    order = order.filter(x => x !== tempId)
    const e = upsertRecord(r.session, { pending: false })
    e.model = temporary.model
    e.draft = temporary.draft
    if (activeId === tempId) {
      activeId = r.session.id
      composerStateFor(e)
    }
    chatClient.subscribe(r.session.id, 0)
    e.loaded = true
    queueRender()
    if (activeId === r.session.id) composer.focus()
    return e
  } catch (err) {
    sessions.delete(tempId)
    order = order.filter(x => x !== tempId)
    if (activeId === tempId) {
      activeId = null
      composerStateFor(null)
      transcript.clear()
      composer.setDraft(draft || freshDraft)
    }
    queueRender()
    throw err
  }
}

async function createSession(req: NewSessionRequest, errorEl: HTMLElement): Promise<void> {
  try {
    await createSessionEntry(req, activeId ? null : composer.getDraft())
  } catch (err) {
    const code = err instanceof ChatHttpError ? err.code : undefined
    const message = (err as Error).message
    const text = code === 'checkout_dirty' ? `The checkout has uncommitted changes on a branch no session owns — commit or stash them first. ${message}`
      : code === 'checkout_busy' ? `The checkout is busy with another session. ${message}`
      : code === 'compat' ? `Caller needs updating (no --record-turn). ${message}`
      : message
    await openNewSessionDialog({ context: req.context })
    const el = dialogEl.querySelector<HTMLElement>('.chat-dialog-error') || errorEl
    el.textContent = text
    el.hidden = false
    queueRender()
  }
}

// ── Entry points ───────────────────────────────────────────────────────────

/** Open an existing session by id (Swarm's Target column). */
export async function openChatSession(id: string): Promise<void> {
  await ensureInit()
  if (!sessions.has(id)) await loadSessions()
  if (sessions.has(id)) await selectSession(id)
  else setNotice(`Session ${id} was not found.`)
}

/** Open the New session dialog prefilled from a card or a document. */
export async function openChatWithContext(prefill: NewSessionPrefill): Promise<void> {
  await ensureInit()
  await openNewSessionDialog(prefill)
}

async function ensureInit(): Promise<void> {
  if (!initialized) await initChatView()
}

export async function initChatView(): Promise<void> {
  viewEl = document.getElementById('view-chat')!
  if (!initialized) {
    initialized = true
    renderShell()
    // Events keep folding into the per-session models while the view is
    // hidden — that is what lets a running turn be re-joined on return
    // without a refetch — so these listeners live for the app's lifetime.
    chatClient.on('event', onEvent)
    chatClient.on('connection', (state) => {
      const el = viewEl.querySelector<HTMLElement>('.chat-conn')
      if (!el) return
      el.hidden = state === 'open'
      el.textContent = state === 'connecting' ? 'Connecting…' : 'Reconnecting…'
    })
    chatClient.on('restart', () => {
      // Sessions may have been interrupted or cleaned up; re-read them and
      // re-subscribe from what each transcript already holds.
      chatClient.resetSubscriptions()
      for (const e of sessions.values()) {
        if (e.loaded) chatClient.subscribe(e.record.id, e.record.lastSeq || 0)
      }
      void loadSessions()
    })
  }
  if (!tickTimer) tickTimer = setInterval(() => { if (!viewEl.hidden) transcript.tick() }, 1000)
  chatClient.start()
  void loadAgents()
  await loadSessions()
  // A handoff may have opened the New session dialog while the list loaded;
  // auto-selecting would close it.
  if (!activeId && !quickSessionPromise && !composer.getDraft().text && order.length && dialogEl.hidden) await selectSession(order[0])
  queueRender()
}

// Leaving the view stops the per-second tick and keeps the draft; the socket
// and its subscriptions stay so a running turn keeps being mirrored and the
// sidebar is current when the view comes back.
export function stopChatRefresh(): void {
  splitPane?.cancelResize()
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (composer && activeId) {
    const e = sessions.get(activeId)
    if (e) e.draft = composer.getDraft()
  }
}
