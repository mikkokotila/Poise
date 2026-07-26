import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(await readFile(
  join(projectRoot, 'config', 'caller-release.json'),
  'utf8',
))
const healthUrl = process.env.POISE_HEALTH_URL || 'http://127.0.0.1:5555/api/health'

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
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
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `${command} exited ${code}`))
    })
  })
}

const remoteCommit = (await output('gh', [
  'api',
  `repos/${release.repository}/commits/${encodeURIComponent(release.ref)}`,
  '--jq',
  '.sha',
])).toLowerCase()
if (!/^[0-9a-f]{40}$/.test(remoteCommit)) {
  throw new Error(`Caller ${release.ref} did not resolve to a commit SHA`)
}

let localCommit = null
try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
  const health = await response.json()
  if (health?.callerRelease?.status === 'ready') {
    localCommit = health.callerRelease.actualCommit
  }
} catch {
  // An unavailable or invalid runtime is repaired by the production installer.
}

if (localCommit === remoteCommit) {
  console.log(`Caller ${release.ref} is current at ${remoteCommit}`)
} else {
  console.log(`Updating Caller from ${localCommit || 'unknown'} to ${remoteCommit}`)
  await output(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'install-production.mjs')], {
    env: { ...process.env, POISE_CALLER_UPDATER: '1' },
  })
}
