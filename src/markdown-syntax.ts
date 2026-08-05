// The markdown syntax, defined once.
//
// Two things in this app put markdown on screen and they work in
// completely different ways: src/markdown.ts turns an agent's reply into
// a read-only HTML string, and src/views/editor-view.ts turns the
// writer's document into live DOM where the source characters stay put
// so the caret, the annotations and the saved file all still line up.
// Neither can do the other's job. What they must never do is disagree
// about what markdown *is* — so the grammar lives here, and both of them
// consume it.
//
// The one rule that makes a single grammar serve both: every parse
// result reports the marker AND the content it introduces. A renderer
// that throws markdown away (`# ` becomes an <h1> tag) drops the marker;
// a renderer that keeps the source (`# ` becomes a hidden span) keeps
// it. Same parse, two dispositions.
//
// Everything here works on RAW markdown. src/markdown.ts escapes at the
// point it emits rather than up front, because a `>` that has already
// become `&gt;` is no longer a blockquote to any parser that reads it.
//
// Not supported, in both places alike: nested emphasis (`***x***`),
// inline markup inside a link's text, setext headings, indented code
// blocks, and `\|` as an escaped pipe inside a table cell.

// ── Blocks ───────────────────────────────────────────────────────────
//
// One kind per line. Grouping runs of lines into paragraphs, lists and
// quotes is a rendering decision — the chat pane wraps a run of
// list-items in one <ul>, the editor leaves each line standing alone —
// so it is deliberately not made here.
export type BlockKind =
  | 'body' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'list-item' | 'quote' | 'rule'
  | 'code-fence-open' | 'code-fence-close' | 'code-content'
  | 'table-head' | 'table-delim' | 'table-row'
  | 'source'

const HEADING_RE  = /^(#{1,6}) /
const LIST_RE     = /^(?:- |\d+[.)] )/
const QUOTE_RE    = /^>(?: |$)/
const RULE_RE     = /^(?:-{3,}|\*{3,})[ \t]*$/
const FENCE_RE    = /^```/
const TABLE_ROW_RE   = /^\|.*\|[ \t]*$/
const TABLE_DELIM_RE = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/

export function isTableRowText(text: string): boolean {
  return TABLE_ROW_RE.test(text)
}

export function isTableDelimText(text: string): boolean {
  return TABLE_DELIM_RE.test(text)
}

// A marker only counts when the space after it is there: `#foo` is
// prose, `# foo` is a heading. That is what CommonMark says and what
// every live-preview editor does — without it a line would flip to a
// heading on the keystroke before the writer had finished deciding.
// The exception is `>`, which markdown lets stand alone as an empty
// quote line.
function singleLineKind(text: string): BlockKind {
  const heading = HEADING_RE.exec(text)
  if (heading) return `h${heading[1].length}` as BlockKind
  if (RULE_RE.test(text))  return 'rule'
  if (QUOTE_RE.test(text)) return 'quote'
  if (LIST_RE.test(text))  return 'list-item'
  return 'body'
}

// Walk every line in order, because three constructs can't be read from
// one line alone: a fenced code block runs until its closing fence, and
// a table row is only a row when a delimiter row sits under the header.
//
// `graceIdx` is the line holding the caret, and only the editor passes
// it. Four kinds have no visible content of their own — both code
// fences, a rule, and a table's delimiter row are marker from end to
// end — and a caret inside a wholly hidden line is a caret the writer
// cannot see, on a line they then cannot edit. Whichever of them the
// caret is on comes back as `source`: shown verbatim, as the characters
// that produced it.
//
// What that does to the block AROUND the line differs, and the
// difference matters:
//   - an opening fence stops opening a block, which is what lets
//     `` ```ts `` be typed one character at a time without the rest of
//     the document turning into code on the third backtick;
//   - a delimiter row keeps its table. Whether a block is a table never
//     depends on where the caret is; dissolving a whole table because
//     the writer parked on its delimiter would be far worse than the
//     stranded caret this set out to fix.
export function classifyLines(texts: string[], graceIdx: number = -1): BlockKind[] {
  const out: BlockKind[] = []
  let inCode = false
  // 'none' → not in a table; 'delim' → the delimiter row is next (the
  // lookahead below already checked it); 'body' → rows until a line
  // stops looking like one.
  let table: 'none' | 'delim' | 'body' = 'none'

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]
    const grace = i === graceIdx

    if (inCode) {
      if (text === '```') { out.push(grace ? 'source' : 'code-fence-close'); inCode = false }
      else                { out.push('code-content') }
      continue
    }
    if (FENCE_RE.test(text)) {
      if (grace) { out.push('source'); continue }
      out.push('code-fence-open')
      inCode = true
      table = 'none'
      continue
    }
    if (table === 'delim') {
      out.push(grace ? 'source' : 'table-delim')
      table = 'body'
      continue
    }
    if (table === 'body') {
      if (isTableRowText(text)) { out.push('table-row'); continue }
      table = 'none'
    }
    if (isTableRowText(text) && isTableDelimText(texts[i + 1] ?? '')) {
      out.push('table-head')
      table = 'delim'
      continue
    }
    const kind = singleLineKind(text)
    out.push(grace && kind === 'rule' ? 'source' : kind)
  }
  return out
}

