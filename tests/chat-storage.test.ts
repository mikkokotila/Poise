import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot = ''
let database: typeof import('../server/db') | null = null

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-chat-storage-test-'))
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(tempRoot, 'attachments')
  process.env.TMPDIR = join(tempRoot, 'tmp')
  vi.resetModules()
})

afterEach(async () => {
  if (database?.db.open) database.closeDatabase()
  database = null
  delete process.env.POISE_DB
  delete process.env.POISE_CHAT_ATTACHMENTS_DIR
  delete process.env.TMPDIR
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('chat attachment storage', () => {
  it('contains hostile sessions and never overwrites a prior upload', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')

    const first = await chat.saveAttachment('..', '../report.pdf', Buffer.from('first'))
    const second = await chat.saveAttachment('..', '../report.pdf', Buffer.from('second'))

    expect(first.name).not.toBe(second.name)
    expect(first.name).toMatch(/^[0-9a-f-]+-report\.pdf$/)
    const sessionDirs = await readdir(join(tempRoot, 'attachments'))
    expect(sessionDirs).toHaveLength(1)
    expect(await readFile(join(tempRoot, 'attachments', sessionDirs[0], first.name), 'utf8')).toBe('first')
    expect(await readFile(join(tempRoot, 'attachments', sessionDirs[0], second.name), 'utf8')).toBe('second')
  })

  it('keeps distinct long session identifiers in distinct worktrees', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')
    const common = 'session-' + 'a'.repeat(220)

    await chat.saveAttachment(common + 'x', 'note.txt', Buffer.from('x'))
    await chat.saveAttachment(common + 'y', 'note.txt', Buffer.from('y'))

    const sessionDirs = await readdir(join(tempRoot, 'attachments'))
    expect(sessionDirs).toHaveLength(2)
    expect(new Set(sessionDirs).size).toBe(2)
    expect(sessionDirs.every((name) => name.length <= 185)).toBe(true)
  })
})
