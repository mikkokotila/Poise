import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root = ''

afterEach(async () => {
  delete process.env.POISE_ESPANSO_MATCH_DIR
  vi.resetModules()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('snippet persistence', () => {
  it('does not lose concurrent append requests', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const snippets = await import('../server/snippets')

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      snippets.addSnippet({ trigger: `;item-${index}`, replace: `value ${index}` })
    )))

    const saved = await snippets.listSnippets()
    expect(saved).toHaveLength(20)
    expect(new Set(saved.map((item) => item.trigger))).toHaveLength(20)
  })

  it('does not lose appends from independent module/process queues', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const firstProcess = await import('../server/snippets')
    vi.resetModules()
    const secondProcess = await import('../server/snippets')

    await Promise.all(Array.from({ length: 30 }, (_, index) => {
      const writer = index % 2 === 0 ? firstProcess : secondProcess
      return writer.addSnippet({ trigger: `;cross-${index}`, replace: `value ${index}` })
    }))

    const saved = await firstProcess.listSnippets()
    expect(saved).toHaveLength(30)
    expect(new Set(saved.map((item) => item.trigger))).toHaveLength(30)
  })

  it('lets only one concurrent full-set replacement commit from a shared version', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const snippets = await import('../server/snippets')
    const initial = await snippets.readSnippetState()

    const first = snippets.saveSnippets([{ trigger: ';first', replace: 'first' }], initial.version)
    const second = snippets.saveSnippets([{ trigger: ';second', replace: 'second' }], initial.version)

    await expect(first).resolves.toMatchObject({ snippets: [{ trigger: ';first', replace: 'first' }] })
    await expect(second).rejects.toMatchObject({
      name: 'SnippetConflictError',
      code: 'SNIPPET_CONFLICT',
      statusCode: 409,
    })
    await expect(snippets.listSnippets()).resolves.toEqual([{ trigger: ';first', replace: 'first' }])
  })

  it('prevents a stale full-set save from erasing an editor append', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const snippets = await import('../server/snippets')
    const initial = await snippets.readSnippetState()
    const loaded = await snippets.saveSnippets(
      [{ trigger: ';base', replace: 'base' }],
      initial.version,
    )

    await snippets.addSnippet({ trigger: ';editor', replace: 'from editor' })
    await expect(snippets.saveSnippets(
      [{ trigger: ';base', replace: 'stale replacement' }],
      loaded.version,
    )).rejects.toBeInstanceOf(snippets.SnippetConflictError)
    await expect(snippets.listSnippets()).resolves.toEqual([
      { trigger: ';base', replace: 'base' },
      { trigger: ';editor', replace: 'from editor' },
    ])
  })

  it('detects a manual poise.yml edit even when its parsed set is unchanged', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const snippets = await import('../server/snippets')
    const initial = await snippets.readSnippetState()
    const saved = await snippets.saveSnippets(
      [{ trigger: ';manual', replace: 'value' }],
      initial.version,
    )

    await writeFile(join(root, 'poise.yml'), [
      '# edited by hand',
      'matches:',
      '  - trigger: ;manual',
      '    replace: value',
      '',
    ].join('\n'), 'utf8')

    await expect(snippets.saveSnippets(
      [{ trigger: ';manual', replace: 'stale value' }],
      saved.version,
    )).rejects.toMatchObject({ name: 'SnippetConflictError' })
    await expect(snippets.listSnippets()).resolves.toEqual([
      { trigger: ';manual', replace: 'value' },
    ])
  })

  it('rejects an oversized manually managed source before parsing it', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    await writeFile(join(root, 'poise.yml'), 'x'.repeat(1024 * 1024 + 1), 'utf8')
    vi.resetModules()
    const snippets = await import('../server/snippets')

    await expect(snippets.readSnippetState()).rejects.toThrow(/exceeds 1048576 bytes/)
  })

  it('does not write serialized YAML that its own reader would reject', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    vi.resetModules()
    const snippets = await import('../server/snippets')
    const initial = await snippets.readSnippetState()

    await expect(snippets.saveSnippets([{
      trigger: ';escaped',
      replace: '\u0001'.repeat(300_000),
    }], initial.version)).rejects.toThrow(/serialized snippets exceed 1048576 bytes/)
    await expect(snippets.readSnippetState()).resolves.toEqual(initial)
  })

  it('returns deterministic HTTP precondition and conflict responses', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-snippets-api-test-'))
    process.env.POISE_ESPANSO_MATCH_DIR = root
    process.env.POISE_DB = join(root, 'cache.db')
    process.env.POISE_EDITOR_DIR = join(root, 'editor')
    process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
    process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
    vi.resetModules()

    const { createPoiseMiddleware } = await import('../server/cache-plugin')
    const middleware = createPoiseMiddleware()
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const url = `http://127.0.0.1:${address.port}/api/snippets`
    const headers = { 'Content-Type': 'application/json' }

    try {
      const initial = await (await fetch(url)).json() as { version: string }
      const missingPrecondition = await fetch(url, {
        method: 'PUT', headers, body: JSON.stringify({ snippets: [] }),
      })
      expect(missingPrecondition.status).toBe(428)

      const created = await (await fetch(url, {
        method: 'PUT', headers,
        body: JSON.stringify({
          snippets: [{ trigger: ';base', replace: 'base' }],
          base_version: initial.version,
        }),
      })).json() as { version: string }
      const appended = await (await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ trigger: ';editor', replace: 'from editor' }),
      })).json() as { version: string }

      const conflict = await fetch(url, {
        method: 'PUT', headers,
        body: JSON.stringify({
          snippets: [{ trigger: ';base', replace: 'stale' }],
          base_version: created.version,
        }),
      })
      expect(conflict.status).toBe(409)
      await expect(conflict.json()).resolves.toEqual({
        error: 'snippets changed since they were loaded',
        current_version: appended.version,
      })
      await expect((await fetch(url)).json()).resolves.toMatchObject({
        snippets: [
          { trigger: ';base', replace: 'base' },
          { trigger: ';editor', replace: 'from editor' },
        ],
        version: appended.version,
      })
    } finally {
      const { stopPoiseRuntime } = await import('../server/cache-plugin')
      const { closeDatabase } = await import('../server/db')
      await stopPoiseRuntime()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      closeDatabase()
      for (const key of [
        'POISE_DB',
        'POISE_EDITOR_DIR',
        'POISE_CHAT_ATTACHMENTS_DIR',
        'AGENT_INTERFACE_ROOT',
      ]) delete process.env[key]
    }
  })
})
