import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  spawnDetached: vi.fn(),
  authStatus: 'authenticated',
  requireAuth: vi.fn(),
  observeAuthFailure: vi.fn(),
  lockContention: false,
}))

vi.mock('../server/process', () => ({
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  claudeSubscriptionEnvironment: () => ({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CLI: '/poise/claude-subscription',
  }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: mocks.authStatus }),
    requireReady: mocks.requireAuth,
    observeProcessFailure: mocks.observeAuthFailure,
  },
}))
vi.mock('../server/process-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/process-lock')>()
  return {
    ...actual,
    withProcessLock: async <T>(
      options: import('../server/process-lock').ProcessLockOptions,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (mocks.lockContention) {
        const message = options.timeoutMessage || 'timed out waiting for process lock'
        throw options.errorFactory?.(message, new Error('SQLITE_BUSY')) ?? new Error(message)
      }
      return await actual.withProcessLock(options, operation)
    },
  }
})

const pr = {
  repo: 'Vaquum/poise-test',
  number: 17,
  url: 'https://github.com/Vaquum/poise-test/pull/17',
  status: 'open',
  author: 'poise-user',
}
const HEAD_SHA = 'a'.repeat(40)
const NEXT_HEAD_SHA = 'd'.repeat(40)
let listedPrs = [pr]

let tempRoot = ''
let database: typeof import('../server/db') | null = null
let behaviors: typeof import('../server/behaviors') | null = null
let agentLogs: Array<Record<string, unknown>> = []

async function loadModules() {
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  behaviors = await import('../server/behaviors')
  return { database, behaviors }
}

async function restartModules() {
  await behaviors?.stopBehaviorsRuntime()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  vi.resetModules()
  return loadModules()
}

interface ReviewActivityFixture {
  requestedReviewers?: string[]
  activeChangeRequestAuthors?: string[]
  unresolvedConversationCount?: number
  unresolvedConversationAuthors?: string[]
  headSha?: string
  state?: string
  draft?: boolean
  latestActivityAt?: string | null
  reviewerLatestState?: string | null
  reviewerLatestCommit?: string | null
}

