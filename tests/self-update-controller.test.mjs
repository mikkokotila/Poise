import { readFile, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'

import { openStore } from '../scripts/self-update/store.mjs'
import {
  BASE, HEAD, HEAD2, INSTANCE, MAIN2, SESSION, SESSION2, UUID, UUID2, createHarness, runToAwaitingCi,
} from './self-update-harness.test.mjs'

const harnesses = []
async function harness(overrides) {
  const created = await createHarness(overrides)
  harnesses.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((created) => rm(created.root, { recursive: true, force: true })))
})

async function journal(h) {
  return (await readFile(h.paths.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
}

const changeOf = (h, id = UUID) => h.store.state.changes[id]

/** Tick until the predicate holds or the budget runs out; returns the tick count. */
async function tickUntil(h, predicate, { max = 8, controller = h.controller } = {}) {
  for (let count = 1; count <= max; count += 1) {
    await controller.tick()
    if (predicate()) return count
  }
  throw new Error(`condition not met after ${max} ticks; change is ${changeOf(h)?.state}`)
}

/** Take a change all the way to live. */
async function runToLive(h) {
  await runToAwaitingCi(h)
  await tickUntil(h, () => changeOf(h).state === 'live')
  return changeOf(h)
}

describe('status', () => {
  it('reports enabled and available with the baseline and the recovery url', async () => {
    const h = await harness()
    const status = await h.controller.status()
    expect(status).toMatchObject({
      enabled: true, available: true, hold: null, changes: [], previousRelease: null,
      activeRelease: { id: 'baseline-release', sha: BASE }, recoveryUrl: 'http://127.0.0.1:5556/',
    })
    expect(status.reason).toBeUndefined()
    expect(status.activeRelease.root).toContain('/releases/baseline-release')
  })

  it('is disabled without the manual opt-in and unavailable while work is in flight', async () => {
    const h = await harness({ model: { enabled: false } })
    expect(await h.controller.status()).toMatchObject({ enabled: false, available: false, reason: 'self-update is disabled in config' })
    h.model.enabled = true
    await h.controller.prepareChange(h.payload())
    expect(await h.controller.status()).toMatchObject({ enabled: true, available: false, reason: `change ${UUID} is in progress` })
  })
})

describe('POST /changes', () => {
  it('validates the payload before touching anything', async () => {
    const h = await harness()
    await expect(h.controller.prepareChange(null)).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.prepareChange(h.payload({ id: 'nope' }))).rejects.toMatchObject({ status: 400, message: /id must be a UUID/ })
    await expect(h.controller.prepareChange(h.payload({ sessionId: 'x' }))).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.prepareChange(h.payload({ instance: '' }))).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.prepareChange(h.payload({ request: '   ' }))).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.prepareChange(h.payload({ title: 'x'.repeat(201) }))).rejects.toMatchObject({ status: 400 })
    expect(h.git.log).toEqual([])
    expect(h.store.state.changes).toEqual({})
  })

  it('requires the opt-in, a hold-free controller and a healthy, matching baseline', async () => {
    const h = await harness({ model: { enabled: false } })
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 503, code: 'disabled' })
    h.model.enabled = true
    h.model.running = null
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 503, code: 'no_baseline', message: /not reachable/ })
    h.model.running = { id: 'baseline-release', sha: 'f'.repeat(40) }
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 503, message: /serving build ffffffffffff/ })
    h.model.running = { id: 'baseline-release', sha: BASE }
    h.model.chatBroken = true
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 503, message: /chat session list/ })
    h.model.chatBroken = false
    await h.store.commit('test', (draft) => { draft.hold = { changeId: 'x', sha: BASE, reason: 'manual' } })
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 409, code: 'hold' })
    expect(h.git.log).toEqual([])
  })

  it('tolerates a baseline degraded only by external sign-in state', async () => {
    const h = await harness({ model: { degraded: true } })
    const result = await h.controller.prepareChange(h.payload())
    expect(result.change.state).toBe('implementing')
  })

  it('records a durable intent before cloning, prepares an isolated branch off the active SHA, and is idempotent', async () => {
    const h = await harness()
    const result = await h.controller.prepareChange(h.payload({ title: '  Sticky header  ' }))
    expect(result).toEqual({
      change: expect.objectContaining({
        id: UUID, sessionId: SESSION, instance: INSTANCE, request: 'Make the chat header sticky', title: 'Sticky header',
        repository: 'mikkokotila/Poise', branch: `poise/change-${UUID}`, baseSha: BASE, state: 'implementing', canRevert: false,
      }),
      workspace: h.workspace, branch: `poise/change-${UUID}`, baseSha: BASE,
    })
    expect(result.change).not.toHaveProperty('workspace')
    expect(result.change).not.toHaveProperty('sourceSessionId')
    expect(h.git.log).toEqual([['clone', h.workspace, BASE, `poise/change-${UUID}`, 'github_pat_' + 'x'.repeat(30)]])
    const events = (await journal(h)).map((entry) => entry.event)
    expect(events.indexOf('change.prepare')).toBeLessThan(events.indexOf('change.prepared'))

    // Same id and payload: the same answer, no second clone.
    expect(await h.controller.prepareChange(h.payload({ title: 'Sticky header' }))).toEqual(result)
    expect(h.git.log).toHaveLength(1)
    // Same id, different payload: refused.
    await expect(h.controller.prepareChange(h.payload({ request: 'Something else' }))).rejects.toMatchObject({ status: 409, code: 'conflict' })
    // A second change while the first is in flight: one lane only.
    await expect(h.controller.prepareChange(h.payload({ id: UUID2 }))).rejects.toMatchObject({ status: 409, code: 'busy' })
  })

  it('fails the change cleanly when the clone fails, freeing the lane', async () => {
    const h = await harness({ model: { cloneFails: true } })
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 502, code: 'prepare_failed' })
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /clone failed/ })
    await expect(h.controller.prepareChange(h.payload())).rejects.toMatchObject({ status: 409, code: 'prepare_failed' })
    h.model.cloneFails = false
    expect((await h.controller.prepareChange(h.payload({ id: UUID2 }))).change.state).toBe('implementing')
  })
})

