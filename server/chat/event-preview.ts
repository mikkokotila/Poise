// Full reversible records stay in SQLite. Live/history payloads carry a
// bounded preview, so a large file cannot trap reconnect in an oversized
// frame loop. Complete immutable diffs are loaded only on explicit request.
import type { ChatEnvelope, ContentBlock } from './protocol'
export const DIFF_PREVIEW_CHARS = 32_768
const INPUT_PREVIEW_CHARS = 32_768
const CONTENT_PREVIEW_CHARS = 256 * 1024

function inputPreview(value: unknown): unknown {
  if (value === undefined) return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text || text.length <= INPUT_PREVIEW_CHARS) return value
  return { truncated: true, preview: text.slice(0, INPUT_PREVIEW_CHARS), note: 'Large tool input preview; the complete input remains in the local transcript.' }
}

function contentPreview(block: ContentBlock): ContentBlock {
  if (block.type === 'diff') {
    if (block.oldText.length <= DIFF_PREVIEW_CHARS && block.newText.length <= DIFF_PREVIEW_CHARS) return block
    return { ...block, oldText: block.oldText.slice(0, DIFF_PREVIEW_CHARS), newText: block.newText.slice(0, DIFF_PREVIEW_CHARS), previewOnly: true }
  }
  if (block.text.length <= CONTENT_PREVIEW_CHARS) return block
  return { ...block, text: block.text.slice(0, CONTENT_PREVIEW_CHARS) + '\n… [large content preview; full record retained locally]' }
}

export function clientEnvelope(envelope: ChatEnvelope): ChatEnvelope {
  const event = envelope.event
  if (event.type === 'diff') {
    if (event.oldText.length <= DIFF_PREVIEW_CHARS && event.newText.length <= DIFF_PREVIEW_CHARS) return envelope
    return { ...envelope, event: { ...event, oldText: event.oldText.slice(0, DIFF_PREVIEW_CHARS), newText: event.newText.slice(0, DIFF_PREVIEW_CHARS), previewOnly: true } }
  }
  if (event.type === 'tool.started' || event.type === 'permission.requested') {
    const input = inputPreview(event.input)
    return input === event.input ? envelope : { ...envelope, event: { ...event, input } }
  }
  if ((event.type === 'tool.updated' || event.type === 'tool.finished') && event.content) {
    return { ...envelope, event: { ...event, content: event.content.map(contentPreview) } }
  }
  return envelope
}
