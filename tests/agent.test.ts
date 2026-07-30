import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
}))

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

import { fetchAgentLogs } from '../server/agent'

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a'.repeat(32),
    pr_id: '12',
    repo: 'owner/repo',
    actor: 'bit-mis',
    model: 'opus',
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
