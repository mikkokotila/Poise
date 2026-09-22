// Snippets and Chat skills share the existing Espanso match file.
// Its bodies are authoritative; SQLite keeps only a derived revision index.
// A YAML comment commits stable invocation names and legacy import receipts.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { db, getMeta, setMeta } from './db'
import { HttpError } from './http'
import { MATCH_FILE, readSnippetSnapshotSync, mutateSnippetLibrary, validateSnippets, SnippetConflictError, type Snippet, type SnippetState } from './snippets'
import { parseChatSwitches, RESERVED_SWITCHES, switchName, SWITCH_LIMITS, type ChatSwitches } from '../src/chat-switches'

const PREFIX = '# poise-chat-library-v1 '
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const INDEX_KEY = `chat_snippet_index:${hash(MATCH_FILE)}`
const IMPORT_ID = hash(`chat-snippet-import-v1:${db.name}`)
const IMPORT_DONE_KEY = `chat_snippet_import:${hash(MATCH_FILE)}:${IMPORT_ID}`
export const snippetLibraryEvents = new EventEmitter()
interface Metadata { imports: string[], names: Array<[string, string]> }
interface Indexed { removed?: boolean, trigger: string, name: string, digest: string, revision: number, updatedAt: string }
interface Index { revision: number, signature: string, entries: Indexed[] }
interface Plan { state: SnippetState, metadata: Metadata, imported: boolean }
export interface SkillSnippetState extends SnippetState { skills: ChatSwitches }

function metadataFrom(raw: string | null): Metadata {
  const lines = (raw || '').split('\n').filter(line => line.startsWith(PREFIX))
  if (!lines.length) return { imports: [], names: [] }
  try {
    if (lines.length !== 1) throw new Error('duplicate header')
    const value = JSON.parse(Buffer.from(lines[0].slice(PREFIX.length).trim(), 'base64url').toString('utf8')) as Metadata
    if (!Array.isArray(value.imports) || !value.imports.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) || !Array.isArray(value.names)) throw new Error('invalid header')
    const names = new Set<string>(), triggers = new Set<string>()
    for (const pair of value.names) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || switchName(pair[1]) !== pair[1] || RESERVED_SWITCHES.has(pair[1]) || names.has(pair[1]) || triggers.has(pair[0])) throw new Error('invalid binding')
      names.add(pair[1]); triggers.add(pair[0])
    }
    return value
  } catch { throw new HttpError(500, 'The snippet skill-name metadata could not be read. No snippets or skills were replaced.') }
}
const header = (metadata: Metadata) => PREFIX + Buffer.from(JSON.stringify(metadata)).toString('base64url')

function candidateName(trigger: string): string {
  let name = trigger.replace(/^[;:/]+/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(name)) name = `snippet-${name || hash(trigger).slice(0, 10)}`
  name = name.slice(0, 64)
  if (RESERVED_SWITCHES.has(name)) name = `snippet-${name}`
  return name
}
function uniqueName(candidate: string, trigger: string, used: Set<string>): string {
  if (!used.has(candidate) && !RESERVED_SWITCHES.has(candidate)) return candidate
  const suffix = hash(trigger).slice(0, 10)
  let name = `${candidate.slice(0, 52)}-${suffix}`
  for (let n = 2; used.has(name) || RESERVED_SWITCHES.has(name); n++) name = `${candidate.slice(0, 46)}-${suffix}-${n}`
  return name
}
function bind(snippets: Snippet[], metadata: Metadata): Map<string, string> {
  const names = new Map(metadata.names), used = new Set(names.values())
  for (const snippet of snippets) {
    if (names.has(snippet.trigger)) continue
    const name = uniqueName(candidateName(snippet.trigger), snippet.trigger, used)
    names.set(snippet.trigger, name); used.add(name)
  }
  metadata.names = [...names]
  return names
}

/** Import both bodies on a collision; preserve existing Chat invocation names
 * and leave existing Espanso triggers and their text untouched. */
