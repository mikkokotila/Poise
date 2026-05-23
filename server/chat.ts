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

import { spawn } from 'node:child_process'
import { join, resolve, isAbsolute } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir, writeFile, readFile, readdir, rename, rmdir, stat } from 'node:fs/promises'
import { fetchAgentLogs } from './agent'
import { readDoc, slugFromEditorSession } from './editor'

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
function chatPwd(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(CHAT_ATTACHMENTS_DIR, safe)
}

// One-time migration: move any attachments left in the previous
// $TMPDIR/poise-chat/<session>/ tree to the new durable
// ~/.poise/chat-attachments/<session>/ location. Runs at module load,
// best-effort, swallows errors. Existing files in the new location
// are never overwritten — the migration favours not losing newer
// state if a session somehow has both. Empty source dirs are simply
// removed. After every session is migrated (or already migrated),
// the empty $TMPDIR/poise-chat parent is removed too.
async function migrateLegacyChatTmpdir(): Promise<void> {
  const oldRoot = join(tmpdir(), 'poise-chat')
  let sessions: string[]
  try { sessions = await readdir(oldRoot) } catch { return }     // nothing to do
  for (const session of sessions) {
    const oldDir = join(oldRoot, session)
    const newDir = join(CHAT_ATTACHMENTS_DIR, session)
    try {
      const files = await readdir(oldDir)
      if (files.length === 0) {
        try { await rmdir(oldDir) } catch { /* ok */ }
        continue
      }
      await mkdir(newDir, { recursive: true })
      for (const f of files) {
        const target = join(newDir, f)
        // Don't clobber a file already in the new location.
        try { await stat(target); continue } catch { /* doesn't exist — safe to move */ }
        try { await rename(join(oldDir, f), target) } catch { /* skip this file */ }
      }
      try { await rmdir(oldDir) } catch { /* may have files we couldn't move */ }
    } catch { /* ok */ }
  }
  try { await rmdir(oldRoot) } catch { /* may still have non-empty subdirs */ }
}
void migrateLegacyChatTmpdir()

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
    const content = await readFile(path, 'utf-8')
    if (Buffer.byteLength(content, 'utf-8') > VOICE_GUIDE_MAX_BYTES) {
      console.warn(`[chat] voice guide at ${path} exceeds ${VOICE_GUIDE_MAX_BYTES} bytes — skipping`)
      return null
    }
    return content
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
  response: string
  error: string
}

// Slug used for editor articles produced by /content in chat. The
// short hash derives from the agent-interface call's id, so the
// mapping "this chat turn → this article" is purely positional —
// no extra ledger needed.
export function contentSlugForCallId(callId: string): string {
  return 'content-' + String(callId).slice(0, 8)
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
  return rows
}

