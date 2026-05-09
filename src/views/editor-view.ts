// Editor — minimalist markdown writing surface.
//
// Two halves:
//   * Sidebar: list of docs newest-first, plus a single "+ New" button.
//   * Main:    a chromeless textarea, set in a generous serif at a
//              comfortable measure, autosaving on a debounced timer.
//
// MVP scope is intentionally narrow — create, save, switch, no toolbar,
// no formatting buttons, no menu bar. The differentiator is the
// typography and the autosave: the writer types, the page just is. All
// markdown live as plain .md files under ~/.poise/editor/ so they
// roundtrip through whatever versioning / sync the user already has.

interface DocSummary {
  slug: string
  title: string
  updated_at: string
  size: number
}

let viewEl: HTMLElement
let initialized = false
let docs: DocSummary[] = []
let currentSlug: string | null = null
let textareaEl: HTMLTextAreaElement | null = null
let docListEl: HTMLElement | null = null
let metaEl: HTMLElement | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight = false

// Debounce tuned for "I just stopped typing for half a second, save now."
// Long enough to coalesce normal typing rhythm, short enough that the
// "saved" feedback reads as live.
const SAVE_DEBOUNCE_MS = 500

const LAST_OPEN_KEY = 'poise-editor-last'

// Attribute-safe HTML escape — same shape as the other views.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

function relTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

// Sidebar entries grouped by relative recency so the most-active docs
// surface near the top without dating every line.
function groupBucket(iso: string): string {
  const t = new Date(iso).getTime()
  const days = (Date.now() - t) / 86_400_000
  if (days < 1)  return 'Today'
  if (days < 2)  return 'Yesterday'
  if (days < 7)  return 'This week'
  if (days < 30) return 'This month'
  return 'Older'
}

function renderShell(): string {
  return `
    <div class="editor-shell">
      <aside class="editor-sidebar">
        <button class="editor-new-btn" type="button">+ New</button>
        <div class="editor-doc-list" id="editor-doc-list"></div>
      </aside>
      <main class="editor-main">
        <div class="editor-page">
          <textarea class="editor-textarea" id="editor-textarea" spellcheck="true" placeholder="Start writing…"></textarea>
          <div class="editor-meta" id="editor-meta"></div>
        </div>
      </main>
    </div>
  `
}

function renderDocList() {
  if (!docListEl) return
  if (!docs.length) {
    docListEl.innerHTML = '<div class="editor-doc-empty">No notes yet.</div>'
    return
  }
  // Group by recency bucket; preserve sorted-newest-first within each.
  const buckets: { name: string, items: DocSummary[] }[] = []
  let prev = ''
  for (const d of docs) {
    const b = groupBucket(d.updated_at)
    if (b !== prev) { buckets.push({ name: b, items: [d] }); prev = b }
    else            { buckets[buckets.length - 1].items.push(d) }
  }
  const parts: string[] = []
  for (const b of buckets) {
    parts.push(`<h3 class="editor-doc-bucket">${escapeHtml(b.name)}</h3>`)
    for (const d of b.items) {
      const isActive = d.slug === currentSlug
      parts.push(`
        <button type="button"
                class="editor-doc-item${isActive ? ' is-active' : ''}"
                data-slug="${escapeHtml(d.slug)}"
                title="${escapeHtml(d.title)}">
          <span class="editor-doc-title">${escapeHtml(d.title)}</span>
          <span class="editor-doc-time">${escapeHtml(relTime(d.updated_at))}</span>
        </button>
      `)
    }
  }
  docListEl.innerHTML = parts.join('')
}

function setMeta(text: string) {
  if (metaEl) metaEl.textContent = text
}

function wordCount(s: string): number {
  return (s.match(/\S+/g) || []).length
}

function setMetaForCurrent() {
  if (!textareaEl) return
  const wc = wordCount(textareaEl.value)
  setMeta(wc === 0 ? 'Empty · saved' : `${wc} word${wc === 1 ? '' : 's'} · saved`)
}

async function fetchDocs() {
  try {
    const res = await fetch('/api/editor/docs')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    docs = (data.docs || []) as DocSummary[]
  } catch (err) {
    console.error('[editor] fetchDocs failed:', err)
    docs = []
  }
}

