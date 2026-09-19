import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readJson } from '../scripts/self-update/atomic.mjs'
import { runCli } from '../scripts/self-update/cli.mjs'
import { ControlError, ControlUnavailable, createControlClient, disabledStatus, statusOrDisabled } from '../scripts/self-update/client.mjs'
import { startDaemon } from '../scripts/self-update/daemon.mjs'
import { assertRecoveryRequest, createNonceStore, escapeHtml } from '../scripts/self-update/recovery.mjs'
import { BASE, HEAD, INSTANCE, SESSION, SESSION2, UUID, createHarness } from './self-update-harness.test.mjs'

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.once('error', reject)
  })
}

/** A raw loopback HTTP request with full header control, for the recovery UI. */
function http(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

const running = []
async function daemon(overrides = {}, adapters = {}) {
  const h = await createHarness(overrides)
  const recoveryPort = await freePort()
  const logs = []
  const started = await startDaemon({
    root: h.root,
    env: { HOME: h.root },
    log: (line) => logs.push(line),
    adapters: {
      git: h.git, github: h.github, releases: h.releases, app: h.app, restart: h.restart, runner: h.runner,
      enablement: async () => (h.model.enabled ? { enabled: true, reason: null } : { enabled: false, reason: 'self-update is disabled in config' }),
      loadToken: async () => 'github_pat_' + 'x'.repeat(30),
      now: h.clock.now, timing: { healthGraceMs: 10_000, restoreGraceMs: 10_000, drainMaxMs: 30_000 }, recoveryPort, ...adapters,
    },
  })
  const entry = { h, started, logs, recoveryPort, client: createControlClient({ socketPath: started.socketPath, timeoutMs: 5_000 }) }
  running.push(entry)
  return entry
}
afterEach(async () => {
  for (const entry of running.splice(0)) {
    await entry.started.stop().catch(() => {})
    await rm(entry.h.root, { recursive: true, force: true })
  }
})

describe('daemon lifecycle', () => {
  it('holds the controller lock, serves a private socket, writes a heartbeat and stops cleanly', async () => {
    const { h, started, client } = await daemon()
    expect(((await stat(started.socketPath)).mode & 0o777)).toBe(0o600)
    expect(((await stat(h.root)).mode & 0o777)).toBe(0o700)
    const lock = await readJson(started.paths.lockPath)
    expect(lock.pid).toBe(process.pid)
    const heartbeat = await readJson(started.paths.heartbeatPath)
    expect(heartbeat).toMatchObject({ pid: process.pid, status: 'running', pending: false, recoveryUrl: started.recoveryUrl })
    expect(await client.health()).toMatchObject({ ok: true, pid: process.pid })
    // A second daemon on the same root cannot start.
    await expect(startDaemon({ root: h.root, env: { HOME: h.root }, log: () => {}, adapters: {} })).rejects.toMatchObject({ code: 'LOCKED' })
    await started.stop()
    expect(await readJson(started.paths.lockPath, null)).toBeNull()
    expect((await readJson(started.paths.heartbeatPath)).status).toBe('stopped')
    await expect(client.status()).rejects.toBeInstanceOf(ControlUnavailable)
  })

  it('reaps worker process groups recorded by a previous controller', async () => {
    const h = await createHarness()
    const store = h.store
    await store.commit('test', (draft) => { draft.workers[999999] = { pid: 999999, command: 'npm ci', purpose: 'test', startedAt: 'x' } })
    const logs = []
    const started = await startDaemon({
      root: h.root, env: { HOME: h.root }, log: (line) => logs.push(line),
      adapters: { git: h.git, github: h.github, releases: h.releases, app: h.app, restart: h.restart, runner: h.runner, enablement: async () => ({ enabled: false, reason: 'off' }), loadToken: async () => 'x', recoveryPort: await freePort() },
    })
    try {
      expect(started.store.state.workers).toEqual({})
      expect(logs.some((line) => /reaped 1 worker/.test(line))).toBe(true)
    } finally {
      await started.stop()
      await rm(h.root, { recursive: true, force: true })
    }
  })
})

describe('default controller worker lifecycle', () => {
  it('uses the registered worker gate without a runner override', async () => {
    const { h, started } = await daemon({}, { runner: undefined })
    const work = started.runner.run(process.execPath, ['-e', 'setTimeout(() => console.log("settled"), 300)'], { env: { HOME: h.root }, purpose: 'default gate proof' })
    await expect.poll(() => Object.values(started.store.state.workers).length).toBe(1)
    const [record] = Object.values(started.store.state.workers)
    expect(record).toMatchObject({ ident: expect.any(String), pgid: record.pid })
    expect(record.argv).toContain('--self-update-worker')
    expect((await work).stdout.trim()).toBe('settled')
    expect(started.store.state.workers).toEqual({})
  })

  it('retains unidentified live groups instead of clearing their records or killing unrelated processes', async () => {
    const h = await createHarness()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    await once(child, 'spawn')
    let started
    try {
      await h.store.commit('test.worker', draft => { draft.workers[child.pid] = { pid: child.pid, purpose: 'unverified previous worker' } })
      started = await startDaemon({ root: h.root, env: { HOME: h.root }, log: () => {}, adapters: {
        git: h.git, github: h.github, releases: h.releases, app: h.app, restart: h.restart,
        enablement: async () => ({ enabled: true }), loadToken: async () => 'fixture', recoveryPort: await freePort(),
      } })
      expect(started.store.state.workers[child.pid]).toBeDefined()
      expect((await started.controller.status()).available).toBe(false)
      await started.tick()
      expect(child.exitCode).toBeNull()
      expect(started.store.state.workers[child.pid]).toBeDefined()
    } finally {
      if (started) await started.stop()
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
      await rm(h.root, { recursive: true, force: true })
    }
  })

  it('keeps the daemon lock until an in-flight check has finished', async () => {
    const { h, started, client } = await daemon()
    const prepared = await client.prepareChange({ id: UUID, sessionId: SESSION, instance: INSTANCE, request: 'Improve the session list' })
    h.git.commit(prepared.workspace, HEAD)
    let release, entered
    const waiting = new Promise(resolve => { release = resolve })
    const began = new Promise(resolve => { entered = resolve })
    const original = h.runner.run.bind(h.runner)
    h.runner.run = async (...args) => { entered(); await waiting; return original(...args) }
    await client.finishChange(UUID, { outcome: 'completed' })
    const tick = started.tick()
    await began
    const closing = started.stop()
    try {
      expect((await readJson(started.paths.lockPath)).pid).toBe(process.pid)
      expect(started.controller.reconciling).toBe(true)
    } finally { release(); await tick; await closing }
    expect(await readJson(started.paths.lockPath, null)).toBeNull()
  })
})

describe('control API over the Unix socket', () => {
  it('answers Status, validates bodies and routes, and reports controller errors with their status', async () => {
    const { client } = await daemon()
    const status = await client.status()
    expect(status).toMatchObject({ enabled: true, available: true, activeRelease: { id: 'baseline-release', sha: BASE }, changes: [] })
    expect(status.recoveryUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    await expect(client.request('GET', '/nope')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(client.request('POST', '/changes/not-a-uuid/finish', {})).rejects.toMatchObject({ status: 404 })
    await expect(client.prepareChange({ id: 'x' })).rejects.toMatchObject({ status: 400, code: 'invalid' })
    await expect(client.finishChange(UUID, { outcome: 'completed' })).rejects.toMatchObject({ status: 404, code: 'unknown_change' })
    await expect(client.rollbackRelease({ expectedReleaseId: 'nope!' })).rejects.toMatchObject({ status: 400 })
    const raw = await new Promise((resolve) => {
      const req = httpRequest({ socketPath: client.socketPath ?? running[0].started.socketPath, method: 'POST', path: '/changes', headers: { 'content-type': 'application/json' } }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.end('[not an object]')
    })
    expect(raw.status).toBe(400)
    expect(JSON.parse(raw.text).code).toBe('invalid')
  })

  it('rejects oversized bodies', async () => {
    const { client } = await daemon()
    const error = await client.prepareChange({ id: UUID, sessionId: SESSION, instance: INSTANCE, request: 'x'.repeat(70_000) }).catch((caught) => caught)
    expect(error).toBeInstanceOf(ControlError)
    expect(error.status).toBe(413)
  })

  it('drives a change end to end through the socket, queueing the check in the daemon', async () => {
    const { h, client, started } = await daemon()
    const prepared = await client.prepareChange({ id: UUID, sessionId: SESSION, instance: INSTANCE, request: 'Make the chat header sticky' })
    expect(prepared).toMatchObject({ change: { id: UUID, state: 'implementing', repository: 'mikkokotila/Poise' }, branch: `poise/change-${UUID}`, baseSha: BASE })
    expect(prepared.workspace).toBe(join(started.paths.workspacesDir, UUID))
    expect((await client.bindSession(UUID, { sessionId: SESSION2, instance: INSTANCE })).sessionId).toBe(SESSION2)
    expect((await client.status()).available).toBe(false)
    h.git.commit(prepared.workspace, HEAD)
    const finished = await client.finishChange(UUID, { outcome: 'completed' })
    // The answer comes back before the daemon has run anything.
    expect(finished.state).toBe('checking')
    // Let the daemon's reconciliation loop run the pipeline to completion.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { changes } = await client.status()
      if (changes[0]?.state === 'live') break
      await started.tick()
    }
    const live = (await client.status()).changes[0]
    expect(live).toMatchObject({ state: 'live', canRevert: true, prNumber: 100, headSha: HEAD })
    expect(live).not.toHaveProperty('workspace')
    expect(live).not.toHaveProperty('deploy')
    expect(h.restarts).toEqual([live.releaseId])

    // One-click rollback through the same socket, then independent completion.
    const acknowledged = await client.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    expect(acknowledged.state).toBe('reverting')
    await expect(client.rollbackChange(UUID, { expectedReleaseId: 'baseline-release' })).rejects.toMatchObject({ status: 409, code: 'stale' })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { changes } = await client.status()
      if (changes[0]?.state === 'reverted') break
      await started.tick()
    }
    const reverted = await client.status()
    expect(reverted.changes[0].state).toBe('reverted')
    expect(reverted.activeRelease.id).toBe('baseline-release')
    expect(reverted.hold).not.toBeNull()
    // /tick kicks reconciliation and returns Status immediately.
    expect((await client.tick()).activeRelease.id).toBe('baseline-release')
  })
})

describe('client helpers', () => {
  it('turns an unreachable daemon into a disabled Status rather than an error', async () => {
    const client = createControlClient({ socketPath: '/tmp/definitely-missing-poise-control.sock', timeoutMs: 500 })
    const status = await statusOrDisabled(client)
    expect(status).toMatchObject({ enabled: false, available: false, changes: [] })
    expect(status.reason).toMatch(/not running/)
    expect(disabledStatus('x')).toEqual({ enabled: false, available: false, reason: 'x', activeRelease: null, previousRelease: null, hold: null, changes: [] })
  })
})

describe('recovery UI', () => {
  it('serves an escaped, script-free page with a strict CSP and a single-use rollback form', async () => {
    const { h, recoveryPort, started } = await daemon()
    // Make a second release so rollback is possible, with a hostile title to escape.
    await started.controller.prepareChange({ id: UUID, sessionId: SESSION, instance: INSTANCE, request: '<script>alert(1)</script> & "quotes"' })
    h.git.commit(join(started.paths.workspacesDir, UUID), HEAD)
    await started.controller.finishChange(UUID, { outcome: 'completed' })
    for (let attempt = 0; attempt < 10 && started.store.state.changes[UUID].state !== 'live'; attempt += 1) await started.tick()
    const page = await http(recoveryPort)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'; style-src 'nonce-[^']+'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'/)
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.body).not.toContain('<script>alert(1)</script>')
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;')
    expect(page.body).not.toMatch(/<script/i)
    expect(page.body).not.toContain('github_pat_')
    expect(page.body).toContain('Roll back to previous release')
    expect(page.body).toContain('name="expectedReleaseId" value="20260919T100000Z-')
    const nonce = page.body.match(/name="nonce" value="([^"]+)"/)[1]
    const expected = page.body.match(/name="expectedReleaseId" value="([^"]+)"/)[1]

    const json = await http(recoveryPort, { path: '/status.json' })
    expect(json.status).toBe(200)
    expect(JSON.parse(json.body).activeRelease.id).toBe(expected)

    const form = (fields) => new URLSearchParams(fields).toString()
    const browserPost = (body, extra = {}) => http(recoveryPort, {
      method: 'POST', path: '/rollback', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${recoveryPort}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', ...extra },
    })
    // A forged or reused nonce is refused before any controller call.
    const forged = await browserPost(form({ nonce: 'forged', expectedReleaseId: expected }))
    expect(forged.status).toBe(403)
    expect(forged.body).toContain('expired')
    const accepted = await browserPost(form({ nonce, expectedReleaseId: expected }))
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain('Rollback pending')
    expect(started.store.state.rollbacks[`rollback-${expected}`]).toMatchObject({ phase: 'pending', expectedReleaseId: expected })
    const reused = await browserPost(form({ nonce, expectedReleaseId: expected }))
    expect(reused.status).toBe(403)
    for (let attempt = 0; attempt < 10 && started.store.state.changes[UUID].state !== 'reverted'; attempt += 1) await started.tick()
    expect((await started.store.readActivePointer()).id).toBe('baseline-release')
    // The hold-clearing form only appears while a hold stands, and works with a fresh nonce.
    const withHold = await http(recoveryPort)
    expect(withHold.body).toContain('Clear promotion hold')
    const holdNonce = withHold.body.match(/name="nonce" value="([^"]+)"/)[1]
    const cleared = await http(recoveryPort, {
      method: 'POST', path: '/clear-hold', body: form({ nonce: holdNonce }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${recoveryPort}`, 'sec-fetch-site': 'same-origin' },
    })
    expect(cleared.status).toBe(200)
    expect(started.store.state.hold).toBeNull()
  })

  it('refuses wrong hosts, cross-origin and non-browser POSTs, and unknown paths', async () => {
    const { recoveryPort } = await daemon()
    const form = new URLSearchParams({ nonce: 'x', expectedReleaseId: 'baseline-release' }).toString()
    const post = (headers) => http(recoveryPort, { method: 'POST', path: '/rollback', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } })
    expect((await http(recoveryPort, { headers: { host: `evil.example:${recoveryPort}` } })).status).toBe(403)
    expect((await http(recoveryPort, { headers: { host: '127.0.0.1:1' } })).status).toBe(403)
    expect((await http(recoveryPort, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await http(recoveryPort, { headers: { origin: 'http://attacker.example' } })).status).toBe(403)
    // POST without a browser origin (curl-style) is not a click.
    expect((await post({})).status).toBe(403)
    expect((await post({ origin: 'http://attacker.example' })).status).toBe(403)
    expect((await post({ origin: `http://127.0.0.1:${recoveryPort}`, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ origin: `http://127.0.0.1:${recoveryPort}`, 'sec-fetch-mode': 'no-cors' })).status).toBe(403)
    expect((await post({ origin: `http://localhost:${recoveryPort}`, host: `localhost:${recoveryPort}`, 'content-type': 'application/json' })).status).toBe(415)
    expect((await http(recoveryPort, { path: '/admin' })).status).toBe(404)
    expect((await http(recoveryPort, { method: 'DELETE', path: '/' })).status).toBe(404)
  })

  it('validates requests as pure functions too', () => {
    const request = (headers, method = 'GET') => ({ method, headers })
    expect(assertRecoveryRequest(request({ host: 'localhost:5556' }), { port: 5556 })).toBe('localhost:5556')
    expect(() => assertRecoveryRequest(request({ host: '127.0.0.1:5556', origin: 'http://localhost:5556' }), { port: 5556 })).toThrow(/origin/)
    expect(() => assertRecoveryRequest(request({}), { port: 5556 })).toThrow(/host/)
    expect(() => assertRecoveryRequest(request({ host: '127.0.0.1:5556', 'sec-fetch-site': 'same-site' }), { port: 5556 })).toThrow(/cross-origin/)
    expect(escapeHtml('<a href="x">\'&')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
    let clock = 0
    const nonces = createNonceStore({ now: () => clock, ttlMs: 100 })
    const nonce = nonces.issue()
    expect(nonces.consume('other')).toBe(false)
    clock = 200
    expect(nonces.consume(nonce)).toBe(false)
    const fresh = nonces.issue()
    expect(nonces.consume(fresh)).toBe(true)
    expect(nonces.consume(fresh)).toBe(false)
  })
})

describe('CLI', () => {
  it('reads status and drives rollback over the socket, and reports a stopped daemon as disabled', async () => {
    const { h, started } = await daemon()
    const out = []
    expect(await runCli(['status'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
    expect(out.join('\n')).toMatch(/enabled: true {2}available: true/)
    expect(out.join('\n')).toMatch(/active release: {3}baseline-release/)
    out.length = 0
    expect(await runCli(['status', '--json'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
    expect(JSON.parse(out[0]).activeRelease.id).toBe('baseline-release')
    await expect(runCli(['rollback'], { root: h.root, stdout: () => {} })).rejects.toThrow(/--expected/)
    await expect(runCli(['rollback', '--expected', 'baseline-release'], { root: h.root, stdout: () => {} })).rejects.toMatchObject({ status: 409, code: 'no_previous' })
    await expect(runCli(['bogus'], { root: h.root, stdout: () => {} })).rejects.toThrow(/unknown command/)
    out.length = 0
    expect(await runCli(['tick'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
    await started.stop()
    out.length = 0
    expect(await runCli(['status'], { root: h.root, stdout: (line) => out.push(line) })).toBe(2)
    expect(out.join('\n')).toMatch(/not running/)
  })

  it('bootstraps a root without enabling it, and enable insists on a private token', async () => {
    const h = await createHarness()
    try {
      const out = []
      const tokenFile = join(h.root, 'token')
      await writeFile(tokenFile, 'github_pat_' + 'q'.repeat(40), { mode: 0o644 })
      await expect(runCli(['init', '--token-file', tokenFile], { root: h.root, stdout: (line) => out.push(line) })).rejects.toThrow(/owner only/)
      await writeFile(tokenFile, 'github_pat_' + 'q'.repeat(40), { mode: 0o600 })
      const { chmod } = await import('node:fs/promises')
      await chmod(tokenFile, 0o600)
      expect(await runCli(['init', '--token-file', tokenFile, '--caller-sha', 'c'.repeat(40)], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
      expect(out[0]).toMatch(/disabled until/)
      const config = await readJson(join(h.root, 'config.json'))
      expect(config).toMatchObject({ enabled: false, tokenFile, callerSha: 'c'.repeat(40), repository: 'mikkokotila/Poise' })
      expect(await runCli(['install-controller'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
      expect(await readFile(join(h.root, 'controller', 'launch.mjs'), 'utf8')).toContain('resolveLaunch')
      expect(await runCli(['report'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
      expect(JSON.parse(out.at(-1))).toMatchObject({ enabled: false, controllerInstalled: true, tokenFilePresent: true, activeRelease: { id: 'baseline-release' } })
      expect(await runCli(['enable'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
      expect((await readJson(join(h.root, 'config.json'))).enabled).toBe(true)
      expect(await runCli(['disable'], { root: h.root, stdout: (line) => out.push(line) })).toBe(0)
      expect((await readJson(join(h.root, 'config.json'))).enabled).toBe(false)
      await expect(runCli(['bootstrap-release', '--sha', 'short'], { root: h.root, stdout: () => {} })).rejects.toThrow(/--sha/)
    } finally {
      await rm(h.root, { recursive: true, force: true })
    }
  })
})
