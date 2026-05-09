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

// The visible-prefix length each kind hides. CSS sets the marker span
// to `display: none`, so the user only sees the "rest" of the line.
function markerLengthFor(kind: 'h1' | 'h2' | 'body'): number {
  return kind === 'h1' ? 2 : kind === 'h2' ? 3 : 0
}

// Inline-segment model. A line's "rest" (everything after the optional
// block marker) is parsed into a flat sequence of plain text and bold
// runs. We support `**bold**` only — single-asterisk italic isn't in
// the spec, which removes the parser's need to disambiguate `*` vs
// `**`. Pairs are matched greedy left-to-right; an unmatched `**` and
// `****` (empty inner) both stay as plain text.
type InlineSegment = { kind: 'text', text: string } | { kind: 'bold', text: string }

function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('**', i)
    if (open === -1) { out.push({ kind: 'text', text: text.slice(i) }); break }
    if (open > i) out.push({ kind: 'text', text: text.slice(i, open) })
    const close = text.indexOf('**', open + 2)
    if (close === -1) { out.push({ kind: 'text', text: text.slice(open) }); break }
    const inner = text.slice(open + 2, close)
    if (inner === '') {
      // `****` (no inner) stays as plain text — there's nothing to
      // bold. Reflects how iA Writer / Typora handle empty pairs.
      out.push({ kind: 'text', text: text.slice(open, close + 2) })
    } else {
      out.push({ kind: 'bold', text: inner })
    }
    i = close + 2
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

// Build a <strong> wrapping a bold run, with the leading + trailing
// `**` markers in hidden spans flanking the visible inner text.
function buildBoldEl(inner: string): HTMLElement {
  const strong = document.createElement('strong')
  const open = document.createElement('span')
  open.className = 'md-marker'
  open.textContent = '**'
  const text = document.createTextNode(inner)
  const close = document.createElement('span')
  close.className = 'md-marker'
  close.textContent = '**'
  strong.appendChild(open)
  strong.appendChild(text)
  strong.appendChild(close)
  return strong
}

// Build a fresh line element. Lines whose markdown starts with `# ` /
// `## ` get the marker wrapped in a hidden <span class="md-marker">
// so the user sees only the heading text. The line's remaining content
// is parsed for inline `**bold**` runs and split across <strong>
// wrappers (each with its own hidden markers). All marker text still
// lives in textContent so save and the copy-document button round-trip
// the true markdown. Empty lines (and empty headings, where the rest
// is "") get a <br> filler so contenteditable gives them row height.
function buildLineEl(text: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'editor-line'
  const kind = lineKindFor(text)
  div.dataset.kind = kind
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
    if (seg.kind === 'text') div.appendChild(document.createTextNode(seg.text))
    else                     div.appendChild(buildBoldEl(seg.text))
  }
  // Sentinel: when the line ends in a <strong>, append an empty text
  // node so the caret has a non-strong anchor at end-of-line. Without
  // this, Chrome treats a line-level caret position immediately after
  // a <strong> as "inside the previous element" for typing purposes
  // and routes characters back into the bold's inner text — silently
  // extending the bold word. The empty text node is invisible,
  // contributes zero to textContent, and is allowed by lineMatchesModel.
  if (segs.length > 0 && segs[segs.length - 1].kind === 'bold') {
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
      // marker of a <strong>, placing it inside that marker means the
      // user's next keystroke extends the bold (the marker grows by
      // one char, the parser still sees `**…X` and re-parses with X
      // inside the bold). We want the opposite: typing after `**bold**`
      // should produce plain text. Prefer the trailing empty-text
      // sentinel buildLineEl appends after a bold-ending line — that's
      // a real text-node anchor outside the strong. Failing that
      // (sentinel was stripped, or strong has a non-text next sibling),
      // place at line-level after the strong; the sentinel will be
      // re-added on the next reclassify.
      if (localOffset === len && node.parentNode) {
        const markerSpan = node.parentNode as HTMLElement
        if (markerSpan.classList && markerSpan.classList.contains('md-marker')) {
          const strong = markerSpan.parentNode as HTMLElement | null
          if (strong && strong.tagName === 'STRONG' && markerSpan === strong.lastElementChild) {
            const sentinel = strong.nextSibling
            if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
              range.setStart(sentinel, 0)
              range.collapse(true)
              if (sel) { sel.removeAllRanges(); sel.addRange(range) }
              return
            }
            const lineLevel = strong.parentNode!
            const idx = Array.from(lineLevel.childNodes).indexOf(strong) + 1
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

// Walk up from a node looking for an ancestor `<strong>` inside the
// editor. Used by Cmd+B to detect whether the selection sits inside
// an existing bold run (toggle off) or not (toggle on).
function strongAncestorOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n === docEl) return null
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'STRONG') return n as HTMLElement
    n = n.parentNode
  }
  return null
}

