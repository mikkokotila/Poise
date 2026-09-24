import { createJevWorkspace } from './jev-workspace'
import { parseSwitchCreation, RESERVED_SWITCHES, type ChatSwitches } from '../chat-switches'
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
  MessageQueue,
  QueuedMessage,
  NewSessionRequest,
  SessionContext,
  SessionRecord,
  SessionStatus,
  AgentId,
} from '../../server/chat/protocol'
import { AGENT_LABELS } from '../../server/chat/protocol'
import { chatClient, ChatCommandError, ChatHttpError, type AgentsResponse, type AgentInfo } from '../chat-client'
import { escapeHtml } from '../markdown'
import { recoverDraft } from '../chat-draft-recovery'
import { parseChatCommandChain as parseChain, commandBody } from '../../server/chat/commands'
import { commandDraftText } from '../chat-command-draft'
import { recentMessages } from '../chat-message-history'
import { reconcileSession } from '../chat-session-state'
import { reserveQueuedMessage, releaseQueuedMessage } from '../chat-queue'
import { createQueuePanel } from './chat-queue'
import { createMemoriesPane } from './chat-memories'
import { renderNewSessionDialog } from './chat-new-session'
import {
  createModel, applyEvent, addOptimisticTurn, dropOptimisticTurns, focusedPending, createTranscriptView, pickQuestionOption,
  type TranscriptModel, type TranscriptView,
} from './chat-transcript'
import { createComposer, emptyDraft, type Composer, type ComposerDraft } from './chat-composer'
import { quickSessionRequest, quickSessionModel, consoleModelLabel } from '../chat-catalog'
import { attachChatSidebar } from './chat-sidebar'
import { createFilePreview } from './chat-file-preview'
import { ICON_FORK, ICON_HANDOFF, ICON_ACTIVITY, ICON_AUTO_MERGE, ICON_MEMORIES, ICON_SAFE_MODE, ICON_REASONING } from './chat-icons'
import { createDeployCard, type DeployCard, type LocalPendingChange } from './chat-deploy-card'
import { recognisePoiseRequest } from '../poise-request-intent'
import { parsePoiseCommand, reconcilePendingChanges, releaseChangeId, reserveChangeId, type PoiseCommand } from '../self-update-command'
import { isTerminal, nextPollDelay, POLL_ACTIVE_MS, POLL_IDLE_MS, selectChangeForSession } from '../self-update-state'
import { takeDraftSnapshot, buildDraftSnapshot, saveDraftSnapshot, type DraftSnapshot } from '../self-update-drafts'
import { installSelfUpdateWatch, registerDraftProvider, registerReloadGuard } from '../self-update-watch'
import { BUILD_SHA } from '../build-identity'
import { RELOADED_RELEASE_KEY } from '../self-update-reload'
import type { SelfChange, SelfUpdateStatus } from '../self-update-types'

// The build watch is app-wide (it guards every view), but it has to start
// somewhere main.ts already imports; this module is that place until the
// bootstrap moves into main.ts. Installing twice is a no-op.
installSelfUpdateWatch()

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
let jev: ReturnType<typeof createJevWorkspace>
let beforeJev: string | null = null
let filePreview: ReturnType<typeof createFilePreview>
let memories: ReturnType<typeof createMemoriesPane>
let memorySubmissions = 0
let messageQueue: ReturnType<typeof createQueuePanel>
let queueAddChain: Promise<void> = Promise.resolve()
const pendingQueueItems = new Map<string, { sessionId: string | null, item: QueuedMessage }>()
const queueMutations = new Set<string>()
const modelUpdates = new Map<string | null, Promise<void>>()

const sessions = new Map<string, SessionEntry>()
let order: string[] = []
let activeId: string | null = null
let agentsInfo: AgentsResponse | null = null
let agentsPromise: Promise<AgentsResponse | null> | null = null
let renderQueued = false
let tickTimer: ReturnType<typeof setInterval> | null = null

let splitPane: ReturnType<typeof attachChatSidebar>
let freshDraft: ComposerDraft | null = null
let freshModelIdentity: string | null = null
let quickSessionPromise: Promise<SessionEntry> | null = null
let firstPromptPending = false
const AUTO_MERGE_DRAFT_KEY = 'poise-chat-fresh-auto-merge'
let freshAutoMerge = false
try { freshAutoMerge = sessionStorage.getItem(AUTO_MERGE_DRAFT_KEY) === 'true' } catch { /* optional draft state */ }
const autoMergeUpdates = new Map<string, Promise<boolean>>()
const safeModeUpdates = new Map<string, Promise<boolean>>()
const SAFE_MODE_DRAFT_KEY = 'poise-chat-fresh-safe-mode'
let freshSafeMode = false
try { freshSafeMode = sessionStorage.getItem(SAFE_MODE_DRAFT_KEY) === 'true' } catch { /* optional draft state */ }
function setFreshSafeMode(enabled: boolean): void {
  freshSafeMode = enabled
  try { sessionStorage.setItem(SAFE_MODE_DRAFT_KEY, String(enabled)) } catch { /* in-page choice remains */ }
}

function setFreshAutoMerge(enabled: boolean): void {
  freshAutoMerge = enabled
  try {
    if (enabled) sessionStorage.setItem(AUTO_MERGE_DRAFT_KEY, 'true')
    else sessionStorage.removeItem(AUTO_MERGE_DRAFT_KEY)
  } catch { /* the current draft still keeps the choice */ }
}

// ── Self-improvement state ─────────────────────────────────────────────────
// The deploy card follows the supervisor's status for the session on screen.
// `local` holds a `/poise` request between Enter and the server's ack, so the
// card appears at once; `changeSessions` remembers which sessions a change
// belongs to (its source and its dedicated workspace) from the ack itself,
// so the card shows even before the session record carries the link.
let deployCard: DeployCard
let selfStatus: SelfUpdateStatus | null = null
let selfStatusError: string | null = null
const localChanges = new Map<string, LocalPendingChange>()
const changeSessions = new Map<string, Set<string>>()
const reverting = new Set<string>()
const revertNotes = new Map<string, { text: string, level: 'info' | 'error' }>()
const lastStates = new Map<string, SelfChange['state']>()
let poiseInFlight = false
let selfPollTimer: ReturnType<typeof setTimeout> | null = null
let selfPollDelay = POLL_IDLE_MS
let selfPollSeq = 0
let restoredSnapshot: DraftSnapshot | null = null
/** Where a pending change id is kept between attempts; memory when storage is off. */
const pendingStore = (() => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
})() || (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } } })()
/** A single click waits this long so a double-click renames without opening. */
const CLICK_DELAY_MS = 220
const STICK_TO_BOTTOM_PX = 40
const DELETE_ARM_MS = 4000
const REASONING_KEY = 'poise-chat-show-reasoning'
let showReasoning = false
try { showReasoning = localStorage.getItem(REASONING_KEY) === 'true' } catch { /* optional preference */ }
const ACTIVITY_KEY = 'poise-chat-show-activity'
let showActivity = true
try { showActivity = localStorage.getItem(ACTIVITY_KEY) !== 'false' } catch { /* optional preference */ }

const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_SIDEBAR = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M5 2.5v9" stroke="currentColor" stroke-width="1.2"/></svg>'
const ICON_STOP = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionTitle(s: SessionRecord): string {
  return s.title || 'New session'
}

