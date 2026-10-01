import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// Reading Caller's local model catalog is not external work: no GitHub call,
// no launch. The pause assertions below ignore it.
function externalCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command, args]: any[]) => !(command === 'agent-interface' && args[0] === '--models'))
}

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
  draft: 0,
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
  database.setMeta('org', 'Vaquum')
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
  unresolvedLiveConversationCount?: number
  unresolvedConversationAuthors?: string[]
  unresolvedLiveConversationAuthors?: string[]
  headSha?: string
  state?: string
  draft?: boolean
  latestActivityAt?: string | null
  reviewerLatestState?: string | null
  reviewerLatestCommit?: string | null
  reviewerReviewsSince?: number
  // With ids, as github-interface reports them since Caller #39.
  reviewerReviewIdsSince?: number[]
  reviewerPendingReviews?: number
  resolveSuperseded?: boolean
  resolveUnresolvedCount?: number
  resolveBlockers?: string[]
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
    if (command === 'agent-interface' && args[0] === '--models') {
      return { stdout: CATALOG_STDOUT, stderr: '' }
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
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return {
        stdout: JSON.stringify({
          action: 'review_activity_since',
          repository,
          pull_number: pullNumber,
          username: reviewer,
          state: reviewActivity.state ?? 'OPEN',
          draft: reviewActivity.draft ?? false,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
          reviewer_requested: requested,
          active_change_request_authors: reviewActivity.activeChangeRequestAuthors ?? [],
          unresolved_conversation_count: reviewActivity.unresolvedConversationCount ?? 0,
          unresolved_outdated_conversation_count: Math.max(
            0,
            (reviewActivity.unresolvedConversationCount ?? 0)
              - (reviewActivity.unresolvedLiveConversationCount
                ?? reviewActivity.unresolvedConversationCount
                ?? 0),
          ),
          unresolved_live_conversation_count: reviewActivity.unresolvedLiveConversationCount
            ?? reviewActivity.unresolvedConversationCount
            ?? 0,
          unresolved_conversation_authors: reviewActivity.unresolvedConversationAuthors ?? [],
          unresolved_live_conversation_authors: reviewActivity.unresolvedLiveConversationAuthors
            ?? reviewActivity.unresolvedConversationAuthors
            ?? [],
          reviewer_latest_state: reviewActivity.reviewerLatestState ?? null,
          reviewer_latest_commit: reviewActivity.reviewerLatestCommit ?? null,
          reviewer_change_requests_since: 0,
          reviewer_approvals_since: 0,
          reviewer_reviews_since: reviewActivity.reviewerReviewIdsSince?.length ?? reviewActivity.reviewerReviewsSince ?? 0,
          ...(reviewActivity.reviewerReviewIdsSince
            ? { reviewer_reviews_since_items: reviewActivity.reviewerReviewIdsSince.map((id) => ({ id, node_id: `PRR_${id}`, state: 'COMMENTED', commit: HEAD_SHA, submitted_at: new Date().toISOString() })) }
            : {}),
          reviewer_pending_reviews: reviewActivity.reviewerPendingReviews ?? 0,
          latest_activity_at: reviewActivity.latestActivityAt ?? null,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      if (reviewActivity.resolveSuperseded) {
        return {
          stdout: JSON.stringify({
            action: 'resolved_nonblocking_conversations_if_ready',
            repository: pr.repo,
            pull_number: pr.number,
            outcome: 'superseded',
            head_sha: HEAD_SHA,
            current_head_sha: NEXT_HEAD_SHA,
          }),
          stderr: '',
        }
      }
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
          blockers: reviewActivity.resolveBlockers
            ?? ['reviewer_not_approved_current_head'],
          resolved_count: 0,
          unresolved_count: reviewActivity.resolveUnresolvedCount ?? 0,
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
    pull?: Pick<typeof pr, 'repo' | 'number'>
    target?: string
    completedAt?: string
    headSha?: string
    outcome?: 'clean' | 'changes_requested'
    callId?: string
  } = {},
): void {
  const pull = options.pull ?? pr
  const target = options.target ?? `${pull.repo}#${pull.number}`
  const claimId = db.claimSeenOwned('review-new-prs', target)
  if (!claimId) throw new Error('could not arrange initial review claim')
  const marked = db.markBehaviorLaunchIntentOwned({
    key: 'review-new-prs',
    target,
    claimId,
    launchBehavior: 'pr_review',
    repo: pull.repo,
    pr: pull.number,
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
    expect(externalCalls()).toEqual([])
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
    expect(externalCalls()).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('approves a requested clean review on the next scan without a CI gate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const completedAt = '2026-07-15T11:59:59.000Z'
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
      `${pr.repo}#${pr.number}@head=${NEXT_HEAD_SHA}`,
    )).toBe(false)
  })

  it('waits for a busy per-PR lock instead of silently starving an eligible approval', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)
    const blocker = db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 65_000)
    if (!blocker) throw new Error('could not arrange competing PR operation')
    setTimeout(() => db.releasePrOperationOwned(blocker), 25)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-approve')
  })

  it('waits for a busy per-PR lock before initial review', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    const blocker = db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 65_000)
    if (!blocker) throw new Error('could not arrange competing operation')
    setTimeout(() => db.releasePrOperationOwned(blocker), 25)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-review')
  })

  it('does not take a resolver mutation lock when there are no conversations', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    const claim = vi.spyOn(db, 'claimPrOperationOwned')
    await runtime.runEnabledBehaviorsOnce()
    expect(claim).not.toHaveBeenCalled()
    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')).toBe(false)
  })

  it('does not debounce recent PR activity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['review-bot'],
      latestActivityAt: '2026-07-15T11:59:59.000Z',
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('uses a completed approval as the basis for approving a later head', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      latestActivityAt: '2026-07-15T11:49:59.000Z',
      unresolvedConversationCount: 3,
      unresolvedConversationAuthors: ['review-bot'],
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    const target = `${pr.repo}#${pr.number}@quiet=prior/head=${HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)!
    expect(db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs',
      target,
      claimId,
      launchBehavior: 'pr_approve',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: '2026-07-15T11:39:00.000Z',
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:approve-prs',
      correlationId: claimId,
    })).toBe(true)
    expect(db.linkBehaviorLaunchCallOwned(
      'approve-prs',
      target,
      claimId,
      'b'.repeat(32),
    )).toBe(true)
    expect(db.completeBehaviorLaunchOwned({
      key: 'approve-prs',
      target,
      claimId,
      outcome: 'approved',
      action: 'approved',
      completedAt: '2026-07-15T11:40:00.000Z',
      headSha: HEAD_SHA,
    })).toBe(true)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(NEXT_HEAD_SHA)
  })

  it('does not reapprove while another reviewer owns an unresolved conversation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      latestActivityAt: '2026-07-15T11:49:59.000Z',
      unresolvedConversationCount: 2,
      unresolvedConversationAuthors: ['review-bot', 'other-reviewer'],
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    const target = `${pr.repo}#${pr.number}@quiet=prior/head=${HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)!
    expect(db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs',
      target,
      claimId,
      launchBehavior: 'pr_approve',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: '2026-07-15T11:39:00.000Z',
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:approve-prs',
      correlationId: claimId,
    })).toBe(true)
    expect(db.linkBehaviorLaunchCallOwned(
      'approve-prs',
      target,
      claimId,
      'b'.repeat(32),
    )).toBe(true)
    expect(db.completeBehaviorLaunchOwned({
      key: 'approve-prs',
      target,
      claimId,
      outcome: 'approved',
      action: 'approved',
      completedAt: '2026-07-15T11:40:00.000Z',
      headSha: HEAD_SHA,
    })).toBe(true)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('launches eligible approvals independently across PRs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const secondPr = {
      repo: 'Vaquum/poise-second',
      number: 18,
      url: 'https://github.com/Vaquum/poise-second/pull/18',
      status: 'open',
      author: 'poise-user',
      draft: 0,
    }
    listedPrs = [pr, secondPr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, {
      completedAt: '2026-07-15T11:40:00.000Z',
    })
    recordCompletedInitialReview(db, {
      pull: secondPr,
      completedAt: '2026-07-15T11:40:00.000Z',
      callId: 'd'.repeat(32),
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['--pr-approve', `#${pr.number}`]),
        expect.arrayContaining(['--pr-approve', `#${secondPr.number}`]),
      ]),
    )
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

  it('evaluates approval after a third-party conversation becomes outdated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      unresolvedLiveConversationCount: 0,
      unresolvedConversationAuthors: ['other-reviewer'],
      unresolvedLiveConversationAuthors: [],
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-approve')
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

  it('approves on the next scan after another reviewer dismisses a change request', async () => {
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
    db.clearSeen('pr-operation')

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

  it('keeps one durable in-flight worker per PR', async () => {
    const secondPr = {
      repo: 'Vaquum/poise-second',
      number: 18,
      url: 'https://github.com/Vaquum/poise-second/pull/18',
      status: 'open',
      author: 'poise-user',
      draft: 0,
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

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-review', `#${pr.number}`]),
      expect.any(Object),
    )
    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-review', `#${secondPr.number}`]),
      expect.any(Object),
    )
  })

  it('keeps GitHub-only unblocking active during a Claude auth outage', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1 })
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
    expect(externalCalls()).toEqual([])

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
      draft: 0,
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

  it('re-arms a snapshot-only PR after a failed reviewer attempt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_failed_snapshot_recovery_v1', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    agentLogs = [agentLog({
      actor: 'review-bot',
      source: null,
      correlation_id: null,
      status: 'failed',
      started_at: '2026-07-15T11:59:00.000Z',
      started_at_precise: '2026-07-15T11:59:00.001Z',
      error: 'authentication failed',
    })]

    await runtime.runEnabledBehaviorsOnce()

    expect(db.getMeta('behavior_review_new_prs_snapshot_recovery_v2')).toBe('1')
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  it('re-arms a snapshot-only PR missed by a mature runtime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T06:21:21.370Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_failed_snapshot_recovery_v1', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    agentLogs = [agentLog({
      repo: 'Vaquum/previous',
      pr_id: '16',
      actor: 'review-bot',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      started_at: '2026-07-29T18:01:09.127Z',
      completed_at: '2026-07-29T18:07:51.000Z',
    })]

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  it('takes the anti-flood snapshot only when the startup ledger is missing', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    agentLogs = [agentLog({
      repo: 'Vaquum/previous',
      pr_id: '16',
      actor: 'review-bot',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
    })]
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

  it('treats a typed resolver head supersession as a safe no-op', async () => {
    arrangeCli(false, false, { resolveSuperseded: true, unresolvedConversationCount: 1 })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [],
    })
    expect(runtime.getResolveUnblockingLastFired()).toBeNull()
  })

  it('logs the exact resolver blockers for unresolved conversations', async () => {
    arrangeCli(false, false, {
      resolveUnresolvedCount: 1,
      unresolvedConversationCount: 1,
      resolveBlockers: ['reviewer_not_approved_current_head'],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })

    await runtime.runEnabledBehaviorsOnce()

    expect(log).toHaveBeenCalledWith(
      `[behaviors] resolve-unblocking waiting on ${pr.repo}#${pr.number}: reviewer_not_approved_current_head`,
    )
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

  it.each([
    ['review-new-prs', 'failed'], ['approve-prs', 'failed'],
    ['review-new-prs', 'completed'], ['approve-prs', 'completed'],
    ['review-new-prs', 'superseded'], ['approve-prs', 'superseded'],
    ['approve-prs', 'wrong-head'], ['approve-prs', 'wrong-pair'],
  ] as const)('isolates a %s %s outcome and ignores its legacy account breaker across restart', async (behavior, result) => {
    const status = result === 'wrong-head' || result === 'wrong-pair' ? 'completed' : result
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const failure = { kind: 'worker', consecutiveFailures: 21, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000 }
    const failureKey = `behavior_${behavior.replace(/-/g, '_')}_failure`
    launched.database.setMeta(failureKey, JSON.stringify(failure))
    agentLogs = [agentLog({
      id: 'b'.repeat(32), model: 'opus-5-xhigh',
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status, error: status === 'failed' ? 'review behavior must produce exactly one atomic clean or change-request review' : '',
      outcome: status === 'superseded' ? 'superseded' : null,
      ...(result === 'wrong-head' ? { action: 'approved', outcome: 'approved', head_sha: NEXT_HEAD_SHA } : {}),
      ...(result === 'wrong-pair' ? { action: 'approved', outcome: 'clean', head_sha: HEAD_SHA } : {}),
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
    })]
    listedPrs = [pr, { ...pr, repo: 'Vaquum/unrelated', number: 96, url: 'https://github.com/Vaquum/unrelated/pull/96' }]
    let loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#96')
    expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)).toMatchObject({
      launchCallId: 'b'.repeat(32), launchCorrelationId: launched.correlationId, launchExpectedHead: launched.expectedHead,
    })
    expect(loaded.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(loaded.behaviors.getBehaviorsRuntimeHealth().deadLetters).toEqual([
      expect.objectContaining({
        behavior, target: `${pr.repo}#${pr.number}`,
        error: status === 'failed' ? expect.stringContaining('exactly one atomic')
          : result === 'wrong-head' || result === 'wrong-pair' ? expect.stringContaining('missing authoritative action/outcome/head')
            : expect.stringContaining(`reported status ${status}`),
      }),
    ])
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(loaded.database.hasSeen(behavior, launched.target)).toBe(true)
    if (status !== 'failed') {
      // Invalid terminal proof stays ambiguous even when the input changes.
      arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
      loaded.database.setMeta('models', JSON.stringify({
        [behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve']: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' },
      }))
      await loaded.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)).toMatchObject({
        launchCallId: 'b'.repeat(32), launchCorrelationId: launched.correlationId, launchExpectedHead: launched.expectedHead,
      })
      // Corrected logs cannot hide an unresolved durable quarantine.
      agentLogs[0] = {
        ...agentLogs[0], status: 'completed', completed_at: new Date().toISOString(),
        action: behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved',
        outcome: behavior === 'review-new-prs' ? 'clean' : 'approved', head_sha: HEAD_SHA,
      }
      await loaded.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(loaded.behaviors.getBehaviorsRuntimeHealth().deadLetters).toEqual([
        expect.objectContaining({ behavior, target: `${pr.repo}#${pr.number}`, error: expect.stringContaining('invalid_agent_result: ') }),
      ])
      // A revised failure cannot replace the persisted ambiguity with retry proof.
      agentLogs[0] = {
        ...agentLogs[0], status: 'failed', action: null, outcome: null, head_sha: null,
        error: 'provider exited before reporting an action',
      }
      await loaded.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)?.launchError).toContain('invalid_agent_result: ')
      // Quarantine is durable even after Caller rotates the invalid result.
      agentLogs = []
      loaded = await restartModules()
      loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
      await loaded.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)).not.toBeNull()
    }
  })

  it('reconciles successful and failed reviewers while verified provider auth holds new launches', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '2')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    const claims = db.listBehaviorLaunchClaims('review-new-prs')
    expect(claims).toHaveLength(2)
    agentLogs = claims.map((claim, index) => agentLog({
      id: String(index + 1).repeat(32), model: claim.target.endsWith(':secondary') ? 'gpt-6-astra-ultra' : 'opus-5-xhigh',
      started_at: new Date(Date.parse(claim.launchRequestedAt) + 1).toISOString(),
      started_at_precise: new Date(Date.parse(claim.launchRequestedAt) + 1).toISOString(),
      expected_head: claim.launchExpectedHead, actor: claim.launchActor, source: claim.launchSource, correlation_id: claim.launchCorrelationId,
      ...(claim.target.endsWith(':secondary')
        ? { status: 'failed', error: 'malformed reviewer output' }
        : { status: 'completed', completed_at: new Date().toISOString(), action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA }),
    }))
    db.setMeta('behavior_review_new_prs_failure', JSON.stringify({
      kind: 'worker', consecutiveFailures: 21, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000,
    }))
    mocks.authStatus = 'reauth_required'
    listedPrs = [pr, { ...pr, number: 96, url: 'https://github.com/Vaquum/poise-test/pull/96' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
    expect(db.latestApprovalBasisLaunch(pr.repo, pr.number)).toMatchObject({ headSha: HEAD_SHA })
    expect(db.getFailedBehaviorLaunch('review-new-prs', `${pr.repo}#${pr.number}:secondary`)).not.toBeNull()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    expect(mocks.spawnDetached.mock.calls.slice(2).every(([, args]) => args.includes('#96'))).toBe(true)
  })

  it('preserves an existing scan failure when shutdown aborts a behavior scan', async () => {
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
      kind: 'operation',
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
        kind: 'operation',
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

  it('does not review a draft and triggers when it becomes ready', async () => {
    listedPrs = [{ ...pr, draft: 1 }]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    listedPrs = [pr]
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
      draft: 0,
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

    agentLogs = []
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      launch_call_id: callId,
      launch_error: 'awaiting linked agent call visibility',
    })
    expect(db.listBehaviorDeadLetters()).toEqual([])
  })

  it('retires a false dead letter when its exact durable call completes', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = '7'.repeat(32)
    expect(launched.database.linkBehaviorLaunchCallOwned(
      'review-new-prs', launched.target, launched.correlationId, callId,
    )).toBe(true)
    const claim = launched.database.listBehaviorLaunchClaims('review-new-prs')[0]
    launched.database.recordBehaviorDeadLetter(claim, 'transient log miss')
    expect(launched.database.completeSeenOwned(
      'review-new-prs', launched.target, launched.correlationId,
    )).toBe(true)
    agentLogs = [agentLog({
      id: callId,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      completed_at: new Date(Date.parse(launched.requestedAt) + 2_000).toISOString(),
      status: 'completed',
      action: 'requested_changes',
      outcome: 'changes_requested',
      head_sha: launched.expectedHead,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(db.db.prepare(`
      SELECT retired_at FROM behavior_dead_letters WHERE call_id = ?
    `).pluck().get(callId)).toEqual(expect.any(String))
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

    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    expect(mocks.authStatus).toBe('authenticated')
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

  it('reviews a new pull request with every reviewer Behaviors asks for, at once', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    // Three launches for one head, at once — each its own claim with its own model.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    const launches = mocks.spawnDetached.mock.calls.map((call) => call[1] as string[])
    expect(launches.map((args) => args[args.indexOf('--model') + 1]).sort()).toEqual(['gpt-6-astra-ultra', 'grok-4.6-xhigh', 'opus-5-xhigh'])
    expect(new Set(launches.map((args) => args[args.indexOf('--correlation-id') + 1])).size).toBe(3)
    for (const args of launches) {
      expect(args).toEqual(expect.arrayContaining(['--pr-review', `#${pr.number}`, '--expected-head', HEAD_SHA, '--source', 'poise:review-new-prs']))
    }
    const key = `${pr.repo}#${pr.number}`
    expect(db.listSeenTargets('review-new-prs').sort()).toEqual([key, `${key}:secondary`, `${key}:tertiary`, '__snapshot_v3__'].sort())

    // Nothing more on the next tick, and a wider panel later never revisits
    // a pull request the primary already handled.
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it('does not send extra reviewers after a pull request the primary already reviewed', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    db.setMeta('behavior_review_new_prs_reviewers', '3')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    // A pull request opened after the change gets the whole panel.
    listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    expect(mocks.spawnDetached.mock.calls.slice(1).every((call) => (call[1] as string[]).includes('#18'))).toBe(true)
  })

  it('relaunches a dead reviewer on a changed head once siblings\' reviews are accounted for', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    loaded.database.setMeta('me', 'poise-user')
    loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
    loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
    loaded.database.setMeta('behavior_review_new_prs_reviewers', '3')
    loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)

    const key = `${pr.repo}#${pr.number}`
    const requestedAt = new Date(Date.now() - 10_000).toISOString()
    const claims = new Map<string, string>()
    for (const target of [key, `${key}:secondary`, `${key}:tertiary`]) {
      loaded.database.db.prepare(`
        UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
        WHERE key = 'review-new-prs' AND target = ?
      `).run(requestedAt, Date.now() - 1, target)
      const row = loaded.database.db.prepare(
        'SELECT launch_correlation_id AS correlationId FROM behavior_seen WHERE key = ? AND target = ?',
      ).get('review-new-prs', target) as { correlationId: string }
      claims.set(target, row.correlationId)
    }
    const startedAt = new Date(Date.parse(requestedAt) + 1_000).toISOString()
    const row = (id: string, target: string, model: string, overrides: Record<string, unknown>) => agentLog({
      id, model, started_at: startedAt, started_at_precise: startedAt,
      correlation_id: claims.get(target), actor: 'review-bot', source: 'poise:review-new-prs', expected_head: HEAD_SHA,
      ...overrides,
    })
    // The primary and the tertiary posted reviews 91 and 92; the secondary died without one.
    agentLogs = [
      row('1'.repeat(32), key, 'opus-5-xhigh', { status: 'completed', completed_at: new Date().toISOString(), action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 91 }),
      row('2'.repeat(32), `${key}:secondary`, 'gpt-6-astra-ultra', { status: 'failed', error: 'provider unavailable' }),
      row('3'.repeat(32), `${key}:tertiary`, 'grok-4.6-xhigh', { status: 'completed', completed_at: new Date().toISOString(), action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 92 }),
    ]

    // An unclaimed review since the launch could be the dead run's own: hold.
    const { database: db, behaviors: runtime } = await restartModules()
    arrangeCli(false, false, { reviewerReviewIdsSince: [91, 92, 93] })
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: `${key}:secondary`, error: 'provider unavailable' })])
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)

    // Accounting for sibling reviews alone does not retry unchanged input.
    arrangeCli(false, false, { reviewerReviewIdsSince: [91, 92] })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    // A changed head plus proof that no unclaimed review was posted permits retry.
    arrangeCli(false, false, { headSha: NEXT_HEAD_SHA, reviewerReviewIdsSince: [91, 92] })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    const relaunch = mocks.spawnDetached.mock.calls[3][1] as string[]
    expect(relaunch[relaunch.indexOf('--model') + 1]).toBe('gpt-6-astra-ultra')
    expect(relaunch).toEqual(expect.arrayContaining(['--expected-head', NEXT_HEAD_SHA]))
  })

  it('recovers a failed review only after GitHub proves no reviewer action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    agentLogs = [agentLog({
      id: 'c'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'model unavailable', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('authenticated')
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)

    mocks.authStatus = 'authenticated'
    arrangeCli(false, false, { reviewerReviewsSince: 1 })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerReviewsSince: 0,
      reviewerPendingReviews: 0,
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      '--expected-head',
      NEXT_HEAD_SHA,
    ]))
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        target: launched.target,
        error: 'model unavailable',
      }),
    ])
  })

  it('retries an approval after Caller reports that preflight failed before any action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    const callId = 'e'.repeat(32)
    agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: 'not_started',
      outcome: 'preflight_failed',
      error: 'GitHub read timed out',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()

    expect(db.hasSeen('approve-prs', launched.target)).toBe(true)
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'approve-prs',
        target: launched.target,
        callId,
        error: 'GitHub read timed out',
      }),
    ])

    agentLogs = []
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('holds an oversized %s packet across restart until the head changes', async (behavior) => {
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    agentLogs = [agentLog({
      id: 'f'.repeat(32),
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_packet_too_large', error: 'remaining review input is too large',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.hasSeen(behavior, launched.target)).toBe(true)
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(modules.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await modules.behaviors.runEnabledBehaviorsOnce()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('does not repeat a stopped %s worker even with no-action preflight metadata', async (behavior) => {
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    agentLogs = [agentLog({
      id: 'a'.repeat(32), model: 'opus-5-xhigh',
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', review_policy: 'bounded-v1', error_code: 'stopped', error: 'stopped by user',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
    })]
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.getFailedBehaviorLaunch(behavior, launched.target)).not.toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('allows an explicit model change after a bounded no-action failure', async () => {
    const launched = await launchApprovalBeforeCrash()
    agentLogs = [agentLog({
      id: 'f'.repeat(32), behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: null, outcome: null, model: 'opus-5-xhigh',
      review_policy: 'bounded-v1', error_code: 'review_budget_exhausted', error: 'Review needs attention',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    modules.database.setMeta('models', JSON.stringify({ pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const args = mocks.spawnDetached.mock.calls[1][1]
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6-astra-ultra')
    expect(args[args.indexOf('--recovery-model') + 1]).toBe('opus-5-xhigh')
  })

  it.each(['model_output_limit', 'review_budget_exhausted', 'review_recovery_failed', 'stopped'])('holds %s across restarts, without blocking another PR or a new head', async (code) => {
    const behavior = 'approve-prs' as 'review-new-prs' | 'approve-prs'
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    agentLogs = [agentLog({
      id: 'f'.repeat(32),
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: null, outcome: null, model: 'opus-5-xhigh', review_policy: 'bounded-v1',
      error_code: code, error: 'Review needs attention',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.hasSeen(behavior, launched.target)).toBe(true)
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(modules.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await modules.behaviors.runEnabledBehaviorsOnce()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it('recovers a terminal failed approval only after GitHub proves no reviewer action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    const callId = '1'.repeat(32)
    agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'legacy preflight timeout', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()

    expect(db.hasSeen('approve-prs', launched.target)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    arrangeCli(true, false, { reviewerReviewsSince: 1 })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    db.setMeta('models', JSON.stringify({ pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    arrangeCli(true, false, { reviewerReviewsSince: 0, reviewerPendingReviews: 0 })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
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
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)

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
      if (command === 'agent-interface' && args[0] === '--models') return Promise.resolve({ stdout: CATALOG_STDOUT, stderr: '' })
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(externalCalls()).toHaveLength(2))
    const disable = runtime.setEnabled('review-new-prs', false)
    let disabled = false
    void disable.then(() => { disabled = true })
    await Promise.resolve()
    expect(disabled).toBe(false)

    scan.resolve({ stdout: JSON.stringify(listedPrs), stderr: '' })
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
  })

  it('resumes with PRs that appeared while review was disabled', async () => {
    listedPrs = []
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.setEnabled('review-new-prs', false)
    listedPrs = [pr]
    await runtime.setEnabled('review-new-prs', true)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  // The enabled flag is re-read immediately before the head-SHA lookup, but
  // that lookup is a subprocess. Nothing checked again between it returning and
  // the agent being spawned, so a toggle-off during that window still posted a
  // review on the pull request the user was trying to stop.
  it('does not launch after disable during the head-SHA lookup', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const headSha = deferred<{ stdout: string, stderr: string }>()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--head-sha') return headSha.promise
      return base(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(
      (c: unknown[]) => c[0] === 'github-interface' && (c[1] as string[])[0] === '--head-sha',
    )).toBe(true))
    const disable = runtime.setEnabled('review-new-prs', false)
    headSha.resolve({
      stdout: JSON.stringify({ action: 'head_sha', repository: pr.repo, pull_number: pr.number, head_sha: HEAD_SHA }),
      stderr: '',
    })
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
  })

  // The ceiling decides which pull requests get acted on. A tick fans out over
  // every open PR and each one waits on auth, a checkout resolve and the
  // head-SHA subprocess, so narrowing the ceiling took effect on screen
  // immediately while the run already under way kept spawning at the old one.
  it('uses the ceiling as it stands at spawn, not as it was when the tick began', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const headSha = deferred<{ stdout: string, stderr: string }>()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--head-sha') return headSha.promise
      return base(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.setSetting('review-new-prs', 'p4')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(
      (c: unknown[]) => c[0] === 'github-interface' && (c[1] as string[])[0] === '--head-sha',
    )).toBe(true))
    // The person dials the ceiling back while the head-SHA lookup is out.
    runtime.setSetting('review-new-prs', 'p0')
    headSha.resolve({
      stdout: JSON.stringify({ action: 'head_sha', repository: pr.repo, pull_number: pr.number, head_sha: HEAD_SHA }),
      stderr: '',
    })
    await tick

    expect(mocks.spawnDetached).toHaveBeenCalled()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--p') + 1]).toBe('p0')
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

describe('scheduled review model selection', () => {
  it.each(['review-new-prs', 'approve-prs'] as const)('runs %s with Astra during a Claude outage', async (behavior) => {
    arrangeCli(behavior === 'approve-prs')
    mocks.spawnDetached.mockResolvedValue(undefined)
    mocks.authStatus = 'reauth_required'
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('reviewModel', 'astra')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh']))
    expect(mocks.requireAuth).not.toHaveBeenCalled()
  })

  it('does not launch an outdated selection when it changes during preflight', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.requireAuth.mockImplementation(() => { db.setMeta('models', JSON.stringify({ pr_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } })) })
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra']))
  })
})

describe('multiple organization behavior isolation', () => {
  async function arrangeOrganizations() {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    const { database: db, behaviors: runtime } = loaded
    db.setMeta('me', 'poise-user')
    const betaPath = join(tempRoot, 'beta.sqlite')
    db.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')
    `).run(betaPath)
    const original = mocks.runFile.getMockImplementation()!
    const rows = new Map<string, typeof listedPrs>([['Vaquum', []], ['beta', []]])
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command !== 'github-datastore') return original(command, args, options)
      const explicit = args[0] === '--db'
      const scoped = explicit ? args.slice(2) : args
      if (scoped[0] === 'health') {
        const response = datastoreHealthOutput()
        const health = JSON.parse(response.stdout)
        health.database = explicit ? args[1] : join(tempRoot, 'github.sqlite')
        return { ...response, stdout: JSON.stringify(health) }
      }
      return { stdout: JSON.stringify(rows.get(explicit ? 'beta' : 'Vaquum')), stderr: '' }
    })
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    return { ...loaded, betaPath, rows }
  }

  function pull(owner: string, number: number): typeof pr {
    const repo = `${owner}/poise-test`
    return { ...pr, repo, number, url: `https://github.com/${repo}/pull/${number}` }
  }

  it('shares authoritative legacy preferences across every account and ignores old scoped overrides', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_setting', 'p0')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.setMeta('behavior_review_new_prs_scratchpad', '')
    db.setMeta('org:beta:behavior_review_new_prs_enabled', '0')
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p4')
    db.setMeta('org:beta:behavior_review_new_prs_scratchpad', 'old beta note')
    db.setMeta('org:beta:behavior_approve_prs_scratchpad', 'old scoped note')
    runtime.withBehaviorOrganization('beta', () => {
      expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
      expect(runtime.getSetting('review-new-prs')).toBe('p0')
      expect(runtime.getReviewers()).toBe(3)
      expect(runtime.getScratchpad('review-new-prs')).toBe('')
      expect(runtime.getScratchpad('approve-prs')).toBe('')
      runtime.setSetting('review-new-prs', 'p1')
      runtime.setReviewers(2)
      runtime.setScratchpad('review-new-prs', 'shared note')
      runtime.setIssueRepositories(['Vaquum/poise-test', 'beta/poise-test'])
      runtime.setIssueAuthors(['trusted-author'])
    })
    runtime.withBehaviorOrganization('Vaquum', () => {
      expect(runtime.getSetting('review-new-prs')).toBe('p1')
      expect(runtime.getReviewers()).toBe(2)
      expect(runtime.getScratchpad('review-new-prs')).toBe('shared note')
      expect(runtime.getIssueRepositories().map((entry) => entry.repo).sort()).toEqual(['Vaquum/poise-test', 'beta/poise-test'])
      expect(runtime.getIssueAuthors()).toEqual(['trusted-author'])
    })
    expect(db.getMeta('org:beta:behavior_review_new_prs_setting')).toBe('p4')
    expect(db.getMeta('behavior_review_new_prs_setting')).toBe('p1')
  })

  it('migrates managed-only preferences in registration order and keeps issue selection dates', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    db.setMeta('org', '')
    db.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('alpha', ?, 1, 'ready', 'ready', 'poise-user')
    `).run(join(tempRoot, 'alpha.sqlite'))
    db.setMeta('org:beta:behavior_review_new_prs_enabled', '1')
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p1')
    db.setMeta('org:alpha:behavior_review_new_prs_setting', 'p4')
    db.setMeta('org:beta:behavior_review_new_prs_reviewers', '3')
    db.setMeta('behavior_review_new_prs_reviewers', '1')
    const betaSelection = { repo: 'beta/repo', since: '2026-09-01T00:00:00.000Z' }
    const alphaSelection = { repo: 'alpha/repo', since: '2026-09-02T00:00:00.000Z' }
    db.setMeta('org:beta:behavior_review_new_issues_repos', JSON.stringify([betaSelection]))
    db.setMeta('org:alpha:behavior_review_new_issues_repos', JSON.stringify([alphaSelection]))
    runtime.withBehaviorOrganization('alpha', () => {
      expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
      expect(runtime.getSetting('review-new-prs')).toBe('p1')
      expect(runtime.getReviewers()).toBe(1)
      expect(runtime.getIssueRepositories()).toEqual([alphaSelection, betaSelection])
    })
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p3')
    expect(runtime.getSetting('review-new-prs')).toBe('p1')
    expect(db.getMeta('behavior_review_new_prs_enabled')).toBe('1')
    expect(db.getMeta('behavior_review_new_prs_setting')).toBe('p1')
  })

  it('allows global configuration while accounts initialize and reports the persisted switch', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.setMeta('org', '')
    db.db.prepare("UPDATE organizations SET status = 'initializing' WHERE login = 'beta'").run()
    await runtime.setEnabled('review-new-prs', true)
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
    expect(runtime.withBehaviorOrganization('beta', () => runtime.isEnabled('review-new-prs'))).toBe(false)
    expect(db.getMeta('org:beta:behavior_review_new_prs_enabled')).toBeNull()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    db.db.prepare("UPDATE organizations SET status = 'ready' WHERE login = 'beta'").run()
    rows.set('beta', [pull('beta', 17)])
    await runtime.runEnabledBehaviorsOnce()
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#17')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('baselines each organization, filters foreign rows, and deduplicates equal repository names independently', async () => {
    const { database: db, behaviors: runtime, betaPath, rows } = await arrangeOrganizations()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    await runtime.setEnabled('review-new-prs', true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
    rows.set('Vaquum', [pull('Vaquum', 17), pull('Vaquum', 18), pull('beta', 19)])
    rows.set('beta', [pull('beta', 17), pull('beta', 18), pull('Vaquum', 19)])
    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#18')).toBe(true)
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(true)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#19')).toBe(false)
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#19')).toBe(false)
    const betaReads = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[0] === '--db')
    expect(betaReads.length).toBeGreaterThan(0)
    expect(betaReads.every(([, args]) => args[1] === betaPath)).toBe(true)
    expect(betaReads.some(([, args]) => args[2] === 'health')).toBe(true)
    expect(betaReads.some(([, args]) => args[2] === 'view')).toBe(true)
  })

  it('preserves a managed baseline and its settings over restart while catching work opened during downtime', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    rows.set('beta', [pull('beta', 17)])
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('review-new-prs', true))
    runtime.withBehaviorOrganization('beta', () => {
      runtime.setSetting('review-new-prs', 'p1')
      runtime.setScratchpad('review-new-prs', 'persistent beta note')
    })
    const restarted = await restartModules()
    rows.set('beta', [pull('beta', 17), pull('beta', 18)])
    restarted.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--pr-review') + 1]).toBe('#18')
    expect(args[args.indexOf('--p') + 1]).toBe('p1')
    expect(args[args.indexOf('--note') + 1]).toBe('persistent beta note')
    expect(restarted.database.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
  })

  it('continues a healthy organization while another is blocked, and attributes its eventual failure correctly', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const held = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === 'health') return held.promise
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.spawnDetached).toHaveBeenCalledTimes(1))
    held.resolve({ stdout: JSON.stringify({ healthy: false }), stderr: '' })
    await scan
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth())).toMatchObject({
      status: 'ok', failures: [], datastore: { status: 'healthy' },
    })
    expect(runtime.withBehaviorOrganization('Vaquum', () => runtime.getBehaviorsRuntimeHealth())).toMatchObject({
      status: 'degraded', failures: [{ behavior: 'review-new-prs', consecutiveFailures: 1 }],
      datastore: { status: 'unavailable' },
    })
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded', failures: [{ org: 'Vaquum', behavior: 'review-new-prs' }],
    })
  })

  it('rejects freshness reported for a different database without affecting legacy health', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') return datastoreHealthOutput()
      return original(command, args, options)
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth()).datastore.error).toContain('different account database')
    expect(runtime.withBehaviorOrganization('Vaquum', () => runtime.getBehaviorsRuntimeHealth()).datastore.status).toBe('healthy')
  })

  it('stops a removed organization during an in-flight scan and never falls back to the default database', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('review-new-prs', true))
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const entered = deferred<void>()
    const held = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') {
        entered.resolve()
        await held.promise
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await entered.promise
    db.db.prepare("DELETE FROM organizations WHERE login = 'beta'").run()
    held.resolve()
    await scan
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(false)
    db.setMeta('org', '')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('inherits global preferences when an added account becomes ready without absorbing its open PRs', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.db.prepare("UPDATE organizations SET status = 'initializing' WHERE login = 'beta'").run()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    runtime.setSetting('review-new-prs', 'p1')
    runtime.setScratchpad('review-new-prs', 'shared instructions')
    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#17')).toBe(true)
    db.db.prepare("UPDATE organizations SET status = 'ready' WHERE login = 'beta'").run()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--p', 'p1', '--note', 'shared instructions']))
    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.launchRepo)).toEqual(['beta/poise-test'])
    expect(db.getMeta('org:beta:behavior_review_new_prs_enabled')).toBeNull()
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
  })

  it('adopts already-added accounts on restart when the global legacy behavior was active', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    rows.set('beta', [pull('beta', 17)])
    await runtime.stopBehaviorsRuntime()
    const restarted = await restartModules()
    restarted.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(restarted.database.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.launchRepo)).toEqual(['beta/poise-test'])
    expect(restarted.database.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
  })

  it('retries a failed initial account baseline after restart without treating it as expanded coverage', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    const original = mocks.runFile.getMockImplementation()!
    let failBeta = true
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (failBeta && command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') {
        throw new Error('beta database unavailable')
      }
      return original(command, args, options)
    })
    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(false)
    expect(db.getMeta('org:beta:behavior_review_new_prs_initial_baseline')).toBe('1')
    expect(runtime.getBehaviorsRuntimeHealth().failures).toMatchObject([{ org: 'beta', behavior: 'review-new-prs' }])
    failBeta = false
    const restarted = await restartModules()
    rows.set('beta', [pull('beta', 17), pull('beta', 18)])
    restarted.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(restarted.database.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(true)
    rows.set('beta', [pull('beta', 17), pull('beta', 18), pull('beta', 19)])
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(restarted.database.listBehaviorLaunchClaims('review-new-prs')[0].launchPr).toBe(19)
  })

  it('waits for scans in every account, including a removed account, before acknowledging global disable', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const legacyHeld = deferred<void>()
    const betaHeld = deferred<void>()
    const entered = new Set<string>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args.includes('view')) {
        const beta = args[0] === '--db'
        entered.add(beta ? 'beta' : 'Vaquum')
        await (beta ? betaHeld.promise : legacyHeld.promise)
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(entered.size).toBe(2))
    db.db.prepare("DELETE FROM organizations WHERE login = 'beta'").run()
    const disable = runtime.setEnabled('review-new-prs', false)
    let settled = false
    void disable.then(() => { settled = true })
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(false)
    legacyHeld.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    betaHeld.resolve()
    await Promise.all([scan, disable])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
  })

  it('never republishes a queued global enable after a later disable', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const held = deferred<void>()
    let entered = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args.includes('view')) {
        entered += 1
        await held.promise
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(entered).toBe(2))
    const enable = runtime.setEnabled('review-new-prs', true)
    const disable = runtime.setEnabled('review-new-prs', false)
    held.resolve()
    await Promise.all([scan, enable, disable])
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(false)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('ignores a managed account worker cooldown without losing its failed PR proof', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', '__snapshot_v3__:org:beta')
    db.setMeta('org:beta:behavior_review_new_prs_failure', JSON.stringify({
      kind: 'worker', consecutiveFailures: 21, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000,
    }))
    const target = 'beta/poise-test#17'
    const claimId = db.claimSeenOwned('review-new-prs', target)!
    const requestedAt = new Date(Date.now() - 10_000).toISOString()
    db.markBehaviorLaunchIntentOwned({
      key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review', repo: 'beta/poise-test', pr: 17,
      requestedAt, expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId,
    })
    agentLogs = [agentLog({
      id: 'c'.repeat(32), repo: 'beta/poise-test', pr_id: '17', model: 'opus-5-xhigh',
      started_at: new Date(Date.parse(requestedAt) + 1).toISOString(),
      started_at_precise: new Date(Date.parse(requestedAt) + 1).toISOString(),
      status: 'failed', error: 'malformed review result', correlation_id: claimId,
    })]
    rows.set('beta', [pull('beta', 17), pull('beta', 96)])
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('#96')
    expect(db.getFailedBehaviorLaunch('review-new-prs', target)).toMatchObject({
      launchCallId: 'c'.repeat(32), launchCorrelationId: claimId, launchExpectedHead: HEAD_SHA,
    })
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target, repo: 'beta/poise-test' })])
  })

  it('reports the latest resolve event across ready accounts while retaining scoped diagnostics', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    const legacy = { at: '2026-09-30T10:00:00.000Z', target: 'Vaquum/poise-test#17' }
    const beta = { at: '2026-10-01T10:00:00.000Z', target: 'beta/poise-test#17' }
    db.setMeta('behavior_resolve_unblocking_last_fired', JSON.stringify(legacy))
    db.setMeta('org:beta:behavior_resolve_unblocking_last_fired', JSON.stringify(beta))
    expect(runtime.getResolveUnblockingLastFired()).toEqual(beta)
    expect(runtime.withBehaviorOrganization('Vaquum', runtime.getResolveUnblockingLastFired)).toEqual(legacy)
    db.db.prepare("UPDATE organizations SET status = 'error' WHERE login = 'beta'").run()
    expect(runtime.getResolveUnblockingLastFired()).toEqual(legacy)
  })

  it('disables every account but keeps per-account reconciliation and incident ownership', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    for (const owner of ['Vaquum', 'beta']) {
      const target = `${owner}/poise-test#17`
      db.recordSeen('approve-prs', target)
      const claimId = db.claimSeenOwned('review-new-prs', target)!
      db.markBehaviorLaunchIntentOwned({
        key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review', repo: `${owner}/poise-test`,
        pr: 17, requestedAt: new Date(Date.now() - runtime.BEHAVIOR_REGISTRATION_GRACE_MS - 1).toISOString(),
        expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId,
      })
      db.recordBehaviorDeadLetter(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === target)!, 'old error')
    }
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('approve-prs', false))
    expect(db.hasSeen('approve-prs', 'Vaquum/poise-test#17')).toBe(false)
    expect(db.hasSeen('approve-prs', 'beta/poise-test#17')).toBe(false)
    const legacyBefore = db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.launchRepo === 'Vaquum/poise-test')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    await runtime.withBehaviorOrganization('beta', () => runtime.runEnabledBehaviorsOnce())
    expect(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.launchRepo === 'Vaquum/poise-test')).toEqual(legacyBefore)
    expect(db.listBehaviorDeadLetters().map((letter) => letter.repo)).toContain('Vaquum/poise-test')
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth()).deadLetters.every((letter) => letter.repo?.startsWith('beta/'))).toBe(true)
    expect(db.listBehaviorDeadLetters(1, 'Vaquum')[0]?.repo).toBe('Vaquum/poise-test')
  })
})
