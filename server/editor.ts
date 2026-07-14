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

import { mkdir, open, unlink, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { withProcessLock } from './process-lock'

const EDITOR_DIR = process.env.POISE_EDITOR_DIR || join(homedir(), '.poise', 'editor')
const EDITOR_LOCK_PATH = join(EDITOR_DIR, '.poise-editor-lock.sqlite3')
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_MAX_BYTES = 64 * 1024
const EDITOR_LOCK_TIMEOUT_MS = 10_000

export type EditorVersion = string

function versionFor(content: string): EditorVersion {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Missing state needs its own version so deleting an empty document cannot be
// mistaken for leaving an empty document unchanged. Annotation absence is a
// readable state, so its sentinel is returned by readAnnotations.
const MISSING_DOC_VERSION = versionFor('poise:editor:missing-document:v1')
const MISSING_ANNOTATIONS_VERSION = versionFor('poise:editor:missing-annotations:v1')

// All writes go through writeAtomic: write to a sibling .tmp file,
// then rename to the target path. POSIX rename is atomic — readers
// either see the old file or the new one, never a half-written file.
// If the write fails mid-way (disk full, process crash, etc.) the
// original target is untouched. The .tmp filename includes pid + a
// monotonic counter so concurrent writes from re-entrant code or
// multiple vite processes don't collide on the same temp path.
let tmpCounter = 0

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error: any) {
    // Windows does not consistently support opening/fsyncing directories.
    // POSIX directory fsync errors remain fatal because they mean rename
    // durability could not be established.
    const unsupportedOnWindows = process.platform === 'win32'
      && ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)
    if (!unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`
  let handle
  try {
    let mode = 0o600
    try { mode = (await stat(target)).mode & 0o777 }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error }

    handle = await open(tmpPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, target)
    await syncDirectory(dirname(target))
  } catch (err) {
    // Mid-write failure: leave the original target alone and try
    // to remove the abandoned tmp file. Swallow unlink errors —
    // tmp cleanup happens at startup too (cleanStaleTmpFiles).
    try { await handle?.close() } catch { /* best-effort */ }
    try { await unlink(tmpPath) } catch { /* best-effort */ }
    throw err
  }
}

export class EditorLockError extends Error {
  readonly code = 'EDITOR_LOCK_UNAVAILABLE'
  readonly statusCode = 503

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EditorLockError'
  }
}

async function runWithEditorLock<T>(mutation: () => Promise<T>): Promise<T> {
  return withProcessLock({
    path: EDITOR_LOCK_PATH,
    timeoutMs: EDITOR_LOCK_TIMEOUT_MS,
    unavailableMessage: 'editor mutation lock is unavailable',
    timeoutMessage: 'timed out waiting for editor mutation lock',
    errorFactory: (message, cause) => new EditorLockError(message, { cause }),
  }, mutation)
}

// Serialize mutations per target path for deterministic same-process order,
// then take a process-shared lock around each read/compare/write transaction.
const mutationTails = new Map<string, Promise<void>>()

async function serializeMutation<T>(
  target: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(target) || Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => { release = resolve })
  mutationTails.set(target, tail)
  await previous
  try {
    return await runWithEditorLock(mutation)
  } finally {
    release()
    if (mutationTails.get(target) === tail) mutationTails.delete(target)
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
    const match = f.match(/\.tmp\.\d+\.(\d+)(?:\.\d+)?$/)
    if (!match) continue
    const createdAt = Number(match[1])
    // Another Poise process can be inside writeAtomic right now. Only sweep
    // files old enough that they cannot plausibly be an active write.
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < STALE_TMP_AGE_MS) continue
    try { await unlink(join(EDITOR_DIR, f)) } catch { /* best-effort */ }
  }
}
// Public operations await startup cleanup. That prevents the sweep
// from mistaking an active atomic-write temp file for stale debris.
const editorReady = cleanStaleTmpFiles()

// Cap per-doc size so a runaway paste or a corrupt sync doesn't
// blow out memory on read. 5 MB is well past any prose document.
export const MAX_DOC_BYTES = 5 * 1024 * 1024

async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

async function readUtf8Limited(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ content: string, updatedAt: string, size: number }> {
  const handle = await open(path, 'r')
  try {
    const fileStat = await handle.stat()
    if (fileStat.size > maxBytes) throw new Error(`${label} too large (max ${maxBytes} bytes)`)
    const buffer = Buffer.alloc(fileStat.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      content: buffer.subarray(0, offset).toString('utf-8'),
      updatedAt: fileStat.mtime.toISOString(),
      size: fileStat.size,
    }
  } finally {
    await handle.close()
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(EDITOR_DIR, { recursive: true })
}

// A public slug and its on-disk basename must be a bijection. Rejecting rather
// than sanitizing is important: "a b", "a_b", and overlong common prefixes
// must never address the same document.
export const MAX_SLUG_LENGTH = 120
const CANONICAL_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/

export function isCanonicalSlug(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SLUG_LENGTH
    && CANONICAL_SLUG_RE.test(value)
}

function canonicalSlug(value: unknown): string {
  if (!isCanonicalSlug(value)) throw new Error('invalid slug')
  return value
}

function fileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.md')
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
  await editorReady
  let names: string[] = []
  try { names = await readdir(EDITOR_DIR) } catch { return [] }
  const out: DocSummary[] = []
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    const slug = f.slice(0, -3)
    if (!isCanonicalSlug(slug)) continue
    const fullPath = join(EDITOR_DIR, f)
    try {
      const st = await stat(fullPath)
      if (!st.isFile()) continue
      // Skim the file just enough to derive a title — don't slurp
      // multi-MB files into the listing payload.
      // Preserve title derivation for every supported document while still
      // bounding externally oversized files at the normal document limit.
      const content = await readUtf8Prefix(fullPath, Math.min(st.size, MAX_DOC_BYTES))
      out.push({
        slug,
        title: deriveTitle(content),
        updated_at: st.mtime.toISOString(),
        size: st.size,
      })
    } catch { /* skip unreadable files silently */ }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return out
}

export interface DocReadResult {
  slug: string
  content: string
  updated_at: string
  version: EditorVersion
}

export async function readDoc(slug: string): Promise<DocReadResult> {
  await editorReady
  const path = fileFor(slug)
  const loaded = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
  return {
    slug: canonicalSlug(slug),
    content: loaded.content,
    updated_at: loaded.updatedAt,
    version: versionFor(loaded.content),
  }
}

export interface EditorWriteContext {
  clientId: string
  revision: number
  baseVersion: EditorVersion
}

interface ValidWriteContext {
  clientId: string
  revision: number
  baseVersion: EditorVersion
}

export interface DocWriteResult extends DocSummary {
  version: EditorVersion
  stale?: true
}

export class EditorConflictError extends Error {
  readonly code = 'EDITOR_CONFLICT'
  readonly statusCode = 409

  constructor(readonly currentVersion: EditorVersion) {
    super('editor content changed since it was loaded')
    this.name = 'EditorConflictError'
  }
}

const MAX_REVISION_ENTRIES = 10_000
interface ClientWriteState {
  revision: number
  version: EditorVersion
}
const latestClientWrites = new Map<string, ClientWriteState>()

function validWriteContext(input?: EditorWriteContext): ValidWriteContext | null {
  if (input === undefined) return null
  if (!input || typeof input !== 'object') throw new Error('invalid write context')
  if (typeof input.clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientId)) {
    throw new Error('invalid client_id')
  }
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
    throw new Error('invalid revision')
  }
  if (typeof input.baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseVersion)) {
    throw new Error('invalid base_version')
  }
  return { clientId: input.clientId, revision: input.revision, baseVersion: input.baseVersion }
}

function clientWriteKey(target: string, context: ValidWriteContext): string {
  return `${target}\0${context.clientId}`
}

function previousClientWrite(target: string, context: ValidWriteContext): ClientWriteState | undefined {
  const key = clientWriteKey(target, context)
  const previous = latestClientWrites.get(key)
  // Losing a revision watermark could let an evicted lower revision write.
  // Fail closed for a new client instead; deletion and process restart clear
  // the bounded state in normal operation.
  if (!previous && latestClientWrites.size >= MAX_REVISION_ENTRIES) {
    throw new Error('too many active editor clients')
  }
  return previous
}

function rememberClientWrite(
  target: string,
  context: ValidWriteContext,
  version: EditorVersion,
): void {
  const key = clientWriteKey(target, context)
  latestClientWrites.delete(key)
  latestClientWrites.set(key, { revision: context.revision, version })
}

function forgetClientWrites(target: string): void {
  const prefix = `${target}\0`
  for (const key of latestClientWrites.keys()) {
    if (key.startsWith(prefix)) latestClientWrites.delete(key)
  }
}

function canReplaceVersion(
  currentVersion: EditorVersion,
  context: ValidWriteContext,
  previous: ClientWriteState | undefined,
): void {
  // Consecutive saves may have been snapshotted against the same read version.
  // Permit that same client to advance only while its own last write remains
  // current. Any intervening tab/external write breaks the chain.
  if (context.baseVersion === currentVersion) return
  if (previous?.version === currentVersion) return
  throw new EditorConflictError(currentVersion)
}

function docWriteResult(
  slug: string,
  loaded: { content: string, updatedAt: string, size: number },
  stale?: true,
): DocWriteResult {
  return {
    slug: canonicalSlug(slug),
    title: deriveTitle(loaded.content),
    updated_at: loaded.updatedAt,
    size: loaded.size,
    version: versionFor(loaded.content),
    ...(stale ? { stale } : {}),
  }
}

export async function writeDoc(
  slug: string,
  content: string,
  writeContext?: EditorWriteContext,
): Promise<DocWriteResult> {
  if (typeof content !== 'string') throw new Error('content must be a string')
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    throw new Error(`doc too large (max ${MAX_DOC_BYTES} bytes)`)
  }
  await editorReady
  const path = fileFor(slug)
  const context = validWriteContext(writeContext)
  return serializeMutation(path, async () => {
    if (context) {
      let current
      try {
        current = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw new EditorConflictError(MISSING_DOC_VERSION)
        throw error
      }
      const currentVersion = versionFor(current.content)
      const previous = previousClientWrite(path, context)
      if (previous && context.revision <= previous.revision) {
        return docWriteResult(slug, current, true)
      }
      canReplaceVersion(currentVersion, context, previous)
    }
    await writeAtomic(path, content)
    const st = await stat(path)
    const version = versionFor(content)
    if (context) rememberClientWrite(path, context, version)
    return {
      slug: canonicalSlug(slug),
      title: deriveTitle(content),
      updated_at: st.mtime.toISOString(),
      size: st.size,
      version,
    }
  })
}

export async function deleteDoc(slug: string): Promise<{ ok: true }> {
  await editorReady
  const path = fileFor(slug)
  // Take any side-cars with the doc — annotations and chat-session
  // bookkeeping. All best-effort: ENOENT on a side-car is normal
  // (most docs won't have annotations or an opened chat).
  const annPath = annotationsFileFor(slug)
  const chatPath = chatSessionFileFor(slug)
  await Promise.all(
    [path, annPath, chatPath].map((target) => (
      serializeMutation(target, async () => {
        try { await unlink(target) }
        catch (err: any) { if (err.code !== 'ENOENT') throw err }
        forgetClientWrites(target)
      })
    )),
  )
  return { ok: true }
}

// Mint a fresh, sortable slug for a new blank doc. Millisecond time
// keeps creation order legible; a UUID prevents collisions across
// simultaneous requests and multiple processes.
export function newSlug(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '')
  return `untitled-${stamp}-${randomUUID()}`
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

export const MAX_ANNOTATIONS_BYTES = 1 * 1024 * 1024     // 1 MB / doc — many hundreds of comments

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

export interface AnnotationsReadResult extends AnnotationsFile {
  version: EditorVersion
}

export interface AnnotationsWriteResult {
  ok: true
  version: EditorVersion
  stale?: true
}

function annotationsFileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.annotations.json')
}

function parseAnnotationsContainer(raw: string): AnnotationsFile {
  const parsed: unknown = JSON.parse(raw)
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Array.isArray((parsed as { annotations?: unknown }).annotations)
  ) {
    throw new Error('annotations must be an array')
  }
  return { annotations: (parsed as AnnotationsFile).annotations }
}

export async function readAnnotations(slug: string): Promise<AnnotationsReadResult> {
  await editorReady
  const path = annotationsFileFor(slug)
  try {
    const raw = (await readUtf8Limited(path, MAX_ANNOTATIONS_BYTES, 'annotations')).content
    return { ...parseAnnotationsContainer(raw), version: versionFor(raw) }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { annotations: [], version: MISSING_ANNOTATIONS_VERSION }
    }
    // Corrupt JSON or unreadable file: don't silently lose user data.
    // The front-end can decide whether to overwrite on next save.
    throw err
  }
}

export async function writeAnnotations(
  slug: string,
  file: AnnotationsFile,
  writeContext?: EditorWriteContext,
): Promise<AnnotationsWriteResult> {
  if (!file || !Array.isArray(file.annotations)) throw new Error('annotations must be an array')
  const body = JSON.stringify({ annotations: file.annotations }, null, 2)
  if (Buffer.byteLength(body, 'utf-8') > MAX_ANNOTATIONS_BYTES) {
    throw new Error(`annotations too large (max ${MAX_ANNOTATIONS_BYTES} bytes)`)
  }
  await editorReady
  const path = annotationsFileFor(slug)
  const context = validWriteContext(writeContext)
  return serializeMutation(path, async () => {
    let currentVersion = MISSING_ANNOTATIONS_VERSION
    if (context) {
      try {
        const current = await readUtf8Limited(path, MAX_ANNOTATIONS_BYTES, 'annotations')
        currentVersion = versionFor(current.content)
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      const previous = previousClientWrite(path, context)
      if (previous && context.revision <= previous.revision) {
        return { ok: true, version: currentVersion, stale: true }
      }
      canReplaceVersion(currentVersion, context, previous)
    }
    await writeAtomic(path, body)
    const version = versionFor(body)
    if (context) rememberClientWrite(path, context, version)
    return { ok: true, version }
  })
}

// Annotations follow the doc — when the doc is deleted, the side-car
// goes with it. Best-effort: if the side-car is already gone we
// don't surface that.
export async function deleteAnnotations(slug: string): Promise<{ ok: true }> {
  await editorReady
  const path = annotationsFileFor(slug)
  return serializeMutation(path, async () => {
    try { await unlink(path) }
    catch (err: any) { if (err.code !== 'ENOENT') throw err }
    forgetClientWrites(path)
    return { ok: true }
  })
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
// session_id format: `editor-<canonical-slug>-<ms>`. The slug part
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
  return join(EDITOR_DIR, canonicalSlug(slug) + '.chat.json')
}

// Return the chat session for `slug`, minting + persisting a new one
// on first call. Idempotent: subsequent calls return the same row.
// If the side-car exists but is corrupt or missing fields, we treat
// it as absent and overwrite — losing a corrupt session_id loses
// orphaned chat history but never corrupts a working doc.
export async function getOrCreateChatSession(slug: string): Promise<ChatSessionFile> {
  await editorReady
  const path = chatSessionFileFor(slug)
  return serializeMutation(path, async () => {
    try {
      const raw = (await readUtf8Limited(path, CHAT_SESSION_MAX_BYTES, 'chat session')).content
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
    const safe = canonicalSlug(slug)
    const created_at = new Date().toISOString()
    const session_id = `editor-${safe}-${Date.now()}`
    const body: ChatSessionFile = { session_id, created_at }
    await writeAtomic(path, JSON.stringify(body, null, 2))
    return body
  })
}

// Reverse-lookup: given a session_id minted by getOrCreateChatSession,
// return the doc slug it belongs to. Returns null for session_ids that
// aren't ours (card-chat sessions, /content sessions, anything bare).
// Format: `editor-<canonical-slug>-<ms-digits>`. The regex anchors on
// the trailing all-digit ms suffix so slugs containing internal `-`
// chars (e.g. `untitled-20260512123456`) are extracted correctly.
export function slugFromEditorSession(sessionId: string): string | null {
  const m = String(sessionId || '').match(/^editor-(.+)-\d+$/)
  return m && isCanonicalSlug(m[1]) ? m[1] : null
}
