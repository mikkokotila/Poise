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
// Each issue's sub-issues, as github-interface --sub-issues reports them.
let subIssues: Record<string, string[]> = {}
// Issues whose sub-issues cannot be read, with the error.
let subIssueFailures: Record<string, string> = {}
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
    if (command === 'github-interface' && args[0] === '--sub-issues') {
      const repository = args[args.indexOf('--repository') + 1]
      const number = Number(args[1].replace('#', ''))
      const failure = subIssueFailures[`${repository}#${number}`]
      if (failure) throw new Error(failure)
      const rows = (subIssues[`${repository}#${number}`] ?? []).map((ref) => {
        const [repo, child] = ref.split('#')
        return { repository: repo, issue_number: Number(child), via: ['work_slices'] }
      })
      return {
        stdout: JSON.stringify({ action: 'sub_issues', repository, issue_number: number, sub_issues: rows }),
        stderr: '',
      }
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
  database.setMeta('org', 'Vaquum')
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

// Advance only the clock; unrelated targets need no cooldown bypass.
function skipBackoff(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60_000)
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
  subIssues = {}
  subIssueFailures = {}
  catalogStdout = CATALOG_STDOUT
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
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

describe('Review New Issues', () => {
  it('shares issue preferences while each account reads and launches only its own selected repositories', async () => {
    const betaRepo = 'beta/Origo'
    const since = ago(60 * MINUTE)
    const { behaviors, database } = await start({
      reviewers: 2, note: 'Global issue note', repos: [{ repo: REPO, since }, { repo: betaRepo, since }],
    })
    const betaPath = join(tempRoot, 'beta.sqlite')
    database.setMeta('me', 'mikkokotila')
    database.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', 'mikkokotila')
    `).run(betaPath)
    issues = [issue(452), issue(452, { repo: betaRepo, url: `https://github.com/${betaRepo}/issues/452` })]
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-datastore') return original(command, args)
      const explicit = args[0] === '--db'
      const scoped = explicit ? args.slice(2) : args
      if (scoped[0] === 'health') {
        const result = await original(command, scoped)
        const value = JSON.parse(result.stdout)
        value.database = explicit ? args[1] : join(tempRoot, 'github.sqlite')
        return { ...result, stdout: JSON.stringify(value) }
      }
      expect(scoped[scoped.indexOf('--repo') + 1]).toBe(explicit ? betaRepo : REPO)
      return original(command, scoped)
    })
    expect(behaviors.getIssueRepositories()).toEqual([{ repo: REPO, since }, { repo: betaRepo, since }])
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(4)
    expect(launches().map((args) => flag(args, '--issue-review')).sort()).toEqual([
      `${REPO}#452`, `${REPO}#452`, `${betaRepo}#452`, `${betaRepo}#452`,
    ].sort())
    expect(launches().every((args) => flag(args, '--note') === 'Global issue note')).toBe(true)
    await behaviors.setEnabled('review-new-issues', false)
    expect(behaviors.getEnabledMap()['review-new-issues']).toBe(false)
    expect(database.listBehaviorLaunchClaims(KEY)).toHaveLength(4)
  })

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

  it('lets another issue run while one reviewer waits to retry, including after restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T06:00:00Z'))
    let modules = await start()
    issues = [issue(452)]
    await modules.behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(`${REPO}#452`, { status: 'failed', error: 'provider max turns reached' })]
    issues.push(issue(453))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#453`])
    expect(modules.behaviors.getBehaviorsRuntimeHealth().failures).toMatchObject([
      { target: `${REPO}#452`, kind: 'worker' },
    ])
    await modules.behaviors.stopBehaviorsRuntime()
    modules.database.closeDatabase()
    modules = await start()
    issues.push(issue(454))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#453`, `${REPO}#454`])
    skipBackoff()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#453`, `${REPO}#454`, `${REPO}#452`])
  })

  it('continues another repository when one issue listing fails and preserves unread incidents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const other = 'Vaquum/Limen'
    const since = ago(60 * MINUTE)
    const { behaviors, database } = await start({ repos: [{ repo: REPO, since }, { repo: other, since }] })
    behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'bit-mis' })
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(`${REPO}#452`, { status: 'failed', error: 'provider exited' })]
    issues.push(issue(453, { repo: other, url: `https://github.com/${other}/issues/453` }))
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'github-datastore' && args[0] === 'view' && args[args.indexOf('--repo') + 1] === REPO) {
        throw new Error('repository read failed')
      }
      return original(command, args)
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${other}#453`])
    expect(database.listBehaviorDeadLetters()).toMatchObject([{ target: `${REPO}#452` }])
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'operation', target: `${REPO}:scan`, error: 'repository read failed' }),
      expect.objectContaining({ target: `${REPO}#452` }),
    ]))
    expect(behaviors.getBehaviorsRuntimeHealth().status).toBe('ok')
    mocks.runFile.mockClear()
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.runFile.mock.calls.some(([command, args]) => command === 'github-datastore' && args[0] === 'view' && args[args.indexOf('--repo') + 1] === REPO)).toBe(false)
    expect(database.listBehaviorDeadLetters()).toMatchObject([{ target: `${REPO}#452` }])
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: `${REPO}:scan`, consecutiveFailures: 1 }),
      expect.objectContaining({ target: `${REPO}#452`, kind: 'worker' }),
    ]))
    // An empty successful read clears its scan diagnostic without launching anything.
    issues = issues.filter((row) => row.repo === other)
    arrangeCli()
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
    expect(launches()).toHaveLength(2)
  })

  it('isolates an issue launch error with its own retry while another issue starts', async () => {
    const { behaviors, database } = await start()
    behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'bit-mis' })
    issues = [issue(452), issue(453)]
    mocks.spawnDetached.mockImplementation(async (_command: string, args: string[]) => {
      if (args[1] === `${REPO}#452`) throw new Error('launch unavailable for this issue')
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#453`])
    expect(database.listBehaviorLaunchClaims(KEY)).toMatchObject([{ target: `${REPO}#453` }])
    expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok', failures: [{ behavior: KEY, kind: 'operation', target: `${REPO}#452:check`, consecutiveFailures: 1 }],
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
    mocks.spawnDetached.mockResolvedValue(undefined)
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([`${REPO}#452`, `${REPO}#453`, `${REPO}#452`])
    expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
  })

  it.each(['datastore', 'log feed'] as const)('keeps a shared %s failure globally degraded and retries it immediately', async (dependency) => {
    const { behaviors } = await start()
    behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'bit-mis' })
    issues = [issue(452)]
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if ((dependency === 'datastore' && command === 'github-datastore' && args[0] === 'health')
        || (dependency === 'log feed' && command === 'agent-interface' && args[0] === '--logs')) throw new Error(`${dependency} unavailable`)
      return original(command, args)
    })
    await behaviors.runEnabledBehaviorsOnce()
    const health = behaviors.getBehaviorsRuntimeHealth()
    expect(health).toMatchObject({ status: 'degraded', failures: [{ behavior: KEY, kind: 'operation' }] })
    expect(health.failures[0]).not.toHaveProperty('target')
    expect(launches()).toHaveLength(0)
    arrangeCli()
    await behaviors.runEnabledBehaviorsOnce()
    expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
    expect(launches()).toHaveLength(1)
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

