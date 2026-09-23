// Refresh the actual standalone provider launchers, never an IDE's bundled CLI.
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'

export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'muse']
export const CLI_UPDATE_TIMEOUT_MS = 120_000
const COMMANDS = { claude: 'claude', codex: 'codex', grok: 'grok', antigravity: 'agy', muse: 'muse' }
const inflight = new Map()
const children = new Set()

// The standalone refresh runner owns detached updater groups. Its parent can
// stop it without leaving a downloader/discovery process alive behind the lock.
export function terminateUpdateChildren() {
  for (const child of children) {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = text => createHash('sha256').update(text).digest('hex')
function updateEnvironment(source) {
  const keys = ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LANG', 'LC_ALL', 'SHELL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
  return { ...Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])), CI: '1', NO_COLOR: '1' }
}
async function executable(command, env) {
  const candidates = isAbsolute(command) ? [command] : (env.PATH || '').split(delimiter).filter(Boolean).filter(isAbsolute).map(dir => join(dir, command))
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path } catch { /* next PATH entry */ }
  }
  throw new Error(`${command} is not installed on Poise's PATH`)
}

/** Run only the selected provider's updater, without a shell or model prompt. */
export function runUpdateCommand(command, args, { env, cwd, timeoutMs = CLI_UPDATE_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    children.add(child)
    let stdout = '', stderr = '', failure
    const terminate = reason => {
      if (failure) return
      failure = new Error(reason)
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already exited */ }
      child.stdout?.destroy(); child.stderr?.destroy()
    }
    const timer = setTimeout(() => terminate(`${command} update timed out`), timeoutMs)
    const collect = (name, chunk) => {
      if (failure) return
      if (name === 'stdout') stdout += chunk; else stderr += chunk
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 512 * 1024) terminate(`${command} update exceeded its output limit`)
    }
    child.stdout?.on('data', chunk => collect('stdout', chunk))
    child.stderr?.on('data', chunk => collect('stderr', chunk))
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); children.delete(child)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`${command} update exited ${code}; check the provider installation and network access`))
      else resolve({ stdout, stderr })
    })
  })
}

function updatePlan(provider, path) {
  if (provider === 'claude') return { command: path, args: ['install', 'latest'], env: {} }
  if (provider === 'muse') return { command: path, args: ['--version'], env: { MUSE_SYNC_UPDATE: '1', MUSE_NO_AUTO_UPDATE: '0' } }
  return { command: path, args: ['update'], env: {} }
}
const versionOf = output => {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '').trim()
  const version = /\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/.exec(text)?.[0]
  if (!version) throw new Error('The provider CLI did not report a verifiable version')
  return version
}
async function readReceipt(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}
async function saveReceipt(path, result) {
  const staged = `${path}.${randomUUID()}.tmp`
  await writeFile(staged, JSON.stringify(result) + '\n', { mode: 0o600 })
  await rename(staged, path)
}
async function acquireLock(path, timeoutMs = CLI_UPDATE_TIMEOUT_MS + 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = new Database(path, { timeout: 0 })
    try { lock.exec('BEGIN IMMEDIATE'); return lock }
    catch (error) { lock.close(); if (!String(error.code).startsWith('SQLITE_BUSY') || Date.now() >= deadline) throw error }
    await pause(40)
  }
}