describe('session binding and finish', () => {
  it('binds the generated runtime session once, for the recorded instance only', async () => {
    const h = await harness()
    await h.controller.prepareChange(h.payload())
    await expect(h.controller.bindSession(UUID2, { sessionId: SESSION2, instance: INSTANCE })).rejects.toMatchObject({ status: 404 })
    await expect(h.controller.bindSession(UUID, { sessionId: 'bad', instance: INSTANCE })).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.bindSession(UUID, { sessionId: SESSION2, instance: 'other-instance' })).rejects.toMatchObject({ status: 409, code: 'instance_mismatch' })
    const bound = await h.controller.bindSession(UUID, { sessionId: SESSION2, instance: INSTANCE })
    expect(bound.sessionId).toBe(SESSION2)
    expect((await h.controller.bindSession(UUID, { sessionId: SESSION2, instance: INSTANCE })).sessionId).toBe(SESSION2)
    await expect(h.controller.bindSession(UUID, { sessionId: UUID2, instance: INSTANCE })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('queues the check on completion, marks failure terminal, and never re-executes on repeats', async () => {
    const h = await harness()
    await expect(h.controller.finishChange(UUID, { outcome: 'completed' })).rejects.toMatchObject({ status: 404 })
    const { workspace } = await h.controller.prepareChange(h.payload())
    await expect(h.controller.finishChange(UUID, { outcome: 'maybe' })).rejects.toMatchObject({ status: 400 })
    h.git.commit(workspace, HEAD)
    const finished = await h.controller.finishChange(UUID, { outcome: 'completed' })
    expect(finished.state).toBe('checking')
    // Nothing ran yet: the finish call itself only queued the work.
    expect(h.runner.log).toEqual([])
    await h.controller.tick()
    expect(changeOf(h).state).toBe('awaiting_ci')
    const prCount = h.github.log.filter((entry) => entry[0] === 'create-pr').length
    // Repeating the completion is a no-op that returns the current state.
    expect((await h.controller.finishChange(UUID, { outcome: 'completed' })).state).toBe('awaiting_ci')
    await expect(h.controller.finishChange(UUID, { outcome: 'failed' })).rejects.toMatchObject({ status: 409 })
    await tickUntil(h, () => changeOf(h).state === 'live')
    expect(h.github.log.filter((entry) => entry[0] === 'create-pr')).toHaveLength(prCount)
    expect(h.github.log.filter((entry) => entry[0] === 'merge')).toHaveLength(1)
    // A completion after the change went live cannot re-execute the merge.
    expect((await h.controller.finishChange(UUID, { outcome: 'completed' })).state).toBe('live')
    await h.controller.tick()
    expect(h.github.log.filter((entry) => entry[0] === 'merge')).toHaveLength(1)
  })

  it('marks an agent failure without replaying anything', async () => {
    const h = await harness()
    await h.controller.prepareChange(h.payload())
    const failed = await h.controller.finishChange(UUID, { outcome: 'failed', error: 'agent crashed' })
    expect(failed).toMatchObject({ state: 'failed', error: 'agent crashed' })
    await h.controller.tick()
    expect(h.runner.log).toEqual([])
    expect(h.git.log.filter((entry) => entry[0] === 'push')).toEqual([])
    expect((await h.controller.status()).available).toBe(true)
  })
})

describe('check, publish and pull request', () => {
  it('verifies the workspace, runs the checks without credentials, publishes the exact head and opens a linked PR', async () => {
    const h = await harness()
    const { workspace } = await runToAwaitingCi(h)
    expect(changeOf(h)).toMatchObject({ state: 'awaiting_ci', headSha: HEAD, prNumber: 100, prUrl: 'https://github.com/mikkokotila/Poise/pull/100' })
    expect(h.runner.log).toEqual([['npm', 'ci', '--include=dev'], ['npm', 'run', 'check']])
    expect(h.git.log).toContainEqual(['push', `poise/change-${UUID}`, HEAD])
    expect(h.git.remoteRefs[`poise/change-${UUID}`]).toBe(HEAD)
    const pull = h.github.pulls[100]
    expect(pull.title).toBe('Make the chat header sticky')
    expect(pull.body).toContain(UUID)
    expect(pull.body).toContain('> Make the chat header sticky')
    expect(pull.body).toContain(SESSION2)
    expect(pull.body).toContain(`Head: \`${HEAD}\``)
    expect(pull.base.ref).toBe('main')
    expect(workspace).toBe(h.workspace)
  })

  it('blocks a change outside the auto lane, fail closed with the paths named', async () => {
    const h = await harness({ model: { entries: [{ status: 'M', oldMode: '100644', newMode: '100644', path: 'server/http.ts' }, { status: 'A', oldMode: '000000', newMode: '100644', path: 'src/ok.ts' }] } })
    await runToAwaitingCi(h)
    expect(changeOf(h)).toMatchObject({ state: 'blocked', error: /manual review.*server\/http\.ts: protected/ })
    expect(h.runner.log).toEqual([])
    expect(h.git.log.filter((entry) => entry[0] === 'push')).toEqual([])
    expect(Object.keys(h.github.pulls)).toEqual([])
    expect((await h.controller.status()).available).toBe(true)
  })

  it('blocks a dirty workspace, a wrong branch and a rewritten base', async () => {
    const dirty = await harness()
    const { workspace } = await dirty.controller.prepareChange(dirty.payload())
    dirty.git.commit(workspace, HEAD, { dirty: ' M src/main.ts' })
    await dirty.controller.finishChange(UUID, { outcome: 'completed' })
    await dirty.controller.tick()
    expect(changeOf(dirty)).toMatchObject({ state: 'blocked', error: /uncommitted changes/ })

    const branch = await harness()
    const prepared = await branch.controller.prepareChange(branch.payload())
    branch.git.workspaces[prepared.workspace].branch = 'main'
    branch.git.commit(prepared.workspace, HEAD)
    await branch.controller.finishChange(UUID, { outcome: 'completed' })
    await branch.controller.tick()
    expect(changeOf(branch)).toMatchObject({ state: 'blocked', error: /workspace is on main/ })

    const rebased = await harness({ model: { notAncestor: true } })
    await runToAwaitingCi(rebased)
    expect(changeOf(rebased)).toMatchObject({ state: 'blocked', error: /not an ancestor/ })
  })

  it('fails a change with no commits and a change whose checks fail, keeping the output tail', async () => {
    const empty = await harness()
    await runToAwaitingCi(empty, { headSha: BASE })
    expect(changeOf(empty)).toMatchObject({ state: 'failed', error: /no commits/ })

    const broken = await harness({ model: { checkFails: true } })
    await runToAwaitingCi(broken)
    expect(changeOf(broken)).toMatchObject({ state: 'failed', error: /npm run check exited 1[\s\S]*FAIL tests\/x\.test\.ts/ })
    expect(broken.git.log.filter((entry) => entry[0] === 'push')).toEqual([])
  })

  it('does not re-run the checks after a crash once they passed for the same head, and refuses to move an existing branch', async () => {
    const h = await harness({ model: { pushFails: true } })
    await runToAwaitingCi(h)
    // The push is uncertain: the change stays in checking with the check recorded.
    expect(changeOf(h)).toMatchObject({ state: 'checking', check: { headSha: HEAD } })
    h.model.pushFails = false
    const runsBefore = h.runner.log.length
    const resumed = await h.restartController()
    await resumed.tick()
    expect(h.runner.log).toHaveLength(runsBefore)
    expect((await openStore(h.root)).state.changes[UUID].state).toBe('awaiting_ci')

    // A different change whose deterministic branch already exists elsewhere is refused.
    const collision = await harness()
    collision.git.remoteRefs[`poise/change-${UUID}`] = HEAD2
    await runToAwaitingCi(collision)
    expect(changeOf(collision)).toMatchObject({ state: 'failed', error: /already exists/ })
  })

  it('re-observes a push whose connection dropped after the ref landed', async () => {
    const h = await harness({ model: { pushLandsButFails: true } })
    await runToAwaitingCi(h)
    expect(changeOf(h).state).toBe('checking')
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'awaiting_ci', prNumber: 100 })
    expect(h.git.log.filter((entry) => entry[0] === 'push')).toHaveLength(1)
  })

  it('adopts a pull request whose creation was uncertain instead of opening a second one', async () => {
    const h = await harness({ model: { createPrUncertain: true } })
    await runToAwaitingCi(h)
    expect(changeOf(h).state).toBe('checking')
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'awaiting_ci', prNumber: 100 })
    expect(Object.keys(h.github.pulls)).toEqual(['100'])
  })
})

