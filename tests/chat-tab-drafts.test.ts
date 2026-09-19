import { afterEach, expect, it, vi } from 'vitest'
import { DRAFT_SNAPSHOT_KEY, parseDraftSnapshot } from '../src/self-update-drafts'
import { registerDraftProvider, snapshotDrafts } from '../src/self-update-watch'
function store() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } }
}
afterEach(() => vi.unstubAllGlobals())
it('writes an update snapshot into this tab only, never the shared origin store', () => {
  const shared = store(), tab = store()
  vi.stubGlobal('localStorage', shared); vi.stubGlobal('sessionStorage', tab)
  const release = registerDraftProvider(() => ({ fromSha: null, activeSessionId: 'mine', fresh: { draft: null, modelIdentity: null },
    sessions: [['mine', { text: 'Private to this tab', attachments: [], mentions: [], mode: null }]] }))
  try {
    expect(snapshotDrafts()).toBe(true)
    expect(shared.getItem(DRAFT_SNAPSHOT_KEY)).toBeNull()
    expect(parseDraftSnapshot(tab.getItem(DRAFT_SNAPSHOT_KEY))?.sessions.mine.text).toBe('Private to this tab')
    vi.stubGlobal('sessionStorage', { setItem() { throw new Error('quota') } })
    expect(snapshotDrafts()).toBe(false)
    expect(shared.getItem(DRAFT_SNAPSHOT_KEY)).toBeNull()
  } finally { release() }
})
