// Chat pane — slides in from the LEFT, occupies ~25vw (min 360px).
// Each card has a deterministic session id; the pane reuses or starts
// the conversation tied to that id whenever the card's chat icon is
// clicked. Messages flow through agent-interface --chat against one
// of four models (opus default, gpt, gemini, grok). History is
// persisted server-side; the pane just renders + polls.
//
// Composer pattern follows Confab's: a single bordered "input wrap"
// with a focus-within ring, a borderless auto-growing textarea on
// top, and a controls row beneath holding the attach button, the
// model selector, and the send button. Attachments land in the
// session's pwd directory so the agent can read them via cwd; their
// names are appended to the prompt so the agent knows they're there.

interface ChatLogEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string        // 8-char hash → fetch body via /api/agent-response/<hash>
  error: string
}

interface Attachment {
  // Sanitized filename returned by the server — what we send back in
  // the chat payload so the agent knows which files to look at.
  name: string
  // Original (display) name — what the chip shows.
  displayName: string
  size: number
}

const MODELS = ['opus', 'gpt', 'gemini', 'grok'] as const
type ModelKey = typeof MODELS[number]
const DEFAULT_MODEL: ModelKey = 'opus'

let panelEl: HTMLElement | null = null
let titleEl: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let inputEl: HTMLTextAreaElement | null = null
let sendBtn: HTMLButtonElement | null = null
let attachBtn: HTMLButtonElement | null = null
let fileInputEl: HTMLInputElement | null = null
let modelSelectEl: HTMLSelectElement | null = null
let chipsEl: HTMLElement | null = null
let modeChipEl: HTMLElement | null = null
let inputWrapEl: HTMLElement | null = null
let initialized = false

let currentSession: string | null = null
let messages: ChatLogEntry[] = []
let attachments: Attachment[] = []
let selectedModel: ModelKey = DEFAULT_MODEL
// Slash-command mode lock. When the user types `/<token> ` at the
// end of an empty-trimmed input, the composer "locks" into that mode
// — visual chip in the input wrap, and on send we route to the mode's
// dedicated path (currently only `/content` → agent-interface
// --author-content). Same rhythm as Confab's mode-lock pattern.
interface ModeToken { token: string; mode: 'content' }
const MODE_TOKENS: ModeToken[] = [
  { token: '/content', mode: 'content' },
]
let activeMode: ModeToken | null = null
// Cache of fetched reply bodies, keyed by call id, so we don't refetch.
const repliesById: Map<string, string> = new Map()
// Polling — fast while there's an in-flight (running) message, idle otherwise.
let pollTimer: ReturnType<typeof setTimeout> | null = null
let inflight = false

const FAST_POLL_MS = 2_000
const SLOW_POLL_MS = 20_000

// Composer auto-grow cap — ~10 lines at our 13/1.45 type scale. The
// textarea grows upward from one row up to this height; only beyond
// it do we surrender and start scrolling. The controls row sits in
// its own flex child below, so the bottom of the composer is always
// fixed and the send button never collides with text or scrollbars.
const MAX_INPUT_PX = 210

// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >, which is fine for text content but NOT for attribute values:
// an unescaped " in `data-draft="..."` would close the attribute and
// truncate the draft. We use this for both attributes and text.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
// Up-arrow send glyph — matches Confab's composer affordance ("send up
// to the conversation above"). Stroked rather than filled so it sits
// quietly inside the dark pill.
const ICON_SEND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'
// Plus glyph for the attach button — same stroke weight as the close
// X so the two ghost-icons in the pane chrome share visual weight.
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function renderShell() {
  panelEl = document.createElement('aside')
  panelEl.id = 'chat-panel'
  const modelOptions = MODELS
    .map((m) => `<option value="${m}"${m === DEFAULT_MODEL ? ' selected' : ''}>${m}</option>`)
    .join('')
  panelEl.innerHTML = `
    <header class="chat-header">
      <span class="chat-title"></span>
      <button class="chat-close" aria-label="Close chat">${ICON_CLOSE}</button>
    </header>
    <div class="chat-body" id="chat-body"></div>
    <form class="chat-composer">
      <div class="chat-input-wrap">
        <div class="chat-attachments" hidden></div>
        <textarea class="chat-input" rows="1" placeholder="Message…" spellcheck="true"></textarea>
        <div class="chat-controls">
          <button class="chat-attach" type="button" aria-label="Attach file" title="Attach file">${ICON_PLUS}</button>
          <span class="chat-mode-chip" id="chat-mode-chip" aria-live="polite" hidden></span>
          <div class="chat-model">
            <select class="chat-model-select" aria-label="Model">${modelOptions}</select>
            <span class="chat-model-chevron" aria-hidden="true">▾</span>
          </div>
          <span class="chat-controls-spacer"></span>
          <button class="chat-send" type="submit" aria-label="Send">${ICON_SEND}</button>
        </div>
      </div>
      <input class="chat-file-input" type="file" multiple hidden />
    </form>
  `
  document.body.appendChild(panelEl)

  titleEl = panelEl.querySelector('.chat-title')!
  bodyEl  = panelEl.querySelector('.chat-body')!
  inputEl = panelEl.querySelector('.chat-input') as HTMLTextAreaElement
  sendBtn = panelEl.querySelector('.chat-send') as HTMLButtonElement
  attachBtn = panelEl.querySelector('.chat-attach') as HTMLButtonElement
  fileInputEl = panelEl.querySelector('.chat-file-input') as HTMLInputElement
  modelSelectEl = panelEl.querySelector('.chat-model-select') as HTMLSelectElement
  chipsEl = panelEl.querySelector('.chat-attachments') as HTMLElement
  modeChipEl = panelEl.querySelector('.chat-mode-chip') as HTMLElement
  inputWrapEl = panelEl.querySelector('.chat-input-wrap') as HTMLElement

  panelEl.querySelector('.chat-close')!.addEventListener('click', close)
  panelEl.querySelector('.chat-composer')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void send()
  })
  inputEl.addEventListener('input', () => autoResize())
  inputEl.addEventListener('keydown', (e) => {
    // Mode-lock detection — Confab parity. Space at end-of-input,
    // no modifiers, no selection, current value matches a known
    // /<token>: lock in, clear input, show chip.
    if (tryEnterMode(e)) return
    // Backspace at position 0 or Cmd/Ctrl+X while locked: exit mode.
    if (tryExitMode(e)) return
    // Enter sends; Shift+Enter inserts a newline (standard chat
    // convention). Cmd/Ctrl+Enter also sends — kept for muscle-memory
    // from the previous build.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  })
  attachBtn.addEventListener('click', () => fileInputEl?.click())
  fileInputEl.addEventListener('change', () => {
    const files = Array.from(fileInputEl?.files || [])
    if (files.length) void uploadFiles(files)
    // Reset so picking the same filename twice still triggers change
    if (fileInputEl) fileInputEl.value = ''
  })
  modelSelectEl.addEventListener('change', () => {
    const v = modelSelectEl?.value as ModelKey
    if ((MODELS as readonly string[]).includes(v)) selectedModel = v
  })
  chipsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chat-attachment-remove')
    if (!btn) return
    const name = btn.dataset.name || ''
    attachments = attachments.filter((a) => a.name !== name)
    renderChips()
  })
}

// Auto-grow the textarea to fit its content, capped at MAX_INPUT_PX
// (~10 lines). Resetting to `auto` first lets the browser report the
// natural scrollHeight for both the empty and the multi-line case, so
// we don't need a separate single-line branch. Beyond the cap we
// switch on a real scrollbar — which lives entirely inside the
// textarea, never bleeding into the controls row below it.
function autoResize() {
  if (!inputEl) return
  inputEl.style.height = 'auto'
  const next = Math.min(inputEl.scrollHeight, MAX_INPUT_PX)
  inputEl.style.height = `${next}px`
  inputEl.style.overflowY = inputEl.scrollHeight > MAX_INPUT_PX ? 'auto' : 'hidden'
}

// ── Mode-lock helpers (Confab parity) ─────────────────────────────────