describe('CI gate and merge', () => {
  it('waits for CI, fails on a red matrix, and fails when main drifts under the branch', async () => {
    const pending = await harness({ model: { ci: { [HEAD]: 'pending' } } })
    await runToAwaitingCi(pending)
    await pending.controller.tick()
    await pending.controller.tick()
    expect(changeOf(pending).state).toBe('awaiting_ci')
    pending.model.ci[HEAD] = 'failure'
    await pending.controller.tick()
    expect(changeOf(pending)).toMatchObject({ state: 'failed', error: /Node 22.*failure/ })

    const drift = await harness()
    await runToAwaitingCi(drift)
    drift.model.mainSha = MAIN2
    drift.model.compare = { status: 'diverged', ahead_by: 1, behind_by: 1 }
    await drift.controller.tick()
    expect(changeOf(drift)).toMatchObject({ state: 'failed', error: /main moved.*re-requested/ })
    expect(drift.github.log.filter((entry) => entry[0] === 'merge')).toEqual([])
  })

  it('fails when the PR head moves after the check, or the PR is closed', async () => {
    const moved = await harness()
    await runToAwaitingCi(moved)
    moved.model.prHeadOverride = HEAD2
    await moved.controller.tick()
    expect(changeOf(moved)).toMatchObject({ state: 'failed', error: /PR head moved/ })

    const closed = await harness()
    await runToAwaitingCi(closed)
    closed.github.pulls[100].state = 'closed'
    await closed.controller.tick()
    expect(changeOf(closed)).toMatchObject({ state: 'failed', error: /is closed/ })
  })

  it('enforces its own CI gate without requiring administrative branch protection', async () => {
    const h = await harness({ model: { protection: null } })
    h.github.getBranchProtection = async () => { throw new Error('No administrative permission or branch protection') }
    expect((await runToLive(h)).state).toBe('live')
  })

  it('refuses to merge a repository identity mismatch', async () => {
    const identity = await harness({ model: { repository: { full_name: 'mikkokotila/Poise-fork', default_branch: 'main' } } })
    await runToAwaitingCi(identity)
    await tickUntil(identity, () => changeOf(identity).state === 'failed')
    expect(changeOf(identity).error).toMatch(/identity mismatch/)
  })

  it('accepts ordinary backend changes through the same verified release path', async () => {
    const h = await harness({ model: { entries: [{ status: 'M', oldMode: '100644', newMode: '100644', path: 'server/editor.ts' }] } })
    expect((await runToLive(h)).state).toBe('live')
  })

  it('records the expected merge parents before contacting GitHub', async () => {
    const h = await harness()
    const original = h.github.mergePullRequest.bind(h.github)
    h.github.mergePullRequest = async (...args) => {
      expect(h.store.state.changes[UUID].merge).toMatchObject({ mainSha: BASE, attemptedAt: expect.any(String) })
      return original(...args)
    }
    expect((await runToLive(h)).state).toBe('live')
  })

  it('merges exactly the head with merge_method merge and verifies parents and tree', async () => {
    const h = await harness()
    const change = await runToLive(h)
    expect(h.github.log).toContainEqual(['merge', 100, HEAD])
    const commit = h.github.commits[change.mergeSha]
    expect(commit.parents.map((parent) => parent.sha)).toEqual([BASE, HEAD])
    expect(change.merge).toMatchObject({ mainSha: BASE })
  })

  it('stops before deploying when the merge commit does not match, and holds promotion', async () => {
    const parents = await harness({ model: { mergeBehaviour: 'wrong-parents' } })
    await runToAwaitingCi(parents)
    await tickUntil(parents, () => changeOf(parents).state === 'failed')
    expect(changeOf(parents).error).toMatch(/parents/)
    expect(parents.store.state.hold).toMatchObject({ changeId: UUID, reason: /merge verification failed/ })
    expect(parents.releases.log).toEqual([['stage', 'baseline-release', BASE]])
    expect(parents.restarts).toEqual([])

    const tree = await harness({ model: { mergeBehaviour: 'wrong-tree' } })
    await runToAwaitingCi(tree)
    await tickUntil(tree, () => changeOf(tree).state === 'failed')
    expect(changeOf(tree).error).toMatch(/tree/)
    expect(tree.restarts).toEqual([])
  })

  it('reconciles an uncertain merge by re-reading the pull request instead of merging again', async () => {
    const landed = await harness({ model: { mergeBehaviour: 'uncertain' } })
    await runToAwaitingCi(landed)
    await tickUntil(landed, () => changeOf(landed).merge?.attemptedAt)
    expect(changeOf(landed)).toMatchObject({ state: 'merging', merge: { mainSha: BASE } })
    await tickUntil(landed, () => changeOf(landed).state === 'live')
    expect(landed.github.log.filter((entry) => entry[0] === 'merge')).toHaveLength(1)

    const notLanded = await harness({ model: { mergeBehaviour: 'uncertain-not-merged' } })
    await runToAwaitingCi(notLanded)
    await tickUntil(notLanded, () => changeOf(notLanded).merge?.attemptedAt)
    expect(changeOf(notLanded).state).toBe('merging')
    await tickUntil(notLanded, () => changeOf(notLanded).state === 'live')
    expect(notLanded.github.log.filter((entry) => entry[0] === 'merge')).toHaveLength(2)
  })

  it('does not adopt a merge made outside the controller as this change', async () => {
    const h = await harness()
    await runToAwaitingCi(h)
    h.github.performMerge(100, HEAD)
    await tickUntil(h, () => changeOf(h).state === 'failed')
    expect(changeOf(h).error).toMatch(/merged outside the controller/)
    expect(h.restarts).toEqual([])
  })

  it('refuses a GitHub merge rejection as a definite failure', async () => {
    const h = await harness({ model: { mergeBehaviour: 'refuse' } })
    await runToAwaitingCi(h)
    await tickUntil(h, () => changeOf(h).state === 'failed')
    expect(changeOf(h).error).toMatch(/GitHub refused the merge/)
  })
})

