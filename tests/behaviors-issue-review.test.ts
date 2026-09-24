import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT, PRE_ISSUE_REVIEW_CATALOG } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  spawnDetached: vi.fn(),
  authStatus: 'authenticated',
  requireAuth: vi.fn(),
  observeAuthFailure: vi.fn(),
}))

vi.mock('../server/process', () => ({
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  claudeSubscriptionEnvironment: () => ({ CLAUDE_CLI: '/poise/claude-subscription' }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: mocks.authStatus }),
    requireReady: mocks.requireAuth,
    observeProcessFailure: mocks.observeAuthFailure,
  },
}))

const REPO = 'Vaquum/Origo'
const KEY = 'review-new-issues'
const MINUTE = 60_000

let tempRoot = ''
let database: typeof import('../server/db') | null = null
let behaviors: typeof import('../server/behaviors') | null = null
let issues: Array<Record<string, unknown>> = []
let agentLogs: Array<Record<string, unknown>> = []
let catalogStdout = CATALOG_STDOUT
let callCounter = 0

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const created = ago(20 * MINUTE)
  return {
    repo: REPO,
    number,
    status: 'open',
    author: 'mikkokotila',
    created_at: created,
    updated_at: created,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    comments_count: 0,
    ...overrides,
  }
}

function arrangeCli(): void {
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'github-datastore' && args[0] === 'health') {
      return {
        stdout: JSON.stringify({
          action: 'health', status: 'healthy', healthy: true, database: join(tempRoot, 'github.sqlite'),
          max_age_seconds: 120, age_seconds: 1, last_sync_at: new Date().toISOString(),
          last_success_at: new Date().toISOString(), checked_at: new Date().toISOString(),
        }),
        stderr: '',
      }
    }
    if (command === 'github-datastore' && args[0] === 'view' && args[1] === 'issue') {
      // Deliberately not filtered by date: Poise must hold its own line.
      const repo = args[args.indexOf('--repo') + 1]
      return { stdout: JSON.stringify(issues.filter((row) => row.repo === repo)), stderr: '' }
    }
    if (command === 'agent-interface' && args[0] === '--models') return { stdout: catalogStdout, stderr: '' }
    if (command === 'agent-interface' && args[0] === '--logs') return { stdout: JSON.stringify(agentLogs), stderr: '' }
    throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
  })
}

async function start(options: {
  reviewers?: 1 | 2 | 3
  repos?: Array<{ repo: string, since: string }>
  slotSince?: Record<string, string>
  authors?: string[]
  note?: string
} = {}) {
  arrangeCli()
  mocks.spawnDetached.mockResolvedValue(undefined)
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  behaviors = await import('../server/behaviors')
  const gh = await import('../server/gh')
  gh.setReviewAgentUsername('bit-mis')
  const hourAgo = ago(60 * MINUTE)
  database.setMeta('behavior_review_new_issues_enabled', '1')
  database.setMeta('behavior_review_new_issues_repos', JSON.stringify(options.repos ?? [{ repo: REPO, since: hourAgo }]))
  database.setMeta('behavior_review_new_issues_slot_since', JSON.stringify(options.slotSince ?? { secondary: hourAgo, tertiary: hourAgo }))
  if (options.reviewers) database.setMeta('behavior_review_new_issues_reviewers', String(options.reviewers))
  if (options.authors) database.setMeta('behavior_review_new_issues_authors', JSON.stringify(options.authors))
  if (options.note) database.setMeta('behavior_review_new_issues_scratchpad', options.note)
  return { database, behaviors }
}

function launches(): string[][] {
  return mocks.spawnDetached.mock.calls.map(([, args]) => args as string[])
}

function flag(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]
}

// What Caller's log shows for a launched reviewer.
function callFor(target: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claim = database!.listBehaviorLaunchClaims(KEY).find((row) => row.target === target)
    ?? database!.getFailedBehaviorLaunch(KEY, target)
  if (!claim) throw new Error(`no launch for ${target}`)
  callCounter += 1
  const started = new Date(Date.parse(claim.launchRequestedAt) + 1000).toISOString()
  return {
    id: callCounter.toString(16).padStart(32, '0'),
    pr_id: String(claim.launchPr),
    repo: claim.launchRepo,
    actor: 'bit-mis',
    model: 'opus-5-xhigh',
    behavior: 'issue_review',
    session_id: null,
    prompt: '',
    started_at: started,
    started_at_precise: started,
    completed_at: null,
    time_elapsed: '1m',
    status: 'running',
    outcome: null,
    head_sha: null,
    expected_head: null,
    source: 'poise:review-new-issues',
    correlation_id: claim.claimId,
    action: null,
    response: null,
    error: '',
    receipts: null,
    ...overrides,
  }
}

function finished(target: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return callFor(target, { completed_at: new Date().toISOString(), ...overrides })
}

