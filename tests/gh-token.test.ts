import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({
  MAX_PROCESS_ARG_BYTES: 64 * 1024,
  runFile: mocks.runFile,
  spawnDetached: vi.fn(),
}))

let tempRoot = ''
let database: typeof import('../server/db') | null = null

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-gh-token-test-'))
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  mocks.runFile.mockReset()
  vi.resetModules()
})

afterEach(async () => {
  if (database?.db.open) database.closeDatabase()
  database = null
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('GitHub issue identity', () => {
  it('rejects issue arguments that cannot be spawned portably', async () => {
    database = await import('../server/db')
    const { handleGhBody } = await import('../server/gh')

    const oversizedTitle = await handleGhBody({
      operation: 'open_issue',
      repository_full_name: 'acme/repo',
      title: '€'.repeat(22_000),
    })
    const oversizedBody = await handleGhBody({
      operation: 'open_issue',
      repository_full_name: 'acme/repo',
      title: 'small',
      body: 'x'.repeat(64 * 1024),
    })

    expect(oversizedTitle.status).toBe(413)
    expect(oversizedBody.status).toBe(413)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('resolves and uses only the selected github.com credential', async () => {
    mocks.runFile
      .mockResolvedValueOnce({ stdout: 'selected-token\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          state: 'open',
          title: 'Pinned identity',
          html_url: 'https://github.com/acme/repo/issues/42',
          user: { login: 'octocat' },
        }),
        stderr: '',
      })
    database = await import('../server/db')
    database.setMeta('me', 'octocat')
    const { handleGhBody } = await import('../server/gh')

    const result = await handleGhBody({
      operation: 'open_issue',
      repository_full_name: 'acme/repo',
      title: 'Pinned identity',
    })

    expect(result.status).toBe(200)
    expect(mocks.runFile.mock.calls[0][1]).toEqual([
      'auth', 'token', '--hostname', 'github.com', '--user', 'octocat',
    ])
    expect(mocks.runFile.mock.calls[0][2].env).toEqual({
      GH_HOST: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
    })
    expect(mocks.runFile.mock.calls[1][2].env).toEqual({
      GH_HOST: 'github.com',
      GH_TOKEN: 'selected-token',
      GITHUB_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
    })
  })
})
