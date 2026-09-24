import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import release from '../config/caller-release.json'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

// Choosing a repository for Review New Issues checks it against the
// organization's list; the test organization has two.
vi.mock('../server/gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/gh')>()),
  listOrgRepos: vi.fn(async () => ['Vaquum/Limen', 'Vaquum/Origo']),
}))

const EXPECTED_CALLER_COMMIT = 'a'.repeat(40)
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
  process.env.POISE_PRODUCTION_UPDATE_REPORT = join(root, 'production-update.json')
  vi.resetModules()
  production = await import('../server/production')
  server = production.createProductionServer({
    staticDir,
    claudeAuth: auth,
    reviewAgentUsername: 'bit-mis',
  })
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
    'POISE_PRODUCTION_UPDATE_REPORT',
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
      claudeAuth: {
        status: 'authenticated',
        authMethod: 'claude.ai',
        subscriptionType: 'max',
      },
      callerRelease: {
        status: 'unmanaged',
        required: false,
        expectedCommit: '',
      },
      // No updater record yet: nothing is claimed about production.
      production: { status: 'unknown', checkedAt: null, deployedCommit: null },
    })
    expect((await fetch(`${baseUrl}/api/unknown`)).status).toBe(404)
  })

  it('passes the production updater record through health, validated', async () => {
    const deployed = 'b'.repeat(40)
    const remote = 'c'.repeat(40)
    const path = process.env.POISE_PRODUCTION_UPDATE_REPORT!
    await writeFile(path, JSON.stringify({
      at: '2026-09-18T12:00:00.000Z',
      status: 'failed',
      action: null,
      error: '  Remote Poise main is not a fast-forward of the deployed commit\n',
      failingSince: '2026-09-18T11:55:00.000Z',
      poise: { deployed, installed: deployed, remote, behind: 2 },
      caller: 'd'.repeat(40),
    }))
    try {
      await expect((await fetch(`${baseUrl}/api/health`)).json()).resolves.toMatchObject({
        status: 'ok',
        production: {
          status: 'failed',
          checkedAt: '2026-09-18T12:00:00.000Z',
          deployedCommit: deployed,
          remoteCommit: remote,
          behind: 2,
          failingSince: '2026-09-18T11:55:00.000Z',
          error: 'Remote Poise main is not a fast-forward of the deployed commit',
        },
      })

      // A successful run carries no failure fields, and junk in the record
      // is dropped rather than shown.
      await writeFile(path, JSON.stringify({
        at: '2026-09-18T12:01:00.000Z',
        status: 'current',
        error: 'stale text from an old run',
        failingSince: '2026-09-18T11:55:00.000Z',
        poise: { deployed, remote: 'not-a-sha', behind: -1 },
      }))
      await expect((await fetch(`${baseUrl}/api/health`)).json()).resolves.toMatchObject({
        production: {
          status: 'current',
          checkedAt: '2026-09-18T12:01:00.000Z',
          deployedCommit: deployed,
          remoteCommit: null,
          behind: null,
          failingSince: null,
          error: null,
        },
      })

      await writeFile(path, '{"at": "never"}')
      await expect((await fetch(`${baseUrl}/api/health`)).json()).resolves.toMatchObject({
        production: { status: 'unknown' },
      })
    } finally {
      await rm(path, { force: true })
    }
  })

  it('returns 503 when Claude-backed behavior work is enabled without authentication', async () => {
    const { setMeta } = await import('../server/db')
    setMeta('behavior_review_new_prs_enabled', '1')
    auth.setStatus('reauth_required')
    try {
      const health = await fetch(`${baseUrl}/api/health`)
      expect(health.status).toBe(503)
      await expect(health.json()).resolves.toMatchObject({
        status: 'degraded',
        scheduler: { status: 'ok' },
        claudeAuth: {
          status: 'reauth_required',
          reason: 'Claude subscription sign-in is required.',
        },
      })
    } finally {
      setMeta('behavior_review_new_prs_enabled', '0')
      auth.setStatus('authenticated')
    }
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

  it('keeps the reviewer count on the initial review only, one to three', async () => {
    const url = `${baseUrl}/api/behaviors/review-new-prs`
    const headers = { 'Content-Type': 'application/json' }
    for (const reviewers of [0, 4, '2', null]) {
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ reviewers }) })).status).toBe(400)
    }
    expect((await fetch(`${baseUrl}/api/behaviors/approve-prs`, { method: 'POST', headers, body: JSON.stringify({ reviewers: 2 }) })).status).toBe(400)
    const ok = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ reviewers: 3 }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ reviewers: 3 })
    const state = await (await fetch(`${baseUrl}/api/behaviors`)).json() as Record<string, { reviewers: number | null }>
    expect(state['review-new-prs'].reviewers).toBe(3)
    expect(state['approve-prs'].reviewers).toBeNull()
  })

  it('opts repositories and trusted authors into Review New Issues, validated', async () => {
    const url = `${baseUrl}/api/behaviors/review-new-issues`
    const headers = { 'Content-Type': 'application/json' }
    const read = async () => (await (await fetch(`${baseUrl}/api/behaviors`)).json() as Record<string, Record<string, unknown>>)['review-new-issues']
    expect(await read()).toMatchObject({
      owner: 'bit-mis', enabled: false, setting: null, reviewers: 1,
      repos: [], authors: ['mikkokotila', 'zero-bang', 'bit-mis'], lastTriggered: null,
    })
    for (const body of [
      { repos: 'Vaquum/Origo' },
      { repos: ['not a repository'] },
      { repos: ['Vaquum/Unknown'] },
      { authors: ['not a name'] },
      { authors: 'mikkokotila' },
      { reviewers: 4 },
      { enabled: true, repos: ['Vaquum/Unknown'] },
    ]) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect((await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ repos: ['Vaquum/Unknown'] }) })).json()).error)
      .toBe('not a repository of the organization: Vaquum/Unknown')
    // Repositories and authors belong to this behavior only.
    expect((await fetch(`${baseUrl}/api/behaviors/review-new-prs`, { method: 'POST', headers, body: JSON.stringify({ repos: ['Vaquum/Origo'] }) })).status).toBe(400)
    expect(await read()).toMatchObject({ enabled: false, repos: [] })

    const ok = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ repos: ['Vaquum/Origo'], authors: ['mikkokotila'], reviewers: 2 }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ repos: ['Vaquum/Origo'], authors: ['mikkokotila'], reviewers: 2 })
    expect(await read()).toMatchObject({ repos: ['Vaquum/Origo'], authors: ['mikkokotila'], reviewers: 2 })
    // The pull-request panel keeps its own count.
    expect((await (await fetch(`${baseUrl}/api/behaviors`)).json() as Record<string, { reviewers: number }>)['review-new-prs'].reviewers).not.toBe(2)

    const cleared = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ repos: [] }) })
    expect(await cleared.json()).toMatchObject({ repos: [] })
  })

  // Two Poise windows open on the same behavior used to mean the later save
  // silently discarded the earlier one — a memory is prose someone wrote, and
  // losing it leaves no trace that it existed.
  it('refuses a memory write when the stored value moved underneath it', async () => {
    const url = `${baseUrl}/api/behaviors/review-new-prs`
    const headers = { 'Content-Type': 'application/json' }
    await fetch(url, { method: 'POST', headers, body: JSON.stringify({ scratchpad: 'from window A' }) })

    const stale = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ scratchpad: 'from window B', scratchpadPrevious: '' }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ scratchpad: 'from window A' })

    const state = await (await fetch(`${baseUrl}/api/behaviors`)).json() as Record<string, { scratchpad?: string }>
    expect(state['review-new-prs'].scratchpad).toBe('from window A')

    // Re-reading and saving against the current value goes through.
    const ok = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ scratchpad: 'from window B', scratchpadPrevious: 'from window A' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ scratchpad: 'from window B' })
  })

  it.each([0, -1, 1.5, 65_536, Number.NaN])('rejects invalid production port %s', async (port) => {
    await expect(production.startProductionServer({ staticDir, port })).rejects.toThrow(/POISE_PORT/)
  })

  it('fails closed when production has no managed Caller release', async () => {
    await expect(production.startProductionServer({ staticDir, port: 5556 }))
      .rejects.toThrow(/POISE_ENFORCE_CALLER_RELEASE/)
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
    const releaseRoot = join(root, 'caller-release')
    const binRoot = join(releaseRoot, 'venv', 'bin')
    const agentRoot = join(releaseRoot, 'source', 'agent_interface')
    await mkdir(binRoot, { recursive: true })
    await mkdir(agentRoot, { recursive: true })
    for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
      const path = join(binRoot, command)
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o700)
    }
    await writeFile(join(releaseRoot, 'release.json'), JSON.stringify({
      repository: 'mikkokotila/caller',
      ref: release.ref,
      commit: EXPECTED_CALLER_COMMIT,
      packages: {
        'agent-interface': '0.3.0',
        'github-datastore': '0.2.0',
        'github-interface': '0.2.0',
      },
    }))
    process.env.POISE_ENFORCE_CALLER_RELEASE = '1'
    process.env.CALLER_RELEASE_SHA = EXPECTED_CALLER_COMMIT
    process.env.CALLER_RELEASE_ROOT = releaseRoot
    process.env.CALLER_BIN_ROOT = binRoot
    process.env.AGENT_INTERFACE_ROOT = agentRoot

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
      for (const key of [
        'POISE_ENFORCE_CALLER_RELEASE',
        'CALLER_RELEASE_SHA',
        'CALLER_RELEASE_ROOT',
        'CALLER_BIN_ROOT',
      ]) delete process.env[key]
      process.env.AGENT_INTERFACE_ROOT = join(root, 'agent')
    }
  })
})