// A failed reviewer backs the behavior off for a minute; these tests move on.
function skipBackoff(): void {
  database!.setMeta('behavior_review_new_issues_failure', '')
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-issue-review-test-'))
  mocks.runFile.mockReset()
  mocks.spawnDetached.mockReset()
  mocks.authStatus = 'authenticated'
  mocks.requireAuth.mockReset().mockResolvedValue(undefined)
  mocks.observeAuthFailure.mockReset()
  issues = []
  agentLogs = []
  catalogStdout = CATALOG_STDOUT
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(async () => {
  await behaviors?.stopBehaviorsRuntime()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('Review New Issues', () => {
  it('launches every reviewer the panel asks for on a trusted new issue, with full provenance', async () => {
    const { behaviors, database } = await start({ reviewers: 2, note: 'Check the charts.' })
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()

    const [primary, secondary] = launches()
    expect(launches()).toHaveLength(2)
    expect(primary.slice(0, 2)).toEqual(['--issue-review', `${REPO}#452`])
    expect(flag(primary, '--model')).toBe('opus-5-xhigh')
    expect(flag(primary, '--recovery-model')).toBe('gpt-6-astra-ultra')
    expect(flag(primary, '--actor')).toBe('bit-mis')
    expect(flag(primary, '--source')).toBe('poise:review-new-issues')
    expect(flag(primary, '--note')).toBe('Check the charts.')
    expect(flag(secondary, '--model')).toBe('gpt-6-astra-ultra')
    expect(mocks.spawnDetached.mock.calls[0][0]).toBe('agent-interface')
    expect(primary).not.toContain('--expected-head')

    const claims = database.listBehaviorLaunchClaims(KEY)
    expect(claims.map((claim) => claim.target).sort()).toEqual([`${REPO}#452`, `${REPO}#452:secondary`])
    for (const claim of claims) {
      expect(claim).toMatchObject({ launchBehavior: 'issue_review', launchRepo: REPO, launchPr: 452, launchExpectedHead: '', launchActor: 'bit-mis' })
      expect(claim.launchCorrelationId).toBe(claim.claimId)
    }
    expect(flag(primary, '--correlation-id')).toBe(claims.find((claim) => claim.target === `${REPO}#452`)!.claimId)

    // Running reviewers are not launched again.
    agentLogs = [callFor(`${REPO}#452`), callFor(`${REPO}#452:secondary`)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
  })

  it('reviews nothing that was not asked for', async () => {
    const { behaviors } = await start({ repos: [{ repo: REPO, since: ago(15 * MINUTE) }] })
    issues = [
      issue(1, { author: 'stranger' }),
      issue(2, { created_at: ago(5 * MINUTE) }),
      issue(3, { created_at: ago(20 * MINUTE) }),
      issue(4, { repo: 'Vaquum/Limen', url: 'https://github.com/Vaquum/Limen/issues/4' }),
    ]
    await behaviors.runEnabledBehaviorsOnce()
    // An untrusted author, an issue still settling, one opened before the
    // repository was selected, and a repository nobody selected.
    expect(launches()).toEqual([])
    expect(mocks.runFile.mock.calls.some(([, args]) => (args as string[]).includes('Vaquum/Limen'))).toBe(false)
  })

  it('does not even read the datastore until a repository is selected', async () => {
    const { behaviors } = await start({ repos: [] })
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toEqual([])
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'github-datastore')).toBe(false)
  })

  it('gives an extra reviewer only the issues opened after it joined the panel', async () => {
    const { behaviors } = await start({ reviewers: 2, slotSince: { secondary: ago(15 * MINUTE) } })
    issues = [issue(452, { created_at: ago(20 * MINUTE) }), issue(453, { created_at: ago(12 * MINUTE) })]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => `${args[1]} ${flag(args, '--model')}`)).toEqual([
      `${REPO}#452 opus-5-xhigh`,
      `${REPO}#453 opus-5-xhigh`,
      `${REPO}#453 gpt-6-astra-ultra`,
    ])
  })

  it('runs at most three reviewers at once and starts the next when one finishes', async () => {
    const { behaviors } = await start({ reviewers: 3 })
    issues = [issue(452, { created_at: ago(30 * MINUTE) }), issue(453, { created_at: ago(20 * MINUTE) })]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#452`, `${REPO}#452`])

    agentLogs = [callFor(`${REPO}#452`), callFor(`${REPO}#452:secondary`), callFor(`${REPO}#452:tertiary`)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(3)

    agentLogs[0] = { ...agentLogs[0], status: 'completed', completed_at: new Date().toISOString(), action: 'commented', outcome: 'commented' }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#452`, `${REPO}#452`, `${REPO}#453`])
  })

  it('completes a commented review and never reviews that issue again', async () => {
    const { behaviors, database } = await start()
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(`${REPO}#452`, { status: 'completed', action: 'commented', outcome: 'commented', receipts: [] })]
    await behaviors.runEnabledBehaviorsOnce()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(1)
    expect(database.listBehaviorLaunchClaims(KEY)).toEqual([])
    expect(database.hasSeen(KEY, `${REPO}#452`)).toBe(true)
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('relaunches a reviewer once after a failure that posted nothing, then holds it', async () => {
    const { behaviors, database } = await start()
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(`${REPO}#452`, { status: 'failed', error: 'provider exited 1' })]
    await behaviors.runEnabledBehaviorsOnce()
    expect(behaviors.getBehaviorsRuntimeHealth().failures[0]).toMatchObject({ behavior: KEY, kind: 'worker', error: 'provider exited 1' })

    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)

    agentLogs.push(finished(`${REPO}#452`, { status: 'failed', error: 'provider exited 1 again' }))
    await behaviors.runEnabledBehaviorsOnce()
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
    expect(database.countBehaviorDeadLetters(KEY, `${REPO}#452`)).toBe(2)
  })

  it('never relaunches a reviewer that had begun posting', async () => {
    // Receipts alone decide it: a run that died mid-post with no error code
    // may still have commented.
    for (const [receipts, errorCode] of [
      [[], null],
      [[{ issue: `${REPO}#452`, comment_id: 1, url: null, author: 'bit-mis' }], 'posting_failed'],
    ] as const) {
      const { behaviors } = await start()
      issues = [issue(452)]
      await behaviors.runEnabledBehaviorsOnce()
      agentLogs = [finished(`${REPO}#452`, { status: 'failed', error: 'GitHub 502', error_code: errorCode, receipts })]
      await behaviors.runEnabledBehaviorsOnce()
      skipBackoff()
      await behaviors.runEnabledBehaviorsOnce()
      expect(launches()).toHaveLength(1)
      await behaviors.stopBehaviorsRuntime()
      database!.closeDatabase()
      mocks.spawnDetached.mockClear()
      await rm(join(tempRoot, 'cache.db'), { force: true })
    }
  })

  it('holds a stopped or time-limited reviewer for a person instead of relaunching it', async () => {
    for (const errorCode of ['stopped', 'review_budget_exhausted']) {
      const { behaviors } = await start()
      issues = [issue(452)]
      await behaviors.runEnabledBehaviorsOnce()
      agentLogs = [finished(`${REPO}#452`, { status: 'failed', error: 'held', error_code: errorCode })]
      await behaviors.runEnabledBehaviorsOnce()
      // A hold is not an outage: nothing backs the behavior off.
      expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
      await behaviors.runEnabledBehaviorsOnce()
      expect(launches()).toHaveLength(1)
      await behaviors.stopBehaviorsRuntime()
      database!.closeDatabase()
      mocks.spawnDetached.mockClear()
      await rm(join(tempRoot, 'cache.db'), { force: true })
    }
  })

  it('says Caller must be updated rather than launching against one without issue review', async () => {
    const { behaviors } = await start()
    catalogStdout = JSON.stringify(PRE_ISSUE_REVIEW_CATALOG)
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toEqual([])
    expect(behaviors.getBehaviorsRuntimeHealth().failures[0]).toMatchObject({
      behavior: KEY, kind: 'operation', error: 'Update Caller: issue review is unavailable',
    })
  })

  it('does not launch once the repository is deselected during the launch checks', async () => {
    const { behaviors, database } = await start()
    issues = [issue(452)]
    mocks.requireAuth.mockImplementation(async () => { behaviors.setIssueRepositories([]) })
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toEqual([])
    expect(database.listBehaviorLaunchClaims(KEY)).toEqual([])
    expect(database.hasSeen(KEY, `${REPO}#452`)).toBe(false)
  })
})

