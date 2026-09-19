import { describe, expect, it } from 'vitest'
import { recoverDraft } from '../src/chat-draft-recovery'
import { reconcileSession } from '../src/chat-session-state'
import { reserveChangeId } from '../src/self-update-command'
import type { ComposerDraft } from '../src/views/chat-composer'
import type { SessionRecord } from '../server/chat/protocol'
const draft = (text = '', mode: string | null = null): ComposerDraft => ({ text, mode, attachments: [], mentions: [] })

describe('QC draft and state recovery', () => {
  it('keeps new attachment-only drafts and deduplicates shared attachment IDs', () => {
    const a = { id: 'a', name: 'a.txt', path: 'a.txt', size: 1 }
    const b = { id: 'b', name: 'b.txt', path: 'b.txt', size: 1 }
    const recovered = recoverDraft({ ...draft('sent'), attachments: [a] }, { ...draft(), attachments: [a, b] })
    expect(recovered.text).toBe('sent')
    expect(recovered.attachments).toEqual([a, b])
  })
  it('normalizes command chips once without losing their semantics', () => {
    expect(recoverDraft(draft('/queue task', 'queue'), null)).toEqual(draft('task', 'queue'))
    expect(recoverDraft(draft('task'), draft('task'))).toEqual(draft('task'))
    expect(recoverDraft(draft('sent'), draft('new'))).toEqual(draft('sent\n\nnew'))
  })
  it('does not accidentally turn mixed command drafts into executable slash input', () => {
    const restored = recoverDraft(draft('queued', 'queue'), draft('discussion'))
    expect(restored.mode).toBeNull()
    expect(restored.text).toContain('queued')
    expect(restored.text).toContain('discussion')
    expect(restored.text.startsWith('/queue')).toBe(false)
  })
  it('keeps newer live state but accepts a independently newer queue snapshot', () => {
    const current = { lastSeq: 10, autoMerge: true, model: 'new', queue: { revision: 2, ready: false, items: [] } } as unknown as SessionRecord
    const stale = { lastSeq: 5, autoMerge: false, model: 'old', queue: { revision: 3, ready: true, items: [] } } as unknown as SessionRecord
    expect(reconcileSession(current, stale)).toMatchObject({ lastSeq: 10, autoMerge: true, model: 'new', queue: { revision: 3, ready: true } })
  })
  it('distinguishes self-change retries with different uploaded evidence', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) || null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
    const first = reserveChangeId(store, 's', 'same words', 1, 'file-a')
    expect(reserveChangeId(store, 's', 'same words', 2, 'file-a')).toBe(first)
    expect(reserveChangeId(store, 's', 'same words', 3, 'file-b')).not.toBe(first)
  })
})
