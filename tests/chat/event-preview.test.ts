import { describe, expect, it } from 'vitest'
import { clientEnvelope, DIFF_PREVIEW_CHARS } from '../../server/chat/event-preview'
import type { ChatEnvelope } from '../../server/chat/protocol'

function envelope(event: ChatEnvelope['event']): ChatEnvelope {
  return { sessionId: 'session', seq: 42, at: '2026-09-18T16:00:00Z', event }
}

describe('bounded live event previews', () => {
  it('bounds even heavily JSON-escaped diffs without changing the immutable full record', () => {
    const oldText = '\u0001'.repeat(2 * 1024 * 1024)
    const newText = '\n'.repeat(2 * 1024 * 1024)
    const original = envelope({ type: 'diff', turnId: 'turn', toolId: 'tool', diffId: 'diff', path: 'large.txt', oldText, newText, oldExists: true, newExists: true })
    const preview = clientEnvelope(original)
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(1024 * 1024)
    expect(preview).toMatchObject({ seq: 42, event: { diffId: 'diff', previewOnly: true, oldText: oldText.slice(0, DIFF_PREVIEW_CHARS) } })
    expect(original.event).toMatchObject({ oldText, newText })
    expect('previewOnly' in original.event).toBe(false)
  })

  it('does not copy or truncate ordinary diff records', () => {
    const original = envelope({ type: 'diff', turnId: 'turn', toolId: 'tool', diffId: 'diff', path: 'small.txt', oldText: 'before', newText: 'after', oldExists: true, newExists: true })
    expect(clientEnvelope(original)).toBe(original)
  })

  it('previews large write-tool inputs but preserves IDs and permission options', () => {
    const input = { path: 'large.txt', content: 'x'.repeat(2 * 1024 * 1024) }
    const options = [{ id: 'allow', name: 'Allow once', kind: 'allow_once' as const }]
    const original = envelope({ type: 'permission.requested', id: 'request', turnId: 'turn', title: 'Write large.txt', input, options })
    const preview = clientEnvelope(original)
    expect(preview.event).toMatchObject({ id: 'request', options, input: { truncated: true } })
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(128 * 1024)
    expect(original.event).toMatchObject({ input })
  })

  it('also bounds diffs embedded in native tool completion content', () => {
    const original = envelope({ type: 'tool.finished', id: 'tool', turnId: 'turn', status: 'completed', content: [{ type: 'diff', path: 'big.txt', oldText: 'x'.repeat(1024 * 1024), newText: 'y'.repeat(1024 * 1024) }] })
    const preview = clientEnvelope(original)
    expect(preview.event).toMatchObject({ content: [{ previewOnly: true }] })
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(128 * 1024)
  })
})
