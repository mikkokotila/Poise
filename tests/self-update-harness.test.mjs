// Shared fakes for the controller tests: an in-memory git, an in-memory GitHub
// with pull requests, checks, protection and merges, a release manager that
// writes real manifests and bundles into a temporary root, and an application
// whose health follows whatever release the fake restart last launched.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AppUnreachable } from '../scripts/self-update/app-bridge.mjs'
import { writeJsonAtomic } from '../scripts/self-update/atomic.mjs'
import { adoptInitialRelease } from '../scripts/self-update/bootstrap.mjs'
import { createController } from '../scripts/self-update/controller.mjs'
import { GitHubError, REQUIRED_CONTEXTS } from '../scripts/self-update/github.mjs'
import { layout } from '../scripts/self-update/paths.mjs'
import { releaseIsComplete } from '../scripts/self-update/releases.mjs'
import { SubprocessError } from '../scripts/self-update/runner.mjs'
import { openStore } from '../scripts/self-update/store.mjs'

export const BASE = 'a'.repeat(40)
export const HEAD = 'b'.repeat(40)
export const HEAD2 = 'b'.repeat(39) + '2'
export const MAIN2 = 'e'.repeat(40)
export const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'
export const UUID2 = '4c352212-f3cc-4366-9db0-5247d677b073'
export const SESSION = '5d463323-04dd-4477-8ec1-6358e788c184'
export const SESSION2 = '6e574434-15ee-4588-9fd2-7469f899d295'
export const INSTANCE = 'instance-1'

export function treeOf(sha) {
  return sha.split('').reverse().join('')
}

let mergeCounter = 0
export function nextMergeSha() {
  mergeCounter += 1
  return `${mergeCounter.toString(16).padStart(4, '0')}${'c'.repeat(36)}`
}

export function fakeGit(model) {
  const workspaces = {}
  const remoteRefs = {}
  const log = []
  const git = {
    workspaces,
    remoteRefs,
    log,
    async clone({ dest, sha, branch = null, token = null }) {
      log.push(['clone', dest, sha, branch, token])
      if (model.cloneFails) throw new Error('clone failed: network')
      workspaces[dest] = { head: sha, base: sha, branch, dirty: '' }
      return sha
    },
    async revParse(cwd) {
      return workspaces[cwd].head
    },
    async treeSha(cwd, sha) {
      return treeOf(sha)
    },
    async currentBranch(cwd) {
      return workspaces[cwd].branch
    },
    async dirtyFiles(cwd) {
      return workspaces[cwd].dirty
    },
    async isAncestor(cwd, ancestor, descendant) {
      if (model.notAncestor) return false
      return ancestor === workspaces[cwd].base || ancestor === descendant || ancestor === BASE || ancestor === MAIN2
    },
    async changedEntries() {
      return model.entries ?? [{ status: 'M', oldMode: '100644', newMode: '100644', path: 'src/main.ts' }]
    },
    async remoteRef({ branch }) {
      return remoteRefs[branch] ?? null
    },
    async push({ sha, branch, token }) {
      log.push(['push', branch, sha])
      if (!token) throw new Error('no token')
      if (model.pushFails) throw new Error('push failed: connection reset')
      if (model.pushLandsButFails) {
        remoteRefs[branch] = sha
        throw new Error('push: connection reset after write')
      }
      remoteRefs[branch] = sha
    },
    async revertMerge(cwd, mergeSha) {
      log.push(['revert', mergeSha])
      if (model.revertConflict) return { conflict: true, detail: 'CONFLICT (content): src/main.ts' }
      const sha = `${'d'.repeat(36)}${mergeSha.slice(0, 4)}`
      workspaces[cwd].head = sha
      return { sha }
    },
    // Test helper: the agent committed in the workspace.
    commit(dest, sha, { dirty = '' } = {}) {
      workspaces[dest].head = sha
      workspaces[dest].dirty = dirty
    },
  }
  return git
}