describe('Review New Issues sub-issues', () => {
  const ref = (number: number, repo = REPO) => `${repo}#${number}`
  let commentId = 0
  const commentedOn = (...refs: string[]) => refs.map((issue) => ({ issue, comment_id: ++commentId, url: null, author: 'bit-mis' }))
  const reviewed = (target: string, ...refs: string[]) =>
    finished(target, { status: 'completed', action: 'commented', outcome: 'commented', receipts: commentedOn(...refs) })
  const settle = (...numbers: number[]) => {
    issues = issues.map((row) => numbers.includes(row.number as number) ? { ...row, created_at: ago(11 * MINUTE) } : row)
  }

  it('quarantines a corrupt parent review and its covered issues while another issue launches', async () => {
    const { behaviors, database } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501)]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'completed' })] // Missing action and outcome.
    issues.push(issue(502))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    await behaviors.runEnabledBehaviorsOnce()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(502)])
    expect(database.listBehaviorLaunchClaims(KEY).find((claim) => claim.target === ref(500))?.launchError)
      .toContain('agent log row quarantined')
    expect(database.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: ref(500) })])
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('reconciles an exact healthy issue result while unidentified corruption holds missing claims and uncertain coverage', async () => {
    const { behaviors, database } = await start()
    issues = [issue(500), issue(501)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [reviewed(ref(500), ref(500)), { corrupt: true }]
    issues.push(issue(502))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY).map((claim) => claim.target)).toEqual([ref(501)])
    expect(database.listBehaviorLaunchClaims(KEY)[0].launchError).toContain('agent log row quarantined')
    expect(database.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: ref(501) })])
    expect(launches()).toHaveLength(2)
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ error: expect.stringContaining('Issue review coverage is uncertain') }),
    ])
  })

  it.each(['pr_review', 'issue_review'])('holds a parent and its receipt coverage when a malformed %s duplicate contradicts apparent success', async (malformedBehavior) => {
    const { behaviors, database } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501)]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    const completed = reviewed(ref(500), ref(500), ref(501))
    agentLogs = [completed, { id: completed.id, repo: 'other/unrelated', behavior: malformedBehavior }]
    issues.push(issue(502))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY).find((claim) => claim.target === ref(500))?.launchError)
      .toContain('agent log row quarantined')
    expect(database.hasSeen(KEY, ref(501))).toBe(false)
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(502)])
    expect(database.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: ref(500) })])
  })

  it('retains all quarantined reviewers and child coverage across restart without consuming unrelated issue capacity', async () => {
    let loaded = await start({ reviewers: 3 })
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501)]
    subIssues = { [ref(500)]: [ref(501)] }
    await loaded.behaviors.runEnabledBehaviorsOnce()
    const targets = [ref(500), `${ref(500)}:secondary`, `${ref(500)}:tertiary`]
    const invalid = targets.map((target) => finished(target, { status: 'completed' }))
    agentLogs = invalid
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchQuarantine === 'invalid_result')).toBe(true)
    agentLogs = []
    await loaded.behaviors.stopBehaviorsRuntime()
    loaded.database.closeDatabase()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    loaded = await start({ reviewers: 3 })
    issues.push(issue(502))
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([
      ref(500), ref(500), ref(500), ref(502), ref(502), ref(502),
    ])
    const siblings = [ref(502), `${ref(502)}:secondary`, `${ref(502)}:tertiary`]
    agentLogs = [...invalid.map((call) => ({
      ...call, status: 'completed', action: 'commented', outcome: 'commented',
      receipts: commentedOn(ref(500), ref(501)),
    })), ...siblings.map((target) => reviewed(target, ref(502)))]
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorLaunchClaims(KEY).map((claim) => claim.target).sort()).toEqual(targets.sort())
    expect(loaded.database.hasSeen(KEY, ref(501))).toBe(false)
    agentLogs = invalid.map((call) => ({ ...call, status: 'failed', error: 'provider exited before reporting a comment' }))
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(6)
    expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(3)
    expect(loaded.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it.each(['valid-running', 'corrupt-running', 'corrupt-unknown'] as const)('keeps capacity for terminal invalid results with %s duplicates after rotation and restart', async (conflict) => {
    let loaded = await start({ reviewers: 3 })
    issues = [issue(500)]
    await loaded.behaviors.runEnabledBehaviorsOnce()
    const targets = [ref(500), `${ref(500)}:secondary`, `${ref(500)}:tertiary`]
    const terminal = targets.map((target) => finished(target, { status: 'completed' }))
    const live = terminal.map((call) => ({
      ...call, status: conflict === 'corrupt-unknown' ? 'unrecognized' : 'running',
      ...(conflict === 'valid-running' ? {} : { actor: 42 }),
    }))
    agentLogs = [...terminal, ...live]
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorLaunchClaims(KEY)).toEqual(targets.map((target) => expect.objectContaining({
      target, launchQuarantine: 'invalid_result', launchQuarantineMayRun: true,
    })))
    issues.push(issue(501))
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(3)
    agentLogs = terminal
    await loaded.behaviors.stopBehaviorsRuntime()
    loaded.database.closeDatabase()
    loaded = await start({ reviewers: 3 })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(3)
    expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(3)
    expect(loaded.database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchQuarantineMayRun)).toBe(true)
  })

  it('keeps potentially running unreadable reviews inside the worker capacity limit', async () => {
    const { behaviors, database } = await start({ reviewers: 3 })
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const running = [callFor(ref(500)), callFor(`${ref(500)}:secondary`), callFor(`${ref(500)}:tertiary`)]
    const cli = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('log feed unavailable')
      return cli(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(cli)
    agentLogs = running
    issues.push(issue(501))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchQuarantine === null)).toBe(true)
    expect(launches()).toHaveLength(3)
    expect(database.listBehaviorDeadLetters()).toHaveLength(0)
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => !!claim.launchCallId)).toBe(true)
    agentLogs = []
    await behaviors.runEnabledBehaviorsOnce()
    expect(behaviors.getBehaviorsRuntimeHealth().deadLetters).toHaveLength(0)
    expect(launches()).toHaveLength(3)
  })

  it.each(['retryable', 'bounded', 'posted'] as const)('restores %s issue failures after a feed outage without blocking fresh issue capacity', async (kind) => {
    const { behaviors, database } = await start({ reviewers: 3 })
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const targets = [ref(500), `${ref(500)}:secondary`, `${ref(500)}:tertiary`]
    const failed = targets.map((target) => finished(target, {
      status: 'failed', error: `${kind} worker failure`,
      ...(kind === 'bounded' ? { error_code: 'review_budget_exhausted' } : {}),
      ...(kind === 'posted' ? { receipts: [] } : {}),
    }))
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchQuarantine === 'unreadable')).toBe(true)
    mocks.runFile.mockImplementation(original)
    agentLogs = failed
    issues.push(issue(501))
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(500), ref(500), ref(501), ref(501), ref(501)])
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchPr === 501)).toBe(true)
    for (const target of targets) {
      expect(database.getFailedBehaviorLaunch(KEY, target)?.launchQuarantine).toBeNull()
      expect(database.countBehaviorDeadLetters(KEY, target)).toBe(1)
    }
    expect(database.listBehaviorDeadLetters()).toHaveLength(3)
    expect(database.listBehaviorDeadLetters().every((letter) => letter.error === `${kind} worker failure`)).toBe(true)
    agentLogs.push(...[ref(501), `${ref(501)}:secondary`, `${ref(501)}:tertiary`].map((target) => reviewed(target, ref(501))))
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(6)
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(kind === 'retryable' ? 9 : 6)
    if (kind === 'retryable') {
      // Exactly one safe retry remains; diagnostics from the outage are not attempts.
      agentLogs.push(...targets.map((target) => finished(target, { status: 'failed', error: 'second real failure' })))
      await behaviors.runEnabledBehaviorsOnce()
      skipBackoff()
      await behaviors.runEnabledBehaviorsOnce()
      expect(launches()).toHaveLength(9)
      for (const target of targets) expect(database.countBehaviorDeadLetters(KEY, target)).toBe(2)
    }
  })

  it('restores a previously closed failure after a feed outage and preserves its safe retry', async () => {
    const { behaviors, database } = await start()
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'failed', error: 'provider exited without action' })]
    await behaviors.runEnabledBehaviorsOnce()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))?.launchQuarantine).toBe('unreadable')
    mocks.runFile.mockImplementation(original)
    issues.push(issue(501))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))?.launchQuarantine).toBeNull()
    expect(database.countBehaviorDeadLetters(KEY, ref(500))).toBe(1)
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(501)])
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(501), ref(500)])
  })

  it('keeps closed failures held after a feed outage and rotation without resurrecting their worker slots', async () => {
    const { behaviors, database } = await start({ reviewers: 3 })
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const targets = [ref(500), `${ref(500)}:secondary`, `${ref(500)}:tertiary`]
    agentLogs = targets.map((target) => finished(target, { status: 'failed', error: 'provider exited without action' }))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY)).toEqual([])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    agentLogs = []
    issues.push(issue(501))
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    for (const target of targets) expect(database.getFailedBehaviorLaunch(KEY, target)).toMatchObject({
      launchQuarantine: 'unreadable', launchQuarantineMayRun: false,
    })
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(500), ref(500), ref(501), ref(501), ref(501)])
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchPr === 501)).toBe(true)
  })

  it('applies the issue running limit after an exact running record restores a failed feed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { behaviors, database } = await start({ reviewers: 3 })
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const running = [callFor(ref(500)), callFor(`${ref(500)}:secondary`), callFor(`${ref(500)}:tertiary`)]
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    agentLogs = running
    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE)
    issues.push(issue(501))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))).toMatchObject({ launchQuarantine: null, launchError: 'behavior launch exceeded 7200000ms running limit' })
    expect(database.listBehaviorDeadLetters()).toHaveLength(3)
    expect(database.listBehaviorLaunchClaims(KEY).every((claim) => claim.launchPr === 501)).toBe(true)
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(500), ref(500), ref(501), ref(501), ref(501)])
  })

  it.each((['active', 'closed'] as const).flatMap((state) =>
    (['call-id', 'correlation', 'quarantined-call-id'] as const).map((identity) => [state, identity] as const)))('retains contradictory completed evidence for an unreadable %s issue launch sharing %s after rotation', async (state, identity) => {
    const { behaviors, database } = await start()
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const failed = finished(ref(500), { status: 'failed', error: 'provider exited without action' })
    if (state === 'closed') {
      agentLogs = [failed]
      await behaviors.runEnabledBehaviorsOnce()
    }
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    const completed = { ...failed, id: identity === 'correlation' ? 'e'.repeat(32) : failed.id, status: 'completed', error: '', action: 'commented', outcome: 'commented', receipts: commentedOn(ref(500)) }
    const duplicate = identity === 'quarantined-call-id' ? { ...failed, status: 'running', actor: 42 } : failed
    agentLogs = [duplicate, completed]
    await behaviors.runEnabledBehaviorsOnce()
    const held = state === 'closed' ? database.getFailedBehaviorLaunch(KEY, ref(500)) : database.listBehaviorLaunchClaims(KEY)[0]
    expect(held?.launchQuarantine).toBe('invalid_result')
    agentLogs = [failed]
    skipBackoff()
    await behaviors.stopBehaviorsRuntime()
    database.closeDatabase()
    const loaded = await start()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(1)
    expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it.each(['id', 'correlation'] as const)('retains a sole completed issue record contradicting its linked %s', async (field) => {
    const { behaviors, database } = await start()
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const call = callFor(ref(500))
    agentLogs = [call]
    await behaviors.runEnabledBehaviorsOnce()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    agentLogs = [{ ...call, status: 'completed', error: '', completed_at: new Date().toISOString(),
      action: 'commented', outcome: 'commented', receipts: commentedOn(ref(500)),
      ...(field === 'id' ? { id: 'e'.repeat(32) } : { correlation_id: 'different-correlation' }),
    }]
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY)[0]).toMatchObject({ launchCallId: call.id, launchQuarantine: 'invalid_result' })
    agentLogs = [{ ...call, status: 'failed', error: 'provider exited without action' }]
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY)[0].launchQuarantine).toBe('invalid_result')
    expect(launches()).toHaveLength(1)
  })

  it.each(['actor', 'source', 'start', 'expected-head'] as const)('retains a closed unreadable issue launch when completed evidence has the wrong %s', async (field) => {
    const { behaviors, database } = await start()
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    const failed = finished(ref(500), { status: 'failed', error: 'provider exited without action' })
    agentLogs = [failed]
    await behaviors.runEnabledBehaviorsOnce()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    agentLogs = [{ ...failed, status: 'completed', error: '', action: 'commented', outcome: 'commented', receipts: commentedOn(ref(500)),
      ...(field === 'actor' ? { actor: 'another-bot' } : {}),
      ...(field === 'source' ? { source: 'poise:another-source' } : {}),
      ...(field === 'start' ? { started_at: '2020-01-01T00:00:00Z', started_at_precise: '2020-01-01T00:00:00Z' } : {}),
      ...(field === 'expected-head' ? { expected_head: 'a'.repeat(40) } : {}),
    }]
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))?.launchQuarantine).toBe('invalid_result')
    expect(database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('does not resurrect a retired closed failure after a feed outage and log rotation', async () => {
    const { behaviors, database } = await start()
    issues = [issue(500)]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'failed', error: 'provider exited without action' })]
    await behaviors.runEnabledBehaviorsOnce()
    database.retireBehaviorDeadLettersForTarget(KEY, ref(500))
    issues = [issue(501)]
    agentLogs = []
    await behaviors.runEnabledBehaviorsOnce()
    const running = callFor(ref(501))
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, ...rest)
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))?.launchQuarantine).toBeNull()
    expect(database.listBehaviorDeadLetters().some((letter) => letter.target === ref(500))).toBe(false)
    mocks.runFile.mockImplementation(original)
    agentLogs = [running]
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorDeadLetters()).toEqual([])
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(501)])
  })

  it("retains a failed parent's child coverage after later corruption is rotated away", async () => {
    const { behaviors, database } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(5 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    const failed = finished(ref(500), { status: 'failed', error: 'provider unavailable' })
    agentLogs = [failed]
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))).not.toBeNull()
    agentLogs = [{ ...failed, status: 'completed', error: '' }]
    settle(501)
    issues.push(issue(502))
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.getFailedBehaviorLaunch(KEY, ref(500))?.launchQuarantine).toBe('invalid_result')
    agentLogs = [failed]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = []
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(502)])
    expect(database.hasSeen(KEY, ref(501))).toBe(false)
    expect(database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('reviews slices once, inside their PRD\'s review, when they follow the PRD', async () => {
    const { behaviors, database } = await start({ reviewers: 2 })
    issues = [issue(500, { created_at: ago(20 * MINUTE) }), issue(501, { created_at: ago(8 * MINUTE) }), issue(502, { created_at: ago(8 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501), ref(502)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(500)])
    for (const claim of database.listBehaviorLaunchClaims(KEY)) expect(claim.launchCovers).toEqual([ref(501), ref(502)])

    // The slices settle while the PRD's reviewers are still at work.
    settle(501, 502)
    agentLogs = [callFor(ref(500)), callFor(`${ref(500)}:secondary`)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)

    // Once a reviewer has commented on them, they are done for good.
    agentLogs[0] = reviewed(ref(500), ref(500), ref(501), ref(502))
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs[1] = reviewed(`${ref(500)}:secondary`, ref(500), ref(501), ref(502))
    await behaviors.runEnabledBehaviorsOnce()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
    for (const target of [ref(501), `${ref(501)}:secondary`, ref(502), `${ref(502)}:secondary`]) {
      expect(database.hasSeen(KEY, target)).toBe(true)
    }
    expect(console.log).toHaveBeenCalledWith(`[behaviors] review-new-issues: ${ref(501)} was reviewed as a sub-issue of ${ref(500)}`)
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('holds a slice for a PRD that is still settling, then lets the PRD\'s review cover it', async () => {
    const { behaviors } = await start()
    issues = [issue(501, { created_at: ago(20 * MINUTE) }), issue(500, { created_at: ago(5 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toEqual([])

    settle(500)
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500)])
  })

  it('reviews a slice on its own when it joined the PRD after the PRD\'s review began', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) })]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [reviewed(ref(500), ref(500))]
    await behaviors.runEnabledBehaviorsOnce()

    issues.push(issue(503, { created_at: ago(12 * MINUTE) }))
    subIssues = { [ref(500)]: [ref(503)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(503)])
  })

  it('reviews a slice on its own when its PRD\'s review left it without a comment', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(12 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500)])

    agentLogs = [reviewed(ref(500), ref(500))]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(501)])
  })

  it('reviews a slice on its own when its PRD\'s review is held without commenting', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(12 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'failed', error: 'stopped', error_code: 'stopped' })]
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(501)])
  })

  it('keeps a slice waiting while its PRD is relaunched after a failure that posted nothing', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(12 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'failed', error: 'provider exited 1' })]
    await behaviors.runEnabledBehaviorsOnce()
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(500)])
  })

  it('reviews the sub-issue of a covered slice on its own, since a review reaches one level', async () => {
    const { behaviors } = await start()
    issues = [
      issue(500, { created_at: ago(30 * MINUTE) }),
      issue(501, { created_at: ago(25 * MINUTE) }),
      issue(502, { created_at: ago(20 * MINUTE) }),
    ]
    subIssues = { [ref(500)]: [ref(501)], [ref(501)]: [ref(502)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500), ref(502)])
  })

  it('reviews the oldest issue of a loop of sub-issues and lets it cover the rest', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(20 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(501)], [ref(501)]: [ref(500)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500)])
  })

  it('covers a slice in another selected repository, however its name is cased', async () => {
    const limen = 'Vaquum/Limen'
    const hourAgo = ago(60 * MINUTE)
    const { behaviors } = await start({ repos: [{ repo: REPO, since: hourAgo }, { repo: limen, since: hourAgo }] })
    issues = [
      issue(500, { created_at: ago(30 * MINUTE) }),
      issue(7, { repo: limen, url: `https://github.com/${limen}/issues/7`, created_at: ago(12 * MINUTE) }),
    ]
    subIssues = { [ref(500)]: ['vaquum/limen#7'] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500)])
  })

  it('asks GitHub nothing for an issue held after a failure', async () => {
    const { behaviors } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) })]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(500), { status: 'failed', error: 'stopped', error_code: 'stopped' })]
    await behaviors.runEnabledBehaviorsOnce()
    // Another issue is still settling, so only the held one is due.
    issues.push(issue(501, { created_at: ago(5 * MINUTE) }))
    mocks.runFile.mockClear()
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.runFile.mock.calls.some(([command, args]) => command === 'github-interface' && (args as string[])[0] === '--sub-issues')).toBe(false)
    expect(launches()).toHaveLength(1)
  })

  it('launches nothing while no sub-issues can be read at all, and says why', async () => {
    const { behaviors, database } = await start()
    behaviors.startBehaviorsRuntime({ reviewAgentUsername: 'bit-mis' })
    issues = [issue(500, { created_at: ago(30 * MINUTE) }), issue(501, { created_at: ago(20 * MINUTE) })]
    subIssueFailures = { [ref(500)]: 'GitHub 502 reading sub-issues', [ref(501)]: 'GitHub 502 reading sub-issues' }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toEqual([])
    expect(database.hasSeen(KEY, ref(500))).toBe(false)
    expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [
      { behavior: KEY, kind: 'operation', target: `${REPO}#500:sub-issues`, error: 'GitHub 502 reading sub-issues' },
      { behavior: KEY, kind: 'operation', target: `${REPO}#501:sub-issues`, error: 'GitHub 502 reading sub-issues' },
    ] })
  })

  it('keeps one issue whose sub-issues cannot be read from holding back the rest', async () => {
    const limen = 'Vaquum/Limen'
    const hourAgo = ago(60 * MINUTE)
    const { behaviors } = await start({ repos: [{ repo: REPO, since: hourAgo }, { repo: limen, since: hourAgo }] })
    // Deleted while settling: the datastore still lists it for a while.
    issues = [
      issue(500, { created_at: ago(30 * MINUTE) }),
      issue(7, { repo: limen, url: `https://github.com/${limen}/issues/7`, created_at: ago(20 * MINUTE) }),
    ]
    subIssueFailures = { [ref(500)]: 'GitHub 404: Not Found' }
    await behaviors.runEnabledBehaviorsOnce()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(7, limen)])
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toMatchObject([{ behavior: KEY, kind: 'operation', target: `${REPO}#500:sub-issues`, error: 'GitHub 404: Not Found' }])
    // Said once, not every minute.
    const said = vi.mocked(console.error).mock.calls.filter(([line]) => String(line).includes(`sub-issues of ${ref(500)}`))
    expect(said).toHaveLength(1)
  })

  it('drops a sub-issue link that no issue answers to, such as a #0 placeholder', async () => {
    const { behaviors, database } = await start()
    issues = [issue(500, { created_at: ago(30 * MINUTE) })]
    subIssues = { [ref(500)]: [ref(0), ref(501)] }
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches().map((args) => args[1])).toEqual([ref(500)])
    expect(database.listBehaviorLaunchClaims(KEY)[0].launchCovers).toEqual([ref(501)])
  })

  it('asks GitHub nothing while every reviewer is busy', async () => {
    const { behaviors } = await start({ reviewers: 3 })
    issues = [issue(500, { created_at: ago(30 * MINUTE) })]
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [callFor(ref(500)), callFor(`${ref(500)}:secondary`), callFor(`${ref(500)}:tertiary`)]
    issues.push(issue(501, { created_at: ago(20 * MINUTE) }))
    mocks.runFile.mockClear()
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.runFile.mock.calls.some(([command, args]) => command === 'github-interface' && (args as string[])[0] === '--sub-issues')).toBe(false)
    expect(launches()).toHaveLength(3)
  })

  it('settles a covered issue\'s own failed review and a claim that never launched', async () => {
    const { behaviors, database } = await start()
    issues = [issue(501, { created_at: ago(30 * MINUTE) }), issue(502, { created_at: ago(30 * MINUTE) })]
    // 501 was reviewed on its own and failed; 502's claim died before launching.
    await behaviors.runEnabledBehaviorsOnce()
    agentLogs = [finished(ref(501), { status: 'failed', error: 'provider exited 1' }), finished(ref(502), { status: 'failed', error: 'provider exited 1' })]
    await behaviors.runEnabledBehaviorsOnce()
    database.releaseSeen(KEY, ref(502))
    expect(database.claimSeenOwned(KEY, ref(502), 1)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(database.listBehaviorIncidents().map((letter) => letter.target).sort()).toEqual([ref(501), ref(502)])

    const diagnosticKeys = [
      `behavior_review_new_issues_failure:${ref(501)}:check`,
      `behavior_review_new_issues_failure:${ref(502)}:sub-issues`,
    ]
    for (const key of diagnosticKeys) database.setMeta(key, JSON.stringify({
      kind: 'operation', consecutiveFailures: 1, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000, error: 'old eligibility error',
    }))
    // A replay of their PRD's review has commented on both.
    agentLogs.push({
      ...agentLogs[0], id: 'f'.repeat(32), pr_id: '500', correlation_id: 'replay-1', source: 'poise:replay',
      status: 'completed', action: 'commented', outcome: 'commented', error: '', receipts: commentedOn(ref(500), ref(501), ref(502)),
    })
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
    expect(database.listBehaviorIncidents()).toEqual([])
    expect(database.hasExpiredPreLaunchClaim(KEY, ref(502))).toBe(false)
    expect(database.hasSeen(KEY, ref(502))).toBe(true)
    for (const key of diagnosticKeys) expect(database.getMeta(key)).toBe('')
  })
})

