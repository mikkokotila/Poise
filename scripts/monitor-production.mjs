import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { assessUpdater, productionUpdatePath, readProductionUpdate, updaterAlert } from './production-update.mjs'

const healthUrl = process.env.POISE_HEALTH_URL || 'http://127.0.0.1:5555/api/health'
const statePath = join(homedir(), '.poise', 'health-monitor.json')
const updatePath = productionUpdatePath(homedir())

async function previousState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    return null
  }
}

async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, statePath)
}

function runDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function notify(message) {
  const escaped = message.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  runDetached('/usr/bin/osascript', [
    '-e',
    `display notification "${escaped}" with title "Poise"`,
  ])
}

async function check() {
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
    const body = await response.json()
    const healthy = response.ok && body?.status === 'ok'
    return {
      status: healthy ? 'healthy' : 'degraded',
      authStatus: typeof body?.claudeAuth?.status === 'string'
        ? body.claudeAuth.status
        : null,
      checkedAt,
    }
  } catch {
    return { status: 'unavailable', authStatus: null, checkedAt }
  }
}

const [before, current, update] = await Promise.all([previousState(), check(), readProductionUpdate(updatePath)])
if (current.status !== before?.status) {
  if (current.status === 'healthy') notify('Production runtime recovered and is healthy.')
  else if (current.status === 'unavailable') notify('Production runtime is unavailable.')
  else notify('Production runtime is degraded. Open Poise for diagnostics.')
}
if (current.authStatus === 'reauth_required' && before?.authStatus !== 'reauth_required') {
  notify('Claude subscription sign-in is required.')
  runDetached('/usr/bin/open', [healthUrl.replace(/\/api\/health$/, '/')])
}
// A healthy service on a stale commit is the failure the health check cannot
// see: the updater (update-caller.mjs) records each run, and this is where
// its silence or its failures become a notification.
const updater = assessUpdater(update)
const alert = updaterAlert(
  { previous: before?.updater ?? null, alerted: before?.updaterAlerted ?? null },
  updater,
  update,
)
if (alert.message) notify(alert.message)
current.updater = updater.status
current.updaterAlerted = alert.alerted
await saveState(current)
console.log(JSON.stringify(current))
if (current.status !== 'healthy') process.exitCode = 1
