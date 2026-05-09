// Editor — minimalist markdown writing surface.
//
// Single horizontal control bar at the top, sharing the exact alignment
// of every other view's header (same .view-header rule, same indent,
// same height, same right-pad to clear the top-right burger). Inside
// the header, two halves: icons on the left, meta + doc-picker on the
// right.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  +  ×                       25 words · saved   [doc title ▾]│
//   ├─────────────────────────────────────────────────────────────┤
//   │                                                             │
//   │             chromeless writing area, centered page          │
//   │                                                             │
//   └─────────────────────────────────────────────────────────────┘
//
// Storage: each doc is a plain UTF-8 .md file under ~/.poise/editor/.
// Title comes from the first non-empty line at read time. server/editor.ts
// owns sanitization and on-disk layout.

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
let mirrorEl: HTMLElement | null = null
let triggerEl: HTMLButtonElement | null = null
let triggerTitleEl: HTMLElement | null = null
let menuEl: HTMLElement | null = null
let metaEl: HTMLElement | null = null
let copyBtnEl: HTMLButtonElement | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight = false

const SAVE_DEBOUNCE_MS = 500
const LAST_OPEN_KEY = 'poise-editor-last'

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

function groupBucket(iso: string): string {
  const t = new Date(iso).getTime()
  const days = (Date.now() - t) / 86_400_000
  if (days < 1)  return 'Today'
  if (days < 2)  return 'Yesterday'
  if (days < 7)  return 'This week'
  if (days < 30) return 'This month'
  return 'Older'
}

const ICON_PLUS  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4l.5 7a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l.5-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Two-rectangles "duplicate" mark — the same copy glyph used by the
// card chrome, so the meaning carries over.
const ICON_COPY  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Arrows-to-corners pair for the writer-mode toggle: "expand to fill"
// when entering, "contract back" when exiting. Universal fullscreen
// vocabulary, reads as a mode toggle without a label.
const ICON_FOCUS_ENTER = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5V2h3M9 2h3v3M2 9v3h3M9 12h3V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_FOCUS_EXIT  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2v3H2M9 5h3V2M5 12V9H2M9 9v3h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function renderShell(): string {
  // .view-header carries the standard cross-view alignment (vertical
  // position, side indent, right-pad to clear the burger). The
  // editor-specific behaviour piggybacks on it via the .editor-bar
  // modifier — we only override what's specific (justify-content
  // space-between to split left/right halves).
  return `
    <header class="view-header editor-bar">
      <div class="editor-bar-left">
        <button type="button" class="editor-bar-btn editor-focus-btn"  title="Writer mode" aria-label="Toggle writer mode" aria-pressed="false">${ICON_FOCUS_ENTER}</button>
        <button type="button" class="editor-bar-btn editor-new-btn"    title="New (⌘N)" aria-label="New">${ICON_PLUS}</button>
        <button type="button" class="editor-bar-btn editor-copy-btn"   title="Copy document" aria-label="Copy document">${ICON_COPY}</button>
        <button type="button" class="editor-bar-btn editor-delete-btn" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
      <div class="editor-bar-right">
        <span class="editor-meta" id="editor-meta"></span>
        <div class="editor-doc-wrap">
          <button type="button" class="editor-doc-trigger" aria-haspopup="menu" aria-expanded="false">
            <span class="editor-doc-trigger-title">Untitled</span>
            <span class="editor-doc-trigger-chevron" aria-hidden="true">▾</span>
          </button>
          <div class="editor-doc-menu" id="editor-doc-menu" hidden role="menu"></div>
        </div>
      </div>
    </header>
    <main class="editor-main">
      <div class="editor-page">
        <!-- The mirror sits behind the textarea, rendering the same
             content with per-line styling for # / ## headings. The
             textarea above has color: transparent + a visible caret;
             they share font, padding and line-height so the cursor
             lands on the rendered text. -->
        <div class="editor-mirror" id="editor-mirror" aria-hidden="true"></div>
        <textarea class="editor-textarea" id="editor-textarea" spellcheck="true" placeholder="Start writing…"></textarea>
      </div>
    </main>
  `
}