export function fakeGitHub(model, git) {
  const pulls = {}
  const commits = {}
  const log = []
  let nextNumber = 100
  const repo = { full_name: 'mikkokotila/Poise' }
  const protection = () => model.protection ?? {
    required_status_checks: { strict: true, contexts: [...REQUIRED_CONTEXTS] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  }
  const ciFor = (sha) => model.ci?.[sha] ?? 'success'
  function network(message) {
    return new GitHubError(message, { code: 'network' })
  }
  const github = {
    pulls,
    commits,
    log,
    get mainSha() {
      return model.mainSha
    },
    async getRepository() {
      log.push(['repository'])
      if (model.offline) throw network('offline')
      return model.repository ?? { ...repo, default_branch: 'main' }
    },
    async getBranchSha() {
      log.push(['main'])
      if (model.offline) throw network('offline')
      return model.mainSha
    },
    async getBranchProtection() {
      return protection()
    },
    async compare(base, head) {
      if (model.compare) return model.compare
      if (base === head) return { status: 'identical', ahead_by: 0, behind_by: 0 }
      return { status: 'ahead', ahead_by: 1, behind_by: 0 }
    },
    async findPullRequest(branch) {
      if (model.offline) throw network('offline')
      return Object.values(pulls).find((pull) => pull.head.ref === branch) || null
    },
    async createPullRequest({ title, body, head, base }) {
      log.push(['create-pr', head])
      if (model.offline) throw network('offline')
      const number = nextNumber++
      pulls[number] = {
        number, title, body, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
        merge_commit_sha: null, html_url: `https://github.com/mikkokotila/Poise/pull/${number}`,
        head: { ref: head, sha: git.remoteRefs[head], repo }, base: { ref: base, repo },
      }
      if (model.createPrUncertain) {
        model.createPrUncertain = false
        throw network('timeout after create')
      }
      return pulls[number]
    },
    async getPullRequest(number) {
      if (model.offline) throw network('offline')
      const pull = pulls[number]
      if (!pull) throw new GitHubError('Not Found', { status: 404, code: 'http' })
      return { ...pull, head: { ...pull.head, sha: model.prHeadOverride ?? pull.head.sha } }
    },
    async listCheckRuns(sha) {
      const status = ciFor(sha)
      if (status === 'none') return []
      return REQUIRED_CONTEXTS.map((name, index) => ({
        name, head_sha: sha, app: { slug: 'github-actions' }, check_suite: { id: 7 },
        status: status === 'pending' ? 'in_progress' : 'completed',
        conclusion: status === 'pending' ? null : status === 'failure' && index === 1 ? 'failure' : 'success',
      }))
    },
    async listWorkflowRuns(sha) {
      const status = ciFor(sha)
      if (status === 'none') return []
      return [{
        path: '.github/workflows/ci.yml', head_sha: sha, event: 'pull_request', run_number: 1, check_suite_id: 7,
        status: status === 'pending' ? 'in_progress' : 'completed', conclusion: status === 'pending' ? null : 'success',
        head_repository: repo, html_url: 'https://github.com/mikkokotila/Poise/actions/runs/1',
      }]
    },
    // The real merge: main advances to a merge commit whose parents are [main, head].
    performMerge(number, sha, { parents = null, tree = null } = {}) {
      const pull = pulls[number]
      const mergeSha = nextMergeSha()
      commits[mergeSha] = { sha: mergeSha, parents: (parents ?? [model.mainSha, sha]).map((parent) => ({ sha: parent })), commit: { tree: { sha: tree ?? treeOf(sha) } } }
      pull.merged = true
      pull.state = 'closed'
      pull.merge_commit_sha = mergeSha
      model.mainSha = mergeSha
      return mergeSha
    },
    async mergePullRequest(number, { sha }) {
      log.push(['merge', number, sha])
      if (model.offline) throw network('offline')
      if (model.mergeBehaviour === 'refuse') throw new GitHubError('Head branch was modified', { status: 409, code: 'http' })
      if (model.mergeBehaviour === 'uncertain') {
        model.mergeBehaviour = 'ok'
        github.performMerge(number, sha)
        throw network('socket hang up')
      }
      if (model.mergeBehaviour === 'uncertain-not-merged') {
        model.mergeBehaviour = 'ok'
        throw network('socket hang up')
      }
      if (model.mergeBehaviour === 'wrong-parents') {
        const mergeSha = github.performMerge(number, sha, { parents: [model.mainSha, 'f'.repeat(40)] })
        return { merged: true, sha: mergeSha }
      }
      if (model.mergeBehaviour === 'wrong-tree') {
        const mergeSha = github.performMerge(number, sha, { tree: '9'.repeat(40) })
        return { merged: true, sha: mergeSha }
      }
      const mergeSha = github.performMerge(number, sha)
      return { merged: true, sha: mergeSha }
    },
    async getCommit(sha) {
      if (model.offline) throw network('offline')
      const commit = commits[sha]
      if (!commit) throw new GitHubError('Not Found', { status: 404, code: 'http' })
      return commit
    },
  }
  return github
}

export function fakeReleases(model, releasesDir) {
  const log = []
  return {
    log,
    async stage({ id, sha }) {
      log.push(['stage', id, sha])
      if (model.stageFails) throw new Error('npm run build failed (exit 1)')
      const root = join(releasesDir, id)
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(join(root, 'dist', 'server.js'), '// bundle\n')
      const manifest = { id, sha, root, createdAt: '2026-09-19T10:00:00.000Z', callerSha: 'c'.repeat(40) }
      await writeJsonAtomic(join(root, 'release.json'), manifest)
      return manifest
    },
    isComplete(release) {
      return releaseIsComplete(release.root, release)
    },
  }
}

export function fakeApp(model) {
  const log = []
  return {
    log,
    async health() {
      log.push(['health'])
      if (!model.running) throw new AppUnreachable('ECONNREFUSED')
      if (model.running.crashed) throw new AppUnreachable('ECONNREFUSED')
      const degraded = model.degraded === true
      return {
        status: degraded ? 503 : 200, ok: !degraded,
        body: {
          status: degraded ? 'degraded' : 'ok', scheduler: { status: model.schedulerBroken ? 'error' : 'ok' },
          claudeAuth: { status: degraded ? 'signed_out' : 'authenticated' },
          build: { sha: model.running.sha, releaseId: model.running.id },
        },
      }
    },
    async chatSessions() {
      if (!model.running || model.running.crashed) throw new AppUnreachable('ECONNREFUSED')
      if (model.chatBroken) return { status: 500, ok: false, body: { error: 'boom' } }
      return { status: 200, ok: true, body: { sessions: [], instance: INSTANCE } }
    },
    async drain(releaseId) {
      log.push(['drain', releaseId])
      if (!model.running) throw new AppUnreachable('ECONNREFUSED')
      if (model.drainForbidden) return { status: 403, ok: false, body: { error: 'bad key' } }
      return { status: 200, ok: true, body: { ready: !model.busy, busy: model.busy ? 1 : 0, build: { sha: model.running.sha, releaseId: model.running.id } } }
    },
    async resume() {
      log.push(['resume'])
      return { status: 200, ok: true, body: { ready: true } }
    },
  }
}

export function fakeRunner(model) {
  const log = []
  return {
    log,
    async run(command, args, options) {
      log.push([command, ...args])
      if (options.env.GH_TOKEN || options.env.GITHUB_TOKEN || options.env.NODE_OPTIONS) throw new Error('leaked environment')
      if (model.checkFails && args.includes('check')) {
        throw new SubprocessError('npm run check exited 1\nFAIL tests/x.test.ts', { code: 1, stderr: 'FAIL tests/x.test.ts', command: 'npm run check' })
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

/**
 * Build a controller over a temporary root with an adopted baseline release.
 * `model` is shared, mutable state the tests poke to shape behaviour.
 */
export async function createHarness(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'poise-su-ctl-'))
  const paths = layout(root)
  const model = {
    enabled: true, mainSha: BASE, running: null, busy: false, degraded: false, ...overrides.model,
  }
  const releases = fakeReleases(model, paths.releasesDir)
  const baseline = await adoptInitialRelease(root, { sha: BASE, stage: ({ id, sha }) => releases.stage({ id, sha }), id: 'baseline-release' })
  model.running = { id: baseline.id, sha: baseline.sha }
  let time = Date.parse('2026-09-19T10:00:00Z')
  const clock = { now: () => new Date(time), advance(ms) { time += ms } }
  const git = fakeGit(model)
  const github = fakeGitHub(model, git)
  const app = fakeApp(model)
  const runner = fakeRunner(model)
  const restarts = []
  const restart = async () => {
    const store = await openStore(root)
    const pointer = await store.readActivePointer()
    restarts.push(pointer.id)
    if (model.restartFails) throw new Error('launchctl kickstart failed')
    model.running = model.crashOn?.includes(pointer.id) ? { ...pointer, crashed: true } : { id: pointer.id, sha: pointer.sha }
  }
  const logs = []
  const store = await openStore(root, { now: () => clock.now().toISOString() })
  const build = (storeInstance = store) => createController({
    store: storeInstance,
    layout: paths,
    enablement: async () => (model.enabled ? { enabled: true, reason: null } : { enabled: false, reason: 'self-update is disabled in config' }),
    git, github, releases, app, restart, runner,
    baseEnv: { HOME: root, GH_TOKEN: 'leak' },
    loadToken: async () => 'github_pat_' + 'x'.repeat(30),
    now: clock.now,
    log: (line) => logs.push(line),
    timing: { healthGraceMs: 10_000, restoreGraceMs: 10_000, drainMaxMs: 30_000, mainPollMs: 60_000, ...overrides.timing },
    recoveryUrl: 'http://127.0.0.1:5556/',
  })
  const controller = build()
  return {
    root, paths, model, clock, git, github, releases, app, runner, restart, restarts, logs, store, controller, baseline,
    /** A fresh controller over the same on-disk store, as after a daemon restart. */
    async restartController() {
      const reopened = await openStore(root, { now: () => clock.now().toISOString() })
      return build(reopened)
    },
    async pointer() {
      return store.readActivePointer()
    },
    workspace: join(paths.workspacesDir, UUID),
    payload: (extra = {}) => ({ id: UUID, sessionId: SESSION, instance: INSTANCE, request: 'Make the chat header sticky', ...extra }),
  }
}

/** Drive a change from prepared to awaiting_ci with a sensible agent commit. */
export async function runToAwaitingCi(harness, { headSha = HEAD } = {}) {
  const preparedChange = await harness.controller.prepareChange(harness.payload())
  await harness.controller.bindSession(UUID, { sessionId: SESSION2, instance: INSTANCE })
  harness.git.commit(preparedChange.workspace, headSha)
  await harness.controller.finishChange(UUID, { outcome: 'completed' })
  await harness.controller.tick()
  return preparedChange
}

// This file doubles as the shared harness for the controller and daemon tests;
// the suite below keeps the fakes themselves honest.

describe('controller test harness', () => {
  it('adopts a healthy baseline release that the fake app serves', async () => {
    const harness = await createHarness()
    const pointer = await harness.pointer()
    expect(pointer).toMatchObject({ id: 'baseline-release', sha: BASE })
    expect(harness.model.running).toEqual({ id: 'baseline-release', sha: BASE })
    const health = await harness.app.health()
    expect(health.body.build).toEqual({ sha: BASE, releaseId: 'baseline-release' })
    expect(await harness.releases.isComplete(harness.store.state.releases['baseline-release'])).toBe(true)
    await rm(harness.root, { recursive: true, force: true })
  })

  it('merges in the fake GitHub the way GitHub does: parents [main, head], tree of head', async () => {
    const harness = await createHarness()
    harness.git.remoteRefs['poise/change-x'] = HEAD
    const pull = await harness.github.createPullRequest({ title: 't', body: 'b', head: 'poise/change-x', base: 'main' })
    const result = await harness.github.mergePullRequest(pull.number, { sha: HEAD })
    const commit = await harness.github.getCommit(result.sha)
    expect(commit.parents.map((parent) => parent.sha)).toEqual([BASE, HEAD])
    expect(commit.commit.tree.sha).toBe(treeOf(HEAD))
    expect(harness.github.mainSha).toBe(result.sha)
    await rm(harness.root, { recursive: true, force: true })
  })
})
