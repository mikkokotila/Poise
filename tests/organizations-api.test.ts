import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../server/organizations'
import type { RunFileOptions } from '../server/process'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: vi.fn(async () => { throw new Error('unexpected agent launch') }),
}))
vi.mock('../server/content-jobs', async (original) => ({
  ...(await original<typeof import('../server/content-jobs')>()),
  startContentFinalizer: vi.fn(),
  stopContentFinalizer: vi.fn(async () => undefined),
}))
vi.mock('../server/chat/runtime', async (original) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...(await original<typeof import('../server/chat/runtime')>()),
    ChatRuntime: class extends EventEmitter {
      draining = null
      async recover() {}
      async stop() {}
      endDrain() {}
    },
  }
})
vi.mock('../server/jev/api', () => ({
  handleJevApi: vi.fn(async () => false),
  stopJev: vi.fn(async () => undefined),
}))

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
let pendingIndex: Promise<void> | undefined
let releaseIndex: (() => void) | undefined
let failIndex = false
let behaviorLogs: unknown[] = []
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

function writeIndex(path: string, login: string) {
  const fixture = new Database(path)
  try {
    fixture.exec('CREATE TABLE sync_state(scope TEXT, key TEXT, value TEXT)')
    const insert = fixture.prepare('INSERT INTO sync_state VALUES (?, ?, ?)')
    insert.run('org', 'login', login)
    insert.run('org', 'last_full_build_at', new Date().toISOString())
  } finally { fixture.close() }
}

async function cli(command: string, args: string[], options: RunFileOptions) {
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs') return { stdout: JSON.stringify(behaviorLogs), stderr: '' }
  if (command === 'github-interface' && args[0] === '--view-repos') {
    return { stdout: JSON.stringify({ repos: [{ full_name: `${args[1]}/same-repo` }] }), stderr: '' }
  }
  if (command === 'gh') return { stdout: 'test-secret-token', stderr: '' }
  if (command !== 'github-datastore') throw new Error(`Unexpected test command: ${command}`)
  if (args[2] === 'init-org') {
    if (pendingIndex) await Promise.race([
      pendingIndex,
      new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    ])
    if (failIndex) throw new Error('organization access denied')
    writeIndex(args[1]!, args[3]!)
  }
  return {
    stdout: args[2] === 'health'
      ? JSON.stringify({ action: 'health', healthy: true, status: 'healthy', database: args[1] })
      : '',
    stderr: '',
  }
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { organizations: Organization[], error?: string, org?: string, me?: string } }
}

