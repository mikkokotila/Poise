import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'
import { MEMORIES_MAX_BYTES, parseChatMemories, type ChatMemories } from '../../src/chat-memories-types'

const KEY = 'chat_memories'
/** Read at dispatch, not enqueue: all agents and sessions get the latest save. */
export function readMemories(): ChatMemories {
  const raw = getMeta(KEY)
  if (!raw) return { text: '', revision: 0 }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new HttpError(500, 'Saved memories could not be read.') }
  const data = parseChatMemories(value)
  if (!data) throw new HttpError(500, 'Saved memories could not be read.')
  return data
}
/** Compare-and-swap prevents a stale tab overwriting another tab's edit.
 * Retrying a completed save is harmless, including after a lost response. */
export const saveMemories = db.transaction((input: unknown): ChatMemories => {
  const next = parseChatMemories(input)
  if (!next) throw new HttpError(400, 'Memories require text and a non-negative integer revision.')
  if (Buffer.byteLength(next.text, 'utf8') > MEMORIES_MAX_BYTES) throw new HttpError(413, 'Memories exceed 64 KiB of UTF-8 text. Nothing was truncated or saved.')
  const current = readMemories()
  if (current.text === next.text) return current
  if (next.revision !== current.revision) throw new HttpError(409, 'Memories changed in another tab. Your draft has not replaced the saved text.')
  const saved = { text: next.text, revision: current.revision + 1 }
  setMeta(KEY, JSON.stringify(saved))
  return saved
})