async function update(provider, options, requestedAt) {
  const source = options.env || process.env
  const deadline = Date.now() + (options.timeoutMs ?? CLI_UPDATE_TIMEOUT_MS)
  const remaining = (limit = CLI_UPDATE_TIMEOUT_MS) => {
    const ms = Math.min(limit, deadline - Date.now())
    if (ms <= 0) throw new Error(`${provider} CLI update timed out`)
    return ms
  }
  const env = updateEnvironment(source)
  // Updater subprocesses use the same Node runtime as Poise, not a stale PATH Node.
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH || ''}`
  const root = options.root || join(source.HOME || source.USERPROFILE || homedir(), '.poise', 'provider-clis')
  let path, before, after, lock
  const run = options.run || runUpdateCommand
  const result = { provider, status: 'unavailable', checkedAt: new Date().toISOString() }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    path = await executable(COMMANDS[provider], { ...env, PATH: source.PATH })
    result.path = path
    const receipt = join(root, `${provider}-${hash(path).slice(0, 16)}.json`)
    lock = await acquireLock(receipt + '.lock.sqlite3', remaining())
    const prior = await readReceipt(receipt)
    const resolved = await realpath(path)
    const version = async () => {
      const shown = versionOf((await run(path, ['--version'], { env: { ...env, MUSE_NO_AUTO_UPDATE: '1' }, cwd: root, timeoutMs: remaining(10_000) })).stdout)
      if (provider === 'muse') {
        try {
          const build = (await readFile(join(dirname(resolved), '.muse-version'), 'utf8')).trim()
          if (/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(build) && build.startsWith(shown + '-')) return build
        } catch { /* Non-launcher installations report their version directly. */ }
      }
      return shown
    }
    try { before = await version(); result.before = before } catch { /* an incomplete npm install may be repairable */ }
    if (prior?.provider === provider && prior.path === path && Date.parse(prior.checkedAt) >= requestedAt && Date.parse(prior.checkedAt) <= Date.now() && prior.after === before && ['current', 'updated'].includes(prior.status)) return prior
    let plan = updatePlan(provider, path)
    const npmSuffix = '/lib/node_modules/@openai/codex/bin/codex.js'
    let registryVersion
    if (provider === 'codex' && resolved.endsWith(npmSuffix)) {
      const npm = await executable('npm', env)
      const latest = await run(npm, ['view', '@openai/codex@latest', 'version', '--json', '--prefer-online'], { env, cwd: root, timeoutMs: remaining(15_000) })
      registryVersion = JSON.parse(latest.stdout)
      if (typeof registryVersion !== 'string' || versionOf(registryVersion) !== registryVersion) throw new Error('npm did not return a valid latest Codex version')
      // Check the registry on every launch without reinstalling a large native
      // package when it is already current. A broken version probe still repairs.
      plan = before === registryVersion ? null : {
        command: npm, args: ['install', '--global', '--prefix', resolved.slice(0, -npmSuffix.length), '--include=optional', '--prefer-online', '@openai/codex@latest'], env: {},
      }
    }
    const output = plan ? await run(plan.command, plan.args, { env: { ...env, ...plan.env }, cwd: root, timeoutMs: remaining() }) : { stdout: '', stderr: '' }
    after = await version(); result.after = after
    const advertised = registryVersion || /(?:Version:|updated[^\n]*?to(?: version)?)[ \t]+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/i.exec(output.stdout + '\n' + output.stderr)?.[1]
    if (advertised && advertised !== after && !(provider === 'muse' && after.startsWith(advertised + '-R'))) throw new Error(`The updater installed ${advertised}, but Poise's launcher still reports ${after}; check duplicate CLI installations on PATH`)
    result.status = before === after ? 'current' : 'updated'
    result.checkedAt = new Date().toISOString()
    await saveReceipt(receipt, result)
  } catch (error) {
    result.status = 'unavailable'
    result.error = error instanceof Error ? error.message : String(error)
    result.checkedAt = new Date().toISOString()
  } finally {
    if (lock) { try { if (lock.inTransaction) lock.exec('ROLLBACK') } finally { lock.close() } }
  }
  return result
}

/** Check on each launch/check; only overlapping requests share a verification. */
export function ensureProviderCli(provider, options = {}) {
  if (!PROVIDERS.includes(provider)) return Promise.reject(new Error(`Unknown provider ${provider}`))
  const source = options.env || process.env
  const key = `${provider}:${options.root || ''}:${source.HOME || source.USERPROFILE || ''}:${source.PATH || ''}`
  if (inflight.has(key)) return inflight.get(key)
  const task = update(provider, options, Date.now()).finally(() => { if (inflight.get(key) === task) inflight.delete(key) })
  inflight.set(key, task)
  return task
}
export async function ensureProviderClis(options = {}) {
  return Object.fromEntries(await Promise.all(PROVIDERS.map(async provider => [provider, await ensureProviderCli(provider, options)])))
}

/** The daily job and Settings share one discovery writer across Poise processes. */
export async function withModelRefreshLock(reportPath, operation) {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 })
  const lock = await acquireLock(reportPath + '.lock.sqlite3', 14 * 60_000)
  try { return await operation() }
  finally { try { if (lock.inTransaction) lock.exec('ROLLBACK') } finally { lock.close() } }
}
