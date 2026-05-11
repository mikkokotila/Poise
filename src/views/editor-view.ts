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

// Side-car annotations attached to ranges in the doc. The schema
// mirrors server/editor.ts (Annotation). Ranges are line + char-offset
// pairs; the snippet is the highlighted text at create time and
// re-anchors the annotation if the user inserts/removes lines above
// it. session_id is plumbing for Phase 2 (chat per annotation) and
// equals the annotation id by default.
interface AnnotationRange {
  start_line: number
  start_offset: number
  end_line: number
  end_offset: number
}
interface Annotation {
  id: string
  session_id: string
  range: AnnotationRange
  snippet: string
  comment: string
  created_at: string
  updated_at: string
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

// Annotation state. The list is the source of truth in memory; the
// overlay layer below the editor renders one or more thin underline
// rects per annotation, positioned with Range.getClientRects. The
// floating Comment button appears when a non-collapsed selection
// covers some text; clicking it creates a new annotation and opens
// the panel for it. The panel is a single floating element shared
// across annotations — only one is visible at a time.
let annotations: Annotation[] = []
let overlayEl: HTMLElement | null = null
let commentBtnEl: HTMLButtonElement | null = null
let panelEl: HTMLElement | null = null
let panelForId: string | null = null
let annotationsSaveTimer: ReturnType<typeof setTimeout> | null = null
let annotationsSaveInFlight = false

const SAVE_DEBOUNCE_MS = 500
const ANNOTATIONS_SAVE_DEBOUNCE_MS = 400
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
        <!-- Annotation overlay: absolutely-positioned underline rects
             live here, one per Range.getClientRects() result per
             annotation. Behind the editor in z-order so the caret
             stays selectable; the rects themselves use pointer-events
             so clicks open the comment panel. -->
        <div class="editor-annotations" id="editor-annotations" aria-hidden="true"></div>
      </div>
      <!-- Floating Comment button: shown only when a non-collapsed
           selection covers some text in the editor. Click → create
           annotation + open panel. -->
      <button type="button" class="editor-comment-btn" id="editor-comment-btn" hidden aria-label="Add comment">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 11.5 4v4a1.5 1.5 0 0 1-1.5 1.5H6.5L4 12V9.5a1.5 1.5 0 0 1-1.5-1.5V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </button>
      <!-- Comment panel: floating, anchored near the clicked
           annotation. Shared across annotations — only one is open
           at a time. -->
      <div class="editor-annotation-panel" id="editor-annotation-panel" hidden role="dialog" aria-label="Annotation"></div>
    </main>
  `
}

// Line-kind taxonomy. Block-level kinds the editor recognises:
//   - h1 / h2 / body: classified per-line from the leading `#` / `##`.
//   - list-item: a line whose text starts with `- ` (hyphen + space).
//     The `- ` marker is hidden (same .md-marker rule as headings) and
//     a styled bullet renders via ::before; CSS gives the line a
//     leading indent so the bullet sits at the left margin and the
//     content reads as visually nested.
//   - code-fence-open / code-fence-close / code-content: triple-backtick
//     fenced code block. The opening fence is a line whose text starts
//     with ```` (optionally followed by a language tag); the closing
//     fence is a line whose text equals exactly ```` (no language).
//     Lines between are code-content. Detection requires looking at
//     surrounding lines, not just one — see classifyAllLines.
type LineKind = 'h1' | 'h2' | 'body' | 'list-item' | 'code-fence-open' | 'code-fence-close' | 'code-content'

// Classify a single line by its leading markdown token. Only `# ` and
// `## ` produce headings — H3+ isn't supported (intentional: the
// editor's spec is "minimal markup"). `- ` produces a list item.
// Bare `#`, `##`, or `-` without a trailing space stay as body until
// the user adds the space, matching CommonMark / iA Writer behaviour.
// Code-block kinds are NOT computed here — they need cross-line state
// from classifyAllLines.
function lineKindFor(text: string): 'h1' | 'h2' | 'body' | 'list-item' {
  if (/^## /.test(text)) return 'h2'
  if (/^# /.test(text))  return 'h1'
  if (/^- /.test(text))  return 'list-item'
  return 'body'
}

// Walk a list of line texts in order and produce one kind per line.
// State machine: outside a code block, lines are h1/h2/body via
// lineKindFor; encountering a line that starts with ```` opens a
// block, lines between are code-content, and a line whose text is
// exactly ```` closes the block. Unclosed openers run to end-of-doc
// (everything past the open is code-content) — which is the same
// behaviour CommonMark / iA Writer / Typora exhibit.
function classifyAllLines(texts: string[]): LineKind[] {
  const out: LineKind[] = []
  let inBlock = false
  for (const text of texts) {
    if (inBlock) {
      if (text === '```') { out.push('code-fence-close'); inBlock = false }
      else                { out.push('code-content') }
    } else {
      if (/^```/.test(text)) { out.push('code-fence-open'); inBlock = true }
      else                   { out.push(lineKindFor(text)) }
    }
  }
  return out
}

// The visible-prefix length each kind hides. CSS sets the marker span
// to `display: none`, so the user only sees the "rest" of the line.
// For code-fence kinds, the entire line is the marker — markerLengthFor
// returns the length so callers (snap logic) treat the whole line as
// a hidden prefix.
function markerLengthFor(kind: LineKind, lineText: string = ''): number {
  if (kind === 'h1') return 2
  if (kind === 'h2') return 3
  if (kind === 'list-item') return 2     // `- ` prefix
  if (kind === 'code-fence-open' || kind === 'code-fence-close') return lineText.length
  return 0
}

// Inline-segment model. A line's "rest" (everything after the optional
// block marker) is parsed into a flat sequence of plain text, bold
// (`**…**`) and code (`` `…` ``) runs. Italic isn't in the spec,
// which removes the parser's need to disambiguate `*` vs `**`. Code
// and bold can't nest — whichever delimiter opens first wins, and
// the other delimiter inside that run stays as literal text. Pairs
// are matched greedy left-to-right; unmatched delimiters and empty
// pairs (`****`, ` `` `) stay as plain text.
type InlineSegment =
  | { kind: 'text', text: string }
  | { kind: 'bold', text: string }
  | { kind: 'code', text: string }

function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  let i = 0
  while (i < text.length) {
    // Pick the nearest opener. Bold (`**`) and code (`` ` ``) compete
    // by position; ties prefer bold (rare since `**` is two chars).
    const boldOpen = text.indexOf('**', i)
    const codeOpen = text.indexOf('`', i)
    let openType: 'bold' | 'code' | null = null
    let openAt = -1
    if (boldOpen !== -1 && (codeOpen === -1 || boldOpen <= codeOpen)) {
      openType = 'bold'
      openAt = boldOpen
    } else if (codeOpen !== -1) {
      openType = 'code'
      openAt = codeOpen
    }
    if (openType === null) { out.push({ kind: 'text', text: text.slice(i) }); break }
    if (openAt > i) out.push({ kind: 'text', text: text.slice(i, openAt) })

    if (openType === 'bold') {
      const close = text.indexOf('**', openAt + 2)
      if (close === -1) { out.push({ kind: 'text', text: text.slice(openAt) }); break }
      const inner = text.slice(openAt + 2, close)
      if (inner === '') {
        out.push({ kind: 'text', text: text.slice(openAt, close + 2) })
      } else {
        out.push({ kind: 'bold', text: inner })
      }
      i = close + 2
    } else {
      const close = text.indexOf('`', openAt + 1)
      if (close === -1) { out.push({ kind: 'text', text: text.slice(openAt) }); break }
      const inner = text.slice(openAt + 1, close)
      if (inner === '') {
        out.push({ kind: 'text', text: text.slice(openAt, close + 1) })
      } else {
        out.push({ kind: 'code', text: inner })
      }
      i = close + 1
    }
  }
  // Coalesce consecutive plain-text runs so the DOM stays minimal —
  // adjacent text nodes confuse cursor accounting and offer no benefit.
  const merged: InlineSegment[] = []
  for (const seg of out) {
    const last = merged[merged.length - 1]
    if (seg.kind === 'text' && last && last.kind === 'text') {
      last.text += seg.text
    } else {
      merged.push(seg)
    }
  }
  return merged
}

// Build an inline wrapper element (<strong> or <code>) with the
// leading + trailing markers in hidden spans flanking the visible
// inner text. The marker text differs (`**` for bold, `` ` `` for
// code) but the structure is the same — three children, marker /
// text / marker — so the rest of the editor can treat them as one
// shape via `wrap.tagName === 'STRONG' || wrap.tagName === 'CODE'`.
function buildInlineWrap(tag: 'strong' | 'code', marker: string, inner: string): HTMLElement {
  const wrap = document.createElement(tag)
  const open = document.createElement('span')
  open.className = 'md-marker'
  open.textContent = marker
  const text = document.createTextNode(inner)
  const close = document.createElement('span')
  close.className = 'md-marker'
  close.textContent = marker
  wrap.appendChild(open)
  wrap.appendChild(text)
  wrap.appendChild(close)
  return wrap
}

function buildBoldEl(inner: string): HTMLElement { return buildInlineWrap('strong', '**', inner) }
function buildCodeEl(inner: string): HTMLElement { return buildInlineWrap('code',  '`',  inner) }

// Build a fresh line element. Behaviour by kind:
//   - h1 / h2 / list-item: the leading `# ` / `## ` / `- ` prefix is
//     wrapped in a hidden marker span; the rest is parsed for inline
//     bold/code and split into text nodes + <strong> / <code>
//     wrappers. Lines ending in a wrapper get an empty-text sentinel
//     for caret anchoring.
//   - body: as h1/h2/list-item but no leading marker.
//   - code-fence-open / code-fence-close: the WHOLE textContent is
//     the marker — wrapped in `<span class="md-marker">` so the
//     fence text disappears visually. The line div itself is still
//     in the DOM; CSS gives it min-height so it occupies a blank
//     line of vertical space, framing the code block.
//   - code-content: plain text in monospace, no inline parsing
//     (asterisks/backticks inside code are literal).
// All marker text stays in textContent so save and copy round-trip
// the true markdown.
function buildLineEl(text: string, kind: LineKind): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'editor-line'
  div.dataset.kind = kind

  if (kind === 'code-fence-open' || kind === 'code-fence-close') {
    if (text === '') {
      div.appendChild(document.createElement('br'))
    } else {
      const span = document.createElement('span')
      span.className = 'md-marker'
      span.textContent = text
      div.appendChild(span)
    }
    return div
  }

  if (kind === 'code-content') {
    if (text === '') div.appendChild(document.createElement('br'))
    else             div.appendChild(document.createTextNode(text))
    return div
  }

  const prefixLen = markerLengthFor(kind)
  const prefix = text.slice(0, prefixLen)
  const rest = text.slice(prefixLen)
  if (prefix) {
    const span = document.createElement('span')
    span.className = 'md-marker'
    span.textContent = prefix
    div.appendChild(span)
  }
  if (rest === '') {
    div.appendChild(document.createElement('br'))
    return div
  }
  const segs = parseInline(rest)
  for (const seg of segs) {
    if      (seg.kind === 'text') div.appendChild(document.createTextNode(seg.text))
    else if (seg.kind === 'bold') div.appendChild(buildBoldEl(seg.text))
    else                          div.appendChild(buildCodeEl(seg.text))
  }
  // Sentinel: when the line ends in a <strong> or <code>, append an
  // empty text node so the caret has a non-wrapper anchor at
  // end-of-line. Without this, Chrome treats a line-level caret
  // position immediately after a <strong>/<code> as "inside the
  // previous element" for typing purposes and routes characters back
  // into the wrapper's inner text — silently extending the bold/code
  // run. The empty text node is invisible, contributes zero to
  // textContent, and is allowed by lineMatchesModel.
  const last = segs[segs.length - 1]
  if (last && (last.kind === 'bold' || last.kind === 'code')) {
    div.appendChild(document.createTextNode(''))
  }
  return div
}

// Cursor-offset helpers — work in textContent character coordinates
// (i.e. counting hidden marker chars too) so we can preserve cursor
// position across line rebuilds. The marker span participates in the
// offset count: if the cursor was at offset 2 in `# Hello`, that's
// just-after the marker in DOM terms, which is offset 0 of the visible
// "Hello" — the right place after a body→h1 transition.
function getCursorOffsetInLine(line: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null
  if (!line.contains(sel.anchorNode)) return null
  let offset = 0
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node === sel.anchorNode) return offset + sel.anchorOffset
    offset += (node.textContent || '').length
  }
  // Anchor was inside line but not in a text node (e.g. before a <br>).
  return offset
}

function setCursorOffsetInLine(line: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node: Node | null
  const sel = window.getSelection()
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) {
      const localOffset = offset - acc
      const range = document.createRange()

      // Edge: when the cursor is exactly at the end of the trailing
      // marker of a <strong>/<code>, placing it inside that marker
      // means the user's next keystroke extends the wrapper (the
      // marker grows by one char, the parser still sees `**…X` /
      // `` `…X `` and re-parses with X inside). We want the opposite:
      // typing after a bold or code run should produce plain text.
      // Prefer the trailing empty-text sentinel buildLineEl appends
      // after a wrapped-ending line — that's a real text-node anchor
      // outside the wrapper. Failing that, place at line-level after
      // the wrapper; the sentinel will be re-added on the next
      // reclassify.
      if (localOffset === len && node.parentNode) {
        const markerSpan = node.parentNode as HTMLElement
        if (markerSpan.classList && markerSpan.classList.contains('md-marker')) {
          const wrap = markerSpan.parentNode as HTMLElement | null
          if (wrap && (wrap.tagName === 'STRONG' || wrap.tagName === 'CODE') && markerSpan === wrap.lastElementChild) {
            const sentinel = wrap.nextSibling
            if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
              range.setStart(sentinel, 0)
              range.collapse(true)
              if (sel) { sel.removeAllRanges(); sel.addRange(range) }
              return
            }
            const lineLevel = wrap.parentNode!
            const idx = Array.from(lineLevel.childNodes).indexOf(wrap) + 1
            range.setStart(lineLevel, idx)
            range.collapse(true)
            if (sel) { sel.removeAllRanges(); sel.addRange(range) }
            return
          }
        }
      }