describe('deploy and verify', () => {
  it('stages an immutable release, drains, switches the pointer, restarts and verifies before calling it live', async () => {
    const h = await harness()
    const change = await runToLive(h)
    expect(change).toMatchObject({ state: 'live', previousReleaseId: 'baseline-release' })
    expect(change.error).toBeUndefined()
    expect(change.releaseId).toMatch(/^20260919T100000Z-/)
    expect(h.releases.log.at(-1)).toEqual(['stage', change.releaseId, change.mergeSha])
    expect(h.app.log).toContainEqual(['drain', change.releaseId])
    expect(h.restarts).toEqual([change.releaseId])
    expect(await h.pointer()).toMatchObject({ id: change.releaseId, sha: change.mergeSha, previousId: 'baseline-release' })
    expect(h.store.state.previousReleaseId).toBe('baseline-release')
    expect(h.store.state.switching).toBeNull()
    const events = (await journal(h)).map((entry) => entry.event)
    expect(events.indexOf('switch.intent')).toBeLessThan(events.indexOf('deploy.switched'))
    expect(events.indexOf('deploy.switched')).toBeLessThan(events.indexOf('deploy.live'))
    const status = await h.controller.status()
    expect(status.activeRelease.id).toBe(change.releaseId)
    expect(status.previousRelease.id).toBe('baseline-release')
    expect(status.changes[0]).toMatchObject({ id: UUID, state: 'live', canRevert: true, releaseId: change.releaseId })
    expect(status.changes[0]).not.toHaveProperty('deploy')
    expect(status.available).toBe(true)
  })

  it('defers the switch while production is busy and never builds in the active directory', async () => {
    const h = await harness({ model: { busy: true } })
    await runToAwaitingCi(h)
    await tickUntil(h, () => changeOf(h).state === 'deploying')
    expect(h.restarts).toEqual([])
    const drains = h.app.log.filter((entry) => entry[0] === 'drain').length
    await h.controller.tick()
    expect(h.app.log.filter((entry) => entry[0] === 'drain')).toHaveLength(drains + 1)
    expect(h.restarts).toEqual([])
    h.model.busy = false
    await h.controller.tick()
    expect(changeOf(h).state).toBe('live')
    // The active baseline directory was never a build target.
    const baselineRoot = h.store.state.releases['baseline-release'].root
    for (const [, id] of h.releases.log) expect(h.store.state.releases[id].root).not.toBe(id === 'baseline-release' ? 'never' : baselineRoot)
  })

  it('gives up a drain that never finishes, resumes the app and holds', async () => {
    const h = await harness({ model: { busy: true } })
    await runToAwaitingCi(h)
    await tickUntil(h, () => changeOf(h).state === 'deploying')
    h.clock.advance(31_000)
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /drain limit/ })
    expect(h.app.log).toContainEqual(['resume'])
    expect(h.store.state.hold).toMatchObject({ changeId: UUID })
    expect(h.restarts).toEqual([])
  })

  it('fails a release build without touching production and resumes the app', async () => {
    const h = await harness()
    await runToAwaitingCi(h)
    h.model.stageFails = true
    await tickUntil(h, () => changeOf(h).state === 'failed')
    expect(changeOf(h).error).toMatch(/release build failed/)
    expect(h.restarts).toEqual([])
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.store.state.hold).toMatchObject({ changeId: UUID, reason: /release build failed/ })
  })

  it('refuses to switch when the drain endpoint rejects the bridge key', async () => {
    const h = await harness({ model: { drainForbidden: true } })
    await runToAwaitingCi(h)
    await tickUntil(h, () => changeOf(h).state === 'failed')
    expect(changeOf(h).error).toMatch(/drain endpoint answered 403/)
    expect(h.restarts).toEqual([])
  })
})

