import { selfUpdateRoot, selfUpdateEnabled, supervisorRequest } from './self-update-bridge.mjs'
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productionUpdatePath, readProductionUpdate, writeProductionUpdate } from './production-update.mjs'
import { configureStopGate, stopGateIsCurrent } from './stop-gate-runtime.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const callerRelease = JSON.parse(await readFile(
  join(projectRoot, 'config', 'caller-release.json'),
  'utf8',
))
const packageDocument = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const poiseRepository = packageDocument.repository?.url
const healthUrl = process.env.POISE_HEALTH_URL || 'http://127.0.0.1:5555/api/health'

function validCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(stderr.trim() || `${command} exited ${code}`))
    })
  })
}

async function callerHealth() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
    const health = await response.json()
    const commit = health?.callerRelease?.actualCommit?.toLowerCase()
    if (health?.callerRelease?.status === 'ready' && validCommit(commit)) return commit
  } catch {
    // The installer repairs an unavailable or invalid runtime.
  }
  return null
}

async function productionInstall(run) {
  await run(process.execPath, [join(dirname(scriptPath), 'install-production.mjs')], {
    env: {
      ...process.env,
      POISE_CALLER_UPDATER: '1',
      POISE_RUNTIME_RECONCILER: '1',
    },
  })
}

async function datastoreServicesCurrent({ home, commit }) {
  const executable = join(
    home,
    '.poise',
    'releases',
    'caller',
    commit,
    'venv',
    'bin',
    'github-datastore',
  )
  const launchAgents = join(home, 'Library', 'LaunchAgents')
  const labels = [
    'com.vaquum.github-datastore.sync',
    'com.vaquum.github-datastore.reconcile',
    'com.vaquum.github-datastore.health',
  ]
  try {
    const services = await Promise.all(labels.map((label) => readFile(
      join(launchAgents, `${label}.plist`),
      'utf8',
    )))
    return services.every((service) => service.includes(executable))
  } catch {
    return false
  }
}

function requireCommit(value, label) {
  const commit = value.trim().toLowerCase()
  if (!validCommit(commit)) throw new Error(`${label} did not resolve to a commit SHA`)
  return commit
}

// Every run leaves a record (production-update.json) whether it succeeds or
// throws: the health monitor reads it to notice an updater that keeps failing
// or has stopped running, and /api/health shows it in Settings. The record
// also carries the last commit whose install completed, so a fast-forward
// whose install failed is retried on the next tick instead of leaving the
// checkout on a commit the service was never rebuilt from.
export async function reconcileRuntime(options = {}) {
  const home = options.home || homedir()
  const statePath = options.statePath || productionUpdatePath(home)
  const readState = options.readState || readProductionUpdate
  const writeState = options.writeState || writeProductionUpdate
  const run = options.run || output

  const previous = await readState(statePath)
  const state = {
    at: null,
    status: 'failed',
    action: null,
    error: null,
    failingSince: null,
    poise: {
      deployed: null,
      installed: validCommit(previous?.poise?.installed) ? previous.poise.installed : null,
      remote: null,
      behind: null,
    },
    caller: validCommit(previous?.caller) ? previous.caller : null,
  }
  try {
    // A managed release controller is the only promoter once opted in. Even
    // when it is down, do not reinstall rejected code or update Caller here.
    const root = selfUpdateRoot(home)
    const managed = options.selfUpdateStatus
      ? await options.selfUpdateStatus()
      : await selfUpdateEnabled(root) ? await supervisorRequest(root, 'POST', '/tick', {}) : null
    if (managed) {
      if (!managed.enabled || !managed.activeRelease?.sha) throw new Error('Self-update controller has no verified active release')
      state.poise.deployed = requireCommit(managed.activeRelease.sha, 'Active release')
      state.poise.installed = state.poise.deployed
      state.poise.remote = managed.hold?.sha || managed.remoteSha || state.poise.deployed
      state.caller = managed.activeRelease.callerSha || state.caller
      if (managed.hold) throw new Error(`Automatic promotion held: ${managed.hold.reason}`)
      state.status = 'current'
      state.action = 'managed-self-update'
      return { action: 'managed-self-update', poiseCommit: state.poise.deployed }
    }
    const result = await reconcile({ ...options, home, run, previous, state })
    state.status = result.action === 'current' ? 'current' : 'updated'
    state.action = result.action
    return result
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    // One failure event has one timestamp, even across a millisecond boundary.
    state.at = new Date().toISOString()
    state.failingSince = previous?.status === 'failed' && typeof previous.failingSince === 'string'
      ? previous.failingSince
      : state.at
    throw error
  } finally {
    const { deployed, remote } = state.poise
    if (deployed && remote && deployed !== remote) {
      try {
        const count = (await run('git', ['rev-list', '--count', `${deployed}..${remote}`], {
          cwd: options.projectRoot || projectRoot,
        })).stdout
        state.poise.behind = /^\d+$/.test(count) ? Number(count) : null
      } catch {
        // The count is a courtesy for the operator; the record stands without it.
      }
    } else if (deployed && remote) {
      state.poise.behind = 0
    }
    state.at ??= new Date().toISOString()
    await writeState(statePath, state)
  }
}

