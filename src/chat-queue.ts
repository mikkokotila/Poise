import type { MessageQueue, PromptInput } from '../server/chat/protocol'

/** Both a pasted command and the command-chip form are handled before steer. */
export function parseQueueMessage(text: string, mode?: string | null): string | null {
  const match = /^\/queue(?=\s|$)([\s\S]*)$/i.exec(text.trimStart())
  return match ? match[1].trim() : mode === 'queue' ? text.trim() : null
}
interface Store { getItem(key: string): string | null, setItem(key: string, value: string): void }
export interface PendingQueueMessage { id: string, sessionId: string, prompt: PromptInput, model: string, effort: string }
export const PENDING_QUEUE_KEY = 'poise-chat-pending-queue'
const memory = new WeakMap<Store, PendingQueueMessage[]>()
const unavailable = new WeakSet<Store>()
function read(store: Store): PendingQueueMessage[] {
  if (unavailable.has(store)) return memory.get(store) || []
  try {
    const value: unknown = JSON.parse(store.getItem(PENDING_QUEUE_KEY) || '[]')
    if (Array.isArray(value)) return value.filter(item => item && typeof item.id === 'string' && typeof item.sessionId === 'string'
      && item.prompt && typeof item.prompt.text === 'string' && typeof item.model === 'string' && typeof item.effort === 'string')
  } catch { /* use the page-local receipts when storage is unavailable */ }
  return memory.get(store) || []
}
function write(store: Store, items: PendingQueueMessage[]): void {
  memory.set(store, items)
  try { store.setItem(PENDING_QUEUE_KEY, JSON.stringify(items)); unavailable.delete(store) } catch { unavailable.add(store) }
}
export function reserveQueuedMessage(store: Store, sessionId: string, prompt: PromptInput, model: string, effort: string, preferredId = crypto.randomUUID()): PendingQueueMessage {
  const pending = read(store)
  const previous = pending.find(item => item.sessionId === sessionId && JSON.stringify(item.prompt) === JSON.stringify(prompt))
  if (previous) return previous
  const item = { id: preferredId, sessionId, prompt, model, effort }
  write(store, [...pending, item])
  return item
}
export function releaseQueuedMessage(store: Store, id: string): void {
  write(store, read(store).filter(item => item.id !== id))
}

/** Reject malformed acknowledgements instead of dropping an unsaved message. */
export function parseMessageQueue(value: unknown): MessageQueue | null {
  if (!value || typeof value !== 'object') return null
  const queue = value as MessageQueue
  if (!Number.isSafeInteger(queue.revision) || queue.revision < 0 || typeof queue.ready !== 'boolean' || !Array.isArray(queue.items)) return null
  if (!queue.items.every(item => item && typeof item.id === 'string' && typeof item.model === 'string' && typeof item.agent === 'string'
    && ['waiting', 'running', 'failed'].includes(item.state) && item.prompt && typeof item.prompt.text === 'string'
    && Array.isArray(item.prompt.attachments) && Array.isArray(item.prompt.mentions))) return null
  return queue
}