      range.setStart(node, localOffset)
      range.collapse(true)
      if (sel) { sel.removeAllRanges(); sel.addRange(range) }
      return
    }
    acc += len
  }
  // Fallback: place caret at end of line
  const range = document.createRange()
  range.selectNodeContents(line)
  range.collapse(false)
  if (sel) { sel.removeAllRanges(); sel.addRange(range) }
}

// Convert a (container, offset) anchor inside a line to a single
// character offset within that line's textContent (which counts hidden
// marker chars). Used by copy/cut to slice the visible selection out
// of the markdown-bearing textContent.
//   - text-node container: char-offset in that text node + sum of
//     text lengths that come earlier in the line subtree.
//   - element container: offset is a child index; sum lengths of
//     children before that index, recursively.
function offsetInLineFor(line: HTMLElement, container: Node, offset: number): number {
  let acc = 0
  let found = false
  function visit(node: Node): void {
    if (found) return
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        acc += offset
      } else {
        const kids = node.childNodes
        for (let i = 0; i < offset && i < kids.length; i++) {
          acc += (kids[i].textContent || '').length
        }
      }
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      acc += (node.textContent || '').length
      return
    }
    for (const c of Array.from(node.childNodes)) visit(c)
  }
  visit(line)
  return acc
}

// Walk up from a node looking for an ancestor inline wrapper inside
// the editor. The shape (<strong> for bold, <code> for inline code)
// determines which marker the toggle-off path strips.
function inlineWrapAncestorOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n === docEl) return null
    if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as HTMLElement).tagName
      if (tag === 'STRONG' || tag === 'CODE') return n as HTMLElement
    }
    n = n.parentNode
  }
  return null
}