describe('deploy failure and restore', () => {
  /** Deploy a change whose freshly built release crashes on start; returns its release id. */
  async function deployCrashing(h) {
    await runToAwaitingCi(h)
    const originalStage = h.releases.stage
    h.releases.stage = async (args) => {
      const manifest = await originalStage(args)
      h.model.crashOn = [manifest.id]
      return manifest
    }
    await tickUntil(h, () => changeOf(h).state === 'verifying')
    return changeOf(h).releaseId
  }

  it('flips the pointer back, restarts the previous release, verifies it and records the hold', async () => {
    const h = await harness()
    const minted = await deployCrashing(h)
    expect(await h.pointer()).toMatchObject({ id: minted })
    expect(h.restarts).toEqual([minted])
    // Within the grace window the controller keeps waiting.
    h.clock.advance(5_000)
    await h.controller.tick()
    expect(changeOf(h).state).toBe('verifying')
    // Past it: restore.
    h.clock.advance(6_000)
    await h.controller.tick()
    const change = changeOf(h)
    expect(change).toMatchObject({ state: 'failed', error: /did not become healthy[\s\S]*baseline-release restored/, releaseId: minted, previousReleaseId: 'baseline-release' })
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release', sha: BASE })
    expect(h.restarts).toEqual([minted, 'baseline-release'])
    expect(h.model.running).toEqual({ id: 'baseline-release', sha: BASE })
    expect(h.store.state.hold).toMatchObject({ changeId: UUID, sha: change.mergeSha, reason: /did not become healthy/ })
    expect(h.store.state.releases[minted].rejected).toBe(true)
    expect(h.store.state.rejectedShas).toEqual([change.mergeSha])
    expect(h.store.state.switching).toBeNull()
    const status = await h.controller.status()
    expect(status).toMatchObject({ available: false, reason: /promotion hold/, activeRelease: { id: 'baseline-release' } })
    expect(status.changes[0].canRevert).toBe(false)
    // Nothing new is accepted while the hold stands; clearing it is a manual act.
    await expect(h.controller.prepareChange(h.payload({ id: UUID2 }))).rejects.toMatchObject({ code: 'hold' })
    await h.controller.clearHold()
    expect((await h.controller.status()).available).toBe(true)
  })

  it('keeps the hold and says so loudly when even the restored release cannot be verified', async () => {
    const h = await harness()
    const minted = await deployCrashing(h)
    h.model.crashOn = [minted, 'baseline-release']
    h.clock.advance(11_000)
    await h.controller.tick()
    expect(changeOf(h).state).toBe('reverting')
    h.clock.advance(11_000)
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /RESTORE OF baseline-release UNVERIFIED/ })
    expect(h.store.state.hold.reason).toMatch(/restore of baseline-release unverified/)
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
  })

  it('treats a failed launchctl restart as an unverified switch, restores, and reports the hold', async () => {
    const h = await harness()
    await runToAwaitingCi(h)
    h.model.restartFails = true
    await tickUntil(h, () => changeOf(h).state === 'verifying')
    expect(h.store.state.switching.restartError).toMatch(/launchctl kickstart failed/)
    h.clock.advance(11_000)
    await h.controller.tick()
    // The old process is still serving the baseline build, so the restore
    // verifies at once even though the restart command failed both times.
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /did not become healthy[\s\S]*baseline-release restored/ })
    expect(h.store.state.switching).toBeNull()
    expect(h.store.state.hold).toMatchObject({ changeId: UUID })
    expect(h.logs.filter((line) => /restart after .* failed/.test(line))).toHaveLength(2)
  })

  it('resumes a switch that was interrupted between pointer write and phase commit', async () => {
    const h = await harness()
    await runToAwaitingCi(h)
    await tickUntil(h, () => changeOf(h).state === 'merged')
    // Crash the controller right after the deploy wrote its intent and pointer.
    const originalWrite = h.store.writeActivePointer.bind(h.store)
    h.store.writeActivePointer = async (pointer) => {
      await originalWrite(pointer)
      throw new Error('simulated controller crash')
    }
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /simulated controller crash/ })
    // An in-process exception records the failure; a real crash would not.
    // Put the record back to what a crash leaves: intent, pointer, phase.
    await h.store.commit('test.uncrash', (draft) => {
      draft.changes[UUID].state = 'deploying'
      delete draft.changes[UUID].error
    })
    expect(h.store.state.switching).toMatchObject({ kind: 'deploy', changeId: UUID })
    expect(changeOf(h).deploy.phase).toBe('switching')
    expect(h.restarts).toEqual([])
    const resumed = await h.restartController()
    await resumed.tick()
    const reopened = await openStore(h.root)
    expect(reopened.state.changes[UUID].state).toBe('live')
    expect(reopened.state.switching).toBeNull()
    // The resume cannot know whether the restart happened, so it issues it once.
    expect(h.restarts).toHaveLength(1)
  })
})

