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
import { mkdir } from 'node:fs/promises'
import { fetchAgentLogs } from './agent'

const AGENT_INTERFACE = 'agent-interface'

// `--model gpt` is the alias that runs under the codex CLI inside
// agent-interface (see agent_interface/chat.py — gpt-5.5-xhigh path
// shells to $CODEX_CLI). User's request was "codex for this".
const CHAT_MODEL = 'gpt'

function agentInterfaceCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

// Per-session work tree. agent-interface defaults to a TMPDIR path if
// --pwd is omitted, but we set it explicitly so the conversation is
// rooted in a stable, predictable directory we own.
function chatPwd(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(tmpdir(), 'poise-chat', safe)
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

export async function sendChat(sessionId: string, message: string): Promise<{ ok: true }> {
  if (!sessionId) throw new Error('session is required')
  const trimmed = String(message || '').trim()
  if (!trimmed) throw new Error('message is required')

  const pwd = chatPwd(sessionId)
  await mkdir(pwd, { recursive: true })

  const child = spawn(
    AGENT_INTERFACE,
    ['--chat', trimmed, '--model', CHAT_MODEL, '--session', sessionId, '--pwd', pwd],
    {
      cwd: agentInterfaceCwd(),
      detached: true,
      stdio: 'ignore',
    },
  )
  child.unref()
  return { ok: true }
}
