import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  models: {} as Record<string, { default: string, fallback: string }>,
}))

vi.mock('../server/settings', () => ({ getModelSettings: () => mocks.models }))

vi.mock('../server/process', () => ({
  claudeSubscriptionEnvironment: vi.fn(),
  runFile: mocks.runFile,
  spawnDetached: vi.fn(),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    observeProcessFailure: vi.fn(),
    requireReady: vi.fn(),
  },
}))
vi.mock('../server/gh', () => ({
  getHeadSha: vi.fn(),
  getReviewAgentUsername: vi.fn(),
  localCheckoutPath: vi.fn(),
}))

import { fetchAgentLogs, fetchAgentReasoning } from '../server/agent'
import { CATALOG_STDOUT } from './model-catalog-fixture'

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a'.repeat(32),
    pr_id: '12',
    repo: 'owner/repo',
    actor: 'bit-mis',
    model: 'opus-5-xhigh',
    behavior: 'pr_review',
    session_id: null,
    prompt: '',
    started_at: '2026-07-17T09:00:00.000Z',
    started_at_precise: '2026-07-17T09:00:00.000Z',
    completed_at: '2026-07-17T09:01:00.000Z',
    time_elapsed: '1m',
    status: 'completed',
    outcome: null,
    head_sha: null,
    expected_head: null,
    source: null,
    correlation_id: null,
    action: null,
    response: null,
    error: '',
    ...overrides,
  }
}

describe('agent log compatibility', () => {
  beforeEach(() => mocks.runFile.mockReset())

  // Fields agent-interface added over time — expected_head, source,
  // correlation_id, action — are simply absent from rows written before them.
  // Only an explicit null was accepted, so `undefined` failed validation, and
  // because the batch is validated as a unit one such row rejected all of
  // them: with the oldest row in this log dating to May, /api/agent-logs
  // answered 502 and Swarm rendered nothing at all.
  it('reads a row written before a field existed, and does not fail its batch', async () => {
    const legacy = logRow({ behavior: null, pr_id: null, repo: null, actor: 'bit-mis' })
    for (const field of ['expected_head', 'source', 'correlation_id', 'action', 'outcome', 'head_sha', 'session_id']) {
      delete legacy[field]
    }
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([legacy, logRow({ id: 'b'.repeat(32) })]),
      stderr: '',
    })
    const rows = await fetchAgentLogs()
    expect(rows).toHaveLength(2)
    // Absent reads as absent, not as a violation.
    expect(rows.find((r) => r.id === 'a'.repeat(32))).toMatchObject({
      expected_head: null, source: null, correlation_id: null, action: null,
      outcome: null, head_sha: null, session_id: null,
    })
    // And the well-formed row beside it still arrives.
    expect(rows.some((r) => r.id === 'b'.repeat(32))).toBe(true)
  })

  it('keeps a historical unqualified repository row readable', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({ repo: 'legacy-repo' })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      repo: 'legacy-repo',
      source: null,
    }])
  })

  it('rejects an unqualified repository in a Poise launch contract', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        repo: 'legacy-repo',
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        head_sha: 'b'.repeat(40),
        correlation_id: 'correlation-1',
        action: 'reviewed_clean',
        outcome: 'clean',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).rejects.toThrow(/incomplete Poise provenance/)
  })

  it('accepts a running Poise call before it has a terminal error', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        status: 'running',
        completed_at: null,
        error: null,
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        correlation_id: 'correlation-1',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      status: 'running',
      error: '',
      source: 'poise:review-new-prs',
    }])
  })

  it('accepts a typed superseded Poise call', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        status: 'superseded',
        outcome: 'superseded',
        head_sha: 'c'.repeat(40),
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        correlation_id: 'correlation-1',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      status: 'superseded',
      outcome: 'superseded',
      head_sha: 'c'.repeat(40),
    }])
  })
})

