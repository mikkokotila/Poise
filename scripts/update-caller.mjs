import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function requireCommit(value, label) {
  const commit = value.trim().toLowerCase()
  if (!validCommit(commit)) throw new Error(`${label} did not resolve to a commit SHA`)
  return commit
}

export async function reconcileRuntime(options = {}) {
  const root = options.projectRoot || projectRoot
  const home = options.home || homedir()
  const release = options.callerRelease || callerRelease
  const repository = options.poiseRepository || poiseRepository
  const run = options.run || output
  const readHealth = options.readHealth || callerHealth
  const hookCurrent = options.hookCurrent || stopGateIsCurrent
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
  await run('git', ['fetch', '--quiet', repository, 'refs/heads/main'], { cwd: root })
  const remotePoise = requireCommit(
    (await run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root })).stdout,
    'Remote Poise main',
  )

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
    await install()
    return { action: 'updated-poise', poiseCommit: remotePoise }
  }

  const remoteCaller = requireCommit((await run('gh', [
    'api',
    `repos/${release.repository}/commits/${encodeURIComponent(release.ref)}`,
    '--jq',
    '.sha',
  ])).stdout, `Caller ${release.ref}`)
  const [localCaller, currentHook] = await Promise.all([
    readHealth(),
    hookCurrent({ home, manifest: { ...release, commit: remoteCaller } }),
  ])

  if (localCaller !== remoteCaller || !currentHook) {
    log(
      `Reconciling Caller/runtime from ${localCaller || 'unknown'} to ${remoteCaller}`
      + (currentHook ? '' : ' and repairing agent hooks'),
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
