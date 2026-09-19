// Renders an agent reply as read-only HTML.
//
// Agent output is markdown by convention — headings, lists, fenced code,
// tables — and the chat pane used to drop all of it into a <pre>, so a
// reply arrived as a wall of asterisks and pipes that was harder to read
// than the plain prose it was trying to format.
//
// What markdown *is* isn't decided here: src/markdown-syntax.ts owns the
// grammar so that this renderer and the editor's live one can never
// drift apart. This file owns only the two things that are its own
// business — what HTML to emit, and staying safe with text an agent
// wrote.
//
// Safety is structural rather than a filter. Every string that reaches
// the output passes through `escapeHtml` at the moment it is emitted,
// and there are exactly three places that emit text: `inlineHtml` for
// prose, `escapeHtml` directly for code blocks, and the link href, which
// is scheme-checked first. Nothing else writes into the buffer, so there
// is no path by which a `<script>` in a reply survives as markup.
//
// The escaping deliberately happens on the way out rather than to the
// whole input up front: a `>` escaped to `&gt;` before parsing is no
// longer a blockquote to any parser that reads it, and the grammar this
// file shares with the editor reads raw markdown.

import { chatFileReference } from './chat-file-reference'

export interface MarkdownOptions { localFileLinks?: boolean }

import {
  type BlockKind,
  type InlineSegment,
  classifyLines,
  blockMarkerLength,
  codeFenceLang,
  inlineSource,
  parseInline,
  parseTableAligns,
  splitTableRow,
} from './markdown-syntax'

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

// Only http(s) links navigate. Chat can opt in to inert, app-handled file
// links whose reads are authorized by the server; other consumers retain
// the text-only fallback for local paths and all unsafe schemes.
function safeHref(url: string): string | null {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  // Whitespace and angle brackets have no business in a URL here, and a
  // quote would end the attribute. Refuse rather than emit an href
  // nobody meant to write. Escaping the quote would also be safe, but a
  // URL containing one is a sign the text was never a link at all.
  if (/[\s<>"']/.test(trimmed)) return null
  return trimmed
}

function inlineHtml(segments: InlineSegment[], options: MarkdownOptions): string {
  let out = ''
  for (const seg of segments) {
    switch (seg.kind) {
      case 'bold':
        out += `<strong>${escapeHtml(seg.text)}</strong>`
        break
      case 'italic':
        out += `<em>${escapeHtml(seg.text)}</em>`
        break
      case 'code':
        out += `<code>${escapeHtml(seg.text)}</code>`
        break
      case 'link': {
        const href = safeHref(seg.url)
        // A rejected link falls back to the source that produced it —
        // escaped, inert, and still readable as what the agent wrote.
        if (href) out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(seg.text)}</a>`
        else if (options.localFileLinks && chatFileReference(seg.url)) {
          out += `<a href="#chat-file=${encodeURIComponent(seg.url)}" data-chat-file="${escapeHtml(seg.url)}" title="Preview ${escapeHtml(seg.url)}">${escapeHtml(seg.text)}</a>`
        } else out += escapeHtml(inlineSource(seg))
        break
      }
      default:
        out += escapeHtml(seg.text)
    }
  }
  return out
}

// The content of a line, with its block marker taken off — `# ` on a
// heading, `- ` on a list item — since this renderer expresses those as
// tags rather than keeping the source.
function contentOf(text: string, kind: BlockKind): string {
  return text.slice(blockMarkerLength(kind, text))
}

function inlineOf(text: string, kind: BlockKind, options: MarkdownOptions): string {
  return inlineHtml(parseInline(contentOf(text, kind)), options)
}

const ALIGN_STYLE: Record<string, string> = {
  left:   ' style="text-align:left"',
  center: ' style="text-align:center"',
  right:  ' style="text-align:right"',
}

export function renderMarkdown(src: string, options: MarkdownOptions = {}): string {
  const lines = String(src ?? '').split('\n')
  const kinds = classifyLines(lines)
  const out: string[] = []
  let i = 0

  // Runs of same-kind lines that become one element: a paragraph, a
  // list, a quote. Each is gathered here rather than in the grammar,
  // because the editor groups none of them.
  const runOf = (test: (k: BlockKind, text: string) => boolean): string[] => {
    const body: string[] = []
    while (i < lines.length && test(kinds[i], lines[i])) { body.push(lines[i]); i++ }
    return body
  }

  while (i < lines.length) {
    const kind = kinds[i]
    const line = lines[i]

    if (kind === 'code-fence-open') {
      const lang = codeFenceLang(line)
      const body: string[] = []
      i++
      while (i < lines.length && kinds[i] === 'code-content') { body.push(lines[i]); i++ }
      if (i < lines.length && kinds[i] === 'code-fence-close') i++   // or the end of an unterminated block
      out.push(`<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    if (kind === 'table-head') {
      const head = line
      const aligns = parseTableAligns(lines[i + 1] ?? '')
      i += 2   // header and delimiter
      const rows: string[] = []
      while (i < lines.length && kinds[i] === 'table-row') { rows.push(lines[i]); i++ }
      const cellsOf = (row: string, tag: 'th' | 'td') => {
        const parts = splitTableRow(row)
        if (!parts) return ''
        return parts.cells
          .map((cell, c) => `<${tag}${ALIGN_STYLE[aligns[c] ?? ''] ?? ''}>${inlineHtml(parseInline(cell), options)}</${tag}>`)
          .join('')
      }
      const bodyHtml = rows.map((row) => `<tr>${cellsOf(row, 'td')}</tr>`).join('')
      out.push(
        `<table class="md-table"><thead><tr>${cellsOf(head, 'th')}</tr></thead>`
        + (bodyHtml ? `<tbody>${bodyHtml}</tbody>` : '')
        + '</table>',
      )
      continue
    }

    if (kind === 'rule') { out.push('<hr class="md-hr">'); i++; continue }

    if (kind[0] === 'h' && kind.length === 2) {
      out.push(`<h${kind[1]} class="md-h">${inlineOf(line, kind, options)}</h${kind[1]}>`)
      i++
      continue
    }

    if (kind === 'quote') {
      const body = runOf((k) => k === 'quote')
      out.push(`<blockquote class="md-quote">${body.map((l) => inlineOf(l, 'quote', options)).join('<br>')}</blockquote>`)
      continue
    }

    if (kind === 'list-item') {
      // `-` opens a bullet list, a digit opens a numbered one; a run
      // ends when the flavour changes so the two never share a list.
      const numbered = /^\d/.test(line)
      const body = runOf((k, text) => k === 'list-item' && /^\d/.test(text) === numbered)
      const tag = numbered ? 'ol' : 'ul'
      out.push(`<${tag} class="md-list">${body.map((l) => `<li>${inlineOf(l, 'list-item', options)}</li>`).join('')}</${tag}>`)
      continue
    }

    if (/^\s*$/.test(line)) { i++; continue }

    // Anything left is prose. Consecutive prose lines are one paragraph
    // with hard breaks between them, which is how a reply's own line
    // wrapping is meant to read.
    const body = runOf((k, text) => k === 'body' && !/^\s*$/.test(text))
    out.push(`<p>${body.map((l) => inlineOf(l, 'body', options)).join('<br>')}</p>`)
  }

  return out.join('')
}