// Build the mirror's HTML from the textarea's plain-text source.
// Lines starting with `# ` become H1; `## ` become H2. Empty lines
// emit a zero-width space so they retain row height. The marker
// (`#` / `##`) is wrapped in a faded span so the syntax visually
// recedes; widths still match the source character-for-character so
// the textarea cursor lines up with the rendered text.
function buildMirror(text: string): string {
  return text.split('\n').map((line) => {
    const m = line.match(/^(#{1,2})( .*)?$/)
    if (m) {
      const level = m[1].length          // 1 or 2
      const rest = m[2] || ''            // includes leading space if present
      return `<div class="m-h${level}"><span class="m-marker">${m[1]}</span>${escapeHtml(rest)}</div>`
    }
    if (line === '') return '<div class="m-line">​</div>'    // ZWSP keeps row height
    return `<div class="m-line">${escapeHtml(line)}</div>`
  }).join('')
}

function syncMirror() {
  if (!textareaEl || !mirrorEl) return
  mirrorEl.innerHTML = buildMirror(textareaEl.value)
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

function currentDoc(): DocSummary | null {
  if (!currentSlug) return null
  return docs.find((d) => d.slug === currentSlug) || null
}

function setTriggerTitle() {
  if (!triggerTitleEl) return
  const d = currentDoc()
  triggerTitleEl.textContent = d?.title || 'Untitled'
}

function renderDocMenu() {
  if (!menuEl) return
  if (!docs.length) {
    menuEl.innerHTML = '<div class="editor-doc-empty">No notes yet.</div>'
    return
  }
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
                role="menuitem"
                title="${escapeHtml(d.title)}">
          <span class="editor-doc-title">${escapeHtml(d.title)}</span>
          <span class="editor-doc-time">${escapeHtml(relTime(d.updated_at))}</span>
        </button>
      `)
    }
  }
  menuEl.innerHTML = parts.join('')
}

function openMenu() {
  if (!menuEl || !triggerEl) return
  renderDocMenu()
  menuEl.hidden = false
  triggerEl.setAttribute('aria-expanded', 'true')
  // Defer install so the click that opened the menu doesn't
  // immediately close it. Escape works from anywhere while the menu
  // is open, not just when the textarea has focus.
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick)
    document.addEventListener('keydown', onMenuKeydown)
  }, 0)
}

function closeMenu() {
  if (!menuEl || !triggerEl) return
  menuEl.hidden = true
  triggerEl.setAttribute('aria-expanded', 'false')
  document.removeEventListener('click', onOutsideClick)
  document.removeEventListener('keydown', onMenuKeydown)
}

function onOutsideClick(e: MouseEvent) {
  if (!menuEl || !triggerEl) return
  const target = e.target as Node
  if (menuEl.contains(target) || triggerEl.contains(target)) return
  closeMenu()
}

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
  }
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

// Match the textarea's height to its content so the page reads as a
// scroll of prose, not a fixed-height frame with an inner scrollbar.
// The mirror tracks the textarea's height implicitly — both share the
// same .editor-page container and font metrics, so identical input
// produces identical wrapping.
function autosize() {
  if (!textareaEl) return
  textareaEl.style.height = 'auto'
  textareaEl.style.height = textareaEl.scrollHeight + 'px'
}

async function loadDoc(slug: string) {
  if (!textareaEl) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flushSave() }
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    currentSlug = String(data.slug || slug)
    textareaEl.value = String(data.content || '')
    try { localStorage.setItem(LAST_OPEN_KEY, currentSlug) } catch { /* ignore */ }
    setTriggerTitle()
    setMetaForCurrent()
    syncMirror()
    autosize()
    textareaEl.focus()
    const len = textareaEl.value.length
    try { textareaEl.setSelectionRange(len, len) } catch { /* ignore */ }
  } catch (err) {
    console.error('[editor] loadDoc failed:', err)
  }
}

async function newDoc() {
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

// Copy the entire document (raw markdown) to the clipboard, with a
// brief icon swap to a checkmark for visual confirmation. Falls back
// to the textarea + execCommand path on contexts where
// navigator.clipboard isn't available (insecure origin, some
// embedded webviews).
async function copyDoc() {
  if (!textareaEl || !copyBtnEl) return
  const text = textareaEl.value
  let ok = false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      ok = true
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
  } catch (err) {
    console.error('[editor] copy failed:', err)
  }
  if (!ok) return
  const original = copyBtnEl.innerHTML
  copyBtnEl.innerHTML = ICON_CHECK
  copyBtnEl.classList.add('is-copied')
  window.setTimeout(() => {
    if (!copyBtnEl) return
    copyBtnEl.classList.remove('is-copied')
    copyBtnEl.innerHTML = original
  }, 1200)
}

async function deleteCurrent() {
  const d = currentDoc()
  if (!d) return
  const ok = window.confirm(`Delete "${d.title}"? This cannot be undone.`)
  if (!ok) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(d.slug)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.error('[editor] delete failed:', err)
    return
  }
  docs = docs.filter((x) => x.slug !== d.slug)
  try { localStorage.removeItem(LAST_OPEN_KEY) } catch { /* ignore */ }
  if (docs.length) {
    await loadDoc(docs[0].slug)
  } else {
    await newDoc()
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
    const idx = docs.findIndex((d) => d.slug === slug)
    if (idx >= 0) {
      docs[idx] = {
        slug,
        title: String(data.title || docs[idx].title),
        updated_at: String(data.updated_at || new Date().toISOString()),
        size: Number(data.size || content.length),
      }
      const [moved] = docs.splice(idx, 1)
      docs.unshift(moved)
    }
    setTriggerTitle()
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
  triggerEl!.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menuEl!.hidden) openMenu()
    else                closeMenu()
  })
  menuEl!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.editor-doc-item')
    if (!btn) return
    const slug = btn.dataset.slug || ''
    closeMenu()
    if (!slug || slug === currentSlug) return
    void loadDoc(slug)
  })
  viewEl.querySelector<HTMLButtonElement>('.editor-new-btn')!
    .addEventListener('click', () => { void newDoc() })
  viewEl.querySelector<HTMLButtonElement>('.editor-delete-btn')!
    .addEventListener('click', () => { void deleteCurrent() })
  copyBtnEl = viewEl.querySelector<HTMLButtonElement>('.editor-copy-btn')!
  copyBtnEl.addEventListener('click', () => { void copyDoc() })

  const focusBtn = viewEl.querySelector<HTMLButtonElement>('.editor-focus-btn')!
  focusBtn.addEventListener('click', () => {
    // Writer mode = body class + icon swap. The CSS hides everything
    // outside the writing surface (top nav, burger, the rest of the
    // bar), leaving just the page and this one icon.
    const on = document.body.classList.toggle('editor-writer-mode')
    focusBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    focusBtn.innerHTML = on ? ICON_FOCUS_EXIT : ICON_FOCUS_ENTER
    // Make sure the textarea has focus when the user enters writer
    // mode — they came here to type, not to look at chrome.
    if (on) textareaEl?.focus()
  })

  textareaEl!.addEventListener('input', () => { syncMirror(); autosize(); scheduleSave() })
  textareaEl!.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      void flushSave()
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      void newDoc()
    }
    // Escape while the menu is open is handled by onMenuKeydown
    // (installed at openMenu, removed at closeMenu) so it works
    // whether or not the textarea has focus.
  })

  window.addEventListener('pagehide', () => {
    if (!textareaEl || !currentSlug) return
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try {
      const blob = new Blob([JSON.stringify({ content: textareaEl.value })], { type: 'application/json' })
      navigator.sendBeacon(`/api/editor/doc/${encodeURIComponent(currentSlug)}`, blob)
    } catch { /* best-effort */ }
  })
}

// External slug-load: any code anywhere in the app can fire
// `poise:editor-load-doc` with { slug } to open a specific document.
// main.ts uses this when /content in the chat pane finishes
// authoring — chat dispatches poise:open-editor-doc, main.ts
// switches the view + re-dispatches the load event for us. We need
// to refresh the doc list first (the new article won't be in our
// in-memory `docs` array yet).
window.addEventListener('poise:editor-load-doc', (ev) => {
  const slug = (ev as CustomEvent<{ slug: string }>).detail?.slug
  if (!slug) return
  void (async () => {
    if (!initialized) {
      // initEditorView hasn't run yet — main.ts switchTo('editor')
      // triggers it. Wait one tick.
      await new Promise((r) => setTimeout(r, 100))
    }
    await fetchDocs()
    await loadDoc(slug)
  })()
})

export async function initEditorView() {
  viewEl = document.getElementById('view-editor')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    textareaEl     = viewEl.querySelector<HTMLTextAreaElement>('.editor-textarea')
    mirrorEl       = viewEl.querySelector<HTMLElement>('#editor-mirror')
    triggerEl      = viewEl.querySelector<HTMLButtonElement>('.editor-doc-trigger')
    triggerTitleEl = viewEl.querySelector<HTMLElement>('.editor-doc-trigger-title')
    menuEl         = viewEl.querySelector<HTMLElement>('#editor-doc-menu')
    metaEl         = viewEl.querySelector<HTMLElement>('#editor-meta')
    attachHandlers()
  }
  await fetchDocs()
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

export function stopEditorRefresh() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    void flushSave()
  }
  closeMenu()
  // Strip the writer-mode body class on view leave — otherwise the
  // hidden top nav stays hidden once you come back from another view
  // and the user is stuck.
  document.body.classList.remove('editor-writer-mode')
}
