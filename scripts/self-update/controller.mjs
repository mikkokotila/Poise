// The release controller: the one authority that turns an implemented change
// into a pushed branch, a pull request, a verified merge, an immutable release,
// a health-checked switch and — when asked — a rollback. It trusts nothing the
// agent says and nothing a candidate checkout contains; every decision is made
// from the store, the trusted policy copy, git and GitHub's own answers.
//
// Every step is written so that it can be re-entered after a crash: intents
// are recorded before side effects, and resumption re-observes the world (the
// remote branch, the PR, the merge commit, the health endpoint) instead of
// replaying requests blindly.
import { join } from 'node:path'
import { ensurePrivateDirectory } from './atomic.mjs'
import { scrubEnvironment } from './environment.mjs'
import {
  GitHubError, assertPullRequestIdentity, assertRepositoryIdentity, evaluateCi,
  isUncertain as isNetworkUncertain, verifyMergeCommit,
} from './github.mjs'
import { BASE_BRANCH, REPOSITORY, changeBranch, isReleaseId, isSha, isUuid, pullRequestUrl, revertBranch } from './paths.mjs'
import { describeViolations, reviewPolicy } from './policy.mjs'
import { newReleaseId, toRelease } from './releases.mjs'
import { ACTIVE_CHANGE_STATES, activeChange, publicChange } from './store.mjs'
import { AppUnreachable, assessHealth } from './app-bridge.mjs'

export class ControllerError extends Error {
  constructor(status, message, code = 'controller') {
    super(message)
    this.name = 'ControllerError'
    this.status = status
    this.code = code
  }
}

/** The outcome of a remote write is unknown; re-observe before acting again. */
export class UncertainError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UncertainError'
  }
}

function uncertain(error) {
  return error instanceof UncertainError || isNetworkUncertain(error)
}

export const DEFAULT_TIMING = {
  healthGraceMs: 180_000,
  restoreGraceMs: 180_000,
  drainMaxMs: 2 * 3_600_000,
  mainPollMs: 60_000,
  stepTimeoutMs: 20 * 60_000,
}

const MAX_REQUEST_CHARS = 20_000
const MAX_TITLE_CHARS = 200
const MAX_INSTANCE_CHARS = 200
const MAX_ERROR_CHARS = 2_000
const TERMINAL_REVERT_PHASES = new Set(['merged', 'conflict', 'failed'])
const REVERT_PUBLIC_STATE = {
  pending: 'pending', checking: 'checking', pushed: 'checking', awaiting_ci: 'awaiting_ci', merging: 'awaiting_ci',
  merged: 'merged', conflict: 'conflict', failed: 'failed',
}

function trimError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}