// Cmd+B is bold-only: toggle off only when the wrapper is <strong>.
function strongAncestorOf(node: Node | null): HTMLElement | null {
  const wrap = inlineWrapAncestorOf(node)
  return wrap && wrap.tagName === 'STRONG' ? wrap : null
}

// Detect a caret position whose next typed character will, by default,
// land inside the trailing marker of a <strong>/<code> and visually
// extend the wrapper. Three equivalent positions trigger this:
//   1. Caret at the end of the trailing marker's text node (inside
//      the marker span).
//   2. Caret at line-level immediately after a <strong>/<code> with
//      no following text node.
//   3. Caret in the post-wrapper sentinel (empty text node sibling
//      buildLineEl appends after a wrapped-ending line). The sentinel
//      is a real text-node anchor, but Chrome still routes typed
//      characters into the previous element when the sentinel is
//      empty — so we treat this as "caret at wrapper's edge" and
//      redirect the insertion to a fresh text sibling.
// In all three cases we redirect the insertion to a sibling text
// node after the wrapper, so typing produces plain text.
function inlineWrapAtCaretEdge(range: Range): HTMLElement | null {
  const node = range.startContainer
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentNode as HTMLElement | null
    if (!parent) return null
    // Case 1: inside trailing marker, at end of marker text.
    if (parent.classList.contains('md-marker')) {
      const wrap = parent.parentNode as HTMLElement | null
      if (!wrap || (wrap.tagName !== 'STRONG' && wrap.tagName !== 'CODE')) return null
      if (parent !== wrap.lastElementChild) return null
      if (range.startOffset !== (node.textContent || '').length) return null
      return wrap
    }
    // Case 3: in the empty sentinel sibling of a wrapper.
    if (node.textContent === '' && parent.classList.contains('editor-line')
        && node.previousSibling
        && node.previousSibling.nodeType === Node.ELEMENT_NODE) {
      const prev = node.previousSibling as HTMLElement
      if (prev.tagName === 'STRONG' || prev.tagName === 'CODE') return prev
    }
    return null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    if (!el.classList.contains('editor-line')) return null
    // Case 2: line-level position immediately after a wrapper.
    const prev = el.childNodes[range.startOffset - 1]
    if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null
    const tag = (prev as HTMLElement).tagName
    if (tag !== 'STRONG' && tag !== 'CODE') return null
    return prev as HTMLElement
  }
  return null
}

// Cmd+B handler. Three behaviours:
//   - Selection inside an existing <strong>: unbold (replace the
//     whole strong with its inner text node — markers fall away with
//     it). Uses direct DOM replacement; execCommand('insertText')
//     silently no-ops for selections that span an element boundary
//     in some Chromium versions.
//   - Non-empty selection elsewhere: wrap the visible selected text
//     with `**…**` via insertText. The next reclassify rebuilds the
//     line and the new markers fold into a <strong>.
//   - Collapsed selection: insert `****` and park the caret between
//     the two pairs, so the user can type the bold word and the line
//     reclassifies into a <strong> on the next input.
function toggleBoldAtSelection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (!docEl) return
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) return

  const strong = strongAncestorOf(range.commonAncestorContainer)
  if (strong) {
    // Toggle off — direct DOM replacement, then run the post-edit
    // pipeline ourselves since no input event fires.
    const inner = strong.childNodes[1]
    const innerText = (inner && inner.nodeType === Node.TEXT_NODE) ? (inner.textContent || '') : ''
    const textNode = document.createTextNode(innerText)
    strong.parentNode!.replaceChild(textNode, strong)
    const r = document.createRange()
    r.setStart(textNode, innerText.length)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    reclassifyLines()
    updateEmptyState()
    scheduleSave()
    return
  }

  if (range.collapsed) {
    document.execCommand('insertText', false, '****')
    // Move caret back 2 visible chars so the user lands between the
    // two `**` pairs. modify() is non-standard but supported in all
    // contemporary browsers; we wrap in try so a missing impl
    // degrades to "caret stays at end" rather than throwing.
    try {
      sel.modify('move', 'backward', 'character')
      sel.modify('move', 'backward', 'character')
    } catch { /* ignore — caret stays after **** */ }
    return
  }

  const visible = sel.toString()
  document.execCommand('insertText', false, '**' + visible + '**')
}

// Find the textContent offset where a given descendant node's content
// starts within the line. Used by the inline marker-snap logic to
// locate <strong> wrappers in line-relative coordinates.
function offsetOfNodeInLine(line: HTMLElement, node: Node): number {
  let acc = 0
  let found = false
  function visit(n: Node): void {
    if (found) return
    if (n === node) { found = true; return }
    if (n.nodeType === Node.TEXT_NODE) acc += (n.textContent || '').length
    else if (n.nodeType === Node.ELEMENT_NODE) {
      for (const c of Array.from(n.childNodes)) visit(c)
    }
  }
  visit(line)
  return found ? acc : -1
}