function plan(snapshot: ReturnType<typeof readSnippetSnapshotSync>): Plan {
  const metadata = metadataFrom(snapshot.raw)
  const snippets = [...snapshot.state.snippets]
  let imported = false
  if (!metadata.imports.includes(IMPORT_ID) && getMeta(IMPORT_DONE_KEY) !== 'complete') {
    const raw = getMeta('chat_custom_switches')
    if (raw) {
      let legacy: ChatSwitches | null = null
      try { legacy = parseChatSwitches(JSON.parse(raw)) } catch { /* reject below */ }
      if (!legacy) throw new HttpError(500, 'Saved switches could not be read. No definitions were replaced.')
      const used = new Set(metadata.names.map(([, name]) => name))
      for (const skill of legacy.switches) {
        let trigger = `;${skill.name}`
        const existing = snippets.find(snippet => snippet.trigger === trigger)
        if (existing && existing.replace !== skill.content) {
          for (let n = 2; snippets.some(snippet => snippet.trigger === trigger); n++) trigger = `;${skill.name}-${n}`
        }
        if (!snippets.some(snippet => snippet.trigger === trigger)) snippets.push({ trigger, replace: skill.content })
        if (!metadata.names.some(([key]) => key === trigger)) {
          const name = uniqueName(skill.name, trigger, used)
          metadata.names.push([trigger, name]); used.add(name)
        }
      }
      metadata.imports.push(IMPORT_ID); imported = true
    }
  }
  bind(snippets, metadata)
  return { state: { ...snapshot.state, snippets }, metadata, imported }
}

function project(prepared: Plan): ChatSwitches {
  const names = new Map(prepared.metadata.names)
  const raw = getMeta(INDEX_KEY)
  const index: Index = raw ? JSON.parse(raw) : { revision: 0, signature: '', entries: [] }
  const previous = new Map(index.entries.map(item => [item.trigger, item]))
  const live = prepared.state.snippets.map(snippet => ({ snippet, name: names.get(snippet.trigger)!, digest: hash(snippet.replace) }))
  const signature = hash(JSON.stringify(live.map(({ snippet, name, digest }) => [snippet.trigger, name, digest])))
  if (signature !== index.signature) {
    if (live.length || index.entries.length) index.revision++
    for (const { snippet, name, digest } of live) {
      const old = previous.get(snippet.trigger)
      if (!old || old.removed || old.digest !== digest || old.name !== name) previous.set(snippet.trigger, {
        trigger: snippet.trigger, name, digest, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
      })
    }
    const active = new Set(live.map(({ snippet }) => snippet.trigger))
    for (const [trigger, entry] of previous) {
      if (!active.has(trigger) && !entry.removed) previous.set(trigger, { ...entry, removed: true })
    }
    index.signature = signature; index.entries = [...previous.values()]
    setMeta(INDEX_KEY, JSON.stringify(index))
  }
  return { revision: index.revision, switches: live.map(({ snippet, name }) => {
    const indexed = previous.get(snippet.trigger)!
    return { name, content: snippet.replace, revision: indexed.revision, updatedAt: indexed.updatedAt, snippetTrigger: snippet.trigger }
  }).sort((a, b) => a.name.localeCompare(b.name)) }
}
// Read inside the transaction, not before it: an older reader must not publish
// a newer index revision after another process has seen a newer file generation.
const snapshotLibrary = db.transaction((): SkillSnippetState => {
  const prepared = plan(readSnippetSnapshotSync())
  return { ...prepared.state, skills: project(prepared) }
})
export function readSwitches(): ChatSwitches { return snapshotLibrary.immediate().skills }

