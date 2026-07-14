// Bridge to `agent-interface --chat` for per-card long-lived chats.
//
// agent-interface exposes:
//   --chat <MESSAGE> --model <MODEL> --session <ID> [--pwd <DIR>]
//
// where session_id is caller-chosen — passing the same id resumes the
// same conversation (agent-interface tracks the underlying provider
// session in its own DB). The chat call may take ~30s–2min, so we
// spawn detached and let the front-end poll the agent-interface logs
// to see status flow running → completed.
//
// History: agent-interface --logs already projects session_id, so
// filtering for {behavior:'chat', session_id:<id>} gives us the full
// transcript for one card. Each entry's `prompt` is the user message;
// the agent's reply lives at `agent-interface --read-response <hash>`.

import { join, resolve, isAbsolute, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { chmod, lstat, mkdir, open, writeFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fetchAgentLogs, type LogEntry } from './agent'
import { db } from './db'
import { readDoc, slugFromEditorSession } from './editor'
import { HttpError } from './http'
import { MAX_PROCESS_ARG_BYTES, runFile, spawnDetached } from './process'

const AGENT_INTERFACE = 'agent-interface'

// Models exposed by agent-interface (see agent_interface/chat.py
// ALIASES). opus = Claude Opus (default — strongest reasoning), gpt =
// codex CLI, gemini = Gemini Pro, grok = Grok thinking. The frontend
// surfaces the four as a dropdown in the composer.
export const VALID_MODELS = ['opus', 'gpt', 'gemini', 'grok'] as const
export type ChatModel = typeof VALID_MODELS[number]
const DEFAULT_MODEL: ChatModel = 'opus'

function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

// Per-session work tree. agent-interface defaults to a TMPDIR path if
// --pwd is omitted, but we set it explicitly so the conversation is
// rooted in a stable, predictable directory we own. Attachments land
// inside this dir so the agent can read them via cwd.
//
// Lives under ~/.poise/chat-attachments/<sessionId>/ — durable across
// reboots, syncs alongside the rest of ~/.poise/ if the user puts it
// in Dropbox/iCloud/git. Was previously under $TMPDIR/poise-chat/...
// which macOS purges aperiodically; that meant a chat session
// continued days later would find its attachments gone even though
// the transcript referenced them. Path can be overridden with
// POISE_CHAT_ATTACHMENTS_DIR for tests or alt-home setups.
const CHAT_ATTACHMENTS_DIR = process.env.POISE_CHAT_ATTACHMENTS_DIR
  || join(homedir(), '.poise', 'chat-attachments')
const LEGACY_CHAT_TMPDIR = join(tmpdir(), 'poise-chat')
const CURRENT_CHAT_WORKTREE_RE = /-[a-f0-9]{64}$/i

function legacyChatDirectoryName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

function chatPwd(sessionId: string): string {
  const raw = String(sessionId || '')
  if (!raw) throw new Error('invalid session')
  const root = resolve(CHAT_ATTACHMENTS_DIR)
  const legacyName = legacyChatDirectoryName(raw)
  // Always include the full raw-session hash. A sanitized legacy directory
  // cannot be attributed safely because distinct owner/repo pairs can map to
  // the same name; selecting it by existence would cross chat boundaries.
  const readable = legacyName.replace(/^\.+/, '_').slice(0, 120) || 'session'
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
  const candidate = resolve(root, `${readable}-${digest}`)
  if (!candidate.startsWith(root + sep)) throw new Error('invalid session')
  return candidate
}

interface LegacyAttachmentSource {
  path: string
  root: string
  name: string
}

export interface LegacyAttachmentMigrationResult {
  migrated: number
  quarantined: number
}

// Legacy builds used only a sanitized session id as the directory name. That
// mapping is not injective ("owner/repo" and "owner?repo" collide), so a
// directory is moved only when agent-interface's canonical log identifies one
// unique raw session. rename keeps the directory move atomic. Ambiguous,
// unknown, conflicting, cross-device, and non-directory sources stay in place
// as inaccessible quarantine and are reported; no file is merged or deleted.
export async function migrateLegacyChatAttachments(
  listCalls: () => Promise<Pick<LogEntry, 'session_id'>[]> = fetchAgentLogs,
): Promise<LegacyAttachmentMigrationResult> {
  const durableRoot = resolve(CHAT_ATTACHMENTS_DIR)
  const roots = [...new Set([durableRoot, resolve(LEGACY_CHAT_TMPDIR)])]
  const sources: LegacyAttachmentSource[] = []
  for (const root of roots) {
    let names: string[]
    try { names = await readdir(root) } catch { continue }
    for (const name of names) {
      if (root === durableRoot && (name === '.legacy-quarantine' || CURRENT_CHAT_WORKTREE_RE.test(name))) continue
      const path = join(root, name)
      try {
        if ((await lstat(path)).isDirectory()) sources.push({ path, root, name })
      } catch { /* raced with a user cleanup */ }
    }
  }
  if (sources.length === 0) return { migrated: 0, quarantined: 0 }

  const sessions = new Set<string>()
  for (const row of await listCalls()) {
    const session = typeof row.session_id === 'string' ? row.session_id : ''
    if (session) sessions.add(session)
  }
  const byLegacyName = new Map<string, Set<string>>()
  const currentNames = new Set<string>()
  for (const session of sessions) {
    const legacyName = legacyChatDirectoryName(session)
    const matches = byLegacyName.get(legacyName) || new Set<string>()
    matches.add(session)
    byLegacyName.set(legacyName, matches)
    currentNames.add(chatPwd(session).slice(durableRoot.length + 1))
  }

  await mkdir(durableRoot, { recursive: true, mode: 0o700 })
  let migrated = 0
  let quarantined = 0
  for (const source of sources) {
    if (source.root === durableRoot && currentNames.has(source.name)) continue
    const matches = byLegacyName.get(source.name)
    if (!matches || matches.size !== 1) {
      quarantined += 1
      console.warn(`[chat] legacy attachment directory left quarantined at ${source.path}: ${matches ? 'ambiguous session mapping' : 'no attributable session'}`)
      continue
    }
    const session = [...matches][0]
    const target = chatPwd(session)
    try {
      await lstat(target)
      quarantined += 1
      console.warn(`[chat] legacy attachment directory left quarantined at ${source.path}: target already exists`)
      continue
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        quarantined += 1
        console.warn(`[chat] legacy attachment directory left quarantined at ${source.path}: ${error?.message || error}`)
        continue
      }
    }
    try {
      await rename(source.path, target)
      await chmod(target, 0o700)
      migrated += 1
    } catch (error: any) {
      quarantined += 1
      console.warn(`[chat] legacy attachment directory left quarantined at ${source.path}: ${error?.message || error}`)
    }
  }
  try { await rmdir(LEGACY_CHAT_TMPDIR) } catch { /* retained quarantine or absent */ }
  return { migrated, quarantined }
}