// Walk #editor-doc's children and emit, per line that intersects the
// range, the visible slice of that line's textContent — with the
// hidden marker added back ONLY when the selection covers the full
// visible content of the line OR of an inline run. Rationale:
//   - User selects all of "Heading One" (visible) → expects `# Heading One`
//     because that's the markdown form of what they selected.
//   - User selects "ead" inside "Heading One" → expects just "ead" —
//     they didn't select the whole heading.
//   - User selects whole "bold" inside `**bold**` → expects `**bold**`
//     because they selected the whole bold run.
//   - User selects "ol" inside `**bold**` → expects just "ol".
// Concretely, for each touched line we compute clipped offsets in
// textContent space; for the block heading prefix we snap start to 0
// when the slice covers visualStart..visualEnd; for each <strong> we
// expand the slice outward when it covers the strong's full visible
// inner content. Otherwise we snap past hidden marker chars so partial
// slices don't pick them up.
function reconstructMarkdownFromRange(range: Range): string | null {
  if (!docEl) return null
  const out: string[] = []
  for (const child of Array.from(docEl.children)) {
    const line = child as HTMLElement
    if (!line.classList.contains('editor-line')) continue
    if (!range.intersectsNode(line)) continue

    const kind = (line.dataset.kind as LineKind) || 'body'
    const lineText = line.textContent || ''

    // Code-fence lines are entirely hidden marker — there's no
    // "visible content" to slice. If the range touches a fence line
    // at all, emit the whole fence text. (The user might be selecting
    // an empty-looking line; copying out the markdown is the right
    // round-trip.) Code-content lines have only visible text and no
    // hidden markers, so the standard slice produces the right text
    // without any marker snap.
    if (kind === 'code-fence-open' || kind === 'code-fence-close') {
      out.push(lineText)
      continue
    }

    const markerLen = markerLengthFor(kind, lineText)

    let startOffset = 0
    let endOffset = lineText.length
    if (line.contains(range.startContainer) || line === range.startContainer) {
      startOffset = offsetInLineFor(line, range.startContainer, range.startOffset)
    }
    if (line.contains(range.endContainer) || line === range.endContainer) {
      endOffset = offsetInLineFor(line, range.endContainer, range.endOffset)
    }

    // Block-level snap: include the heading marker only if the slice
    // covers the line's full visible content.
    const coversWholeVisible = startOffset <= markerLen && endOffset >= lineText.length
    let s = coversWholeVisible ? 0 : Math.max(startOffset, markerLen)
    let e = endOffset

    // Inline snap: for each inline wrapper (<strong> or <code>) in
    // the line, if the slice covers its full visible inner text,
    // expand outward to include the surrounding markers (`**` for
    // strong, `` ` `` for code). We use the original startOffset/
    // endOffset (visible bounds) for the comparison so the heading
    // snap above doesn't double-count. Code-content lines have no
    // inline wrappers, so this loop is a no-op for them.
    for (const wrap of Array.from(line.querySelectorAll('strong, code'))) {
      const wrapStart = offsetOfNodeInLine(line, wrap)
      if (wrapStart < 0) continue
      const wrapEnd = wrapStart + (wrap.textContent || '').length
      const m = wrap.tagName === 'CODE' ? 1 : 2   // marker length
      const innerStart = wrapStart + m
      const innerEnd   = wrapEnd - m
      if (startOffset <= innerStart && endOffset >= innerEnd) {
        if (wrapStart < s) s = wrapStart
        if (wrapEnd   > e) e = wrapEnd
      }
    }

    if (e <= s) {
      // Selection touched this line but no visible content — keep the
      // entry as an empty string so the line break is preserved when
      // joining (selecting through a line break should produce a
      // newline in the clipboard).
      out.push('')
    } else {
      out.push(lineText.slice(s, e))
    }
  }
  return out.join('\n')
}

