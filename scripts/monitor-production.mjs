import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const healthUrl = process.env.POISE_HEALTH_URL || 'http://127.0.0.1:5555/api/health'
const statePath = join(homedir(), '.poise', 'health-monitor.json')

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

const [before, current] = await Promise.all([previousState(), check()])
if (current.status !== before?.status) {
  if (current.status === 'healthy') notify('Production runtime recovered and is healthy.')
  else if (current.status === 'unavailable') notify('Production runtime is unavailable.')
  else notify('Production runtime is degraded. Open Poise for diagnostics.')
}
if (current.authStatus === 'reauth_required' && before?.authStatus !== 'reauth_required') {
  notify('Claude subscription sign-in is required.')
  runDetached('/usr/bin/open', [healthUrl.replace(/\/api\/health$/, '/')])
}
await saveState(current)
console.log(JSON.stringify(current))
if (current.status !== 'healthy') process.exitCode = 1