async function importLegacy(): Promise<void> {
  const current = plan(readSnippetSnapshotSync())
  if (!current.imported) {
    if (current.metadata.imports.includes(IMPORT_ID) && getMeta(IMPORT_DONE_KEY) !== 'complete') setMeta(IMPORT_DONE_KEY, 'complete')
    return
  }
  await mutateSnippetLibrary(snapshot => {
    const prepared = plan(snapshot)
    return prepared.imported ? { snippets: prepared.state.snippets, header: header(prepared.metadata) } : null
  })
  setMeta(IMPORT_DONE_KEY, 'complete')
}
export async function readSkillSnippets(): Promise<SkillSnippetState> {
  await importLegacy()
  return snapshotLibrary.immediate()
}
function publish(): SkillSnippetState {
  const state = snapshotLibrary.immediate()
  snippetLibraryEvents.emit('changed', state.skills)
  return state
}
export async function saveSkillSnippets(input: unknown, version: unknown): Promise<SkillSnippetState> {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new HttpError(400, 'base_version must be a SHA-256 version')
  await importLegacy()
  await mutateSnippetLibrary(snapshot => {
    if (snapshot.state.version !== version) throw new SnippetConflictError(snapshot.state.version)
    const snippets = validateSnippets(input), metadata = metadataFrom(snapshot.raw)
    bind(snippets, metadata)
    return { snippets, header: header(metadata) }
  })
  return publish()
}
export async function addSkillSnippet(input: unknown): Promise<{ snippet: Snippet, version: string, skills: ChatSwitches }> {
  const [snippet] = validateSnippets([input])
  await importLegacy()
  await mutateSnippetLibrary(snapshot => {
    const snippets = validateSnippets([...snapshot.state.snippets, snippet]), metadata = metadataFrom(snapshot.raw)
    bind(snippets, metadata)
    return { snippets, header: header(metadata) }
  })
  const state = publish()
  return { snippet, version: state.version, skills: state.skills }
}

export async function saveSwitch(input: { name: string, content: string, revision: number }, nativeNames: string[] = []): Promise<ChatSwitches> {
  if (!input || typeof input.name !== 'string' || typeof input.content !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new HttpError(400, 'A switch requires a name, text and a non-negative revision.')
  const name = switchName(input.name)
  if (RESERVED_SWITCHES.has(name) || nativeNames.some(native => native.replace(/^\//, '').toLowerCase() === name)) throw new HttpError(400, `/${name} is already a built-in or native command. Choose another name.`)
  if (!input.content.trim()) throw new HttpError(400, 'The switch instructions cannot be empty.')
  if (Buffer.byteLength(input.content, 'utf8') > SWITCH_LIMITS.contentBytes) throw new HttpError(413, 'Switch instructions exceed 64 KiB. Nothing was truncated or saved.')
  await importLegacy()
  await mutateSnippetLibrary(snapshot => {
    const prepared = plan(snapshot)
    const catalogue = db.transaction(() => project(prepared)).immediate()
    const existing = catalogue.switches.find(item => item.name === name)
    if (existing?.content === input.content) return null
    if (input.revision !== (existing?.revision ?? 0)) throw new HttpError(409, `/${name} changed in Snippets or another tab. Your draft was kept; review it before replacing the saved text.`)
    const bindings = new Map(prepared.metadata.names)
    let trigger = existing?.snippetTrigger || [...bindings].find(([, alias]) => alias === name)?.[0] || `;${name}`
    if (!existing) {
      for (let n = 2; prepared.state.snippets.some(snippet => snippet.trigger === trigger); n++) trigger = `;${name}-${n}`
      bindings.set(trigger, name)
    }
    const snippets = existing ? prepared.state.snippets.map(snippet => snippet.trigger === trigger ? { ...snippet, replace: input.content } : snippet)
      : [...prepared.state.snippets, { trigger, replace: input.content }]
    prepared.metadata.names = [...bindings]
    return { snippets, header: header(prepared.metadata) }
  })
  return publish().skills
}
export function savedSwitchNames(): Set<string> {
  // Retired invocation names remain recognizable. A queued or recalled use of
  // a deleted skill must fail clearly, never become an ordinary provider command.
  const index = getMeta(INDEX_KEY)
  const retired = index ? (JSON.parse(index) as Index).entries.map(item => item.name) : []
  return new Set([...retired, ...plan(readSnippetSnapshotSync()).metadata.names.map(([, name]) => name)])
}
export function expandSwitches(text: string, names: readonly string[] | undefined): string {
  if (!names?.length) return text
  const catalogue = readSwitches(), parts = [text]
  for (const name of new Set(names)) {
    const item = catalogue.switches.find(item => item.name === name)
    if (!item) throw new HttpError(400, `Saved switch /${name} is unavailable. Your task was not sent.`)
    parts.push(`[Saved switch: /${item.name}]\n${item.content}\n[End saved switch: /${item.name}]`)
  }
  const expanded = parts.filter(Boolean).join('\n\n')
  if (Buffer.byteLength(expanded, 'utf8') > 256 * 1024) throw new HttpError(413, 'The message with its saved switches exceeds 256 KiB. Shorten it or use fewer switches; nothing was truncated.')
  return expanded
}