describe('reviewRoots', () => {
  it('reviews each issue once however often it is listed, and settles loops', async () => {
    const { behaviors } = await start()
    const roots = (order: string[], links: Record<string, string[]>) => [...behaviors.reviewRoots(order, new Map(Object.entries(links)))].sort()
    expect(roots([], {})).toEqual([])
    expect(roots(['a', 'b', 'a', 'b'], { a: ['b'] })).toEqual(['a'])
    expect(roots(['p', 'x', 'y'], { p: ['x'], x: ['y'] })).toEqual(['p', 'y'])
    // Every issue of a loop is either reviewed or covered by an issue that is.
    const links = { a: ['b'], b: ['c'], c: ['a'] }
    const loop = roots(['a', 'b', 'c'], links)
    expect(loop[0]).toBe('a')
    for (const issue of ['a', 'b', 'c']) {
      const parents = Object.entries(links).filter(([, children]) => children.includes(issue)).map(([parent]) => parent)
      expect(loop.includes(issue) || parents.some((parent) => loop.includes(parent))).toBe(true)
    }
  })
})

describe('Review New Issues launch safety', () => {
  it('passes a memory that opens with a Markdown rule without it reading as a flag', async () => {
    const { behaviors } = await start({ note: '---\nCheck the charts.' })
    issues = [issue(452)]
    await behaviors.runEnabledBehaviorsOnce()
    expect(flag(launches()[0], '--note')).toBe(' ---\nCheck the charts.')
  })

  it('takes back an issue whose claim was never launched once its short lease runs out', async () => {
    const { behaviors, database } = await start()
    issues = [issue(452)]
    // A process that died between claiming and launching.
    expect(database.claimSeenOwned(KEY, `${REPO}#452`, 1)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(1)
    expect(database.listBehaviorLaunchClaims(KEY)).toHaveLength(1)
  })

  it('does not launch again while an unregistered worker is still alive, and does once it has exited', async () => {
    const { behaviors, database } = await start()
    issues = [issue(452)]
    let exit: ((result: { code: number | null, signal: null }) => void) | undefined
    mocks.spawnDetached.mockImplementation(async (_command: string, _args: string[], options: { onExit: typeof exit }) => { exit = options.onExit })
    await behaviors.runEnabledBehaviorsOnce()
    // The machine slept: Caller has not registered the run past the grace.
    database.db.prepare(`UPDATE behavior_seen SET launch_requested_at = ? WHERE key = ?`).run(ago(10 * MINUTE), KEY)
    await behaviors.runEnabledBehaviorsOnce()
    expect(database.listBehaviorLaunchClaims(KEY)[0].launchError).toBe('worker still running; awaiting agent call registration')
    expect(launches()).toHaveLength(1)

    exit!({ code: 1, signal: null })
    await behaviors.runEnabledBehaviorsOnce()
    skipBackoff()
    await behaviors.runEnabledBehaviorsOnce()
    expect(launches()).toHaveLength(2)
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
