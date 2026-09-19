import { describe, expect, it } from 'vitest'
import { parseMessageQueue, parseQueueMessage, reserveQueuedMessage, releaseQueuedMessage, PENDING_QUEUE_KEY } from '../src/chat-queue'
const prompt = { text: 'later', attachments: [], mentions: [] }
function store() {
  const entries = new Map<string, string>()
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
}
describe('queue switch and delivery receipts', () => {
  it('recognizes the switch and chip without treating ordinary prose or longer words as commands', () => {
    expect(parseQueueMessage('/queue After this')).toBe('After this')
    expect(parseQueueMessage(' /QUEUE\nAfter this\nAnd that')).toBe('After this\nAnd that')
    expect(parseQueueMessage('After this', 'queue')).toBe('After this')
    expect(parseQueueMessage('/queue')).toBe('')
    for (const text of ['Discuss /queue', '/queued something', 'queue this', '/queues x']) expect(parseQueueMessage(text)).toBeNull()
  })
  it('retains one item identity after a lost acknowledgement even when the selected model changed', () => {
    const storage = store()
    const first = reserveQueuedMessage(storage, 'session', prompt, 'm1', 'high')
    expect(reserveQueuedMessage(storage, 'session', prompt, 'm2', 'max')).toEqual(first)
    expect(reserveQueuedMessage(storage, 'other', prompt, 'm2', 'max').id).not.toBe(first.id)
    releaseQueuedMessage(storage, first.id)
    expect(reserveQueuedMessage(storage, 'session', prompt, 'm1', 'high').id).not.toBe(first.id)
  })
  it('ignores malformed saved receipts and remains usable with unavailable storage', () => {
    const storage = store(); storage.setItem(PENDING_QUEUE_KEY, '[null,{},"bad"]')
    expect(reserveQueuedMessage(storage, 's', prompt, 'm', 'high').sessionId).toBe('s')
    const unavailable = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    const first = reserveQueuedMessage(unavailable, 's', prompt, 'm', 'high')
    expect(reserveQueuedMessage(unavailable, 's', prompt, 'm', 'high').id).toBe(first.id)
    const full = { getItem() { return null }, setItem() { throw new Error('quota') } }
    const pending = reserveQueuedMessage(full, 's', prompt, 'm', 'high')
    expect(reserveQueuedMessage(full, 's', prompt, 'm', 'high').id).toBe(pending.id)
  })
  it('validates acknowledgements before the browser drops the pending message', () => {
    expect(parseMessageQueue({ revision: 1, ready: false, items: [] })).not.toBeNull()
    for (const value of [null, {}, { revision: -1, ready: true, items: [] }, { revision: 1, ready: false, items: [{}] }]) expect(parseMessageQueue(value)).toBeNull()
  })
})
