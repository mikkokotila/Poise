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
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { fetchAgentLogs } from './agent'

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
function chatPwd(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(tmpdir(), 'poise-chat', safe)
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

export interface ChatLogEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string
  error: string
}

export async function listChatHistory(sessionId: string): Promise<ChatLogEntry[]> {
  if (!sessionId) return []
  const all = await fetchAgentLogs()
  // The proxy's fetchAgentLogs already returns newest-first; flip back
  // for chat (oldest-first reads top-to-bottom like a transcript).
  const rows = all
    .filter((e: any) => e.behavior === 'chat' && e.session_id === sessionId)
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