function arrangeCli(
  changesAddressed = false,
  failCheckout = false,
  reviewActivity: ReviewActivityFixture = {},
): void {
  mocks.runFile.mockImplementation(async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (command === 'github-datastore') {
      if (args[0] === 'health') {
        return {
          stdout: JSON.stringify({
            action: 'health',
            status: 'healthy',
            healthy: true,
            database: join(tempRoot, 'github.sqlite'),
            max_age_seconds: 120,
            age_seconds: 1,
            last_sync_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
            checked_at: new Date().toISOString(),
          }),
          stderr: '',
        }
      }
      return { stdout: JSON.stringify(listedPrs), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      if (failCheckout) throw new Error('checkout unavailable')
      return {
        stdout: JSON.stringify({
          action: 'local_checkout_path',
          repository: `${args[1]}/${args[2]}`,
          path: tempRoot,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--head-sha') {
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return {
        stdout: JSON.stringify({
          action: 'head_sha',
          repository,
          pull_number: pullNumber,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--requested-changes-addressed') {
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return {
        stdout: JSON.stringify({
          action: 'requested_changes_addressed',
          repository,
          pull_number: pullNumber,
          username: args[args.indexOf('--username') + 1],
          status: changesAddressed,
          has_change_request: changesAddressed,
          reviewer_latest_state: changesAddressed ? 'CHANGES_REQUESTED' : null,
          reviewer_latest_commit: changesAddressed ? HEAD_SHA : null,
          latest_request_at: changesAddressed ? '2026-07-10T10:00:00Z' : null,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
          commits_after_request: changesAddressed ? 1 : 0,
          author_commits_after_request: changesAddressed ? 1 : 0,
          author_inline_replies_after_request: 0,
          response_count: changesAddressed ? 1 : 0,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--review-activity-since') {
      const reviewer = args[args.indexOf('--username') + 1].toLowerCase()
      const requested = (reviewActivity.requestedReviewers || [])
        .some((login) => login.toLowerCase() === reviewer)
      return {
        stdout: JSON.stringify({
          action: 'review_activity_since',
          repository: pr.repo,
          pull_number: pr.number,
          username: reviewer,
          state: reviewActivity.state ?? 'OPEN',
          draft: reviewActivity.draft ?? false,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
          reviewer_requested: requested,
          active_change_request_authors: reviewActivity.activeChangeRequestAuthors ?? [],
          unresolved_conversation_count: reviewActivity.unresolvedConversationCount ?? 0,
          unresolved_conversation_authors: reviewActivity.unresolvedConversationAuthors ?? [],
          reviewer_latest_state: reviewActivity.reviewerLatestState ?? null,
          reviewer_latest_commit: reviewActivity.reviewerLatestCommit ?? null,
          reviewer_change_requests_since: 0,
          reviewer_approvals_since: 0,
          latest_activity_at: reviewActivity.latestActivityAt ?? null,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      return {
        stdout: JSON.stringify({
          ready_except_conversations: false,
          action: 'resolved_nonblocking_conversations_if_ready',
          repository: pr.repo,
          pull_number: pr.number,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
          reviewer_approved_current_head: false,
          changes_requested: false,
          statuses_green: false,
          checks_green: false,
          checks_present: false,
          resolved_count: 0,
          unresolved_count: 0,
          latest_reviews: {},
          conversations: [],
        }),
        stderr: '',
      }
    }
    if (command === 'agent-interface' && args[0] === '--logs') {
      return { stdout: JSON.stringify(agentLogs), stderr: '' }
    }
    throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
  })
}

function agentLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const behavior = String(overrides.behavior || 'pr_review')
  const completed = overrides.status === 'completed'
  return {
    id: 'f'.repeat(32),
    pr_id: String(pr.number),
    repo: pr.repo,
    actor: 'review-bot',
    model: 'opus-4.7-max',
    behavior,
    session_id: null,
    prompt: '',
    started_at: new Date().toISOString(),
    started_at_precise: new Date().toISOString(),
    completed_at: completed ? new Date().toISOString() : null,
    time_elapsed: '1s',
    status: 'running',
    outcome: null,
    head_sha: null,
    expected_head: HEAD_SHA,
    source: behavior === 'pr_review' ? 'poise:review-new-prs' : 'poise:approve-prs',
    correlation_id: 'correlation-missing',
    action: null,
    response: null,
    error: '',
    ...overrides,
  }
}

function datastoreHealthOutput(): { stdout: string, stderr: string } {
  return {
    stdout: JSON.stringify({
      action: 'health',
      status: 'healthy',
      healthy: true,
      database: join(tempRoot, 'github.sqlite'),
      max_age_seconds: 120,
      age_seconds: 1,
      last_sync_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    }),
    stderr: '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function recordCompletedInitialReview(
  db: typeof import('../server/db'),
  options: {
    target?: string
    completedAt?: string
    headSha?: string
    outcome?: 'clean' | 'changes_requested'
    callId?: string
  } = {},
): void {
  const target = options.target ?? `${pr.repo}#${pr.number}`
  const claimId = db.claimSeenOwned('review-new-prs', target)
  if (!claimId) throw new Error('could not arrange initial review claim')
  const marked = db.markBehaviorLaunchIntentOwned({
    key: 'review-new-prs',
    target,
    claimId,
    launchBehavior: 'pr_review',
    repo: pr.repo,
    pr: pr.number,
    requestedAt: new Date().toISOString(),
    expectedHead: options.headSha ?? HEAD_SHA,
    actor: 'review-bot',
    source: 'poise:review-new-prs',
    correlationId: claimId,
  })
  const callId = options.callId ?? 'c'.repeat(32)
  const linked = db.linkBehaviorLaunchCallOwned('review-new-prs', target, claimId, callId)
  const completed = db.completeReviewLaunchOwned({
    key: 'review-new-prs',
    target,
    claimId,
    outcome: options.outcome ?? 'clean',
    completedAt: options.completedAt
      ?? new Date(Date.now() - (10 * 60_000) - 1).toISOString(),
    headSha: options.headSha ?? HEAD_SHA,
  })
  if (!marked || !linked || !completed) {
    throw new Error('could not arrange completed initial review')
  }
}

async function launchReviewBeforeCrash() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  await loaded.behaviors.runEnabledBehaviorsOnce()

  const target = `${pr.repo}#${pr.number}`
  const requestedAt = new Date(Date.now() - 10_000).toISOString()
  loaded.database.db.prepare(`
    UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
    WHERE key = 'review-new-prs' AND target = ?
  `).run(requestedAt, Date.now() - 1, target)
  const launch = loaded.database.db.prepare(`
    SELECT
      launch_correlation_id AS correlationId,
      launch_expected_head AS expectedHead,
      launch_actor AS actor,
      launch_source AS source
    FROM behavior_seen
    WHERE key = 'review-new-prs' AND target = ?
  `).get(target) as {
    correlationId: string
    expectedHead: string
    actor: string
    source: string
  }
  return { ...loaded, target, requestedAt, ...launch }
}

async function launchApprovalBeforeCrash() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
  await loaded.behaviors.runEnabledBehaviorsOnce()

  const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${HEAD_SHA}`
  const requestedAt = new Date(Date.now() - 10_000).toISOString()
  loaded.database.db.prepare(`
    UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
    WHERE key = 'approve-prs' AND target = ?
  `).run(requestedAt, Date.now() - 1, target)
  const launch = loaded.database.db.prepare(`
    SELECT
      launch_correlation_id AS correlationId,
      launch_expected_head AS expectedHead,
      launch_actor AS actor,
      launch_source AS source
    FROM behavior_seen
    WHERE key = 'approve-prs' AND target = ?
  `).get(target) as {
    correlationId: string
    expectedHead: string
    actor: string
    source: string
  }
  return { ...loaded, target, requestedAt, ...launch }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-behavior-test-'))
  mocks.runFile.mockReset()
  mocks.spawnDetached.mockReset()
  mocks.authStatus = 'authenticated'
  mocks.requireAuth.mockReset().mockImplementation(() => {
    if (mocks.authStatus !== 'authenticated') throw new Error('Claude authentication required')
  })
  mocks.observeAuthFailure.mockReset()
  mocks.lockContention = false
  listedPrs = [pr]
  agentLogs = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  await behaviors?.stopBehaviorsRuntime()
  vi.useRealTimers()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('behavior launch claims', () => {
  it('pauses Claude-backed behaviors before external work and resumes once authenticated', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    mocks.authStatus = 'reauth_required'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('pauses approval work and resumes it once authenticated', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    mocks.authStatus = 'reauth_required'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('approves a requested clean review after ten quiet minutes without a CI gate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const completedAt = '2026-07-15T11:49:59.000Z'
    arrangeCli(false, false, {
      requestedReviewers: ['other-reviewer', 'REVIEW-BOT'],
      headSha: NEXT_HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt, headSha: NEXT_HEAD_SHA })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-approve', `#${pr.number}`]),
      expect.any(Object),
    )
    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      [
        '--review-activity-since',
        `#${pr.number}`,
        '--username',
        'review-bot',
        '--since',
        completedAt,
        '--token-user',
        'review-bot',
      ],
      expect.objectContaining({ cwd: expect.stringContaining('Vaquum/poise-test') }),
    )
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'gh')).toBe(false)

    const onExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    onExit({ code: 0, signal: null })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.claimSeen(
      'approve-prs',
      `${pr.repo}#${pr.number}@quiet=2026-07-15T11:49:59.000Z/head=${NEXT_HEAD_SHA}`,
    )).toBe(false)
  })

  it('moves the quiet window forward when new PR activity appears', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['review-bot'],
      latestActivityAt: '2026-07-15T11:55:00.000Z',
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-07-15T12:05:00.000Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('does not approve a clean review while a review conversation is unresolved', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, { unresolvedConversationCount: 1 })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('does not approve addressed changes while another reviewer owns an unresolved conversation', async () => {
    arrangeCli(true, false, {
      unresolvedConversationCount: 2,
      unresolvedConversationAuthors: ['review-bot', 'other-reviewer'],
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('waits ten minutes after another reviewer dismisses a change request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['review-bot'],
      activeChangeRequestAuthors: ['zero-bang'],
      latestActivityAt: '2026-07-15T11:45:00.000Z',
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.activeChangeRequestAuthors = []
    activity.latestActivityAt = '2026-07-15T12:00:00.000Z'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-07-15T12:10:00.000Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('requires an open non-draft PR but not a separate review request', async () => {
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['other-reviewer'],
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    mocks.spawnDetached.mockClear()
    db.clearSeen('approve-prs')

    activity.draft = true
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.draft = false
    activity.state = 'CLOSED'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.state = 'OPEN'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('does not treat a changes-requested review outcome as clean', async () => {
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(mocks.runFile.mock.calls.some(
      ([command, args]) => command === 'github-interface'
        && args[0] === '--review-activity-since',
    )).toBe(false)
  })

  it('never overlaps initial review and approval for the same PR', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T11:40:00.000Z'))
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_approve_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-review')
    expect(mocks.runFile.mock.calls.some(
      ([command, args]) => command === 'github-interface'
        && args[0] === '--review-activity-since',
    )).toBe(false)

    const reviewRow = db.db.prepare(`
      SELECT
        launch_requested_at AS requestedAt,
        launch_correlation_id AS correlationId,
        launch_expected_head AS expectedHead,
        launch_actor AS actor,
        launch_source AS source
      FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = ?
    `).get(`${pr.repo}#${pr.number}`) as {
      requestedAt: string
      correlationId: string
      expectedHead: string
      actor: string
      source: string
    }
    const reviewExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    reviewExit({ code: 0, signal: null })
    agentLogs = [agentLog({
      id: 'd'.repeat(32),
      started_at: reviewRow.requestedAt,
      started_at_precise: new Date(Date.parse(reviewRow.requestedAt) + 1).toISOString(),
      completed_at: '2026-07-15T11:45:00.000Z',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      expected_head: reviewRow.expectedHead,
      actor: reviewRow.actor,
      source: reviewRow.source,
      correlation_id: reviewRow.correlationId,
      response: 'reviewed-clean',
    })]
    vi.setSystemTime(new Date('2026-07-15T11:45:00.000Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date('2026-07-15T11:55:00.000Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('--pr-approve')
  })

  it('does not infer a clean outcome from a legacy process exit', async () => {
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    const target = `${pr.repo}#${pr.number}@legacy-head`
    const claimId = db.claimSeenOwned('review-new-prs', target)!
    db.markBehaviorLaunchIntentOwned({
      key: 'review-new-prs',
      target,
      claimId,
      launchBehavior: 'pr_review',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:review-new-prs',
      correlationId: claimId,
    })
    db.completeSeenOwned('review-new-prs', target, claimId)

    await runtime.setEnabled('review-new-prs', false)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('coalesces sibling-process lock contention without opening a breaker', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.lockContention = true

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.lockContention = false
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('requires a fresh live auth gate before a scheduled worker launch', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.requireAuth.mockImplementation((options?: { liveWithinMs?: number }) => {
      if (options?.liveWithinMs === 60_000) {
        mocks.authStatus = 'degraded'
        throw new Error('fresh Claude canary failed')
      }
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.requireAuth).toHaveBeenCalledWith({ liveWithinMs: 60_000 })
    expect(mocks.authStatus).toBe('degraded')
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('keeps one durable in-flight worker per scheduled behavior', async () => {
    const secondPr = {
      repo: 'Vaquum/poise-second',
      number: 18,
      url: 'https://github.com/Vaquum/poise-second/pull/18',
      status: 'open',
      author: 'poise-user',
    }
    listedPrs = [pr, secondPr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-review', `#${pr.number}`]),
      expect.any(Object),
    )
  })

  it('keeps GitHub-only unblocking active during a Claude auth outage', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    mocks.authStatus = 'reauth_required'

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      [
        '--resolve-nonblocking-conversations-if-ready',
        `#${pr.number}`,
        '--username',
        'review-bot',
        '--expected-head',
        HEAD_SHA,
        '--token-user',
        'review-bot',
      ],
      expect.any(Object),
    )
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('preserves the startup ledger and catches a PR opened during downtime', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.authStatus = 'reauth_required'

    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
  })

  it('migrates v2 in place and reviews a PR first seen during downtime', async () => {
    const downtimePr = {
      repo: 'Vaquum/downtime-test',
      number: 18,
      url: 'https://github.com/Vaquum/downtime-test/pull/18',
      status: 'open',
      author: 'poise-user',
    }
    listedPrs = [pr, downtimePr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '2')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}@legacy-head`)
    db.recordSeen('review-new-prs', '__snapshot_v2__')

    await runtime.runEnabledBehaviorsOnce()

    expect(db.getMeta('behavior_review_new_prs_keyver')).toBe('3')
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${downtimePr.number}`)
  })

  it('takes the anti-flood snapshot only when the startup ledger is missing', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    mocks.authStatus = 'reauth_required'

    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await vi.waitFor(() => expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true))
    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
  })

  it('rearms the scheduler while a behavior scan is still busy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.100Z'))
    const scan = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[]) => {
      if (command === 'github-datastore' && args[0] === 'health') {
        return Promise.resolve(datastoreHealthOutput())
      }
      if (command === 'github-datastore' && args[0] === 'view') return scan.promise
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    try {
      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
      await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledTimes(2))
      const firstTick = runtime.getBehaviorsRuntimeHealth().lastTickAt
      expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual([
        expect.objectContaining({ behavior: 'resolve-unblocking' }),
      ])

      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
      expect(runtime.getBehaviorsRuntimeHealth().lastTickAt).not.toBe(firstTick)
      expect(mocks.runFile).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.getBehaviorsRuntimeHealth().status).toBe('degraded')
    } finally {
      scan.resolve({ stdout: '[]', stderr: '' })
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('retries a failed scan immediately so dependency recovery clears health', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    mocks.runFile.mockRejectedValue(new Error('502 Bad Gateway'))
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded',
      failures: [{
        behavior: 'resolve-unblocking',
        kind: 'operation',
        consecutiveFailures: 1,
        lastFailureAt: '2026-07-15T12:00:00.000Z',
        nextRetryAt: '2026-07-15T12:01:00.000Z',
      }],
    })

    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [],
    })
  })

  it('clears a recovered scan failure when the scan launches a worker', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta('behavior_review_new_prs_failure', JSON.stringify({
      kind: 'operation',
      consecutiveFailures: 4,
      lastFailureAtMs: Date.now(),
      nextRetryAtMs: Date.now() + 3_600_000,
    }))

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('preserves an existing breaker when shutdown aborts a behavior scan', async () => {
    mocks.runFile.mockImplementation(async (
      _command: string,
      _args: string[],
      options?: { signal?: AbortSignal },
    ) => await new Promise((_, reject) => {
      const signal = options?.signal
      if (!signal) return reject(new Error('missing operation signal'))
      const onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }))
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    db.setMeta('behavior_resolve_unblocking_failure', JSON.stringify({
      kind: 'worker',
      consecutiveFailures: 2,
      lastFailureAtMs: Date.now() - 120_000,
      nextRetryAtMs: Date.now() - 1,
    }))
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    const cycle = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledOnce())
    await runtime.stopBehaviorsRuntime()
    await cycle

    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'resolve-unblocking',
        kind: 'worker',
        consecutiveFailures: 2,
      }),
    ])
  })

  it('releases a review claim when the detached launch fails', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockRejectedValue(new Error('missing agent-interface'))
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(true)
  })

  it('retains the claim for an intentional review skip', async () => {
    arrangeCli(true)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
  })

  it('retains a review claim when an accepted worker exits until its durable result arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    const target = `${pr.repo}#${pr.number}`
    expect(db.claimSeen('review-new-prs', target)).toBe(false)
    const options = mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }
    options.onExit({ code: 7, signal: null })
    expect(db.hasSeen('review-new-prs', target)).toBe(true)
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([
      expect.objectContaining({
        target,
        launchError: 'worker exited exit 7; awaiting durable agent result',
      }),
    ])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('does not let an old worker failure release a newer claim generation', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    const target = `${pr.repo}#${pr.number}`
    const oldExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    db.clearSeen('review-new-prs')
    const newerOwner = db.claimSeenOwned('review-new-prs', target)
    expect(newerOwner).toEqual(expect.any(String))

    oldExit({ code: 7, signal: null })

    expect(db.claimSeen('review-new-prs', target)).toBe(false)
    expect(db.releaseSeenOwned('review-new-prs', target, newerOwner!)).toBe(true)
  })

  it('turns a successful worker lease into a terminal seen marker', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    const target = `${pr.repo}#${pr.number}`
    const onExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    onExit({ code: 0, signal: null })

    expect(db.claimSeenOwned('review-new-prs', target, 1)).toBeNull()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('releases an approval claim when pre-launch work fails', async () => {
    arrangeCli(true, true)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${HEAD_SHA}`
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('approve-prs', target)).toBe(true)
  })

  it('marks an empty snapshot so the first later PR triggers', async () => {
    listedPrs = []
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')

    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)

    listedPrs = [pr]
    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('snapshots every existing PR without per-head source calls', async () => {
    const secondPr = {
      repo: 'Vaquum/second-test',
      number: 18,
      url: 'https://github.com/Vaquum/second-test/pull/18',
      status: 'open',
      author: 'poise-user',
    }
    listedPrs = [pr, secondPr]
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')

    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
    expect(db.claimSeen('review-new-prs', `${secondPr.repo}#${secondPr.number}`)).toBe(false)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    expect(mocks.runFile.mock.calls.some(
      ([command, args]) => command === 'github-interface' && args[0] === '--head-sha',
    )).toBe(false)
  })

  it('links a unique running review call after restart and renews without duplicate launch', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = 'a'.repeat(32)
    agentLogs = [agentLog({
      id: callId,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'running',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      lease_until: expect.any(Number),
      launch_call_id: callId,
      launch_error: null,
    })
    const leaseUntil = db.db.prepare(`
      SELECT lease_until FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).pluck().get(launched.target) as number
    expect(leaseUntil).toBeGreaterThan(Date.now())
  })

  it('caps an unknown worker state by local launch time despite a future timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const requestedAt = new Date(Date.now() - (2 * 60 * 60_000) - 10_000).toISOString()
    launched.database.db.prepare(`
      UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
      WHERE key = 'review-new-prs' AND target = ?
    `).run(requestedAt, Date.now() - 1, launched.target)
    agentLogs = [agentLog({
      id: '9'.repeat(32),
      started_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      started_at_precise: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      status: 'unexpected',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.observeAuthFailure).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        target: launched.target,
        error: expect.stringContaining('exceeded 7200000ms running limit'),
      }),
    ])
  })

  it('turns a completed approval found after restart into a terminal claim', async () => {
    const launched = await launchApprovalBeforeCrash()
    const callId = 'b'.repeat(32)
    agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      completed_at: new Date(Date.parse(launched.requestedAt) + 2_000).toISOString(),
      status: 'completed',
      action: 'approved',
      outcome: 'approved',
      head_sha: launched.expectedHead,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
      response: 'approved',
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'approve-prs' AND target = ?
    `).get(launched.target)).toEqual({
      claim_id: '',
      lease_until: null,
      launch_call_id: callId,
      launch_error: null,
    })
  })

  it('dead-letters a failed recovered review call without duplicate retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    agentLogs = [agentLog({
      id: 'c'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'model unavailable',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        target: launched.target,
        error: 'model unavailable',
      }),
    ])
  })

  it('releases a superseded review without degradation and reviews the current head', async () => {
    const launched = await launchReviewBeforeCrash()
    agentLogs = [agentLog({
      id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'pull-request head changed during behavior execution',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
  })

  it('waits through bounded registration grace before retrying a missing call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, launch_error FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      launch_error: 'awaiting agent call registration',
    })

    db.db.prepare(`
      UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
      WHERE key = 'review-new-prs' AND target = ?
    `).run(
      new Date(Date.now() - runtime.BEHAVIOR_REGISTRATION_GRACE_MS - 1_000).toISOString(),
      Date.now() - 1,
      launched.target,
    )
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('retains an ambiguous post-watermark review registration without retrying', async () => {
    const launched = await launchReviewBeforeCrash()
    const after = Date.parse(launched.requestedAt) + 1_000
    agentLogs = [
      agentLog({
        id: 'd'.repeat(32),
        started_at: new Date(after).toISOString(),
        started_at_precise: new Date(after).toISOString(),
        status: 'running',
        correlation_id: launched.correlationId,
      }),
      agentLog({
        id: 'e'.repeat(32),
        started_at: new Date(after + 1_000).toISOString(),
        started_at_precise: new Date(after + 1_000).toISOString(),
        completed_at: new Date(after + 2_000).toISOString(),
        status: 'completed',
        action: 'reviewed_clean',
        outcome: 'clean',
        head_sha: launched.expectedHead,
        response: 'clean',
        correlation_id: launched.correlationId,
      }),
    ]

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: '',
      lease_until: null,
      launch_call_id: null,
      launch_error: expect.stringContaining('ambiguous correlation id matched'),
    })
  })

  it('waits for an in-flight tick to stop before acknowledging disable', async () => {
    const scan = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[]) => {
      if (command === 'github-datastore' && args[0] === 'health') {
        return Promise.resolve(datastoreHealthOutput())
      }
      if (command === 'github-datastore' && args[0] === 'view') return scan.promise
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledTimes(2))
    const disable = runtime.setEnabled('review-new-prs', false)
    let disabled = false
    void disable.then(() => { disabled = true })
    await Promise.resolve()
    expect(disabled).toBe(false)

    scan.resolve({ stdout: JSON.stringify(listedPrs), stderr: '' })
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(false)
  })

  it('does not launch after disable during the final auth gate', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const finalGate = deferred<void>()
    mocks.requireAuth
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(finalGate.promise)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.requireAuth).toHaveBeenCalledTimes(2))
    const disable = runtime.setEnabled('review-new-prs', false)
    finalGate.resolve(undefined)
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
  })
})
