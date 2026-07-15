// Snippets — espanso text-expansion pairs, managed from Poise.
//
// Poise owns exactly ONE espanso match file: <match>/poise.yml. espanso
// loads every .yml in its match directory and hot-reloads on change, so
// rewriting this file is all it takes for a `;trigger` expansion to go
// live system-wide. Advanced espanso matches (forms, vars, per-app
// rules) belong in the user's OTHER match files — Poise reads and
// rewrites poise.yml exclusively and never touches the rest.
//
// The file itself is the source of truth — no DB row, no sidecar. Same
// philosophy as server/editor.ts: a plain file in a standard location
// the user can also edit, version, or sync by hand.

import { mkdir, open, writeFile, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { withProcessLock } from './process-lock'

// espanso's macOS config root holds config/ and match/. Override the
// match dir via POISE_ESPANSO_MATCH_DIR (mirrors POISE_EDITOR_DIR) for
// non-default installs or tests.
const MATCH_DIR = process.env.POISE_ESPANSO_MATCH_DIR
  || join(homedir(), 'Library', 'Application Support', 'espanso', 'match')
const MATCH_FILE = join(MATCH_DIR, 'poise.yml')
const LOCK_FILE = join(MATCH_DIR, '.poise-snippets-lock.sqlite3')
const MAX_SNIPPETS_BYTES = 1 * 1024 * 1024

export interface Snippet {
  trigger: string
  replace: string
}

export interface SnippetState {
  snippets: Snippet[]
  version: string
}

function versionFor(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

// Absence is a distinct readable state. A user manually creating even an
// empty poise.yml after a GET must invalidate that client's pending PUT.
const MISSING_SNIPPETS_VERSION = versionFor('poise:snippets:missing-file:v1')

export class SnippetConflictError extends Error {
  readonly code = 'SNIPPET_CONFLICT'
  readonly statusCode = 409

  constructor(readonly currentVersion: string) {
    super('snippets changed since they were loaded')
    this.name = 'SnippetConflictError'
  }
}

let mutationTail: Promise<void> = Promise.resolve()

async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail
  let release!: () => void
  mutationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

async function readSnippetSource(): Promise<string> {
  const handle = await open(MATCH_FILE, 'r')
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error('poise.yml is not a regular file')
    if (fileStat.size > MAX_SNIPPETS_BYTES) {
      throw new Error(`poise.yml exceeds ${MAX_SNIPPETS_BYTES} bytes`)
    }
    const buffer = Buffer.alloc(MAX_SNIPPETS_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_SNIPPETS_BYTES) {
      throw new Error(`poise.yml exceeds ${MAX_SNIPPETS_BYTES} bytes`)
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

// Read both the parsed pairs and a hash of the exact source bytes. Hashing the
// raw YAML (rather than its parsed pairs) means comments, formatting, and
// other manual edits also invalidate a stale full-set replacement.
export async function readSnippetState(): Promise<SnippetState> {
  let raw: string | null
  try {
    raw = await readSnippetSource()
  } catch (err: any) {
    if (err.code === 'ENOENT') raw = null
    else throw err
  }
  if (raw === null) {
    return { snippets: [], version: MISSING_SNIPPETS_VERSION }
  }

  // Anything that isn't a simple trigger/replace pair is ignored. Poise only
  // models simple snippets, while the raw version still protects all content.
  const doc = parseYaml(raw, {
    maxAliasCount: 20,
    merge: false,
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  }) as { matches?: unknown } | null
  const matches = doc && Array.isArray(doc.matches) ? doc.matches : []
  const snippets: Snippet[] = []
  for (const m of matches) {
    if (m && typeof m === 'object'
        && typeof (m as any).trigger === 'string'
        && typeof (m as any).replace === 'string') {
      snippets.push({ trigger: (m as any).trigger, replace: (m as any).replace })
    }
  }
  return { snippets, version: versionFor(raw) }
}

export async function listSnippets(): Promise<Snippet[]> {
  return (await readSnippetState()).snippets
}

// Validate + normalize an incoming list. Throws on the first problem with
// a user-facing message: triggers must be non-empty and unique, bodies
// non-empty. Returns the trimmed-trigger list ready to persist.
export function validateSnippets(input: unknown): Snippet[] {
  if (!Array.isArray(input)) throw new Error('snippets must be an array')
  const seen = new Set<string>()
  const out: Snippet[] = []
  for (const s of input) {
    const trigger = String((s as any)?.trigger ?? '').trim()
    const replace = String((s as any)?.replace ?? '')
    if (!trigger) throw new Error('every snippet needs a trigger')
    if (!replace.trim()) throw new Error(`snippet "${trigger}" needs a body`)
    if (seen.has(trigger)) throw new Error(`duplicate trigger: ${trigger}`)
    seen.add(trigger)
    out.push({ trigger, replace })
  }
  return out
}

// espanso refuses to start if its config root exists but has no config/
// directory — it panics with "missing config directory" instead of
// scaffolding defaults (it only scaffolds when the root is wholly
// absent). Because writing poise.yml creates <root>/match/, a user who
// adds a snippet BEFORE ever launching espanso would otherwise be left
// with an unstartable, half-initialized config root. So whenever we
// write into espanso's real default location, make sure a minimal
// config/default.yml exists too. Never overwrites an existing config.
const DEFAULT_ESPANSO_CONFIG = `# espanso configuration file
#
# espanso loads all match files from the sibling "match/" directory
# (including Poise's poise.yml), so nothing is required here. This file
# was created by Poise so espanso can start even when a snippet was added
# before espanso's first launch. Edit freely — https://espanso.org/docs/
`

async function ensureEspansoConfigDir(): Promise<void> {
  // With a custom POISE_ESPANSO_MATCH_DIR the caller owns the layout, so
  // don't assume an espanso config root sits beside it.
  if (process.env.POISE_ESPANSO_MATCH_DIR) return
  const defaultYml = join(dirname(MATCH_DIR), 'config', 'default.yml')
  if (existsSync(defaultYml)) return
  await mkdir(dirname(defaultYml), { recursive: true })
  if (!existsSync(defaultYml)) await writeFile(defaultYml, DEFAULT_ESPANSO_CONFIG, 'utf-8')
}

// Serialize to espanso's match schema and write atomically (tmp +
// rename, same as server/editor.ts) so espanso's file watcher never sees
// a half-written file. Creates the match dir (and a minimal config/ so
// espanso stays startable) if espanso hasn't been initialized yet.
let tmpCounter = 0

async function writeSnippets(snippets: Snippet[], expectedVersion: string): Promise<string> {
  await mkdir(MATCH_DIR, { recursive: true })
  await ensureEspansoConfigDir()
  // espanso schema: { matches: [{ trigger, replace }] }. yaml.stringify
  // owns the quoting/escaping and emits block scalars for multi-line
  // bodies — no manual escaping here.
  const body = stringifyYaml({ matches: snippets })
  if (Buffer.byteLength(body, 'utf8') > MAX_SNIPPETS_BYTES) {
    throw new Error(`serialized snippets exceed ${MAX_SNIPPETS_BYTES} bytes`)
  }
  const tmp = `${MATCH_FILE}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null

    // A manual editor does not participate in Poise's process lock. Recheck
    // after preparing the durable temp file so an edit during serialization
    // still turns into a conflict instead of being overwritten.
    const current = await readSnippetState()
    if (current.version !== expectedVersion) {
      throw new SnippetConflictError(current.version)
    }
    await rename(tmp, MATCH_FILE)
    const directory = await open(MATCH_DIR, 'r')
    try { await directory.sync() } finally { await directory.close() }
    return versionFor(body)
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined)
    try { await unlink(tmp) } catch { /* best-effort */ }
    throw err
  }
}

export async function saveSnippets(input: unknown, baseVersion: unknown): Promise<SnippetState> {
  if (typeof baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(baseVersion)) {
    throw new Error('base_version must be a SHA-256 version')
  }
  return serializeMutation(() => withProcessLock({ path: LOCK_FILE }, async () => {
      const current = await readSnippetState()
      if (current.version !== baseVersion) {
        throw new SnippetConflictError(current.version)
      }
      const snippets = validateSnippets(input)
      const version = await writeSnippets(snippets, current.version)
      return { snippets, version }
    }))
}

// Append one snippet to the latest set and persist. The whole set is
// validated under the same rules as a full PUT, so a duplicate or empty
// trigger is rejected. Returns the added pair and resulting source version.
// Used by the editor's "save selection as snippet" action.
export async function addSnippet(input: unknown): Promise<{ snippet: Snippet, version: string }> {
  const trigger = String((input as any)?.trigger ?? '').trim()
  const replace = String((input as any)?.replace ?? '')
  return serializeMutation(() => withProcessLock({ path: LOCK_FILE }, async () => {
      const current = await readSnippetState()
      const next = validateSnippets([...current.snippets, { trigger, replace }])
      const version = await writeSnippets(next, current.version)
      return { snippet: next[next.length - 1], version }
    }))
}

// Best-effort "is espanso installed?" — drives a UI hint only. We look
// for the `espanso` binary on PATH rather than for a directory: espanso
// is commonly installed before its config dir exists (in that state
// `espanso path` itself panics with "missing config directory"), so a
// dir check gives false negatives. A custom POISE_ESPANSO_MATCH_DIR
// means the user knows their setup, so assume yes.
export function espansoDetected(): boolean {
  if (process.env.POISE_ESPANSO_MATCH_DIR) return true
  const dirs = (process.env.PATH || '').split(delimiter)
  return dirs.some((p) => p !== '' && existsSync(join(p, 'espanso')))
}