function statusText(s: SessionRecord): string {
  switch (s.status) {
    case 'starting': return s.cliChecking ? 'checking CLI…' : 'starting…'
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

let savedSwitches: ChatSwitches = { revision: 0, switches: [] }
let switchNames = new Set<string>()
let switchesLoaded = false
let switchesLoading: Promise<void> | null = null
let switchLoadGeneration = 0
let switchSave: Promise<void> | null = null
const pendingSwitchDrafts = new Map<symbol, { origin: string | null, draft: ComposerDraft }>()
const parseChatCommandChain = (text: string) => parseChain(text, switchNames)
function acceptSwitches(catalogue: ChatSwitches): void {
  if (switchesLoaded && catalogue.revision < savedSwitches.revision) return
  savedSwitches = catalogue; switchesLoaded = true
  switchNames = new Set(catalogue.switches.map(item => item.name))
  composer?.setSwitches(catalogue.switches)
}
function loadSwitches(refresh = false): Promise<void> {
  if (switchesLoading) return switchesLoading
  if (switchesLoaded && !refresh) return Promise.resolve()
  const generation = switchLoadGeneration
  const request = chatClient.listSwitches().then(catalogue => {
    if (generation !== switchLoadGeneration) return loadSwitches()
    acceptSwitches(catalogue)
  }, error => {
    if (generation !== switchLoadGeneration) return loadSwitches()
    throw error
  }).finally(() => { if (switchesLoading === request) switchesLoading = null })
  switchesLoading = request
  return request
}

function loadAgents(force = false): Promise<AgentsResponse | null> {
  if (agentsPromise && !force) return agentsPromise
  const request = chatClient.agents().then((a) => { if (agentsPromise === request) { agentsInfo = a; queueRender() }; return a }).catch((err) => {
    console.error('[chat] agents failed:', err)
    return null
  })
  agentsPromise = request
  return request
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
        <button type="button" class="chat-icon-btn chat-new-btn" title="New session" aria-label="New session">${ICON_PLUS}</button>
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
            <div id="chat-transcript" class="chat-transcript"></div>
          </div>
          <div class="chat-dock"></div>
          <div class="chat-new-dialog" role="dialog" aria-modal="true" aria-label="New session" tabindex="-1" hidden></div>
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
  dialogEl.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); return }
    if (event.key === 'Tab') {
      const controls = [...dialogEl.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter(control => control.getClientRects().length > 0 && !control.closest('[hidden], [inert]'))
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); dialogEl.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogEl)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogEl)) { event.preventDefault(); first.focus() }
    }
  })

  viewEl.querySelector<HTMLButtonElement>('.chat-new-btn')!.addEventListener('click', event => {
    // WebKit does not focus a button on pointer click. Remember the actual opener.
    (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true })
    void openNewSessionDialog()
  })

  filePreview = createFilePreview(viewEl, (sessionId, reference) => chatClient.filePreview(sessionId, reference))
  transcript = createTranscriptView(transcriptEl, {
    onFile: (reference) => { if (activeId) void filePreview.show(activeId, reference) },
    onPermission: (id, optionId) => { void respondPermission(id, optionId) },
    onQuestion: (id, answers) => { void answerQuestion(id, answers) },
    onRevert: (diffId) => { void revertDiff(diffId) },
    onLoadDiff: (diffId) => { void loadCompleteDiff(diffId) },
  })
  transcriptEl.addEventListener('chat:rerender', () => queueRender())

  composer = createComposer({
    onJev: () => { openPrimitiveWorkspace() },
    jevAvailable: () => jev?.configured === true,
    history: () => {
      const e = entry()
      return { entries: e ? recentMessages(e.model, e.record.context) : [], loading: !!e?.loading, error: e?.error }
    },
    onSend: (draft) => {
      if (parseChatCommandChain(commandDraftText(draft)).create || parseChatCommandChain(commandDraftText(draft)).context === 'reset') void sendPrompt(draft)
      else void withSavedMemories(draft, () => sendPrompt(draft))
    },
    onQueue: (draft) => { void withSavedMemories(draft, async () => {
      const origin = activeId
      if (!await waitForSwitchSave(draft, origin)) return
      if (activeId !== origin) { restoreDraftTo(origin, draft); return }
      const update = modelUpdates.get(origin)
      if (update) {
        try { await update }
        catch (error) { restoreDraftTo(origin, draft); if (activeId === origin) commandFailed(error, 'Model change'); return }
        if (activeId !== origin) { restoreDraftTo(origin, draft); return }
      }
      queueDraft(draft)
    }) },
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
    onSteer: (draft) => { void withSavedMemories(draft, () => steer(draft)) },
    onStop: () => { void cancelTurn() },
    onResume: () => { void resumeActive() },
    onCommand: (name, arg) => { void withSavedMemories({ ...emptyDraft(), text: arg, mode: name }, () => runOwnCommand(name, arg)) },
    prepareUpload: async () => {
      const origin = activeId
      await modelUpdates.get(origin)
      if (activeId !== origin) throw new Error('The selected conversation changed before the upload started')
      return (await ensureQuickSession()).record.id
    },
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
  messageQueue = createQueuePanel({
    onModel: (id, itemId, model) => { void changeQueueItem(id, itemId, model) },
    onRemove: (id, itemId) => { void changeQueueItem(id, itemId) },
  })
  dockEl.append(messageQueue.el, composer.history.el, composer.models.el, composer.el)
  composer.el.addEventListener('chat:composer-change', queueRender)
  composer.el.addEventListener('input', () => persistDrafts())
  // After the transcript, inside the same scroll, outside the activity toggle.
  deployCard = createDeployCard(scrollEl, { onRevert: (changeId, releaseId) => { void revertChange(changeId, releaseId) } })
  const layoutObserver = new ResizeObserver(() => queueRender())
  layoutObserver.observe(mainEl)
  layoutObserver.observe(dockEl)

  memories = createMemoriesPane(viewEl, queueRender)
  viewEl.querySelector('.chat-layout')!.append(memories.el)
  splitPane = attachChatSidebar(viewEl, () => { composer.layout(); queueRender() })
  memories.mount()
  jev = createJevWorkspace(mainEl, viewEl.querySelector<HTMLElement>('.chat-sidebar')!, {
    activate(id) {
      if (!activeId?.startsWith('jev:')) {
        beforeJev = activeId
        const previous = entry()
        if (previous) previous.draft = composer.getDraft()
        else freshDraft = composer.getDraft()
      }
      activeId = `jev:${id}`
      composer.history.close(); composer.models.close(); filePreview.close()
      mainEl.classList.add('jev-mode'); mainEl.classList.remove('chat-empty-session')
      queueRender()
    },
    close() {
      mainEl.classList.remove('jev-mode')
      if (beforeJev && sessions.has(beforeJev)) void selectSession(beforeJev)
      else { activeId = null; composer.setDraft(freshDraft); composerStateFor(null); queueRender() }
    },
    memories() { memories.toggle() },
    async flushMemories() { await memories.editor.flush() },
  })
  attachSidebar()
  attachHeader()
  attachKeys()
  attachReloadGuards()
}

// ── Safe-reload cooperation ────────────────────────────────────────────────
// What this view cannot carry across a reload, and what it can. Drafts are
// serialisable and go into the snapshot; everything listed as a blocker is
// not, so the build watch waits for it.

function attachReloadGuards(): void {
  registerReloadGuard(() => {
    const blockers: string[] = []
    if (memories.editor.state.dirty) blockers.push('unsaved:memories')
    if (memories.editor.state.saving || memorySubmissions) blockers.push('saving:memories')
    if (chatClient.pendingCount() > 0 || modelUpdates.size || pendingSwitchDrafts.size) blockers.push('command')
    if (composer.isUploading()) blockers.push('upload')
    if (quickSessionPromise || firstPromptPending) blockers.push('session-create')
    for (const e of sessions.values()) if (e.pending) { blockers.push('session-create'); break }
    const active = entry()
    if (active && (focusedPending(active.model) || (active.record.pendingRequests?.length || 0) > 0)) blockers.push('pending-request')
    if (poiseInFlight || localChanges.size) blockers.push('poise-change')
    if (reverting.size || pendingQueueItems.size || queueMutations.size) blockers.push('command')
    return blockers
  })
  registerDraftProvider(captureDrafts)
  window.addEventListener('pagehide', () => persistDrafts(true))
  window.addEventListener('beforeunload', () => persistDrafts(true))
}

function captureDrafts() {
  const drafts = new Map<string, ComposerDraft | null>()
  for (const [id, e] of sessions) drafts.set(id, id === activeId ? composer.getDraft() : e.draft)
  let fresh = activeId ? freshDraft : composer.getDraft()
  // A refresh during the catalogue read/save must not lose a cleared definition.
  // Restore intent as a draft only; an uncertain save is never replayed on load.
  for (const { origin, draft } of [...pendingSwitchDrafts.values()].reverse()) {
    if (origin && drafts.has(origin)) drafts.set(origin, recoverDraft(draft, drafts.get(origin)))
    else fresh = recoverDraft(draft, fresh)
  }
  return {
    fromSha: BUILD_SHA, activeSessionId: activeId?.startsWith('jev:') ? beforeJev : activeId,
    fresh: { draft: fresh, modelIdentity: freshModelIdentity, modelSelection: freshModelIdentity ? 'explicit' as const : 'automatic' as const }, sessions: [...drafts],
  }
}

let savedDraftFingerprint = ''
/** Ordinary refresh and tab restoration deserve the same protection as an update. */
function persistDrafts(force = false): void {
  if (!composer || restoredSnapshot) return
  const snapshot = buildDraftSnapshot(captureDrafts())
  const fingerprint = JSON.stringify({ ...snapshot, savedAt: 0 })
  if (!force && fingerprint === savedDraftFingerprint) return
  try {
    if (saveDraftSnapshot(sessionStorage, snapshot)) savedDraftFingerprint = fingerprint
  } catch { /* private mode: the in-page drafts and update guards still work */ }
}

/** Put a consumed snapshot back where it came from, once the session list is known. */
function applyRestoredSnapshot(): void {
  const snap = restoredSnapshot
  if (!snap) return
  restoredSnapshot = null
  for (const [id, draft] of Object.entries(snap.sessions)) {
    const e = sessions.get(id)
    if (e) e.draft = { text: draft.text, attachments: draft.attachments, mentions: draft.mentions, mode: draft.mode, ...(draft.model ? { model: draft.model } : {}) }
  }
  // Older builds wrote their fixed Opus 5 High default as if it were a choice.
  // New snapshots distinguish automatic defaults from explicit model selections.
  if (snap.fresh.modelIdentity) freshModelIdentity = !snap.fresh.modelSelection && snap.fresh.modelIdentity === 'opus-5-high'
    ? null : snap.fresh.modelIdentity
  if (snap.fresh.draft) freshDraft = { text: snap.fresh.draft.text, attachments: snap.fresh.draft.attachments, mentions: snap.fresh.draft.mentions, mode: snap.fresh.draft.mode, ...(snap.fresh.draft.model ? { model: snap.fresh.draft.model } : {}) }
  if (!activeId && freshDraft) composer.setDraft(freshDraft)
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
    e.record = reconcileSession(e.record, record)
    if (opts.pending !== undefined) e.pending = opts.pending
  }
  applyResetRecord(e, e.record)
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
    if (ev.isComposing || ev.keyCode === 229) return
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
      composer.setDraft(freshDraft)
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

async function selectSession(id: string, restoring = false): Promise<void> {
  if (!restoring) jev?.leave(); mainEl?.classList.remove('jev-mode')
  const e = sessions.get(id)
  if (!e) return
  if (!activeId) freshDraft = composer.getDraft()
  if (activeId && activeId !== id) {
    const prev = sessions.get(activeId)
    if (prev) prev.draft = composer.getDraft()
  }
  const switching = activeId !== id
  if (switching) filePreview.close()
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
  if (switching) scheduleSelfPoll(0)
  if (!e.loaded && !e.loading && !e.pending) await loadHistory(e)
  if (activeId === id && !viewEl.hidden && !memories.el.contains(document.activeElement)) composer.focus()
}

async function loadHistory(e: SessionEntry): Promise<void> {
  e.loading = true
  queueRender()
  try {
    let after = chatClient.subscribedAfter(e.record.id) ?? 0
    for (let guard = 0; guard < 100; guard++) {
      const page = await chatClient.fetchSession(e.record.id, after)
      e.record = reconcileSession(e.record, page.session)
      applyResetRecord(e, e.record)
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
  if (ev.type === 'session.reset') {
    upsertRecord({ ...ev.session, lastSeq: env.seq }, { pending: false })
    applyResetRecord(e, ev.session)
  } else if (ev.type === 'session.created' || ev.type === 'session.resumed' || ev.type === 'session.updated') {
    upsertRecord({ ...ev.session, lastSeq: env.seq }, { pending: false })
  } else if (ev.type === 'status.changed') {
    e.record = { ...e.record, status: ev.status, queuedBehind: ev.queuedBehind }
  } else if (ev.type === 'queue.updated') {
    acceptQueue(e, ev.queue)
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

/** Flush memories before dispatch; a failure preserves the submitted draft. */
async function withSavedMemories(draft: ComposerDraft, dispatch: () => void | Promise<void>): Promise<void> {
  if (!memories.editor.state.dirty && !memories.editor.state.saving) { await dispatch(); return }
  const origin = activeId
  memorySubmissions++
  try {
    await memories.editor.flush()
    if (origin !== activeId) throw new Error('The selected session changed while memories were saving.')
    await dispatch()
  } catch (error) {
    const target = origin ? sessions.get(origin) : null
    restoreDraftTo(origin, draft)
    if (origin === activeId) setNotice(`Message not sent — ${(error as Error).message}`)
    else if (target) target.error = `Message not sent — ${(error as Error).message}`
  } finally { memorySubmissions--; queueRender() }
}

function restoreDraftTo(sessionId: string | null, draft: ComposerDraft): void {
  const target = sessionId ? sessions.get(sessionId) : null
  if (activeId === sessionId) composer.setDraft(recoverDraft(draft, composer.getDraft()))
  else if (target) target.draft = recoverDraft(draft, target.draft)
  else freshDraft = recoverDraft(draft, freshDraft)
}

function commandFailed(err: unknown, what: string): void {
  const code = err instanceof ChatCommandError ? err.code : undefined
  const message = (err as Error).message || String(err)
  setNotice(`${what} failed${code ? ` (${code})` : ''} — ${message}`)
}

/** One user action creates one session; neither focus nor typing launches an agent. */
function ensureQuickSession(firstPrompt?: ComposerDraft, title?: string, deferStart = false, modelOverride?: string): Promise<SessionEntry> {
  if (quickSessionPromise) return quickSessionPromise
  const current = entry()
  if (current && !current.pending) return Promise.resolve(current)
  if (current) return Promise.reject(new Error('The session is still being created.'))
  const draft = firstPrompt || deferStart ? null : composer.getDraft()
  const selectedModel = modelOverride || firstPrompt?.model || parseChatCommandChain(firstPrompt?.text || '').model || draft?.model || parseChatCommandChain(draft?.text || '').model || freshModelIdentity
  const selectedAutoMerge = freshAutoMerge
  const selectedSafeMode = freshSafeMode
  quickSessionPromise = (async () => {
    const catalogue = await loadAgents(true)
    if (!catalogue) throw new Error('Could not load the model catalogue. Your message has not been sent.')
    const request = quickSessionRequest(catalogue.agents, selectedModel)
    if (selectedAutoMerge) request.autoMerge = true
    request.safeMode = selectedSafeMode
    if (deferStart) request.deferStart = true
    if (firstPrompt?.text) request.title = firstPrompt.text.slice(0, 200)
    else if (title) request.title = title.slice(0, 200)
    const created = await createSessionEntry(request, draft, firstPrompt, null)
    freshModelIdentity = null
    setFreshAutoMerge(false)
    setFreshSafeMode(false)
    return created
  })().finally(() => { quickSessionPromise = null; queueRender() })
  queueRender()
  return quickSessionPromise
}

// ── Deferred messages ─────────────────────────────────────────────────────

function acceptQueue(e: SessionEntry, queue: MessageQueue): void {
  if (queue.revision >= (e.record.queue?.revision ?? -1)) e.record = { ...e.record, queue }
}

async function queueDraft(draft: ComposerDraft): Promise<void> {
  const origin = activeId
  const setting = modelUpdates.get(origin)
  try {
    if (setting) await setting
    for (const update of origin ? [safeModeUpdates.get(origin), autoMergeUpdates.get(origin)] : []) {
      if (update && !await update) throw new Error('The session setting was not saved')
    }
    if (activeId !== origin) { restoreDraftTo(origin, draft); return }
  } catch (error) {
    restoreDraftTo(origin, draft)
    if (activeId === origin) commandFailed(error, 'Queue setting')
    queueRender(); return
  }
  const source = entry()
  const chain = parseChatCommandChain(draft.text)
  const requestedModel = draft.model || chain.model || source?.record.model || freshModelIdentity
  const model = requestedModel || quickSessionModel(agentsInfo?.agents || [])?.identity || ''
  const agent = agentsInfo?.agents.find(agent => agent.models.some(option => option.identity === model))
  const effort = agent?.models.find(option => option.identity === model)?.effort || ''
  const id = crypto.randomUUID()
  const pending = { sessionId: source?.record.id ?? null, item: {
    id, prompt: { text: commandBody(chain), attachments: draft.attachments, mentions: draft.mentions },
    agent: (agent?.id as AgentId) || source?.record.agent || 'claude', model,
    effort, state: 'waiting', createdAt: new Date().toISOString(),
  } as QueuedMessage }
  pendingQueueItems.set(id, pending)
  // Create idle session storage for a fresh queue, but do not start a native
  // agent or send any prompt. Every queued submission shares that creation.
  const target = source && !source.pending ? Promise.resolve(source) : ensureQuickSession(undefined, undefined, true, requestedModel || undefined)
  // Install a handler immediately so a failed creation cannot be unhandled
  // while an earlier queue acknowledgement is still outstanding.
  const captured = target.then(value => ({ value }), error => ({ error }))
  queueAddChain = queueAddChain.then(async () => {
    const result = await captured
    if ('error' in result) throw result.error
    const e = result.value
    pending.sessionId = e.record.id
    const prompt = pending.item.prompt
    if (!requestedModel) { pending.item.model = e.record.model; pending.item.effort = e.record.effort }
    const receipt = reserveQueuedMessage(pendingStore, e.record.id, prompt, pending.item.model, pending.item.effort, id)
    if (receipt.id !== id) { pendingQueueItems.delete(id); pending.item.id = receipt.id; pendingQueueItems.set(receipt.id, pending) }
    if (!agent) pending.item.agent = e.record.agent
    queueRender()
    try {
      const queue = await chatClient.queueCommand({ type: 'queue.add', sessionId: e.record.id, itemId: receipt.id,
        ...receipt.prompt, model: receipt.model, ...(receipt.effort ? { effort: receipt.effort } : {}) })
      acceptQueue(e, queue)
      releaseQueuedMessage(pendingStore, receipt.id)
      if (activeId === e.record.id) setNotice(null)
    } catch (error) {
      if (error instanceof ChatCommandError && error.code !== 'command_in_doubt') releaseQueuedMessage(pendingStore, receipt.id)
      throw error
    } finally {
      pendingQueueItems.delete(receipt.id)
    }
  }).catch(error => {
    pendingQueueItems.delete(id)
    const origin = pending.sessionId ? sessions.get(pending.sessionId) : null
    const message = `Queue failed — ${(error as Error).message}`
    if (activeId === pending.sessionId || (!activeId && !source)) setNotice(message)
    else if (origin) origin.error = message
    const current = activeId === pending.sessionId || (!activeId && !source) ? composer.getDraft() : origin?.draft
    if (!current?.text && !current?.attachments.length) {
      if (activeId === pending.sessionId || (!activeId && !source)) composer.setDraft(draft)
      else if (origin) origin.draft = draft
      else freshDraft = draft
    } else {
      // A newer draft must not be overwritten. Keep the unsent text visibly
      // in the queue panel until the user removes it or copies it for retry.
      pending.item = { ...pending.item, state: 'failed', error: message }
      pendingQueueItems.set(pending.item.id, pending)
    }
  }).finally(() => queueRender())
  queueRender()
}

async function changeQueueItem(sessionId: string, itemId: string, model?: string): Promise<void> {
  const e = sessions.get(sessionId)
  if (!e || queueMutations.has(itemId)) return
  const local = pendingQueueItems.get(itemId)
  if (local?.item.state === 'failed' && !model) { pendingQueueItems.delete(itemId); queueRender(); return }
  queueMutations.add(itemId)
  queueRender()
  try {
    const command = model
      ? { type: 'queue.update' as const, sessionId, itemId, model }
      : { type: 'queue.remove' as const, sessionId, itemId }
    acceptQueue(e, await chatClient.queueCommand(command))
    if (activeId === sessionId) setNotice(null)
  } catch (error) {
    if (activeId === sessionId) commandFailed(error, 'Queue update')
    else e.error = `Queue update failed — ${(error as Error).message}`
  } finally { queueMutations.delete(itemId); queueRender() }
}

function renderQueue(): void {
  const e = entry()
  const queue = e?.record.queue || { revision: 0, ready: false, items: [] }
  const items = queue.items.slice()
  const pendingIds = new Set(queueMutations)
  for (const [id, pending] of pendingQueueItems) {
    if (pending.sessionId !== activeId && !(pending.sessionId === null && (!e || e.pending))) continue
    if (!items.some(item => item.id === id)) items.push(pending.item)
    if (pending.item.state !== 'failed') pendingIds.add(id)
  }
  messageQueue.render(activeId, { ...queue, items }, agentsInfo?.agents || [], !!e && (isRunning(e.record.status) || !!e.model.running), pendingIds)
}

// ── Poise self-change ──────────────────────────────────────────────────────

/** Put a request that did not start back where the person can edit it. */
function keepDraft(sessionId: string | null, draft: ComposerDraft): void {
  restoreDraftTo(sessionId, draft)
}

/** `/poise <request>`: one explicit command, one change id, one dedicated
 *  session. The source session gets no ordinary prompt — the request travels
 *  inside the command and the server injects it into the new session's first
 *  turn — so nothing is ever sent twice. */
async function startPoiseChange(cmd: PoiseCommand, draft: ComposerDraft): Promise<void> {
  // The composer clears itself right after handing over the draft; anything
  // put back synchronously would be wiped, so give it that turn first.
  await Promise.resolve()
  if (!cmd.request) {
    setNotice('Type the change after /poise — for example: /poise Add a Stop button to the Swarm header', 'info')
    keepDraft(activeId, draft)
    return
  }
  if (poiseInFlight) {
    setNotice('A Poise change is already being started; wait for it to be acknowledged.', 'info')
    keepDraft(activeId, draft)
    return
  }
  poiseInFlight = true
  let source: SessionEntry | null = null
  let changeId: string | null = null
  try {
    source = entry()
    if (!source || source.pending) {
      // A fresh console needs an ordinary local session on the chosen model
      // to be the source; it receives no prompt.
      firstPromptPending = true
      try { source = await ensureQuickSession(undefined, `Poise: ${cmd.request}`, false, draft.model || parseChatCommandChain(draft.text).model) } finally { firstPromptPending = false }
      freshDraft = null
    }
    const sessionId = source.record.id
    const names = parseChatCommandChain(commandDraftText(draft)).switches
    const context = { attachments: draft.attachments, mentions: draft.mentions, ...(names?.length ? { switches: names } : {}) }
    const contextKey = context.attachments.length || context.mentions.length || context.switches?.length ? JSON.stringify(context) : ''
    changeId = reserveChangeId(pendingStore, sessionId, cmd.request, Date.now(), contextKey)
    localChanges.set(sessionId, { id: changeId, request: cmd.request, sessionId, startedAt: Date.now() })
    setNotice(null)
    queueRender()
    const ack = await chatClient.startPoiseChange(sessionId, cmd.request, changeId, context)
    releaseChangeId(pendingStore, changeId)
    localChanges.delete(sessionId)
    rememberChange(ack.change, [sessionId, ack.session.id])
    mergeChange(ack.change)
    upsertRecord(ack.session, { pending: false })
    if (activeId === sessionId) await selectSession(ack.session.id)
    scheduleSelfPoll(POLL_ACTIVE_MS)
  } catch (err) {
    if (source) localChanges.delete(source.record.id)
    const code = err instanceof ChatCommandError ? err.code : err instanceof ChatHttpError ? err.code : undefined
    const message = (err as Error).message || String(err)
    if (code === 'command_in_doubt') {
      // The reserved id stays: resending the same request replays it.
      setNotice(`Poise change not acknowledged — ${message} If no new session appears, send the same request again; it reuses the same change id.`)
    } else {
      if (changeId) releaseChangeId(pendingStore, changeId)
      const why = code === 'self_update_unavailable' ? `Poise self-updates are not set up on this server — ${message}`
        : code === 'draining' ? `Poise is installing an update and refuses new work until it restarts — ${message}`
        : `Poise change not started${code ? ` (${code})` : ''} — ${message}`
      setNotice(`${why} Your request is still in the composer; nothing was sent to a model.`)
    }
    keepDraft(source?.record.id ?? null, draft)
    queueRender()
  } finally {
    poiseInFlight = false
    queueRender()
  }
}

function rememberChange(change: SelfChange, sessionIds: string[]): void {
  let set = changeSessions.get(change.id)
  if (!set) { set = new Set(); changeSessions.set(change.id, set) }
  for (const id of sessionIds) set.add(id)
  if (change.sessionId) set.add(change.sessionId)
}

/** Fold one change record into the last status without waiting for a poll. */
function mergeChange(change: SelfChange): void {
  const base: SelfUpdateStatus = selfStatus || { enabled: true, available: true, activeRelease: null, previousRelease: null, hold: null, changes: [] }
  const changes = base.changes.filter((c) => c.id !== change.id)
  changes.push(change)
  selfStatus = { ...base, changes }
}

function linkedChangeIds(sessionId: string | null): Set<string> {
  const ids = new Set<string>()
  if (!sessionId) return ids
  for (const [changeId, set] of changeSessions) if (set.has(sessionId)) ids.add(changeId)
  const local = localChanges.get(sessionId)
  if (local) ids.add(local.id)
  return ids
}

function activeChange(): SelfChange | null {
  const e = entry()
  if (!e || !selfStatus) return null
  return selectChangeForSession(selfStatus.changes, e.record.id, e.record.selfChangeId, linkedChangeIds(e.record.id))
}

function scheduleSelfPoll(delay: number): void {
  if (selfPollTimer) clearTimeout(selfPollTimer)
  selfPollTimer = setTimeout(() => { selfPollTimer = null; void pollSelfStatus() }, delay)
}

/** Ask the status endpoint for the session on screen. Independent of the
 *  agent: a change keeps being followed after its session went quiet. */
async function pollSelfStatus(): Promise<void> {
  if (!viewEl || viewEl.hidden) return
  const e = entry()
  if (!e || e.pending) { scheduleSelfPoll(POLL_IDLE_MS); return }
  const seq = ++selfPollSeq
  const sessionId = e.record.id
  let failed = false
  let available = false
  try {
    const status = await chatClient.selfUpdateStatus(sessionId)
    if (seq !== selfPollSeq) return
    selfStatusError = null
    if (status) {
      available = status.available
      // Keep changes this page learned from acks that a filtered answer omits.
      const known = (selfStatus?.changes || []).filter((c) => linkedChangeIds(sessionId).has(c.id) && !status.changes.some((s) => s.id === c.id))
      selfStatus = { ...status, changes: [...status.changes, ...known] }
      let promoted = false
      for (const c of status.changes) {
        rememberChange(c, [])
        const before = lastStates.get(c.id)
        if (before && before !== c.state && (c.state === 'live' || c.state === 'reverted')) promoted = true
        lastStates.set(c.id, c.state)
      }
      // A promotion or rollback just changed the served build: let the build
      // watch see it now rather than at its next interval.
      if (promoted) void installSelfUpdateWatch().poll()
      // Ids the server lists are held durably there; a retry from here would
      // only be answered from its receipt.
      reconcilePendingChanges(pendingStore, status.changes.map((c) => c.id))
    } else if (selfStatus && !linkedChangeIds(sessionId).size) {
      selfStatus = null
    }
  } catch (err) {
    if (seq !== selfPollSeq) return
    failed = true
    selfStatusError = `Could not read the update status — ${(err as Error).message}`
  }
  const change = activeChange()
  // A moving change, or a running turn that may still turn into one, keeps
  // the fast cadence; the endpoint is a local socket read.
  const moving = (!!change && !isTerminal(change.state)) || (!!selfStatus?.enabled && available && isRunning(e.record.status))
  selfPollDelay = nextPollDelay({ available, failed, moving, previous: selfPollDelay })
  scheduleSelfPoll(selfPollDelay)
  queueRender()
}

/** One click, one POST bound to the exact release; no confirmation dialog.
 *  The server deduplicates by change, so an uncertain answer is reported and
 *  never repeated blindly. */
async function revertChange(changeId: string, expectedReleaseId: string): Promise<void> {
  if (reverting.has(changeId)) return
  reverting.add(changeId)
  revertNotes.delete(changeId)
  queueRender()
  try {
    const change = await chatClient.revertSelfChange(changeId, expectedReleaseId)
    mergeChange(change)
    rememberChange(change, [])
    revertNotes.set(changeId, { text: 'Revert requested; the previous release is being restored.', level: 'info' })
  } catch (err) {
    const message = (err as Error).message || String(err)
    const uncertain = !(err instanceof ChatHttpError)
    revertNotes.set(changeId, {
      text: uncertain ? `Revert request did not get an answer — ${message}. The status below will show whether it went through.` : `Revert refused — ${message}`,
      level: 'error',
    })
  } finally {
    reverting.delete(changeId)
    scheduleSelfPoll(0)
    queueRender()
  }
}

function renderDeployCard(): void {
  const e = entry()
  const change = activeChange()
  const local = e ? localChanges.get(e.record.id) || null : null
  const showLocal = local && !change ? local : null
  deployCard.render({
    status: selfStatus,
    change,
    local: showLocal,
    browserSha: BUILD_SHA,
    reverting: !!change && reverting.has(change.id),
    revertNote: change ? revertNotes.get(change.id) || null : null,
    statusError: change ? selfStatusError : null,
  })
}

function applyCommandModel(identity: string, origin: string | null, effort?: string): Promise<void> {
  return trackSettingUpdate(origin, () => applyCommandModelNow(identity, origin, effort))
}

function trackSettingUpdate(origin: string | null, operation: () => Promise<void>, ordered = true): Promise<void> {
  const previous = ordered ? modelUpdates.get(origin) : undefined
  const update = previous ? previous.then(operation, operation) : operation()
  modelUpdates.set(origin, update)
  void update.finally(() => { if (modelUpdates.get(origin) === update) modelUpdates.delete(origin); queueRender() }).catch(() => undefined)
  return update
}

async function applyCommandModelNow(identity: string, origin: string | null, effort?: string): Promise<void> {
  if (!origin) {
    const catalogue = await loadAgents(true)
    if (!catalogue) throw new Error('Could not load the model catalogue')
    quickSessionRequest(catalogue.agents, identity)
    if (activeId !== null) throw new Error('The selected conversation changed before the model was chosen')
    freshModelIdentity = identity; composerStateFor(null); queueRender()
    return
  }
  const result = await chatClient.send({ type: 'set_model', sessionId: origin, model: identity, ...(effort ? { effort } : {}) }) as { session?: SessionRecord } | undefined
  if (result?.session?.id !== origin) throw new Error('The server did not confirm the selected model')
  const current = sessions.get(origin)
  if (current && result.session.lastSeq >= current.record.lastSeq) upsertRecord(result.session)
  queueRender()
}

async function createSavedSwitch(draft: ComposerDraft, origin: string | null): Promise<void> {
  const token = Symbol('switch-save')
  pendingSwitchDrafts.set(token, { origin, draft })
  const previous = switchSave
  const task = (async () => {
    await previous?.catch(() => undefined)
    const chain = parseChatCommandChain(commandDraftText(draft))
    if (chain.model || chain.queue || chain.review || chain.context || chain.switches?.length) throw new Error('Use /create /name instructions on its own. The definition is saved without starting a task.')
    if (draft.attachments.length || draft.mentions.length) throw new Error('A saved switch contains text. Paste its instructions into the console; attached files have been kept in your draft.')
    const definition = parseSwitchCreation(commandDraftText(draft))
    await loadSwitches()
    const revision = savedSwitches.switches.find(item => item.name === definition.name)?.revision ?? 0
    acceptSwitches(await chatClient.createSwitch({ ...definition, revision }))
    if (activeId === origin) setNotice(`${revision ? 'Updated' : 'Saved'} /${definition.name}. Use it in any chat.`, 'info')
  })()
  switchSave = task
  try { await task }
  catch (error) {
    pendingSwitchDrafts.delete(token)
    restoreDraftTo(origin, draft)
    if (activeId === origin) commandFailed(error, 'Save switch')
    // A conflict response leaves the definition untouched. Refresh the palette,
    // but retain the person's exact text for a deliberate subsequent edit.
    void loadSwitches(true).catch(() => undefined)
  } finally { pendingSwitchDrafts.delete(token); if (switchSave === task) switchSave = null; queueRender() }
}

async function waitForSwitchSave(draft: ComposerDraft, origin: string | null): Promise<boolean> {
  const token = Symbol('switch-message')
  const waiting = !!switchSave || (!switchesLoaded && /^\s*\//.test(commandDraftText(draft)))
  if (waiting) pendingSwitchDrafts.set(token, { origin, draft })
  try {
    await switchSave
    const text = commandDraftText(draft)
    if (!switchesLoaded && /^\s*\//.test(text)) {
      try { await loadSwitches() }
      catch (error) {
        const remaining = parseChain(text).text
        const name = /^\/([a-z][a-z0-9_-]*)/i.exec(remaining)?.[1]?.toLowerCase()
        const native = entry(origin)?.record.commands?.some(command => command.name.replace(/^\//, '').toLowerCase() === name)
        if (name && !RESERVED_SWITCHES.has(name) && !native) throw error
      }
    }
    return true
  }
  catch (error) { pendingSwitchDrafts.delete(token); restoreDraftTo(origin, draft); if (activeId === origin) commandFailed(error, 'Saved switches'); return false }
  finally { if (pendingSwitchDrafts.delete(token)) queueRender() }
}

async function resetPrompt(draft: ComposerDraft, origin: string | null): Promise<void> {
  const chain = parseChatCommandChain(commandDraftText(draft))
  if (chain.review) { restoreDraftTo(origin, draft); setNotice('A reset removes the reply to review. Review first or start a new task after resetting.'); return }
  let remaining = draft
  const resetBefore = entry(origin)?.record.contextResetSeq || 0
  let resetAcknowledged = false
  try {
    if (origin) await trackSettingUpdate(origin, async () => {
      const result = await chatClient.send({ type: 'context.reset', sessionId: origin }) as { session?: SessionRecord }
      if (result?.session?.id !== origin || !result.session.contextResetSeq) throw new Error('The server did not confirm the reset; check this chat before repeating it.')
      upsertRecord(result.session)
      applyResetRecord(sessions.get(origin)!, result.session)
    }, false)
    resetAcknowledged = true
    remaining = { ...draft, text: [...(chain.switches || []).map(name => `/${name}`), chain.text].filter(Boolean).join(' '), mode: null, ...(chain.model ? { model: chain.model } : {}) }
    if (activeId !== origin) { if (remaining.text || remaining.attachments.length) restoreDraftTo(origin, remaining); return }
    if (chain.model) await applyCommandModel(chain.model, origin)
    setNotice('Chat reset. Previous conversation context cleared.', 'info')
    if (remaining.text || remaining.attachments.length) await withSavedMemories(remaining, () => sendPrompt(remaining))
  } catch (error) {
    if (resetAcknowledged || (entry(origin)?.record.contextResetSeq || 0) > resetBefore) {
      // The durable reset event can beat a lost acknowledgement. Never put
      // /reset back into the editor where it could erase subsequent work.
      remaining = { ...draft, text: [...(chain.switches || []).map(name => `/${name}`), chain.text].filter(Boolean).join(' '), mode: null, ...(chain.model ? { model: chain.model } : {}) }
      if (remaining.text || remaining.attachments.length || remaining.model) restoreDraftTo(origin, remaining)
      if (activeId === origin) setNotice(resetAcknowledged ? `Chat was reset. The follow-up was not sent — ${(error as Error).message}` : 'Chat reset was recorded. Its acknowledgement was unavailable; any follow-up remains unsent.', 'info')
    } else {
      restoreDraftTo(origin, remaining)
      if (activeId === origin) commandFailed(error, 'Reset')
    }
  } finally { queueRender() }
}

function applyResetRecord(e: SessionEntry, record: SessionRecord): void {
  const seq = record.contextResetSeq || 0
  if (seq <= (e.model.resetSeq || 0)) return
  applyEvent(e.model, { sessionId: record.id, seq, at: record.updatedAt, event: { type: 'session.reset', session: record } })
  e.error = null
  if (activeId === record.id) {
    transcript.clear()
    composer.history.close(); composer.models.close(); filePreview.close()
    setNotice('Chat reset. Previous conversation context cleared.', 'info')
    scrollToBottom(true)
  }
}

async function sendPrompt(draft: ComposerDraft): Promise<void> {
  const origin = activeId
  await Promise.resolve() // The composer clears after passing us the immutable draft.
  if (activeId !== origin) { restoreDraftTo(origin, draft); return }
  draft = { ...draft, text: commandDraftText(draft) }
  if (parseChatCommandChain(draft.text).create) { await createSavedSwitch(draft, origin); return }
  if (!await waitForSwitchSave(draft, origin)) return
  if (activeId !== origin) { restoreDraftTo(origin, draft); return }
  if (parseChatCommandChain(draft.text).create) { await createSavedSwitch(draft, origin); return }
  if (parseChatCommandChain(draft.text).context === 'reset') { await resetPrompt(draft, origin); return }
  const pendingModel = modelUpdates.get(origin)
  if (pendingModel) {
    try { await pendingModel }
    catch (error) { restoreDraftTo(origin, draft); if (activeId === origin) commandFailed(error, 'Model change'); return }
    if (activeId !== origin) { restoreDraftTo(origin, draft); return }
  }
  const chain = parseChatCommandChain(draft.text)
  if (chain.missingModel) { restoreDraftTo(origin, draft); setNotice('Choose a model from /model first.'); return }
  if (chain.review && !entry()) { restoreDraftTo(origin, draft); setNotice('There is no reply to review yet.'); return }
  if (chain.context === 'compact' && !entry() && !chain.review && !chain.text && !chain.switches?.length && !draft.attachments.length) {
    try {
      if (chain.model) await applyCommandModel(chain.model, origin)
      if (activeId === origin) setNotice('No conversation history to compact yet.', 'info')
    } catch (error) { restoreDraftTo(origin, draft); if (activeId === origin) commandFailed(error, 'Model choice') }
    return
  }
  const own = !chain.switches?.length && !chain.review && /^\/(mode|fork)(?:\s+(.*))?$/s.exec(chain.text)
  if ((chain.model && !chain.text && !chain.switches?.length && !chain.review && !chain.context && !draft.attachments.length) || (own && !chain.context)) {
    try {
      if (chain.model) await applyCommandModel(chain.model, origin)
      if (activeId !== origin) { restoreDraftTo(origin, draft); return }
      if (own) {
        if (!origin) throw new Error('Start a conversation before using this command')
        if (own[1] === 'mode') await trackSettingUpdate(origin, async () => { await chatClient.send({ type: 'set_mode', sessionId: origin, mode: own[2]?.trim() || '' }) })
        else {
          const result = await chatClient.forkSession(origin)
          upsertRecord(result.session)
          if (activeId === origin) await selectSession(result.session.id)
        }
      }
      if (activeId === origin) setNotice(null)
    } catch (error) { restoreDraftTo(origin, draft); if (activeId === origin) commandFailed(error, 'Command') }
    queueRender(); return
  }
  const beforeQueue = activeId
  if (pendingQueueItems.size) {
    await queueAddChain
    if (beforeQueue && activeId !== beforeQueue) { keepDraft(beforeQueue, draft); return }
  }
  const sourceId = activeId
  const permissionUpdate = sourceId ? safeModeUpdates.get(sourceId) : null
  if (permissionUpdate) {
    const saved = await permissionUpdate
    if (!saved || activeId !== sourceId) { keepDraft(sourceId, draft); return }
  }
  const modeUpdate = sourceId ? autoMergeUpdates.get(sourceId) : null
  if (modeUpdate) {
    const saved = await modeUpdate
    if (!saved || activeId !== sourceId) { keepDraft(sourceId, draft); return }
  }
  const current = entry()?.record
  const explicit = chain.review || chain.context ? null : parsePoiseCommand(chain.text)
  // A batch stays with its agent even when it includes Poise. Only the
  // explicit command selects the independent one-change release controller.
  const autoMerge = current ? current.autoMerge === true : freshAutoMerge
  const natural = explicit || autoMerge || chain.review || chain.context ? null : recognisePoiseRequest(chain.text, { poiseChangeSession: current?.workspaceKind === 'poise-change' })
  // Vocabulary alone must not reinterpret work on another repository as a
  // Poise request. An explicit Poise target still means what the user wrote.
  const otherRepository = !!current?.repo && current.repo.toLowerCase() !== 'mikkokotila/poise'
  const poise = explicit || (natural && (!otherRepository || natural.cue === 'explicit') ? natural : null)
  if (poise) {
    if (chain.model && sourceId) {
      try { await applyCommandModel(chain.model, sourceId) }
      catch (error) { restoreDraftTo(sourceId, draft); if (activeId === sourceId) commandFailed(error, 'Model change'); return }
      if (activeId !== sourceId) { restoreDraftTo(sourceId, draft); return }
    }
    await startPoiseChange(poise, draft); return
  }
  let e = entry()
  if (!e || e.pending) {
    if (firstPromptPending) {
      // Two Send actions can be released by one Memories save before the
      // first session exists. Only the first may launch it; keep the other
      // draft with that session instead of silently dropping its text.
      const startup = quickSessionPromise
      try {
        const target = startup ? await startup : e
        restoreDraftTo(target?.record.id ?? sourceId, draft)
      } catch { restoreDraftTo(sourceId, draft) }
      queueRender()
      return
    }
    firstPromptPending = true
    try {
      e = await ensureQuickSession(draft)
      freshDraft = null
    } catch (err) {
      restoreDraftTo(null, draft)
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
    // Keep status current for a session linked to an existing Poise change.
    if (activeId === e.record.id) scheduleSelfPoll(POLL_ACTIVE_MS)
  } catch (err) {
    dropOptimisticTurns(e.model)
    if (e.record.status === 'running' && !e.model.running) e.record = { ...e.record, status: 'idle' }
    restoreDraftTo(e.record.id, draft)
    if (activeId === e.record.id) commandFailed(err, 'Send')
    else e.error = `Send failed — ${(err as Error).message}`
    queueRender()
  }
}

async function steer(draft: ComposerDraft): Promise<void> {
  const e = entry()
  if (!e) return
  if (!await waitForSwitchSave(draft, e.record.id)) return
  if (activeId !== e.record.id) { restoreDraftTo(e.record.id, draft); return }
  const chain = parseChatCommandChain(commandDraftText(draft))
  if (chain.create) { await createSavedSwitch(draft, e.record.id); return }
  if (chain.context === 'reset' && !chain.queue) { await resetPrompt(draft, e.record.id); return }
  if (chain.queue || chain.context || chain.review || chain.model) { queueDraft(draft); return }
  try {
    await chatClient.send({ type: 'steer', sessionId: e.record.id, text: draft.text,
      ...(draft.attachments.length ? { attachments: draft.attachments } : {}), ...(draft.mentions.length ? { mentions: draft.mentions } : {}) })
  } catch (err) {
    restoreDraftTo(e.record.id, draft)
    if (activeId === e.record.id) commandFailed(err, 'Steer')
    else e.error = `Steer failed — ${(err as Error).message}`
    queueRender()
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
    await applyCommandModel(model, e.record.id, effort)
  } catch (err) {
    commandFailed(err, 'Model change')
    queueRender()
  }
}

async function setMode(mode: string): Promise<void> {
  const e = entry()
  if (!e) return
  try {
    await trackSettingUpdate(e.record.id, async () => { await chatClient.send({ type: 'set_mode', sessionId: e.record.id, mode }) })
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
    if (activeId === e.record.id) await selectSession(r.session.id)
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
  if (name === 'poise') {
    // The chip form of the command; the fresh console may run it too.
    await startPoiseChange({ request: arg.trim(), form: 'slash' }, { ...emptyDraft(), text: `/poise ${arg}`.trim() })
    return
  }
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
    await memories.editor.flush()
    const r = await chatClient.handoffSession(e.record.id, { agent, model, effort })
    upsertRecord(r.session)
    if (activeId === e.record.id) await selectSession(r.session.id)
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
  const focusMemories = !!document.activeElement?.closest('.chat-h-memories')
  headerEl.innerHTML = html
  if (focusMemories) headerEl.querySelector<HTMLButtonElement>('.chat-h-memories')?.focus()
}

function autoMergeButton(enabled: boolean, pending = false): string {
  return `<button type="button" class="chat-icon-btn chat-h-auto-merge" aria-label="Auto-merge" aria-pressed="${enabled}" data-tooltip="Auto-merge"${pending ? ' disabled aria-busy="true"' : ''}>${ICON_AUTO_MERGE}</button>`
}

async function toggleAutoMerge(): Promise<void> {
  const e = entry()
  if (!e) {
    if (quickSessionPromise || firstPromptPending) return
    setFreshAutoMerge(!freshAutoMerge)
    renderHeader()
    headerEl.querySelector<HTMLButtonElement>('.chat-h-auto-merge')?.focus()
    return
  }
  const id = e.record.id
  if (e.pending || autoMergeUpdates.has(id)) return
  const enabled = e.record.autoMerge !== true
  const hadFocus = !!document.activeElement?.closest('.chat-h-auto-merge')
  const update = (async (): Promise<boolean> => {
    try {
      if (enabled) await memories.editor.flush()
      const result = await chatClient.setAutoMerge(id, enabled)
      // Do not replace a newer update received from another tab with an old ack.
      if (result.session.lastSeq >= e.record.lastSeq) upsertRecord(result.session)
      if (activeId === id) setNotice(result.warning || null, result.warning ? 'error' : 'info')
      return true
    } catch (error) {
      if (activeId === id) commandFailed(error, 'Auto-merge')
      else e.error = `Auto-merge update failed — ${(error as Error).message}`
      return false
    } finally {
      autoMergeUpdates.delete(id)
      if (activeId === id) {
        const restoreFocus = hadFocus && (document.activeElement === document.body || !!document.activeElement?.closest('.chat-h-auto-merge'))
        renderHeader()
        if (restoreFocus) headerEl.querySelector<HTMLButtonElement>('.chat-h-auto-merge')?.focus()
      }
      queueRender()
    }
  })()
  autoMergeUpdates.set(id, update)
  renderHeader()
  await update
}

function reasoningButton(): string {
  return `<button type="button" class="chat-icon-btn chat-h-reasoning" aria-label="Reasoning" aria-pressed="${showReasoning}" aria-controls="chat-transcript" data-tooltip="Reasoning">${ICON_REASONING}</button>`
}

function safeModeButton(enabled: boolean, pending = false, deferred = false): string {
  return `<button type="button" class="chat-icon-btn chat-h-safe-mode${deferred ? ' is-deferred' : ''}" aria-label="Safe mode" aria-pressed="${enabled}" data-tooltip="Safe mode"${pending ? ' disabled aria-busy="true"' : ''}${deferred ? ' aria-describedby="chat-safe-mode-status"' : ''}>${ICON_SAFE_MODE}</button>`
}

async function toggleSafeMode(): Promise<void> {
  const e = entry()
  if (!e) {
    if (quickSessionPromise || firstPromptPending) return
    setFreshSafeMode(!freshSafeMode)
    renderHeader()
    headerEl.querySelector<HTMLButtonElement>('.chat-h-safe-mode')?.focus()
    return
  }
  const id = e.record.id
  if (e.pending || safeModeUpdates.has(id)) return
  const enabled = e.record.safeMode !== true
  const hadFocus = !!document.activeElement?.closest('.chat-h-safe-mode')
  const update = (async (): Promise<boolean> => {
    try {
      // Permission controls must remain usable even if a Memories save fails.
      const result = await chatClient.setSafeMode(id, enabled)
      if (result.session.lastSeq >= e.record.lastSeq) upsertRecord(result.session)
      if (activeId === id) setNotice(result.warning || null, 'info')
      return true
    } catch (error) {
      if (activeId === id) commandFailed(error, 'Safe mode')
      else e.error = `Safe mode update failed — ${(error as Error).message}`
      return false
    } finally {
      safeModeUpdates.delete(id)
      if (activeId === id) {
        const restoreFocus = hadFocus && (document.activeElement === document.body || !!document.activeElement?.closest('.chat-h-safe-mode'))
        renderHeader()
        if (restoreFocus) headerEl.querySelector<HTMLButtonElement>('.chat-h-safe-mode')?.focus()
      }
      queueRender()
    }
  })()
  safeModeUpdates.set(id, update)
  renderHeader()
  await update
}

function memoriesButton(): string {
  const open = memories?.open ?? false
  const error = memories?.editor.state.error
  return `<button type="button" class="chat-icon-btn chat-h-memories${error ? ' has-error' : ''}" aria-label="Memories" aria-controls="chat-memories-pane" aria-expanded="${open}" aria-pressed="${open}" data-tooltip="Memories">${ICON_MEMORIES}</button>`
}

function headerHtml(): string {
  const e = entry()
  if (!e) return `<div class="chat-h-row chat-h-fresh"><span class="chat-controls-spacer"></span>${reasoningButton()}${autoMergeButton(freshAutoMerge, !!quickSessionPromise || firstPromptPending)}${safeModeButton(freshSafeMode, !!quickSessionPromise || firstPromptPending)}${memoriesButton()}</div>`
  const s = e.record
  const agent = agentFor(s.agent)
  const between = !isRunning(s.status) && s.status !== 'starting' && s.status !== 'closed'
  const models = agent?.models.map((m) => m.identity) || []
  if (!models.includes(s.model)) models.unshift(s.model)
  const selectedModel = agent?.models.find(model => model.identity === s.model)
  const variants = selectedModel ? agent!.models.filter(model => model.selector === selectedModel.selector).map(model => model.effort) : []
  const efforts = variants.filter(effort => !s.efforts?.length || s.efforts.includes(effort))
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
      <span class="chat-h-repo" title="${escapeHtml(s.checkout || '')}">${s.workspaceKind === 'poise-local' ? '<span>Poise · local</span>' : s.workspaceKind === 'poise-change' ? `<span>Poise · change</span> · <code>${escapeHtml(s.branch?.name || '')}</code>` : `<code>${escapeHtml(s.repo || 'local')}</code> · <code>${escapeHtml(s.branch?.name || '')}</code>`}${ws.text ? ` <span class="chat-h-ws ${ws.cls}">${escapeHtml(ws.text)}</span>` : ''}</span>
      ${modeSel}
      <span class="chat-h-status" data-status="${s.status}">${escapeHtml(statusText(s))}</span>
      <span class="chat-controls-spacer"></span>
      ${isRunning(s.status) ? `<button type="button" class="chat-h-btn chat-h-stop" title="Stop the turn (⌘.)">${ICON_STOP} Stop</button>` : ''}
      ${s.capabilities?.fork ? `<button type="button" class="chat-icon-btn chat-h-fork" title="Fork session" aria-label="Fork"${between ? '' : ' disabled'}>${ICON_FORK}</button>` : ''}
      <button type="button" class="chat-icon-btn chat-h-activity" aria-label="${showActivity ? 'Hide activity' : 'Show activity'}" data-tooltip="Activity" aria-pressed="${showActivity}" aria-controls="chat-transcript">${ICON_ACTIVITY}</button>
      ${others.length ? `<span class="chat-h-handoff-wrap"><button type="button" class="chat-icon-btn chat-h-handoff" title="Hand off to another agent" aria-label="Hand off…" aria-haspopup="true" aria-expanded="${handoffOpen}">${ICON_HANDOFF}</button>${handoffOpen ? handoffMenu(others) : ''}</span>` : ''}
      ${reasoningButton()}
      ${autoMergeButton(s.autoMerge === true, e.pending || autoMergeUpdates.has(s.id))}
      ${safeModeButton(s.safeMode === true, e.pending || safeModeUpdates.has(s.id) || s.status === 'closed', s.safeModePending === true)}
      ${memoriesButton()}
    </div>
    ${s.safeModePending ? '<div id="chat-safe-mode-status" class="st-help chat-safe-mode-status" role="status">Permission change queued for the next turn; current native permissions are unchanged.</div>' : ''}
    ${s.cliWarning ? `<div class="st-help st-help-error chat-cli-warning" role="status">${escapeHtml(s.cliWarning)}</div>` : ''}
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
    if (t.classList.contains('chat-model-select')) void setModel(t.value, agentFor(s.agent)?.models.find(model => model.identity === t.value)?.effort)
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
    if (t.closest('.chat-h-memories')) { memories.toggle(); renderHeader(); return }
    if (t.closest('.chat-h-safe-mode')) { void toggleSafeMode(); return }
    if (t.closest('.chat-h-reasoning')) {
      showReasoning = !showReasoning
      try { localStorage.setItem(REASONING_KEY, String(showReasoning)) } catch { /* optional preference */ }
      renderHeader()
      headerEl.querySelector<HTMLButtonElement>('.chat-h-reasoning')?.focus()
      queueRender()
      return
    }
    if (t.closest('.chat-h-auto-merge')) { void toggleAutoMerge(); return }
    if (t.closest('.chat-h-activity')) {
      showActivity = !showActivity
      try { localStorage.setItem(ACTIVITY_KEY, String(showActivity)) } catch { /* optional preference */ }
      renderHeader()
      headerEl.querySelector<HTMLButtonElement>('.chat-h-activity')?.focus()
      queueRender()
      return
    }
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
    if (!e.isComposing && e.key === 'Escape' && !dialogEl.hidden) {
      e.preventDefault(); closeDialog(); viewEl.querySelector<HTMLButtonElement>('.chat-new-btn')?.focus(); return
    }
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
    composer.setCommands([], { model: true, modes: false, fork: false })
    const model = freshModelIdentity || quickSessionModel(agentsInfo?.agents || [])?.identity
    const restoring = !!restoredSnapshot?.activeSessionId
    composer.setState({ running: false, disabled: !!quickSessionPromise || restoring, placeholder: restoring ? 'Loading your conversation…' : quickSessionPromise ? 'Starting the session…' : undefined, modelLabel: model ? consoleModelLabel(model) : 'Opus · High', modelIdentity: model, sessionId: null })
    return
  }
  const s = e.record
  const running = isRunning(s.status) || !!e.model.running
  let disabled = false
  let placeholder: string | undefined
  if (e.pending) { disabled = true; placeholder = 'Starting the session…' }
  else if (s.status === 'closed') { disabled = true; placeholder = 'This session is closed' }
  else if (s.status === 'interrupted') { disabled = true; placeholder = 'Interrupted — Resume to continue, or /reset to start fresh' }
  else if (s.status === 'error') { disabled = true; placeholder = 'The session failed — Resume to try again, or /reset to start fresh' }
  composer.setCommands(s.commands || [], { modes: !!s.capabilities?.modes, fork: !!s.capabilities?.fork })
  if (s.contextResetting) { disabled = true; placeholder = 'Resetting chat…' }
  composer.setState({ running, maintaining: s.contextCompacting, disabled, placeholder, modelIdentity: s.model, resume: !s.contextResetting && (s.status === 'interrupted' || s.status === 'error'), sessionId: e.pending ? null : s.id })
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
  if (jev?.visible) return
  renderHeader()
  const e = entry()
  composerStateFor(e)
  renderQueue()
  // A deploy card is content too: the console must not lift over it.
  const hasCard = !!e && (!!activeChange() || localChanges.has(e.record.id))
  const empty = !e || (!e.model.blocks.length && !e.loading && !hasCard)
  mainEl.classList.toggle('chat-empty-session', empty)
  // The fresh console sits slightly above centre. Its own height participates
  // in the calculation, so a taller draft never pushes it off-screen.
  if (lastEmpty !== empty) { lastEmpty = empty; composer.layout() }
  const contentHeight = Math.max(0, mainEl.clientHeight - headerEl.offsetHeight - noticeEl.offsetHeight)
  const history = composer.models.open ? composer.models : composer.history
  if (history.open) {
    const dockStyle = getComputedStyle(dockEl)
    const padding = parseFloat(dockStyle.paddingTop) + parseFloat(dockStyle.paddingBottom)
    const queueFixed = messageQueue.el.hidden ? 0 : messageQueue.el.querySelector('summary')!.offsetHeight + 10
    const available = Math.max(0, contentHeight - composer.el.offsetHeight - padding - history.fixedHeight - queueFixed - 28)
    // Share the extension space; the history is closest to the input and
    // gets priority, while a visible queue keeps its summary and some rows.
    const historyRoom = messageQueue.el.hidden ? available : available * .65
    const historyHeight = Math.min(320, history.rowsHeight, historyRoom)
    history.setAvailableHeight(historyHeight)
    mainEl.style.setProperty('--chat-queue-available', `${Math.floor(Math.max(0, available - historyHeight))}px`)
  } else if (!messageQueue.el.hidden) {
    const dockStyle = getComputedStyle(dockEl)
    const padding = parseFloat(dockStyle.paddingTop) + parseFloat(dockStyle.paddingBottom)
    const summaryHeight = messageQueue.el.querySelector('summary')!.offsetHeight
    // Keep the entire console (including Send) on screen; only queue rows
    // scroll when the window is short. Leave room for the scroll's padding.
    const room = Math.max(0, contentHeight - composer.el.offsetHeight - padding - summaryHeight - 36)
    mainEl.style.setProperty('--chat-queue-available', `${Math.floor(room)}px`)
  }
  const dockHeight = dockEl.offsetHeight
  const desiredLift = contentHeight * 0.58 - dockHeight / 2
  const lift = Math.max(0, Math.min(desiredLift, contentHeight - dockHeight))
  mainEl.style.setProperty('--chat-dock-lift', `${Math.round(lift)}px`)
  viewEl.querySelector<HTMLElement>('.chat-transcript-loading')!.hidden = !(e && e.loading && !e.model.blocks.length)
  // Scrolling sticks to the bottom only for someone already reading there.
  const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
  const wasAtBottom = distance <= STICK_TO_BOTTOM_PX
  if (e) {
    transcript.render(e.model, { showActivity, showReasoning, agent: e.record.agent, running: isRunning(e.record.status) || !!e.model.running, interruptedTurnId: e.record.interruptedTurnId })
  } else {
    transcript.clear()
  }
  renderDeployCard()
  if (wasAtBottom || forceBottom) scrollEl.scrollTop = scrollEl.scrollHeight
  forceBottom = false
  persistDrafts()
}

// ── New session dialog ─────────────────────────────────────────────────────

export interface NewSessionPrefill { context?: SessionContext }

let dialogGeneration = 0
let dialogOpener: HTMLElement | null = null

function openPrimitiveWorkspace(): void { closeDialog(); void jev.create() }

async function openNewSessionDialog(prefill: NewSessionPrefill = {}): Promise<void> {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  closeDialog()
  dialogOpener = opener
  const generation = ++dialogGeneration
  dialogEl.hidden = false
  dialogEl.innerHTML = '<div class="chat-dialog-body"><div class="chat-empty" role="status">Loading agent models…</div><button type="button" class="st-clear chat-dialog-jev">JEV · Primitive builder</button></div>'
  dialogEl.querySelector('.chat-dialog-jev')!.addEventListener('click', openPrimitiveWorkspace)
  dialogEl.focus({ preventScroll: true })
  const agents = await loadAgents(true)
  if (dialogEl.hidden || generation !== dialogGeneration) return
  if (!agents) {
    dialogEl.innerHTML = '<div class="chat-dialog-body"><div class="st-help st-help-error">Could not load the model catalogue.</div><button type="button" class="st-clear chat-dialog-jev">JEV · Primitive builder</button><button type="button" class="st-clear chat-dialog-cancel">Close</button></div>'
    dialogEl.querySelector('.chat-dialog-jev')!.addEventListener('click', openPrimitiveWorkspace)
    dialogEl.querySelector('.chat-dialog-cancel')!.addEventListener('click', closeDialog)
    return
  }
  renderNewSessionDialog(dialogEl, agents, prefill.context, (request, error) => { void createSession(request, error) }, closeDialog, openPrimitiveWorkspace)
}

function closeDialog(): void {
  if (!dialogEl) return
  dialogGeneration++
  if (dialogEl.contains(document.activeElement) && dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true })
  dialogEl.hidden = true
  dialogEl.innerHTML = ''
  dialogOpener = null
}

async function createSessionEntry(req: NewSessionRequest, draft: ComposerDraft | null = null,
  firstPrompt?: ComposerDraft, expectedActiveId = activeId): Promise<SessionEntry> {
  const tempId = `pending-${crypto.randomUUID()}`
  const placeholder: SessionRecord = {
    id: tempId, agent: req.agent, model: req.model, modelId: req.model, effort: req.effort || '', repo: '', checkout: '', workspaceKind: 'poise-local',
    branch: { name: '', origin: 'new', provisional: true },
    title: req.title || req.context?.title || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'starting',
    capabilities: { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false },
    lastSeq: 0, pendingRequests: [], instance: '', context: req.context, autoMerge: req.autoMerge, safeMode: req.safeMode === true,
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
    const fresh = !activeId
    await createSessionEntry({ ...req, ...(fresh && freshAutoMerge ? { autoMerge: true } : {}), safeMode: fresh && freshSafeMode }, activeId ? null : composer.getDraft())
    if (fresh) { setFreshAutoMerge(false); setFreshSafeMode(false) }
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
    // Both ordinary and update snapshots belong to this tab. A different
    // tab must never consume shared text left by an older release.
    try { restoredSnapshot = takeDraftSnapshot(sessionStorage) } catch { restoredSnapshot = null }
    if (!restoredSnapshot) {
      // Upgrade compatibility: old builds wrote to localStorage and marked
      // the initiating tab. Only that marked tab may consume the legacy file.
      try { if (sessionStorage.getItem(RELOADED_RELEASE_KEY)) restoredSnapshot = takeDraftSnapshot(localStorage) } catch { /* optional recovery */ }
    }
    // A fast catalogue response must not expose a writable fresh console
    // while this tab is still restoring a different conversation and draft.
    composerStateFor(null)
    // Events keep folding into the per-session models while the view is
    // hidden — that is what lets a running turn be re-joined on return
    // without a refetch — so these listeners live for the app's lifetime.
    window.addEventListener('poise:models-updated', () => { void loadAgents(true) })
    chatClient.on('switches', acceptSwitches)
    chatClient.on('event', onEvent)
    chatClient.on('connection', (state) => {
      if (state === 'open') void loadSwitches(true).catch(() => undefined)
      const el = viewEl.querySelector<HTMLElement>('.chat-conn')
      if (!el) return
      el.hidden = state === 'open'
      el.textContent = state === 'connecting' ? 'Connecting…' : 'Reconnecting…'
    })
    chatClient.on('restart', () => {
      switchLoadGeneration++; switchesLoading = null
      switchesLoaded = false
      savedSwitches = { revision: 0, switches: [] }; switchNames.clear()
      composer.setSwitches([])
      void loadSwitches(true).catch(() => undefined)
      // Sessions may have been interrupted or cleaned up; re-read them and
      // re-subscribe from what each transcript already holds.
      chatClient.resetSubscriptions()
      for (const e of sessions.values()) {
        if (e.loaded) chatClient.subscribe(e.record.id, e.record.lastSeq || 0)
      }
      void loadSessions()
      // A restart is what a promotion or rollback looks like from here.
      scheduleSelfPoll(0)
      void installSelfUpdateWatch().poll()
    })
  }
  if (!tickTimer) tickTimer = setInterval(() => { if (!viewEl.hidden) transcript.tick() }, 1000)
  chatClient.start()
  void loadAgents()
  void loadSwitches().catch(() => undefined)
  await loadSessions()
  const restoreActive = restoredSnapshot?.activeSessionId ?? null
  applyRestoredSnapshot()
  // The session that was on screen before a safe reload comes back first.
  if (restoreActive && !activeId && sessions.has(restoreActive) && dialogEl.hidden) await selectSession(restoreActive, true)
  // A handoff may have opened the New session dialog while the list loaded;
  // auto-selecting would close it.
  if (!activeId && !quickSessionPromise && !composer.getDraft().text && order.length && dialogEl.hidden) await selectSession(order[0], true)
  void jev.init(); jev.resume()
  scheduleSelfPoll(0)
  queueRender()
}

// Leaving the view stops the per-second tick and keeps the draft; the socket
// and its subscriptions stay so a running turn keeps being mirrored and the
// sidebar is current when the view comes back.
export function stopChatRefresh(): void {
  jev?.pause()
  composer?.history.close()
  composer?.models.close()
  filePreview?.close()
  splitPane?.cancelResize()
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (selfPollTimer) { clearTimeout(selfPollTimer); selfPollTimer = null }
  if (composer && activeId) {
    const e = sessions.get(activeId)
    if (e) e.draft = composer.getDraft()
  }
}