function defaultTitle(request) {
  const line = request.split('\n').map((part) => part.trim()).find(Boolean) || 'Poise change'
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

function samePayload(record, payload) {
  return record.sourceSessionId === payload.sessionId
    && record.instance === payload.instance
    && record.request === payload.request
    && record.title === (payload.title || defaultTitle(payload.request))
}

function terminalRollback(op) {
  return op.phase === 'done' || op.phase === 'failed'
}

export function createController({
  store,
  layout,
  enablement,
  git,
  github,
  releases,
  app,
  restart,
  runner,
  nodeBin = null,
  baseEnv = process.env,
  loadToken,
  now = () => new Date(),
  log = () => {},
  timing = {},
  recoveryUrl = null,
}) {
  const clock = { ...DEFAULT_TIMING, ...timing }
  const iso = () => now().toISOString()
  const elapsedSince = (stamp) => now().getTime() - Date.parse(stamp)
  const preparing = new Set()
  let reconciling = null
  let kicked = false
  let resumed = false
  let stopping = false

  // ── Store helpers ────────────────────────────────────────────────────────

  const change = (id) => store.state.changes[id] || null
  const releaseRecord = (id) => (id ? store.state.releases[id] || null : null)
  const activePointer = () => store.readActivePointer()
  const pendingRollback = () => Object.values(store.state.rollbacks).find((op) => !terminalRollback(op)) || null

  function commitChange(id, event, mutate, details = {}) {
    return store.commit(event, (draft) => {
      const target = draft.changes[id]
      if (!target) throw new ControllerError(404, `unknown change ${id}`, 'unknown_change')
      mutate(target, draft)
      target.updatedAt = iso()
      return target
    }, { changeId: id, ...details })
  }

  async function canRevert(record, pointer) {
    if (record.state !== 'live' || !pointer || record.releaseId !== pointer.id) return false
    const previous = releaseRecord(record.previousReleaseId)
    if (!previous || previous.rejected || store.state.previousReleaseId !== previous.id) return false
    return releases.isComplete(previous)
  }

  async function publicChanges(pointer) {
    const result = []
    for (const record of Object.values(store.state.changes)) {
      result.push(publicChange(record, await canRevert(record, pointer)))
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  function fail(id, error, state = 'failed') {
    log(`[self-update] change ${id} ${state}: ${trimError(error)}`)
    return commitChange(id, `change.${state}`, (target) => {
      target.state = state
      target.error = trimError(error)
    }, { error: trimError(error) })
  }

  function hasPendingWork() {
    const state = store.state
    return Boolean(activeChange(state))
      || Boolean(state.switching)
      || Boolean(pendingRollback())
      || Boolean(state.update.current)
      || Object.values(state.changes).some((record) => record.revert && !TERMINAL_REVERT_PHASES.has(record.revert.phase))
  }

  // ── Status ───────────────────────────────────────────────────────────────

  async function status() {
    const state = store.state
    const pointer = await activePointer()
    const gate = await enablement()
    const active = pointer ? releaseRecord(pointer.id) : null
    const previous = releaseRecord(state.previousReleaseId)
    const current = activeChange(state)
    let reason = gate.reason
    let available = gate.enabled
    const unavailable = (why) => { available = false; reason = why }
    if (available && !pointer) unavailable('no active release is recorded')
    else if (available && !active) unavailable(`active release ${pointer.id} is unknown to the controller`)
    else if (available && Object.keys(state.workers).length) unavailable('a release worker is active or awaiting verified cleanup')
    else if (available && state.hold) unavailable(`promotion hold: ${state.hold.reason}`)
    else if (available && state.update.current) unavailable('a main update is being deployed')
    else if (available && current) unavailable(`change ${current.id} is in progress`)
    else if (available && state.switching) unavailable('a release switch is in progress')
    const result = {
      enabled: gate.enabled,
      available,
      activeRelease: active ? toRelease(active) : null,
      previousRelease: previous && !previous.rejected ? toRelease(previous) : null,
      hold: state.hold,
      changes: await publicChanges(pointer),
    }
    if (reason) result.reason = reason
    if (recoveryUrl) result.recoveryUrl = recoveryUrl
    return result
  }

  // ── POST /changes ────────────────────────────────────────────────────────

  function validatePrepare(payload) {
    if (!payload || typeof payload !== 'object') throw new ControllerError(400, 'body must be an object', 'invalid')
    const { id, sessionId, instance, request, title } = payload
    if (!isUuid(id)) throw new ControllerError(400, 'id must be a UUID', 'invalid')
    if (!isUuid(sessionId)) throw new ControllerError(400, 'sessionId must be a UUID', 'invalid')
    if (typeof instance !== 'string' || !instance.trim() || instance.length > MAX_INSTANCE_CHARS) {
      throw new ControllerError(400, 'instance is required', 'invalid')
    }
    if (typeof request !== 'string' || !request.trim() || request.length > MAX_REQUEST_CHARS) {
      throw new ControllerError(400, `request must be 1–${MAX_REQUEST_CHARS} characters`, 'invalid')
    }
    if (title !== undefined && title !== null && (typeof title !== 'string' || title.length > MAX_TITLE_CHARS)) {
      throw new ControllerError(400, 'title must be a short string', 'invalid')
    }
    return { id: id.toLowerCase(), sessionId: sessionId.toLowerCase(), instance, request, title: title?.trim() || undefined }
  }

  function prepared(record) {
    return { change: publicChange(record, false), workspace: record.workspace, branch: record.branch, baseSha: record.baseSha }
  }

  async function requireHealthyBaseline() {
    const gate = await enablement()
    if (!gate.enabled) throw new ControllerError(503, gate.reason, 'disabled')
    const state = store.state
    if (Object.keys(state.workers).length) throw new ControllerError(409, 'a release worker is active or awaiting verified cleanup', 'busy')
    if (state.hold) throw new ControllerError(409, `promotion hold: ${state.hold.reason}`, 'hold')
    if (state.switching) throw new ControllerError(409, 'a release switch is in progress', 'busy')
    if (state.update.current) throw new ControllerError(409, 'a main update is being deployed', 'busy')
    if (pendingRollback()) throw new ControllerError(409, 'a rollback is in progress', 'busy')
    const pointer = await activePointer()
    const active = pointer ? releaseRecord(pointer.id) : null
    if (!pointer || !active) throw new ControllerError(503, 'no known active release', 'no_baseline')
    if (!await releases.isComplete(active)) throw new ControllerError(503, `active release ${active.id} is incomplete on disk`, 'no_baseline')
    let health
    try {
      health = assessHealth({ health: await app.health(), chat: await app.chatSessions() }, { sha: active.sha, releaseId: active.id })
    } catch (error) {
      throw new ControllerError(503, `production is not reachable: ${trimError(error)}`, 'no_baseline')
    }
    if (!health.healthy) throw new ControllerError(503, `production baseline is not healthy: ${health.reason}`, 'no_baseline')
    return { pointer, active }
  }

  async function prepareChange(rawPayload) {
    const payload = validatePrepare(rawPayload)
    const existing = change(payload.id)
    if (existing) {
      if (!samePayload(existing, payload)) throw new ControllerError(409, `change ${payload.id} exists with a different payload`, 'conflict')
      if (!existing.prepared) {
        if (existing.state === 'failed') throw new ControllerError(409, `change ${payload.id} failed to prepare: ${existing.error}`, 'prepare_failed')
        throw new ControllerError(409, `change ${payload.id} is still being prepared`, 'busy')
      }
      return prepared(existing)
    }
    const { active } = await requireHealthyBaseline()
    const busy = activeChange(store.state)
    if (busy) throw new ControllerError(409, `change ${busy.id} is already in progress; one change at a time`, 'busy')
    const workspace = join(layout.workspacesDir, payload.id)
    const branch = changeBranch(payload.id)
    const stamp = iso()
    preparing.add(payload.id)
    try {
      // Durable intent first: if the clone below crashes, the lane is still held
      // by a record the next tick fails cleanly instead of a half-made clone
      // nobody knows about.
      await store.commit('change.prepare', (draft) => {
        if (draft.changes[payload.id]) throw new ControllerError(409, 'change id collision', 'conflict')
        if (activeChange(draft)) throw new ControllerError(409, 'another change is already in progress', 'busy')
        draft.changes[payload.id] = {
          id: payload.id,
          sessionId: payload.sessionId,
          sourceSessionId: payload.sessionId,
          instance: payload.instance,
          request: payload.request,
          title: payload.title || defaultTitle(payload.request),
          repository: REPOSITORY,
          branch,
          baseSha: active.sha,
          state: 'implementing',
          createdAt: stamp,
          updatedAt: stamp,
          workspace,
          prepared: false,
        }
      }, { changeId: payload.id, baseSha: active.sha })
      try {
        await ensurePrivateDirectory(layout.workspacesDir)
        await git.clone({ dest: workspace, sha: active.sha, branch, token: await loadToken(), purpose: `change ${payload.id} workspace` })
        const head = await git.revParse(workspace, 'HEAD')
        if (head !== active.sha) throw new Error(`workspace HEAD ${head} is not the base ${active.sha}`)
        if (await git.currentBranch(workspace) !== branch) throw new Error('workspace is not on the change branch')
      } catch (error) {
        await fail(payload.id, `workspace preparation failed: ${trimError(error)}`)
        throw new ControllerError(502, `workspace preparation failed: ${trimError(error)}`, 'prepare_failed')
      }
      const record = await commitChange(payload.id, 'change.prepared', (target) => { target.prepared = true })
      return prepared(record)
    } finally {
      preparing.delete(payload.id)
    }
  }

  // ── POST /changes/<id>/session ───────────────────────────────────────────

  async function bindSession(id, body) {
    const record = change(id)
    if (!record) throw new ControllerError(404, `unknown change ${id}`, 'unknown_change')
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.toLowerCase() : null
    if (!isUuid(sessionId)) throw new ControllerError(400, 'sessionId must be a UUID', 'invalid')
    if (typeof body?.instance !== 'string' || body.instance !== record.instance) {
      throw new ControllerError(409, 'change belongs to a different instance', 'instance_mismatch')
    }
    if (record.sessionId === sessionId) return publicChange(record, false)
    if (record.state !== 'implementing' || record.sessionId !== record.sourceSessionId) {
      throw new ControllerError(409, `change ${id} is already bound to session ${record.sessionId}`, 'conflict')
    }
    const updated = await commitChange(id, 'change.session', (target) => { target.sessionId = sessionId }, { sessionId })
    return publicChange(updated, false)
  }

  // ── POST /changes/<id>/finish ────────────────────────────────────────────

  async function finishChange(id, body) {
    const record = change(id)
    if (!record) throw new ControllerError(404, `unknown change ${id}`, 'unknown_change')
    const outcome = body?.outcome
    if (outcome !== 'completed' && outcome !== 'failed') throw new ControllerError(400, 'outcome must be completed or failed', 'invalid')
    const error = typeof body?.error === 'string' ? body.error.slice(0, MAX_ERROR_CHARS) : undefined
    if (record.finish) {
      if (record.finish.outcome === outcome) return publicChange(record, await canRevert(record, await activePointer()))
      throw new ControllerError(409, `change ${id} already finished as ${record.finish.outcome}`, 'conflict')
    }
    if (record.state !== 'implementing') throw new ControllerError(409, `change ${id} is ${record.state}, not implementing`, 'conflict')
    if (!record.prepared) throw new ControllerError(409, `change ${id} has no prepared workspace`, 'conflict')
    const updated = await commitChange(id, `change.finish.${outcome}`, (target) => {
      target.finish = { outcome, error, at: iso() }
      if (outcome === 'completed') target.state = 'checking'
      else {
        target.state = 'failed'
        target.error = error || 'the agent reported failure'
      }
    }, { outcome })
    return publicChange(updated, false)
  }

  // ── Rollback requests ────────────────────────────────────────────────────

  async function requestRollback({ expectedReleaseId, changeId = null }) {
    if (!isReleaseId(expectedReleaseId)) throw new ControllerError(400, 'expectedReleaseId is required', 'invalid')
    const pointer = await activePointer()
    if (!pointer) throw new ControllerError(409, 'no active release', 'no_baseline')
    const existing = Object.values(store.state.rollbacks).find((op) => op.expectedReleaseId === expectedReleaseId && op.phase !== 'failed')
    if (existing) return existing
    if (pointer.id !== expectedReleaseId) {
      throw new ControllerError(409, `active release is ${pointer.id}, not ${expectedReleaseId}; refusing a stale rollback`, 'stale')
    }
    const previous = releaseRecord(store.state.previousReleaseId)
    if (!previous || previous.rejected) throw new ControllerError(409, 'no previous release is available to roll back to', 'no_previous')
    if (!await releases.isComplete(previous)) throw new ControllerError(409, `previous release ${previous.id} is incomplete on disk`, 'no_previous')
    if (changeId) {
      const record = change(changeId)
      if (!record) throw new ControllerError(404, `unknown change ${changeId}`, 'unknown_change')
      if (record.state !== 'live' || record.releaseId !== expectedReleaseId) {
        throw new ControllerError(409, `change ${changeId} is ${record.state} on release ${record.releaseId ?? 'none'}; only the live change can roll back`, 'stale')
      }
    }
    if (store.state.switching) throw new ControllerError(409, 'a release switch is in progress', 'busy')
    const id = `rollback-${expectedReleaseId}`
    const op = await store.commit('rollback.requested', (draft) => {
      // Hold first, durably, so no periodic update can promote anything while
      // the rollback is pending or after it lands.
      draft.hold = {
        changeId: changeId || `release:${expectedReleaseId}`,
        sha: pointer.sha,
        reason: `rollback of release ${expectedReleaseId} requested`,
      }
      draft.rollbacks[id] = {
        id, changeId, expectedReleaseId, expectedSha: pointer.sha, targetReleaseId: previous.id,
        phase: 'pending', createdAt: iso(), switchedAt: null, completedAt: null, error: null,
      }
      for (const record of Object.values(draft.changes)) {
        if (record.state === 'live' && record.releaseId === expectedReleaseId) {
          record.state = 'reverting'
          record.rollbackId = id
          record.updatedAt = iso()
        }
      }
      return draft.rollbacks[id]
    }, { rollbackId: id, changeId, expectedReleaseId })
    return op
  }

  async function rollbackChange(changeId, body) {
    const record = change(changeId)
    if (!record) throw new ControllerError(404, `unknown change ${changeId}`, 'unknown_change')
    const expectedReleaseId = body?.expectedReleaseId
    if (record.rollbackId && store.state.rollbacks[record.rollbackId]) {
      const op = store.state.rollbacks[record.rollbackId]
      if (op.expectedReleaseId !== expectedReleaseId) throw new ControllerError(409, `rollback already recorded for release ${op.expectedReleaseId}`, 'stale')
      return publicChange(record, false)
    }
    await requestRollback({ expectedReleaseId, changeId })
    return publicChange(change(changeId), false)
  }

  async function rollbackRelease(body) {
    const op = await requestRollback({ expectedReleaseId: body?.expectedReleaseId })
    return { rollback: op, status: await status() }
  }

  async function clearHold() {
    if (pendingRollback() || store.state.switching) throw new ControllerError(409, 'cannot clear the hold while a switch or rollback is pending', 'busy')
    await store.commit('hold.cleared', (draft) => { draft.hold = null })
    return status()
  }

  // ── Shared GitHub pipeline ───────────────────────────────────────────────

  async function publishBranch({ cwd, headSha, branch }) {
    const remote = await git.remoteRef({ branch, token: await loadToken() })
    if (remote === headSha) return
    if (remote) throw new Error(`branch ${branch} already exists at ${remote.slice(0, 12)}; refusing to move it`)
    try {
      await git.push({ cwd, sha: headSha, branch, token: await loadToken() })
    } catch (error) {
      // The push may have landed. Re-observing the remote ref next tick tells.
      throw new UncertainError(`push of ${branch} uncertain: ${trimError(error)}`)
    }
    const after = await git.remoteRef({ branch, token: await loadToken() })
    if (after !== headSha) throw new Error(`branch ${branch} is ${after ? after.slice(0, 12) : 'missing'} after push, expected ${headSha.slice(0, 12)}`)
  }

  async function ensurePullRequest({ branch, headSha, title, body }) {
    let pull = await github.findPullRequest(branch)
    if (!pull) {
      try {
        pull = await github.createPullRequest({ title, body, head: branch, base: BASE_BRANCH })
      } catch (error) {
        if (uncertain(error)) throw new UncertainError(`pull request creation uncertain: ${error.message}`)
        throw error
      }
    }
    assertPullRequestIdentity(pull, { branch, headSha })
    return { number: pull.number, url: pull.html_url || pullRequestUrl(pull.number) }
  }

  async function gateCi({ headSha, branch, prNumber }) {
    const pull = await github.getPullRequest(prNumber)
    if (pull.merged) return { status: 'merged', pull }
    if (pull.state !== 'open') return { status: 'failure', reason: `pull request #${prNumber} is ${pull.state}`, pull }
    assertPullRequestIdentity(pull, { branch, headSha })
    const mainSha = await github.getBranchSha(BASE_BRANCH)
    const comparison = await github.compare(mainSha, headSha)
    if (comparison?.behind_by > 0 || comparison?.status === 'diverged' || comparison?.status === 'behind') {
      return { status: 'failure', reason: `main moved to ${mainSha.slice(0, 12)}; the branch is ${comparison.behind_by} commit(s) behind and must be re-requested`, pull, mainSha }
    }
    if (comparison?.status !== 'ahead') return { status: 'failure', reason: `branch is not ahead of main (${comparison?.status ?? 'unknown'})`, pull, mainSha }
    const [checkRuns, workflowRuns] = await Promise.all([github.listCheckRuns(headSha), github.listWorkflowRuns(headSha)])
    return { ...evaluateCi({ headSha, checkRuns, workflowRuns }), pull, mainSha }
  }

  /**
   * Merge exactly `headSha` into main and prove the result. Returns
   * { mergeSha, baseSha }, or { uncertain: true, mainSha } when the network
   * left the outcome unknown so the caller can record the attempt and
   * re-observe on the next tick.
   */
  async function mergeVerified({ prNumber, branch, headSha, cwd, attempt = null, recordAttempt }) {
    assertRepositoryIdentity(await github.getRepository())
    const pull = await github.getPullRequest(prNumber)
    const headTree = await git.treeSha(cwd, headSha)
    if (pull.merged) {
      // Only a merge this controller attempted counts; anything else is a
      // human's merge, which the ordinary main update deploys on its own terms.
      if (!attempt?.mainSha) throw new Error(`pull request #${prNumber} was merged outside the controller; not deploying it as this change`)
      const mergeSha = pull.merge_commit_sha
      if (!isSha(mergeSha)) throw new Error(`pull request #${prNumber} is merged without a merge commit`)
      const commit = await github.getCommit(mergeSha)
      verifyMergeCommit({ commit, expectedBase: attempt.mainSha, expectedHead: headSha, headTree })
      return { mergeSha, baseSha: attempt.mainSha }
    }
    const gate = await gateCi({ headSha, branch, prNumber })
    if (gate.status !== 'success') throw new Error(`refusing to merge: ${gate.reason}`)
    const mainSha = gate.mainSha
    if (pull.mergeable === false) throw new Error(`pull request #${prNumber} is not mergeable (${pull.mergeable_state})`)
    // A restart after GitHub accepts the merge must be able to re-observe it.
    // Commit the expected parents before the remote side effect, not only
    // after a network error.
    await recordAttempt({ attemptedAt: iso(), mainSha })
    let result
    try {
      result = await github.mergePullRequest(prNumber, { sha: headSha })
    } catch (error) {
      if (uncertain(error)) return { uncertain: true, mainSha }
      if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) {
        throw new Error(`GitHub refused the merge: ${error.message}`)
      }
      throw error
    }
    if (result?.merged !== true || !isSha(result?.sha)) throw new Error(`merge response did not confirm a merge: ${result?.message || 'no message'}`)
    const commit = await github.getCommit(result.sha)
    verifyMergeCommit({ commit, expectedBase: mainSha, expectedHead: headSha, headTree })
    return { mergeSha: result.sha, baseSha: mainSha }
  }

  async function runProjectChecks({ cwd, id, label }) {
    const env = scrubEnvironment({ base: baseEnv, nodeBin })
    const logRoot = join(layout.logsDir, label, id)
    for (const [step, args] of [['npm-ci', ['ci', '--include=dev']], ['check', ['run', 'check']]]) {
      await runner.run('npm', args, {
        cwd, env, timeoutMs: clock.stepTimeoutMs, purpose: `${label} ${id} ${step}`,
        stdoutFile: join(logRoot, `${step}.stdout.log`), stderrFile: join(logRoot, `${step}.stderr.log`),
      })
    }
  }

  // ── Change pipeline ──────────────────────────────────────────────────────

  async function advanceChecking(record) {
    const cwd = record.workspace
    const dirty = await git.dirtyFiles(cwd)
    if (dirty) return fail(record.id, `workspace has uncommitted changes:\n${dirty.split('\n').slice(0, 10).join('\n')}`, 'blocked')
    const branch = await git.currentBranch(cwd)
    if (branch !== record.branch) return fail(record.id, `workspace is on ${branch || 'a detached HEAD'}, not ${record.branch}`, 'blocked')
    const headSha = await git.revParse(cwd, 'HEAD')
    if (headSha === record.baseSha) return fail(record.id, 'no commits were made on the change branch')
    if (!await git.isAncestor(cwd, record.baseSha, headSha)) {
      return fail(record.id, `base ${record.baseSha.slice(0, 12)} is not an ancestor of head ${headSha.slice(0, 12)}`, 'blocked')
    }
    const entries = await git.changedEntries(cwd, record.baseSha, headSha)
    const verdict = await reviewPolicy(entries, (side, path) => git.fileText(cwd, side === 'base' ? record.baseSha : headSha, path))
    if (!verdict.allowed) {
      return fail(record.id, `change is outside the auto lane and needs manual review: ${describeViolations(verdict.violations)}`, 'blocked')
    }
    await commitChange(record.id, 'change.head', (target) => { target.headSha = headSha })
    if (record.check?.headSha !== headSha) {
      try {
        await runProjectChecks({ cwd, id: record.id, label: 'changes' })
      } catch (error) {
        return fail(record.id, `npm ci / npm run check failed: ${trimError(error)}`)
      }
      const after = await git.revParse(cwd, 'HEAD')
      if (after !== headSha) return fail(record.id, `workspace HEAD moved during checks (${after.slice(0, 12)})`, 'blocked')
      if (await git.dirtyFiles(cwd)) return fail(record.id, 'checks modified tracked files in the workspace', 'blocked')
      await commitChange(record.id, 'change.checked', (target) => { target.check = { headSha, passedAt: iso() } })
    }
    try {
      await publishBranch({ cwd, headSha, branch: record.branch })
      const body = [
        `Poise self-improvement change \`${record.id}\`.`,
        '',
        '**Request**',
        '',
        ...record.request.split('\n').map((line) => `> ${line}`),
        '',
        `Session: \`${record.sessionId}\` on instance \`${record.instance}\``,
        `Base: \`${record.baseSha}\``,
        `Head: \`${headSha}\``,
        '',
        'Opened by the Poise release controller. It merges automatically once the required checks pass on this exact head.',
      ].join('\n')
      const pull = await ensurePullRequest({ branch: record.branch, headSha, title: record.title, body })
      return commitChange(record.id, 'change.pull_request', (target) => {
        target.prNumber = pull.number
        target.prUrl = pull.url
        target.state = 'awaiting_ci'
      }, { prNumber: pull.number })
    } catch (error) {
      if (uncertain(error)) {
        log(`[self-update] change ${record.id}: ${trimError(error)}; will re-observe`)
        return record
      }
      return fail(record.id, trimError(error))
    }
  }

  async function advanceAwaitingCi(record) {
    let gate
    try {
      gate = await gateCi({ headSha: record.headSha, branch: record.branch, prNumber: record.prNumber })
    } catch (error) {
      if (uncertain(error)) return record
      return fail(record.id, trimError(error))
    }
    if (gate.status === 'pending') return record
    if (gate.status === 'failure') return fail(record.id, gate.reason)
    return commitChange(record.id, 'change.ci_passed', (target) => { target.state = 'merging' }, { reason: gate.reason })
  }

  async function advanceMerging(record) {
    let result
    try {
      result = await mergeVerified({
        prNumber: record.prNumber, branch: record.branch, headSha: record.headSha, cwd: record.workspace, attempt: record.merge ?? null,
        recordAttempt: attempt => commitChange(record.id, 'change.merge_intent', target => { target.merge = attempt }),
      })
    } catch (error) {
      if (uncertain(error)) return record
      // A merge may already exist on GitHub; nothing here deploys it.
      await store.commit('hold.set', (draft) => {
        if (!draft.hold) draft.hold = { changeId: record.id, sha: record.headSha, reason: `merge verification failed: ${trimError(error)}` }
      }, { changeId: record.id })
      return fail(record.id, `merge verification failed: ${trimError(error)}`)
    }
    if (result.uncertain) {
      return commitChange(record.id, 'change.merge_uncertain', (target) => {
        target.merge = { attemptedAt: iso(), mainSha: result.mainSha }
      })
    }
    return commitChange(record.id, 'change.merged', (target) => {
      target.mergeSha = result.mergeSha
      target.merge = { ...(target.merge || {}), mainSha: result.baseSha, mergedAt: iso() }
      target.state = 'merged'
    }, { mergeSha: result.mergeSha })
  }

  // ── Deployment (shared by changes and main updates) ──────────────────────

  function newDeployment({ sha, kind, changeId = null }) {
    return {
      kind, changeId, sha, releaseId: newReleaseId(sha, now()), phase: 'staging', startedAt: iso(),
      drainStartedAt: null, switchedAt: null, fromReleaseId: null, restoreStartedAt: null, error: null,
    }
  }

  function deploymentState(phase) {
    if (phase === 'verifying') return 'verifying'
    if (phase === 'done') return 'live'
    if (phase === 'failed') return 'failed'
    if (phase === 'restoring' || phase === 'verifying_restore') return 'reverting'
    return 'deploying'
  }

  function currentDeployment(deployment) {
    return deployment.changeId ? store.state.changes[deployment.changeId]?.deploy : store.state.update.current
  }

  /** Persist a deployment mutation wherever the record lives and mirror it on its change. */
  function commitDeployment(deployment, event, mutate, details = {}) {
    return store.commit(event, (draft) => {
      const target = deployment.changeId ? draft.changes[deployment.changeId].deploy : draft.update.current
      mutate(target, draft)
      if (deployment.changeId) {
        const record = draft.changes[deployment.changeId]
        record.state = deploymentState(target.phase)
        record.releaseId = target.releaseId
        if (target.fromReleaseId) record.previousReleaseId = target.fromReleaseId
        if (target.error) record.error = target.error
        record.updatedAt = iso()
      } else if (target.phase === 'failed' || target.phase === 'done') {
        draft.update.current = null
      }
      return target
    }, { releaseId: deployment.releaseId, changeId: deployment.changeId, ...details })
  }

  async function resumeApp() {
    try {
      await app.resume()
    } catch (error) {
      log(`[self-update] resume after failure did not reach the app: ${trimError(error)}`)
    }
  }

  function holdFor(deployment, reason) {
    return { changeId: deployment.changeId || `release:${deployment.releaseId}`, sha: deployment.sha, reason }
  }

  async function failDeployment(deployment, error, { restore = false } = {}) {
    const message = trimError(error)
    log(`[self-update] deployment ${deployment.releaseId} failed: ${message}`)
    if (!restore) {
      await resumeApp()
      return commitDeployment(deployment, 'deploy.failed', (target, draft) => {
        target.phase = 'failed'
        target.error = message
        if (!draft.hold) draft.hold = holdFor(deployment, message)
      })
    }
    return commitDeployment(deployment, 'deploy.restoring', (target, draft) => {
      target.phase = 'restoring'
      target.error = message
      if (!draft.hold) draft.hold = holdFor(deployment, message)
    })
  }

  async function checkHealth(release) {
    try {
      const health = await app.health()
      const chat = await app.chatSessions()
      return assessHealth({ health, chat }, { sha: release.sha, releaseId: release.id })
    } catch (error) {
      return { healthy: false, reason: trimError(error) }
    }
  }

  /**
   * Ask launchd to restart production. A failure here is recorded, not thrown:
   * the pointer is already switched, and the verification phase that follows
   * judges what actually serves and restores if it is not the target.
   */
  async function restartProduction(context) {
    try {
      await restart()
    } catch (error) {
      log(`[self-update] restart after ${context} failed: ${trimError(error)}`)
      await store.commit('switch.restart_failed', (draft) => {
        if (draft.switching) draft.switching.restartError = trimError(error)
      }, { error: trimError(error) })
    }
  }

  /** Intent, then pointer, then restart: a crash between any two leaves an intent naming both sides. */
  async function switchTo({ kind, changeId = null, releaseId, from, to }) {
    await store.commit('switch.intent', (draft) => {
      draft.switching = {
        kind, changeId, releaseId,
        from: from ? { id: from.id, sha: from.sha, root: from.root } : null,
        to: { id: to.id, sha: to.sha, root: to.root },
        startedAt: iso(),
      }
    }, { kind, releaseId, to: to.id })
    await store.writeActivePointer({ id: to.id, sha: to.sha, root: to.root, previousId: from?.id ?? null })
    await restartProduction(`${kind} switch to ${to.id}`)
  }

  /** A switch intent this deployment already wrote before the controller stopped. */
  function ownSwitch(deployment, kind) {
    const intent = store.state.switching
    return intent && intent.kind === kind && intent.releaseId === deployment.releaseId ? intent : null
  }

  /** No deployment starts under a hold, so a hold seen mid-flight (a rollback's, typically) means stop. */
  function intervened() {
    if (pendingRollback()) return 'a rollback was requested; the deployment is abandoned'
    if (store.state.hold) return `a promotion hold was set (${store.state.hold.reason}); the deployment is abandoned`
    return null
  }

  async function advanceDeployment(deployment) {
    let current = currentDeployment(deployment)
    if (!current) return null
    if (current.phase === 'staging') {
      if (intervened()) return failDeployment(current, intervened())
      let manifest
      try {
        manifest = await releases.stage({ id: current.releaseId, sha: current.sha, token: await loadToken() })
      } catch (error) {
        return failDeployment(current, `release build failed: ${trimError(error)}`)
      }
      current = await commitDeployment(current, 'deploy.staged', (target, draft) => {
        draft.releases[manifest.id] = { ...toRelease(manifest), rejected: false }
        target.phase = 'draining'
        target.drainStartedAt = iso()
      })
    }
    if (current.phase === 'draining') {
      if (intervened()) return failDeployment(current, intervened())
      let drained
      try {
        const response = await app.drain(current.releaseId)
        if (!response.ok) return failDeployment(current, `drain endpoint answered ${response.status}`)
        drained = response.body?.ready === true
      } catch (error) {
        if (!(error instanceof AppUnreachable)) return failDeployment(current, `drain failed: ${trimError(error)}`)
        // No app answering means nothing to drain; the switch restarts it.
        drained = true
      }
      if (!drained) {
        if (elapsedSince(current.drainStartedAt) > clock.drainMaxMs) return failDeployment(current, 'production stayed busy past the drain limit')
        return current
      }
      current = await commitDeployment(current, 'deploy.drained', (target) => { target.phase = 'switching' })
    }
    if (current.phase === 'switching') {
      const own = ownSwitch(current, 'deploy')
      if (!own) {
        if (intervened()) return failDeployment(current, intervened())
        if (store.state.switching) return current
        const pointer = await activePointer()
        const to = store.state.releases[current.releaseId]
        current = await commitDeployment(current, 'deploy.switching', (target) => { target.fromReleaseId = pointer?.id ?? null })
        await switchTo({ kind: 'deploy', changeId: current.changeId, releaseId: current.releaseId, from: pointer, to })
      }
      current = await commitDeployment(current, 'deploy.switched', (target) => {
        target.phase = 'verifying'
        target.switchedAt = own?.startedAt ?? iso()
      })
    }
    if (current.phase === 'verifying') {
      const release = store.state.releases[current.releaseId]
      const health = await checkHealth(release)
      if (health.healthy) {
        return commitDeployment(current, 'deploy.live', (target, draft) => {
          target.phase = 'done'
          draft.switching = null
          draft.previousReleaseId = target.fromReleaseId
          for (const other of Object.values(draft.changes)) {
            if (other.id !== deployment.changeId && other.state === 'live') {
              other.state = 'superseded'
              other.updatedAt = iso()
            }
          }
        }, { health: health.reason })
      }
      if (elapsedSince(current.switchedAt) <= clock.healthGraceMs) return current
      current = await failDeployment(current, `release ${current.releaseId} did not become healthy: ${health.reason}`, { restore: true })
    }
    if (current.phase === 'restoring') {
      const from = store.state.releases[current.fromReleaseId]
      if (!from) {
        return commitDeployment(current, 'deploy.failed', (target, draft) => {
          target.phase = 'failed'
          target.error = `${target.error}; no previous release to restore`
          draft.switching = null
        })
      }
      if (!ownSwitch(current, 'restore')) {
        await switchTo({ kind: 'restore', changeId: current.changeId, releaseId: current.releaseId, from: store.state.releases[current.releaseId], to: from })
      }
      current = await commitDeployment(current, 'deploy.restored', (target, draft) => {
        target.phase = 'verifying_restore'
        target.restoreStartedAt = store.state.switching?.startedAt ?? iso()
        draft.releases[target.releaseId].rejected = true
        if (!draft.rejectedShas.includes(target.sha)) draft.rejectedShas.push(target.sha)
      })
    }
    if (current.phase === 'verifying_restore') {
      const from = store.state.releases[current.fromReleaseId]
      const health = await checkHealth(from)
      if (!health.healthy && elapsedSince(current.restoreStartedAt) <= clock.restoreGraceMs) return current
      return commitDeployment(current, 'deploy.failed', (target, draft) => {
        target.phase = 'failed'
        target.error = health.healthy
          ? `${target.error}; previous release ${from.id} restored`
          : `${target.error}; RESTORE OF ${from.id} UNVERIFIED: ${health.reason}`
        draft.switching = null
        if (!health.healthy) draft.hold = { ...(draft.hold || holdFor(target, '')), reason: `restore of ${from.id} unverified: ${health.reason}` }
      }, { restored: health.healthy })
    }
    return current
  }

  async function startChangeDeployment(record) {
    const deployment = newDeployment({ sha: record.mergeSha, kind: 'change', changeId: record.id })
    await commitChange(record.id, 'deploy.start', (target) => {
      target.deploy = deployment
      target.releaseId = deployment.releaseId
      target.state = 'deploying'
    }, { releaseId: deployment.releaseId })
    return deployment
  }

  // ── Rollback pipeline ────────────────────────────────────────────────────

  async function advanceRollback(op) {
    const commitOp = (event, mutate) => store.commit(event, (draft) => {
      mutate(draft.rollbacks[op.id], draft)
      return draft.rollbacks[op.id]
    }, { rollbackId: op.id })
    const failOp = (message) => commitOp('rollback.failed', (entry, draft) => {
      entry.phase = 'failed'
      entry.error = message
      if (draft.switching?.kind === 'rollback' && draft.switching.releaseId === entry.targetReleaseId) draft.switching = null
      draft.hold = { ...(draft.hold || { changeId: entry.changeId || `release:${entry.expectedReleaseId}`, sha: entry.expectedSha }), reason: message }
      for (const record of Object.values(draft.changes)) {
        if (record.rollbackId === entry.id && record.state === 'reverting') {
          record.state = 'failed'
          record.error = message
          record.updatedAt = iso()
        }
      }
    })
    let record = store.state.rollbacks[op.id]
    if (record.phase === 'pending') {
      const target = store.state.releases[record.targetReleaseId]
      const pointer = await activePointer()
      const own = store.state.switching?.kind === 'rollback' && store.state.switching.releaseId === target?.id ? store.state.switching : null
      if (!own) {
        if (store.state.switching) return record
        if (!pointer || pointer.id !== record.expectedReleaseId) {
          return failOp(`active release is ${pointer?.id ?? 'unknown'}, not ${record.expectedReleaseId}`)
        }
        // Best effort: let the app refuse new work for the moment of the
        // switch, but rollback must not depend on the app cooperating.
        try { await app.drain(target.id) } catch { /* the app may already be down */ }
        await switchTo({ kind: 'rollback', changeId: record.changeId, releaseId: target.id, from: pointer, to: target })
      }
      record = await commitOp('rollback.switched', (entry) => {
        entry.phase = 'verifying'
        entry.switchedAt = own?.startedAt ?? iso()
      })
    }
    if (record.phase === 'verifying') {
      const target = store.state.releases[record.targetReleaseId]
      const health = await checkHealth(target)
      if (health.healthy) {
        return commitOp('rollback.done', (entry, draft) => {
          entry.phase = 'done'
          entry.completedAt = iso()
          draft.switching = null
          // The rolled-back release is never a rollback target itself.
          draft.previousReleaseId = null
          draft.releases[entry.expectedReleaseId].rejected = true
          if (!draft.rejectedShas.includes(entry.expectedSha)) draft.rejectedShas.push(entry.expectedSha)
          draft.hold = {
            changeId: entry.changeId || `release:${entry.expectedReleaseId}`,
            sha: entry.expectedSha,
            reason: `release ${entry.expectedReleaseId} rolled back to ${target.id}; main still carries the rolled-back merge`,
          }
          for (const changeRecord of Object.values(draft.changes)) {
            if (changeRecord.rollbackId !== entry.id) continue
            changeRecord.state = 'reverted'
            changeRecord.updatedAt = iso()
            if (isSha(changeRecord.mergeSha)) {
              changeRecord.sourceRevert = { state: 'pending' }
              changeRecord.revert = {
                phase: 'pending', branch: revertBranch(changeRecord.id), workspace: join(layout.workspacesDir, `revert-${changeRecord.id}`),
                baseSha: null, headSha: null, prNumber: null, prUrl: null, mergeSha: null, attempt: null, error: null,
              }
            }
          }
        })
      }
      if (elapsedSince(record.switchedAt) <= clock.restoreGraceMs) return record
      return failOp(`previous release ${target.id} did not become healthy: ${health.reason}`)
    }
    return record
  }

  // ── Source revert reconciliation ─────────────────────────────────────────

  function publicRevert(revert) {
    const result = { state: REVERT_PUBLIC_STATE[revert.phase] || 'pending' }
    if (revert.prUrl) result.prUrl = revert.prUrl
    if (revert.error) result.error = revert.error
    return result
  }

  function commitRevert(changeId, event, mutate) {
    return commitChange(changeId, event, (target, draft) => {
      mutate(target.revert, target, draft)
      target.sourceRevert = publicRevert(target.revert)
    })
  }

  async function advanceRevert(record) {
    const revert = record.revert
    const failRevert = (error, phase = 'failed') => {
      log(`[self-update] source revert for ${record.id} ${phase}: ${trimError(error)}`)
      return commitRevert(record.id, `revert.${phase}`, (target) => {
        target.phase = phase
        target.error = trimError(error)
      })
    }
    try {
      switch (revert.phase) {
        case 'pending': {
          const mainSha = await github.getBranchSha(BASE_BRANCH)
          await ensurePrivateDirectory(layout.workspacesDir)
          await git.clone({ dest: revert.workspace, sha: mainSha, branch: revert.branch, token: await loadToken(), purpose: `revert ${record.id} workspace` })
          const outcome = await git.revertMerge(revert.workspace, record.mergeSha)
          if (outcome.conflict) return failRevert(`git revert -m 1 ${record.mergeSha.slice(0, 12)} conflicts with main: ${outcome.detail}`, 'conflict')
          return commitRevert(record.id, 'revert.prepared', (target) => {
            target.baseSha = mainSha
            target.headSha = outcome.sha
            target.phase = 'checking'
          })
        }
        case 'checking': {
          try {
            await runProjectChecks({ cwd: revert.workspace, id: record.id, label: 'reverts' })
          } catch (error) {
            return failRevert(`revert checks failed: ${trimError(error)}`)
          }
          return commitRevert(record.id, 'revert.checked', (target) => { target.phase = 'pushed' })
        }
        case 'pushed': {
          await publishBranch({ cwd: revert.workspace, headSha: revert.headSha, branch: revert.branch })
          const pull = await ensurePullRequest({
            branch: revert.branch,
            headSha: revert.headSha,
            title: `Revert: ${record.title}`,
            body: [
              `Source reconciliation for rolled-back Poise change \`${record.id}\`${record.prUrl ? ` (${record.prUrl})` : ''}.`,
              '',
              `Reverts merge \`${record.mergeSha}\` with \`git revert -m 1\`. Opened by the Poise release controller after production`,
              'was rolled back to the previous release; merging only reconciles main, it does not deploy anything.',
            ].join('\n'),
          })
          return commitRevert(record.id, 'revert.pull_request', (target) => {
            target.prNumber = pull.number
            target.prUrl = pull.url
            target.phase = 'awaiting_ci'
          })
        }
        case 'awaiting_ci': {
          const gate = await gateCi({ headSha: revert.headSha, branch: revert.branch, prNumber: revert.prNumber })
          if (gate.status === 'pending') return record
          if (gate.status === 'failure') return failRevert(gate.reason)
          return commitRevert(record.id, 'revert.ci_passed', (target) => { target.phase = 'merging' })
        }
        case 'merging': {
          const result = await mergeVerified({
            prNumber: revert.prNumber, branch: revert.branch, headSha: revert.headSha, cwd: revert.workspace, attempt: revert.attempt,
            recordAttempt: attempt => commitRevert(record.id, 'revert.merge_intent', target => { target.attempt = attempt }),
          })
          if (result.uncertain) {
            return commitRevert(record.id, 'revert.merge_uncertain', (target) => { target.attempt = { attemptedAt: iso(), mainSha: result.mainSha } })
          }
          return commitRevert(record.id, 'revert.merged', (target, changeRecord, draft) => {
            target.phase = 'merged'
            target.mergeSha = result.mergeSha
            // main now matches what is serving; the hold the rollback set has done its job.
            if (draft.hold && (draft.hold.changeId === changeRecord.id
              || draft.hold.changeId === `release:${changeRecord.releaseId}`)) draft.hold = null
          })
        }
        default:
          return record
      }
    } catch (error) {
      if (uncertain(error)) return record
      return failRevert(error)
    }
  }

  // ── Periodic main update ─────────────────────────────────────────────────

  async function reconcileMain() {
    const state = store.state
    if (state.update.current) return advanceDeployment(state.update.current)
    if (state.update.lastCheckedAt && elapsedSince(state.update.lastCheckedAt) < clock.mainPollMs) return null
    if (state.hold || state.switching || activeChange(state) || pendingRollback()) return null
    const gate = await enablement()
    if (!gate.enabled) return null
    const pointer = await activePointer()
    if (!pointer || !releaseRecord(pointer.id)) return null
    let mainSha
    try {
      mainSha = await github.getBranchSha(BASE_BRANCH)
    } catch (error) {
      log(`[self-update] main poll failed: ${trimError(error)}`)
      await store.commit('update.poll_failed', (draft) => { draft.update.lastCheckedAt = iso() }, { error: trimError(error) })
      return null
    }
    await store.commit('update.polled', (draft) => {
      draft.update.lastCheckedAt = iso()
      draft.update.lastMainSha = mainSha
    }, { mainSha })
    if (mainSha === pointer.sha) return null
    if (store.state.rejectedShas.includes(mainSha)) {
      log(`[self-update] main is at rejected ${mainSha.slice(0, 12)}; not redeploying`)
      return null
    }
    const deployment = newDeployment({ sha: mainSha, kind: 'update' })
    await store.commit('update.start', (draft) => { draft.update.current = deployment }, { releaseId: deployment.releaseId, sha: mainSha })
    log(`[self-update] main moved to ${mainSha.slice(0, 12)}; deploying release ${deployment.releaseId}`)
    return advanceDeployment(deployment)
  }

  // ── Reconciliation ───────────────────────────────────────────────────────

  async function resumeSwitching() {
    const intent = store.state.switching
    if (!intent) return
    // A switch was in flight when the controller stopped. Make the pointer
    // agree with the intent (the restart is idempotent), then let the owning
    // deployment or rollback verify from its recorded phase. An intent with no
    // owner cannot be verified by anyone and is cleared as such.
    const pointer = await activePointer()
    if (!pointer || pointer.id !== intent.to.id) {
      log(`[self-update] resuming switch to ${intent.to.id}: pointer is ${pointer?.id ?? 'missing'}`)
      await store.writeActivePointer({ id: intent.to.id, sha: intent.to.sha, root: intent.to.root, previousId: intent.from?.id ?? null })
      await restartProduction(`resumed switch to ${intent.to.id}`)
    } else if (!resumed) {
      // First reconciliation of this controller process with an intent still
      // open: the restart may never have been issued. Issuing it again is
      // idempotent; verification then judges what actually serves.
      log(`[self-update] resuming switch to ${intent.to.id}: restarting production to be sure it serves the pointer`)
      await restartProduction(`resumed switch to ${intent.to.id}`)
    }
    const owned = intent.kind === 'rollback'
      ? Boolean(pendingRollback())
      : Boolean((intent.changeId && store.state.changes[intent.changeId]?.deploy) || store.state.update.current)
    if (!owned) {
      log(`[self-update] orphaned switch intent to ${intent.to.id}; clearing`)
      await store.commit('switch.orphaned', (draft) => { draft.switching = null }, { to: intent.to.id })
    }
  }

  async function advanceChange(record) {
    switch (record.state) {
      case 'implementing':
        if (!record.prepared && !preparing.has(record.id)) return fail(record.id, 'the controller restarted before the workspace was prepared')
        return record
      case 'checking': return advanceChecking(record)
      case 'awaiting_ci': return advanceAwaitingCi(record)
      case 'merging': return advanceMerging(record)
      case 'merged': {
        if (store.state.hold) return fail(record.id, `merged but not deployed: promotion hold (${store.state.hold.reason})`)
        return advanceDeployment(await startChangeDeployment(record))
      }
      case 'deploying':
      case 'verifying':
      case 'reverting':
        if (record.rollbackId) return record
        if (!record.deploy) return fail(record.id, 'deployment record missing')
        return advanceDeployment(record.deploy)
      default:
        return record
    }
  }

  async function reconcileOnce() {
    if (Object.keys(store.state.workers).length) return
    await resumeSwitching()
    resumed = true
    for (const op of Object.values(store.state.rollbacks)) {
      if (!terminalRollback(op)) await advanceRollback(op)
    }
    const current = activeChange(store.state)
    if (current) {
      try {
        await advanceChange(current)
      } catch (error) {
        if (uncertain(error)) log(`[self-update] change ${current.id}: ${trimError(error)}; will retry`)
        else await fail(current.id, trimError(error))
      }
    }
    for (const record of Object.values(store.state.changes)) {
      if (record.revert && !TERMINAL_REVERT_PHASES.has(record.revert.phase)) await advanceRevert(record)
    }
    await reconcileMain()
  }

  function tick() {
    if (stopping) return reconciling || Promise.resolve()
    if (reconciling) {
      kicked = true
      return reconciling
    }
    reconciling = (async () => {
      try {
        do {
          kicked = false
          await reconcileOnce()
        } while (kicked && !stopping)
      } finally {
        reconciling = null
      }
    })()
    return reconciling
  }

  function kick() {
    tick().catch((error) => log(`[self-update] reconciliation failed: ${trimError(error)}`))
  }

  return {
    status,
    prepareChange,
    bindSession,
    finishChange,
    rollbackChange,
    rollbackRelease,
    clearHold,
    tick,
    kick,
    hasPendingWork,
    async stop() {
      stopping = true
      if (reconciling) await reconciling
    },
    get reconciling() {
      return reconciling !== null
    },
  }
}

export { ACTIVE_CHANGE_STATES }
