import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoriesEditor, MEMORIES_DRAFT_KEY } from '../src/chat-memories'
import type { ChatMemories } from '../src/chat-memories-types'
const editors: ReturnType<typeof createMemoriesEditor>[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.useRealTimers() })
function world(initial = 'initial') {
  let remote: ChatMemories = { text: initial, revision: 0 }
  const stored = new Map<string, string>()
  const store = { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) } }
  const read = vi.fn(async () => ({ ...remote }))
  const write = vi.fn(async (next: ChatMemories) => {
    if (next.text !== remote.text && next.revision !== remote.revision) throw Object.assign(new Error('another tab changed memories'), { status: 409 })
    remote = { text: next.text, revision: remote.revision + 1 }; return { ...remote }
  })
  const make = () => { const editor = createMemoriesEditor({ read, write, store }); editors.push(editor); return editor }
  return { make, read, write, store, change: (text: string) => { remote = { text, revision: remote.revision + 1 } } }
}
describe('memory editor autosaving', () => {
  it('debounces edits, flushes immediately before send, and clears the recovery draft', async () => {
    vi.useFakeTimers()
    const w = world(); const editor = w.make(); await editor.load()
    editor.edit('one'); editor.edit('two')
    expect(w.write).not.toHaveBeenCalled()
    await editor.flush()
    expect(w.write).toHaveBeenCalledExactlyOnceWith({ text: 'two', revision: 0 })
    expect(editor.state).toMatchObject({ text: 'two', dirty: false, saving: false })
    expect(w.store.getItem(MEMORIES_DRAFT_KEY)).toBeNull()
  })
  it('drains edits typed while a previous save is in flight without replacing the textarea', async () => {
    const w = world(); const editor = w.make(); await editor.load()
    let finish!: (value: ChatMemories) => void
    w.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    editor.edit('first'); const flushed = editor.flush()
    await vi.waitFor(() => expect(w.write).toHaveBeenCalledTimes(1))
    editor.edit('newer')
    finish({ text: 'first', revision: 0 })
    await flushed
    expect(editor.state.text).toBe('newer')
    expect(w.write).toHaveBeenCalledTimes(2)
    expect(editor.state.dirty).toBe(false)
  })
  it('preserves unsaved text across a reload and a save failure', async () => {
    const w = world(); const editor = w.make(); await editor.load()
    w.write.mockRejectedValueOnce(new Error('offline'))
    editor.edit('keep this')
    await expect(editor.flush()).rejects.toThrow('offline')
    editor.dispose()
    const reopened = w.make(); await reopened.load(); await reopened.flush()
    expect(reopened.state).toMatchObject({ text: 'keep this', dirty: false })
  })
  it('does not automatically overwrite a conflicting edit, even after another reload', async () => {
    const w = world(); const editor = w.make(); await editor.load()
    editor.edit('local draft'); w.change('other tab')
    await expect(editor.flush()).rejects.toThrow('another tab')
    editor.dispose()
    const reopened = w.make(); await reopened.load()
    expect(reopened.state).toMatchObject({ text: 'local draft', conflict: true, dirty: true })
    await expect(reopened.flush()).rejects.toThrow('another tab')
    reopened.dispose()
    const again = w.make(); await again.load()
    expect(again.state.conflict).toBe(true)
    await again.retry()
    expect(again.state).toMatchObject({ text: 'local draft', dirty: false, conflict: false })
  })
  it('refreshes clean text from another tab without requiring an agent turn', async () => {
    const w = world(); const editor = w.make(); await editor.load()
    w.change('new saved text'); await editor.load(true)
    expect(editor.state.text).toBe('new saved text')
    expect(w.write).not.toHaveBeenCalled()
  })
  it('allows clearing and keeps the text when browser storage is unavailable', async () => {
    const read = async () => ({ text: 'old', revision: 0 })
    const write = vi.fn(async (value: ChatMemories) => ({ ...value, revision: 1 }))
    const editor = createMemoriesEditor({ read, write, store: { getItem() { throw new Error('unavailable') }, setItem() { throw new Error('unavailable') }, removeItem() { throw new Error('unavailable') } } })
    editors.push(editor); await editor.load(); editor.edit(''); await editor.flush()
    expect(editor.state).toMatchObject({ text: '', dirty: false })
  })
})
