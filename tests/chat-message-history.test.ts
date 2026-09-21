import { describe, expect, it } from 'vitest'
import type { ChatEvent, PromptInput } from '../server/chat/protocol'
import { historyLabel, recentMessages } from '../src/chat-message-history'
import { addOptimisticTurn, applyEvent, createModel } from '../src/views/chat-transcript'

const prompt = (text: string): PromptInput => ({ text, attachments: [], mentions: [] })
function world() {
  const model = createModel()
  let seq = 0
  const emit = (event: ChatEvent) => applyEvent(model, { seq: ++seq, sessionId: 'history', at: new Date().toISOString(), event })
  const turn = (id: string, text: string) => emit({ type: 'turn.started', turnId: id, prompt: prompt(text) })
  return { model, emit, turn }
}

describe('recent user message history', () => {
  it('keeps the latest ten messages in chronological order, including steering', () => {
    const w = world()
    for (let i = 1; i <= 12; i++) w.turn(String(i), `Task ${i}`)
    w.emit({ type: 'steer.sent', turnId: '12', text: 'Also keep the tests' })
    const history = recentMessages(w.model)
    expect(history).toHaveLength(10)
    expect(history.map(entry => entry.draft.text)).toEqual([...Array.from({ length: 9 }, (_, i) => `Task ${i + 4}`), 'Also keep the tests'])
  })
  it('excludes assistant text, tool activity, empty shells and unacknowledged optimistic prompts', () => {
    const w = world(); w.turn('1', 'The actual user request')
    w.emit({ type: 'text.delta', turnId: '1', messageId: 'answer', delta: 'Not a user message' })
    w.emit({ type: 'thought.delta', turnId: '1', messageId: 'thought', delta: 'Internal thoughts' })
    w.emit({ type: 'text.delta', turnId: 'orphan', messageId: 'orphan-text', delta: 'Incomplete transcript shell' })
    addOptimisticTurn(w.model, prompt('Still waiting for acknowledgement'))
    expect(recentMessages(w.model).map(entry => entry.draft.text)).toEqual(['The actual user request'])
  })
  it('returns independent drafts with full multiline text and original attachment references', () => {
    const w = world()
    const original = { ...prompt('First line\n\nSecond line'), attachments: [{ id: 'file', name: 'notes.txt', path: 'uploads/notes.txt', size: 4 }], mentions: [{ path: 'README.md' }], memories: 'not a draft' }
    w.emit({ type: 'turn.started', turnId: 'files', prompt: original })
    const recalled = recentMessages(w.model)[0].draft
    expect(recalled).toEqual({ text: original.text, attachments: original.attachments, mentions: original.mentions, mode: null })
    recalled.attachments[0].name = 'edited'; recalled.mentions[0].path = 'changed'
    expect(original.attachments[0].name).toBe('notes.txt'); expect(original.mentions[0].path).toBe('README.md')
  })
  it('preserves the queue switch without initiating a new task', () => {
    const w = world()
    w.emit({ type: 'turn.started', turnId: 'queued', queueItemId: 'queue-1', prompt: prompt('Follow-up') })
    const item = recentMessages(w.model)[0]
    expect(item.draft).toMatchObject({ mode: 'queue', text: 'Follow-up' })
    expect(historyLabel(item)).toBe('/queue Follow-up')
  })
  it('does not recall an automatically generated initial handoff summary', () => {
    const w = world(); w.turn('summary', '[Handoff from another agent]')
    w.emit({ type: 'steer.sent', turnId: 'summary', text: 'My actual steering message' })
    w.turn('user', 'My next request')
    expect(recentMessages(w.model, { kind: 'handoff', title: 'Previous conversation' }).map(item => item.draft.text))
      .toEqual(['My actual steering message', 'My next request'])
  })
  it('shows attachment-only messages and keeps repeated messages as distinct entries', () => {
    const w = world(); w.turn('1', 'Continue'); w.turn('2', 'Continue')
    w.emit({ type: 'turn.started', turnId: 'file', prompt: { ...prompt(''), attachments: [{ id: 'f', name: 'image.png', path: 'uploads/image.png', size: 4 }] } })
    const items = recentMessages(w.model)
    expect(items.map(historyLabel)).toEqual(['Continue', 'Continue', 'image.png'])
    expect(new Set(items.map(item => item.id)).size).toBe(3)
  })
  it('only collapses whitespace in the label, preserving complete text for recall', () => {
    const w = world(); const text = 'Hello\n\nworld\t' + 'long text '.repeat(100)
    w.turn('1', text)
    const item = recentMessages(w.model)[0]
    expect(historyLabel(item)).not.toMatch(/[\r\n\t]/)
    expect(historyLabel(item)).toContain('long text '.repeat(99).trim())
    expect(item.draft.text).toBe(text)
  })
})

it('QC2: recalling a queued review keeps its original reviewer and effort', () => {
  const w = world()
  w.emit({ type: 'turn.started', turnId: 'queued', queueItemId: 'q1', agent: 'codex', model: 'gpt-6-astra-max', prompt: prompt('/review correctness') })
  expect(recentMessages(w.model)[0].draft).toMatchObject({ mode: 'queue', model: 'gpt-6-astra-max', text: '/review correctness' })
})

it('QC2: steering history carries independent copies of attached and mentioned context', () => {
  const w = world(); w.turn('task', 'Continue')
  const file = { id: 'f', name: 'notes.txt', path: 'uploads/notes.txt', size: 4 }
  w.emit({ type: 'steer.sent', turnId: 'task', text: '', attachments: [file], mentions: [{ path: 'README.md' }] })
  const recalled = recentMessages(w.model).at(-1)!
  expect(recalled.draft).toMatchObject({ text: '', attachments: [file], mentions: [{ path: 'README.md' }] })
  expect(historyLabel(recalled)).toBe('notes.txt')
  recalled.draft.attachments[0].name = 'changed'
  expect(file.name).toBe('notes.txt')
})