// Replace every child of #editor-doc with one line div per `\n`-split
// row of the source markdown. Preserves the round-trip — what comes out
// of serializeDoc(load(x)) is exactly x for any well-formed document.
function loadIntoEditor(content: string) {
  if (!docEl) return
  docEl.innerHTML = ''
  const lines = content === '' ? [''] : content.split('\n')
  const kinds = classifyAllLines(lines)
  for (let i = 0; i < lines.length; i++) {
    docEl.appendChild(buildLineEl(lines[i], kinds[i]))
  }
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

// Test whether a line's current DOM structure matches what
// buildLineEl(textContent, kind) would produce — used to decide
// whether to rebuild on input. Mismatch happens when:
//   - kind changed (user typed/erased a `#` marker prefix, or a
//     ``` fence appeared/disappeared somewhere up the doc)
//   - the marker span content drifted from its kind's prefix
//   - the inline-bold/code structure changed (user typed/closed a
//     `**` or `` ` `` pair, or broke one) so a wrapper needs to
//     appear / disappear / move
//   - any segment got split across multiple text nodes from browser
//     edit operations (cursor offset accounting depends on each
//     segment being a single text node).
// `kind` is supplied by the caller (classifyAllLines) because code-
// block kinds depend on cross-line state and can't be derived from
// the line's own text alone.
function lineMatchesModel(line: HTMLElement, kind: LineKind): boolean {
  if (line.dataset.kind !== kind) return false
  const txt = line.textContent || ''
  const children = Array.from(line.childNodes)

  if (kind === 'code-fence-open' || kind === 'code-fence-close') {
    if (txt === '') {
      return children.length === 1
        && children[0].nodeType === Node.ELEMENT_NODE
        && (children[0] as HTMLElement).tagName === 'BR'
    }
    return children.length === 1
      && children[0].nodeType === Node.ELEMENT_NODE
      && (children[0] as HTMLElement).classList.contains('md-marker')
      && children[0].textContent === txt
  }

  if (kind === 'code-content') {
    if (txt === '') {
      return children.length === 1
        && children[0].nodeType === Node.ELEMENT_NODE
        && (children[0] as HTMLElement).tagName === 'BR'
    }
    return children.length === 1
      && children[0].nodeType === Node.TEXT_NODE
      && children[0].textContent === txt
  }

  const prefixLen = markerLengthFor(kind)
  const expectedPrefix = txt.slice(0, prefixLen)
  const rest = txt.slice(prefixLen)
  let i = 0

  if (expectedPrefix !== '') {
    const first = children[i]
    if (!first || first.nodeType !== Node.ELEMENT_NODE) return false
    const fe = first as HTMLElement
    if (!fe.classList.contains('md-marker')) return false
    if (fe.textContent !== expectedPrefix) return false
    i++
  }

  if (rest === '') {
    // Empty rest: exactly one <br> filler.
    if (children.length !== i + 1) return false
    const br = children[i]
    return br.nodeType === Node.ELEMENT_NODE && (br as HTMLElement).tagName === 'BR'
  }

  const segs = parseInline(rest)
  // Lines that end in bold or code carry a trailing empty-text
  // sentinel (see buildLineEl) so the caret has a non-wrapper anchor
  // at end-of-line. Accept either segment-count OR segment-count+1
  // children remaining.
  const remaining = children.length - i
  const lastSeg = segs[segs.length - 1]
  const endsInWrap = !!lastSeg && (lastSeg.kind === 'bold' || lastSeg.kind === 'code')
  if (remaining !== segs.length && !(endsInWrap && remaining === segs.length + 1)) return false

  for (const seg of segs) {
    const node = children[i++]
    if (seg.kind === 'text') {
      // Plain segment: a single text node with the exact text.
      if (node.nodeType !== Node.TEXT_NODE) return false
      if (node.textContent !== seg.text) return false
    } else {
      // Inline wrapper segment: <strong> for bold or <code> for code,
      // each with three children — open marker, inner text, close
      // marker. The marker character differs (`**` vs `` ` ``), but
      // the structure is identical.
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      const expectedTag = seg.kind === 'bold' ? 'STRONG' : 'CODE'
      const expectedMarker = seg.kind === 'bold' ? '**' : '`'
      if (el.tagName !== expectedTag) return false
      if (el.childNodes.length !== 3) return false
      const open = el.childNodes[0]
      const inner = el.childNodes[1]
      const close = el.childNodes[2]
      if (open.nodeType !== Node.ELEMENT_NODE || !(open as HTMLElement).classList.contains('md-marker') || open.textContent !== expectedMarker) return false
      if (close.nodeType !== Node.ELEMENT_NODE || !(close as HTMLElement).classList.contains('md-marker') || close.textContent !== expectedMarker) return false
      if (inner.nodeType !== Node.TEXT_NODE || inner.textContent !== seg.text) return false
    }
  }

  // Sentinel check: when present, must be an empty text node.
  if (i < children.length) {
    const sentinel = children[i]
    if (sentinel.nodeType !== Node.TEXT_NODE || sentinel.textContent !== '') return false
  }

  return true
}

// Rebuild a line in place at the given kind, preserving cursor offset
// (in textContent coordinates, including any hidden marker characters).
// Replacing only the line's children (not the line div itself) keeps
// any external references to the div alive.
function rebuildLineInPlace(line: HTMLElement, kind: LineKind) {
  const txt = line.textContent || ''
  const cursor = getCursorOffsetInLine(line)
  const fresh = buildLineEl(txt, kind)
  line.dataset.kind = fresh.dataset.kind!
  line.innerHTML = ''
  while (fresh.firstChild) line.appendChild(fresh.firstChild)
  if (cursor !== null) setCursorOffsetInLine(line, cursor)
}

// Re-classify every line and clean up structure. Runs on every input
// event; the common case is "no structural change" and we touch
// nothing. When the user types a marker character (`# `, `## `, ``` )
// or breaks one (deleting through a marker), the affected line — and
// in the case of code-block fences, every line that follows in the
// block — gets rebuilt in place with cursor preserved at its
// textContent offset.
function reclassifyLines() {
  if (!docEl) return
  // The browser sometimes promotes the contenteditable into containing
  // bare text nodes (e.g. when typing into an empty doc) or stray <br>s
  // at the root. Wrap any of those in editor-line divs so the
  // per-line model stays consistent. We don't yet know each new line's
  // kind here — body is a safe placeholder; classifyAllLines below
  // will produce the real kind and trigger a rebuild if needed.
  for (const node of Array.from(docEl.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const wrap = buildLineEl(node.textContent || '', 'body')
      docEl.replaceChild(wrap, node)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'BR') {
        const wrap = buildLineEl('', 'body')
        docEl.replaceChild(wrap, node)
      } else if (!el.classList.contains('editor-line')) {
        // Some other element snuck in (e.g. <p> from a paste). Re-wrap
        // it as a line and pull the text across.
        const wrap = buildLineEl(el.textContent || '', 'body')
        docEl.replaceChild(wrap, node)
      }
    }
  }
  // Compute kinds doc-level (so code-block fences propagate) and
  // rebuild any line whose DOM doesn't match its expected shape.
  const lines = Array.from(docEl.children) as HTMLElement[]
  const texts = lines.map((l) => l.textContent || '')
  const kinds = classifyAllLines(texts)
  for (let idx = 0; idx < lines.length; idx++) {
    const el = lines[idx]
    if (!lineMatchesModel(el, kinds[idx])) {
      rebuildLineInPlace(el, kinds[idx])
    }
    // Ensure empty lines have a <br> filler.
    if ((el.textContent || '') === '' && !el.querySelector('br')) {
      el.appendChild(document.createElement('br'))
    }
  }
  // If the doc somehow got emptied entirely, restore one empty line
  // so the cursor has a place to live.
  if (docEl.children.length === 0) {
    docEl.appendChild(buildLineEl('', 'body'))
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
  closePanel()
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
    // Annotations live alongside the doc — load and render in parallel
    // with the markdown so the underlines appear when the doc does.
    await fetchAnnotations(currentSlug)
    renderAnnotationOverlay()
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

// ── Annotations ──────────────────────────────────────────────────────
//
// Annotations are highlight + comment pairs anchored to ranges in the
// doc. The list is fetched alongside loadDoc and persisted via a
// debounced PUT. Ranges are stored as line + char-offset pairs but
// re-anchored by snippet match on every render — so an annotation
// survives line shifts above it (the caller adds/removes paragraphs
// earlier in the doc) as long as the snippet remains uniquely
// findable. If the snippet vanishes, the annotation orphans (no
// overlay rendered, but the row stays in storage so the user's
// comment text isn't silently lost).

async function fetchAnnotations(slug: string): Promise<void> {
  annotations = []
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}/annotations`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    annotations = Array.isArray(data.annotations) ? (data.annotations as Annotation[]) : []
  } catch (err) {
    console.error('[editor] fetchAnnotations failed:', err)
    annotations = []
  }
}

async function flushAnnotationsSave(): Promise<void> {
  if (!currentSlug || annotationsSaveInFlight) return
  annotationsSaveInFlight = true
  const slug = currentSlug
  const body = JSON.stringify({ annotations })
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}/annotations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.error('[editor] save annotations failed:', err)
  } finally {
    annotationsSaveInFlight = false
  }
}

function scheduleAnnotationsSave(): void {
  if (!currentSlug) return
  if (annotationsSaveTimer) clearTimeout(annotationsSaveTimer)
  annotationsSaveTimer = setTimeout(() => { void flushAnnotationsSave() }, ANNOTATIONS_SAVE_DEBOUNCE_MS)
}

// Build a DOM Range from an annotation's stored line + char-offset
// pair. Walks the editor-doc's children to the nominated line, then
// counts text-content chars up to the offset (counting hidden marker
// chars too — this matches the offset model annotations were stored
// with). Returns null if the line index is out of bounds, which is
// treated as orphaned at the caller.
function rangeForAnnotation(a: Annotation): Range | null {
  if (!docEl) return null
  const lines = Array.from(docEl.children) as HTMLElement[]
  const startLine = lines[a.range.start_line]
  const endLine   = lines[a.range.end_line]
  if (!startLine || !endLine) return null
  const startNode = textNodeAtOffset(startLine, a.range.start_offset)
  const endNode   = textNodeAtOffset(endLine,   a.range.end_offset)
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode.node, startNode.offset)
    range.setEnd(endNode.node, endNode.offset)
    return range
  } catch {
    return null
  }
}

// Walk text descendants of a line and find the (text-node, offset)
// pair that corresponds to a given char offset within line.textContent.
// Returns null if the offset is past the end of the line.
function textNodeAtOffset(line: HTMLElement, offset: number): { node: Node, offset: number } | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Node | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) return { node, offset: offset - acc }
    acc += len
    last = node
  }
  // Past the end — pin to the end of the last text node so a Range
  // can still be built (rather than refusing it) for end-of-line cases.
  if (last) return { node: last, offset: (last.textContent || '').length }
  return null
}

// Best-effort re-anchoring: returns the (start_line, start_offset,
// end_line, end_offset) where the snippet currently lives, or null if
// it can't be found. The recorded position is checked first; if the
// text there matches, no change. Otherwise we walk the doc's lines for
// the first occurrence of the snippet and take that. No occurrence ⇒
// the annotation has orphaned.
function reAnchorAnnotation(a: Annotation): AnnotationRange | null {
  if (!docEl) return null
  const lines = Array.from(docEl.children) as HTMLElement[]
  const startLine = lines[a.range.start_line]
  const endLine   = lines[a.range.end_line]
  if (startLine && endLine && a.range.start_line === a.range.end_line) {
    const text = startLine.textContent || ''
    const slice = text.slice(a.range.start_offset, a.range.end_offset)
    if (slice === a.snippet) return a.range          // fast path: still in place
  }
  // Snippet drifted — search the whole doc for a single-line match.
  // We don't try to rebind multi-line snippets in this pass; those
  // simply orphan if they shift, until the user re-annotates.
  if (a.snippet.includes('\n')) return null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].textContent || ''
    const idx = text.indexOf(a.snippet)
    if (idx >= 0) {
      return { start_line: i, start_offset: idx, end_line: i, end_offset: idx + a.snippet.length }
    }
  }
  return null
}

// Render the annotation underline overlay. Each annotation can occupy
// multiple visual rectangles (multi-line ranges, or wrapped lines), so
// we call Range.getClientRects() and emit a thin underline div for
// each. The container is positioned relative to .editor-page; rects
// are translated into editor-page-local coordinates so they stay
// pinned even as the page scrolls. Re-rendered after every reclassify
// (text edits) and on window resize.
function renderAnnotationOverlay(): void {
  if (!docEl || !overlayEl) return
  overlayEl.innerHTML = ''
  if (!annotations.length) return
  const page = overlayEl.parentElement as HTMLElement
  if (!page) return
  const pageRect = page.getBoundingClientRect()

  // Re-anchor each annotation. Three outcomes per annotation:
  //   - found at recorded position: render as-is.
  //   - found at a new position: update + persist + render at new pos.
  //   - not found at all: orphan — don't render (the row stays in
  //     storage so the user's comment isn't silently lost; if the
  //     snippet reappears on a later edit, the underline returns).
  let anyChanged = false
  const orphans = new Set<string>()
  for (const a of annotations) {
    const fresh = reAnchorAnnotation(a)
    if (!fresh) { orphans.add(a.id); continue }
    if (fresh.start_line !== a.range.start_line
        || fresh.start_offset !== a.range.start_offset
        || fresh.end_line   !== a.range.end_line
        || fresh.end_offset !== a.range.end_offset) {
      a.range = fresh
      a.updated_at = new Date().toISOString()
      anyChanged = true
    }
  }
  if (anyChanged) scheduleAnnotationsSave()

  for (const a of annotations) {
    if (orphans.has(a.id)) continue
    const range = rangeForAnnotation(a)
    if (!range) continue
    const rects = Array.from(range.getClientRects())
    for (const rect of rects) {
      if (rect.width < 0.5) continue
      const mark = document.createElement('div')
      mark.className = 'annotation-mark'
      mark.dataset.annId = a.id
      mark.style.left   = (rect.left   - pageRect.left) + 'px'
      mark.style.top    = (rect.top    - pageRect.top)  + 'px'
      mark.style.width  = rect.width  + 'px'
      mark.style.height = rect.height + 'px'
      mark.title = a.comment ? a.comment.slice(0, 200) : 'Comment'
      overlayEl.appendChild(mark)
    }
  }
}

// Compute (start_line, start_offset, end_line, end_offset) and the
// text snippet for the current selection inside the editor. Returns
// null if the selection is collapsed, doesn't span text, or escapes
// the editor-doc element.
function selectionAsAnnotationRange(): { range: AnnotationRange, snippet: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (range.collapsed) return null
  if (!docEl) return null
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) return null

  const lines = Array.from(docEl.children) as HTMLElement[]
  function locate(node: Node, off: number): { line: number, offset: number } | null {
    // Find the line div containing `node` (or `node` itself if it's a line)
    let l: Node | null = node
    while (l && l.parentNode !== docEl) l = l.parentNode
    if (!l) return null
    const lineIdx = lines.indexOf(l as HTMLElement)
    if (lineIdx < 0) return null
    return { line: lineIdx, offset: offsetInLineFor(l as HTMLElement, node, off) }
  }
  const s = locate(range.startContainer, range.startOffset)
  const e = locate(range.endContainer,   range.endOffset)
  if (!s || !e) return null
  if (s.line > e.line || (s.line === e.line && s.offset >= e.offset)) return null

  // Build the snippet from the lines' textContent so it captures the
  // visible characters the user highlighted (markers included — they
  // round-trip with the source).
  let snippet: string
  if (s.line === e.line) {
    snippet = (lines[s.line].textContent || '').slice(s.offset, e.offset)
  } else {
    const parts: string[] = []
    parts.push((lines[s.line].textContent || '').slice(s.offset))
    for (let i = s.line + 1; i < e.line; i++) parts.push(lines[i].textContent || '')
    parts.push((lines[e.line].textContent || '').slice(0, e.offset))
    snippet = parts.join('\n')
  }

  return {
    range: { start_line: s.line, start_offset: s.offset, end_line: e.line, end_offset: e.offset },
    snippet,
  }
}

// Show or hide the floating Comment button based on the current
// selection. Anchored just above-right of the selection's end rect.
function updateCommentButtonForSelection(): void {
  if (!commentBtnEl || !docEl) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed) {
    commentBtnEl.hidden = true
    return
  }
  const range = sel.getRangeAt(0)
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) {
    commentBtnEl.hidden = true
    return
  }
  const rects = range.getClientRects()
  if (rects.length === 0) { commentBtnEl.hidden = true; return }
  const last = rects[rects.length - 1]
  // Anchor just above the right end of the selection.
  commentBtnEl.style.left = (last.right + window.scrollX + 4) + 'px'
  commentBtnEl.style.top  = (last.top + window.scrollY - 28) + 'px'
  commentBtnEl.hidden = false
}

// Create a new annotation from the current selection, append to the
// list, persist, and immediately open the panel for it so the user
// can type a comment.
function createAnnotationFromSelection(): void {
  if (!currentSlug) return
  const got = selectionAsAnnotationRange()
  if (!got) return
  const id = 'ann-' + Math.random().toString(36).slice(2, 10)
  const now = new Date().toISOString()
  const a: Annotation = {
    id,
    session_id: id,
    range: got.range,
    snippet: got.snippet,
    comment: '',
    created_at: now,
    updated_at: now,
  }
  annotations.push(a)
  // Collapse the selection so the floating button hides naturally and
  // the underline overlay can be drawn over the now-quiet selection.
  window.getSelection()?.removeAllRanges()
  if (commentBtnEl) commentBtnEl.hidden = true
  scheduleAnnotationsSave()
  renderAnnotationOverlay()
  openPanelForAnnotation(id)
}

function deleteAnnotation(id: string): void {
  annotations = annotations.filter((a) => a.id !== id)
  scheduleAnnotationsSave()
  renderAnnotationOverlay()
  closePanel()
}

function updateAnnotationComment(id: string, comment: string): void {
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  if (a.comment === comment) return
  a.comment = comment
  a.updated_at = new Date().toISOString()
  scheduleAnnotationsSave()
}

// ── Annotation panel chat state ──
//
// Each annotation carries a session_id; opening the panel kicks off a
// fetch + poll loop against /api/chat?session=<id>, mirroring what
// chat-pane.ts does for the dedicated chat view but smaller and
// scoped to the panel. The panel is single-instance — only one
// annotation's chat is live at a time, so we don't need per-id state
// dictionaries; the timer + caches reset on every open/close.
interface PanelChatEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string
  error: string
}
let panelMessages: PanelChatEntry[] = []
const panelReplies: Map<string, string> = new Map()
let panelPollTimer: ReturnType<typeof setTimeout> | null = null
let panelPollInflight = false

const PANEL_FAST_POLL_MS = 1500    // matches chat-pane's running cadence
const PANEL_SLOW_POLL_MS = 8000    // idle cadence

async function fetchPanelReply(hash: string): Promise<string> {
  const res = await fetch(`/api/agent-response/${encodeURIComponent(hash)}`)
  if (!res.ok) throw new Error(`agent-response ${res.status}`)
  const data = await res.json()
  return String(data.body || '')
}

async function refreshPanelChat(sessionId: string): Promise<void> {
  if (panelPollInflight) return
  panelPollInflight = true
  try {
    const res = await fetch(`/api/chat?session=${encodeURIComponent(sessionId)}`)
    if (!res.ok) return
    const data = await res.json()
    panelMessages = (data.messages || []) as PanelChatEntry[]
    // Pull bodies for every newly-completed entry whose hash we
    // haven't cached yet. Tiny payloads, fire in parallel.
    const toFetch = panelMessages.filter((m) => m.status === 'completed' && m.response && !panelReplies.has(m.id))
    await Promise.all(toFetch.map(async (m) => {
      try { panelReplies.set(m.id, await fetchPanelReply(m.response)) } catch { /* leave missing */ }
    }))
    renderPanelChat()
  } finally {
    panelPollInflight = false
  }
}

function schedulePanelPoll(sessionId: string): void {
  if (panelPollTimer) clearTimeout(panelPollTimer)
  if (!panelEl || panelEl.hidden || panelForId == null) return
  const hasInflight = panelMessages.some((m) => m.status === 'running')
  const delay = hasInflight ? PANEL_FAST_POLL_MS : PANEL_SLOW_POLL_MS
  panelPollTimer = setTimeout(async () => {
    await refreshPanelChat(sessionId)
    schedulePanelPoll(sessionId)
  }, delay)
}

function stopPanelPoll(): void {
  if (panelPollTimer) { clearTimeout(panelPollTimer); panelPollTimer = null }
}

function renderPanelChat(): void {
  if (!panelEl) return
  const log = panelEl.querySelector<HTMLElement>('.editor-annotation-chat-log')
  if (!log) return
  if (panelMessages.length === 0) {
    log.innerHTML = '<div class="editor-annotation-chat-empty">Ask the agent about this passage…</div>'
    return
  }
  const parts: string[] = []
  for (const m of panelMessages) {
    parts.push(`
      <div class="editor-annotation-chat-msg editor-annotation-chat-user">
        <div class="editor-annotation-chat-body">${escapeHtml(m.prompt)}</div>
      </div>
    `)
    const reply = panelReplies.get(m.id)
    if (m.status === 'running') {
      parts.push(`
        <div class="editor-annotation-chat-msg editor-annotation-chat-agent">
          <div class="chat-thinking"><span></span><span></span><span></span></div>
        </div>
      `)
    } else if (m.status === 'failed') {
      parts.push(`
        <div class="editor-annotation-chat-msg editor-annotation-chat-agent editor-annotation-chat-error">
          <div class="editor-annotation-chat-body">${escapeHtml(m.error || 'failed')}</div>
        </div>
      `)
    } else if (reply !== undefined) {
      parts.push(`
        <div class="editor-annotation-chat-msg editor-annotation-chat-agent">
          <pre class="editor-annotation-chat-body editor-annotation-chat-mono">${escapeHtml(reply)}</pre>
        </div>
      `)
    } else if (m.response) {
      parts.push(`
        <div class="editor-annotation-chat-msg editor-annotation-chat-agent">
          <div class="chat-thinking"><span></span><span></span><span></span></div>
        </div>
      `)
    }
  }
  log.innerHTML = parts.join('')
  log.scrollTop = log.scrollHeight
}

async function sendPanelChat(sessionId: string, snippet: string): Promise<void> {
  if (!panelEl) return
  const input = panelEl.querySelector<HTMLTextAreaElement>('.editor-annotation-chat-input')
  const sendBtn = panelEl.querySelector<HTMLButtonElement>('.editor-annotation-chat-send')
  if (!input || !sendBtn) return
  const text = input.value.trim()
  if (!text) return
  sendBtn.disabled = true
  input.disabled = true
  // Prefix the message with the highlighted snippet so the agent has
  // immediate context — the chat session might span weeks; the
  // snippet is what the comment is "about". We only do this when
  // there is no existing transcript for this session — once the
  // conversation has started, the agent's session memory carries it.
  const prefixed = panelMessages.length === 0
    ? `(About: "${snippet.replace(/"/g, '\\"')}")\n\n${text}`
    : text
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId, message: prefixed }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    input.value = ''
    autoResizePanelInput()
    // Optimistic placeholder so the user's bubble lands immediately
    // — the next refresh reconciles against the real row.
    panelMessages.push({
      id: '__optimistic-' + Date.now(),
      session_id: sessionId,
      prompt: prefixed,
      started_at: new Date().toISOString(),
      status: 'running',
      response: '',
      error: '',
    })
    renderPanelChat()
    // Pull soon — agent-interface needs a moment to insert the row.
    window.setTimeout(() => { void refreshPanelChat(sessionId).then(() => schedulePanelPoll(sessionId)) }, 800)
  } catch (err) {
    console.error('[editor] sendPanelChat failed:', err)
  } finally {
    sendBtn.disabled = false
    input.disabled = false
    input.focus()
  }
}

