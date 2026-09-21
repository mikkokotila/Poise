// What a safe reload carries across: every Chat draft, by session, plus the
// fresh console's draft and model choice, which session was on screen and the
// composer's input mode. Attachments are the server's records (ids and paths);
// a File still uploading cannot be serialised and blocks the reload instead.
//
// The snapshot lives in this tab's sessionStorage, is read once by the next
// page, and expires: a snapshot nobody consumed is not restored an hour later
// over whatever the person has typed since.

import type { Attachment, Mention } from '../server/chat/protocol'

export interface DraftSnapshotDraft {
  model?: string
  text: string
  attachments: Attachment[]
  mentions: Mention[]
  mode: string | null
}

export interface DraftSnapshot {
  version: 1
  savedAt: number
  /** Build the page was running when it saved, for diagnostics only. */
  fromSha: string | null
  activeSessionId: string | null
  fresh: { draft: DraftSnapshotDraft | null, modelIdentity: string | null }
  sessions: Record<string, DraftSnapshotDraft>
}

export interface SnapshotStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DRAFT_SNAPSHOT_KEY = 'poise-chat-draft-snapshot'
export const DRAFT_SNAPSHOT_TTL_MS = 15 * 60_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function cleanAttachment(v: unknown): Attachment | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.path !== 'string') return null
  const a: Attachment = { id: v.id, name: v.name, path: v.path, size: typeof v.size === 'number' ? v.size : 0 }
  if (typeof v.text === 'string') a.text = v.text
  return a
}

/** Copy a draft to plain data. Returns `null` for an empty draft so the
 *  snapshot never restores a blank over a session's own state. */
export function cleanDraft(v: unknown): DraftSnapshotDraft | null {
  if (!isRecord(v)) return null
  const text = typeof v.text === 'string' ? v.text : ''
  const attachments = Array.isArray(v.attachments) ? v.attachments.map(cleanAttachment).filter((a): a is Attachment => !!a) : []
  const mentions = Array.isArray(v.mentions) ? v.mentions.filter((m): m is Mention => isRecord(m) && typeof m.path === 'string').map((m) => ({ path: m.path })) : []
  const mode = typeof v.mode === 'string' && v.mode ? v.mode : null
  const model = typeof v.model === 'string' && v.model && v.model.length < 200 && !/\s/.test(v.model) ? v.model : undefined
  if (!text && !attachments.length && !mode && !model) return null
  return { text, attachments, mentions, mode, ...(model ? { model } : {}) }
}

export interface DraftSnapshotInput {
  fromSha: string | null
  activeSessionId: string | null
  fresh: { draft: unknown, modelIdentity: string | null }
  sessions: Iterable<[string, unknown]>
}

export function buildDraftSnapshot(input: DraftSnapshotInput, now = Date.now()): DraftSnapshot {
  const sessions: Record<string, DraftSnapshotDraft> = {}
  for (const [id, draft] of input.sessions) {
    if (!id || id.startsWith('pending-')) continue
    const clean = cleanDraft(draft)
    if (clean) sessions[id] = clean
  }
  return {
    version: 1,
    savedAt: now,
    fromSha: input.fromSha,
    activeSessionId: input.activeSessionId && !input.activeSessionId.startsWith('pending-') ? input.activeSessionId : null,
    fresh: { draft: cleanDraft(input.fresh.draft), modelIdentity: input.fresh.modelIdentity || null },
    sessions,
  }
}

export function parseDraftSnapshot(raw: string | null, now = Date.now()): DraftSnapshot | null {
  if (!raw) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!isRecord(v) || v.version !== 1 || typeof v.savedAt !== 'number') return null
  if (now - v.savedAt > DRAFT_SNAPSHOT_TTL_MS || v.savedAt - now > 60_000) return null
  const sessions: Record<string, DraftSnapshotDraft> = {}
  if (isRecord(v.sessions)) {
    for (const [id, draft] of Object.entries(v.sessions)) {
      const clean = cleanDraft(draft)
      if (clean) sessions[id] = clean
    }
  }
  const fresh = isRecord(v.fresh) ? v.fresh : {}
  return {
    version: 1,
    savedAt: v.savedAt,
    fromSha: typeof v.fromSha === 'string' ? v.fromSha : null,
    activeSessionId: typeof v.activeSessionId === 'string' && v.activeSessionId ? v.activeSessionId : null,
    fresh: { draft: cleanDraft(fresh.draft), modelIdentity: typeof fresh.modelIdentity === 'string' && fresh.modelIdentity ? fresh.modelIdentity : null },
    sessions,
  }
}

/** Persist; `false` when storage refused (quota, private mode), in which case
 *  the caller must not reload automatically. */
export function saveDraftSnapshot(store: SnapshotStore, snapshot: DraftSnapshot): boolean {
  try {
    const raw = JSON.stringify(snapshot)
    store.setItem(DRAFT_SNAPSHOT_KEY, raw)
    // Read it back: a silently truncated write is the worst kind.
    return store.getItem(DRAFT_SNAPSHOT_KEY) === raw
  } catch {
    return false
  }
}

/** Read and remove: one page consumes a snapshot, the next never sees it. */
export function takeDraftSnapshot(store: SnapshotStore, now = Date.now()): DraftSnapshot | null {
  let raw: string | null = null
  try { raw = store.getItem(DRAFT_SNAPSHOT_KEY) } catch { return null }
  try { store.removeItem(DRAFT_SNAPSHOT_KEY) } catch { /* nothing more to do */ }
  return parseDraftSnapshot(raw, now)
}
