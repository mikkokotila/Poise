// The controller daemon: one process per root, holding the controller lock,
// serving the private control API on the Unix socket and the recovery UI on
// loopback, writing a heartbeat, and reconciling on a cadence of ~5 s while
// work is pending and ~60 s otherwise. Every collaborator is injectable so
// tests run the whole daemon against fakes in a temporary root.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppBridge, createLaunchdRestarter, loadBridgeKey } from './app-bridge.mjs'
import { acquireLock, ensurePrivateDirectory, writeJsonAtomic } from './atomic.mjs'
import { assessEnablement, loadReleaseToken, readConfig } from './config.mjs'
import { createControlServer } from './control-api.mjs'
import { createController } from './controller.mjs'
import { createGit } from './git.mjs'
import { createGitHubClient } from './github.mjs'
import { layout, selfUpdateRoot } from './paths.mjs'
import { createRecoveryServer } from './recovery.mjs'
import { createReleaseManager } from './releases.mjs'
import { createRunner, reapWorkers } from './runner.mjs'
import { openStore } from './store.mjs'

export const PENDING_INTERVAL_MS = 5_000
export const IDLE_INTERVAL_MS = 60_000
export const HEARTBEAT_INTERVAL_MS = 5_000

function workerRegistry(store) {
  return {
    register(worker) {
      return store.commit('worker.start', (draft) => { draft.workers[worker.pid] = worker }, { pid: worker.pid, purpose: worker.purpose })
    },
    release(pid) {
      return store.commit('worker.end', (draft) => { delete draft.workers[pid] }, { pid })
    },
  }
}

/**
 * Start the daemon. `adapters` may override any collaborator:
 * { git, github, releases, app, restart, runner, enablement, loadToken, now, timing, recoveryPort, recoveryHost }.
 */
export async function startDaemon({ root = selfUpdateRoot(), env = process.env, log = (line) => console.log(line), adapters = {} } = {}) {
  const paths = layout(root)
  await ensurePrivateDirectory(root)
  const lock = await acquireLock(paths.lockPath)
  let store
  try {
    store = await openStore(root)
  } catch (error) {
    await lock.release()
    throw error
  }
  const reaped = reapWorkers(store.state.workers)
  if (reaped.length) {
    log(`[self-update] reaped ${reaped.length} worker process group(s) left by a previous controller`)
    await store.commit('workers.reaped', (draft) => { for (const pid of reaped) delete draft.workers[pid] }, { pids: reaped })
  }

  if (Object.keys(store.state.workers).length) log('[self-update] retained unverifiable workers; automatic work waits for recovery')

  const { config } = await readConfig(root, env)
  const now = adapters.now || (() => new Date())
  const enablement = adapters.enablement || (() => assessEnablement(root, env))
  const loadToken = adapters.loadToken || (() => loadReleaseToken(config.tokenFile))
  const runner = adapters.runner || createRunner({ workers: workerRegistry(store), log })
  const git = adapters.git || createGit({ runner, nodeBin: config.nodeBin, baseEnv: env })
  const github = adapters.github || createGitHubClient({ loadToken })
  const releases = adapters.releases || createReleaseManager({
    releasesDir: paths.releasesDir, logsDir: paths.logsDir, git, runner, nodeBin: config.nodeBin, baseEnv: env, callerSha: config.callerSha, log,
  })
  const app = adapters.app || createAppBridge({ port: config.productionPort, loadKey: () => loadBridgeKey(config.bridgeKeyFile) })
  const restart = adapters.restart || createLaunchdRestarter({ runner, label: config.productionServiceLabel, baseEnv: env })
  const recoveryHost = adapters.recoveryHost || '127.0.0.1'
  const recoveryPort = adapters.recoveryPort ?? config.recoveryPort
  const recoveryUrl = `http://${recoveryHost}:${recoveryPort}/`

  const controller = createController({
    store, layout: paths, enablement, git, github, releases, app, restart, runner,
    nodeBin: config.nodeBin, baseEnv: env, loadToken, now, log, timing: adapters.timing || {}, recoveryUrl,
  })

  const control = createControlServer(controller, { socketPath: paths.socketPath, log })
  const recovery = createRecoveryServer(controller, { host: recoveryHost, port: recoveryPort, log })
  try {
    await control.listen()
    await recovery.listen()
  } catch (error) {
    await control.close().catch(() => {})
    await recovery.close().catch(() => {})
    await lock.release()
    throw error
  }

  const startedAt = now().toISOString()
  let stopped = false
  let loopTimer = null
  let heartbeatTimer = null

  async function heartbeat(status = 'running') {
    try {
      await writeJsonAtomic(paths.heartbeatPath, {
        pid: process.pid, status, startedAt, at: now().toISOString(), pending: controller.hasPendingWork(), recoveryUrl,
      })
    } catch (error) {
      log(`[self-update] heartbeat write failed: ${error?.message || error}`)
    }
  }

  function schedule(delay) {
    if (stopped) return
    clearTimeout(loopTimer)
    loopTimer = setTimeout(loop, delay)
    loopTimer.unref?.()
  }

  async function loop() {
    if (stopped) return
    try {
      await controller.tick()
    } catch (error) {
      log(`[self-update] tick failed: ${error?.stack || error}`)
    }
    schedule(controller.hasPendingWork() ? PENDING_INTERVAL_MS : IDLE_INTERVAL_MS)
  }

  await heartbeat()
  heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}) }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
  schedule(0)

  async function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(loopTimer)
    clearInterval(heartbeatTimer)
    await recovery.close().catch(() => {})
    await control.close().catch(() => {})
    // Keep exclusive ownership until the current reconcile and its worker
    // groups settle. Releasing early permits a second daemon to write here.
    await controller.stop()
    await heartbeat('stopped')
    await lock.release()
    log('[self-update] controller stopped')
  }

  return {
    root, paths, controller, store, config, runner, socketPath: paths.socketPath, recoveryUrl, stop,
    /** Run the loop body once, for tests and the CLI. */
    tick: () => controller.tick(),
  }
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (isEntrypoint) {
  const daemon = await startDaemon()
  const shutdown = () => { daemon.stop().finally(() => process.exit(0)) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(`[self-update] controller running for ${daemon.root}; recovery ui at ${daemon.recoveryUrl}`)
}
