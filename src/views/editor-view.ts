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
//
// Surface: the writing area is a single `<div contenteditable>` whose
// children are per-line `<div class="editor-line" data-kind=...>`
// blocks. Each line's data-kind (h1 / h2 / body) is recomputed on every
// `input` from its leading `#` / `##` token, and CSS sizes the line
// accordingly — H1 28px, H2 22px, body 19px, each with its own
// line-height. The native caret rides the rendered text because there's
// no mirror to drift against; this replaces an earlier textarea+mirror
// approach where different per-line font-sizes broke cursor alignment.

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
let docEl: HTMLElement | null = null
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
        <!-- Single contenteditable surface. Children are per-line
             <div class="editor-line" data-kind="h1|h2|body"> blocks
             whose font-size/line-height come from CSS. The native
             caret tracks rendered text directly — no mirror layer. -->
        <div class="editor-doc" id="editor-doc" contenteditable="true" spellcheck="true" data-empty="true"></div>
      </div>
    </main>
  `
}

// Classify a single line by its leading markdown token. Only `# ` and
// `## ` produce headings — H3+ isn't supported (intentional: the
// editor's spec is "minimal markup"). Lines that are bare `#` or `##`
// without a trailing space stay as body until the user adds the space,
// matching CommonMark/iA Writer behaviour.
function lineKindFor(text: string): 'h1' | 'h2' | 'body' {
  if (/^## /.test(text)) return 'h2'
  if (/^# /.test(text))  return 'h1'
  return 'body'
}

// Build a fresh line element. Empty lines need a <br> filler so they
// retain row height in contenteditable; non-empty lines hold a single
// text node so cursor offsets match string offsets one-to-one.
function buildLineEl(text: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'editor-line'
  div.dataset.kind = lineKindFor(text)
  if (text === '') div.appendChild(document.createElement('br'))
  else             div.textContent = text
  return div
}

// Replace every child of #editor-doc with one line div per `\n`-split
// row of the source markdown. Preserves the round-trip — what comes out
// of serializeDoc(load(x)) is exactly x for any well-formed document.
function loadIntoEditor(content: string) {
  if (!docEl) return
  docEl.innerHTML = ''
  const lines = content === '' ? [''] : content.split('\n')
  for (const line of lines) docEl.appendChild(buildLineEl(line))
  updateEmptyState()
}

// Walk the per-line divs, take each one's plain text, join with `\n`.
// textContent transparently strips the <br> filler from empty lines,
// so empty rows serialize back to '' and rejoin into the right string.
function serializeDoc(): string {
  if (!docEl) return ''
  const lines: string[] = []
  for (const child of Array.from(docEl.children)) {
    lines.push((child as HTMLElement).textContent || '')
  }
  return lines.join('\n')
}

function updateEmptyState() {
  if (!docEl) return
  const text = serializeDoc()
  if (text === '') docEl.dataset.empty = 'true'
  else             docEl.removeAttribute('data-empty')
}

// Re-classify every line and clean up structure. Runs on every input
// event; cheap because (a) it touches data-kind only when it changed,
// (b) the doc tree is shallow (one div per line), and (c) we never
// rebuild text content — just the per-line kind attribute, which leaves
// the cursor untouched.
function reclassifyLines() {
  if (!docEl) return
  // The browser sometimes promotes the contenteditable into containing
  // bare text nodes (e.g. when typing into an empty doc) or stray <br>s
  // at the root. Wrap any of those in editor-line divs so the
  // per-line model stays consistent.
  for (const node of Array.from(docEl.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const wrap = buildLineEl(node.textContent || '')
      docEl.replaceChild(wrap, node)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'BR') {
        const wrap = buildLineEl('')
        docEl.replaceChild(wrap, node)
      } else if (!el.classList.contains('editor-line')) {
        // Some other element snuck in (e.g. <p> from a paste). Re-wrap
        // it as a line and pull the text across.
        const wrap = buildLineEl(el.textContent || '')
        docEl.replaceChild(wrap, node)
      }
    }
  }
  // Now every child is an .editor-line div. Update kinds + empty filler.
  for (const child of Array.from(docEl.children)) {
    const el = child as HTMLElement
    const txt = el.textContent || ''
    const kind = lineKindFor(txt)
    if (el.dataset.kind !== kind) el.dataset.kind = kind
    // Empty line needs a <br> filler so contenteditable gives it
    // height and the caret can land on it. If text is non-empty but
    // contains a stray <br>, leave it alone — browsers sometimes add
    // <br> after the last character on a line and removing it eats a
    // useful trailing space.
    if (txt === '' && !el.querySelector('br')) {
      el.appendChild(document.createElement('br'))
    }
  }
  // If the doc somehow got emptied entirely, restore one empty line
  // so the cursor has a place to live.
  if (docEl.children.length === 0) {
    docEl.appendChild(buildLineEl(''))
  }
}

function setMeta(text: string) {
  if (metaEl) metaEl.textContent = text
}

function wordCount(s: string): number {
  return (s.match(/\S+/g) || []).length
}

function setMetaForCurrent() {
  const wc = wordCount(serializeDoc())
  setMeta(wc === 0 ? 'Empty · saved' : `${wc} word${wc === 1 ? '' : 's'} · saved`)
}

function currentDoc(): DocSummary | null {
  if (!currentSlug) return null
  return docs.find((d) => d.slug === currentSlug) || null
}

// Trigger label is space-constrained — the bar lives at 680px max
// and shares the row with three icons + meta. Truncate to 20 chars
// with an ellipsis so long titles don't push the trigger off the
// bar. The full title still shows in the dropdown menu items.
function truncateTitleForTrigger(s: string): string {
  return s.length > 20 ? s.slice(0, 19).trimEnd() + '…' : s
}

function setTriggerTitle() {
  if (!triggerTitleEl) return
  const d = currentDoc()
  const full = d?.title || 'Untitled'
  triggerTitleEl.textContent = truncateTitleForTrigger(full)
  triggerTitleEl.title = full     // hover-tooltip shows the full title
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

// Place the caret at the end of the editor (e.g. after loading a doc).
// Used so a freshly-loaded article doesn't pin the cursor at offset 0
// inside the first heading — natural to land where the writer left off.
function placeCaretAtEnd() {
  if (!docEl) return
  const last = docEl.lastElementChild as HTMLElement | null
  if (!last) return
  const range = document.createRange()
  // Walk to the deepest text node so the caret lands inside text rather
  // than after a <br> filler — those produce a "phantom row" caret.
  let target: Node = last
  while (target.lastChild && target.lastChild.nodeType !== Node.TEXT_NODE && target.lastChild.nodeName !== 'BR') {
    target = target.lastChild
  }
  if (target.lastChild && target.lastChild.nodeType === Node.TEXT_NODE) {
    target = target.lastChild
    range.setStart(target, (target.textContent || '').length)
  } else {
    range.selectNodeContents(target)
    range.collapse(false)
  }
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

async function loadDoc(slug: string) {
  if (!docEl) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flushSave() }
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    currentSlug = String(data.slug || slug)
    loadIntoEditor(String(data.content || ''))
    try { localStorage.setItem(LAST_OPEN_KEY, currentSlug) } catch { /* ignore */ }
    setTriggerTitle()
    setMetaForCurrent()
    docEl.focus()
    placeCaretAtEnd()
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
  if (!docEl || !copyBtnEl) return
  const text = serializeDoc()
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
  if (!docEl || !currentSlug || saveInFlight) return
  saveInFlight = true
  setMeta('Saving…')
  const slug = currentSlug
  const content = serializeDoc()
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
  if (!docEl || !currentSlug) return
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
    // Make sure the editor has focus when the user enters writer mode
    // — they came here to type, not to look at chrome.
    if (on) docEl?.focus()
  })

  // Force browser to use <div> (not <p> or <br>) for paragraph splits
  // on Enter, so our line model stays consistent across browsers. Set
  // once at handler attach; some browsers ignore it but Chrome/Safari
  // honour it. Firefox uses <br> by default; reclassifyLines wraps
  // anything we don't recognize into editor-line divs so the model
  // doesn't drift.
  try { document.execCommand('defaultParagraphSeparator', false, 'div') } catch { /* ignore */ }

  // Block native rich-text shortcuts (Cmd+B, Cmd+I, Cmd+U) — those wrap
  // selection in <b>/<i>/<u> tags which serialize back to plain text
  // (good) but render as visually rich for the session (confusing in a
  // markdown editor — the user expects to type **bold** for bold).
  docEl!.addEventListener('beforeinput', (e: InputEvent) => {
    const t = e.inputType
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline'
        || t === 'formatStrikeThrough' || t === 'formatSuperscript'
        || t === 'formatSubscript') {
      e.preventDefault()
    }
  })

  // Force plain-text paste — markdown editor: any HTML/styled content
  // would inject inline styles and tags we'd then have to scrub.
  docEl!.addEventListener('paste', (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') || ''
    // insertText respects the line model: newlines split into new
    // editor-line divs via the browser's normal Enter handling.
    document.execCommand('insertText', false, text)
  })

  // Drag-and-drop also tries to inject HTML; force plain-text the same
  // way as paste.
  docEl!.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const text = e.dataTransfer?.getData('text/plain') || ''
    if (!text) return
    document.execCommand('insertText', false, text)
  })

  docEl!.addEventListener('input', () => {
    reclassifyLines()
    updateEmptyState()
    scheduleSave()
  })

  docEl!.addEventListener('keydown', (e) => {
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
    // whether or not the editor has focus.
  })

  window.addEventListener('pagehide', () => {
    if (!docEl || !currentSlug) return
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try {
      const blob = new Blob([JSON.stringify({ content: serializeDoc() })], { type: 'application/json' })
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
    docEl          = viewEl.querySelector<HTMLElement>('#editor-doc')
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