async function loadDoc(slug: string) {
  if (!textareaEl) return
  // Save anything pending on the OLD doc before swapping content,
  // so a fast click-around doesn't lose recent keystrokes.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flushSave() }
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    currentSlug = String(data.slug || slug)
    textareaEl.value = String(data.content || '')
    try { localStorage.setItem(LAST_OPEN_KEY, currentSlug) } catch { /* ignore */ }
    setMetaForCurrent()
    renderDocList()
    textareaEl.focus()
    // Caret at the end so cmd-tab back into the editor lands you
    // where you left off, not at the very top.
    const len = textareaEl.value.length
    try { textareaEl.setSelectionRange(len, len) } catch { /* ignore */ }
  } catch (err) {
    console.error('[editor] loadDoc failed:', err)
  }
}

async function newDoc() {
  // Save anything outstanding on the doc we're leaving.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flushSave() }
  try {
    const res = await fetch('/api/editor/docs', { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const slug = String(data.slug || '')
    if (!slug) return
    await fetchDocs()
    await loadDoc(slug)
  } catch (err) {
    console.error('[editor] newDoc failed:', err)
  }
}

async function flushSave() {
  if (!textareaEl || !currentSlug || saveInFlight) return
  saveInFlight = true
  setMeta('Saving…')
  const slug = currentSlug
  const content = textareaEl.value
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    // Update the local doc summary so the sidebar's title + ordering
    // reflect what's on disk without a full re-fetch.
    const idx = docs.findIndex((d) => d.slug === slug)
    if (idx >= 0) {
      docs[idx] = {
        slug,
        title: String(data.title || docs[idx].title),
        updated_at: String(data.updated_at || new Date().toISOString()),
        size: Number(data.size || content.length),
      }
      // Move to front (newest-first ordering).
      const [moved] = docs.splice(idx, 1)
      docs.unshift(moved)
    }
    renderDocList()
    setMetaForCurrent()
  } catch (err) {
    console.error('[editor] save failed:', err)
    setMeta('Save failed')
  } finally {
    saveInFlight = false
  }
}

function scheduleSave() {
  if (!textareaEl || !currentSlug) return
  setMeta('Editing…')
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, SAVE_DEBOUNCE_MS)
}

function attachHandlers() {
  const newBtn = viewEl.querySelector<HTMLButtonElement>('.editor-new-btn')!
  newBtn.addEventListener('click', () => { void newDoc() })

  docListEl!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.editor-doc-item')
    if (!btn) return
    const slug = btn.dataset.slug || ''
    if (!slug || slug === currentSlug) return
    void loadDoc(slug)
  })

  textareaEl!.addEventListener('input', () => scheduleSave())
  // Cmd/Ctrl+S forces a save right now — for users with the muscle
  // memory.
  textareaEl!.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      void flushSave()
    }
    // Cmd/Ctrl+N → new doc, matches the global "new" muscle.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      void newDoc()
    }
  })

  // Best-effort flush on tab close / view leave so the very last
  // keystroke isn't lost. The browser may swallow async fetches
  // during pagehide; we use sendBeacon for that one path.
  window.addEventListener('pagehide', () => {
    if (!textareaEl || !currentSlug) return
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try {
      const blob = new Blob([JSON.stringify({ content: textareaEl.value })], { type: 'application/json' })
      navigator.sendBeacon(`/api/editor/doc/${encodeURIComponent(currentSlug)}`, blob)
    } catch { /* best-effort */ }
  })
}

export async function initEditorView() {
  viewEl = document.getElementById('view-editor')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    textareaEl = viewEl.querySelector<HTMLTextAreaElement>('.editor-textarea')
    docListEl = viewEl.querySelector<HTMLElement>('#editor-doc-list')
    metaEl = viewEl.querySelector<HTMLElement>('#editor-meta')
    attachHandlers()
  }
  await fetchDocs()
  renderDocList()
  // Open the doc the user had last, or fall back to the most recent,
  // or — if nothing exists — mint a fresh blank one so the user has
  // something to type into immediately.
  let target: string | null = null
  try { target = localStorage.getItem(LAST_OPEN_KEY) } catch { /* ignore */ }
  if (!target || !docs.find((d) => d.slug === target)) {
    target = docs[0]?.slug || null
  }
  if (target) {
    await loadDoc(target)
  } else {
    await newDoc()
  }
}

// Symmetrical with the other views' stop functions, even though the
// editor doesn't subscribe to the global tick — the shape lets main.ts
// switch views uniformly. Save anything outstanding on the way out.
export function stopEditorRefresh() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    void flushSave()
  }
}
