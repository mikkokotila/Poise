// The one typed entrypoint for a Poise self-change: `/poise <request>` or
// `Poise: <request>` at the very start of a message. It is recognised in the
// composer text the person submits and nowhere else — never in model output,
// never from a mention of Poise inside an ordinary message — so nothing an
// agent writes can turn into an implement-and-release order.
//
// Kept free of DOM imports so it runs under the node test environment.

export interface PoiseCommand {
  /** The implementation request, trimmed. Empty when only the prefix was typed. */
  request: string
  /** Which spelling was used, for the notice text. */
  form: 'slash' | 'prefix'
}

const SLASH = /^\/poise(?=\s|$)([\s\S]*)$/i
const PREFIX = /^Poise:(?=\s|$)([\s\S]*)$/

/** Parse a submitted message; `null` for anything that is not the command. */
export function parsePoiseCommand(text: string): PoiseCommand | null {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trimStart()
  let match = SLASH.exec(raw)
  if (match) return { request: match[1].trim(), form: 'slash' }
  match = PREFIX.exec(raw)
  if (match) return { request: match[1].trim(), form: 'prefix' }
  return null
}

/** Whether a string looks like a browser-minted change id (UUID v4-ish). */
export function isChangeId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function newChangeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Not a real UUID, but unique enough for a request id the server validates.
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`
}

/** A request that is still unacknowledged keeps its change id, so a retry after
 *  an in-doubt answer replays the same command instead of starting a second
 *  change. Keyed by source session and exact request text, kept in local
 *  storage — shared by every tab of this origin and surviving reloads — and
 *  never expired on its own: the server's receipt is durable, so the id stays
 *  until the server has answered for it (accepted, refused, or seen in its
 *  status) or a definitive local outcome released it. A silently minted second
 *  id would be a second change. */
export interface PendingChangeRequest { changeId: string, sessionId: string, request: string, createdAt: number }

export interface PendingChangeStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const PENDING_CHANGE_KEY = 'poise-self-change-pending'

export function readPendingChanges(store: PendingChangeStore): PendingChangeRequest[] {
  try {
    const raw = store.getItem(PENDING_CHANGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is PendingChangeRequest => !!p && typeof p === 'object'
      && isChangeId(p.changeId) && typeof p.sessionId === 'string' && typeof p.request === 'string'
      && typeof p.createdAt === 'number')
  } catch { return [] }
}

function writePending(store: PendingChangeStore, list: PendingChangeRequest[]): void {
  try {
    if (!list.length) store.removeItem(PENDING_CHANGE_KEY)
    else store.setItem(PENDING_CHANGE_KEY, JSON.stringify(list))
  } catch { /* the in-memory id still covers this page's lifetime */ }
}

/** The change id to send for this session+request: the one already pending, or a new one recorded now. */
export function reserveChangeId(store: PendingChangeStore, sessionId: string, request: string, now = Date.now()): string {
  const list = readPendingChanges(store)
  const found = list.find((p) => p.sessionId === sessionId && p.request === request)
  if (found) return found.changeId
  const changeId = newChangeId()
  writePending(store, [...list, { changeId, sessionId, request, createdAt: now }])
  return changeId
}

/** Forget a pending id once the server answered definitively (accepted or refused). */
export function releaseChangeId(store: PendingChangeStore, changeId: string): void {
  const list = readPendingChanges(store)
  const next = list.filter((p) => p.changeId !== changeId)
  if (next.length !== list.length) writePending(store, next)
}

/** Ids the server's status already lists are reconciled: it holds them durably,
 *  so a later retry from here would only be answered from its receipt anyway.
 *  Returns the ids released. */
export function reconcilePendingChanges(store: PendingChangeStore, knownChangeIds: Iterable<string>): string[] {
  const known = new Set(Array.from(knownChangeIds, (id) => id.toLowerCase()))
  const list = readPendingChanges(store)
  const released = list.filter((p) => known.has(p.changeId.toLowerCase())).map((p) => p.changeId)
  if (released.length) writePending(store, list.filter((p) => !known.has(p.changeId.toLowerCase())))
  return released
}