// Kinds that are marker from end to end, and so become `source` when the
// caret lands on them.
export function isWhollyHidden(kind: BlockKind): boolean {
  return kind === 'code-fence-open' || kind === 'code-fence-close'
    || kind === 'rule' || kind === 'table-delim'
}

// How many leading characters of the line are marker rather than
// content. Kinds whose whole line is marker — the fences, a rule, a
// table's delimiter row — report the entire length.
export function blockMarkerLength(kind: BlockKind, text: string = ''): number {
  if (kind[0] === 'h' && kind.length === 2) return Number(kind[1]) + 1
  if (kind === 'list-item') {
    const m = LIST_RE.exec(text)
    return m ? m[0].length : 2
  }
  if (kind === 'quote') {
    const m = QUOTE_RE.exec(text)
    return m ? m[0].length : 1
  }
  if (kind === 'code-fence-open' || kind === 'code-fence-close'
      || kind === 'rule' || kind === 'table-delim') {
    return text.length
  }
  if (kind === 'table-head' || kind === 'table-row') {
    const parts = splitTableRow(text)
    return parts ? parts.markers[0].length : 0
  }
  return 0
}

// The marker run at the END of a line. Only table rows have one — the
// closing pipe and the padding before it — so everything else reports
// 0 and callers can ask "where does the visible content stop?" uniformly.
export function blockTrailingMarkerLength(kind: BlockKind, text: string = ''): number {
  if (kind !== 'table-head' && kind !== 'table-row') return 0
  const parts = splitTableRow(text)
  return parts ? parts.markers[parts.markers.length - 1].length : 0
}

// The language tag on an opening fence, if the writer gave one.
export function codeFenceLang(text: string): string {
  return text.replace(FENCE_RE, '').trim()
}

// ── Inline ───────────────────────────────────────────────────────────
//
// A line's content — everything after the block marker — is a flat
// sequence of runs. Flat, not a tree: neither renderer supports nesting,
// so `**a `b`**` gives a bold run whose text happens to contain
// backticks rather than a code run inside a bold one.
//
// Every segment carries enough to rebuild its exact source, which is
// what lets the editor keep the markdown in the document while showing
// the rendered form.
export type InlineSegment =
  | { kind: 'text',   text: string }
  | { kind: 'bold',   text: string }
  | { kind: 'italic', text: string, marker: '*' | '_' }
  | { kind: 'code',   text: string }
  | { kind: 'link',   text: string, url: string }

// The source `text` was parsed from, character for character.
export function inlineSource(seg: InlineSegment): string {
  switch (seg.kind) {
    case 'bold':   return `**${seg.text}**`
    case 'italic': return `${seg.marker}${seg.text}${seg.marker}`
    case 'code':   return `\`${seg.text}\``
    case 'link':   return `[${seg.text}](${seg.url})`
    default:       return seg.text
  }
}

// Two rules keep emphasis where it was meant and out of arithmetic and
// identifiers:
//   - it starts and ends at the edge of a word, so `some_variable_name`
//     is a name;
//   - it never opens onto a space or closes off one, so `2 * 3 * 4` is
//     multiplication.
// The second is the flanking rule CommonMark states; without it any pair
// of spaced-out asterisks in a sum turned the middle of it italic.
const WORD_RE = /\w/
const SPACE_RE = /\s/

function atWordEdge(text: string, index: number): boolean {
  const char = text[index]
  return char === undefined || !WORD_RE.test(char)
}

// `wordEdge` applies the first rule. Italic asks for it, bold does not:
// `**` in the middle of a word is a long-standing way to emphasise part
// of one (`re**do**`), while a lone `*` or `_` there is nearly always
// arithmetic or an identifier.
function opensEmphasis(text: string, index: number, markerLen: number, wordEdge: boolean): boolean {
  const after = text[index + markerLen]
  if (after === undefined || SPACE_RE.test(after)) return false
  return !wordEdge || atWordEdge(text, index - 1)
}

function closesEmphasis(text: string, index: number, markerLen: number, wordEdge: boolean): boolean {
  const before = text[index - 1]
  if (before === undefined || SPACE_RE.test(before)) return false
  return !wordEdge || atWordEdge(text, index + markerLen)
}

// Find the closer for an emphasis run opened at `open`. A candidate that
// fails the rules is passed over rather than failing the run outright,
// so `_a_b_` closes on its last underscore.
function emphasisCloser(text: string, open: number, marker: string, wordEdge: boolean): number {
  const markerLen = marker.length
  for (let j = open + markerLen; j < text.length; j++) {
    if (!text.startsWith(marker, j)) continue
    if (j > open + markerLen && closesEmphasis(text, j, markerLen, wordEdge)) return j
  }
  return -1
}