describe('rollback', () => {
  it('is one durable click: hold before switch, pointer to previous, verify, then reverted with a pending source revert', async () => {
    const h = await harness()
    const live = await runToLive(h)
    const acknowledged = await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    expect(acknowledged).toMatchObject({ state: 'reverting', canRevert: false })
    // The hold is recorded durably before any pointer switch happens, and the
    // acknowledgement does not wait for the switch.
    expect(h.store.state.hold).toMatchObject({ changeId: UUID, sha: live.mergeSha, reason: /rollback of release .* requested/ })
    expect(h.restarts).toEqual([live.releaseId])
    expect((await journal(h)).map((entry) => entry.event)).toContain('rollback.requested')
    await h.controller.tick()
    // The same tick that verified the previous release already began the
    // source revert, so the public state has moved on from pending.
    expect(changeOf(h)).toMatchObject({ state: 'reverted', sourceRevert: { state: 'checking' } })
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release', sha: BASE })
    expect(h.model.running).toEqual({ id: 'baseline-release', sha: BASE })
    expect(h.restarts).toEqual([live.releaseId, 'baseline-release'])
    expect(h.store.state.releases[live.releaseId].rejected).toBe(true)
    expect(h.store.state.rejectedShas).toContain(live.mergeSha)
    expect(h.store.state.previousReleaseId).toBeNull()
    expect(h.store.state.hold.reason).toMatch(/rolled back to baseline-release/)
    const status = await h.controller.status()
    expect(status.activeRelease.id).toBe('baseline-release')
    expect(status.previousRelease).toBeNull()
    expect(status.changes[0]).toMatchObject({ state: 'reverted', canRevert: false, sourceRevert: { state: 'checking' } })
    expect(status.available).toBe(false)
  })

  it('needs no model, GitHub, git or build to roll back', async () => {
    const h = await harness()
    const live = await runToLive(h)
    h.model.offline = true
    const gitCalls = h.git.log.length
    const stageCalls = h.releases.log.length
    const runnerCalls = h.runner.log.length
    await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    await h.controller.tick()
    expect(changeOf(h).state).toBe('reverted')
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.releases.log).toHaveLength(stageCalls)
    expect(h.runner.log).toHaveLength(runnerCalls)
    // The source revert cannot start while GitHub is offline; nothing about the
    // production rollback depended on it.
    expect(changeOf(h).sourceRevert.state).toBe('pending')
    expect(h.git.log.slice(gitCalls)).toEqual([])
  })

  it('shares the operation across repeated clicks and refuses stale or foreign releases', async () => {
    const h = await harness()
    const live = await runToLive(h)
    await expect(h.controller.rollbackChange(UUID, { expectedReleaseId: 'baseline-release' })).rejects.toMatchObject({ status: 409, code: 'stale' })
    await expect(h.controller.rollbackChange(UUID, { expectedReleaseId: 'not valid!' })).rejects.toMatchObject({ status: 400 })
    await expect(h.controller.rollbackChange(UUID2, { expectedReleaseId: live.releaseId })).rejects.toMatchObject({ status: 404 })
    const first = await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    const second = await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    expect(second.state).toBe(first.state)
    expect(Object.keys(h.store.state.rollbacks)).toHaveLength(1)
    await expect(h.controller.rollbackChange(UUID, { expectedReleaseId: 'baseline-release' })).rejects.toMatchObject({ status: 409 })
    await h.controller.tick()
    expect(changeOf(h).state).toBe('reverted')
    // After completion, a repeated click returns the settled state and does nothing.
    const restartsBefore = h.restarts.length
    expect((await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })).state).toBe('reverted')
    await h.controller.tick()
    expect(h.restarts).toHaveLength(restartsBefore)
    // The release-level entry point shares the same operation too.
    const shared = await h.controller.rollbackRelease({ expectedReleaseId: live.releaseId })
    expect(shared.rollback.phase).toBe('done')
    // And the rolled-back release can never be a rollback target.
    await expect(h.controller.rollbackRelease({ expectedReleaseId: 'baseline-release' })).rejects.toMatchObject({ code: 'no_previous' })
  })

  it('does not let an older card roll back a newer change', async () => {
    const h = await harness()
    const first = await runToLive(h)
    // Second change lands on top.
    await h.controller.prepareChange(h.payload({ id: UUID2, sessionId: SESSION2 }))
    h.git.commit(`${h.paths.workspacesDir}/${UUID2}`, HEAD2)
    await h.controller.finishChange(UUID2, { outcome: 'completed' })
    await tickUntil(h, () => changeOf(h, UUID2).state === 'live')
    const second = changeOf(h, UUID2)
    expect(changeOf(h).state).toBe('superseded')
    const status = await h.controller.status()
    expect(status.changes.find((change) => change.id === UUID)).toMatchObject({ state: 'superseded', canRevert: false })
    expect(status.changes.find((change) => change.id === UUID2)).toMatchObject({ state: 'live', canRevert: true })
    await expect(h.controller.rollbackChange(UUID, { expectedReleaseId: first.releaseId })).rejects.toMatchObject({ status: 409, code: 'stale' })
    await expect(h.controller.rollbackChange(UUID, { expectedReleaseId: second.releaseId })).rejects.toMatchObject({ status: 409, code: 'stale' })
    expect(await h.pointer()).toMatchObject({ id: second.releaseId })
    // Rolling back the newer change lands on the first change's release.
    await h.controller.rollbackChange(UUID2, { expectedReleaseId: second.releaseId })
    await h.controller.tick()
    expect(await h.pointer()).toMatchObject({ id: first.releaseId })
    expect(changeOf(h, UUID2).state).toBe('reverted')
    expect(changeOf(h).state).toBe('superseded')
  })

  it('keeps the prior release and the hold when the previous release will not come up', async () => {
    const h = await harness()
    const live = await runToLive(h)
    h.model.crashOn = ['baseline-release']
    await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    await h.controller.tick()
    expect(changeOf(h).state).toBe('reverting')
    h.clock.advance(11_000)
    await h.controller.tick()
    expect(changeOf(h)).toMatchObject({ state: 'failed', error: /baseline-release did not become healthy/ })
    expect(h.store.state.rollbacks[`rollback-${live.releaseId}`].phase).toBe('failed')
    expect(h.store.state.hold.reason).toMatch(/did not become healthy/)
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(changeOf(h).sourceRevert).toBeUndefined()
  })

  it('abandons a deployment in flight when a rollback is requested', async () => {
    const h = await harness()
    const live = await runToLive(h)
    // A main update starts deploying but production is busy, so it waits.
    h.model.mainSha = MAIN2
    h.model.busy = true
    h.clock.advance(61_000)
    await h.controller.tick()
    expect(h.store.state.update.current).toMatchObject({ phase: 'draining' })
    await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    await h.controller.tick()
    expect(h.store.state.update.current).toBeNull()
    expect(h.app.log).toContainEqual(['resume'])
    expect(changeOf(h).state).toBe('reverted')
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
  })
})