// Detect a caret position whose next typed character will, by default,
// land inside the trailing marker of a <strong> and visually extend
// the bold. Three equivalent positions trigger this:
//   1. Caret at the end of the trailing marker's text node (inside
//      the marker span).
//   2. Caret at line-level immediately after a <strong> with no
//      following text node.
//   3. Caret in the post-strong sentinel (empty text node sibling
//      buildLineEl appends after a bold-ending line). The sentinel
//      is a real text-node anchor, but Chrome still routes typed
//      characters into the previous element when the sentinel is
//      empty — so we treat this as "caret at strong's edge" and
//      redirect the insertion to a fresh text sibling.
// In all three cases we redirect the insertion to a sibling text
// node after the strong, so typing produces plain text.
function strongAtCaretEdge(range: Range): HTMLElement | null {
  const node = range.startContainer
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentNode as HTMLElement | null
    if (!parent) return null
    // Case 1: inside trailing marker, at end of marker text.
    if (parent.classList.contains('md-marker')) {
      const strong = parent.parentNode as HTMLElement | null
      if (!strong || strong.tagName !== 'STRONG') return null
      if (parent !== strong.lastElementChild) return null
      if (range.startOffset !== (node.textContent || '').length) return null
      return strong
    }
    // Case 3: in the empty sentinel sibling of a strong.
    if (node.textContent === '' && parent.classList.contains('editor-line')
        && node.previousSibling
        && node.previousSibling.nodeType === Node.ELEMENT_NODE
        && (node.previousSibling as HTMLElement).tagName === 'STRONG') {
      return node.previousSibling as HTMLElement
    }
    return null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    if (!el.classList.contains('editor-line')) return null
    // Case 2: line-level position immediately after a <strong>.
    const prev = el.childNodes[range.startOffset - 1]
    if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null
    if ((prev as HTMLElement).tagName !== 'STRONG') return null
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

    const lineText = line.textContent || ''
    const markerLen = markerLengthFor((line.dataset.kind as 'h1' | 'h2' | 'body') || 'body')

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

    // Inline snap: for each <strong> in the line, if the slice covers
    // its full visible inner text, expand outward to include the
    // surrounding `**` markers. We use the original startOffset/
    // endOffset (visible bounds) for the comparison so the heading
    // snap above doesn't double-count.
    for (const strong of Array.from(line.querySelectorAll('strong'))) {
      const strongStart = offsetOfNodeInLine(line, strong)
      if (strongStart < 0) continue
      const strongEnd = strongStart + (strong.textContent || '').length
      const innerStart = strongStart + 2     // skip leading `**`
      const innerEnd   = strongEnd - 2       // skip trailing `**`
      if (startOffset <= innerStart && endOffset >= innerEnd) {
        if (strongStart < s) s = strongStart
        if (strongEnd   > e) e = strongEnd
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

// Test whether a line's current DOM structure matches what
// buildLineEl(textContent) would produce — used to decide whether to
// rebuild on input. Mismatch happens when:
//   - kind changed (user typed/erased a `#` marker prefix)
//   - the marker span content drifted from its kind's prefix
//   - the inline-bold structure changed (user typed/closed a `**`
//     pair, or broke one) so a <strong> wrapper needs to appear /
//     disappear / move
//   - any segment got split across multiple text nodes from browser
//     edit operations (cursor offset accounting depends on each
//     segment being a single text node).
function lineMatchesModel(line: HTMLElement): boolean {
  const txt = line.textContent || ''
  const kind = lineKindFor(txt)
  if (line.dataset.kind !== kind) return false

  const prefixLen = markerLengthFor(kind)
  const expectedPrefix = txt.slice(0, prefixLen)
  const rest = txt.slice(prefixLen)
  const children = Array.from(line.childNodes)
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
  // Lines that end in bold carry a trailing empty-text sentinel (see
  // buildLineEl) so the caret has a non-strong anchor at end-of-line.
  // Accept either segment-count OR segment-count+1 children remaining.
  const remaining = children.length - i
  const endsInBold = segs.length > 0 && segs[segs.length - 1].kind === 'bold'
  if (remaining !== segs.length && !(endsInBold && remaining === segs.length + 1)) return false

  for (const seg of segs) {
    const node = children[i++]
    if (seg.kind === 'text') {
      // Plain segment: a single text node with the exact text.
      if (node.nodeType !== Node.TEXT_NODE) return false
      if (node.textContent !== seg.text) return false
    } else {
      // Bold segment: <strong> with three children — open marker
      // (`**`), inner text, close marker (`**`).
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.tagName !== 'STRONG') return false
      if (el.childNodes.length !== 3) return false
      const open = el.childNodes[0]
      const inner = el.childNodes[1]
      const close = el.childNodes[2]
      if (open.nodeType !== Node.ELEMENT_NODE || !(open as HTMLElement).classList.contains('md-marker') || open.textContent !== '**') return false
      if (close.nodeType !== Node.ELEMENT_NODE || !(close as HTMLElement).classList.contains('md-marker') || close.textContent !== '**') return false
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

// Rebuild a line in place from its current textContent, preserving
// cursor offset (in textContent coordinates, including any hidden
// marker characters). The marker span the rebuild produces is
// display:none, so the visible line snaps to the new kind's typography
// while save/copy still see the full markdown.
function rebuildLineInPlace(line: HTMLElement) {
  const txt = line.textContent || ''
  const cursor = getCursorOffsetInLine(line)
  const fresh = buildLineEl(txt)
  // Replace content but keep the line div itself (so external refs hold).
  line.dataset.kind = fresh.dataset.kind!
  line.innerHTML = ''
  while (fresh.firstChild) line.appendChild(fresh.firstChild)
  if (cursor !== null) setCursorOffsetInLine(line, cursor)
}

// Re-classify every line and clean up structure. Runs on every input
// event; the common case is "no structural change" and we touch
// nothing. When the user types a marker character (`# `/`## `) or
// breaks one (deleting through the marker), the affected line gets
// rebuilt in place with cursor preserved at its textContent offset.
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
  // Now every child is an .editor-line div. For each, compare its
  // current shape to what its textContent should produce; rebuild only
  // when they diverge — otherwise leave the cursor alone.
  for (const child of Array.from(docEl.children)) {
    const el = child as HTMLElement
    if (!lineMatchesModel(el)) {
      rebuildLineInPlace(el)
    }
    // Ensure empty lines have a <br> filler. lineMatchesModel rejects
    // body lines with no children at all; this catches mid-edit states
    // (e.g. user just deleted everything but the cursor is in this line).
    if ((el.textContent || '') === '' && !el.querySelector('br')) {
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
      const strong = strongAtCaretEdge(range)
      if (!strong) return
      e.preventDefault()
      const lineLevel = strong.parentNode!
      const after = strong.nextSibling
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
    if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      toggleBoldAtSelection()
    }
    // Right-arrow / End from the end of a bold's inner text: Chrome
    // won't navigate the caret past hidden markers, so the user gets
    // stuck inside the <strong> and subsequent typing extends the
    // bold. We intercept and jump to the sentinel text node after the
    // strong, so one keypress is enough to exit and start typing
    // plain text. The opposite (entering bold from outside) doesn't
    // need a fix — Chrome navigates into strong inner text cleanly.
    if ((e.key === 'ArrowRight' || e.key === 'End') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const node = range.startContainer
          if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentNode as HTMLElement | null
            if (parent && parent.tagName === 'STRONG'
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