let legacyAttachmentMigration: Promise<void> | null = null

async function ensureLegacyAttachmentMigration(): Promise<void> {
  if (!legacyAttachmentMigration) {
    legacyAttachmentMigration = migrateLegacyChatAttachments()
      .then(() => undefined)
  }
  const attempt = legacyAttachmentMigration
  try {
    await attempt
  } catch (error: unknown) {
    if (legacyAttachmentMigration === attempt) legacyAttachmentMigration = null
    console.warn('[chat] legacy attachment migration deferred:', error)
    throw new HttpError(503, 'legacy attachment migration is temporarily unavailable')
  }
}

// Filename sanitization for attachment uploads — strip path
// separators, leading dots, and anything weird so a malicious filename
// can't escape chatPwd via "../" or land inside a hidden directory.
function safeAttachmentName(raw: string): string {
  const base = raw.replace(/^.*[\\\/]/, '')        // strip any path
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return cleaned.slice(0, 120) || 'attachment'
}

const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024       // 2 MB / file

// Voice style guide read fresh on every editor-bound chat turn so
// edits to the file land in the next message (matches the writer's
// expectation that what they see is what the agent sees). Path comes
// from POISE_VOICE_GUIDE_PATH; relative paths resolve from the server
// cwd, absolute paths pass through. Capped at 64 KB — anything larger
// almost certainly means the env var points at the wrong file, and
// silently flooding the prompt would mask the misconfiguration.
const VOICE_GUIDE_MAX_BYTES = 64 * 1024
const CHAT_CONTEXT_MAX_BYTES = 16 * 1024 * 1024
const CHAT_CONTEXT_DIR = '.poise-context'
const CHAT_CONTEXT_STALE_MS = 2 * 60 * 60 * 1000
const CONTEXT_PROMPT_PREFIX = '[Poise context file v1]'
const USER_MESSAGE_MARKER = "\n\n[User's message:]\n"