function autoResizePanelInput(): void {
  if (!panelEl) return
  const input = panelEl.querySelector<HTMLTextAreaElement>('.editor-annotation-chat-input')
  if (!input) return
  input.style.height = 'auto'
  input.style.height = Math.min(120, input.scrollHeight) + 'px'
}

// Show the comment panel for the given annotation. Anchored below the
// annotation's first rectangle (or above if there's no room below).
// Two stacked surfaces inside:
//   - The user's editable comment (top): their thinking, autosaved.
//   - A chat thread (bottom): a long-running session keyed on
//     annotation.session_id, fetched + polled the same way as the
//     dedicated chat pane. The first message gets the highlighted
//     snippet prepended so the agent has context.
function openPanelForAnnotation(id: string): void {
  if (!panelEl) return
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  panelForId = id
  panelMessages = []
  panelReplies.clear()
  panelEl.innerHTML = `
    <div class="editor-annotation-row">
      <span class="editor-annotation-snippet" title="${escapeHtml(a.snippet)}">${escapeHtml(a.snippet.slice(0, 80))}${a.snippet.length > 80 ? '…' : ''}</span>
      <button type="button" class="editor-annotation-delete" aria-label="Delete">${ICON_TRASH}</button>
    </div>
    <textarea class="editor-annotation-text" placeholder="Add a comment…" rows="3"></textarea>
    <div class="editor-annotation-chat-log" aria-live="polite"></div>
    <div class="editor-annotation-chat-compose">
      <textarea class="editor-annotation-chat-input" placeholder="Ask…" rows="1"></textarea>
      <button type="button" class="editor-annotation-chat-send" aria-label="Send">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l10-4-4 10-2-4-4-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </button>
    </div>
  `
  const ta = panelEl.querySelector<HTMLTextAreaElement>('.editor-annotation-text')!
  ta.value = a.comment
  ta.addEventListener('input', () => updateAnnotationComment(id, ta.value))
  panelEl.querySelector<HTMLButtonElement>('.editor-annotation-delete')!
    .addEventListener('click', () => deleteAnnotation(id))

  const input = panelEl.querySelector<HTMLTextAreaElement>('.editor-annotation-chat-input')!
  const sendBtn = panelEl.querySelector<HTMLButtonElement>('.editor-annotation-chat-send')!
  input.addEventListener('input', autoResizePanelInput)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendPanelChat(a.session_id, a.snippet)
    }
  })
  sendBtn.addEventListener('click', () => { void sendPanelChat(a.session_id, a.snippet) })

  // Position the panel near the annotation. Use the annotation's first
  // rect for anchoring; if it would push off the bottom edge, flip
  // above the annotation instead.
  const range = rangeForAnnotation(a)
  panelEl.hidden = false
  if (range) {
    const rect = range.getBoundingClientRect()
    const margin = 8
    const panelRect = panelEl.getBoundingClientRect()
    const wouldOverflowBottom = rect.bottom + margin + panelRect.height > window.innerHeight
    const top = wouldOverflowBottom
      ? Math.max(margin, rect.top - margin - panelRect.height)
      : rect.bottom + margin
    panelEl.style.left = (rect.left + window.scrollX) + 'px'
    panelEl.style.top  = (top + window.scrollY) + 'px'
  }
  ta.focus()

  // Kick off chat fetch + polling for this session.
  void refreshPanelChat(a.session_id).then(() => schedulePanelPoll(a.session_id))

  setTimeout(() => {
    document.addEventListener('click', onPanelOutsideClick)
    document.addEventListener('keydown', onPanelKeydown)
  }, 0)
}