async function orgStatus(login: string, status: Organization['status']) {
  await vi.waitFor(async () => {
    const result = await request('/api/organizations')
    expect(result.body.organizations.find((org) => org.login.toLowerCase() === login.toLowerCase())?.status).toBe(status)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-organizations-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  pendingIndex = undefined
  releaseIndex = undefined
  failIndex = false
  behaviorLogs = []
  mocks.runFile.mockReset().mockImplementation(cli)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Legacy')
  database.setMeta('me', 'octocat')
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end() })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await cache?.stopPoiseRuntime()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  server = undefined
  cache = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('organizations API', () => {
  it('returns the existing organization unchanged through registry and Settings', async () => {
    const registry = await request('/api/organizations')
    expect(registry.status).toBe(200)
    expect(registry.body.organizations).toEqual([{
      login: 'Legacy', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null, retryAt: null,
    }])
    const settings = await request('/api/settings')
    expect(settings.body).toMatchObject({ org: 'Legacy', me: 'octocat', organizations: registry.body.organizations })
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('returns accepted before indexing ends, then publishes ready status without touching legacy', async () => {
    pendingIndex = new Promise<void>((resolve) => { releaseIndex = resolve })
    database!.recordSeen('review-new-prs', 'Legacy/repo#1')
    const added = await request('/api/organizations', { org: ' Acme ', datastorePath: '/ignored.sqlite' })
    expect(added.status).toBe(202)
    expect(added.body.organizations).toMatchObject([
      { login: 'Legacy', status: 'ready', managed: false },
      { login: 'acme', status: 'initializing', managed: true, datastorePath: join(root, 'datastores/acme/github.sqlite') },
    ])
    const duplicate = await request('/api/organizations', { org: 'ACME' })
    expect(duplicate.status).toBe(202)
    expect(duplicate.body.organizations).toHaveLength(2)
    const progress = await request('/api/organizations')
    expect(progress.body.organizations[1]!.status).toBe('initializing')
    releaseIndex!()
    pendingIndex = undefined
    await orgStatus('acme', 'ready')
    expect(mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[2] === 'init-org')).toHaveLength(1)
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.hasSeen('review-new-prs', 'Legacy/repo#1')).toBe(true)
  })

  it.each([{}, null, [], { org: 12 }, { org: '../escape' }, { org: 'https://github.com/acme' }])('rejects malformed organization input %j without starting work', async (body) => {
    const result = await request('/api/organizations', body)
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('GitHub organization name')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('exposes the shared quota reset and refuses to bypass it through the retry API', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'init-org') {
        throw Object.assign(new Error('GitHub API rate limit exceeded'), {
          stderr: `GITHUB_RATE_LIMIT_RESET=${reset}`,
        })
      }
      return cli(command, args, options)
    })
    await request('/api/organizations', { org: 'acme' })
    await vi.waitFor(async () => {
      const result = await request('/api/organizations')
      expect(result.body.organizations[1]).toMatchObject({
        login: 'acme', status: 'initializing', stage: 'rate-limited',
        retryAt: new Date(reset * 1000).toISOString(), error: expect.stringContaining('automatically'),
      })
    })
    const requests = () => mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore' || command === 'gh')
    const count = requests().length
    const retry = await request('/api/organizations/acme/retry', {})
    expect(retry.status).toBe(202)
    expect(retry.body.organizations[1]!.retryAt).toBe(new Date(reset * 1000).toISOString())
    const added = await request('/api/organizations', { org: 'beta' })
    expect(added.body.organizations[2]).toMatchObject({ login: 'beta', stage: 'rate-limited', retryAt: new Date(reset * 1000).toISOString() })
    const settings = await request('/api/settings')
    expect(settings.body.organizations[1]!.retryAt).toBe(new Date(reset * 1000).toISOString())
    expect(requests()).toHaveLength(count)
    expect(settings.body.organizations[0]!.retryAt).toBeNull()
  })

  it('persists an activation error and recovers through its explicit retry endpoint', async () => {
    failIndex = true
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    await orgStatus('acme', 'error')
    const failed = (await request('/api/organizations')).body.organizations[1]!
    expect(failed.error).toContain('organization access denied')
    failIndex = false
    expect((await request('/api/organizations/ACME/retry', {})).status).toBe(202)
    await orgStatus('acme', 'ready')
    expect((await request('/api/organizations')).body.organizations[1]!.error).toBeNull()
    expect((await request('/api/organizations/missing/retry', {})).status).toBe(400)
  })

  it('rejects a settings update that would bypass organization activation before saving any fields', async () => {
    const result = await request('/api/settings', { org: 'uninitialized', me: 'different-user' })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('account setup')
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.getMeta('me')).toBe('octocat')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    const valid = await request('/api/settings', { org: 'Legacy', timezone: 'UTC' })
    expect(valid.status).toBe(200)
    expect(valid.body.organizations[0]!.login).toBe('Legacy')
  })
})


