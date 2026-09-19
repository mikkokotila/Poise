// The release journey, end to end, on real artifacts: a change in a real git
// workspace cloned from a temporary bare "origin", real `npm ci` / `npm run
// check` / `npm run build` runs through the safe runner on a zero-dependency
// fixture app, a GitHub whose REST answers are simulated but whose merges are
// real merge commits in that origin (so verifyMergeCommit proves an actual
// object), a release staged by the real release manager, a real fixture
// server started from the active-release pointer the stable launcher
// resolves, health verified over loopback HTTP, and a one-click rollback
// through the recovery UI while GitHub is unreachable.
//
// Nothing here touches production, the user's ~/.poise, launchctl, gh or any
// model provider; every process and directory belongs to the test and is torn
// down with it. Only loopback ports are used.
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { createAppBridge, loadBridgeKey } from '../scripts/self-update/app-bridge.mjs'
import { readJson } from '../scripts/self-update/atomic.mjs'
import { adoptInitialRelease, ensureBridgeKey, initializeRoot } from '../scripts/self-update/bootstrap.mjs'
import { createControlClient } from '../scripts/self-update/client.mjs'
import { createController } from '../scripts/self-update/controller.mjs'
import { startDaemon } from '../scripts/self-update/daemon.mjs'
import { createGit } from '../scripts/self-update/git.mjs'
import { CI_WORKFLOW_PATH, GITHUB_ACTIONS_APP, REQUIRED_CONTEXTS, createGitHubClient } from '../scripts/self-update/github.mjs'
import { resolveLaunch } from '../scripts/self-update/launch.mjs'
import { BASE_BRANCH, REPOSITORY, changeBranch, revertBranch } from '../scripts/self-update/paths.mjs'
import { BUNDLE_PATH, MANIFEST_NAME, createReleaseManager } from '../scripts/self-update/releases.mjs'
import { createRunner } from '../scripts/self-update/safe-runner.mjs'
import { openStore } from '../scripts/self-update/store.mjs'

