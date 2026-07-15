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
}
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

interface ReviewRequestFixture {
  requestedReviewers?: string[]
  reviews?: Array<{ login: string, state: string }>
  headSha?: string
  state?: string
  draft?: boolean
  mergeable?: boolean
  ciState?: string | null
}

function arrangeCli(
  changesAddressed = false,
  failCheckout = false,
  reviewRequest: ReviewRequestFixture = {},
): void {
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'github-datastore') {
      return { stdout: JSON.stringify(listedPrs), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      if (failCheckout) throw new Error('checkout unavailable')
      return { stdout: JSON.stringify({ path: tempRoot }), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--requested-changes-addressed') {
      return {
        stdout: JSON.stringify({
          has_change_request: changesAddressed,
          latest_request_at: '2026-07-10T10:00:00Z',
          author_commits_after_request: changesAddressed ? 1 : 0,
          author_inline_replies_after_request: 0,
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--requested-review-ready') {
      const reviewer = args[args.indexOf('--username') + 1].toLowerCase()
      const requested = (reviewRequest.requestedReviewers || [])
        .some((login) => login.toLowerCase() === reviewer)
      const blocked = (reviewRequest.reviews || []).some(
        (review) => review.login.toLowerCase() !== reviewer
          && review.state === 'CHANGES_REQUESTED',
      )
      const checksGreen = reviewRequest.ciState === null
        || (reviewRequest.ciState || 'SUCCESS') === 'SUCCESS'
      const ready = requested
        && (reviewRequest.state || 'open').toLowerCase() === 'open'
        && !(reviewRequest.draft ?? false)
        && (reviewRequest.mergeable ?? true)
        && checksGreen
        && !blocked
      return {
        stdout: JSON.stringify({
          ready,
          requested,
          head_sha: reviewRequest.headSha ?? 'abc123',
        }),
        stderr: '',
      }
    }
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      return {
        stdout: JSON.stringify({
          ready_except_conversations: false,
          resolved_count: 0,
          unresolved_count: 0,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function recordCompletedInitialReview(
  db: typeof import('../server/db'),
  target = `${pr.repo}#${pr.number}`,
): void {
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
  })
  if (!marked || !db.completeSeenOwned('review-new-prs', target, claimId)) {
    throw new Error('could not arrange completed initial review')
  }
}

async function launchReviewBeforeCrash() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
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
  return { ...loaded, target, requestedAt }
}

async function launchApprovalBeforeCrash() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
  await loaded.behaviors.runEnabledBehaviorsOnce()

  const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1`
  const requestedAt = new Date(Date.now() - 10_000).toISOString()
  loaded.database.db.prepare(`
    UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
    WHERE key = 'approve-prs' AND target = ?
  `).run(requestedAt, Date.now() - 1, target)
  return { ...loaded, target, requestedAt }
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

  it('approves an explicitly requested green head once under the configured identity', async () => {
    arrangeCli(false, false, {
      requestedReviewers: ['other-reviewer', 'REVIEW-BOT'],
      headSha: 'def456',
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-approve', `#${pr.number}`]),
      expect.any(Object),
    )
    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      ['--requested-review-ready', `#${pr.number}`, '--username', 'review-bot'],
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
      `${pr.repo}#${pr.number}@requested=review-bot/head=def456`,
    )).toBe(false)
  })

  it('does not inherit another reviewer change request', async () => {
    const reviewRequest: ReviewRequestFixture = {
      requestedReviewers: ['review-bot'],
      reviews: [{ login: 'zero-bang', state: 'CHANGES_REQUESTED' }],
    }
    arrangeCli(false, false, reviewRequest)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    reviewRequest.reviews![0].state = 'DISMISSED'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('requires the configured review request and a conflict-free head', async () => {
    const reviewRequest: ReviewRequestFixture = {
      requestedReviewers: ['other-reviewer'],
    }
    arrangeCli(false, false, reviewRequest)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    reviewRequest.requestedReviewers = ['review-bot']
    reviewRequest.mergeable = false
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    reviewRequest.mergeable = true
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('waits for requested-review CI to be fully green', async () => {
    const reviewRequest: ReviewRequestFixture = {
      requestedReviewers: ['review-bot'],
      ciState: 'PENDING',
    }
    arrangeCli(false, false, reviewRequest)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    reviewRequest.ciState = 'SUCCESS'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('never overlaps initial review and approval for the same PR', async () => {
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
        && args[0] === '--requested-review-ready',
    )).toBe(false)

    const reviewExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    reviewExit({ code: 0, signal: null })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('--pr-approve')
  })

  it('preserves legacy completed-review proof through disable', async () => {
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime({ reviewAgentUsername: 'review-bot' })
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, `${pr.repo}#${pr.number}@legacy-head`)

    await runtime.setEnabled('review-new-prs', false)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-approve')
  })

  it('coalesces sibling-process lock contention without opening a breaker', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
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
    }
    listedPrs = [pr, secondPr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
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
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    mocks.authStatus = 'reauth_required'

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      ['--resolve-nonblocking-conversations-if-ready', `#${pr.number}`],
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

    runtime.startBehaviorsRuntime()
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
    }
    listedPrs = [pr, downtimePr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
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

    runtime.startBehaviorsRuntime()
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
      if (command === 'github-datastore') return scan.promise
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

    await vi.advanceTimersByTimeAsync(59_900)
    expect(mocks.runFile).toHaveBeenCalledOnce()
    const firstTick = runtime.getBehaviorsRuntimeHealth().lastTickAt
    expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual([
      expect.objectContaining({ behavior: 'resolve-unblocking' }),
    ])

    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
    expect(runtime.getBehaviorsRuntimeHealth().lastTickAt).not.toBe(firstTick)
    expect(mocks.runFile).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.getBehaviorsRuntimeHealth().status).toBe('degraded')

    scan.resolve({ stdout: '[]', stderr: '' })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('degrades health and backs off after a failed scan until a clean retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    mocks.runFile.mockRejectedValue(new Error('502 Bad Gateway'))
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

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

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [],
    })
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
    runtime.startBehaviorsRuntime()

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

  it('releases a review claim when an accepted worker later exits non-zero', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
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
    expect(db.hasSeen('review-new-prs', target)).toBe(false)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        kind: 'worker',
        consecutiveFailures: 1,
      }),
    ])

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    listedPrs = []
    const restarted = await restartModules()
    restarted.behaviors.startBehaviorsRuntime()
    // Queue behind startup without snapshotting the failed target. Startup
    // itself must not clear an expired worker breaker merely because no claim
    // remains after the failed worker released it.
    await restarted.behaviors.setEnabled('review-new-prs', true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(restarted.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        kind: 'worker',
        consecutiveFailures: 1,
      }),
    ])

    listedPrs = [pr]
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)

    const retryExit = (mocks.spawnDetached.mock.calls[1][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    retryExit({ code: 7, signal: null })
    expect(restarted.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        kind: 'worker',
        consecutiveFailures: 2,
        nextRetryAt: '2026-07-15T12:03:00.000Z',
      }),
    ])
  })

  it('does not let an old worker failure release a newer claim generation', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
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

    const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1`
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('approve-prs', target)).toBe(true)
  })

  it('marks an empty snapshot so the first later PR triggers', async () => {
    mocks.runFile.mockResolvedValue({ stdout: '[]', stderr: '' })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')

    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)

    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('snapshots every existing PR without per-head source calls', async () => {
    const secondPr = {
      repo: 'Vaquum/second-test',
      number: 18,
      url: 'https://github.com/Vaquum/second-test/pull/18',
    }
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([pr, secondPr]), stderr: '' })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')

    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
    expect(db.claimSeen('review-new-prs', `${secondPr.repo}#${secondPr.number}`)).toBe(false)
    expect(mocks.runFile).toHaveBeenCalledOnce()
  })

  it('links a unique running review call after restart and renews without duplicate launch', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = 'a'.repeat(32)
    agentLogs = [{
      id: callId,
      behavior: 'pr_review',
      repo: pr.repo,
      pr_id: String(pr.number),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'running',
    }]

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
    agentLogs = [{
      id: '9'.repeat(32),
      behavior: 'pr_review',
      repo: pr.repo,
      pr_id: pr.number,
      started_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      status: 'unexpected',
    }]

    const { database: db, behaviors: runtime } = await restartModules()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.observeAuthFailure).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(false)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('turns a completed approval found after restart into a terminal claim', async () => {
    const launched = await launchApprovalBeforeCrash()
    const callId = 'b'.repeat(32)
    agentLogs = [{
      id: callId,
      behavior: 'pr_approve',
      repo: pr.repo,
      pr_id: pr.number,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'completed',
    }]

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

  it('closes the gate before retrying a failed recovered review call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    agentLogs = [{
      id: 'c'.repeat(32),
      behavior: 'pr_review',
      repo: pr.repo,
      pr_id: pr.number,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed',
    }]

    const { database: db, behaviors: runtime } = await restartModules()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(false)

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('waits through bounded registration grace before retrying a missing call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const { database: db, behaviors: runtime } = await restartModules()

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
      { id: 'd'.repeat(32), behavior: 'pr_review', repo: pr.repo, pr_id: pr.number, started_at: new Date(after).toISOString(), status: 'running' },
      { id: 'e'.repeat(32), behavior: 'pr_review', repo: pr.repo, pr_id: pr.number, started_at: new Date(after + 1_000).toISOString(), status: 'completed' },
      { id: 'f'.repeat(32), behavior: 'pr_review', repo: 'Other/repo', pr_id: pr.number, started_at: new Date(after).toISOString(), status: 'running' },
      { id: '1'.repeat(32), behavior: 'pr_review', repo: pr.repo, pr_id: pr.number, started_at: new Date(Date.parse(launched.requestedAt) - 1).toISOString(), status: 'running' },
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
      launch_error: expect.stringContaining('ambiguous agent call registration'),
    })
  })

  it('waits for an in-flight tick to stop before acknowledging disable', async () => {
    const scan = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[]) => {
      if (command === 'github-datastore') return scan.promise
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledOnce())
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