function assertHttpArgumentSize(value: string, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROCESS_ARG_BYTES) {
    throw new HttpError(413, `${label} exceeds ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes`)
  }
}

async function ensurePrivateSessionDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw new Error(`chat path is not a directory: ${path}`)
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

async function createChatContextFile(
  pwd: string,
  content: string,
): Promise<{ path: string, relativePath: string }> {
  if (Buffer.byteLength(content, 'utf8') > CHAT_CONTEXT_MAX_BYTES) {
    throw new HttpError(413, `chat context exceeds ${CHAT_CONTEXT_MAX_BYTES} UTF-8 bytes`)
  }
  const directory = join(pwd, CHAT_CONTEXT_DIR)
  await ensurePrivateSessionDirectory(directory)
  let names: string[] = []
  try { names = await readdir(directory) } catch { /* created above */ }
  for (const name of names) {
    if (!/^request-[0-9a-f-]+\.md$/.test(name)) continue
    const path = join(directory, name)
    try {
      if (Date.now() - (await stat(path)).mtimeMs >= CHAT_CONTEXT_STALE_MS) await unlink(path)
    } catch { /* active cleanup is best-effort */ }
  }
  const name = `request-${randomUUID()}.md`
  const path = join(directory, name)
  await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  return { path, relativePath: join(CHAT_CONTEXT_DIR, name) }
}

// A normal onExit removes each context file. If Poise itself is killed, the
// detached chat worker can still need that file for up to its one-hour
// deadline, so startup removes only copies older than two hours.
export async function cleanStaleChatContextFiles(): Promise<void> {
  let sessions: string[] = []
  try { sessions = await readdir(CHAT_ATTACHMENTS_DIR) } catch { return }
  for (const session of sessions) {
    try {
      if (!(await lstat(join(CHAT_ATTACHMENTS_DIR, session))).isDirectory()) continue
    } catch { continue }
    const directory = join(CHAT_ATTACHMENTS_DIR, session, CHAT_CONTEXT_DIR)
    try {
      if (!(await lstat(directory)).isDirectory()) continue
    } catch { continue }
    let names: string[] = []
    try { names = await readdir(directory) } catch { continue }
    for (const name of names) {
      if (!/^request-[0-9a-f-]+\.md$/.test(name)) continue
      const path = join(directory, name)
      try {
        if (Date.now() - (await stat(path)).mtimeMs >= CHAT_CONTEXT_STALE_MS) await unlink(path)
      } catch { /* raced with an active worker or user cleanup */ }
    }
    try { await rmdir(directory) } catch { /* still active or non-empty */ }
  }
}

void cleanStaleChatContextFiles().catch((error: unknown) => {
  console.warn('[chat] stale context cleanup failed:', error)
})

