import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchAgentLogs: vi.fn(),
  runFile: vi.fn(),
  spawnDetached: vi.fn(),
}))

vi.mock('../server/agent', () => ({ fetchAgentLogs: mocks.fetchAgentLogs }))
vi.mock('../server/process', () => ({
  MAX_PROCESS_ARG_BYTES: 64 * 1024,
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
}))

let root = ''
let database: typeof import('../server/db') | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-runtime-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'attachments')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.TMPDIR = join(root, 'tmp')
  mocks.fetchAgentLogs.mockReset().mockResolvedValue([])
  mocks.runFile.mockReset()
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
})

afterEach(async () => {
  if (database?.db.open) database.closeDatabase()
  database = null
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'POISE_CHAT_ATTACHMENTS_DIR',
    'AGENT_INTERFACE_ROOT',
    'TMPDIR',
  ]) delete process.env[key]
  vi.restoreAllMocks()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function worktreeName(session: string): string {
  const readable = session.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'session'
  return `${readable}-${createHash('sha256').update(session).digest('hex')}`
}

describe('chat runtime hardening', () => {
  it('atomically migrates only uniquely attributable legacy attachment directories', async () => {
    const attachments = join(root, 'attachments')
    const legacyTmp = join(root, 'tmp', 'poise-chat')
    await Promise.all([
      mkdir(join(attachments, 'owner_repo'), { recursive: true }),
      mkdir(join(attachments, 'collision_name'), { recursive: true }),
      mkdir(join(attachments, 'orphan'), { recursive: true }),
      mkdir(join(legacyTmp, 'temp_session'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(attachments, 'owner_repo', 'one.txt'), 'durable legacy'),
      writeFile(join(attachments, 'collision_name', 'two.txt'), 'ambiguous'),
      writeFile(join(attachments, 'orphan', 'three.txt'), 'unknown'),
      writeFile(join(legacyTmp, 'temp_session', 'four.txt'), 'temporary legacy'),
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    const result = await chat.migrateLegacyChatAttachments(async () => [
      { session_id: 'owner/repo' },
      { session_id: 'temp/session' },
      { session_id: 'collision/name' },
      { session_id: 'collision?name' },
    ])

    expect(result).toEqual({ migrated: 2, quarantined: 2 })
    await expect(readFile(join(attachments, worktreeName('owner/repo'), 'one.txt'), 'utf8'))
      .resolves.toBe('durable legacy')
    await expect(readFile(join(attachments, worktreeName('temp/session'), 'four.txt'), 'utf8'))
      .resolves.toBe('temporary legacy')
    await expect(readFile(join(attachments, 'collision_name', 'two.txt'), 'utf8'))
      .resolves.toBe('ambiguous')
    await expect(readFile(join(attachments, 'orphan', 'three.txt'), 'utf8'))
      .resolves.toBe('unknown')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('fails closed on a transient log lookup and retries before creating a worktree', async () => {
    const attachments = join(root, 'attachments')
    await mkdir(join(attachments, 'owner_repo'), { recursive: true })
    await writeFile(join(attachments, 'owner_repo', 'one.txt'), 'durable legacy')
    mocks.fetchAgentLogs
      .mockRejectedValueOnce(new Error('logs unavailable'))
      .mockResolvedValue([{ session_id: 'owner/repo' }])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.sendChat('owner/repo', 'hello'))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(readFile(join(attachments, 'owner_repo', 'one.txt'), 'utf8'))
      .resolves.toBe('durable legacy')
    await expect(readFile(join(attachments, worktreeName('owner/repo'), 'one.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    await expect(chat.sendChat('owner/repo', 'hello')).resolves.toEqual({ ok: true })
    await expect(readFile(join(attachments, worktreeName('owner/repo'), 'one.txt'), 'utf8'))
      .resolves.toBe('durable legacy')
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('never reclassifies a current hash-format worktree as legacy', async () => {
    const attachments = join(root, 'attachments')
    const originalSession = 'original/session'
    const currentName = worktreeName(originalSession)
    const craftedTarget = worktreeName(currentName)
    await mkdir(join(attachments, currentName), { recursive: true })
    await writeFile(join(attachments, currentName, 'one.txt'), 'current attachment')
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.migrateLegacyChatAttachments(async () => [{ session_id: currentName }]))
      .resolves.toEqual({ migrated: 0, quarantined: 0 })
    await expect(readFile(join(attachments, currentName, 'one.txt'), 'utf8'))
      .resolves.toBe('current attachment')
    await expect(readFile(join(attachments, craftedTarget, 'one.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves editor context off argv, preserves the displayed prompt, and removes the context after exit', async () => {
    const editor = join(root, 'editor')
    await mkdir(editor, { recursive: true })
    const document = `# Brief\n\n${'context '.repeat(12_000)}`
    await writeFile(join(editor, 'brief.md'), document, 'utf8')
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await chat.sendChat('editor-brief-123', 'Review this draft.', 'gpt')

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const [, args, options] = mocks.spawnDetached.mock.calls[0] as [string, string[], {
      onExit: () => Promise<void>
    }]
    const prompt = args[1]
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(64 * 1024)
    expect(prompt).not.toContain('context context context')
    expect(prompt).toContain('Review this draft.')
    const contextRelative = prompt.match(/context file "([^"]+)"/)?.[1]
    expect(contextRelative).toBeTruthy()
    const contextPath = join(args[args.indexOf('--pwd') + 1], contextRelative!)
    await expect(readFile(contextPath, 'utf8')).resolves.toContain(document)

    mocks.fetchAgentLogs.mockResolvedValueOnce([{
      id: 'a'.repeat(32),
      pr_id: null,
      repo: null,
      actor: null,
      model: 'gpt',
      behavior: 'chat',
      session_id: 'editor-brief-123',
      prompt,
      started_at: '2026-07-14T10:00:00.000Z',
      time_elapsed: '',
      status: 'running',
      response: null,
      error: '',
    }])
    await expect(chat.listChatHistory('editor-brief-123')).resolves.toMatchObject([
      { prompt: 'Review this draft.' },
    ])

    await options.onExit()
    await expect(readFile(contextPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed before spawning when aggregate authored context exceeds its budget', async () => {
    const editor = join(root, 'editor')
    await mkdir(editor, { recursive: true })
    await writeFile(join(editor, 'budget.md'), `# Current\n${'c'.repeat(5 * 1024 * 1024 - 10)}`)
    const chat = await import('../server/chat')
    database = await import('../server/db')
    const now = '2026-07-14T10:00:00.000Z'
    const rows = []
    for (const letter of ['a', 'b', 'c']) {
      const callId = letter.repeat(32)
      const slug = chat.contentSlugForCallId(callId)
      await writeFile(join(editor, `${slug}.md`), `# Article ${letter}\n${letter.repeat(4 * 1024 * 1024 - 16)}`)
      database.db.prepare(`
        INSERT INTO content_jobs (
          call_id, session_id, topic, started_at, status, slug,
          response_hash, error, article_created, lease_owner,
          lease_expires_at, next_attempt_at, error_count, created_at,
          updated_at, completed_at
        ) VALUES (?, ?, ?, ?, 'completed', ?, 'response', NULL, 1, NULL, NULL, 0, 0, ?, ?, ?)
      `).run(callId, 'editor-budget-1', `Article ${letter}`, now, slug, now, now, now)
      rows.push({
        id: callId,
        behavior: 'author_content',
        session_id: 'editor-budget-1',
        status: 'completed',
        prompt: `Article ${letter}`,
        started_at: now,
      })
    }
    mocks.fetchAgentLogs.mockResolvedValue(rows)

    await expect(chat.sendChat('editor-budget-1', 'Continue.'))
      .rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('returns typed size failures before spawning oversized direct arguments', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.sendChat('session', 'x'.repeat(64 * 1024 + 1)))
      .rejects.toMatchObject({ statusCode: 413 })
    await expect(chat.runDebate('x'.repeat(64 * 1024 + 1)))
      .rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('marks a post-spawn log lookup failure as recoverable discovery state', async () => {
    const lookupError = new Error('agent logs temporarily unavailable')
    mocks.fetchAgentLogs
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(lookupError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Durable topic', 'durable-session'))
      .rejects.toMatchObject({
        name: 'AuthorContentDiscoveryUnavailableError',
        code: 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE',
        cause: lookupError,
      })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogs).toHaveBeenCalledTimes(2)
  })

  it('keeps a pre-spawn log lookup failure definite', async () => {
    const lookupError = new Error('initial agent logs unavailable')
    mocks.fetchAgentLogs.mockRejectedValueOnce(lookupError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Definite topic', 'definite-session'))
      .rejects.toBe(lookupError)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('keeps a rejected spawn definite without entering discovery', async () => {
    const spawnError = new Error('agent-interface executable missing')
    mocks.spawnDetached.mockRejectedValueOnce(spawnError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Definite topic', 'definite-session'))
      .rejects.toBe(spawnError)
    expect(mocks.fetchAgentLogs).toHaveBeenCalledOnce()
  })
})