function findModeForText(text: string): ModeToken | null {
  const t = text.trim().toLowerCase()
  for (const m of MODE_TOKENS) if (t === m.token) return m
  return null
}

function applyMode(mode: ModeToken | null) {
  activeMode = mode
  if (!modeChipEl || !inputWrapEl) return
  if (!mode) {
    modeChipEl.hidden = true
    modeChipEl.textContent = ''
    inputWrapEl.classList.remove('mode-locked')
    return
  }
  modeChipEl.textContent = mode.token
  modeChipEl.dataset.mode = mode.mode
  modeChipEl.hidden = false
  inputWrapEl.classList.add('mode-locked')
}

// Space at end-of-input, no modifiers, current text matches a known
// token. We match Confab's exact precondition set: no selection,
// caret at value.length, space key with no Cmd/Ctrl/Alt.
function tryEnterMode(e: KeyboardEvent): boolean {
  if (activeMode || e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return false
  if (!inputEl) return false
  if (inputEl.selectionStart !== inputEl.selectionEnd) return false
  if (inputEl.selectionStart !== inputEl.value.length) return false
  const match = findModeForText(inputEl.value)
  if (!match) return false
  e.preventDefault()
  inputEl.value = ''
  autoResize()
  applyMode(match)
  return true
}

// Backspace/Delete at position 0, OR Cmd/Ctrl+X anywhere, while
// locked: exit the mode.
function tryExitMode(e: KeyboardEvent): boolean {
  if (!activeMode || !inputEl) return false
  if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
    applyMode(null)
    return true
  }
  if ((e.key === 'Backspace' || e.key === 'Delete')
      && inputEl.selectionStart === 0
      && inputEl.selectionEnd === 0) {
    e.preventDefault()
    applyMode(null)
    return true
  }
  return false
}

function renderChips() {
  if (!chipsEl) return
  if (!attachments.length) {
    chipsEl.hidden = true
    chipsEl.innerHTML = ''
    return
  }
  chipsEl.hidden = false
  chipsEl.innerHTML = attachments.map((a) => `
    <span class="chat-attachment-chip" title="${escapeHtml(a.name)} · ${a.size} bytes">
      <span class="chat-attachment-name">${escapeHtml(a.displayName)}</span>
      <button type="button" class="chat-attachment-remove" data-name="${escapeHtml(a.name)}" aria-label="Remove ${escapeHtml(a.displayName)}">×</button>
    </span>
  `).join('')
}

async function uploadFiles(files: File[]) {
  if (!currentSession) return
  for (const f of files) {
    try {
      const url = `/api/chat-attachment?session=${encodeURIComponent(currentSession)}&filename=${encodeURIComponent(f.name)}`
      const res = await fetch(url, { method: 'POST', body: f })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Server returns the sanitized name + size. We use that for the
      // payload sent with the message; the original filename stays
      // visible on the chip for human readability.
      attachments.push({
        name: String(data.name || f.name),
        displayName: f.name,
        size: Number(data.size || f.size),
      })
      renderChips()
    } catch (err) {
      console.error('[chat] attachment upload failed:', err)
      alert(`Couldn't attach "${f.name}": ${(err as Error).message}`)
    }
  }
}

function renderMessages() {
  if (!bodyEl) return
  if (!messages.length) {
    bodyEl.innerHTML = '<div class="chat-empty">No messages yet — send the first one below.</div>'
    return
  }
  // Each entry is a user prompt + an agent reply. User → bubble pill
  // on the right; agent → flat prose on the left (no bubble bg) so
  // long replies read like a document, matching Confab.
  const parts: string[] = []
  for (const m of messages) {
    if (m.prompt) {
      parts.push(`
        <div class="chat-msg chat-msg-user">
          <div class="chat-msg-body">${escapeHtml(m.prompt)}</div>
        </div>
      `)
    }
    const reply = repliesById.get(m.id)
    if (m.status === 'running') {
      parts.push(`
        <div class="chat-msg chat-msg-agent">
          <div class="chat-thinking"><span></span><span></span><span></span></div>
        </div>
      `)
    } else if (m.status === 'failed') {
      parts.push(`
        <div class="chat-msg chat-msg-agent chat-msg-error">
          <div class="chat-msg-body">${escapeHtml(m.error || 'failed')}</div>
        </div>
      `)
    } else if (reply !== undefined) {
      parts.push(`
        <div class="chat-msg chat-msg-agent">
          <pre class="chat-msg-body chat-msg-mono">${escapeHtml(reply)}</pre>
        </div>
      `)
    } else if (m.response) {
      // Completed but body not yet fetched
      parts.push(`
        <div class="chat-msg chat-msg-agent">
          <div class="chat-thinking"><span></span><span></span><span></span></div>
        </div>
      `)
    }
  }
  bodyEl.innerHTML = parts.join('')
  bodyEl.scrollTop = bodyEl.scrollHeight
}

