// Bridge to the local `agent-interface` CLI for Swarm's data source.
//
// `agent-interface --logs` prints a JSON array of completed agent calls,
// each with a `response_path` relative to the agent_interface project
// root. There's no CLI/HTTP way to fetch the response body, so we read
// the file directly. Path is overridable via env so the install layout
// isn't hardcoded for everyone.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const execFileP = promisify(execFile)
const CLI = 'agent-interface'

// agent-interface project root (where `data/responses/<id>.txt` lives).
// The relative response_path emitted by --logs is resolved against this.
function agentRoot(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

interface LogEntry {
  id: string
  model: string
  prompt: string
  time_elapsed: string
  status: string
  response_path: string
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

// Read the response body for one log entry. The id-based lookup runs
// `agent-interface --logs` to find the matching entry's response_path —
// fine because the call is on demand (only when the user clicks View).
export async function fetchAgentResponse(id: string): Promise<{ id: string, body: string } | null> {
  const logs = await fetchAgentLogs()
  const entry = logs.find((e) => e.id === id)
  if (!entry) return null
  const rel = entry.response_path
  const abs = isAbsolute(rel) ? rel : join(agentRoot(), rel)
  try {
    const body = await readFile(abs, 'utf-8')
    return { id, body }
  } catch {
    return { id, body: '' }
  }
}