const execFile = promisify(execFileCallback)
const FIXTURE_APP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'self-update-journey', 'app')
const CALLER_SHA = '5'.repeat(40)
const TOKEN = `github_pat_${'x'.repeat(30)}`
const INSTANCE = 'journey-instance'
const REQUEST = 'Greet in Finnish: change the greeting from Hello to Hei'
const TIMING = { healthGraceMs: 8_000, restoreGraceMs: 8_000, drainMaxMs: 20_000, mainPollMs: 60_000, stepTimeoutMs: 60_000 }
const SHA_PATTERN = /^[0-9a-f]{40}$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Tick until `predicate` holds; the log tail travels with a timeout so a stall explains itself. */
async function settle(tick, label, predicate, { timeoutMs = 30_000, logs = [] } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await tick()
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${logs.slice(-15).join('\n')}`)
    await sleep(100)
  }
}

/** Plain HTTP against the recovery UI: node:http so the browser-style headers are sent verbatim. */
function recoveryRequest(port, { method = 'GET', path = '/', form = null } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null
    const headers = { host: `127.0.0.1:${port}` }
    if (body !== null) {
      Object.assign(headers, {
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      })
    }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

function nonceOf(page) {
  const match = page.match(/name="nonce" value="([^"]+)"/)
  if (!match) throw new Error('recovery page has no nonce')
  return match[1]
}

// ── Simulated GitHub over a real bare repository ─────────────────────────────

/**
 * A GitHub REST transport for `createGitHubClient`. Refs, comparisons and
 * commits are read from the bare origin; pull requests and CI are in-memory
 * records; a merge is a real `git merge --no-ff` pushed to the origin's main.
 */
function createFakeGitHub({ bare, hub, sh, rollbackPhase }) {
  const state = { offline: false, ci: {}, pulls: new Map(), nextNumber: 100, calls: [] }
  const prefix = `/repos/${REPOSITORY}`
  const repo = { full_name: REPOSITORY }
  const ciFor = (sha) => state.ci[sha] ?? 'none'

  async function refSha(branch) {
    const result = await sh(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
    return result.ok ? result.stdout.trim() : null
  }

  async function view(pull) {
    const headSha = pull.merged ? pull.headSha : (await refSha(pull.head)) ?? pull.headSha
    return {
      number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, draft: false,
      mergeable: pull.merged ? null : true, mergeable_state: pull.merged ? 'unknown' : 'clean', merge_commit_sha: pull.mergeSha,
      html_url: `https://github.com/${REPOSITORY}/pull/${pull.number}`,
      head: { ref: pull.head, sha: headSha, repo }, base: { ref: pull.base, sha: await refSha(pull.base), repo },
    }
  }

  async function commitObject(sha) {
    const result = await sh(bare, ['cat-file', '-p', sha], { allowFailure: true })
    if (!result.ok) return null
    const parents = []
    let tree = null
    for (const line of result.stdout.split('\n')) {
      if (line === '') break
      if (line.startsWith('tree ')) tree = line.slice(5)
      if (line.startsWith('parent ')) parents.push({ sha: line.slice(7) })
    }
    return { sha, parents, commit: { tree: { sha: tree } } }
  }

  async function handle(method, path, query, body) {
    if (!path.startsWith(prefix)) return [404, { message: 'Not Found' }]
    const rest = path.slice(prefix.length)
    let match
    if (method === 'GET' && rest === '') return [200, { ...repo, default_branch: BASE_BRANCH, private: false }]
    if (method === 'GET' && (match = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = await refSha(decodeURIComponent(match[1]))
      return sha ? [200, { ref: `refs/heads/${match[1]}`, object: { type: 'commit', sha } }] : [404, { message: 'Not Found' }]
    }
    if (method === 'GET' && (match = rest.match(/^\/branches\/([^/]+)\/protection$/))) {
      return [200, {
        required_status_checks: { strict: true, contexts: [...REQUIRED_CONTEXTS], checks: REQUIRED_CONTEXTS.map((context) => ({ context, app_id: null })) },
        enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      }]
    }
    if (method === 'GET' && (match = rest.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const counts = await sh(bare, ['rev-list', '--left-right', '--count', `${match[1]}...${match[2]}`], { allowFailure: true })
      if (!counts.ok) return [404, { message: 'Not Found' }]
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
      const status = ahead === 0 && behind === 0 ? 'identical' : ahead > 0 && behind === 0 ? 'ahead' : ahead === 0 ? 'behind' : 'diverged'
      return [200, { status, ahead_by: ahead, behind_by: behind }]
    }
    if (method === 'GET' && rest === '/pulls') {
      const head = query.get('head')
      const wanted = head ? head.split(':').slice(1).join(':') : null
      const pulls = []
      for (const pull of state.pulls.values()) {
        if (wanted && pull.head !== wanted) continue
        if (query.get('state') && query.get('state') !== 'all' && pull.state !== query.get('state')) continue
        pulls.push(await view(pull))
      }
      return [200, pulls]
    }
    if (method === 'POST' && rest === '/pulls') {
      const headSha = await refSha(body.head)
      if (!headSha) return [422, { message: 'Validation Failed', errors: [{ message: `head branch ${body.head} does not exist` }] }]
      if (body.base !== BASE_BRANCH) return [422, { message: 'Validation Failed' }]
      const number = state.nextNumber++
      const pull = { number, title: body.title, body: body.body, head: body.head, base: body.base, headSha, state: 'open', merged: false, mergeSha: null }
      state.pulls.set(number, pull)
      return [201, await view(pull)]
    }
    if (method === 'GET' && (match = rest.match(/^\/pulls\/(\d+)$/))) {
      const pull = state.pulls.get(Number(match[1]))
      return pull ? [200, await view(pull)] : [404, { message: 'Not Found' }]
    }
    if (method === 'GET' && (match = rest.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/))) {
      const sha = match[1]
      const status = ciFor(sha)
      if (status === 'none') return [200, { total_count: 0, check_runs: [] }]
      return [200, {
        total_count: REQUIRED_CONTEXTS.length,
        check_runs: REQUIRED_CONTEXTS.map((name, index) => ({
          name, head_sha: sha, app: { slug: GITHUB_ACTIONS_APP }, check_suite: { id: 4242 },
          status: status === 'pending' ? 'in_progress' : 'completed',
          conclusion: status === 'pending' ? null : status === 'failure' && index === 1 ? 'failure' : 'success',
        })),
      }]
    }
    if (method === 'GET' && rest === '/actions/runs') {
      const sha = query.get('head_sha')
      const status = ciFor(sha)
      if (status === 'none') return [200, { total_count: 0, workflow_runs: [] }]
      return [200, {
        total_count: 1,
        workflow_runs: [{
          path: CI_WORKFLOW_PATH, head_sha: sha, event: 'pull_request', run_number: 1, check_suite_id: 4242,
          status: status === 'pending' ? 'in_progress' : 'completed', conclusion: status === 'pending' ? null : status === 'failure' ? 'failure' : 'success',
          head_repository: repo, html_url: `https://github.com/${REPOSITORY}/actions/runs/1`,
        }],
      }]
    }
    if (method === 'PUT' && (match = rest.match(/^\/pulls\/(\d+)\/merge$/))) {
      const pull = state.pulls.get(Number(match[1]))
      if (!pull) return [404, { message: 'Not Found' }]
      if (pull.merged || pull.state !== 'open') return [405, { message: 'Pull Request is not mergeable' }]
      if (body?.merge_method !== 'merge') return [405, { message: `merge method ${body?.merge_method} is not allowed` }]
      const current = await refSha(pull.head)
      if (!SHA_PATTERN.test(body?.sha ?? '') || body.sha !== current) {
        return [409, { message: 'Head branch was modified. Review and try the merge again.' }]
      }
      // The real thing: a merge commit joining origin/main and the exact head, pushed to the origin.
      await sh(hub, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
      await sh(hub, ['checkout', '--quiet', '-B', BASE_BRANCH, `origin/${BASE_BRANCH}`])
      const merge = await sh(hub, ['merge', '--no-ff', '--no-edit', '-m', `Merge pull request #${pull.number} from ${REPOSITORY.split('/')[0]}/${pull.head}\n\n${pull.title}`, current], { allowFailure: true })
      if (!merge.ok) {
        await sh(hub, ['merge', '--abort'], { allowFailure: true })
        return [405, { message: 'Pull Request is not mergeable', merged: false }]
      }
      const mergeSha = (await sh(hub, ['rev-parse', 'HEAD'])).stdout.trim()
      await sh(hub, ['push', '--quiet', 'origin', `${BASE_BRANCH}:${BASE_BRANCH}`])
      Object.assign(pull, { merged: true, state: 'closed', mergeSha, headSha: current })
      return [200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }]
    }
    if (method === 'GET' && (match = rest.match(/^\/commits\/([0-9a-f]{40})$/))) {
      const commit = await commitObject(match[1])
      return commit ? [200, commit] : [404, { message: 'Not Found' }]
    }
    return [404, { message: `no route for ${method} ${rest}` }]
  }

  async function fetch(url, init = {}) {
    const parsed = new URL(url)
    state.calls.push({ method: init.method, path: parsed.pathname, rollback: rollbackPhase(), offline: state.offline, authorization: init.headers?.authorization })
    if (state.offline) throw new TypeError('fetch failed: ENETUNREACH')
    const [status, json] = await handle(init.method, parsed.pathname, parsed.searchParams, init.body ? JSON.parse(init.body) : undefined)
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }

  return { state, fetch, refSha }
}

