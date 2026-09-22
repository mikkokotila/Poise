import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'
import { parseChatSwitches, switchName, RESERVED_SWITCHES, SWITCH_LIMITS, type ChatSwitches } from '../../src/chat-switches'

const KEY = 'chat_custom_switches'

export function readSwitches(): ChatSwitches {
  const raw = getMeta(KEY)
  if (!raw) return { revision: 0, switches: [] }
  let data: ChatSwitches | null = null
  try { data = parseChatSwitches(JSON.parse(raw)) } catch { /* report unreadable saved data */ }
  if (!data) throw new HttpError(500, 'Saved switches could not be read. No definitions were replaced.')
  return data
}
/** Exact retries are harmless. Revision checks protect edits from stale tabs. */
export const saveSwitch = db.transaction((input: { name: string, content: string, revision: number }, nativeNames: string[] = []): ChatSwitches => {
  if (!input || typeof input.name !== 'string' || typeof input.content !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new HttpError(400, 'A switch requires a name, text and a non-negative revision.')
  const name = switchName(input.name)
  if (RESERVED_SWITCHES.has(name) || nativeNames.some(native => native.replace(/^\//, '').toLowerCase() === name)) throw new HttpError(400, `/${name} is already a built-in or native command. Choose another name.`)
  if (!input.content.trim()) throw new HttpError(400, 'The switch instructions cannot be empty.')
  if (Buffer.byteLength(input.content, 'utf8') > SWITCH_LIMITS.contentBytes) throw new HttpError(413, 'Switch instructions exceed 64 KiB. Nothing was truncated or saved.')
  const current = readSwitches()
  const existing = current.switches.find(item => item.name === name)
  if (existing?.content === input.content) return current
  if (input.revision !== (existing?.revision ?? 0)) throw new HttpError(409, `/${name} changed in another tab. Your draft was kept; check the saved switch before replacing it.`)
  const item = { name, content: input.content, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
  const next = { revision: current.revision + 1, switches: [...current.switches.filter(item => item.name !== name), item].sort((a, b) => a.name.localeCompare(b.name)) }
  if (next.switches.length > SWITCH_LIMITS.count || Buffer.byteLength(JSON.stringify(next)) > SWITCH_LIMITS.totalBytes) throw new HttpError(413, 'Saved switches exceed the 128-switch or 512 KiB limit. Nothing was saved.')
  setMeta(KEY, JSON.stringify(next))
  return next
})

/** Expand only the user's explicitly parsed names. Never parse the saved text. */
export function expandSwitches(text: string, names: readonly string[] | undefined): string {
  if (!names?.length) return text
  const catalogue = readSwitches()
  const parts = [text]
  for (const name of new Set(names)) {
    const item = catalogue.switches.find(item => item.name === name)
    if (!item) throw new HttpError(400, `Saved switch /${name} is unavailable. Your task was not sent.`)
    parts.push(`[Saved switch: /${item.name}]\n${item.content}\n[End saved switch: /${item.name}]`)
  }
  const expanded = parts.filter(Boolean).join('\n\n')
  if (Buffer.byteLength(expanded, 'utf8') > 256 * 1024) throw new HttpError(413, 'The message with its saved switches exceeds 256 KiB. Shorten it or use fewer switches; nothing was truncated.')
  return expanded
}
export function savedSwitchNames(): Set<string> { return new Set(readSwitches().switches.map(item => item.name)) }
