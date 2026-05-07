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

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { localCheckoutPath } from './gh'

const execFileP = promisify(execFile)
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

interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string
  model: string
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  prompt: string
  time_elapsed: string
  status: string
  response: string        // 8-char hash; pass to --read-response for the body
  error: string
}

export async function fetchAgentLogs(): Promise<LogEntry[]> {
  const { stdout } = await execFileP(CLI, ['--logs'], {
    cwd: agentCwd(),
    maxBuffer: 32 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  // agent-interface returns oldest-first (`order by started_at`).
  // Surface newest-first so the front-end doesn't carry the convention.
  const list: LogEntry[] = JSON.parse(trimmed)
  return list.reverse()
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
    cwd: agentCwd(),
    maxBuffer: 32 * 1024 * 1024,
  })
  return { hash, body: stdout }
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

  const child = spawn(CLI, ['--pr-review', `#${num}`, '--pwd', pwd], {
    cwd: agentCwd(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
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
  const child = spawn(CLI, [flag, `#${prId}`, '--pwd', pwd], {
    cwd: agentCwd(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { ok: true }
}