function closePanel(): void {
  if (!panelEl) return
  if (panelEl.hidden && !panelForId) return
  panelEl.hidden = true
  panelEl.innerHTML = ''
  panelForId = null
  panelMessages = []
  panelReplies.clear()
  stopPanelPoll()
  document.removeEventListener('click', onPanelOutsideClick)
  document.removeEventListener('keydown', onPanelKeydown)
}

function onPanelOutsideClick(e: MouseEvent): void {
  if (!panelEl) return
  const t = e.target as Node
  if (panelEl.contains(t)) return
  // Allow clicks on annotation marks to switch panels (handled by the
  // overlay click delegate); other clicks close the panel.
  if ((t as HTMLElement).classList?.contains('annotation-mark')) return
  closePanel()
}

function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    closePanel()
  }
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
  // Cmd+B is handled at keydown to insert markdown markers instead.
  //
  // Also fix a Chrome quirk: when the caret sits at "line-level, just
  // after a <strong>" (no text-node anchor), Chrome routes typed
  // characters into the trailing marker text node — which extends the
  // bold span. We intercept text insertion in that position and create
  // a real sibling text node ourselves, then place the caret in it.
  // The reclassify pass picks the new text node up and parseInline
  // produces the correct (bold + plain) split.
  docEl!.addEventListener('beforeinput', (e: InputEvent) => {
    const t = e.inputType
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline'
        || t === 'formatStrikeThrough' || t === 'formatSuperscript'
        || t === 'formatSubscript') {
      e.preventDefault()
      return
    }

    if ((t === 'insertText' || t === 'insertCompositionText') && typeof e.data === 'string') {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return
      const wrap = inlineWrapAtCaretEdge(range)
      if (!wrap) return
      e.preventDefault()
      const lineLevel = wrap.parentNode!
      const after = wrap.nextSibling
      const newText = document.createTextNode(e.data)
      if (after) lineLevel.insertBefore(newText, after)
      else       lineLevel.appendChild(newText)
      const r = document.createRange()
      r.setStart(newText, newText.textContent!.length)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      // The browser won't fire 'input' for a prevented insertion, so
      // run the post-edit pipeline ourselves to reclassify and save.
      reclassifyLines()
      updateEmptyState()
      scheduleSave()
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

  // Selection.toString() and the browser's default copy data both
  // strip display:none content — but our `# `/`## ` markers are
  // hidden that way. Intercept copy and rebuild the markdown from
  // each line's textContent (which still includes the marker chars),
  // sliced to the selection's bounds within each line, joined with
  // newlines. The result is true markdown, exactly as it sits on
  // disk — what the user sees in this editor is the rendering, what
  // they paste elsewhere is the source.
  docEl!.addEventListener('copy', (e: ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    if (!docEl!.contains(range.commonAncestorContainer)
        && range.commonAncestorContainer !== docEl) return
    const md = reconstructMarkdownFromRange(range)
    if (md == null) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', md)
  })

  // Cut is copy + delete; same reconstruction so the clipboard sees
  // markdown. The deletion itself is left to the browser's default
  // (which acts on visible text); reclassify on the resulting input
  // event will rebuild any line whose marker was disturbed.
  docEl!.addEventListener('cut', (e: ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    if (!docEl!.contains(range.commonAncestorContainer)
        && range.commonAncestorContainer !== docEl) return
    const md = reconstructMarkdownFromRange(range)
    if (md == null) return
    e.clipboardData?.setData('text/plain', md)
    // Don't preventDefault — we still want the browser to delete the
    // visible selection. Setting clipboardData on a cut event without
    // preventDefault overrides the default copy data while letting the
    // delete proceed.
    e.preventDefault()
    document.execCommand('delete')
  })

  docEl!.addEventListener('input', () => {
    reclassifyLines()
    updateEmptyState()
    scheduleSave()
    // Re-render annotation overlay AFTER reclassifyLines: the line
    // tree has been canonicalised, so DOM ranges and getClientRects
    // produce the right pixel positions for the underlines.
    renderAnnotationOverlay()
  })

  // Show / hide the floating Comment button based on the live
  // selection. selectionchange fires on every cursor move, so this
  // also handles the case where the user starts a selection with
  // shift+arrow and grows it.
  document.addEventListener('selectionchange', () => {
    // Only react when the editor is the focused element — avoids
    // showing the button while the user has selected text in some
    // other view.
    if (document.activeElement !== docEl) {
      if (commentBtnEl) commentBtnEl.hidden = true
      return
    }
    updateCommentButtonForSelection()
  })

  commentBtnEl = viewEl.querySelector<HTMLButtonElement>('#editor-comment-btn')
  commentBtnEl?.addEventListener('mousedown', (e) => {
    // mousedown (not click) so the action fires before the editor
    // sees the click event and collapses the selection itself.
    e.preventDefault()
    createAnnotationFromSelection()
  })

  overlayEl = viewEl.querySelector<HTMLElement>('#editor-annotations')
  overlayEl?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const id = target?.dataset?.annId
    if (!id) return
    e.stopPropagation()
    openPanelForAnnotation(id)
  })

  panelEl = viewEl.querySelector<HTMLElement>('#editor-annotation-panel')

  // Re-position annotation overlays on viewport changes. Resize and
  // scroll both invalidate the cached rects; they're cheap to redraw
  // (a few transient absolute divs), so we do it eagerly.
  window.addEventListener('resize', renderAnnotationOverlay)

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
    if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      toggleBoldAtSelection()
    }
    // Right-arrow / End from the end of a bold's or code's inner
    // text: Chrome won't navigate the caret past hidden markers, so
    // the user gets stuck inside the wrapper and subsequent typing
    // extends the bold/code. We intercept and jump to the sentinel
    // text node after the wrapper, so one keypress is enough to exit
    // and start typing plain text. The opposite (entering the
    // wrapper from outside) doesn't need a fix — Chrome navigates
    // into wrapper inner text cleanly.
    if ((e.key === 'ArrowRight' || e.key === 'End') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const node = range.startContainer
          if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentNode as HTMLElement | null
            if (parent
                && (parent.tagName === 'STRONG' || parent.tagName === 'CODE')
                && range.startOffset === (node.textContent || '').length
                && node.nextSibling
                && node.nextSibling.nodeType === Node.ELEMENT_NODE
                && (node.nextSibling as HTMLElement).classList.contains('md-marker')) {
              const sentinel = parent.nextSibling
              if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
                e.preventDefault()
                const r = document.createRange()
                r.setStart(sentinel, 0)
                r.collapse(true)
                sel.removeAllRanges()
                sel.addRange(r)
              }
            }
          }
        }
      }
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
