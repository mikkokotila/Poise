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

import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// espanso's macOS config root holds config/ and match/. Override the
// match dir via POISE_ESPANSO_MATCH_DIR (mirrors POISE_EDITOR_DIR) for
// non-default installs or tests.
const MATCH_DIR = process.env.POISE_ESPANSO_MATCH_DIR
  || join(homedir(), 'Library', 'Application Support', 'espanso', 'match')
const MATCH_FILE = join(MATCH_DIR, 'poise.yml')

export interface Snippet {
  trigger: string
  replace: string
}

// Parse poise.yml into the {trigger, replace} pairs Poise manages.
// Missing file → empty list. Anything that isn't a simple trigger/replace
// pair is ignored (Poise only models simple snippets; this file is
// Poise-owned so there shouldn't be anything else).
export async function listSnippets(): Promise<Snippet[]> {
  let raw: string
  try {
    raw = await readFile(MATCH_FILE, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const doc = parseYaml(raw) as { matches?: unknown } | null
  const matches = doc && Array.isArray(doc.matches) ? doc.matches : []
  const out: Snippet[] = []
  for (const m of matches) {
    if (m && typeof m === 'object'
        && typeof (m as any).trigger === 'string'
        && typeof (m as any).replace === 'string') {
      out.push({ trigger: (m as any).trigger, replace: (m as any).replace })
    }
  }
  return out
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

// Serialize to espanso's match schema and write atomically (tmp +
// rename, same as server/editor.ts) so espanso's file watcher never sees
// a half-written file. Creates the match dir if espanso hasn't yet.
export async function saveSnippets(input: unknown): Promise<Snippet[]> {
  const snippets = validateSnippets(input)
  await mkdir(MATCH_DIR, { recursive: true })
  // espanso schema: { matches: [{ trigger, replace }] }. yaml.stringify
  // owns the quoting/escaping and emits block scalars for multi-line
  // bodies — no manual escaping here.
  const body = stringifyYaml({ matches: snippets })
  const tmp = `${MATCH_FILE}.tmp.${process.pid}.${Date.now()}`
  try {
    await writeFile(tmp, body, 'utf-8')
    await rename(tmp, MATCH_FILE)
  } catch (err) {
    try { await unlink(tmp) } catch { /* best-effort */ }
    throw err
  }
  return snippets
}

// Append one snippet to the current set and persist. The whole set is
// re-validated by saveSnippets, so a duplicate or empty trigger is
// rejected exactly as it would be on a full PUT. Returns the added pair.
// Used by the editor's "save selection as snippet" action.
export async function addSnippet(input: unknown): Promise<Snippet> {
  const trigger = String((input as any)?.trigger ?? '').trim()
  const replace = String((input as any)?.replace ?? '')
  const current = await listSnippets()
  await saveSnippets([...current, { trigger, replace }])
  return { trigger, replace }
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