async function fetchReply(hash: string): Promise<string> {
  const res = await fetch(`/api/agent-response/${encodeURIComponent(hash)}`)
  if (!res.ok) throw new Error(`agent-response ${res.status}`)
  const data = await res.json()
  return String(data.body || '')
}

async function refresh() {
  if (!currentSession) return
  inflight = true
  try {
    const res = await fetch(`/api/chat?session=${encodeURIComponent(currentSession)}`)
    if (!res.ok) return
    const data = await res.json()
    messages = (data.messages || []) as ChatLogEntry[]
    // Resolve replies for every completed entry whose body we don't
    // have cached yet. Fire in parallel — tiny payloads, server-side
    // already cached the read.
    const toFetch = messages.filter((m) => m.status === 'completed' && m.response && !repliesById.has(m.id))
    await Promise.all(
      toFetch.map(async (m) => {
        try { repliesById.set(m.id, await fetchReply(m.response)) } catch { /* leave missing */ }
      }),
    )
    renderMessages()
  } finally {
    inflight = false
  }
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  if (!isOpen()) return
  // If anything is still running on the upstream side, poll fast so
  // the reply lands in the UI within seconds. Otherwise idle.
  const hasInflight = messages.some((m) => m.status === 'running')
  const delay = hasInflight ? FAST_POLL_MS : SLOW_POLL_MS
  pollTimer = setTimeout(async () => {
    if (!inflight) await refresh()
    schedulePoll()
  }, delay)
}

async function send() {
  if (!currentSession || !inputEl || !sendBtn) return
  const text = inputEl.value.trim()
  if (!text) return
  // /content takes a different path — calls agent-interface
  // --author-content (no --pwd; the behavior isn't pinned to a
  // repo). The result becomes a new editor article and the user is
  // navigated there.
  if (activeMode?.mode === 'content') {
    void sendContent(text)
    return
  }
  sendBtn.disabled = true
  inputEl.disabled = true
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: currentSession,
        message: text,
        model: selectedModel,
        attachments: attachments.map((a) => a.name),
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    inputEl.value = ''
    autoResize()
    // Optimistically add the user's message so the bubble shows
    // immediately; the next poll will reconcile against server truth.
    messages.push({
      id: '__optimistic-' + Date.now(),
      session_id: currentSession,
      prompt: text,
      started_at: new Date().toISOString(),
      status: 'running',
      response: '',
      error: '',
    })
    // Attachments stick to the message they were sent with — clear
    // the chip row so the next message starts fresh. Files remain in
    // pwd indefinitely so the agent can re-reference them.
    attachments = []
    renderChips()
    renderMessages()
    // Pull right after a small delay so agent-interface has time to
    // insert its row and our optimistic placeholder gets replaced by
    // the real one.
    window.setTimeout(() => { void refresh().then(schedulePoll) }, 800)
  } catch (err) {
    console.error('[chat] send failed:', err)
    alert(`Send failed: ${(err as Error).message}`)
  } finally {
    sendBtn.disabled = false
    inputEl.disabled = false
    inputEl.focus()
  }
}

