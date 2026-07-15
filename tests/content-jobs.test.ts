import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

type DatabaseModule = typeof import('../server/db')
type ContentJobsModule = typeof import('../server/content-jobs')

let root = ''
let database: DatabaseModule
let jobs: ContentJobsModule

async function loadModules(): Promise<void> {
  database = await import('../server/db')
  jobs = await import('../server/content-jobs')
}

async function restartModules(): Promise<void> {
  await jobs.stopContentFinalizer()
  if (database.db.open) database.closeDatabase()
  vi.resetModules()
  await loadModules()
}

function enqueue(callId = 'a'.repeat(32)) {
  return jobs.enqueueContentJob({
    callId,
    sessionId: 'chat-session',
    topic: 'A durable article',
    startedAt: '2026-07-14T10:00:00.000Z',
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-content-jobs-test-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  vi.resetModules()
  await loadModules()
})

afterEach(async () => {
  await jobs.stopContentFinalizer()
  if (database.db.open) database.closeDatabase()
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'POISE_CHAT_ATTACHMENTS_DIR',
    'AGENT_INTERFACE_ROOT',
  ]) delete process.env[key]
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('durable author-content finalization', () => {
  it('finalizes in the background without any status endpoint polling', async () => {
    const pending = enqueue()
    const inspectCall = vi.fn().mockResolvedValue({
      status: 'completed',
      response_hash: 'deadbeef',
    })
    const readResponse = vi.fn().mockResolvedValue('# Authored\n\nDurable body.')

    jobs.startContentFinalizer({
      intervalMs: 5,
      retryDelayMs: 5,
      dependencies: {
        listCalls: vi.fn().mockResolvedValue([]),
        inspectCall,
        readResponse,
      },
    })

    await vi.waitFor(() => {
      expect(jobs.getContentJobResponse(pending.call_id)).toMatchObject({
        status: 'completed',
        slug: pending.slug,
        article_created: true,
      })
    }, { timeout: 2_000 })
    await expect(readFile(join(root, 'editor', `${pending.slug}.md`), 'utf8'))
      .resolves.toBe('# Authored\n\nDurable body.')
    expect(inspectCall).toHaveBeenCalledWith(pending.call_id)
    expect(readResponse).toHaveBeenCalledWith(pending.call_id)
  })

  it('recovers a pending job after restart without overwriting an existing article', async () => {
    const pending = enqueue('0'.repeat(8) + '1'.repeat(24))
    await restartModules()

    await mkdir(join(root, 'editor'), { recursive: true })
    await writeFile(join(root, 'editor', `${pending.slug}.md`), '# User-owned revision', 'utf8')
    const inspectCall = vi.fn().mockResolvedValue({
      status: 'completed',
      response_hash: 'response-after-restart',
    })
    const readResponse = vi.fn().mockResolvedValue('# Agent response that must not overwrite')

    await expect(jobs.runContentFinalizerOnce({
      workerId: 'restarted-worker',
      dependencies: { inspectCall, readResponse },
    })).resolves.toBe(1)

    expect(jobs.getContentJobResponse(pending.call_id)).toMatchObject({
      status: 'completed',
      slug: pending.slug,
      article_created: false,
    })
    await expect(readFile(join(root, 'editor', `${pending.slug}.md`), 'utf8'))
      .resolves.toBe('# User-owned revision')

    inspectCall.mockClear()
    await expect(jobs.runContentFinalizerOnce({
      workerId: 'later-worker',
      dependencies: { inspectCall, readResponse },
    })).resolves.toBe(0)
    expect(inspectCall).not.toHaveBeenCalled()
  })

  it('allows only one leased worker to finalize a job', async () => {
    const pending = enqueue('e'.repeat(32))
    let releaseInspection!: () => void
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve })
    const inspectCall = vi.fn().mockImplementation(async () => {
      await inspectionGate
      return { status: 'completed', response_hash: 'leased-response' }
    })
    const readResponse = vi.fn().mockResolvedValue('# One worker')

    const first = jobs.runContentFinalizerOnce({
      workerId: 'worker-a',
      leaseMs: 60_000,
      dependencies: { inspectCall, readResponse },
    })
    await vi.waitFor(() => expect(inspectCall).toHaveBeenCalledOnce())
    await expect(jobs.runContentFinalizerOnce({
      workerId: 'worker-b',
      leaseMs: 60_000,
      dependencies: { inspectCall, readResponse },
    })).resolves.toBe(0)

    releaseInspection()
    await expect(first).resolves.toBe(1)
    expect(readResponse).toHaveBeenCalledOnce()
    expect(jobs.getContentJobResponse(pending.call_id)?.status).toBe('completed')
  })

  it('persists terminal failures and collision-resistant slugs', async () => {
    const first = enqueue('abcdef12' + '1'.repeat(24))
    const second = enqueue('abcdef12' + '2'.repeat(24))
    expect(first.slug).not.toBe(second.slug)
    expect(first.slug).toMatch(/^content-[a-f0-9]{64}$/)

    const observeProcessFailure = vi.fn()
    await jobs.runContentFinalizerOnce({
      workerId: 'failure-worker',
      maxJobsPerRun: 1,
      dependencies: {
        inspectCall: vi.fn().mockResolvedValue({ status: 'failed', error: 'model backend failed' }),
        readResponse: vi.fn(),
        observeProcessFailure,
      },
    })
    expect(jobs.getContentJobResponse(first.call_id)).toMatchObject({
      status: 'failed',
      error: 'model backend failed',
    })
    expect(observeProcessFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 1,
      error: expect.objectContaining({ message: 'model backend failed' }),
    }))

    await restartModules()
    expect(jobs.getContentJobResponse(first.call_id)).toMatchObject({
      status: 'failed',
      error: 'model backend failed',
    })
  })

  it('maps one exact legacy article durably without changing its file or attribution', async () => {
    const callId = '1a2b3c4d' + '1'.repeat(24)
    const legacySlug = `content-${callId.slice(0, 8)}`
    await mkdir(join(root, 'editor'), { recursive: true })
    await writeFile(join(root, 'editor', `${legacySlug}.md`), '# Existing legacy article', 'utf8')
    const listCalls = vi.fn().mockResolvedValue([{
      id: callId,
      behavior: 'author_content',
      session_id: ' legacy-session ',
      prompt: '  Preserved legacy topic  ',
      started_at: new Date(Date.now() + 1_000).toISOString(),
      response: 'cafebabe',
    }, {
      id: '2'.repeat(32),
      behavior: 'author_content',
      session_id: 'unrelated-session',
      prompt: 'No corresponding legacy file',
      started_at: new Date(Date.now() + 1_000).toISOString(),
    }])

    await expect(jobs.recoverLegacyContentMappings(listCalls)).resolves.toBe(1)
    expect(jobs.getContentJob(callId)).toMatchObject({
      sessionId: ' legacy-session ',
      topic: '  Preserved legacy topic  ',
      status: 'completed',
      slug: legacySlug,
      responseHash: 'cafebabe',
      articleCreated: true,
    })
    expect(jobs.getContentJob('2'.repeat(32))).toBeNull()
    await expect(readFile(join(root, 'editor', `${legacySlug}.md`), 'utf8'))
      .resolves.toBe('# Existing legacy article')
    expect(await readdir(join(root, 'editor'))).toEqual([`${legacySlug}.md`])

    await restartModules()
    const afterRestart = vi.fn().mockRejectedValue(new Error('must not rescan logs'))
    await expect(jobs.recoverLegacyContentMappings(afterRestart)).resolves.toBe(0)
    expect(afterRestart).not.toHaveBeenCalled()
  })

  it('skips ambiguous prefixes, near-miss files, and unrelated author-content rows', async () => {
    const ambiguousPrefix = 'abcdef12'
    const first = ambiguousPrefix + '1'.repeat(24)
    const second = ambiguousPrefix + '2'.repeat(24)
    const unrelated = 'deadbeef' + '3'.repeat(24)
    await mkdir(join(root, 'editor'), { recursive: true })
    await writeFile(
      join(root, 'editor', `content-${ambiguousPrefix}.md`),
      '# Ambiguous legacy article',
      'utf8',
    )
    await writeFile(
      join(root, 'editor', 'content-deadbeef.md.bak'),
      '# Not an exact legacy filename',
      'utf8',
    )
    const startedAt = new Date().toISOString()
    const listCalls = vi.fn().mockResolvedValue([first, second, unrelated].map((id) => ({
      id,
      behavior: 'author_content',
      session_id: 'legacy-session',
      prompt: 'Legacy topic',
      started_at: startedAt,
    })))

    await expect(jobs.recoverLegacyContentMappings(listCalls)).resolves.toBe(0)
    for (const callId of [first, second, unrelated]) {
      expect(jobs.getContentJob(callId)).toBeNull()
    }
    expect((await readdir(join(root, 'editor'))).sort()).toEqual([
      `content-${ambiguousPrefix}.md`,
      'content-deadbeef.md.bak',
    ].sort())
  })

  it('does not enumerate global logs for launch recovery without an intent', async () => {
    const listCalls = vi.fn().mockResolvedValue([])
    await expect(jobs.recoverPendingContentLaunches(listCalls)).resolves.toBe(0)
    expect(listCalls).not.toHaveBeenCalled()
  })

  it('rejects mismatched and pre-intent log rows during launch recovery', async () => {
    const chat = await import('../server/chat')
    const launch = vi.fn().mockRejectedValue(new chat.AuthorContentDiscoveryTimeoutError())
    await expect(jobs.launchAndEnqueueContentJob(
      'Exact recovery topic',
      'exact-session',
      launch,
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)

    const intent = database.db.prepare(`
      SELECT requested_at FROM content_launches WHERE session_id = ?
    `).get('exact-session') as { requested_at: string }
    const after = new Date(Date.parse(intent.requested_at) + 1_000).toISOString()
    const before = new Date(Date.parse(intent.requested_at) - 10_000).toISOString()
    const rows = [
      { id: '3'.repeat(32), behavior: 'author_content', session_id: 'wrong-session', prompt: 'Exact recovery topic', started_at: after },
      { id: '4'.repeat(32), behavior: 'author_content', session_id: 'exact-session', prompt: 'Wrong topic', started_at: after },
      { id: '5'.repeat(32), behavior: 'author_content', session_id: 'exact-session', prompt: 'Exact recovery topic', started_at: before },
      { id: '6'.repeat(32), behavior: 'author_content', session_id: null, prompt: 'Exact recovery topic', started_at: after },
    ]

    await expect(jobs.recoverPendingContentLaunches(
      vi.fn().mockResolvedValue(rows),
    )).resolves.toBe(0)
    for (const row of rows) expect(jobs.getContentJob(row.id)).toBeNull()
    expect(database.db.prepare(`
      SELECT status, call_id, error FROM content_launches WHERE session_id = ?
    `).get('exact-session')).toMatchObject({
      status: 'pending',
      call_id: null,
      error: 'awaiting attributable author-content log row',
    })
  })

  it('retains post-spawn discovery failures but terminalizes definite launch failures', async () => {
    const chat = await import('../server/chat')
    const postSpawnError = new chat.AuthorContentDiscoveryUnavailableError(
      new Error('agent logs temporarily unavailable'),
    )
    await expect(jobs.launchAndEnqueueContentJob(
      'Recoverable discovery topic',
      'recoverable-discovery-session',
      vi.fn().mockRejectedValue(postSpawnError),
    )).rejects.toBe(postSpawnError)
    expect(database.db.prepare(`
      SELECT status, recovery_eligible, call_id FROM content_launches
      WHERE session_id = ?
    `).get('recoverable-discovery-session')).toEqual({
      status: 'pending',
      recovery_eligible: 1,
      call_id: null,
    })

    const definiteError = new Error('agent-interface executable missing')
    await expect(jobs.launchAndEnqueueContentJob(
      'Definite failure topic',
      'definite-failure-session',
      vi.fn().mockRejectedValue(definiteError),
    )).rejects.toBe(definiteError)
    expect(database.db.prepare(`
      SELECT status, recovery_eligible, call_id FROM content_launches
      WHERE session_id = ?
    `).get('definite-failure-session')).toEqual({
      status: 'failed',
      recovery_eligible: 0,
      call_id: null,
    })
  })

  it('recovers a persisted launch intent idempotently after restart', async () => {
    const chat = await import('../server/chat')
    await expect(jobs.launchAndEnqueueContentJob(
      'Restart recovery topic',
      'restart-recovery-session',
      vi.fn().mockRejectedValue(new chat.AuthorContentDiscoveryTimeoutError()),
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const intent = database.db.prepare(`
      SELECT requested_at FROM content_launches WHERE session_id = ?
    `).get('restart-recovery-session') as { requested_at: string }

    await restartModules()
    const callId = '6'.repeat(32)
    const listCalls = vi.fn().mockResolvedValue([{
      id: callId,
      behavior: 'author_content',
      session_id: 'restart-recovery-session',
      prompt: 'Restart recovery topic',
      started_at: new Date(Date.parse(intent.requested_at) + 1_000).toISOString(),
    }])
    await expect(jobs.recoverPendingContentLaunches(listCalls)).resolves.toBe(1)
    expect(jobs.getContentJob(callId)).toMatchObject({
      sessionId: 'restart-recovery-session',
      status: 'pending',
    })
    await expect(jobs.recoverPendingContentLaunches(listCalls)).resolves.toBe(0)
  })

  it('periodically recovers delayed call registration without a server restart', async () => {
    const chat = await import('../server/chat')
    const launch = vi.fn().mockRejectedValue(new chat.AuthorContentDiscoveryTimeoutError())
    await expect(jobs.launchAndEnqueueContentJob(
      'Delayed recovery topic',
      'delayed-session',
      launch,
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)

    const secondLaunch = vi.fn()
    await expect(jobs.launchAndEnqueueContentJob(
      'Second topic',
      'delayed-session',
      secondLaunch,
    )).rejects.toBeInstanceOf(jobs.ContentLaunchPendingError)
    expect(secondLaunch).not.toHaveBeenCalled()

    const intent = database.db.prepare(`
      SELECT requested_at FROM content_launches WHERE session_id = ?
    `).get('delayed-session') as { requested_at: string }
    let rows: Array<{
      id: string
      behavior: string
      session_id: string
      prompt: string
      started_at: string
    }> = []
    const callId = '7'.repeat(32)
    const listCalls = vi.fn().mockImplementation(async () => rows)
    jobs.startContentFinalizer({
      intervalMs: 5,
      recoveryIntervalMs: 5,
      retryDelayMs: 5,
      dependencies: {
        listCalls,
        inspectCall: vi.fn().mockResolvedValue({ status: 'completed', response_hash: 'cafebabe' }),
        readResponse: vi.fn().mockResolvedValue('# Delayed but durable'),
      },
    })

    await vi.waitFor(() => expect(listCalls).toHaveBeenCalled(), { timeout: 1_000 })
    rows = [{
      id: callId,
      behavior: 'author_content',
      session_id: 'delayed-session',
      prompt: 'Delayed recovery topic',
      started_at: new Date(Date.parse(intent.requested_at) + 1_000).toISOString(),
    }]

    await vi.waitFor(() => {
      expect(jobs.getContentJobResponse(callId)).toMatchObject({
        status: 'completed',
        article_created: true,
      })
    }, { timeout: 2_000 })
    await expect(readFile(
      join(root, 'editor', `${jobs.getContentJob(callId)?.slug}.md`),
      'utf8',
    )).resolves.toBe('# Delayed but durable')
  })

  it('terminalizes an expired registration intent and permits a same-session retry', async () => {
    const chat = await import('../server/chat')
    const discoveryTimeout = vi.fn().mockRejectedValue(
      new chat.AuthorContentDiscoveryTimeoutError(),
    )
    await expect(jobs.launchAndEnqueueContentJob(
      'Retryable topic',
      'retryable-session',
      discoveryTimeout,
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const original = database.db.prepare(`
      SELECT launch_id, requested_at, recovery_eligible FROM content_launches
      WHERE session_id = ? AND status = 'pending'
    `).get('retryable-session') as {
      launch_id: string
      requested_at: string
      recovery_eligible: number
    }
    expect(original.recovery_eligible).toBe(1)
    database.db.prepare(`
      UPDATE content_launches SET registration_deadline_at = ? WHERE launch_id = ?
    `).run(Date.parse(original.requested_at), original.launch_id)
    await expect(jobs.recoverPendingContentLaunches(
      vi.fn().mockResolvedValue([]),
    )).resolves.toBe(0)
    expect(database.db.prepare(`
      SELECT status FROM content_launches WHERE launch_id = ?
    `).get(original.launch_id)).toEqual({ status: 'failed' })

    const retryCallId = 'a'.repeat(32)
    await expect(jobs.launchAndEnqueueContentJob(
      'Retryable topic',
      'retryable-session',
      vi.fn().mockResolvedValue({
        call_id: retryCallId,
        started_at: new Date().toISOString(),
      }),
    )).resolves.toMatchObject({ call_id: retryCallId, status: 'pending' })
    expect(database.db.prepare(`
      SELECT status, recovery_eligible, call_id, error
      FROM content_launches WHERE launch_id = ?
    `).get(original.launch_id)).toEqual({
      status: 'failed',
      recovery_eligible: 1,
      call_id: null,
      error: 'author-content registration deadline expired',
    })
    expect(database.db.prepare(`
      SELECT status, call_id FROM content_launches
      WHERE session_id = ? AND launch_id <> ?
    `).get('retryable-session', original.launch_id)).toEqual({
      status: 'linked',
      call_id: retryCallId,
    })
  })

  it('links a late row to its expired intent while a retry remains pending', async () => {
    const chat = await import('../server/chat')
    const timeout = () => vi.fn().mockRejectedValue(
      new chat.AuthorContentDiscoveryTimeoutError(),
    )
    await expect(jobs.launchAndEnqueueContentJob(
      'Late registration topic',
      'late-registration-session',
      timeout(),
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const original = database.db.prepare(`
      SELECT launch_id FROM content_launches WHERE session_id = ? AND status = 'pending'
    `).get('late-registration-session') as { launch_id: string }
    const base = Date.now()
    database.db.prepare(`
      UPDATE meta SET value = ? WHERE key = ?
    `).run(
      new Date(base - 120_000).toISOString(),
      database.CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY,
    )
    database.db.prepare(`
      UPDATE content_launches
      SET requested_at = ?, registration_deadline_at = ?
      WHERE launch_id = ?
    `).run(new Date(base - 60_000).toISOString(), base - 30_000, original.launch_id)

    await expect(jobs.launchAndEnqueueContentJob(
      'Late registration topic',
      'late-registration-session',
      timeout(),
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const retry = database.db.prepare(`
      SELECT launch_id FROM content_launches
      WHERE session_id = ? AND status = 'pending'
    `).get('late-registration-session') as { launch_id: string }
    const lateCallId = 'b'.repeat(32)
    await expect(jobs.recoverPendingContentLaunches(vi.fn().mockResolvedValue([{
      id: lateCallId,
      behavior: 'author_content',
      session_id: 'late-registration-session',
      prompt: 'Late registration topic',
      started_at: new Date(base - 45_000).toISOString(),
    }]))).resolves.toBe(1)

    expect(database.db.prepare(`
      SELECT status, call_id FROM content_launches WHERE launch_id = ?
    `).get(original.launch_id)).toEqual({ status: 'linked', call_id: lateCallId })
    expect(database.db.prepare(`
      SELECT status, call_id FROM content_launches WHERE launch_id = ?
    `).get(retry.launch_id)).toEqual({ status: 'pending', call_id: null })
    expect(jobs.getContentJob(lateCallId)).toMatchObject({
      sessionId: 'late-registration-session',
      topic: 'Late registration topic',
    })
  })

  it('refuses a row that overlaps two intent windows without blocking later retry', async () => {
    const chat = await import('../server/chat')
    const timeout = () => vi.fn().mockRejectedValue(
      new chat.AuthorContentDiscoveryTimeoutError(),
    )
    await expect(jobs.launchAndEnqueueContentJob(
      'Overlapping topic',
      'overlapping-session',
      timeout(),
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const original = database.db.prepare(`
      SELECT launch_id FROM content_launches WHERE session_id = ? AND status = 'pending'
    `).get('overlapping-session') as { launch_id: string }
    const base = Date.now()
    database.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      new Date(base - 60_000).toISOString(),
      database.CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY,
    )
    database.db.prepare(`
      UPDATE content_launches
      SET requested_at = ?, registration_deadline_at = ?
      WHERE launch_id = ?
    `).run(new Date(base - 20_000).toISOString(), base - 1_000, original.launch_id)
    await expect(jobs.launchAndEnqueueContentJob(
      'Overlapping topic',
      'overlapping-session',
      timeout(),
    )).rejects.toBeInstanceOf(chat.AuthorContentDiscoveryTimeoutError)
    const retry = database.db.prepare(`
      SELECT launch_id FROM content_launches
      WHERE session_id = ? AND status = 'pending'
    `).get('overlapping-session') as { launch_id: string }
    const ambiguousCallId = 'c'.repeat(32)

    await expect(jobs.recoverPendingContentLaunches(vi.fn().mockResolvedValue([{
      id: ambiguousCallId,
      behavior: 'author_content',
      session_id: 'overlapping-session',
      prompt: 'Overlapping topic',
      started_at: new Date(base - 2_000).toISOString(),
    }]))).resolves.toBe(0)
    expect(jobs.getContentJob(ambiguousCallId)).toBeNull()
    expect(database.db.prepare(`
      SELECT error FROM content_launches WHERE launch_id = ?
    `).get(retry.launch_id)).toEqual({
      error: 'ambiguous recovery: call matches multiple launch intent windows',
    })

    database.db.prepare(`
      UPDATE content_launches SET registration_deadline_at = ? WHERE launch_id = ?
    `).run(Date.now() - 1, retry.launch_id)
    const finalCallId = 'd'.repeat(32)
    await expect(jobs.launchAndEnqueueContentJob(
      'Overlapping topic',
      'overlapping-session',
      vi.fn().mockResolvedValue({
        call_id: finalCallId,
        started_at: new Date().toISOString(),
      }),
    )).resolves.toMatchObject({ call_id: finalCallId })
  })

  it('serializes launch discovery through durable enqueue', async () => {
    let activeLaunches = 0
    let maxActiveLaunches = 0
    const launch = vi.fn().mockImplementation(async (_topic: string, sessionId: string) => {
      activeLaunches += 1
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches)
      await new Promise((resolve) => setTimeout(resolve, 15))
      activeLaunches -= 1
      return {
        call_id: sessionId === 'session-a' ? '8'.repeat(32) : '9'.repeat(32),
        started_at: '2026-07-14T10:00:00.000Z',
      }
    })

    const [first, second] = await Promise.all([
      jobs.launchAndEnqueueContentJob('First topic', 'session-a', launch),
      jobs.launchAndEnqueueContentJob('Second topic', 'session-b', launch),
    ])

    expect(maxActiveLaunches).toBe(1)
    expect(jobs.getContentJob(first.call_id)?.sessionId).toBe('session-a')
    expect(jobs.getContentJob(second.call_id)?.sessionId).toBe('session-b')
  })

  it('keeps completed upstream content pending and unlinkable until durable publication', async () => {
    const chat = await import('../server/chat')
    const callId = 'b'.repeat(32)
    const pending = enqueue(callId)
    const upstream: import('../server/chat').ChatLogEntry = {
      id: callId,
      session_id: 'chat-session',
      prompt: 'A durable article',
      started_at: '2026-07-14T10:00:00.000Z',
      status: 'completed',
      response: '1234abcd',
      error: '',
      behavior: 'author_content',
    }

    expect(chat.mergeAuthorContentJobState(upstream)).toMatchObject({ status: 'pending' })
    expect(chat.mergeAuthorContentJobState(upstream).content_slug).toBeUndefined()
    await expect(chat.existingContentSlugForCallId(callId)).resolves.toBeNull()

    await jobs.runContentFinalizerOnce({
      dependencies: {
        inspectCall: vi.fn().mockResolvedValue({ status: 'completed', response_hash: '1234abcd' }),
        readResponse: vi.fn().mockResolvedValue('# Published before linked'),
      },
    })
    expect(chat.mergeAuthorContentJobState(upstream)).toMatchObject({
      status: 'completed',
      content_slug: pending.slug,
    })
    await expect(chat.existingContentSlugForCallId(callId)).resolves.toBe(pending.slug)
  })

  it('retries operational finalization errors indefinitely with durable backoff state', async () => {
    const pending = enqueue('f'.repeat(32))
    const inspectCall = vi.fn().mockResolvedValue({ status: 'completed', response_hash: 'retry-response' })
    const readResponse = vi.fn().mockRejectedValue(new Error('temporary response store outage'))

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await jobs.runContentFinalizerOnce({
        workerId: `retry-worker-${attempt}`,
        retryDelayMs: 0,
        dependencies: { inspectCall, readResponse },
      })
    }
    expect(jobs.getContentJob(pending.call_id)).toMatchObject({
      status: 'pending',
      errorCount: 7,
      error: 'temporary response store outage',
    })

    readResponse.mockResolvedValueOnce('# Recovered article')
    await jobs.runContentFinalizerOnce({
      workerId: 'recovered-worker',
      retryDelayMs: 0,
      dependencies: { inspectCall, readResponse },
    })
    expect(jobs.getContentJobResponse(pending.call_id)?.status).toBe('completed')
  })

  it('migrates earlier content_jobs tables additively and idempotently', async () => {
    await jobs.stopContentFinalizer()
    database.closeDatabase()
    const path = process.env.POISE_DB as string
    await Promise.all([
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ])

    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE content_jobs (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        slug TEXT NOT NULL,
        response_hash TEXT,
        error TEXT,
        article_created INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `)
    legacy.prepare(`
      INSERT INTO content_jobs (
        call_id, session_id, topic, started_at, status, slug, created_at, updated_at
      ) VALUES (?, 'legacy-session', 'Legacy topic', ?, 'pending', 'content-legacy', ?, ?)
    `).run('c'.repeat(32), new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
    legacy.close()

    vi.resetModules()
    await loadModules()
    expect(database.db.prepare(`
      SELECT next_attempt_at, error_count FROM content_jobs WHERE call_id = ?
    `).get('c'.repeat(32))).toEqual({ next_attempt_at: 0, error_count: 0 })
    await restartModules()
    expect(database.db.prepare(`
      SELECT next_attempt_at, error_count FROM content_jobs WHERE call_id = ?
    `).get('c'.repeat(32))).toEqual({ next_attempt_at: 0, error_count: 0 })
  })

  it('upgrades pending legacy launch intents with a finite recoverable deadline', async () => {
    await jobs.stopContentFinalizer()
    database.closeDatabase()
    const path = process.env.POISE_DB as string
    await Promise.all([
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ])

    const requestedAt = new Date().toISOString()
    const launchId = 'legacy-launch-intent'
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE content_launches (
        launch_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'failed')),
        call_id TEXT UNIQUE,
        error TEXT,
        updated_at TEXT NOT NULL
      )
    `)
    legacy.prepare(`
      INSERT INTO content_launches (
        launch_id, session_id, topic, requested_at, status, updated_at
      ) VALUES (?, 'upgraded-session', 'Upgraded topic', ?, 'pending', ?)
    `).run(launchId, requestedAt, requestedAt)
    legacy.close()

    vi.resetModules()
    await loadModules()
    const migrated = database.db.prepare(`
      SELECT registration_deadline_at, recovery_eligible, status
      FROM content_launches WHERE launch_id = ?
    `).get(launchId) as {
      registration_deadline_at: number
      recovery_eligible: number
      status: string
    }
    expect(migrated).toEqual({
      registration_deadline_at:
        (Math.floor(Date.parse(requestedAt) / 1_000) * 1_000)
        + database.CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
      recovery_eligible: 1,
      status: 'pending',
    })

    await restartModules()
    expect(database.db.prepare(`
      SELECT registration_deadline_at, recovery_eligible
      FROM content_launches WHERE launch_id = ?
    `).get(launchId)).toEqual({
      registration_deadline_at: migrated.registration_deadline_at,
      recovery_eligible: 1,
    })
    database.db.prepare(`
      UPDATE content_launches SET registration_deadline_at = ? WHERE launch_id = ?
    `).run(Date.now() - 1, launchId)
    const retryCallId = 'e'.repeat(32)
    await expect(jobs.launchAndEnqueueContentJob(
      'Upgraded topic',
      'upgraded-session',
      vi.fn().mockResolvedValue({
        call_id: retryCallId,
        started_at: new Date().toISOString(),
      }),
    )).resolves.toMatchObject({ call_id: retryCallId })
    expect(database.db.prepare(`
      SELECT status FROM content_launches WHERE launch_id = ?
    `).get(launchId)).toEqual({ status: 'failed' })
  })

  it('returns 413 before /content spawn and exposes only durable status records', async () => {
    const cache = await import('../server/cache-plugin')
    const middleware = cache.createPoiseMiddleware({
      claudeAuth: createAuthenticatedClaudeAuth(),
    })
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    await cache.stopPoiseRuntime()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const base = `http://127.0.0.1:${address.port}`

    try {
      const oversized = await fetch(`${base}/api/chat-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'cap-session', topic: 'x'.repeat((64 * 1024) + 1) }),
      })
      expect(oversized.status).toBe(413)
      expect(database.db.prepare('SELECT COUNT(*) AS count FROM content_launches').get())
        .toEqual({ count: 0 })

      const pending = enqueue('d'.repeat(32))
      const status = await fetch(
        `${base}/api/chat-content/status?call_id=${encodeURIComponent(pending.call_id)}`,
      )
      expect(status.status).toBe(200)
      await expect(status.json()).resolves.toMatchObject({
        call_id: pending.call_id,
        status: 'pending',
        slug: pending.slug,
      })

      // Short response markers are not accepted as route identities.
      expect((await fetch(`${base}/api/agent-response/deadbeef`)).status).toBe(404)
    } finally {
      await cache.stopPoiseRuntime()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
