/** User-authored, shared prompt switches. Content is text, never executable commands. */
export interface ChatSwitch { snippetTrigger?: string, name: string, content: string, revision: number, updatedAt: string }
export interface ChatSwitches { revision: number, switches: ChatSwitch[] }
export const SWITCH_LIMITS = { nameChars: 64, contentBytes: 64 * 1024, totalBytes: 512 * 1024, count: 128 } as const
// Accept every readable snippet; expanded prompts retain their own byte limit.
const LIBRARY_LIMITS = { count: 65_536, contentBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 }
export const RESERVED_SWITCHES = new Set(['create', 'model', 'review', 'queue', 'compact', 'reset', 'mode', 'fork', 'poise', 'context', 'clear', 'help', 'always-approve', 'deep-research'])
export function switchName(value: string): string {
  const name = value.replace(/^\//, '').toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Use a switch name starting with a letter, followed by letters, numbers, hyphens or underscores (up to 64 characters).')
  return name
}
/** Everything after the name is literal, including other slashes and newlines. */
export function parseSwitchCreation(text: string): { name: string, content: string } {
  const match = /^\s*\/create\s+(\/[^\s]+)[ \t]*(?:\r?\n|[ \t])?([\s\S]*)$/i.exec(text)
  if (!match) throw new Error('Use /create /switch-name followed by the instructions to save.')
  const name = switchName(match[1])
  const content = match[2]
  if (!content.trim()) throw new Error(`Add the instructions to save after /${name}.`)
  return { name, content }
}
export function parseChatSwitches(value: unknown): ChatSwitches | null {
  if (!value || typeof value !== 'object') return null
  const data = value as ChatSwitches
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.switches) || data.switches.length > LIBRARY_LIMITS.count) return null
  const names = new Set<string>()
  for (const item of data.switches) {
    if (!item || typeof item.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.name) || names.has(item.name) || RESERVED_SWITCHES.has(item.name)) return null
    if (typeof item.content !== 'string' || !item.content.trim() || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.updatedAt !== 'string') return null
    if (item.revision > data.revision || new TextEncoder().encode(item.content).byteLength > LIBRARY_LIMITS.contentBytes) return null
    names.add(item.name)
  }
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > LIBRARY_LIMITS.totalBytes) return null
  return data
}