// /content takes a topic and asks agent-interface --author-content to
// produce an article. The article becomes a new editor doc and the
// user is navigated to the editor on it. The chat itself doesn't
// gain a transcript turn (yet) — that needs agent-interface to
// accept --session for --author-content so we can attribute the
// call to this chat session. Until then the article is tracked in
// the editor only; the chat history shows nothing for it.
async function sendContent(topic: string) {
  if (!currentSession || !inputEl || !sendBtn) return
  sendBtn.disabled = true
  inputEl.disabled = true
  // Briefly indicate we're authoring; the editor view will take over
  // once the response is ready.
  const prevPlaceholder = inputEl.placeholder
  inputEl.placeholder = 'Authoring…'
  try {
    const res = await fetch('/api/chat-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession, topic }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
    }
    const data = await res.json()
    const callId = String(data.call_id || '')
    if (!callId) throw new Error('server did not return a call_id')
    // Poll for completion; on completion the server creates an editor
    // article and returns its slug. We then navigate the user there.
    const slug = await pollContentUntilDone(callId)
    if (!slug) throw new Error('author-content finished without a slug')
    // Reset the composer state.
    inputEl.value = ''
    autoResize()
    applyMode(null)
    // Hand off to the editor view: switch view + load the new doc.
    window.dispatchEvent(new CustomEvent('poise:open-editor-doc', { detail: { slug } }))
  } catch (err) {
    console.error('[chat] /content failed:', err)
    alert(`Couldn't author content: ${(err as Error).message}`)
  } finally {
    if (inputEl) {
      inputEl.placeholder = prevPlaceholder
      inputEl.disabled = false
      inputEl.focus()
    }
    if (sendBtn) sendBtn.disabled = false
  }
}

async function pollContentUntilDone(callId: string): Promise<string | null> {
  // Author-content is a long-running Opus call; polling every 2s
  // until completed (or failed) is plenty.
  const start = Date.now()
  const TIMEOUT_MS = 10 * 60_000
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await fetch(`/api/chat-content/status?call_id=${encodeURIComponent(callId)}`)
      if (!res.ok) continue
      const data = await res.json()
      if (data.status === 'completed') return String(data.slug || '')
      if (data.status === 'failed') throw new Error(String(data.error || 'agent failed'))
    } catch (err) {
      // Network blip — retry.
      console.error('[chat] /content status poll failed:', err)
    }
  }
  throw new Error('author-content timed out')
}

function isOpen(): boolean {
  return !!panelEl && panelEl.classList.contains('open')
}

export function close() {
  if (!panelEl) return
  panelEl.classList.remove('open')
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

export async function open(sessionId: string, label: string, draft?: string) {
  if (!initialized) {
    initialized = true
    renderShell()
  }
  // Switching to a new session resets the message buffer, reply
  // cache, attachments, and any in-flight draft so nothing leaks
  // across cards. Reopening the same session preserves all of it —
  // including whatever the user had typed but not sent and any
  // chips they'd added.
  if (currentSession !== sessionId) {
    currentSession = sessionId
    messages = []
    repliesById.clear()
    attachments = []
    renderChips()
    applyMode(null)
    if (titleEl) titleEl.textContent = label
    if (bodyEl) bodyEl.innerHTML = '<div class="chat-empty">Loading…</div>'
    if (inputEl) {
      inputEl.value = ''
      autoResize()
    }
  }
  panelEl!.classList.add('open')
  inputEl?.focus()
  await refresh()
  // First-time pre-fill: if the chat has never been used and the
  // user hasn't already started typing, seed the composer with the
  // card's content so the first message is one keystroke (or paste,
  // or edit) away. We never auto-send — the user always pulls the
  // trigger.
  if (draft && messages.length === 0 && inputEl && !inputEl.value) {
    inputEl.value = draft
    autoResize()
    // Place caret at the end so a follow-up keystroke appends rather
    // than overwriting the seeded text.
    const len = inputEl.value.length
    try { inputEl.setSelectionRange(len, len) } catch { /* fine */ }
  }
  schedulePoll()
}

export function toggle(sessionId: string, label: string, draft?: string) {
  if (isOpen() && currentSession === sessionId) {
    close()
  } else {
    void open(sessionId, label, draft)
  }
}
