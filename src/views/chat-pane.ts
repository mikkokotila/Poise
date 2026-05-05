// Chat pane — slides in from the LEFT, occupies ~25vw (min 360px).
// Each card has a deterministic session id; the pane reuses or starts
// the conversation tied to that id whenever the card's chat icon is
// clicked. Messages flow through agent-interface --chat (codex-backed
// `gpt` model). History is persisted server-side; the pane just
// renders + polls.
//
// Composer pattern follows Confab's: a single bordered "input wrap"
// with a focus-within ring, a borderless auto-growing textarea, and
// the send button absolute-positioned inside the wrap. Auto-grow caps
// at ~6 lines; Enter sends, Shift+Enter inserts a newline.

interface ChatLogEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string        // 8-char hash → fetch body via /api/agent-response/<hash>
  error: string
}

let panelEl: HTMLElement | null = null
let titleEl: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let inputEl: HTMLTextAreaElement | null = null
let sendBtn: HTMLButtonElement | null = null
let initialized = false

let currentSession: string | null = null
let messages: ChatLogEntry[] = []
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

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
// Up-arrow send glyph — matches Confab's composer affordance ("send up
// to the conversation above"). Stroked rather than filled so it sits
// quietly inside the dark pill.
const ICON_SEND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'

function renderShell() {
  panelEl = document.createElement('aside')
  panelEl.id = 'chat-panel'
  panelEl.innerHTML = `
    <header class="chat-header">
      <span class="chat-title"></span>
      <button class="chat-close" aria-label="Close chat">${ICON_CLOSE}</button>
    </header>
    <div class="chat-body" id="chat-body"></div>
    <form class="chat-composer">
      <div class="chat-input-wrap">
        <textarea class="chat-input" rows="1" placeholder="Message…" spellcheck="true"></textarea>
        <div class="chat-controls">
          <button class="chat-send" type="submit" aria-label="Send">${ICON_SEND}</button>
        </div>
      </div>
    </form>
  `
  document.body.appendChild(panelEl)

  titleEl = panelEl.querySelector('.chat-title')!
  bodyEl  = panelEl.querySelector('.chat-body')!
  inputEl = panelEl.querySelector('.chat-input') as HTMLTextAreaElement
  sendBtn = panelEl.querySelector('.chat-send') as HTMLButtonElement

  panelEl.querySelector('.chat-close')!.addEventListener('click', close)
  panelEl.querySelector('.chat-composer')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void send()
  })
  inputEl.addEventListener('input', () => autoResize())
  inputEl.addEventListener('keydown', (e) => {
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
  sendBtn.disabled = true
  inputEl.disabled = true
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession, message: text }),
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
  // cache, and any in-flight draft so the previous card's text
  // doesn't leak into the new card's composer. Reopening the same
  // session preserves all of it — including whatever the user had
  // typed but not sent.
  if (currentSession !== sessionId) {
    currentSession = sessionId
    messages = []
    repliesById.clear()
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
