// Bridge to the local `agent-interface` CLI for Swarm's data source.
//
// Two operations:
//   --logs                  → JSON array of completed agent calls
//   --read-response <id>    → response body, looked up by the full call id
//                             field
//
// Everything is hash-routed now — Poise never touches the filesystem
// the agent-interface project owns.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { localCheckoutPath } from './gh'
import { runFile, spawnDetached } from './process'

const CLI = 'agent-interface'

// agent-interface's DB stores some response_paths as relative
// (`data/responses/<id>.txt`) and `--read-response` reads them without
// resolving against the project root — so the CLI must be invoked with
// cwd at the agent-interface project root for those entries to work.
// Override via env if your install lives elsewhere.
function agentCwd(): string {
  return process.env.AGENT_INTERFACE_ROOT
    || join(homedir(), 'dev', 'caller', 'agent_interface')
}

export interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string | null
  model: string
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  session_id: string | null
  prompt: string
  started_at: string
  time_elapsed: string
  status: string
  response: string | null // upstream 8-char availability marker; read by full `id`
  error: string
}

export async function fetchAgentLogs(): Promise<LogEntry[]> {
  const { stdout } = await runFile(CLI, ['--logs'], {
    cwd: agentCwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  // agent-interface returns oldest-first (`order by started_at`).
  // Surface newest-first so the front-end doesn't carry the convention.
  const list: unknown = JSON.parse(trimmed)
  if (!Array.isArray(list)) throw new Error('agent-interface --logs returned non-array JSON')
  return list.reverse()
}

// Fetch one response body by the full 32-hex call id. agent-interface also
// accepts prefixes, but those become ambiguous as the log grows.
export async function fetchAgentResponse(callId: string): Promise<{ id: string, body: string }> {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) {
    throw new Error('invalid agent call id')
  }
  const { stdout } = await runFile(CLI, ['--read-response', callId], {
    cwd: agentCwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  })
  return { id: callId, body: stdout }
}

// Kick off `agent-interface --pr-review #<num> --pwd <local-checkout>`.
// The underlying claude run takes minutes; we spawn detached and return
// immediately. The user watches progress in the Swarm view (the agent
// call lands as a new entry with status='running' the moment track()
// fires upstream, then settles to completed/failed).
export async function triggerPrReview(prUrl: string): Promise<{ ok: true }> {
  const m = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url')
  const [, owner, repo, num] = m
  const pwd = await localCheckoutPath(owner, repo)

  await spawnDetached(CLI, ['--pr-review', `#${num}`, '--pwd', pwd], {
    cwd: agentCwd(),
  })
  return { ok: true }
}

// Replay an existing agent-interface job — used by the Swarm view's
// Replay column. The frontend sends the row's `behavior` + `repo` +
// `pr_id`; we map behavior → CLI flag and re-spawn the same command
// with the repo's local checkout as --pwd. A new row will appear in
// `agent-interface --logs` for the new run; the existing row is
// untouched. Only pr_review and pr_approve are replayable through
// this path — other behaviors aren't exposed as standalone CLI
// invocations today.
export async function replayAgentJob(input: {
  behavior?: string,
  repo?: string,
  pr_id?: string | number,
}): Promise<{ ok: true }> {
  const behavior = String(input.behavior || '')
  const repo = String(input.repo || '')
  const prId = String(input.pr_id || '')
  if (!repo.includes('/'))   throw new Error('repo must be owner/name')
  if (!/^\d+$/.test(prId))   throw new Error('pr_id must be a positive integer')

  let flag: string
  if (behavior === 'pr_review')       flag = '--pr-review'
  else if (behavior === 'pr_approve') flag = '--pr-approve'
  else throw new Error(`behavior "${behavior}" is not replayable`)

  const [owner, repoName] = repo.split('/', 2)
  const pwd = await localCheckoutPath(owner, repoName)
  await spawnDetached(CLI, [flag, `#${prId}`, '--pwd', pwd], {
    cwd: agentCwd(),
  })
  return { ok: true }
}
