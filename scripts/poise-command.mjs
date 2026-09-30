import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const SERVICE_LABEL = 'com.vaquum.poise'

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) return resolveRun({ stdout, stderr })
      const reason = signal ? `signal ${signal}` : `exit ${code}`
      rejectRun(new Error(`${command} failed (${reason})${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isPoiseHealth(body) {
  return body !== null
    && typeof body === 'object'
    && ['ok', 'degraded'].includes(body.status)
    && body.scheduler !== null
    && typeof body.scheduler === 'object'
    && body.claudeAuth !== null
    && typeof body.claudeAuth === 'object'
    && body.callerRelease !== null
    && typeof body.callerRelease === 'object'
}

async function fetchHealth(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json()
    return isPoiseHealth(body) ? body : null
  } catch {
    return null
  }
}

async function waitForHealth(probe, attempts, delayMs, pause) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await probe()
    if (health) return health
    if (attempt < attempts - 1) await pause(delayMs)
  }
  return null
}

function portNumber(value) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('POISE_PORT must be an integer between 1 and 65535')
  }
  return port
}

export async function openPoise(options = {}) {
  if (process.platform !== 'darwin' && !options.allowNonDarwin) {
    throw new Error('the managed poise command currently supports macOS launchd')
  }
  const home = options.home || homedir()
  const uid = options.uid ?? process.getuid()
  const execute = options.run || run
  const pause = options.pause || delay
  const fileExists = options.fileExists || exists
  const log = options.log || console.log
  const port = portNumber(options.port ?? process.env.POISE_PORT ?? '5555')
  const url = `http://127.0.0.1:${port}/`
  const healthUrl = `${url}api/health`
  const target = `gui/${uid}/${SERVICE_LABEL}`
  const plist = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  const projectRoot = options.projectRoot || process.env.POISE_PRODUCTION_ROOT || ''
  const probe = options.probe || (() => fetchHealth(
    options.fetch || globalThis.fetch,
    healthUrl,
    options.probeTimeoutMs || 1_500,
  ))
  const attempts = options.waitAttempts || 30
  const delayMs = options.waitDelayMs || 1_000

  let health = await probe()
  if (!health) {
    let registered = true
    try {
      await execute('/bin/launchctl', ['print', target])
    } catch {
      registered = false
    }
    await execute('/bin/launchctl', ['enable', target])

    if (registered) {
      await execute('/bin/launchctl', ['kickstart', target])
    } else if (await fileExists(plist)) {
      try {
        await execute('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist])
      } catch (error) {
        try {
          await execute('/bin/launchctl', ['print', target])
        } catch {
          throw error
        }
      }
    } else {
      if (!isAbsolute(projectRoot)) {
        throw new Error(`managed service is not installed and POISE_PRODUCTION_ROOT is invalid`)
      }
      const installer = join(projectRoot, 'scripts', 'install-production.mjs')
      if (!await fileExists(installer)) {
        throw new Error(`managed service is not installed and installer is missing: ${installer}`)
      }
      log('poise: repairing the managed production installation')
      await execute(process.execPath, [installer], { cwd: projectRoot, inherit: true })
    }

    health = await waitForHealth(probe, attempts, delayMs, pause)
    if (!health) {
      log('poise: managed service is unresponsive; restarting it once')
      await execute('/bin/launchctl', ['kickstart', '-k', target])
      health = await waitForHealth(probe, attempts, delayMs, pause)
    }
  }

  if (!health) {
    throw new Error(
      `managed service did not answer at ${healthUrl}; see ~/.poise/logs/production.err.log`,
    )
  }
  if (options.openBrowser !== false) await execute('/usr/bin/open', [url])
  log(`poise: ${url} (${health.status})`)
  return { action: 'opened', url, status: health.status }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('usage: poise [--check]')
  }
  await openPoise({ openBrowser: args[0] !== '--check' })
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await main()
  } catch (error) {
    console.error(`poise: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