async function readUtf8Bounded(path: string, maxBytes: number, label: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error(`${label} is not a regular file`)
    if (fileStat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

// Response-format contract injected into every editor-bound turn so
// the chat-pane can render proposed changes as reviewable cards
// instead of a wall of text. The model is free to ignore it for
// discussion turns — the parser only kicks in when a reply starts
// with `{`. Format is identical to Confab's edit-card schema so the
// model's "I know this" priors carry over across vendors (opus, gpt,
// gemini, grok all handle it cleanly in practice).
const EDITOR_RESPONSE_FORMAT = [
  '[Response format]',
  'For free-form discussion, questions, or feedback: reply with plain prose.',
  'For one or more specific edits to the document: reply with a single JSON object — no prose around it:',
  '{"chat": "<your message to the user>", "edits": [{"description": "<short summary>", "context_before": "<short snippet just before the change>", "old": "<exact text to replace, verbatim from the document>", "new": "<replacement text>", "context_after": "<short snippet just after the change>"}]}',
  'For a full document rewrite: reply with JSON:',
  '{"chat": "<your message>", "document": "<full new markdown>"}',
  'Rules: "old" must be a verbatim substring of the current document. Pure insertions use "old": "". Pure deletions use "new": "". context_before and context_after are short (a few words) and only needed to disambiguate when "old" appears more than once.',
].join('\n')

async function readVoiceGuide(): Promise<string | null> {
  const envPath = process.env.POISE_VOICE_GUIDE_PATH
  if (!envPath) return null
  const path = isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath)
  try {
    return await readUtf8Bounded(path, VOICE_GUIDE_MAX_BYTES, 'voice guide')
  } catch (err: any) {
    console.warn(`[chat] POISE_VOICE_GUIDE_PATH unreadable (${path}): ${err.message || err}`)
    return null
  }
}

export interface ChatLogEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string | null
  error: string
  behavior: 'chat' | 'author_content'
  content_slug?: string
}

// Slug used for editor articles produced by /content in chat. The
// full SHA-256 digest makes the mapping deterministic without relying on a
// collision-prone call-id prefix.
export function contentSlugForCallId(callId: string): string {
  return 'content-' + createHash('sha256').update(String(callId), 'utf8').digest('hex')
}

// Only a completed durable job makes an authored article attributable and
// linkable. A filename (including a legacy short-prefix path) is never enough.
export async function existingContentSlugForCallId(callId: string): Promise<string | null> {
  const mapped = db.prepare(`
    SELECT slug FROM content_jobs WHERE call_id = ? AND status = 'completed'
  `).pluck().get(callId)
  return typeof mapped === 'string' ? mapped : null
}

export function mergeAuthorContentJobState(row: ChatLogEntry): ChatLogEntry {
  if (row.behavior !== 'author_content') return row
  const job = db.prepare(
    'SELECT status, slug, error FROM content_jobs WHERE call_id = ?',
  ).get(row.id) as { status: string, slug: string, error: string | null } | undefined
  if (!job) {
    // A completed agent response is not linkable until durable publication is
    // recorded. Periodic recovery will create the missing job if launch
    // discovery timed out or the server crashed before enqueue.
    return {
      ...row,
      status: row.status === 'failed' ? 'failed' : 'pending',
      content_slug: undefined,
    }
  }
  return {
    ...row,
    status: job.status,
    error: job.status === 'failed' ? String(job.error || row.error || 'failed') : row.error,
    content_slug: job.status === 'completed' ? job.slug : undefined,
  }
}

