import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

let root = ''
let staticDir = ''
let server: Server
let baseUrl = ''
let production: typeof import('../server/production')
const auth = createAuthenticatedClaudeAuth()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-production-test-'))
  // The parent segment deliberately has the same name as Vite's asset
  // directory; index.html must still be no-cache.
  staticDir = join(root, 'assets', 'client')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Poise test</title>')
  await writeFile(join(staticDir, 'assets', 'app.js'), 'export {}')
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent')
  vi.resetModules()
  production = await import('../server/production')
  server = production.createProductionServer({ staticDir, claudeAuth: auth })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  const { stopBehaviorsRuntime } = await import('../server/behaviors')
  const { closeDatabase } = await import('../server/db')
  await stopBehaviorsRuntime()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase()
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'POISE_CHAT_ATTACHMENTS_DIR',
    'POISE_ESPANSO_MATCH_DIR',
    'AGENT_INTERFACE_ROOT',
  ]) delete process.env[key]
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('production server', () => {
  it('serves the built client with security headers', async () => {
    const response = await fetch(baseUrl, { headers: { Accept: 'text/html' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Poise test')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const csp = response.headers.get('content-security-policy') || ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('https://fonts.googleapis.com')
    expect(csp).toContain('https://fonts.gstatic.com')

    const asset = await fetch(`${baseUrl}/assets/app.js`)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it.runIf(process.platform !== 'win32')('does not serve symlinks that escape the static root', async () => {
    const secret = 'outside-static-root'
    const outside = join(root, 'outside.txt')
    const assetLink = join(staticDir, 'assets', 'leak.txt')
    await writeFile(outside, secret, 'utf8')
    await symlink(outside, assetLink)
    try {
      const asset = await fetch(`${baseUrl}/assets/leak.txt`)
      expect(asset.status).toBe(404)
      expect(await asset.text()).not.toContain(secret)
    } finally {
      await rm(assetLink, { force: true })
    }

    const index = join(staticDir, 'index.html')
    const backup = join(staticDir, 'index.real.html')
    await rename(index, backup)
    try {
      await symlink(outside, index)
      const fallback = await fetch(`${baseUrl}/missing-spa-route`, {
        headers: { Accept: 'text/html' },
      })
      expect(fallback.status).toBe(503)
      expect(await fallback.text()).not.toContain(secret)
    } finally {
      await rm(index, { force: true })
      await rename(backup, index)
    }
  })

  it('serves health and rejects unknown APIs', async () => {
    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      scheduler: {
        status: 'ok',
        running: true,
        startedAt: expect.any(String),
        busy: [],
        failures: [],
      },
    })
    expect((await fetch(`${baseUrl}/api/unknown`)).status).toBe(404)
  })

  it('returns 503 while an enabled behavior is backing off after failure', async () => {
    const { setMeta } = await import('../server/db')
    const now = Date.now()
    setMeta('behavior_resolve_unblocking_enabled', '1')
    setMeta('behavior_resolve_unblocking_failure', JSON.stringify({
      kind: 'operation',
      consecutiveFailures: 3,
      lastFailureAtMs: now,
      nextRetryAtMs: now + 60_000,
    }))
    try {
      const health = await fetch(`${baseUrl}/api/health`)
      expect(health.status).toBe(503)
      await expect(health.json()).resolves.toMatchObject({
        status: 'degraded',
        scheduler: {
          failures: [{
            behavior: 'resolve-unblocking',
            kind: 'operation',
            consecutiveFailures: 3,
          }],
        },
      })
    } finally {
      setMeta('behavior_resolve_unblocking_enabled', '0')
      setMeta('behavior_resolve_unblocking_failure', '')
    }
  })

  it('exposes sanitized auth health and starts one subscription login', async () => {
    auth.setStatus('reauth_required')
    const status = await fetch(`${baseUrl}/api/claude-auth`)
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({
      status: 'reauth_required',
      reason: 'Claude subscription sign-in is required.',
      checkedAt: '2026-07-15T09:00:00.000Z',
      verifiedAt: '2026-07-15T09:00:00.000Z',
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginInProgress: false,
    })

    const first = await fetch(`${baseUrl}/api/claude-auth/login`, { method: 'POST' })
    const second = await fetch(`${baseUrl}/api/claude-auth/login`, { method: 'POST' })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(auth.logins).toBe(1)
    await expect(second.json()).resolves.toMatchObject({
      status: 'signing_in',
      loginInProgress: true,
    })
    auth.setStatus('authenticated')
  })

  it('rejects cross-origin mutation attempts', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })

  it('rejects malformed editor replacements without erasing stored data', async () => {
    const docUrl = `${baseUrl}/api/editor/doc/validation-test`
    const jsonHeaders = { 'Content-Type': 'application/json' }
    const editor = await import('../server/editor')
    await editor.writeDoc('validation-test', '# retained')
    expect((await fetch(docUrl, {
      method: 'PUT', headers: jsonHeaders, body: '{}',
    })).status).toBe(400)
    await expect((await fetch(docUrl)).json()).resolves.toMatchObject({ content: '# retained' })

    const annotationsUrl = `${docUrl}/annotations`
    await editor.writeAnnotations('validation-test', { annotations: [] })
    expect((await fetch(annotationsUrl, {
      method: 'PUT', headers: jsonHeaders, body: '{}',
    })).status).toBe(400)
    await expect((await fetch(annotationsUrl)).json()).resolves.toMatchObject({ annotations: [] })
  })

  it('returns 409 instead of allowing a stale tab to overwrite a document', async () => {
    const url = `${baseUrl}/api/editor/doc/cas-test`
    const headers = { 'Content-Type': 'application/json' }
    const editor = await import('../server/editor')
    await editor.writeDoc('cas-test', '# base')
    const initial = await (await fetch(url)).json() as { version: string }
    const first = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        content: '# tab A', client_id: 'tab-a', revision: 1, base_version: initial.version,
      }),
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { version: string }

    const conflict = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        content: '# tab B', client_id: 'tab-b', revision: 1, base_version: initial.version,
      }),
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ current_version: firstBody.version })
    await expect((await fetch(url)).json()).resolves.toMatchObject({ content: '# tab A' })
  })

  it('requires version preconditions on HTTP editor writes', async () => {
    const headers = { 'Content-Type': 'application/json' }
    expect((await fetch(`${baseUrl}/api/editor/doc/validation-test`, {
      method: 'PUT', headers, body: JSON.stringify({ content: '# unsafe legacy write' }),
    })).status).toBe(428)
    expect((await fetch(`${baseUrl}/api/editor/doc/validation-test/annotations`, {
      method: 'PUT', headers, body: JSON.stringify({ annotations: [] }),
    })).status).toBe(428)
  })

  it('validates a complete behavior update before changing state', async () => {
    const url = `${baseUrl}/api/behaviors/review-new-prs`
    const headers = { 'Content-Type': 'application/json' }
    expect((await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ enabled: 'false' }),
    })).status).toBe(400)
    expect((await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ enabled: true, setting: 'invalid' }),
    })).status).toBe(400)

    const state = await (await fetch(`${baseUrl}/api/behaviors`)).json() as Record<string, { enabled: boolean }>
    expect(state['review-new-prs'].enabled).toBe(false)
  })

  it.each([0, -1, 1.5, 65_536, Number.NaN])('rejects invalid production port %s', async (port) => {
    await expect(production.startProductionServer({ staticDir, port })).rejects.toThrow(/POISE_PORT/)
  })

  it('validates Confab URLs before creating or starting a server', async () => {
    expect(() => production.createProductionServer({
      staticDir,
      confabUrl: 'http://confab.example',
    })).toThrow(/must use HTTPS/)
    await expect(production.startProductionServer({
      staticDir,
      port: 55_555,
      confabUrl: 'file:///tmp/confab.sock',
    })).rejects.toThrow(/must use HTTP or HTTPS/)
  })

  it('stops the behavior runtime when its port is already occupied', async () => {
    const blocker = createHttpServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('blocker did not bind')

    const { stopBehaviorsRuntime } = await import('../server/behaviors')
    await stopBehaviorsRuntime()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await expect(production.startProductionServer({ staticDir, port: address.port }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' })
      await vi.runOnlyPendingTimersAsync()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