describe('source revert reconciliation', () => {
  async function rolledBack(h) {
    const live = await runToLive(h)
    await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    await h.controller.tick()
    expect(changeOf(h).state).toBe('reverted')
    return live
  }

  it('reverts the exact stored merge on a fresh clone of main, checks, publishes, gates CI, merges, and clears the hold', async () => {
    const h = await harness()
    const live = await rolledBack(h)
    const revert = () => changeOf(h).sourceRevert
    // The tick that finished the rollback also prepared the revert branch.
    expect(revert().state).toBe('checking')
    expect(h.git.log).toContainEqual(['revert', live.mergeSha])
    const revertClone = h.git.log.find((entry) => entry[0] === 'clone' && entry[3] === `poise/revert-${UUID}`)
    expect(revertClone[2]).toBe(live.mergeSha) // main at the time
    const runsBefore = h.runner.log.length
    await tickUntil(h, () => revert().state === 'awaiting_ci')
    expect(revert().prUrl).toBe('https://github.com/mikkokotila/Poise/pull/101')
    expect(h.runner.log.slice(runsBefore)).toEqual([['npm', 'ci', '--include=dev'], ['npm', 'run', 'check']])
    expect(h.github.pulls[101].title).toBe('Revert: Make the chat header sticky')
    expect(h.github.pulls[101].body).toContain(live.mergeSha)
    expect(h.git.remoteRefs[`poise/revert-${UUID}`]).toBe(changeOf(h).revert.headSha)
    await tickUntil(h, () => revert().state === 'merged')
    expect(h.store.state.hold).toBeNull()
    // Reconcile only: nothing was deployed for the revert merge, the rolled-back
    // release remains rejected, and main's new head is not the rejected SHA.
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.store.state.releases[live.releaseId].rejected).toBe(true)
    expect(h.model.mainSha).not.toBe(live.mergeSha)
    expect(changeOf(h).state).toBe('reverted')
    // With the hold gone, the ordinary main update deploys the reverted main as a new release.
    h.clock.advance(61_000)
    await h.controller.tick()
    expect(await h.pointer()).toMatchObject({ sha: h.model.mainSha })
    expect(changeOf(h).state).toBe('reverted')
  })

  it('reports a conflict, keeps the prior release and keeps the hold', async () => {
    const h = await harness({ model: { revertConflict: true } })
    await rolledBack(h)
    expect(changeOf(h).sourceRevert).toMatchObject({ state: 'conflict', error: /conflicts with main/ })
    expect(h.store.state.hold).not.toBeNull()
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    await h.controller.tick()
    expect(h.git.log.filter((entry) => entry[0] === 'revert')).toHaveLength(1)
    expect(Object.keys(h.github.pulls)).toEqual(['100'])
  })

  it('reports failed revert checks and does not open a PR', async () => {
    const h = await harness()
    await rolledBack(h)
    h.model.checkFails = true
    await h.controller.tick()
    expect(changeOf(h).sourceRevert).toMatchObject({ state: 'failed', error: /revert checks failed/ })
    expect(Object.keys(h.github.pulls)).toEqual(['100'])
    expect(h.store.state.hold).not.toBeNull()
  })

  it('waits out GitHub outages without duplicating work', async () => {
    const h = await harness()
    await rolledBack(h)
    await tickUntil(h, () => changeOf(h).sourceRevert.state === 'awaiting_ci')
    h.model.offline = true
    await h.controller.tick()
    await h.controller.tick()
    expect(changeOf(h).sourceRevert.state).toBe('awaiting_ci')
    h.model.offline = false
    await tickUntil(h, () => changeOf(h).sourceRevert.state === 'merged')
    expect(h.github.log.filter((entry) => entry[0] === 'merge')).toHaveLength(2)
  })
})