export async function listChatHistory(sessionId: string): Promise<ChatLogEntry[]> {
  if (!sessionId) return []
  const all = await fetchAgentLogs()
  // The proxy's fetchAgentLogs already returns newest-first; flip back
  // for chat (oldest-first reads top-to-bottom like a transcript).
  // We include both `chat` and `author_content` behaviors — author_content
  // calls now carry session_id (agent-interface --author-content
  // --session-id ID) so they belong in the transcript too. The chat
  // pane renders them differently: instead of the response body, a
  // link to the editor article that was authored.
  const rows = all
    .filter((e: any) =>
      (e.behavior === 'chat' || e.behavior === 'author_content')
      && e.session_id === sessionId)
    .reverse() as ChatLogEntry[]
  return rows.map((row) => {
    const marker = row.behavior === 'chat' && row.prompt.startsWith(CONTEXT_PROMPT_PREFIX)
      ? row.prompt.indexOf(USER_MESSAGE_MARKER)
      : -1
    const displayRow = marker >= 0
      ? { ...row, prompt: row.prompt.slice(marker + USER_MESSAGE_MARKER.length) }
      : row
    return mergeAuthorContentJobState(displayRow)
  })
}

export async function sendChat(
  sessionId: string,
  message: string,
  model: string = DEFAULT_MODEL,
  attachments: string[] = [],
): Promise<{ ok: true }> {
  if (!sessionId) throw new Error('session is required')
  assertHttpArgumentSize(sessionId, 'session')
  const trimmed = String(message || '').trim()
  if (!trimmed) throw new Error('message is required')
  const chosen: ChatModel = (VALID_MODELS as readonly string[]).includes(model)
    ? (model as ChatModel)
    : DEFAULT_MODEL

  await ensureLegacyAttachmentMigration()
  const pwd = chatPwd(sessionId)
  await ensurePrivateSessionDirectory(pwd)

  // Attachments already live in pwd (saved by saveAttachment). We
  // append a short footer to the prompt so the agent knows to look at
  // them — without it, models often ignore files that haven't been
  // explicitly mentioned. Names are filtered through the same
  // sanitizer as on upload to be defensive.
  let userMessage = trimmed
  if (attachments.length) {
    const names = attachments.map(safeAttachmentName)
    userMessage += `\n\n[Attached files in cwd: ${names.join(', ')}]`
  }
  const contextSections: string[] = []
  let contextBytes = 0
  const appendContext = (section: string) => {
    const added = Buffer.byteLength(section, 'utf8') + (contextSections.length ? 2 : 0)
    if (contextBytes + added > CHAT_CONTEXT_MAX_BYTES) {
      throw new HttpError(413, `chat context exceeds ${CHAT_CONTEXT_MAX_BYTES} UTF-8 bytes`)
    }
    contextBytes += added
    contextSections.push(section)
  }

  // Editor-bound chats: prepend the voice guide and the doc's current
  // body. agent-interface --chat resumes the model's session memory,
  // but the writer is actively editing — we feed the latest state on
  // every turn so the model sees what the user sees. Voice guide is
  // editor-only (it's about prose, not card chats). Both are
  // best-effort: missing voice guide or deleted doc just skip that
  // section, the conversation continues.
  const editorSlug = slugFromEditorSession(sessionId)
  if (editorSlug) {
    const voice = await readVoiceGuide()
    if (voice) {
      appendContext(`[Voice guide — the user's writing voice. Apply this style when proposing edits or generating prose.]\n${voice}`)
    }
    try {
      const doc = await readDoc(editorSlug)
      appendContext(`[Current document:]\n${doc.content}`)
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw new Error(`could not read editor doc ${editorSlug}: ${err.message || err}`, { cause: err })
      }
    }
    // Response-format contract. The chat-pane is willing to parse a
    // single JSON object from the reply when it carries an `edits`
    // array or a `document` string; otherwise it renders the reply
    // as prose. The directive ships every turn (alongside voice +
    // doc) so a long-lived session can't drift off the contract.
    appendContext(EDITOR_RESPONSE_FORMAT)
  }

  // If this session has prior /content invocations, inject the
  // CURRENT body of each authored article as context. The user might
  // have edited the article in the editor since it was authored —
  // agent-interface --chat resumes the model's session but won't
  // know about edits. Injection here makes "the article in its
  // current form is in the context of the chat when it is continued
  // later, as if it was in the chat window itself" actually true.
  const articleBlocks = await readArticleContextForSession(
    sessionId,
    CHAT_CONTEXT_MAX_BYTES - contextBytes,
  )
  for (const block of articleBlocks) appendContext(block)

  let contextPath: string | null = null
  let prompt = userMessage
  if (contextSections.length) {
    const context = await createChatContextFile(pwd, contextSections.join('\n\n'))
    contextPath = context.path
    prompt = `${CONTEXT_PROMPT_PREFIX}\nRead the complete UTF-8 context file "${context.relativePath}" under your working directory before answering. Do not modify it.${USER_MESSAGE_MARKER}${userMessage}`
  }

  try {
    assertHttpArgumentSize(prompt, 'chat prompt')
    await spawnDetached(
      AGENT_INTERFACE,
      ['--chat', prompt, '--model', chosen, '--session', sessionId, '--pwd', pwd],
      {
        cwd: agentInterfaceCwd(),
        ...(contextPath ? { onExit: () => unlink(contextPath!).catch(() => undefined) } : {}),
      },
    )
  } catch (error) {
    if (contextPath) await unlink(contextPath).catch(() => undefined)
    throw error
  }
  return { ok: true }
}

