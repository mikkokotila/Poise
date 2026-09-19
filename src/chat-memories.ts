import { parseChatMemories, type ChatMemories } from './chat-memories-types'

export const MEMORIES_DRAFT_KEY = 'poise-chat-memories-draft'
interface Store { getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }
interface MemoriesIO {
  read(): Promise<ChatMemories>
  write(value: ChatMemories): Promise<ChatMemories>
  store?: Store
  delayMs?: number
}
/** Serial autosaves preserve local drafts. Hiding never disables inclusion. */
export function createMemoriesEditor(io: MemoriesIO) {
  let base: ChatMemories = { text: '', revision: 0 }
  let text = ''
  let loaded = false
  let dirty = false
  let error: string | null = null
  let conflict = false
  let loading: Promise<void> | null = null
  let saving: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  try {
    const restored = parseChatMemories(JSON.parse(io.store?.getItem(MEMORIES_DRAFT_KEY) || 'null'))
    if (restored) { base.revision = restored.revision; text = restored.text; dirty = true }
  } catch { /* optional draft store */ }
  function persist() {
    try {
      if (dirty) io.store?.setItem(MEMORIES_DRAFT_KEY, JSON.stringify({ text, revision: base.revision }))
      else io.store?.removeItem(MEMORIES_DRAFT_KEY)
    } catch { /* reload guard still protects this page's draft */ }
  }
  function notify() { for (const listener of listeners) listener() }
  function describe(failure: unknown) { return failure instanceof Error ? failure.message : String(failure) }
  function load(refresh = false): Promise<void> {
    if (loading) return loading
    if (loaded && (!refresh || dirty || saving)) return Promise.resolve()
    loading = (async () => {
      try {
        const remote = await io.read()
        if (dirty && text !== remote.text) {
          if (base.revision !== remote.revision) {
            conflict = true
            error = 'Memories changed in another tab. Your draft is preserved; Retry save will replace the saved text with this draft.'
          }
          if (!conflict) base = remote
        } else {
          base = remote; text = remote.text; dirty = false; error = null; conflict = false
        }
        loaded = true
        persist()
      } catch (failure) { error = describe(failure); throw failure }
      finally { loading = null; notify() }
    })()
    notify(); return loading
  }
  function flush(): Promise<void> {
    clearTimeout(timer)
    if (saving) return saving
    if (!dirty) return Promise.resolve()
    saving = (async () => {
      try {
        await load()
        if (conflict) throw new Error(error || 'Memories changed in another tab.')
        while (dirty) {
          const saved = await io.write({ text, revision: base.revision })
          base = saved
          dirty = text !== saved.text
          error = null
          persist(); notify()
        }
      } catch (failure) {
        if (typeof failure === 'object' && failure && 'status' in failure && failure.status === 409) conflict = true
        error = describe(failure)
        persist()
        throw failure
      } finally { saving = null; notify() }
    })()
    notify(); return saving
  }
  return {
    load, flush,
    get state() { return { text, loaded, dirty, saving: !!saving, loading: !!loading, error, conflict } },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    edit(value: string) {
      // A conflict means the saved value is no longer our baseline. Typing
      // the old value back is still an unsaved choice, not a successful save.
      text = value; dirty = conflict || text !== base.text
      if (!conflict) error = null
      persist(); notify(); clearTimeout(timer)
      if (dirty && !conflict) timer = setTimeout(() => { void flush().catch(() => undefined) }, io.delayMs ?? 350)
    },
    async retry() {
      if (saving) await saving.catch(() => undefined)
      if (conflict) { base = await io.read(); conflict = false; error = null; dirty = text !== base.text; persist() }
      if (!loaded) await load()
      await flush()
    },
    dispose() { clearTimeout(timer); listeners.clear() },
  }
}

export async function readChatMemories(): Promise<ChatMemories> {
  return request('GET')
}
export async function writeChatMemories(value: ChatMemories): Promise<ChatMemories> {
  return request('PUT', value)
}
async function request(method: string, value?: ChatMemories): Promise<ChatMemories> {
  const response = await fetch('/api/chat/memories', { method, cache: 'no-store',
    ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const data: unknown = await response.json()
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'Memories could not be saved.'
    throw Object.assign(new Error(message), { status: response.status })
  }
  const parsed = parseChatMemories(data)
  if (!parsed) throw new Error('The server did not return saved memories. Your draft has been kept.')
  return parsed
}