describe('manual review model selection', () => {
  beforeEach(async () => {
    mocks.models = {}
    mocks.runFile.mockReset().mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    const gh = await import('../server/gh')
    vi.mocked(gh.getHeadSha).mockResolvedValue('a'.repeat(40))
    vi.mocked(gh.getReviewAgentUsername).mockReturnValue('bit-mis')
    vi.mocked(gh.localCheckoutPath).mockResolvedValue('/repo')
    const { spawnDetached } = await import('../server/process')
    vi.mocked(spawnDetached).mockReset().mockResolvedValue(undefined)
    const { claudeAuth } = await import('../server/claude-auth')
    vi.mocked(claudeAuth.requireReady).mockReset().mockResolvedValue(undefined)
  })

  it('launches the catalog default with its recovery model when nothing is chosen', async () => {
    const { triggerPrReview, replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const { claudeAuth } = await import('../server/claude-auth')
    await triggerPrReview('https://github.com/o/r/pull/12')
    await replayAgentJob({ behavior: 'pr_approve', repo: 'o/r', pr_id: 12 })
    expect(spawnDetached).toHaveBeenCalledTimes(2)
    for (const [, args] of vi.mocked(spawnDetached).mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'opus-5-xhigh', '--recovery-model', 'gpt-6-astra-ultra', '--actor', 'bit-mis', '--expected-head', 'a'.repeat(40)]))
    }
    expect(claudeAuth.requireReady).toHaveBeenCalledTimes(4)
  })

  it('launches the chosen default and fallback, and skips the Claude gate for Codex', async () => {
    const choice = { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' }
    mocks.models = { pr_review: choice, pr_approve: choice }
    const { triggerPrReview, replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const { claudeAuth } = await import('../server/claude-auth')
    await triggerPrReview('https://github.com/o/r/pull/12')
    await replayAgentJob({ behavior: 'pr_approve', repo: 'o/r', pr_id: 12 })
    for (const [, args] of vi.mocked(spawnDetached).mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh']))
    }
    expect(claudeAuth.requireReady).not.toHaveBeenCalled()
  })

  it('falls back to the catalog default when the chosen model was retired', async () => {
    mocks.models = { pr_review: { default: 'opus-4.8-max', fallback: 'gpt-6-astra-ultra' } }
    const { triggerPrReview } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    await triggerPrReview('https://github.com/o/r/pull/12')
    expect(vi.mocked(spawnDetached).mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'opus-5-xhigh']))
  })

  it('does not launch against Caller that cannot honor the selection', async () => {
    mocks.runFile.mockResolvedValue({ stdout: '{}', stderr: '' })
    const { triggerPrReview } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    await expect(triggerPrReview('https://github.com/o/r/pull/12')).rejects.toThrow(/Update Caller/)
    expect(spawnDetached).not.toHaveBeenCalled()
  })
})

describe('progress data does not determine review status', () => {
  const now = '2026-09-13T11:00:00.000Z'
  const progress = {
    version: 1, phase: 'waiting_provider', phase_started_at: now,
    heartbeat_at: now, last_provider_event_at: null, deadline_at: null,
    warning: null, events: [{ at: now, message: 'Waiting for provider' }],
  }

  it('preserves current progress and keeps rows from older Caller versions readable', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ progress }), logRow({ id: 'b'.repeat(32) }),
    ]), stderr: '' })
    const rows = await fetchAgentLogs()
    expect(rows[0].progress).toBeNull()
    expect(rows[1].progress).toEqual(progress)
  })

  it.each([
    { ...progress, version: 2 },
    { ...progress, heartbeat_at: 'invalid' },
    { ...progress, events: Array(21).fill({ at: now, message: 'event' }) },
    { ...progress, events: [{ at: now, message: 'x'.repeat(161) }] },
    { ...progress, phase: '__proto__' },
  ])('invalid observation data cannot hide the run or override its outcome', async (progress) => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow({ progress, status: 'completed', outcome: 'approved' })]), stderr: '' })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{ status: 'completed', outcome: 'approved', progress: null }])
  })
})


describe('stopping a run', () => {
  beforeEach(() => mocks.runFile.mockReset())
  it('asks Caller to stop the call and passes its answer through', async () => {
    const { stopAgentJob } = await import('../server/agent')
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ id: 'a'.repeat(32), stopped: true, status: 'failed', error_code: 'stopped' }), stderr: '' })
    await expect(stopAgentJob('A'.repeat(32))).resolves.toEqual({ id: 'a'.repeat(32), stopped: true, status: 'failed', error_code: 'stopped' })
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--stop', 'a'.repeat(32)], expect.objectContaining({ timeoutMs: 30_000 }))
  })
  it('refuses a malformed id before running anything, and an old Caller after', async () => {
    const { stopAgentJob } = await import('../server/agent')
    await expect(stopAgentJob('../etc')).rejects.toThrow('invalid agent call id')
    expect(mocks.runFile).not.toHaveBeenCalled()
    mocks.runFile.mockResolvedValue({ stdout: 'usage: agent-interface BEHAVIOR', stderr: '' })
    await expect(stopAgentJob('b'.repeat(32))).rejects.toThrow('Update Caller')
  })
})

