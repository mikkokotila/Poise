/** One free-text memory shared by Chat sessions in this Poise installation. */
export interface ChatMemories { text: string, revision: number }
export const MEMORIES_MAX_BYTES = 64 * 1024
export function parseChatMemories(value: unknown): ChatMemories | null {
  if (!value || typeof value !== 'object') return null
  const data = value as ChatMemories
  return typeof data.text === 'string' && Number.isSafeInteger(data.revision) && data.revision >= 0
    ? { text: data.text, revision: data.revision } : null
}