// Save an attachment uploaded by the front-end into the session's
// pwd directory so the agent can read it via cwd. Returns the
// sanitized filename the front-end should reference when sending the
// chat. Caller passes raw bytes; we cap at ATTACHMENT_MAX_BYTES so
// pwd doesn't get blown out by a runaway upload.
export async function saveAttachment(
  sessionId: string,
  filename: string,
  body: Buffer,
): Promise<{ ok: true, name: string, size: number }> {
  if (!sessionId) throw new Error('session is required')
  assertHttpArgumentSize(sessionId, 'session')
  if (!filename) throw new Error('filename is required')
  if (body.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment too large (max ${ATTACHMENT_MAX_BYTES} bytes)`)
  }
  await ensureLegacyAttachmentMigration()
  const pwd = chatPwd(sessionId)
  await ensurePrivateSessionDirectory(pwd)
  const originalName = safeAttachmentName(filename)
  const name = `${randomUUID()}-${originalName}`
  // Unique immutable names keep old transcript references stable when a
  // filename is uploaded twice or two raw names sanitize to the same value.
  await writeFile(join(pwd, name), body, { flag: 'wx', mode: 0o600 })
  return { ok: true, name, size: body.byteLength }
}

// ── /consensus → agent-interface --debate ─────────────────────────────
// Synchronous wrapper around the local `agent-interface --debate`
// runner. The CLI writes a row to agent-interface's calls log when it
// fires, so the run appears in Swarm alongside chat/pr_review/etc.
// Returns the parsed `{synthesis, rounds}` payload verbatim so the
// chat-pane can render the synthesis as an agent turn.
const DEBATE_MAX_ROUNDS = 8
// agent-interface --debate already caps each call at 60 min internally
// (debate.py: timeout_s=3600 default). Poise's outer timeout is set
// slightly higher (65 min) so the CLI gets to write `finish(...)`
// before we'd ever SIGTERM it — otherwise the row stays stuck at
// `running` in agent-interface's calls log and Swarm can't tell the
// difference between "still going" and "Poise killed it."
const DEBATE_TIMEOUT_MS = 65 * 60_000
const DEBATE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export interface DebateResult { synthesis: string; rounds: any[] }
export async function runDebate(topic: string, rounds: number = 1): Promise<DebateResult> {
  const t = String(topic || '').trim()
  if (!t) throw new Error('topic is required')
  assertHttpArgumentSize(t, 'debate topic')
  const r = Math.min(Math.max(Number.isFinite(rounds) ? rounds : 1, 1), DEBATE_MAX_ROUNDS)
  let stdout: string
  try {
    ({ stdout } = await runFile(
      AGENT_INTERFACE,
      ['--debate', t, '--rounds', String(r)],
      {
        cwd: agentInterfaceCwd(),
        timeoutMs: DEBATE_TIMEOUT_MS,
        maxOutputBytes: DEBATE_MAX_OUTPUT_BYTES,
      },
    ))
  } catch (err: any) {
    const detail = String(err?.stderr || err?.stdout || '').trim()
    if (detail) throw new Error(detail)
    throw err
  }
  try {
    // The CLI wraps the debate output as
    //   { id, model, rounds, response: "<json-string>" }
    // where `response` is itself JSON containing {synthesis, rounds}.
    // Unwrap one level to get the actual payload.
    const wrapper = JSON.parse(stdout.trim()) as { response?: string }
    if (typeof wrapper.response !== 'string') {
      throw new Error('debate output missing wrapper.response')
    }
    const inner = JSON.parse(wrapper.response) as Partial<DebateResult>
    if (typeof inner.synthesis !== 'string' || !Array.isArray(inner.rounds)) {
      throw new Error('debate inner payload missing synthesis or rounds')
    }
    return { synthesis: inner.synthesis, rounds: inner.rounds }
  } catch (err) {
    throw new Error(`debate JSON parse failed: ${(err as Error).message}`)
  }
}

// ── /content slash-command bridge ─────────────────────────────────────
// Spawns `agent-interface --author-content TOPIC` (no --pwd; the
// behavior isn't pinned to a repo). Because the spawn is detached
// fire-and-forget, we briefly poll --logs immediately after to find
// the freshly-minted call row and grab its id; the front-end then
// polls /api/chat-content/status?call_id=… for completion.
//
// `--session-id` ties the author_content log row back to this chat, so
// history can surface the authored turn and later messages can inject the
// article's current editor contents.

export const AUTHOR_CONTENT_TOPIC_MAX_BYTES = 64 * 1024

export function normalizeAuthorContentTopic(topic: string): string {
  const trimmed = String(topic || '').trim()
  if (!trimmed) throw new HttpError(400, 'topic is required')
  if (Buffer.byteLength(trimmed, 'utf8') > AUTHOR_CONTENT_TOPIC_MAX_BYTES) {
    throw new HttpError(413, `topic exceeds ${AUTHOR_CONTENT_TOPIC_MAX_BYTES} UTF-8 bytes`)
  }
  return trimmed
}

export abstract class AuthorContentDiscoveryPendingError extends Error {
  abstract readonly code: string
}

export class AuthorContentDiscoveryTimeoutError extends AuthorContentDiscoveryPendingError {
  readonly code = 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT'

  constructor(message = 'agent-interface --author-content did not register a new call within 3s') {
    super(message)
    this.name = 'AuthorContentDiscoveryTimeoutError'
  }
}

export class AuthorContentDiscoveryUnavailableError extends AuthorContentDiscoveryPendingError {
  readonly code = 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE'

  constructor(cause: unknown) {
    super(
      'agent-interface log discovery failed after author-content launch; correlation remains pending',
      { cause },
    )
    this.name = 'AuthorContentDiscoveryUnavailableError'
  }
}

export function isAuthorContentDiscoveryPendingError(
  error: unknown,
): error is AuthorContentDiscoveryPendingError {
  const code = String((error as { code?: unknown } | null)?.code || '')
  return error instanceof AuthorContentDiscoveryPendingError
    || code === 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT'
    || code === 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE'
}

export async function startAuthorContent(topic: string, sessionId: string): Promise<{ call_id: string, started_at: string }> {
  // Enforce the portable one-argument budget before any CLI work. Linux's
  // common per-string argv ceiling is 128 KiB; 64 KiB leaves headroom for
  // encoding and platform variance.
  const trimmed = normalizeAuthorContentTopic(topic)
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) throw new HttpError(400, 'session is required')
  assertHttpArgumentSize(normalizedSessionId, 'session')
  // Snapshot every existing id in this session. Exact topic matching prevents
  // an unrelated delayed call from being attributed to this launch.
  const beforeIds = new Set((await fetchAgentLogs())
    .filter((entry: any) => entry.behavior === 'author_content' && entry.session_id === normalizedSessionId)
    .map((entry: any) => String(entry.id || '')))

  // --session-id ties this call to the chat session, so the chat
  // history can include this turn (listChatHistory filters by
  // session_id across both behaviors).
  await spawnDetached(
    AGENT_INTERFACE,
    ['--author-content', trimmed, '--session-id', normalizedSessionId],
    { cwd: agentInterfaceCwd() },
  )

  const deadline = Date.now() + 3000
  let ambiguous = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    let fresh: LogEntry[]
    try {
      fresh = (await fetchAgentLogs()).filter((entry: any) => {
        const id = String(entry.id || '')
        return entry.behavior === 'author_content'
          && entry.session_id === normalizedSessionId
          && String(entry.prompt || '').trim() === trimmed
          && /^[0-9a-fA-F]{32}$/.test(id)
          && !beforeIds.has(id)
      })
    } catch (error) {
      // spawnDetached has already observed the child's spawn event. A log
      // lookup failure cannot prove that no call exists, so durable intent
      // recovery must retain ownership of this launch.
      throw new AuthorContentDiscoveryUnavailableError(error)
    }
    if (fresh.length === 1) {
      return { call_id: String(fresh[0].id), started_at: String(fresh[0].started_at || '') }
    }
    if (fresh.length > 1) ambiguous = true
  }
  throw new AuthorContentDiscoveryTimeoutError(ambiguous
    ? 'multiple matching author-content calls registered; correlation remains pending'
    : undefined)
}

export async function authorContentStatus(callId: string): Promise<{
  status: string,
  response_hash?: string,
  body?: string,
  error?: string,
}> {
  const all = await fetchAgentLogs()
  const row = all.find((e: any) => e.id === callId)
  if (!row) return { status: 'unknown' }
  return {
    status: String(row.status || ''),
    response_hash: row.response ? String(row.response) : undefined,
    error: row.error ? String(row.error) : undefined,
  }
}

// Find every author_content call attributed to this chat session, in
// chronological order, and read the CURRENT body of each one's
// editor article. Used by sendChat to inject article context into
// chat continuations — see the comment there. Articles the user has
// since deleted are skipped silently; non-existent files don't bring
// the chat down.
async function readArticleContextForSession(sessionId: string, maxBytes: number): Promise<string[]> {
  if (!sessionId) return []
  const all = await fetchAgentLogs()
  // fetchAgentLogs is newest-first; reverse for chronological injection.
  const rows = all
    .filter((e: any) =>
      e.behavior === 'author_content'
      && e.session_id === sessionId
      && e.status === 'completed')
    .reverse()
  const out: string[] = []
  let usedBytes = 0
  for (const r of rows) {
    const slug = await existingContentSlugForCallId(String(r.id))
    if (!slug) continue
    let doc
    try {
      doc = await readDoc(slug)
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue // user may have deleted it
      throw new Error(`could not read authored article ${slug}: ${error?.message || error}`, { cause: error })
    }
    const title = (doc.content || '').split('\n').find((line) => line.trim().length > 0)
      ?.replace(/^#+\s*/, '').trim().slice(0, 200) || ''
    const block = `[Article ${out.length + 1} authored in this chat — current contents${title ? ` (titled "${title}")` : ''}:]\n${doc.content}`
    const added = Buffer.byteLength(block, 'utf8') + (out.length ? 2 : 0)
    if (usedBytes + added > maxBytes) {
      throw new HttpError(413, `chat context exceeds ${CHAT_CONTEXT_MAX_BYTES} UTF-8 bytes`)
    }
    usedBytes += added
    out.push(block)
  }
  return out
}
