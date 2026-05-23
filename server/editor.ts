// Markdown editor — file-backed CRUD over ~/.poise/editor/*.md (or
// $POISE_EDITOR_DIR if set). Each document is a plain UTF-8 markdown
// file; there's no metadata header, no DB row, no schema. The
// document's slug is its filename without the trailing `.md`. The
// title is derived from the first non-empty line at read time —
// users can rename a doc just by editing line 1.
//
// Why files: this is the writer's own corpus. Plain markdown files
// in their home directory means it integrates with whatever
// versioning / sync / backup they already have (git, Dropbox, iCloud,
// etc.). No lock-in.

import { mkdir, readFile, writeFile, unlink, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const EDITOR_DIR = process.env.POISE_EDITOR_DIR || join(homedir(), '.poise', 'editor')

// All writes go through writeAtomic: write to a sibling .tmp file,
// then rename to the target path. POSIX rename is atomic — readers
// either see the old file or the new one, never a half-written file.
// If the write fails mid-way (disk full, process crash, etc.) the
// original target is untouched. The .tmp filename includes pid + a
// monotonic counter so concurrent writes from re-entrant code or
// multiple vite processes don't collide on the same temp path.
let tmpCounter = 0
async function writeAtomic(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`
  try {
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, target)
  } catch (err) {
    // Mid-write failure: leave the original target alone and try
    // to remove the abandoned tmp file. Swallow unlink errors —
    // tmp cleanup happens at startup too (cleanStaleTmpFiles).
    try { await unlink(tmpPath) } catch { /* best-effort */ }
    throw err
  }
}

// On startup, sweep stale .tmp.* files left behind by a previous
// crash or a kill during writeAtomic. Tmp files in the editor dir
// are never user-visible (no slug looks like `*.tmp.<pid>.<...>`),
// so deleting them is safe. Idempotent: rerun any time.
async function cleanStaleTmpFiles(): Promise<void> {
  await ensureDir()
  let names: string[] = []
  try { names = await readdir(EDITOR_DIR) } catch { return }
  for (const f of names) {
    // Match the writeAtomic pattern: <anything>.tmp.<pid>.<ms>[.<counter>]
    if (/\.tmp\.\d+\.\d+(?:\.\d+)?$/.test(f)) {
      try { await unlink(join(EDITOR_DIR, f)) } catch { /* best-effort */ }
    }
  }
}
// Fire-and-forget at module load. Any caller using readDoc/writeDoc
// gets a tidy directory by the time their first call lands; if the
// sweep is still running, it doesn't interfere (we're only deleting
// tmp files, never .md or .annotations.json).
void cleanStaleTmpFiles()

// Cap per-doc size so a runaway paste or a corrupt sync doesn't
// blow out memory on read. 5 MB is well past any prose document.
const MAX_DOC_BYTES = 5 * 1024 * 1024

async function ensureDir(): Promise<void> {
  await mkdir(EDITOR_DIR, { recursive: true })
}

// Slug must be a plain identifier — no path separators, no leading
// dots, no escapes. Anything weird gets stripped or replaced.
function sanitizeSlug(raw: string): string {
  const base = String(raw).replace(/^.*[\\\/]/, '')
  const cleaned = base
    .replace(/\.md$/i, '')                  // strip extension if user passed it
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
  return cleaned.slice(0, 120)
}

function fileFor(slug: string): string {
  const safe = sanitizeSlug(slug)
  if (!safe) throw new Error('invalid slug')
  return join(EDITOR_DIR, safe + '.md')
}

// First non-empty line, with optional leading "#" stripped so a doc
// starting with `# My Heading` titles as `My Heading` rather than
// `# My Heading`. Truncated at 200 chars so titles can't dominate
// the sidebar.
function deriveTitle(content: string): string {
  const line = (content || '').split('\n').find((l) => l.trim().length > 0)
  if (!line) return 'Untitled'
  const t = line.trim().replace(/^#+\s*/, '').slice(0, 200)
  return t || 'Untitled'
}

export interface DocSummary {
  slug: string         // filename without `.md`
  title: string        // first non-empty line, "#"-stripped
  updated_at: string   // ISO mtime
  size: number         // bytes
}

export async function listDocs(): Promise<DocSummary[]> {
  await ensureDir()
  let names: string[] = []
  try { names = await readdir(EDITOR_DIR) } catch { return [] }
  const out: DocSummary[] = []
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    const fullPath = join(EDITOR_DIR, f)
    try {
      const st = await stat(fullPath)
      if (!st.isFile()) continue
      // Skim the file just enough to derive a title — don't slurp
      // multi-MB files into the listing payload.
      const content = await readFile(fullPath, 'utf-8')
      out.push({
        slug: f.slice(0, -3),
        title: deriveTitle(content),
        updated_at: st.mtime.toISOString(),
        size: st.size,
      })
    } catch { /* skip unreadable files silently */ }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return out
}

export async function readDoc(slug: string): Promise<{ slug: string, content: string, updated_at: string }> {
  await ensureDir()
  const path = fileFor(slug)
  const content = await readFile(path, 'utf-8')
  const st = await stat(path)
  return { slug: sanitizeSlug(slug), content, updated_at: st.mtime.toISOString() }
}

export async function writeDoc(slug: string, content: string): Promise<DocSummary> {
  if (typeof content !== 'string') throw new Error('content must be a string')
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    throw new Error(`doc too large (max ${MAX_DOC_BYTES} bytes)`)
  }
  await ensureDir()
  const path = fileFor(slug)
  await writeAtomic(path, content)
  const st = await stat(path)
  return {
    slug: sanitizeSlug(slug),
    title: deriveTitle(content),
    updated_at: st.mtime.toISOString(),
    size: st.size,
  }
}

export async function deleteDoc(slug: string): Promise<{ ok: true }> {
  const path = fileFor(slug)
  try { await unlink(path) }
  catch (err: any) { if (err.code !== 'ENOENT') throw err }
  // Take any side-cars with the doc — annotations and chat-session
  // bookkeeping. All best-effort: ENOENT on a side-car is normal
  // (most docs won't have annotations or an opened chat).
  const annPath = annotationsFileFor(slug)
  try { await unlink(annPath) }
  catch (err: any) { if (err.code !== 'ENOENT') throw err }
  const chatPath = chatSessionFileFor(slug)
  try { await unlink(chatPath) }
  catch (err: any) { if (err.code !== 'ENOENT') throw err }
  return { ok: true }
}

// Mint a fresh, sortable slug for a new blank doc. Time-stamped so
// the order on disk matches the order of creation, and so two docs
// created seconds apart don't collide.
export function newSlug(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  return `untitled-${stamp}`
}

// ── Annotations ───────────────────────────────────────────────────────
//
// Each editor doc can carry side-car annotations: range-anchored notes
// the writer attaches to specific spans of text. Stored alongside the
// .md file as `<slug>.annotations.json`. The markdown file stays
// pristine (no inline metadata pollution) so it round-trips cleanly
// through git/Dropbox/etc.
//
// Range anchoring: the annotation pins to a (line, char-offset) pair
// at write time AND records a snippet of the highlighted text. On
// load we first try the recorded coords; if the snippet there has
// drifted (the user edited above and lines shifted), the front-end
// searches for the snippet in the current doc and rebinds. Genuinely
// orphaned annotations stay in storage but render as inert.
//
// Annotation ids and session_ids are caller-supplied (the front-end
// mints them) — keeping them client-owned means we don't need a
// generation endpoint round-trip to create one. A single session_id
// per annotation lets each comment grow into a long-running chat
// thread later (Phase 2) by passing it to agent-interface --chat.

const MAX_ANNOTATIONS_BYTES = 1 * 1024 * 1024     // 1 MB / doc — many hundreds of comments

export interface AnnotationRange {
  start_line: number
  start_offset: number
  end_line: number
  end_offset: number
}

export interface Annotation {
  id: string
  session_id: string
  range: AnnotationRange
  snippet: string         // the highlighted text at create time, used for re-anchoring
  comment: string
  created_at: string
  updated_at: string
}

export interface AnnotationsFile {
  annotations: Annotation[]
}

function annotationsFileFor(slug: string): string {
  const safe = sanitizeSlug(slug)
  if (!safe) throw new Error('invalid slug')
  return join(EDITOR_DIR, safe + '.annotations.json')
}

export async function readAnnotations(slug: string): Promise<AnnotationsFile> {
  await ensureDir()
  const path = annotationsFileFor(slug)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AnnotationsFile>
    const list = Array.isArray(parsed.annotations) ? parsed.annotations : []
    return { annotations: list }
  } catch (err: any) {
    if (err.code === 'ENOENT') return { annotations: [] }
    // Corrupt JSON or unreadable file: don't silently lose user data.
    // The front-end can decide whether to overwrite on next save.
    throw err
  }
}

export async function writeAnnotations(slug: string, file: AnnotationsFile): Promise<{ ok: true }> {
  if (!file || !Array.isArray(file.annotations)) throw new Error('annotations must be an array')
  const body = JSON.stringify({ annotations: file.annotations }, null, 2)
  if (Buffer.byteLength(body, 'utf-8') > MAX_ANNOTATIONS_BYTES) {
    throw new Error(`annotations too large (max ${MAX_ANNOTATIONS_BYTES} bytes)`)
  }
  await ensureDir()
  const path = annotationsFileFor(slug)
  await writeAtomic(path, body)
  return { ok: true }
}

// Annotations follow the doc — when the doc is deleted, the side-car
// goes with it. Best-effort: if the side-car is already gone we
// don't surface that.
export async function deleteAnnotations(slug: string): Promise<{ ok: true }> {
  const path = annotationsFileFor(slug)
  try { await unlink(path) }
  catch (err: any) { if (err.code !== 'ENOENT') throw err }
  return { ok: true }
}

// ── Chat session ──────────────────────────────────────────────────────
//
// Each editor doc can open a long-lived chat sidebar (the existing
// `chat-pane.ts` view, opened via `poise:open-chat`). The chat itself
// is held by agent-interface — the model session, the transcript, the
// tokens — all keyed off a single session_id string. We just need to
// remember which session_id belongs to which doc, so reopening the
// chat for the same doc resumes the same conversation forever.
//
// Stored as a third side-car next to the .md and .annotations.json:
//   <slug>.chat.json  →  { session_id, created_at }
//
// session_id format: `editor-<sanitized-slug>-<ms>`. The slug part
// makes the id self-describing in `agent-interface --logs`; the ms
// suffix is uniqueness insurance — if the side-car is deleted and a
// fresh chat is started for the same slug later, the new session_id
// won't collide with whatever orphaned history the old one left behind.
// The file is small and stable: the schema can grow (e.g. tracking
// which voice guide was active) without breaking older readers.

export interface ChatSessionFile {
  session_id: string
  created_at: string
}

function chatSessionFileFor(slug: string): string {
  const safe = sanitizeSlug(slug)
  if (!safe) throw new Error('invalid slug')
  return join(EDITOR_DIR, safe + '.chat.json')
}

// Return the chat session for `slug`, minting + persisting a new one
// on first call. Idempotent: subsequent calls return the same row.
// If the side-car exists but is corrupt or missing fields, we treat
// it as absent and overwrite — losing a corrupt session_id loses
// orphaned chat history but never corrupts a working doc.
export async function getOrCreateChatSession(slug: string): Promise<ChatSessionFile> {
  await ensureDir()
  const path = chatSessionFileFor(slug)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ChatSessionFile>
    if (parsed && typeof parsed.session_id === 'string' && parsed.session_id) {
      return {
        session_id: parsed.session_id,
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
      }
    }
    // Fall through to mint a fresh one — the file existed but its
    // contents were unusable.
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Surface unexpected read errors (perms, etc.) rather than
      // silently minting a duplicate session.
      throw err
    }
  }
  const safe = sanitizeSlug(slug)
  if (!safe) throw new Error('invalid slug')
  const created_at = new Date().toISOString()
  const session_id = `editor-${safe}-${Date.now()}`
  const body: ChatSessionFile = { session_id, created_at }
  await writeAtomic(path, JSON.stringify(body, null, 2))
  return body
}

// Reverse-lookup: given a session_id minted by getOrCreateChatSession,
// return the doc slug it belongs to. Returns null for session_ids that
// aren't ours (card-chat sessions, /content sessions, anything bare).
// Format: `editor-<sanitized-slug>-<ms-digits>`. The regex anchors on
// the trailing all-digit ms suffix so slugs containing internal `-`
// chars (e.g. `untitled-20260512123456`) are extracted correctly.
export function slugFromEditorSession(sessionId: string): string | null {
  const m = String(sessionId || '').match(/^editor-(.+)-\d+$/)
  return m ? m[1] : null
}