describe('global behavior settings API', () => {
  async function addSecondAccount() {
    expect((await request('/api/organizations', { org: 'beta' })).status).toBe(202)
    await orgStatus('beta', 'ready')
  }

  async function state(query = '') {
    const response = await fetch(`${base}/api/behaviors${query}`)
    const data = await response.json() as Record<string, Record<string, unknown>>
    expect(response.status, JSON.stringify(data)).toBe(200)
    return data
  }

  it('shares preferences and memory conflict checks across legacy account query parameters', async () => {
    await addSecondAccount()
    database!.setMeta('behavior_review_new_prs_enabled', '1')
    const updated = await request('/api/behaviors/review-new-prs?org=beta', {
      setting: 'p3', reviewers: 3, scratchpad: 'Shared instructions',
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    for (const query of ['', '?org=Legacy', '?org=beta', '?org=not-configured']) {
      expect((await state(query))['review-new-prs']).toMatchObject({
        enabled: true, setting: 'p3', reviewers: 3, scratchpad: 'Shared instructions',
      })
    }
    expect(database!.getMeta('org:beta:behavior_review_new_prs_setting')).toBeNull()
    expect((await request('/api/behaviors/review-new-prs?org=Legacy', {
      scratchpad: 'Stale overwrite', scratchpadPrevious: '',
    })).status).toBe(409)
    expect((await state())['review-new-prs']!.scratchpad).toBe('Shared instructions')
    expect((await request('/api/behaviors/review-new-prs?org=beta', { enabled: false })).status).toBe(200)
    expect((await state('?org=Legacy'))['review-new-prs']!.enabled).toBe(false)
    expect((await state('?org=beta'))['review-new-prs']!.enabled).toBe(false)
  })

  it('keeps one issue repository selection across accounts and validates each repository owner', async () => {
    await addSecondAccount()
    const repos = ['beta/same-repo', 'Legacy/same-repo']
    const added = await request('/api/behaviors/review-new-issues', { repos })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect((await state())['review-new-issues']!.repos).toEqual(repos)
    expect((await state('?org=beta'))['review-new-issues']!.repos).toEqual(repos)
    expect(mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--view-repos')
      .map(([, args]) => args[1]).sort()).toEqual(['Legacy', 'beta'])
    const before = database!.getMeta('behavior_review_new_issues_repos')
    expect((await request('/api/behaviors/review-new-issues', { enabled: true, repos: [...repos, 'beta/unknown'] })).status).toBe(400)
    expect(database!.getMeta('behavior_review_new_issues_repos')).toBe(before)
    expect((await state())['review-new-issues']!.enabled).toBe(false)
  })

  it('serves healthy Swarm rows and diagnostics when one worker row is unreadable', async () => {
    const healthy = { id: '1'.repeat(32), behavior: 'pr_review',
      source: 'poise:review-new-prs', repo: 'Legacy/same-repo', pr_id: '1',
      started_at: '2026-10-01T12:00:00Z', completed_at: '2026-10-01T12:00:01Z', status: 'completed',
      actor: 'review-bot', expected_head: 'a'.repeat(40), head_sha: 'a'.repeat(40),
      correlation_id: 'healthy-review', action: 'reviewed_clean', outcome: 'clean',
      model: 'test', prompt: '', time_elapsed: '1s' }
    behaviorLogs = [healthy, { ...healthy, id: '2'.repeat(32), pr_id: '2',
      correlation_id: 'unreadable-review', outcome: null }]
    const response = await fetch(`${base}/api/agent-logs`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.logs).toMatchObject([{ id: healthy.id }])
    expect(data.quarantined).toMatchObject([{ id: '2'.repeat(32), prId: '2' }])
    const diagnostics = await state()
    expect(diagnostics['review-new-prs']!.lastTriggered).toMatchObject({ target: 'Legacy/same-repo#1' })
    behaviorLogs = [healthy, { ...healthy, repo: 'elsewhere/repo', outcome: null }]
    const scoped = await (await fetch(`${base}/api/agent-logs?org=Legacy`)).json()
    expect(scoped.logs).toEqual([])
    expect(scoped.quarantined).toMatchObject([{
      id: healthy.id, repo: 'elsewhere/repo', correlationId: 'healthy-review',
      error: expect.stringContaining('incomplete terminal outcome'),
    }])
    // A duplicate correlation has the same ambiguity even with a different
    // call ID and an apparently unrelated reported organization.
    behaviorLogs = [healthy, { ...healthy, id: '3'.repeat(32), repo: 'elsewhere/repo', outcome: null }]
    const conflictingCorrelation = await (await fetch(`${base}/api/agent-logs?org=Legacy`)).json()
    expect(conflictingCorrelation.logs).toEqual([])
    expect(conflictingCorrelation.quarantined).toMatchObject([{
      id: '3'.repeat(32), repo: 'elsewhere/repo', correlationId: 'healthy-review',
      error: expect.stringContaining('incomplete terminal outcome'),
    }])
  })

  it('shows latest behavior activity across configured accounts', async () => {
    await addSecondAccount()
    behaviorLogs = ['Legacy', 'beta', 'unconfigured'].map((owner, index) => ({
      id: String(index + 1).repeat(32), behavior: 'pr_review',
      source: 'poise:review-new-prs', repo: `${owner}/same-repo`, pr_id: '1',
      started_at: `2026-10-01T12:0${index}:00Z`, completed_at: `2026-10-01T12:0${index}:01Z`, status: 'completed',
      actor: 'review-bot', expected_head: 'a'.repeat(40), head_sha: 'a'.repeat(40),
      correlation_id: `review-${index}`, action: 'reviewed_clean', outcome: 'clean',
      model: 'test', prompt: '', time_elapsed: '1s',
    }))
    for (const query of ['', '?org=Legacy']) {
      expect((await state(query))['review-new-prs']!.lastTriggered).toEqual({
        at: '2026-10-01T12:01:00Z', target: 'beta/same-repo#1',
      })
    }
  })
})