export async function sendChat(
  sessionId: string,
  message: string,
  model: string = DEFAULT_MODEL,
  attachments: string[] = [],
): Promise<{ ok: true }> {
  if (!sessionId) throw new Error('session is required')
  const trimmed = String(message || '').trim()
  if (!trimmed) throw new Error('message is required')
  const chosen: ChatModel = (VALID_MODELS as readonly string[]).includes(model)
    ? (model as ChatModel)
    : DEFAULT_MODEL

  const pwd = chatPwd(sessionId)
  await mkdir(pwd, { recursive: true })

  // Attachments already live in pwd (saved by saveAttachment). We
  // append a short footer to the prompt so the agent knows to look at
  // them — without it, models often ignore files that haven't been
  // explicitly mentioned. Names are filtered through the same
  // sanitizer as on upload to be defensive.
  let prompt = trimmed
  if (attachments.length) {
    const names = attachments.map(safeAttachmentName)
    prompt += `\n\n[Attached files in cwd: ${names.join(', ')}]`
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
    const sections: string[] = []
    const voice = await readVoiceGuide()
    if (voice) {
      sections.push(`[Voice guide — the user's writing voice. Apply this style when proposing edits or generating prose.]\n${voice}`)
    }
    try {
      const doc = await readDoc(editorSlug)
      sections.push(`[Current document:]\n${doc.content}`)
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[chat] could not read editor doc ${editorSlug}: ${err.message || err}`)
      }
    }
    // Response-format contract. The chat-pane is willing to parse a
    // single JSON object from the reply when it carries an `edits`
    // array or a `document` string; otherwise it renders the reply
    // as prose. The directive ships every turn (alongside voice +
    // doc) so a long-lived session can't drift off the contract.
    sections.push(EDITOR_RESPONSE_FORMAT)
    if (sections.length) {
      prompt = `${sections.join('\n\n')}\n\n[User's message:]\n${prompt}`
    }
  }

  // If this session has prior /content invocations, inject the
  // CURRENT body of each authored article as context. The user might
  // have edited the article in the editor since it was authored —
  // agent-interface --chat resumes the model's session but won't
  // know about edits. Injection here makes "the article in its
  // current form is in the context of the chat when it is continued
  // later, as if it was in the chat window itself" actually true.
  const articles = await readArticlesForSession(sessionId)
  if (articles.length) {
    const blocks = articles.map(({ title, content }, i) => (
      `[Article ${i + 1} authored in this chat — current contents${title ? ` (titled "${title}")` : ''}:]\n${content}`
    ))
    prompt = `${blocks.join('\n\n')}\n\n[User's message:]\n${prompt}`
  }

  const child = spawn(
    AGENT_INTERFACE,
    ['--chat', prompt, '--model', chosen, '--session', sessionId, '--pwd', pwd],
    {
      cwd: agentInterfaceCwd(),
      detached: true,
      stdio: 'ignore',
    },
  )
  child.unref()
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
  if (!filename) throw new Error('filename is required')
  if (body.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment too large (max ${ATTACHMENT_MAX_BYTES} bytes)`)
  }
  const pwd = chatPwd(sessionId)
  await mkdir(pwd, { recursive: true })
  const name = safeAttachmentName(filename)
  await writeFile(join(pwd, name), body)
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
export interface DebateResult { synthesis: string; rounds: any[] }
export async function runDebate(topic: string, rounds: number = 1): Promise<DebateResult> {
  const t = String(topic || '').trim()
  if (!t) throw new Error('topic is required')
  const r = Math.min(Math.max(Number.isFinite(rounds) ? rounds : 1, 1), DEBATE_MAX_ROUNDS)
  return new Promise<DebateResult>((resolve, reject) => {
    const child = spawn(
      AGENT_INTERFACE,
      ['--debate', t, '--rounds', String(r)],
      { cwd: agentInterfaceCwd() },
    )
    let stdout = ''
    let stderr = ''
    const killer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* ignore */ } }, DEBATE_TIMEOUT_MS)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => { clearTimeout(killer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(killer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `agent-interface --debate exited ${code}`))
        return
      }
      try {
        // The CLI wraps the debate output as
        //   { id, model, rounds, response: "<json-string>" }
        // where `response` is itself JSON containing {synthesis, rounds}.
        // Unwrap one level to get the actual payload.
        const wrapper = JSON.parse(stdout.trim()) as { response?: string }
        if (typeof wrapper.response !== 'string') {
          reject(new Error('debate output missing wrapper.response'))
          return
        }
        const inner = JSON.parse(wrapper.response) as Partial<DebateResult>
        if (typeof inner.synthesis !== 'string' || !Array.isArray(inner.rounds)) {
          reject(new Error('debate inner payload missing synthesis or rounds'))
          return
        }
        resolve({ synthesis: inner.synthesis, rounds: inner.rounds })
      } catch (err) {
        reject(new Error(`debate JSON parse failed: ${(err as Error).message}`))
      }
    })
  })
}

// ── /content slash-command bridge ─────────────────────────────────────
// Spawns `agent-interface --author-content TOPIC` (no --pwd; the
// behavior isn't pinned to a repo). Because the spawn is detached
// fire-and-forget, we briefly poll --logs immediately after to find
// the freshly-minted call row and grab its id; the front-end then
// polls /api/chat-content/status?call_id=… for completion.
//
// The author_content row in agent-interface's calls log doesn't carry
// a session_id today (the CLI doesn't accept --session for that
// behavior). Until that lands, the chat history can't surface a turn
// for it; the article exists in the editor only and is the user's
// reference. See the comment in cache-plugin.ts /api/chat-content.

export async function startAuthorContent(topic: string, sessionId: string): Promise<{ call_id: string, started_at: string }> {
  const trimmed = String(topic || '').trim()
  if (!trimmed) throw new Error('topic is required')
  if (!sessionId) throw new Error('session is required')
  // Sentinel: latest author_content call's id BEFORE we spawn,
  // scoped to THIS session so a parallel /content in some other
  // session doesn't get attributed here. After the spawn we poll
  // --logs for a NEW row in this session.
  const beforeForSession = (await fetchAgentLogs())
    .find((e: any) => e.behavior === 'author_content' && e.session_id === sessionId)?.id || ''

  // --session-id ties this call to the chat session, so the chat
  // history can include this turn (listChatHistory filters by
  // session_id across both behaviors).
  const child = spawn(
    AGENT_INTERFACE,
    ['--author-content', trimmed, '--session-id', sessionId],
    { cwd: agentInterfaceCwd(), detached: true, stdio: 'ignore' },
  )
  child.unref()

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    const fresh = (await fetchAgentLogs())
      .find((e: any) => e.behavior === 'author_content' && e.session_id === sessionId)
    if (fresh && fresh.id !== beforeForSession) {
      return { call_id: String(fresh.id), started_at: String(fresh.started_at || '') }
    }
  }
  throw new Error('agent-interface --author-content did not register a new call within 3s')
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
async function readArticlesForSession(sessionId: string): Promise<{ slug: string, title: string, content: string }[]> {
  if (!sessionId) return []
  const all = await fetchAgentLogs()
  // fetchAgentLogs is newest-first; reverse for chronological injection.
  const rows = all
    .filter((e: any) =>
      e.behavior === 'author_content'
      && e.session_id === sessionId
      && e.status === 'completed')
    .reverse()
  const out: { slug: string, title: string, content: string }[] = []
  for (const r of rows) {
    const slug = contentSlugForCallId(String(r.id))
    try {
      const doc = await readDoc(slug)
      const title = (doc.content || '').split('\n').find((l) => l.trim().length > 0)?.replace(/^#+\s*/, '').trim() || ''
      out.push({ slug, title, content: doc.content })
    } catch { /* article missing — user may have deleted it */ }
  }
  return out
}