export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  let plain = ''
  let i = 0
  const flush = () => { if (plain !== '') { out.push({ kind: 'text', text: plain }); plain = '' } }

  while (i < text.length) {
    const char = text[i]
    let seg: InlineSegment | null = null
    let next = i

    if (char === '`') {
      const close = text.indexOf('`', i + 1)
      if (close > i + 1) {
        seg = { kind: 'code', text: text.slice(i + 1, close) }
        next = close + 1
      }
    } else if (char === '*' && text[i + 1] === '*') {
      const close = opensEmphasis(text, i, 2, false) ? emphasisCloser(text, i, '**', false) : -1
      if (close !== -1) {
        seg = { kind: 'bold', text: text.slice(i + 2, close) }
        next = close + 2
      }
    } else if ((char === '*' || char === '_') && opensEmphasis(text, i, 1, true)) {
      const close = emphasisCloser(text, i, char, true)
      if (close !== -1) {
        seg = { kind: 'italic', text: text.slice(i + 1, close), marker: char }
        next = close + 1
      }
    } else if (char === '[') {
      const close = text.indexOf(']', i + 1)
      if (close > i + 1 && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2)
        const url = end === -1 ? '' : text.slice(close + 2, end)
        if (url !== '' && !/\s/.test(url)) {
          seg = { kind: 'link', text: text.slice(i + 1, close), url }
          next = end + 1
        }
      }
    }

    if (seg) {
      flush()
      out.push(seg)
      i = next
      continue
    }
    // Nothing opened here, or what did was never closed: literal.
    plain += char
    i++
  }
  flush()
  return out
}

// ── Tables ───────────────────────────────────────────────────────────
//
// A table is a header row, a delimiter row, and zero or more body rows:
//
//   | Name | Role     |
//   | ---- | -------- |
//   | Ada  | Engineer |
//
// Rows must open AND close with a pipe. GFM also accepts rows without
// the outer pipes, but requiring them keeps detection unambiguous —
// prose that merely contains a `|` never turns into a table.

// Split a row's source into its pipe markers and its cell contents. The
// pieces interleave marker/cell/marker/…/marker and rejoin to exactly
// the input, so markers.length === cells.length + 1 always.
//
// Padding whitespace around a cell rides on the adjacent marker rather
// than on the cell, so `| Ada |` and `|Ada|` hold the same cell.
export interface TableRowParts { markers: string[], cells: string[] }

export function splitTableRow(text: string): TableRowParts | null {
  const pipes: number[] = []
  for (let i = 0; i < text.length; i++) if (text[i] === '|') pipes.push(i)
  if (pipes.length < 2) return null
  const markers: string[] = []
  const cells: string[] = []
  let markerStart = 0
  for (let p = 0; p < pipes.length - 1; p++) {
    const raw = text.slice(pipes[p] + 1, pipes[p + 1])
    let lead = /^[ \t]*/.exec(raw)![0]
    // An all-whitespace cell is an empty one, and its padding belongs to
    // neither side in particular. Split it down the middle so typing
    // into a fresh row grows `| a | b |` rather than `| a| b|` — the
    // greedy read would hand every space to the leading marker and
    // leave the writer's file ragged.
    if (lead.length === raw.length) lead = raw.slice(0, Math.ceil(raw.length / 2))
    const trail = /[ \t]*$/.exec(raw.slice(lead.length))![0]
    markers.push(text.slice(markerStart, pipes[p] + 1) + lead)
    cells.push(raw.slice(lead.length, raw.length - trail.length))
    markerStart = pipes[p + 1] - trail.length
  }
  markers.push(text.slice(markerStart))
  return { markers, cells }
}

// Per-column alignment, read off the delimiter row's colons the way GFM
// defines them: `:---` left, `---:` right, `:---:` centre, and a bare
// `---` unset — which renders left, but stays distinguishable so
// neither renderer writes a style nobody asked for.
export type TableAlign = null | 'left' | 'center' | 'right'

export function parseTableAligns(delimText: string): TableAlign[] {
  const parts = splitTableRow(delimText)
  if (!parts) return []
  return parts.cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right)         return 'right'
    if (left)          return 'left'
    return null
  })
}

// The source text of a delimiter row for a table of `columns` columns.
export function tableDelimTextFor(columns: number): string {
  return '|' + ' --- |'.repeat(Math.max(1, columns))
}

// Two spaces per empty cell, so splitTableRow's half-split gives each
// cell one space on either side and the row reads as `|  |  |` in the
// file rather than collapsing all its padding to the left.
export function emptyTableRowText(columns: number): string {
  return '|' + '  |'.repeat(Math.max(1, columns))
}