describe('periodic main update', () => {
  it('deploys a new main as a release, keeps the previous artifact, and polls at most once a minute', async () => {
    const h = await harness()
    await h.controller.tick()
    expect(h.github.log.filter((entry) => entry[0] === 'main')).toHaveLength(1)
    await h.controller.tick()
    expect(h.github.log.filter((entry) => entry[0] === 'main')).toHaveLength(1)
    h.model.mainSha = MAIN2
    h.clock.advance(61_000)
    await h.controller.tick()
    const pointer = await h.pointer()
    expect(pointer).toMatchObject({ sha: MAIN2, previousId: 'baseline-release' })
    expect(h.store.state.releases['baseline-release']).toMatchObject({ rejected: false })
    expect(h.store.state.previousReleaseId).toBe('baseline-release')
    expect(h.store.state.update.current).toBeNull()
    const status = await h.controller.status()
    expect(status.previousRelease.id).toBe('baseline-release')
    expect(status.changes).toEqual([])
    // The CLI/recovery rollback works for releases without a change.
    const result = await h.controller.rollbackRelease({ expectedReleaseId: pointer.id })
    expect(result.rollback.phase).toBe('pending')
    expect(result.status.hold).not.toBeNull()
    await h.controller.tick()
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.store.state.rejectedShas).toContain(MAIN2)
    // Even with the hold cleared, main still points at the rejected SHA: no redeploy.
    await h.controller.clearHold()
    h.clock.advance(61_000)
    await h.controller.tick()
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.logs.some((line) => /rejected/.test(line))).toBe(true)
  })

  it('never overwrites a hold and does not deploy while a change is in flight', async () => {
    const h = await harness()
    await h.store.commit('test', (draft) => { draft.hold = { changeId: 'manual', sha: BASE, reason: 'operator hold' } })
    h.model.mainSha = MAIN2
    await h.controller.tick()
    expect(h.store.state.hold).toEqual({ changeId: 'manual', sha: BASE, reason: 'operator hold' })
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    await h.controller.clearHold()
    h.model.mainSha = BASE
    await h.controller.prepareChange(h.payload())
    h.model.mainSha = MAIN2
    h.clock.advance(61_000)
    await h.controller.tick()
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.store.state.update.current).toBeNull()
  })

  it('restores the previous release when a main update fails verification', async () => {
    const h = await harness()
    h.model.mainSha = MAIN2
    const originalStage = h.releases.stage
    h.releases.stage = async (args) => {
      const manifest = await originalStage(args)
      h.model.crashOn = [manifest.id]
      return manifest
    }
    await h.controller.tick()
    expect(h.store.state.update.current).toMatchObject({ phase: 'verifying' })
    expect((await h.controller.status()).reason).toMatch(/main update is being deployed/)
    h.clock.advance(11_000)
    await h.controller.tick()
    expect(h.store.state.update.current).toBeNull()
    expect(await h.pointer()).toMatchObject({ id: 'baseline-release' })
    expect(h.store.state.hold).toMatchObject({ changeId: /^release:/, sha: MAIN2 })
    expect(h.store.state.rejectedShas).toEqual([MAIN2])
    expect((await h.controller.status()).reason).toMatch(/promotion hold/)
  })

  it('tolerates a failed poll and keeps going', async () => {
    const h = await harness({ model: { offline: true } })
    await h.controller.tick()
    expect(h.store.state.update.lastCheckedAt).not.toBeNull()
    expect(h.logs.some((line) => /main poll failed/.test(line))).toBe(true)
  })

  it('does not poll main at all while disabled', async () => {
    const h = await harness({ model: { enabled: false } })
    await h.controller.tick()
    expect(h.github.log).toEqual([])
  })
})

describe('crash recovery', () => {
  it('fails a change whose workspace preparation was interrupted by a controller restart', async () => {
    const h = await harness()
    await h.store.commit('test', (draft) => {
      draft.changes[UUID] = {
        id: UUID, sessionId: SESSION, sourceSessionId: SESSION, instance: INSTANCE, request: 'r', title: 'r', repository: 'mikkokotila/Poise',
        branch: `poise/change-${UUID}`, baseSha: BASE, state: 'implementing', createdAt: '2026-09-19T09:00:00.000Z', updatedAt: '2026-09-19T09:00:00.000Z',
        workspace: h.workspace, prepared: false,
      }
    })
    const resumed = await h.restartController()
    await resumed.tick()
    expect((await openStore(h.root)).state.changes[UUID]).toMatchObject({ state: 'failed', error: /restarted before the workspace was prepared/ })
  })

  it('does not fail a change that is being prepared right now', async () => {
    const h = await harness()
    let release, entered
    const gate = new Promise((resolve) => { release = resolve })
    const cloning = new Promise((resolve) => { entered = resolve })
    const originalClone = h.git.clone
    h.git.clone = async (args) => { entered(); await gate; return originalClone(args) }
    const preparing = h.controller.prepareChange(h.payload())
    try {
      await cloning // the preparation intent is now durable, regardless of disk speed
      await h.controller.tick()
      expect(changeOf(h).state).toBe('implementing')
    } finally { release(); await preparing }
    expect((await preparing).change.state).toBe('implementing')
  })

  it('resumes a rollback interrupted after the pointer switch', async () => {
    const h = await harness()
    const live = await runToLive(h)
    await h.controller.rollbackChange(UUID, { expectedReleaseId: live.releaseId })
    // Simulate the crash: intent written and pointer switched, phase still pending.
    const baselineRoot = h.store.state.releases['baseline-release'].root
    await h.store.commit('test', (draft) => {
      draft.switching = {
        kind: 'rollback', changeId: UUID, releaseId: 'baseline-release',
        from: { id: live.releaseId, sha: live.mergeSha, root: '/r' }, to: { id: 'baseline-release', sha: BASE, root: baselineRoot },
        startedAt: h.clock.now().toISOString(),
      }
    })
    await h.store.writeActivePointer({ id: 'baseline-release', sha: BASE, root: baselineRoot, previousId: live.releaseId })
    const resumed = await h.restartController()
    await resumed.tick()
    const reopened = await openStore(h.root)
    expect(reopened.state.changes[UUID].state).toBe('reverted')
    expect(reopened.state.switching).toBeNull()
    expect(h.model.running).toEqual({ id: 'baseline-release', sha: BASE })
  })

  it('clears an orphaned switch intent nobody can verify', async () => {
    const h = await harness()
    await h.store.commit('test', (draft) => {
      draft.switching = { kind: 'deploy', changeId: null, releaseId: 'ghost', from: null, to: { id: 'baseline-release', sha: BASE, root: h.store.state.releases['baseline-release'].root }, startedAt: 'x' }
    })
    await h.controller.tick()
    expect(h.store.state.switching).toBeNull()
    expect(h.logs.some((line) => /orphaned switch intent/.test(line))).toBe(true)
  })
})

describe('concurrency', () => {
  it('serialises ticks and honours a kick that arrives mid-tick', async () => {
    const h = await harness()
    const first = h.controller.tick()
    expect(h.controller.reconciling).toBe(true)
    const second = h.controller.tick()
    expect(second).toBe(first)
    await first
    expect(h.controller.reconciling).toBe(false)
    expect(h.controller.hasPendingWork()).toBe(false)
    await h.controller.prepareChange(h.payload())
    expect(h.controller.hasPendingWork()).toBe(true)
  })
})
