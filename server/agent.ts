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
import { randomUUID } from 'node:crypto'
import { getHeadSha, getReviewAgentUsername, localCheckoutPath } from './gh'
import { claudeAuth } from './claude-auth'
import { claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'

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
  started_at_precise?: string | null
  completed_at?: string | null
  time_elapsed: string
  status: string
  outcome: 'clean' | 'changes_requested' | 'approved' | 'superseded' | 'preflight_failed' | null
  head_sha: string | null
  expected_head: string | null
  source: string | null
  correlation_id: string | null
  action: 'reviewed_clean' | 'requested_changes' | 'approved' | 'not_started' | null
  response: string | null // upstream 8-char availability marker; read by full `id`
  error: string
}

export async function fetchAgentLogs(
  options: { signal?: AbortSignal } = {},
): Promise<LogEntry[]> {
  const { stdout } = await runFile(CLI, ['--logs'], {
    cwd: agentCwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
    signal: options.signal,
  })
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('agent-interface --logs returned empty output')
  // agent-interface returns oldest-first (`order by started_at`).
  // Surface newest-first so the front-end doesn't carry the convention.
  let list: unknown
  try { list = JSON.parse(trimmed) }
  catch (error) {
    throw new Error('agent-interface --logs returned invalid JSON', { cause: error })
  }
  if (!Array.isArray(list)) throw new Error('agent-interface --logs returned non-array JSON')
  return list.map(validateLogEntry).reverse()
}

function validateLogEntry(value: unknown, index: number): LogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`agent-interface log row ${index} is not an object`)
  }
  const row = value as Record<string, unknown>
  const optionalString = (field: string): string | null => {
    const item = row[field]
    if (item === null) return null
    if (typeof item !== 'string') {
      throw new Error(`agent-interface log row ${index} has invalid ${field}`)
    }
    return item
  }
  const requiredString = (field: string): string => {
    const item = row[field]
    if (typeof item !== 'string') {
      throw new Error(`agent-interface log row ${index} has invalid ${field}`)
    }
    return item
  }
  const id = requiredString('id').toLowerCase()
  const prId = optionalString('pr_id')
  const repo = optionalString('repo')
  const actor = optionalString('actor')
  const behavior = optionalString('behavior')
  const sessionId = optionalString('session_id')
  const startedAt = requiredString('started_at')
  const startedAtPrecise = optionalString('started_at_precise')
  const completedAt = optionalString('completed_at')
  const status = requiredString('status')
  const outcome = optionalString('outcome')
  const headSha = optionalString('head_sha')
  const expectedHead = optionalString('expected_head')
  const source = optionalString('source')
  const correlationId = optionalString('correlation_id')
  const action = optionalString('action')
  const error = optionalString('error') || ''
  const preflightFailed = status === 'failed'
    && action === 'not_started'
    && outcome === 'preflight_failed'
    && headSha === null
  if (!/^[0-9a-f]{32}$/.test(id)
    || (prId !== null && !/^[1-9][0-9]*$/.test(prId))
    || (repo !== null && !/^[^/\s]+(?:\/[^/\s]+)?$/.test(repo))
    || (actor !== null
      && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(actor))
    || !Number.isFinite(Date.parse(startedAt))
    || (startedAtPrecise !== null && !Number.isFinite(Date.parse(startedAtPrecise)))
    || (completedAt !== null && !Number.isFinite(Date.parse(completedAt)))
    || !['clean', 'changes_requested', 'approved', 'superseded', 'preflight_failed', null].includes(outcome)
    || (headSha !== null && !/^[0-9a-f]{40}$/.test(headSha))
    || (expectedHead !== null && !/^[0-9a-f]{40}$/.test(expectedHead))
    || !['reviewed_clean', 'requested_changes', 'approved', 'not_started', null].includes(action)
    || ((action === 'not_started' || outcome === 'preflight_failed') && !preflightFailed)
    || (source !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(source))
    || (correlationId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(correlationId))) {
    throw new Error(`agent-interface log row ${index} violates the schema`)
  }
  if (source?.startsWith('poise:')) {
    if (!actor || !expectedHead || !correlationId || !behavior
      || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !prId) {
      throw new Error(`agent-interface log row ${index} has incomplete Poise provenance`)
    }
    if (status === 'completed' && (!completedAt || !action || !outcome || !headSha)) {
      throw new Error(`agent-interface log row ${index} has incomplete terminal outcome`)
    }
    if (status === 'failed' && !error) {
      throw new Error(`agent-interface log row ${index} has no terminal error`)
    }
    if (status === 'superseded'
      && (!completedAt || outcome !== 'superseded' || !headSha || action !== null)) {
      throw new Error(`agent-interface log row ${index} has incomplete superseded outcome`)
    }
  }
  return {
    id,
    pr_id: prId,
    repo,
    actor,
    model: requiredString('model'),
    behavior,
    session_id: sessionId,
    prompt: requiredString('prompt'),
    started_at: startedAt,
    started_at_precise: startedAtPrecise,
    completed_at: completedAt,
    time_elapsed: requiredString('time_elapsed'),
    status,
    outcome: outcome as LogEntry['outcome'],
    head_sha: headSha,
    expected_head: expectedHead,
    source,
    correlation_id: correlationId,
    action: action as LogEntry['action'],
    response: optionalString('response'),
    error,
  }
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
export async function triggerPrReview(
  prUrl: string,
): Promise<{ ok: true, source: string, correlationId: string }> {
  const m = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url')
  const [, owner, repo, num] = m
  const actor = getReviewAgentUsername()
  const repoFullName = `${owner}/${repo}`
  await claudeAuth.requireReady()
  const pwd = await localCheckoutPath(owner, repo)
  const expectedHead = await getHeadSha(repoFullName, Number(num))
  const source = 'poise:manual-review'
  const correlationId = randomUUID()

  await claudeAuth.requireReady()
  await spawnDetached(CLI, [
    '--pr-review',
    `#${num}`,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    correlationId,
    '--pwd',
    pwd,
  ], {
    cwd: agentCwd(),
    env: claudeSubscriptionEnvironment(),
    onExit: (result) => { claudeAuth.observeProcessFailure(result) },
  })
  return { ok: true, source, correlationId }
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
}): Promise<{ ok: true, source: string, correlationId: string }> {
  const behavior = String(input.behavior || '')
  const repo = String(input.repo || '')
  const prId = String(input.pr_id || '')
  if (!repo.includes('/'))   throw new Error('repo must be owner/name')
  if (!/^\d+$/.test(prId))   throw new Error('pr_id must be a positive integer')

  let flag: string
  if (behavior === 'pr_review')       flag = '--pr-review'
  else if (behavior === 'pr_approve') flag = '--pr-approve'
  else throw new Error(`behavior "${behavior}" is not replayable`)

  await claudeAuth.requireReady()
  const [owner, repoName] = repo.split('/', 2)
  const pwd = await localCheckoutPath(owner, repoName)
  const actor = getReviewAgentUsername()
  const expectedHead = await getHeadSha(repo, Number(prId))
  const source = 'poise:replay'
  const correlationId = randomUUID()
  await claudeAuth.requireReady()
  await spawnDetached(CLI, [
    flag,
    `#${prId}`,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    correlationId,
    '--pwd',
    pwd,
  ], {
    cwd: agentCwd(),
    env: claudeSubscriptionEnvironment(),
    onExit: (result) => { claudeAuth.observeProcessFailure(result) },
  })
  return { ok: true, source, correlationId }
}