describe('provider reasoning reads', () => {
  beforeEach(() => mocks.runFile.mockReset())
  it('reads only a full call id and bounds the CLI output', async () => {
    mocks.runFile.mockResolvedValue({ stdout: 'exposed reasoning' })
    await expect(fetchAgentReasoning('A'.repeat(32))).resolves.toMatchObject({ body: 'exposed reasoning' })
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--read-reasoning', 'a'.repeat(32)], expect.objectContaining({ maxOutputBytes: 512 * 1024 }))
    mocks.runFile.mockClear()
    for (const id of ['../secret', 'a'.repeat(8)]) await expect(fetchAgentReasoning(id)).rejects.toThrow('invalid agent call id')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})


describe('review policy compatibility', () => {
  it('rejects a Caller release without the bounded review policy or the catalog', async () => {
    const { reviewChoice } = await import('../server/review-model')
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    mocks.runFile.mockResolvedValue({ stdout: CATALOG_STDOUT.replace('"policy":"bounded-v1"', '"policy":"unbounded"'), stderr: '' })
    await expect(reviewChoice('pr_review')).rejects.toThrow('Update Caller')
    invalidateCatalog()
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ opus: 'opus-5-high', astra: 'gpt-6-astra-xhigh', policy: 'bounded-v1' }), stderr: '' })
    await expect(reviewChoice('pr_review')).rejects.toThrow('Update Caller')
  })
})

// An issue review has no pull-request head: its Poise rows carry none, finish
// as `commented`, and say which comments they posted. Before Poise knew the
// shape, one such row rejected the whole log — Swarm blank, reconciliation
// stalled for every behavior.
describe('issue review rows', () => {
  beforeEach(() => mocks.runFile.mockReset())

  function issueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return logRow({
      behavior: 'issue_review',
      repo: 'Vaquum/Origo',
      pr_id: '452',
      source: 'poise:review-new-issues',
      correlation_id: 'claim-1',
      expected_head: null,
      head_sha: null,
      ...overrides,
    })
  }

  it('reads running, commented and failed issue reviews with their receipts', async () => {
    const receipt = { issue: 'Vaquum/Origo#452', comment_id: 9, url: 'https://github.com/Vaquum/Origo/issues/452#issuecomment-9', author: 'bit-mis' }
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([
        issueRow({ id: 'a'.repeat(32), status: 'running', completed_at: null }),
        issueRow({ id: 'b'.repeat(32), status: 'completed', action: 'commented', outcome: 'commented', receipts: [receipt] }),
        issueRow({ id: 'c'.repeat(32), status: 'failed', error: 'GitHub 502', error_code: 'posting_failed', receipts: [receipt, { broken: true }] }),
        issueRow({ id: 'd'.repeat(32), status: 'failed', error: 'provider failed' }),
        issueRow({ id: 'e'.repeat(32), status: 'failed', error: 'crashed while posting', receipts: 'garbled' }),
      ]),
      stderr: '',
    })
    const rows = await fetchAgentLogs()
    const byId = (letter: string) => rows.find((row) => row.id === letter.repeat(32))!
    expect(byId('a').status).toBe('running')
    expect(byId('b')).toMatchObject({ action: 'commented', outcome: 'commented', receipts: [receipt] })
    // A receipt it cannot read is dropped, but posting still counts as begun.
    expect(byId('c').receipts).toEqual([receipt])
    expect(byId('d').receipts).toBeNull()
    expect(byId('e').receipts).toEqual([])
  })

  it('keeps the commented outcome to issue reviews and requires a terminal outcome', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({ action: 'commented', outcome: 'commented' })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).rejects.toThrow(/violates the schema/)
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([issueRow({ status: 'completed' })]), stderr: '' })
    await expect(fetchAgentLogs()).rejects.toThrow(/incomplete terminal outcome/)
  })

  it('replays an issue review with the Issue review default and no head or checkout', async () => {
    mocks.models = { issue_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }
    mocks.runFile.mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    const gh = await import('../server/gh')
    vi.mocked(gh.getReviewAgentUsername).mockReturnValue('bit-mis')
    const { spawnDetached } = await import('../server/process')
    vi.mocked(spawnDetached).mockReset().mockResolvedValue(undefined)
    const { replayAgentJob } = await import('../server/agent')
    const result = await replayAgentJob({ behavior: 'issue_review', repo: 'Vaquum/Origo', pr_id: '452' })
    expect(result.source).toBe('poise:replay')
    const [command, args] = vi.mocked(spawnDetached).mock.calls[0]
    expect(command).toBe('agent-interface')
    expect(args).toEqual(['--issue-review', 'Vaquum/Origo#452', '--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh',
      '--actor', 'bit-mis', '--source', 'poise:replay', '--correlation-id', result.correlationId])
    expect(gh.getHeadSha).not.toHaveBeenCalled()
    expect(gh.localCheckoutPath).not.toHaveBeenCalled()
  })
})