describe('Review New Issues settings', () => {
  it('dates each repository from when it was selected and keeps that date', async () => {
    const { behaviors } = await start({ repos: [{ repo: REPO, since: '2026-09-01T00:00:00.000Z' }] })
    const next = behaviors.setIssueRepositories(['Vaquum/Limen', REPO])
    expect(next.map((entry) => entry.repo)).toEqual(['Vaquum/Limen', REPO])
    expect(next.find((entry) => entry.repo === REPO)!.since).toBe('2026-09-01T00:00:00.000Z')
    expect(Date.now() - Date.parse(next.find((entry) => entry.repo === 'Vaquum/Limen')!.since)).toBeLessThan(5_000)
    expect(behaviors.setIssueRepositories([])).toEqual([])
  })

  it('trusts three authors by default and keeps each name once', async () => {
    const { behaviors, database } = await start()
    database.setMeta('behavior_review_new_issues_authors', '')
    expect(behaviors.getIssueAuthors()).toEqual(['mikkokotila', 'zero-bang', 'bit-mis'])
    expect(behaviors.setIssueAuthors(['mikkokotila', 'MikkoKotila', 'zero-bang'])).toEqual(['mikkokotila', 'zero-bang'])
    expect(behaviors.isValidAuthorList(['not a name'])).toBe(false)
  })

  it('starts an extra reviewer when it joins and forgets it when it leaves', async () => {
    const { behaviors, database } = await start({ slotSince: {} })
    const since = () => JSON.parse(database.getMeta('behavior_review_new_issues_slot_since') || '{}')
    behaviors.setReviewers(3, KEY)
    const joined = since()
    expect(Object.keys(joined).sort()).toEqual(['secondary', 'tertiary'])
    behaviors.setReviewers(2, KEY)
    expect(since()).toEqual({ secondary: joined.secondary })
    expect(behaviors.getReviewers(KEY)).toBe(2)
    expect(behaviors.getReviewers('review-new-prs')).toBe(1)
  })
})