// ── The journey: origin, controller root, fixture process ────────────────────

async function createJourney() {
  // Real path: the fixture reports process.cwd() resolved, and /tmp is a symlink on macOS.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'poise-jy-')))
  const home = join(scratch, 'home')
  const root = join(scratch, 'su')
  const bare = join(scratch, 'origin.git')
  const hub = join(scratch, 'github-hub')
  const seed = join(scratch, 'seed')
  await mkdir(home, { recursive: true })
  const logs = []
  const log = (line) => logs.push(line)
  const gitEnv = {
    HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Journey Agent', GIT_AUTHOR_EMAIL: 'agent@localhost', GIT_COMMITTER_NAME: 'Journey Agent', GIT_COMMITTER_EMAIL: 'agent@localhost',
  }
  /** Git as the test (the agent, the seed, GitHub's side) runs it: never through the controller's runner. */
  async function sh(cwd, args, { allowFailure = false } = {}) {
    try {
      const { stdout, stderr } = await execFile('git', args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      return { ok: true, code: 0, stdout, stderr }
    } catch (error) {
      if (!allowFailure) throw error
      return { ok: false, code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
  }

  // The origin: one commit of the fixture app on main, plus GitHub's own working clone.
  await execFile('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare], { env: gitEnv })
  await sh(scratch, ['clone', '--quiet', bare, seed])
  await cp(FIXTURE_APP, seed, { recursive: true, filter: (source) => !/\/(node_modules|dist)(\/|$)/.test(source) })
  await sh(seed, ['add', '-A'])
  await sh(seed, ['commit', '--quiet', '-m', 'Poise fixture baseline'])
  const baseSha = (await sh(seed, ['rev-parse', 'HEAD'])).stdout.trim()
  await sh(seed, ['push', '--quiet', 'origin', `HEAD:${BASE_BRANCH}`])
  await sh(scratch, ['clone', '--quiet', bare, hub])

  const paths = await initializeRoot(root)
  const bridgeKeyFile = await ensureBridgeKey(root)
  const port = await freePort()
  const baseEnv = { HOME: home, TMPDIR: scratch }
  let offset = 0
  const clock = { now: () => new Date(Date.now() + offset), advance(ms) { offset += ms } }

  // Worker records go to whichever store currently owns the root: the
  // standalone controller's, then the daemon's after the "restart".
  const registry = {
    store: null,
    register(worker) {
      if (!this.store) throw new Error('worker registry has no store')
      return this.store.commit('worker.start', (draft) => { draft.workers[worker.pid] = worker }, { pid: worker.pid, purpose: worker.purpose })
    },
    release(pid) {
      return this.store.commit('worker.end', (draft) => { delete draft.workers[pid] }, { pid })
    },
  }
  const rollbackPhase = () => {
    const ops = Object.values(registry.store?.state.rollbacks ?? {})
    return ops.length ? ops.map((op) => `${op.id}:${op.phase}`).join(',') : null
  }
  const releaseManager = (runner, git) => createReleaseManager({
    releasesDir: paths.releasesDir, logsDir: paths.logsDir, git, runner, baseEnv, callerSha: CALLER_SHA, now: clock.now, log,
  })
  // The baseline is built untracked, exactly as `cli.mjs bootstrap-release` builds it.
  const bootstrapRunner = createRunner({ log })
  const bootstrapGit = createGit({ runner: bootstrapRunner, baseEnv, url: bare })
  const baseline = await adoptInitialRelease(root, {
    sha: baseSha, id: `baseline-${baseSha.slice(0, 12)}`, now: () => clock.now().toISOString(),
    stage: (release) => releaseManager(bootstrapRunner, bootstrapGit).stage(release),
  })

  const runner = createRunner({ workers: registry, log })
  const git = createGit({ runner, baseEnv, url: bare })
  const releases = releaseManager(runner, git)
  const github = createFakeGitHub({ bare, hub, sh, rollbackPhase })
  const calls = { loadToken: [] }
  const journey = { tokenUnavailable: false, enabled: true }
  const loadToken = async () => {
    calls.loadToken.push({ rollback: rollbackPhase() })
    if (journey.tokenUnavailable) throw new Error('release token file does not exist')
    return TOKEN
  }
  const githubClient = createGitHubClient({ fetch: github.fetch, loadToken, baseUrl: 'http://github.invalid', timeoutMs: 5_000 })
  const app = createAppBridge({ port, loadKey: () => loadBridgeKey(bridgeKeyFile), timeoutMs: 2_000 })
  const enablement = async () => (journey.enabled ? { enabled: true, reason: null } : { enabled: false, reason: 'self-update is disabled in config' })

  // The production service: whatever the pointer names, started the way the
  // stable launcher resolves it. Like `launchctl kickstart -k`, restart
  // returns once the new process is spawned; the controller verifies health.
  const fixture = { child: null, output: [] }
  const restarts = []
  async function stopFixture() {
    const child = fixture.child
    fixture.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const exited = once(child, 'exit')
    await Promise.race([exited, sleep(3_000).then(() => { child.kill('SIGKILL'); return exited })])
  }
  async function restart() {
    await stopFixture()
    const launch = await resolveLaunch(root)
    const child = spawn(process.execPath, [launch.bundle], {
      cwd: launch.root,
      env: { HOME: home, PATH: dirname(process.execPath), ...launch.env, POISE_PORT: String(port), POISE_BRIDGE_KEY_FILE: bridgeKeyFile, POISE_INSTANCE: INSTANCE },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => fixture.output.push(`[${launch.releaseId}] ${chunk.trimEnd()}`))
    }
    child.on('error', (error) => fixture.output.push(`[${launch.releaseId}] spawn error ${error.message}`))
    fixture.child = child
    restarts.push({ releaseId: launch.releaseId, sha: launch.sha, root: launch.root, pid: child.pid })
    log(`[journey] restarted production: ${launch.releaseId} (${launch.sha.slice(0, 12)}) pid ${child.pid}`)
  }

  /** Independent evidence: the fixture over plain loopback HTTP, not through the bridge. */
  async function probe(path, init) {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(2_000) })
    return { status: response.status, body: await response.json() }
  }
  async function healthy(release) {
    try {
      const { body } = await probe('/api/health')
      return body?.build?.sha === release.sha && body?.build?.releaseId === release.id
    } catch {
      return false
    }
  }
  async function waitForBaseline() {
    await restart()
    await settle(() => sleep(50), 'baseline fixture health', () => healthy(baseline), { timeoutMs: 10_000, logs })
  }

  /** The agent's work: write files into the prepared workspace and commit on its branch. */
  async function agentCommit(workspace, files, message) {
    for (const [path, content] of Object.entries(files)) await writeFile(join(workspace, path), content)
    await sh(workspace, ['add', '-A'])
    await sh(workspace, ['commit', '--quiet', '-m', message])
    return (await sh(workspace, ['rev-parse', 'HEAD'])).stdout.trim()
  }

  const store = await openStore(root, { now: () => clock.now().toISOString() })
  registry.store = store
  const controller = createController({
    store, layout: paths, enablement, git, github: githubClient, releases, app, restart, runner,
    baseEnv, loadToken, now: clock.now, log, timing: TIMING,
  })

  let daemon = null
  async function startJourneyDaemon() {
    const recoveryPort = await freePort()
    daemon = await startDaemon({
      root, env: { HOME: home }, log,
      adapters: { git, github: githubClient, releases, app, restart, runner, enablement, loadToken, now: clock.now, timing: TIMING, recoveryPort },
    })
    registry.store = daemon.store
    return { daemon, recoveryPort, client: createControlClient({ socketPath: daemon.socketPath, timeoutMs: 30_000 }) }
  }

  async function teardown() {
    if (daemon) await daemon.stop().catch(() => {})
    // stop() does not wait for a reconcile already in flight; its git/npm
    // workers must be gone before their directories are removed.
    const deadline = Date.now() + 30_000
    while ((controller.reconciling || daemon?.controller.reconciling) && Date.now() < deadline) await sleep(50)
    await stopFixture()
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  return {
    scratch, root, paths, bare, port, baseSha, baseline, sh, logs, clock, registry, github, calls, journey,
    controller, store, restart, restarts, fixture, probe, healthy, waitForBaseline, agentCommit, startJourneyDaemon, teardown,
    remoteSha: (branch) => github.refSha(branch),
    treeOf: async (sha) => (await sh(bare, ['rev-parse', `${sha}^{tree}`])).stdout.trim(),
    payload: (extra = {}) => ({ id: randomUUID(), sessionId: randomUUID(), instance: INSTANCE, request: REQUEST, ...extra }),
  }
}

const FINNISH_GREETING = [
  "// Changed by the journey test's agent.",
  "export const GREETING = 'Hei'",
  '',
  'export function greeting(name) {',
  '  return `${GREETING}, ${name}!`',
  '}',
  '',
].join('\n')

const FINNISH_SPEC = [
  "import assert from 'node:assert/strict'",
  "import { test } from 'node:test'",
  "import { GREETING, greeting } from '../src/greeting.mjs'",
  '',
  "test('greets by name', () => {",
  "  assert.equal(GREETING, 'Hei')",
  "  assert.equal(greeting('Poise'), 'Hei, Poise!')",
  '})',
  '',
].join('\n')

// ── Stages shared by the journeys ────────────────────────────────────────────

/** Adopt-and-serve: the baseline really answers from its release directory. */
async function verifyBaseline(j) {
  await j.waitForBaseline()
  const before = await j.probe('/api/health')
  expect(before.body.build).toEqual({ sha: j.baseSha, releaseId: j.baseline.id })
  expect(before.body.greeting).toBe('Hello, Poise!')
  expect(before.body.cwd).toBe(j.baseline.root)
  expect(before.body.release).toEqual({ id: j.baseline.id, sha: j.baseSha, root: j.baseline.root })
  const status = await j.controller.status()
  expect(status).toMatchObject({ enabled: true, available: true, previousRelease: null, hold: null })
  expect(status.activeRelease).toMatchObject({ id: j.baseline.id, sha: j.baseSha, callerSha: CALLER_SHA })
  return { baselinePid: before.body.pid }
}

/**
 * Request → prepared clone → agent commit → checks → published head → PR →
 * CI gate → verified real merge → staged release → drain → switch → health → live.
 */
async function shipGreetingChange(j) {
  const { controller, store, paths, logs } = j
  const changeOf = () => Object.values(store.state.changes)[0]
  const { baselinePid } = await verifyBaseline(j)

  // Prepare: a real clone on the change branch at the active SHA; idempotent for the same payload.
  const payload = j.payload()
  const prepared = await controller.prepareChange(payload)
  expect(prepared.change.state).toBe('implementing')
  expect(prepared.branch).toBe(changeBranch(payload.id))
  expect(prepared.baseSha).toBe(j.baseSha)
  expect(prepared.workspace).toBe(join(paths.workspacesDir, payload.id))
  expect((await j.sh(prepared.workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(j.baseSha)
  expect((await j.sh(prepared.workspace, ['branch', '--show-current'])).stdout.trim()).toBe(prepared.branch)
  expect(await controller.prepareChange(payload)).toEqual(prepared)
  const runtimeSession = randomUUID()
  expect((await controller.bindSession(payload.id, { sessionId: runtimeSession, instance: INSTANCE })).sessionId).toBe(runtimeSession)

  // The agent implements the request and commits; nothing is pushed by it.
  const headSha = await j.agentCommit(prepared.workspace, { 'src/greeting.mjs': FINNISH_GREETING, 'tests/greeting.spec.mjs': FINNISH_SPEC }, 'Greet in Finnish')
  expect(await j.remoteSha(prepared.branch)).toBeNull()
  j.github.state.ci[headSha] = 'pending'
  expect((await controller.finishChange(payload.id, { outcome: 'completed' })).state).toBe('checking')
  await settle(() => controller.tick(), 'awaiting_ci', () => changeOf().state === 'awaiting_ci', { logs })

  // Checks ran for real in the workspace, the exact head was published and a PR opened on it.
  const checked = changeOf()
  expect(checked.headSha).toBe(headSha)
  expect(checked.check).toMatchObject({ headSha })
  expect(await readFile(join(paths.logsDir, 'changes', payload.id, 'check.stdout.log'), 'utf8')).toMatch(/# pass 1/)
  expect(await readFile(join(paths.logsDir, 'changes', payload.id, 'npm-ci.stdout.log'), 'utf8')).toBeDefined()
  expect(await j.remoteSha(prepared.branch)).toBe(headSha)
  const pull = j.github.state.pulls.get(checked.prNumber)
  expect(pull).toMatchObject({ head: prepared.branch, base: BASE_BRANCH, headSha, title: checked.title, state: 'open' })
  expect(pull.body).toContain(REQUEST)
  expect(pull.body).toContain(headSha)
  expect(checked.prUrl).toBe(`https://github.com/${REPOSITORY}/pull/${checked.prNumber}`)
  expect(j.github.state.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true)

  // Pending CI holds the gate; a busy app holds the drain after the merge.
  await controller.tick()
  expect(changeOf().state).toBe('awaiting_ci')
  expect(await j.remoteSha(BASE_BRANCH)).toBe(j.baseSha)
  await j.probe('/__fixture/busy', { method: 'POST', body: JSON.stringify({ busy: 1 }), headers: { 'content-type': 'application/json' } })
  j.github.state.ci[headSha] = 'success'
  await settle(() => controller.tick(), 'draining', () => changeOf().deploy?.phase === 'draining', { logs })
  const merged = changeOf()
  expect(merged.state).toBe('deploying')
  const mergeSha = merged.mergeSha
  expect(mergeSha).toMatch(SHA_PATTERN)
  expect(await j.remoteSha(BASE_BRANCH)).toBe(mergeSha)
  const mergeCommit = (await j.sh(j.bare, ['cat-file', '-p', mergeSha])).stdout
  expect(mergeCommit.match(/^parent ([0-9a-f]{40})$/gm)).toEqual([`parent ${j.baseSha}`, `parent ${headSha}`])
  expect(await j.treeOf(mergeSha)).toBe(await j.treeOf(headSha))
  expect(pull).toMatchObject({ merged: true, state: 'closed', mergeSha })
  // The release was staged for real and is complete before anything switched.
  const candidate = store.state.releases[merged.releaseId]
  expect(candidate).toMatchObject({ sha: mergeSha, callerSha: CALLER_SHA, rejected: false })
  expect(await readJson(join(candidate.root, MANIFEST_NAME))).toMatchObject({ id: candidate.id, sha: mergeSha, callerSha: CALLER_SHA, builder: 'poise-self-update' })
  expect(await readFile(join(candidate.root, BUNDLE_PATH), 'utf8')).toContain(`const __POISE_BUILD_SHA__ = "${mergeSha}"`)
  expect((await j.probe('/api/health')).body.build.sha).toBe(j.baseSha)
  const bridgeKey = (await readFile(join(j.root, 'bridge.key'), 'utf8')).trim()
  const readiness = await j.probe('/api/self-update/readiness', { headers: { 'x-poise-release-key': bridgeKey } })
  expect(readiness.body).toMatchObject({ draining: true, releaseId: candidate.id, ready: false, busy: 1 })
  expect(j.restarts).toHaveLength(1)

  // Idle again: switch, restart from the pointer, verify health, live.
  await j.probe('/__fixture/busy', { method: 'POST', body: JSON.stringify({ busy: 0 }), headers: { 'content-type': 'application/json' } })
  await settle(() => controller.tick(), 'live', () => changeOf().state === 'live', { logs })
  const live = changeOf()
  expect(live).toMatchObject({ releaseId: candidate.id, previousReleaseId: j.baseline.id, mergeSha })
  expect(j.restarts.map((entry) => entry.releaseId)).toEqual([j.baseline.id, candidate.id])
  expect(await store.readActivePointer()).toMatchObject({ id: candidate.id, sha: mergeSha, root: candidate.root, previousId: j.baseline.id })
  const served = await j.probe('/api/health')
  expect(served.body.build).toEqual({ sha: mergeSha, releaseId: candidate.id })
  expect(served.body.greeting).toBe('Hei, Poise!')
  expect(served.body.cwd).toBe(candidate.root)
  expect(served.body.pid).not.toBe(baselinePid)
  expect(store.state.previousReleaseId).toBe(j.baseline.id)
  expect(store.state.workers).toEqual({})
  const status = await controller.status()
  expect(status.activeRelease).toMatchObject({ id: candidate.id, sha: mergeSha, callerSha: CALLER_SHA })
  expect(status.previousRelease).toMatchObject({ id: j.baseline.id, sha: j.baseSha })
  expect(status.changes[0]).toMatchObject({ id: payload.id, state: 'live', canRevert: true, prNumber: checked.prNumber })
  return { payload, headSha, mergeSha, candidate, title: checked.title, status, livePid: served.body.pid }
}

/** The controller restarts from disk as the daemon: same facts, same Caller SHA, socket and recovery UI up. */
async function restartAsDaemon(j, shipped) {
  const { daemon, recoveryPort, client } = await j.startJourneyDaemon()
  const status = await client.status()
  expect(status.activeRelease).toEqual(shipped.status.activeRelease)
  expect(status.previousRelease).toEqual(shipped.status.previousRelease)
  expect(status.changes[0]).toMatchObject({ id: shipped.payload.id, state: 'live', canRevert: true, releaseId: shipped.candidate.id })
  expect(status.recoveryUrl).toBe(`http://127.0.0.1:${recoveryPort}/`)
  return { daemon, recoveryPort, client }
}

/**
 * One click while GitHub is unreachable — from the change card (`via:
 * 'card'`) or the recovery page (`via: 'recovery'`) — then proof that the
 * previous artifact serves and that nothing on the way needed the token or
 * GitHub. Returns the rollback operation id.
 */
async function rollBackOffline(j, { daemon, recoveryPort, client }, shipped, { via }) {
  const { payload, candidate, mergeSha, livePid } = shipped
  const rollbackId = `rollback-${candidate.id}`
  j.github.state.offline = true
  const clickAt = { github: j.github.state.calls.length, token: j.calls.loadToken.length, restarts: j.restarts.length }
  if (via === 'card') {
    const acknowledged = await client.rollbackChange(payload.id, { expectedReleaseId: candidate.id })
    expect(acknowledged).toMatchObject({ id: payload.id, state: 'reverting', canRevert: false })
    expect(daemon.store.state.hold).toMatchObject({ changeId: payload.id, sha: mergeSha })
  } else {
    const page = await recoveryRequest(recoveryPort)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`name="expectedReleaseId" value="${candidate.id}"`)
    expect(page.body).toContain('<button type="submit">Roll back to previous release</button>')
    const click = await recoveryRequest(recoveryPort, { method: 'POST', path: '/rollback', form: { nonce: nonceOf(page.body), expectedReleaseId: candidate.id } })
    expect(click.status).toBe(200)
    expect(click.body).toContain(`Rollback pending: release ${candidate.id} → ${j.baseline.id}.`)
    // The recovery page rolls back a release, not a card: the hold is keyed by the release.
    expect(daemon.store.state.hold).toMatchObject({ changeId: `release:${candidate.id}`, sha: mergeSha })
  }
  expect(daemon.store.state.rollbacks[rollbackId]).toMatchObject({ expectedReleaseId: candidate.id, expectedSha: mergeSha, targetReleaseId: j.baseline.id })
  await settle(() => daemon.tick(), 'rollback done', () => daemon.store.state.rollbacks[rollbackId]?.phase === 'done', { logs: j.logs })

  // The previous artifact serves again; the rollback needed neither the token nor GitHub.
  expect(j.restarts.map((entry) => entry.releaseId)).toEqual([j.baseline.id, candidate.id, j.baseline.id])
  expect(await daemon.store.readActivePointer()).toMatchObject({ id: j.baseline.id, sha: j.baseSha, previousId: candidate.id })
  const restored = await j.probe('/api/health')
  expect(restored.body.build).toEqual({ sha: j.baseSha, releaseId: j.baseline.id })
  expect(restored.body.greeting).toBe('Hello, Poise!')
  expect(restored.body.pid).not.toBe(livePid)
  for (const call of j.calls.loadToken.slice(clickAt.token)) expect(call.rollback).toBe(`${rollbackId}:done`)
  for (const call of j.github.state.calls.slice(clickAt.github)) expect(call).toMatchObject({ offline: true, rollback: `${rollbackId}:done` })
  const status = await client.status()
  expect(status.available).toBe(false)
  expect(status.reason).toMatch(/promotion hold/)
  expect(status.hold.reason).toMatch(new RegExp(`release ${candidate.id} rolled back to ${j.baseline.id}`))
  expect(status.previousRelease).toBeNull()
  expect(status.activeRelease).toMatchObject({ id: j.baseline.id, sha: j.baseSha, callerSha: CALLER_SHA })
  expect(status.changes[0]).toMatchObject({ id: payload.id, state: 'reverted', canRevert: false, sourceRevert: { state: 'pending' } })
  expect(daemon.store.state.releases[candidate.id].rejected).toBe(true)
  expect(daemon.store.state.rejectedShas).toContain(mergeSha)
  expect(daemon.store.state.switching).toBeNull()
  expect(j.restarts).toHaveLength(clickAt.restarts + 1)
  return rollbackId
}

/** GitHub returns: main is reconciled with a real `git revert -m 1`, checked, merged and verified. */
async function reconcileSource(j, { daemon, client }, shipped) {
  const { payload, mergeSha, title } = shipped
  j.github.state.offline = false
  const revertOf = () => daemon.store.state.changes[payload.id]
  await settle(() => daemon.tick(), 'revert awaiting CI', () => revertOf().sourceRevert?.state === 'awaiting_ci', { logs: j.logs })
  const revert = revertOf().revert
  expect(revert.baseSha).toBe(mergeSha)
  expect(await j.remoteSha(revertBranch(payload.id))).toBe(revert.headSha)
  expect(await readFile(join(j.paths.logsDir, 'reverts', payload.id, 'check.stdout.log'), 'utf8')).toMatch(/# pass 1/)
  expect(j.github.state.pulls.get(revert.prNumber)).toMatchObject({ head: revertBranch(payload.id), headSha: revert.headSha, title: `Revert: ${title}` })
  j.github.state.ci[revert.headSha] = 'success'
  await settle(() => daemon.tick(), 'revert merged', () => revertOf().sourceRevert?.state === 'merged', { logs: j.logs })
  const reconciledMain = await j.remoteSha(BASE_BRANCH)
  expect(reconciledMain).toBe(revertOf().revert.mergeSha)
  const revertMerge = (await j.sh(j.bare, ['cat-file', '-p', reconciledMain])).stdout
  expect(revertMerge.match(/^parent ([0-9a-f]{40})$/gm)).toEqual([`parent ${mergeSha}`, `parent ${revert.headSha}`])
  expect(await j.treeOf(reconciledMain)).toBe(await j.treeOf(j.baseSha))
  const status = await client.status()
  expect(status.changes[0]).toMatchObject({ state: 'reverted', sourceRevert: { state: 'merged', prUrl: `https://github.com/${REPOSITORY}/pull/${revert.prNumber}` } })
  return { reconciledMain, status }
}

describe('Poise release journey on real artifacts', () => {
  const journeys = []
  afterEach(async () => {
    while (journeys.length) await journeys.pop().teardown()
  })

  it('ships a change through checks, CI, a verified merge and a health-checked switch, then rolls it back from the card with GitHub offline', async () => {
    const j = await createJourney()
    journeys.push(j)
    const shipped = await shipGreetingChange(j)
    const running = await restartAsDaemon(j, shipped)
    const { daemon, recoveryPort, client } = running
    const { payload, candidate } = shipped
    await rollBackOffline(j, running, shipped, { via: 'card' })

    // A second click shares the operation (card or recovery page); a stale card or release is refused; nothing new starts under the hold.
    const restartsAfterRollback = j.restarts.length
    expect(await client.rollbackChange(payload.id, { expectedReleaseId: candidate.id })).toMatchObject({ id: payload.id, state: 'reverted' })
    const page = await recoveryRequest(recoveryPort)
    expect(page.body).toContain('<button type="submit" disabled>Roll back to previous release</button>')
    const duplicate = await recoveryRequest(recoveryPort, { method: 'POST', path: '/rollback', form: { nonce: nonceOf(page.body), expectedReleaseId: candidate.id } })
    expect(duplicate.status).toBe(200)
    expect(duplicate.body).toContain(`Rollback done: release ${candidate.id} → ${j.baseline.id}.`)
    const reused = await recoveryRequest(recoveryPort, { method: 'POST', path: '/rollback', form: { nonce: nonceOf(page.body), expectedReleaseId: candidate.id } })
    expect(reused.status).toBe(403)
    await expect(client.rollbackChange(payload.id, { expectedReleaseId: j.baseline.id })).rejects.toMatchObject({ status: 409, code: 'stale' })
    await expect(client.rollbackRelease({ expectedReleaseId: 'not-the-active-release' })).rejects.toMatchObject({ status: 409, code: 'stale' })
    await expect(client.rollbackRelease({ expectedReleaseId: j.baseline.id })).rejects.toMatchObject({ status: 409, code: 'no_previous' })
    await expect(client.prepareChange(j.payload())).rejects.toMatchObject({ status: 409, code: 'hold' })
    expect(j.restarts).toHaveLength(restartsAfterRollback)
    expect((await client.status()).changes).toHaveLength(1)
    expect(Object.keys(daemon.store.state.rollbacks)).toEqual([`rollback-${candidate.id}`])

    // Source reconciliation lifts the hold the card's rollback set.
    const { reconciledMain, status } = await reconcileSource(j, running, shipped)
    expect(status.hold).toBeNull()
    expect(status.available).toBe(true)

    // The periodic main update deploys the reconciled main — never the rejected SHA.
    j.clock.advance(TIMING.mainPollMs + 1)
    await settle(() => daemon.tick(), 'main update live', async () => (await daemon.store.readActivePointer())?.sha === reconciledMain && !daemon.store.state.update.current, { logs: j.logs })
    const updated = await j.probe('/api/health')
    expect(updated.body.build.sha).toBe(reconciledMain)
    expect(updated.body.greeting).toBe('Hello, Poise!')
    const final = await client.status()
    expect(final.activeRelease).toMatchObject({ sha: reconciledMain, callerSha: CALLER_SHA })
    expect(final.previousRelease).toMatchObject({ id: j.baseline.id })
    expect(final.hold).toBeNull()
    expect(daemon.store.state.rejectedShas).toEqual([shipped.mergeSha])
    expect(daemon.store.state.workers).toEqual({})
    expect(daemon.controller.hasPendingWork()).toBe(false)
  }, 90_000)

  it('rolls back from the recovery page with GitHub offline and lifts the hold once main is reconciled', async () => {
    const j = await createJourney()
    journeys.push(j)
    const shipped = await shipGreetingChange(j)
    const running = await restartAsDaemon(j, shipped)
    const { recoveryPort, client } = running
    const { candidate } = shipped
    await rollBackOffline(j, running, shipped, { via: 'recovery' })

    // A second click on the page shares the finished operation and its nonce cannot be replayed.
    const page = await recoveryRequest(recoveryPort)
    const duplicate = await recoveryRequest(recoveryPort, { method: 'POST', path: '/rollback', form: { nonce: nonceOf(page.body), expectedReleaseId: candidate.id } })
    expect(duplicate.status).toBe(200)
    expect(duplicate.body).toContain(`Rollback done: release ${candidate.id} → ${j.baseline.id}.`)
    expect((await recoveryRequest(recoveryPort, { method: 'POST', path: '/rollback', form: { nonce: nonceOf(page.body), expectedReleaseId: candidate.id } })).status).toBe(403)
    await expect(client.prepareChange(j.payload())).rejects.toMatchObject({ status: 409, code: 'hold' })

    // The hold's stated reason — "main still carries the rolled-back merge" —
    // is false once the revert has merged, exactly as after a card rollback.
    const { status } = await reconcileSource(j, running, shipped)
    expect(status.hold).toBeNull()
    expect(status.available).toBe(true)
  }, 90_000)

  it('restores the previous artifact when a merged candidate cannot boot, and never redeploys it', async () => {
    const j = await createJourney()
    journeys.push(j)
    const { controller, store, logs } = j
    const changeOf = () => Object.values(store.state.changes)[0]
    const { baselinePid } = await verifyBaseline(j)

    // Tests pass; the server throws at boot. Exactly the regression checks cannot see.
    const payload = j.payload({ request: 'Log the build identity at startup' })
    const prepared = await controller.prepareChange(payload)
    const original = await readFile(join(prepared.workspace, 'src', 'server.mjs'), 'utf8')
    const importLine = "import { greeting } from './greeting.mjs'\n"
    expect(original).toContain(importLine)
    const broken = original.replace(importLine, `${importLine}\n// Only visible at boot; the unit checks never import this module.\nthrow new Error('candidate cannot boot')\n`)
    const headSha = await j.agentCommit(prepared.workspace, { 'src/server.mjs': broken }, 'Log the build identity at startup')
    j.github.state.ci[headSha] = 'success'
    await controller.finishChange(payload.id, { outcome: 'completed' })
    await settle(() => controller.tick(), 'verifying', () => changeOf().state === 'verifying', { logs })
    const mergeSha = changeOf().mergeSha
    const candidate = store.state.releases[changeOf().releaseId]
    expect(await j.remoteSha(BASE_BRANCH)).toBe(mergeSha)
    expect(await readFile(join(candidate.root, BUNDLE_PATH), 'utf8')).toContain("throw new Error('candidate cannot boot')")
    expect(await store.readActivePointer()).toMatchObject({ id: candidate.id, sha: mergeSha, previousId: j.baseline.id })
    expect(store.state.switching).toMatchObject({ kind: 'deploy', to: { id: candidate.id } })

    // The candidate process is gone and nothing answers; within the grace period the controller keeps waiting.
    if (j.fixture.child.exitCode === null) await once(j.fixture.child, 'exit')
    expect(j.fixture.child.exitCode).toBe(1)
    expect(j.fixture.output.join('\n')).toContain('candidate cannot boot')
    await expect(j.probe('/api/health')).rejects.toThrow()
    await controller.tick()
    expect(changeOf().state).toBe('verifying')
    expect(await store.readActivePointer()).toMatchObject({ id: candidate.id })

    // Grace over: the previous artifact is restored from disk, restarted and verified before the change fails.
    j.clock.advance(TIMING.healthGraceMs + 1)
    await settle(() => controller.tick(), 'restore verified', () => changeOf().state === 'failed', { logs })
    const failed = changeOf()
    expect(failed.error).toMatch(new RegExp(`release ${candidate.id} did not become healthy`))
    expect(failed.error).toMatch(new RegExp(`previous release ${j.baseline.id} restored`))
    expect(failed.error).not.toMatch(/UNVERIFIED/)
    expect(j.restarts.map((entry) => entry.releaseId)).toEqual([j.baseline.id, candidate.id, j.baseline.id])
    expect(await store.readActivePointer()).toMatchObject({ id: j.baseline.id, sha: j.baseSha, previousId: candidate.id })
    const restored = await j.probe('/api/health')
    expect(restored.body.build).toEqual({ sha: j.baseSha, releaseId: j.baseline.id })
    expect(restored.body.greeting).toBe('Hello, Poise!')
    expect(restored.body.pid).not.toBe(baselinePid)
    expect(store.state.releases[candidate.id].rejected).toBe(true)
    expect(store.state.rejectedShas).toEqual([mergeSha])
    expect(store.state.switching).toBeNull()
    expect(store.state.hold).toMatchObject({ changeId: payload.id, sha: mergeSha })
    expect(store.state.hold.reason).toMatch(/did not become healthy/)
    const status = await controller.status()
    expect(status).toMatchObject({ available: false, previousRelease: null })
    expect(status.reason).toMatch(/promotion hold/)
    expect(status.activeRelease).toMatchObject({ id: j.baseline.id, callerSha: CALLER_SHA })
    expect(status.changes[0]).toMatchObject({ state: 'failed', canRevert: false, releaseId: candidate.id })
    expect(await readJson(join(candidate.root, MANIFEST_NAME))).toMatchObject({ sha: mergeSha })

    // main still carries the merge; the hold blocks the periodic update, and clearing it still never redeploys a rejected SHA.
    j.clock.advance(TIMING.mainPollMs + 1)
    await controller.tick()
    expect(store.state.update.current).toBeNull()
    expect(store.state.update.lastMainSha).toBeNull()
    await controller.clearHold()
    j.clock.advance(TIMING.mainPollMs + 1)
    await controller.tick()
    expect(store.state.update).toMatchObject({ current: null, lastMainSha: mergeSha })
    expect(j.restarts).toHaveLength(3)
    expect(logs.some((line) => line.includes(`main is at rejected ${mergeSha.slice(0, 12)}`))).toBe(true)
    expect((await j.probe('/api/health')).body.build.sha).toBe(j.baseSha)
    expect(store.state.workers).toEqual({})
  }, 60_000)
})
