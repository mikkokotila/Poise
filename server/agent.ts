// Bridge to the local `agent-interface` CLI for Swarm's data source.
//
// Two operations:
//   --logs                  → JSON array of completed agent calls
//   --read-response <hash>  → response body, looked up by the 8-char
//                             prefix returned in the log's `response`
//                             field
//
// Everything is hash-routed now — Poise never touches the filesystem
// the agent-interface project owns.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const CLI = 'agent-interface'

interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string
  model: string
  prompt: string
  time_elapsed: string
  status: string
  response: string        // 8-char hash; pass to --read-response for the body
  error: string
}

export async function fetchAgentLogs(): Promise<LogEntry[]> {
  const { stdout } = await execFileP(CLI, ['--logs'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  return JSON.parse(trimmed)
}

// Fetch one response body by its hash (the 8-char value from a log
// entry's `response` field). agent-interface looks up the full row by
// `id like <hash>%` and prints the body.
export async function fetchAgentResponse(hash: string): Promise<{ hash: string, body: string }> {
  // Guard against shell-injection-style input — only hex prefixes pass.
  if (!/^[0-9a-fA-F]+$/.test(hash)) {
    throw new Error('invalid response hash')
  }
  const { stdout } = await execFileP(CLI, ['--read-response', hash], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return { hash, body: stdout }
}