async function reconcile(options) {
  const root = options.projectRoot || projectRoot
  const { home, run, previous, state } = options
  const release = options.callerRelease || callerRelease
  const repository = options.poiseRepository || poiseRepository
  const readHealth = options.readHealth || callerHealth
  const hookCurrent = options.hookCurrent || stopGateIsCurrent
  const datastoreCurrent = options.datastoreCurrent || datastoreServicesCurrent
  const repairHookConfiguration = options.repairHookConfiguration || configureStopGate
  const install = options.install || (() => productionInstall(run))
  const log = options.log || console.log

  if (typeof repository !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(
    repository,
  )) throw new Error('Poise package repository must be an HTTPS GitHub repository')

  const branch = (await run('git', ['branch', '--show-current'], { cwd: root })).stdout
  if (branch !== 'main') {
    throw new Error(`Production reconciliation requires branch main, found ${branch || 'detached HEAD'}`)
  }
  const dirty = (await run('git', ['status', '--porcelain'], { cwd: root })).stdout
  if (dirty) throw new Error('Production reconciliation requires a clean managed worktree')

  const localPoise = requireCommit(
    (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout,
    'Local Poise HEAD',
  )
  state.poise.deployed = localPoise
  await run('git', ['fetch', '--quiet', repository, 'refs/heads/main'], { cwd: root })
  const remotePoise = requireCommit(
    (await run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root })).stdout,
    'Remote Poise main',
  )
  state.poise.remote = remotePoise

  if (localPoise !== remotePoise) {
    try {
      await run('git', ['merge-base', '--is-ancestor', localPoise, remotePoise], { cwd: root })
    } catch {
      throw new Error('Remote Poise main is not a fast-forward of the deployed commit')
    }
    log(`Updating Poise from ${localPoise} to ${remotePoise}`)
    await run('git', ['merge', '--ff-only', remotePoise], { cwd: root })
    const deployed = requireCommit(
      (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout,
      'Deployed Poise HEAD',
    )
    if (deployed !== remotePoise) throw new Error('Poise fast-forward did not deploy the selected commit')
    state.poise.deployed = deployed
    await install()
    state.poise.installed = deployed
    return { action: 'updated-poise', poiseCommit: remotePoise }
  }

  // The checkout is on main's commit. If the last completed install was for
  // an older one — the fast-forward went through and the install then failed
  // — the service is still running that older build, and nothing above would
  // ever run the install again. A record with no install at all predates
  // this bookkeeping; its install happened, so it is adopted, not repeated.
  if (!previous || !state.poise.installed) {
    state.poise.installed = localPoise
  } else if (state.poise.installed !== localPoise) {
    log(`Installing Poise ${localPoise}: the previous install did not complete`)
    await install()
    state.poise.installed = localPoise
    return { action: 'installed-poise', poiseCommit: localPoise }
  }

  const remoteCaller = requireCommit((await run('gh', [
    'api',
    `repos/${release.repository}/commits/${encodeURIComponent(release.ref)}`,
    '--jq',
    '.sha',
  ])).stdout, `Caller ${release.ref}`)
  state.caller = remoteCaller
  const [localCaller, currentHook, currentDatastore] = await Promise.all([
    readHealth(),
    hookCurrent({ home, manifest: { ...release, commit: remoteCaller } }),
    datastoreCurrent({ home, commit: remoteCaller }),
  ])

  if (localCaller !== remoteCaller || !currentHook || !currentDatastore) {
    log(
      `Reconciling Caller/runtime from ${localCaller || 'unknown'} to ${remoteCaller}`
      + (currentHook ? '' : ' and repairing agent hooks')
      + (currentDatastore ? '' : ' and repairing datastore services'),
    )
    await install()
    return { action: 'reconciled-runtime', callerCommit: remoteCaller }
  }

  await repairHookConfiguration({ home, run })
  log(`Poise ${localPoise} and Caller ${remoteCaller} are current; agent hooks are configured`)
  return { action: 'current', poiseCommit: localPoise, callerCommit: remoteCaller }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await reconcileRuntime()
}
