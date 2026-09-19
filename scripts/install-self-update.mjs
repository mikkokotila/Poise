// One-time bootstrap and maintenance of the independent self-update controller
// on macOS launchd. Run by hand, after the bootstrap pull request has been
// merged and the legacy updater has fast-forwarded ~/.poise/production onto it:
//
//   node scripts/install-self-update.mjs enable --token-file ~/.poise/release-token
//   node scripts/install-self-update.mjs enable --dry-run
//   node scripts/install-self-update.mjs status | doctor
//   node scripts/install-self-update.mjs disable      (maintenance: legacy launcher back, controller stopped)
//   node scripts/install-self-update.mjs uninstall    (after disable: hand ownership back to the legacy updater)
//
// What `enable` does, in order, and why the order matters:
//
//   1. Preflight, no writes. The managed launchd plist is parsed and everything
//      production runs with today — POISE_DB, the editor/workspace identity, the
//      pinned Caller release SHA/root/bin, the Node runtime — is read from it,
//      never re-derived. The checkout it runs from must be a clean
//      mikkokotila/Poise `main` at exactly the SHA GitHub's `main` is at, and
//      the running server must already serve that SHA. The release token file
//      must be private and must be able to push to this one repository.
//   2. `installed.json` is written before anything else. From that moment
//      scripts/self-update-bridge.mjs makes the legacy installer and updater
//      refuse to touch production, so nothing can move the launcher back under
//      us; then the legacy updater is waited out in case a run was in flight.
//   3. The baseline release is staged in a fresh clone: exact SHA, `npm ci
//      --include=dev` (the build needs vite, tsc and esbuild, which a
//      production `npm ci` omits), `npm run build` stamped with the SHA, then
//      re-verified. The active checkout, its dist/ and node_modules are never
//      touched; the release is a complete retained directory of its own.
//   4. Trusted controller copy, bridge key, config (still disabled) and the
//      active-release pointer go under ~/.poise/self-update, outside any release.
//   5. The legacy plist is preserved byte-for-byte, the daemon service is
//      installed, the app is drained through the bridge key, and only then is
//      the production plist re-pointed at the trusted launcher.
//   6. Health must prove build.sha and build.releaseId are the baseline before
//      config gains `enabled: true`. Any failure after the switch puts the
//      preserved plist back, restarts, verifies, and returns ownership to the
//      legacy updater; nothing built is thrown away.
//
// Every phase is idempotent and recorded in installed.json and a durable
// bootstrap journal, so a crashed or interrupted run is resumed by running
// `enable` again. Every command, launchctl call, HTTP request, clock and sleep
// is injectable so the whole flow is testable without launchd, GitHub or a
// running server.
//
// Subprocesses run under scripts/self-update/safe-runner.mjs, never a bare
// spawn: a bootstrap that is killed or times out must not leave `npm ci` or
// the build still writing into a staging directory it will later reuse.
// Commands that write (clone, install, build) are registered in a private
// registry file — durably, before the gate lets them start — so a resumed run
// can reap the groups it can prove are settled and refuse to touch a staging
// path an unverifiable group may still be writing to. Read-only commands
// (git queries, `node --version`, launchctl) use the same gate for parent-death
// teardown but record nothing, which keeps preflight, dry-run and status free
// of writes.
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessHealth, RELEASE_KEY_HEADER } from './self-update/app-bridge.mjs'
import {
  acquireLock, appendLineDurable, assertPrivateFile, ensurePrivateDirectory, isDirectory, isFile, readJson,
  writeFileAtomic, writeJsonAtomic,
} from './self-update/atomic.mjs'
import { adoptInitialRelease, ensureBridgeKey, initializeRoot, installControllerCopy } from './self-update/bootstrap.mjs'
import { createControlClient } from './self-update/client.mjs'
import { PRODUCTION_SERVICE_LABEL, normalizeConfig, readConfig, writeConfig } from './self-update/config.mjs'
import { scrubEnvironment } from './self-update/environment.mjs'
import { BASE_BRANCH, DEFAULT_PRODUCTION_PORT, DEFAULT_RECOVERY_PORT, REPOSITORY, REPOSITORY_URL, isSha, layout, selfUpdateRoot } from './self-update/paths.mjs'
import { BUNDLE_PATH, MANIFEST_NAME, newReleaseId, readManifest, releaseIsComplete, toRelease } from './self-update/releases.mjs'
import { createRunner, reapWorkersDetailed } from './self-update/safe-runner.mjs'
import { ACTIVE_CHANGE_STATES, openStore, validPointer } from './self-update/store.mjs'

export const SERVICE_LABEL = PRODUCTION_SERVICE_LABEL
export const DAEMON_LABEL = 'com.vaquum.poise.self-update'
export const LEGACY_UPDATER_LABEL = 'com.vaquum.poise.caller-update'
export const INSTALLED_NAME = 'installed.json'
export const BOOTSTRAP_JOURNAL_NAME = 'bootstrap.ndjson'
export const BOOTSTRAP_WORKERS_NAME = 'bootstrap-workers.json'
export const MAINTENANCE_LOCK_NAME = 'maintenance.lock'
export const PRESERVED_DIRECTORY = 'preserved'
export const LEGACY_LAUNCHER = join('scripts', 'start-production.mjs')
export const TRUSTED_LAUNCHER = join('controller', 'launch.mjs')
export const TRUSTED_DAEMON = join('controller', 'daemon.mjs')
export const CONTROLLER_SOURCE = join('scripts', 'self-update')
export const GITHUB_API_URL = 'https://api.github.com'

/** Bootstrap phases in order; installed.json records the last one reached. */
export const PHASES = [
  'locked', 'staged', 'configured', 'adopted', 'preserved', 'daemon', 'drained', 'switched', 'verified', 'completed',
]

export const DEFAULT_TIMING = {
  pollMs: 1_000,
  updaterIdleMaxMs: 15 * 60_000,
  daemonStartMaxMs: 60_000,
  drainMaxMs: 30 * 60_000,
  healthGraceMs: 180_000,
  restoreGraceMs: 180_000,
  stageTimeoutMs: 30 * 60_000,
  commandTimeoutMs: 60_000,
}

const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/
const REMOTE_PATTERN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)mikkokotila\/Poise(?:\.git)?\/?$/
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\./

export class BootstrapError extends Error {
  constructor(message, { code = 'bootstrap', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BootstrapError'
    this.code = code
  }
}

// ── Property lists ─────────────────────────────────────────────────────────
//
// launchd plists as install-production.mjs writes them: a dict of strings,
// arrays, booleans and integers. The parser is deliberately small but real —
// it handles whitespace, comments and entities — so a hand-edited plist still
// round-trips. A plist is the only record of what production runs with, so
// nothing here guesses at values that are not in it.

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITY_MAP[entity] ?? whole
  })
}

function tokenizePlist(xml) {
  const tokens = []
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/)?([A-Za-z]+)([^>]*?)(\/)?>|([^<]+)/g
  for (const match of xml.matchAll(pattern)) {
    if (match[2]) tokens.push({ kind: match[1] ? 'close' : match[4] ? 'self' : 'open', name: match[2] })
    else if (match[5] !== undefined) tokens.push({ kind: 'text', text: match[5] })
  }
  return tokens
}

export function parsePlist(xml) {
  const tokens = tokenizePlist(String(xml))
  let index = 0
  const skipSpace = () => { while (tokens[index]?.kind === 'text' && !tokens[index].text.trim()) index += 1 }
  const expectClose = (name) => {
    skipSpace()
    const token = tokens[index]
    if (!token || token.kind !== 'close' || token.name !== name) throw new BootstrapError(`plist: expected </${name}>`, { code: 'plist' })
    index += 1
  }
  const readText = (name) => {
    let text = ''
    while (tokens[index] && tokens[index].kind === 'text') { text += tokens[index].text; index += 1 }
    expectClose(name)
    return unescapeXml(text)
  }
  function value() {
    skipSpace()
    const token = tokens[index]
    if (!token) throw new BootstrapError('plist: unexpected end of document', { code: 'plist' })
    index += 1
    if (token.kind === 'self') {
      if (token.name === 'true') return true
      if (token.name === 'false') return false
      if (token.name === 'dict') return {}
      if (token.name === 'array') return []
      if (['string', 'data', 'date'].includes(token.name)) return ''
      throw new BootstrapError(`plist: unsupported element <${token.name}/>`, { code: 'plist' })
    }
    if (token.kind !== 'open') throw new BootstrapError(`plist: unexpected ${token.kind} ${token.name || ''}`.trim(), { code: 'plist' })
    switch (token.name) {
      case 'plist': { const inner = value(); expectClose('plist'); return inner }
      case 'dict': {
        const dict = {}
        for (;;) {
          skipSpace()
          if (tokens[index]?.kind === 'close' && tokens[index].name === 'dict') { index += 1; return dict }
          const key = tokens[index]
          if (!key || key.kind !== 'open' || key.name !== 'key') throw new BootstrapError('plist: expected <key>', { code: 'plist' })
          index += 1
          const name = readText('key')
          dict[name] = value()
        }
      }
      case 'array': {
        const items = []
        for (;;) {
          skipSpace()
          if (tokens[index]?.kind === 'close' && tokens[index].name === 'array') { index += 1; return items }
          items.push(value())
        }
      }
      case 'string': case 'data': case 'date': return readText(token.name)
      case 'integer': case 'real': {
        const number = Number(readText(token.name).trim())
        if (!Number.isFinite(number)) throw new BootstrapError('plist: invalid number', { code: 'plist' })
        return number
      }
      case 'true': expectClose('true'); return true
      case 'false': expectClose('false'); return false
      default: throw new BootstrapError(`plist: unsupported element <${token.name}>`, { code: 'plist' })
    }
  }
  const document = value()
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new BootstrapError('plist: root must be a dict', { code: 'plist' })
  return document
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function plistValue(value) {
  if (value === true) return '<true/>'
  if (value === false) return '<false/>'
  if (typeof value === 'number') return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`
  if (typeof value === 'string') return `<string>${xml(value)}</string>`
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`
  if (value && typeof value === 'object') {
    return `<dict>${Object.entries(value).map(([key, entry]) => `<key>${xml(key)}</key>${plistValue(entry)}`).join('')}</dict>`
  }
  throw new BootstrapError(`plist: cannot serialise ${typeof value}`, { code: 'plist' })
}

/** Serialise in the same one-line-dict shape install-production.mjs writes. */
export function plistXml(document) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    Object.entries(document).map(([key, value]) => `<key>${xml(key)}</key>${plistValue(value)}`).join(''),
    '</dict></plist>',
    '',
  ].join('\n')
}

/** Which launcher a production service plist points at. */
export function classifyService(document) {
  const args = Array.isArray(document?.ProgramArguments) ? document.ProgramArguments : []
  const [node = null, script = null] = args
  const environment = document?.EnvironmentVariables && typeof document.EnvironmentVariables === 'object' ? document.EnvironmentVariables : {}
  if (typeof script === 'string' && script.endsWith(`/${LEGACY_LAUNCHER}`)) {
    return { mode: 'legacy', node, script, checkout: script.slice(0, -LEGACY_LAUNCHER.length - 1), environment }
  }
  if (typeof script === 'string' && script.endsWith(`/${TRUSTED_LAUNCHER}`)) {
    return { mode: 'managed', node, script, checkout: environment.POISE_ENV_ROOT || null, environment }
  }
  return { mode: 'unknown', node, script, checkout: null, environment }
}

// ── Environments ───────────────────────────────────────────────────────────

// Credential-shaped names that must never travel from the app's plist into a
// release or the daemon. Functional settings (NODE_OPTIONS, CLAUDE_CONFIG_DIR…)
// are preserved: this is the production environment, not a build sandbox —
// scrubEnvironment() applies the strict allowlist to every subprocess anyway.
const SECRET_PATTERNS = [/TOKEN/i, /SECRET/i, /PASSWORD/i, /PASSWD/i, /CREDENTIAL/i, /API_KEY/i, /PRIVATE_KEY/i, /^AWS_SESSION/, /^SSH_AUTH_SOCK$/]

export function isSecretName(name) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(name))
}

export function stripSecrets(environment) {
  const kept = {}
  const stripped = []
  for (const [name, value] of Object.entries(environment || {})) {
    if (isSecretName(name)) stripped.push(name)
    else if (typeof value === 'string') kept[name] = value
  }
  return { environment: kept, stripped: stripped.sort() }
}

/**
 * The environment the trusted launcher starts a release with: everything the
 * legacy service had, plus the three paths that keep a release running from
 * an immutable directory on the original installation's data — its .env, its
 * Chat workspace and the controller root the bridge talks to.
 */
export function managedServiceEnvironment({ legacyEnvironment, root, checkout }) {
  const { environment, stripped } = stripSecrets(legacyEnvironment)
  return {
    stripped,
    environment: {
      ...environment,
      POISE_ENV_ROOT: environment.POISE_ENV_ROOT || checkout,
      POISE_CHAT_ROOT: environment.POISE_CHAT_ROOT || join(checkout, '.poise-chat'),
      POISE_SELF_UPDATE_ROOT: root,
    },
  }
}

export function managedServicePlist({ legacy, node, root, checkout }) {
  const { environment, stripped } = managedServiceEnvironment({ legacyEnvironment: legacy.EnvironmentVariables, root, checkout })
  const document = {
    ...legacy,
    Label: SERVICE_LABEL,
    ProgramArguments: [node, join(root, TRUSTED_LAUNCHER)],
    // launch.mjs chdirs into the active release itself; the root always exists.
    WorkingDirectory: root,
    EnvironmentVariables: environment,
  }
  return { document, stripped }
}

export function daemonPlist({ legacy, node, root, checkout, tokenFile, logsDir }) {
  const { environment } = managedServiceEnvironment({ legacyEnvironment: legacy.EnvironmentVariables, root, checkout })
  return {
    Label: DAEMON_LABEL,
    ProgramArguments: [node, join(root, TRUSTED_DAEMON)],
    WorkingDirectory: root,
    EnvironmentVariables: {
      ...environment,
      PATH: [dirname(node), ...(environment.PATH ? environment.PATH.split(':') : [])].filter((entry, index, all) => all.indexOf(entry) === index).join(':'),
      POISE_RELEASE_TOKEN_FILE: tokenFile,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: 'Background',
    ThrottleInterval: 10,
    StandardOutPath: join(logsDir, 'self-update.out.log'),
    StandardErrorPath: join(logsDir, 'self-update.err.log'),
  }
}

// ── Bootstrap worker registry ──────────────────────────────────────────────
//
// A private file, separate from the controller's state.json (the daemon may be
// rewriting that concurrently once it is installed). Each record is the
// safe-runner record plus the staging path the group is allowed to write;
// `register` resolves only after the file is fsynced, which is what the
// runner waits for before sending GO.

export function createBootstrapRegistry(path) {
  const empty = () => ({ version: 1, workers: {} })
  let queue = Promise.resolve()
  const serialise = (work) => {
    const run = queue.then(work)
    queue = run.catch(() => {})
    return run
  }
  async function read() {
    const document = await readJson(path, null)
    return document && typeof document === 'object' && document.workers && typeof document.workers === 'object' ? document : empty()
  }
  return {
    path,
    read,
    register(record) {
      return serialise(async () => {
        const document = await read()
        document.workers[record.pid] = { ...record, registeredAt: new Date().toISOString() }
        await writeJsonAtomic(path, document)
      })
    },
    release(pid) {
      return serialise(async () => {
        const document = await read()
        delete document.workers[pid]
        await writeJsonAtomic(path, document)
      })
    },
    /** Drop the given pids; everything else stays. */
    forget(pids) {
      return serialise(async () => {
        const document = await read()
        for (const pid of pids) delete document.workers[pid]
        await writeJsonAtomic(path, document)
      })
    },
  }
}

// Environment names no git/npm/launchctl subprocess may ever see. The runner
// refuses rather than filters: every caller is expected to hand it an
// allowlisted environment from scrubEnvironment() already.
const FORBIDDEN_SUBPROCESS_ENV = [/^POISE_RELEASE_TOKEN/, /^GH_/, /^GITHUB_/, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i, /API_KEY/i]

export function assertSubprocessEnvironment(env) {
  if (!env || typeof env !== 'object') throw new BootstrapError('subprocess environment is required', { code: 'command' })
  const leaked = Object.keys(env).filter((name) => FORBIDDEN_SUBPROCESS_ENV.some((pattern) => pattern.test(name)))
  if (leaked.length) throw new BootstrapError(`refusing to start a subprocess with ${leaked.sort().join(', ')} in its environment`, { code: 'command' })
}

/**
 * The default command runner. `options.write: true` runs the command as a
 * registered worker (record durable before it starts; `options.staging` names
 * the path it may write); anything else is gated but unrecorded. The returned
 * `run` has the same shape as before, so tests keep injecting a fake.
 */
export function createBootstrapRunner({ registryPath, log = null, spawn = undefined } = {}) {
  const registry = registryPath ? createBootstrapRegistry(registryPath) : null
  let staging = null
  // Read-only queries are silent so `status --json` stays machine-readable;
  // registered writers announce themselves.
  const readOnly = createRunner({ ...(spawn ? { spawn } : {}) })
  const writers = registry ? createRunner({
    log,
    ...(spawn ? { spawn } : {}),
    workers: {
      register: (record) => registry.register({ ...record, staging }),
      release: (pid) => registry.release(pid),
    },
  }) : null
  async function run(command, args, options = {}) {
    const { cwd, env, timeoutMs = DEFAULT_TIMING.commandTimeoutMs, allowFailure = false, write = false, purpose, stdoutFile = null, stderrFile = null } = options
    assertSubprocessEnvironment(env)
    if (write && !writers) throw new BootstrapError('a write-bearing command needs the bootstrap worker registry', { code: 'command' })
    if (write) staging = options.staging || null
    const runner = write ? writers : readOnly
    try {
      return await runner.run(command, args, { cwd, env, timeoutMs, allowFailure, purpose: purpose || `${command} ${args[0] || ''}`.trim(), stdoutFile, stderrFile })
    } catch (error) {
      if (error?.result) {
        const result = error.result
        const how = result.timedOut ? `timed out after ${timeoutMs} ms` : result.settled === false ? 'left processes running that did not die' : result.signal ? `killed by ${result.signal}` : `exited ${result.code}`
        const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n')
        const wrapped = new BootstrapError(`${command} ${args.slice(0, 3).join(' ')} ${how}${tail ? `: ${tail}` : ''}`, { code: 'command', cause: error })
        wrapped.result = result
        throw wrapped
      }
      throw error
    }
  }
  return { run, registry }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function supportedNodeVersion(version) {
  const match = String(version).trim().match(NODE_VERSION_PATTERN)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major === 24
}

function requireSha(value, label) {
  const sha = String(value || '').trim().toLowerCase()
  if (!isSha(sha)) throw new BootstrapError(`${label} did not resolve to a commit SHA`, { code: 'source' })
  return sha
}

function parseLaunchctlPrint(output) {
  const state = output.match(/^\s*state = (\S+)/m)?.[1] || null
  const pid = output.match(/^\s*pid = (\d+)/m)?.[1]
  return { loaded: true, state, pid: pid ? Number(pid) : null, running: state === 'running' || Boolean(pid) }
}

// ── Installer ──────────────────────────────────────────────────────────────

export function createInstaller({
  home = homedir(),
  env = process.env,
  root = selfUpdateRoot(env, home),
  platform = process.platform,
  uid = process.getuid?.(),
  now = () => new Date(),
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  run = null,
  reap = reapWorkersDetailed,
  launchctl = null,
  fetch = globalThis.fetch,
  daemonStatus = null,
  log = (line) => console.log(line),
  timing = {},
  githubApiUrl = GITHUB_API_URL,
} = {}) {
  const clock = { ...DEFAULT_TIMING, ...timing }
  const paths = layout(root)
  const workersPath = join(root, BOOTSTRAP_WORKERS_NAME)
  const registry = createBootstrapRegistry(workersPath)
  const runCommand = run || createBootstrapRunner({ registryPath: workersPath, log }).run
  const launchAgents = join(home, 'Library', 'LaunchAgents')
  const servicePlistPath = join(launchAgents, `${SERVICE_LABEL}.plist`)
  const daemonPlistPath = join(launchAgents, `${DAEMON_LABEL}.plist`)
  const installedPath = join(root, INSTALLED_NAME)
  const journalPath = join(root, BOOTSTRAP_JOURNAL_NAME)
  const lockPath = join(root, MAINTENANCE_LOCK_NAME)
  const preservedDir = join(root, PRESERVED_DIRECTORY)
  const logsDir = join(home, '.poise', 'logs')
  const domain = `gui/${uid}`
  const iso = () => now().toISOString()
  const stamp = () => iso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

  const launchctlRun = launchctl || ((args, options = {}) => runCommand('/bin/launchctl', args, {
    env: scrubEnvironment({ base: env }), timeoutMs: 30_000, allowFailure: options.allowFailure === true, purpose: `launchctl ${args[0]}`,
  }))
  const probeDaemon = daemonStatus || (async () => {
    try {
      return await createControlClient({ socketPath: paths.socketPath, timeoutMs: 5_000 }).status()
    } catch {
      return null
    }
  })

  // ── Records ──────────────────────────────────────────────────────────────

  async function journal(event, details = {}) {
    await ensurePrivateDirectory(root)
    await appendLineDurable(journalPath, JSON.stringify({ at: iso(), event, ...details }))
  }

  const readInstalled = () => readJson(installedPath, null)

  async function writeInstalled(document) {
    await ensurePrivateDirectory(root)
    const next = { version: 1, ...document, updatedAt: iso() }
    await writeJsonAtomic(installedPath, next)
    return next
  }

  async function reachPhase(installed, phase, extra = {}) {
    const next = await writeInstalled({ ...installed, ...extra, phase })
    await journal(`bootstrap.${phase}`, { ...extra })
    log(`[self-update] ${phase}`)
    return next
  }

  async function withMaintenanceLock(work) {
    await ensurePrivateDirectory(root)
    let lock
    try {
      lock = await acquireLock(lockPath)
    } catch (error) {
      if (error?.code === 'LOCKED') throw new BootstrapError(`another install-self-update run is active: ${error.message}`, { code: 'locked' })
      throw error
    }
    try {
      return await work()
    } finally {
      await lock.release()
    }
  }

  // ── launchd ──────────────────────────────────────────────────────────────

  async function servicePrint(label) {
    const result = await launchctlRun(['print', `${domain}/${label}`], { allowFailure: true })
    if (result.code !== 0) return { loaded: false, state: null, pid: null, running: false }
    return parseLaunchctlPrint(result.stdout || '')
  }

  async function bootout(label) {
    await launchctlRun(['bootout', `${domain}/${label}`], { allowFailure: true })
  }

  async function bootstrapService(plistPath) {
    let lastError
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        await launchctlRun(['bootstrap', domain, plistPath])
        return
      } catch (error) {
        // bootout returns before launchd has finished tearing the old job down.
        lastError = error
        if (attempt < 15) await sleep(Math.min(250 * (2 ** attempt), 2_000))
      }
    }
    throw new BootstrapError(`launchctl bootstrap ${basename(plistPath)} failed: ${lastError?.message || lastError}`, { code: 'launchd', cause: lastError })
  }

  /** Replace a service definition: write, bootout, enable, bootstrap. Only this label is touched. */
  async function installService(label, plistPath, document) {
    await mkdir(launchAgents, { recursive: true, mode: 0o700 })
    await writeFileAtomic(plistPath, plistXml(document), { mode: 0o600 })
    await bootout(label)
    await launchctlRun(['enable', `${domain}/${label}`])
    await bootstrapService(plistPath)
  }

  async function waitForLegacyUpdaterIdle() {
    const deadline = now().getTime() + clock.updaterIdleMaxMs
    for (;;) {
      const status = await servicePrint(LEGACY_UPDATER_LABEL)
      if (!status.running) return status
      if (now().getTime() >= deadline) throw new BootstrapError(`the legacy updater (${LEGACY_UPDATER_LABEL}) is still running after ${clock.updaterIdleMaxMs} ms`, { code: 'updater' })
      log(`[self-update] waiting for ${LEGACY_UPDATER_LABEL} to finish its current run`)
      await sleep(clock.pollMs)
    }
  }

  // ── The app over HTTP ────────────────────────────────────────────────────

  function appBase(port) {
    return `http://127.0.0.1:${port}`
  }

  async function http(method, url, { headers = {}, body } = {}) {
    let response
    try {
      response = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
    } catch (error) {
      return { ok: false, status: 0, body: null, error: error?.message || String(error) }
    }
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { ok: response.ok, status: response.status, body: parsed, error: null }
  }

  async function observeApp(port) {
    const [health, chat] = await Promise.all([
      http('GET', `${appBase(port)}/api/health`),
      http('GET', `${appBase(port)}/api/chat/sessions`),
    ])
    return { health, chat }
  }

  async function waitForApp(port, judge, graceMs, label) {
    const deadline = now().getTime() + graceMs
    let last = { healthy: false, reason: 'not observed' }
    for (;;) {
      const observed = await observeApp(port)
      last = judge(observed)
      if (last.healthy) return { ...last, observed }
      if (now().getTime() >= deadline) return { ...last, observed }
      log(`[self-update] waiting for ${label}: ${last.reason}`)
      await sleep(clock.pollMs)
    }
  }

  const judgeManaged = ({ sha, releaseId }) => ({ health, chat }) => assessHealth({ health: health.body ? health : null, chat }, { sha, releaseId })

  /** The legacy launcher is healthy when it answers JSON with status ok or degraded (external sign-in etc.). */
  const judgeLegacy = ({ health }) => {
    if (!health.body || typeof health.body !== 'object') return { healthy: false, reason: health.error || `health returned HTTP ${health.status}` }
    if (health.body.status === 'ok' || health.body.status === 'degraded') return { healthy: true, reason: `health ${health.body.status}` }
    return { healthy: false, reason: `health status is ${health.body.status}` }
  }

  async function bridgeKey() {
    await assertPrivateFile(paths.bridgeKeyPath, 'bridge key file', { uid })
    return (await readFile(paths.bridgeKeyPath, 'utf8')).trim()
  }

  /** Ask the running app to stop taking work, and wait until it is idle. Resumes it on timeout. */
  async function drainApp(port, releaseId) {
    const headers = { [RELEASE_KEY_HEADER]: await bridgeKey() }
    const base = appBase(port)
    const started = await http('POST', `${base}/api/self-update/drain`, { headers, body: { releaseId } })
    if (!started.ok) throw new BootstrapError(`drain request failed: ${started.error || `HTTP ${started.status} ${started.body?.error || ''}`.trim()}`, { code: 'drain' })
    const deadline = now().getTime() + clock.drainMaxMs
    for (;;) {
      const readiness = await http('GET', `${base}/api/self-update/readiness`, { headers })
      if (readiness.ok && readiness.body?.ready === true) return readiness.body
      if (now().getTime() >= deadline) {
        await http('POST', `${base}/api/self-update/resume`, { headers, body: {} })
        throw new BootstrapError(`the app did not become idle within ${clock.drainMaxMs} ms (busy: ${readiness.body?.busy ?? 'unknown'}); drain released`, { code: 'drain' })
      }
      log(`[self-update] draining: ${readiness.body?.busy ?? '?'} operation(s) still running`)
      await sleep(clock.pollMs)
    }
  }

  async function resumeApp(port) {
    try {
      await http('POST', `${appBase(port)}/api/self-update/resume`, { headers: { [RELEASE_KEY_HEADER]: await bridgeKey() }, body: {} })
    } catch {
      // The key or the app may already be gone; a restarted server is never drained.
    }
  }

  // ── Source, runtime and token checks ─────────────────────────────────────

  const gitEnv = () => scrubEnvironment({ base: env })

  /** Read-only git query: gated for parent-death teardown, never registered. */
  async function git(cwd, args, options = {}) {
    return (await runCommand('git', args, { cwd, env: gitEnv(), timeoutMs: clock.commandTimeoutMs, purpose: `git ${args[0]}`, ...options })).stdout.trim()
  }

  async function verifySource(checkout) {
    if (!await isDirectory(join(checkout, '.git'))) throw new BootstrapError(`${checkout} is not a git checkout`, { code: 'source' })
    if (!await isFile(join(checkout, LEGACY_LAUNCHER))) throw new BootstrapError(`${checkout} has no ${LEGACY_LAUNCHER}`, { code: 'source' })
    if (!await isFile(join(checkout, CONTROLLER_SOURCE, 'daemon.mjs')) || !await isFile(join(checkout, CONTROLLER_SOURCE, 'launch.mjs'))) {
      throw new BootstrapError(`${checkout} does not contain the self-update controller (${CONTROLLER_SOURCE}); merge and fast-forward the bootstrap change first`, { code: 'source' })
    }
    const remote = await git(checkout, ['remote', 'get-url', 'origin'])
    if (!REMOTE_PATTERN.test(remote)) throw new BootstrapError(`${checkout} origin is ${remote || 'unset'}, not ${REPOSITORY}`, { code: 'source' })
    const branch = await git(checkout, ['branch', '--show-current'])
    if (branch !== BASE_BRANCH) throw new BootstrapError(`${checkout} is on ${branch || 'a detached HEAD'}, not ${BASE_BRANCH}`, { code: 'source' })
    const dirty = await git(checkout, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty) throw new BootstrapError(`${checkout} has local modifications:\n${dirty}`, { code: 'source' })
    const sha = requireSha(await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']), 'HEAD')
    const remoteMain = requireSha((await git(checkout, ['ls-remote', '--exit-code', REPOSITORY_URL, `refs/heads/${BASE_BRANCH}`])).split(/\s+/)[0], `${REPOSITORY} ${BASE_BRANCH}`)
    if (sha !== remoteMain) throw new BootstrapError(`${checkout} is at ${sha.slice(0, 12)} but ${REPOSITORY} ${BASE_BRANCH} is at ${remoteMain.slice(0, 12)}; let the updater fast-forward first`, { code: 'source' })
    return { checkout, sha }
  }

  async function verifyNode(node) {
    if (typeof node !== 'string' || !node.startsWith('/')) throw new BootstrapError('the production plist has no absolute Node runtime', { code: 'runtime' })
    if (!await executable(node)) throw new BootstrapError(`Node runtime ${node} is not executable`, { code: 'runtime' })
    const version = (await runCommand(node, ['--version'], { env: gitEnv(), timeoutMs: 15_000, purpose: 'node --version' })).stdout.trim()
    if (!supportedNodeVersion(version)) throw new BootstrapError(`Node runtime ${node} is ${version}; 20.19+, 22.13+ or 24.x is required`, { code: 'runtime' })
    return { node, nodeBin: dirname(node), version }
  }

  /** Reads the token once to prove it is usable; the value never leaves this function. */
  async function verifyToken(tokenFile) {
    if (typeof tokenFile !== 'string' || !tokenFile.startsWith('/')) throw new BootstrapError('a release token file is required: --token-file <absolute path> (or POISE_RELEASE_TOKEN_FILE)', { code: 'token' })
    if (tokenFile.startsWith(`${root}/`)) throw new BootstrapError('the release token file must live outside the controller root', { code: 'token' })
    await assertPrivateFile(tokenFile, 'release token file', { uid })
    const token = (await readFile(tokenFile, 'utf8')).trim()
    if (!TOKEN_PATTERN.test(token)) throw new BootstrapError('release token file does not contain a GitHub token', { code: 'token' })
    const response = await http('GET', `${githubApiUrl}/repos/${REPOSITORY}`, {
      headers: { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'poise-self-update-bootstrap' },
    })
    if (!response.ok) throw new BootstrapError(`the release token cannot read ${REPOSITORY} (${response.error || `HTTP ${response.status}`})`, { code: 'token' })
    const repo = response.body || {}
    if (repo.full_name !== REPOSITORY) throw new BootstrapError(`the release token resolved ${JSON.stringify(repo.full_name)} instead of ${REPOSITORY}`, { code: 'token' })
    if (repo.permissions?.push !== true) throw new BootstrapError(`the release token cannot push to ${REPOSITORY}; it needs Contents and Pull requests write access to this one repository`, { code: 'token' })
    if (repo.default_branch !== BASE_BRANCH) throw new BootstrapError(`${REPOSITORY} default branch is ${repo.default_branch}, expected ${BASE_BRANCH}`, { code: 'token' })
    return { tokenFile }
  }

  async function readServicePlist() {
    let text
    try {
      text = await readFile(servicePlistPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') throw new BootstrapError(`${servicePlistPath} does not exist; install production first (npm run install:production)`, { code: 'plist' })
      throw error
    }
    const document = parsePlist(text)
    return { text, document, service: classifyService(document) }
  }

  // ── Preflight ────────────────────────────────────────────────────────────

  async function preflight({ tokenFile = null } = {}) {
    if (platform !== 'darwin') throw new BootstrapError('the self-update bootstrap supports macOS launchd only', { code: 'platform' })
    const installed = await readInstalled()
    const plist = await readServicePlist()
    const { service } = plist
    if (service.mode === 'unknown') throw new BootstrapError(`${servicePlistPath} runs ${service.script || 'nothing recognisable'}; expected ${LEGACY_LAUNCHER} or ${TRUSTED_LAUNCHER}`, { code: 'plist' })
    const checkout = service.mode === 'legacy' ? service.checkout : installed?.checkout || service.checkout
    if (!checkout) throw new BootstrapError('cannot determine the production checkout the managed service was bootstrapped from', { code: 'plist' })
    const legacyEnvironment = service.mode === 'legacy' ? service.environment : installed?.legacyEnvironment || service.environment
    const callerSha = legacyEnvironment.CALLER_RELEASE_SHA
    if (!isSha(callerSha)) throw new BootstrapError('the production plist pins no CALLER_RELEASE_SHA; refusing to guess the Caller release', { code: 'plist' })
    if (!legacyEnvironment.CALLER_RELEASE_ROOT || !await isDirectory(legacyEnvironment.CALLER_RELEASE_ROOT)) {
      throw new BootstrapError(`pinned Caller release root ${legacyEnvironment.CALLER_RELEASE_ROOT || '(unset)'} is missing`, { code: 'plist' })
    }
    const runtime = await verifyNode(service.node)
    const source = await verifySource(checkout)
    const { config, present: configPresent } = await readConfig(root, {})
    const resolvedTokenFile = tokenFile || env.POISE_RELEASE_TOKEN_FILE || (configPresent ? config.tokenFile : null)
    await verifyToken(resolvedTokenFile)
    const port = Number(legacyEnvironment.POISE_PORT) || DEFAULT_PRODUCTION_PORT
    const observed = await observeApp(port)
    const running = observed.health.body
    if (!running || typeof running !== 'object') throw new BootstrapError(`production does not answer on port ${port} (${observed.health.error || `HTTP ${observed.health.status}`}); bootstrap only from a healthy service`, { code: 'health' })
    if (running.build?.sha !== source.sha) {
      throw new BootstrapError(`the running server serves build ${running.build?.sha ? String(running.build.sha).slice(0, 12) : 'unknown'} but the checkout is at ${source.sha.slice(0, 12)}; restart or repair production first`, { code: 'health' })
    }
    if (running.status !== 'ok' && running.status !== 'degraded') throw new BootstrapError(`production health is ${running.status}`, { code: 'health' })
    const { stripped } = stripSecrets(legacyEnvironment)
    return {
      root, installed, plist, service, checkout, sha: source.sha, callerSha, legacyEnvironment, runtime, port, stripped,
      tokenFile: resolvedTokenFile, configPresent, config,
      runningBuild: running.build, healthStatus: running.status,
      recoveryPort: configPresent ? config.recoveryPort : DEFAULT_RECOVERY_PORT,
    }
  }

  // ── Baseline release ─────────────────────────────────────────────────────

  /**
   * Bootstrap worker groups left by an earlier run. Groups the process table
   * proves dead (or reused pids) are forgotten; groups that are still alive
   * under our exact gate identity are killed and, once dead, forgotten. A
   * group that cannot be verified or will not die is retained, and any staging
   * path it was allowed to write is off limits for this run.
   */
  async function reconcileBootstrapWorkers() {
    const document = await registry.read()
    const records = Object.values(document.workers)
    if (!records.length) return { retained: [], blockedPaths: new Set() }
    const outcome = await reap(document.workers)
    const gone = [...outcome.killed, ...outcome.cleared].map((entry) => entry.pid)
    if (gone.length) await registry.forget(gone)
    for (const entry of outcome.killed) log(`[self-update] killed bootstrap worker group ${entry.pid} left by an earlier run`)
    for (const entry of outcome.retained) log(`[self-update] retaining unverified bootstrap worker group ${entry.pid} (${entry.reason})`)
    await journal('bootstrap.workers-reconciled', { killed: outcome.killed, cleared: outcome.cleared, retained: outcome.retained })
    const blockedPaths = new Set(outcome.retained.map((entry) => document.workers[entry.pid]?.staging).filter(Boolean))
    return { retained: outcome.retained, blockedPaths }
  }

  /** True while the registry still holds a group allowed to write `staging`. */
  async function registryMayWrite(staging) {
    const document = await registry.read()
    return Object.values(document.workers).some((record) => record.staging === staging)
  }

  async function stageBaseline({ id, sha, checkout, runtime, callerSha, blockedPaths = new Set() }) {
    await ensurePrivateDirectory(paths.releasesDir)
    const releaseRoot = join(paths.releasesDir, id)
    const existing = await readManifest(releaseRoot)
    if (existing) {
      if (existing.sha !== sha) throw new BootstrapError(`release ${id} already holds ${existing.sha}, not ${sha}`, { code: 'release' })
      if (await isFile(join(releaseRoot, BUNDLE_PATH))) { log(`[self-update] baseline release ${id} already staged`); return existing }
      throw new BootstrapError(`release ${id} exists without a bundle; remove ${releaseRoot} and rerun`, { code: 'release' })
    }
    const staging = join(paths.releasesDir, `.${id}.staging`)
    if (blockedPaths.has(staging) || await registryMayWrite(staging)) {
      throw new BootstrapError(`refusing to reuse ${staging}: a bootstrap worker group from an earlier run may still be writing there (see ${workersPath}); make sure it is dead, remove its record, then rerun`, { code: 'workers' })
    }
    await rm(staging, { recursive: true, force: true })
    const buildEnv = (extra = {}) => scrubEnvironment({ base: env, nodeBin: runtime.nodeBin, extra })
    const logsFor = (step) => ({ stdoutFile: join(paths.logsDir, 'bootstrap', id, `${step}.stdout.log`), stderrFile: join(paths.logsDir, 'bootstrap', id, `${step}.stderr.log`) })
    // Every command that writes into the staging directory is a registered
    // worker; its record names `staging` and is durable before it starts.
    const write = (command, args, { step, env: commandEnv, timeoutMs }) => runCommand(command, args, {
      cwd: command === 'git' && args[0] === 'clone' ? undefined : staging, env: commandEnv, timeoutMs, write: true, staging, purpose: `stage ${id} ${step}`, ...logsFor(step),
    })
    log(`[self-update] staging baseline release ${id} from ${sha.slice(0, 12)}`)
    try {
      // A local clone keeps the bootstrap off the network; the remote is then
      // set to the canonical repository so the release carries no local path.
      await write('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', checkout, staging], { step: 'clone', env: gitEnv(), timeoutMs: clock.stageTimeoutMs })
      await write('git', ['remote', 'set-url', 'origin', REPOSITORY_URL], { step: 'remote', env: gitEnv(), timeoutMs: clock.commandTimeoutMs })
      await write('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], { step: 'checkout', env: gitEnv(), timeoutMs: clock.commandTimeoutMs })
      const head = requireSha(await git(staging, ['rev-parse', '--verify', 'HEAD^{commit}']), 'staged HEAD')
      if (head !== sha) throw new BootstrapError(`staged checkout resolved to ${head}, expected ${sha}`, { code: 'release' })
      // NODE_ENV is production in the scrubbed environment; the build itself
      // needs the dev toolchain, so ask for it explicitly.
      await write('npm', ['ci', '--include=dev'], { step: 'npm-ci', env: buildEnv(), timeoutMs: clock.stageTimeoutMs })
      await write('npm', ['run', 'build'], { step: 'build', env: buildEnv({ POISE_RELEASE_SHA: sha }), timeoutMs: clock.stageTimeoutMs })
      const after = requireSha(await git(staging, ['rev-parse', '--verify', 'HEAD^{commit}']), 'built HEAD')
      if (after !== sha) throw new BootstrapError(`staged checkout moved to ${after} during the build`, { code: 'release' })
      const dirty = await git(staging, ['status', '--porcelain', '--untracked-files=normal'])
      if (dirty) throw new BootstrapError(`the build modified the staged checkout:\n${dirty}`, { code: 'release' })
      if (!await isFile(join(staging, BUNDLE_PATH))) throw new BootstrapError(`the build produced no ${BUNDLE_PATH}`, { code: 'release' })
      const manifest = {
        id, sha, root: releaseRoot, callerSha, createdAt: iso(), node: runtime.version, builder: 'poise-self-update-bootstrap',
      }
      await writeJsonAtomic(join(staging, MANIFEST_NAME), manifest)
      await rename(staging, releaseRoot)
      log(`[self-update] baseline release ${id} staged at ${releaseRoot}`)
      return manifest
    } catch (error) {
      // A group that survived SIGKILL, or a record the registry still holds,
      // may still be writing: the directory stays, quarantined by its record,
      // and the next run refuses it until the record is gone.
      if (error?.result?.settled === false || await registryMayWrite(staging)) {
        await journal('bootstrap.staging-quarantined', { staging, error: error?.message || String(error) })
        log(`[self-update] ${staging} kept: a worker group may still be writing there`)
        throw error
      }
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async function adoptBaseline(manifest, { rebaseline = false } = {}) {
    const store = await openStore(root, { now: iso })
    const pointer = await store.readActivePointer()
    if (pointer && pointer.id === manifest.id && pointer.sha === manifest.sha) {
      if (!store.state.releases[manifest.id]) {
        await store.commit('release.adopted', (draft) => { draft.releases[manifest.id] = { ...toRelease(manifest), rejected: false } }, { releaseId: manifest.id, sha: manifest.sha })
      }
      return pointer
    }
    if (!pointer) {
      await adoptInitialRelease(root, { sha: manifest.sha, id: manifest.id, stage: async () => manifest, now: iso })
      return store.readActivePointer()
    }
    if (!rebaseline) {
      throw new BootstrapError(`the controller already records active release ${pointer.id} (${pointer.sha.slice(0, 12)}); the checkout is at ${manifest.sha.slice(0, 12)}. Pass --rebaseline to adopt the checkout as the new baseline`, { code: 'baseline' })
    }
    assertNoPendingWork(store.state)
    await store.commit('release.rebaselined', (draft) => {
      draft.releases[manifest.id] = { ...toRelease(manifest), rejected: false }
      draft.hold = null
    }, { releaseId: manifest.id, sha: manifest.sha, previousId: pointer.id })
    await store.writeActivePointer({ id: manifest.id, sha: manifest.sha, root: manifest.root, previousId: pointer.id })
    return store.readActivePointer()
  }

  function assertNoPendingWork(state) {
    const active = Object.values(state.changes || {}).find((change) => ACTIVE_CHANGE_STATES.has(change.state))
    const rollback = Object.values(state.rollbacks || {}).find((op) => op.phase !== 'done' && op.phase !== 'failed')
    const busy = state.switching ? 'a release switch is in progress'
      : state.update?.current ? 'a main update is being deployed'
        : active ? `change ${active.id} is ${active.state}`
          : rollback ? 'a rollback is in progress' : null
    if (busy) throw new BootstrapError(`refusing while the controller has unrelated work: ${busy}`, { code: 'busy' })
  }

  async function preservePlist(text, kind) {
    await ensurePrivateDirectory(preservedDir)
    const path = join(preservedDir, `${SERVICE_LABEL}.${kind}.${stamp()}.plist`)
    await writeFileAtomic(path, text, { mode: 0o600 })
    return path
  }

  async function writeControllerConfig(plan, { enabled }) {
    await initializeRoot(root)
    const { config: existing } = await readConfig(root, {})
    return writeConfig(root, normalizeConfig({
      ...existing,
      enabled,
      tokenFile: plan.tokenFile,
      bridgeKeyFile: paths.bridgeKeyPath,
      productionPort: plan.port,
      recoveryPort: plan.recoveryPort,
      productionServiceLabel: SERVICE_LABEL,
      callerSha: plan.callerSha,
      nodeBin: plan.runtime.nodeBin,
    }, root))
  }

  async function waitForDaemon() {
    const deadline = now().getTime() + clock.daemonStartMaxMs
    for (;;) {
      const status = await probeDaemon()
      if (status && typeof status === 'object' && 'enabled' in status) return status
      if (now().getTime() >= deadline) throw new BootstrapError(`the controller daemon did not answer on ${paths.socketPath} within ${clock.daemonStartMaxMs} ms; see ${join(logsDir, 'self-update.err.log')}`, { code: 'daemon' })
      await sleep(clock.pollMs)
    }
  }

  // ── enable ───────────────────────────────────────────────────────────────

  function describePlan(plan, { dryRun }) {
    // On a resumed run the plist on disk is already managed; the legacy
    // environment it was built from is what installed.json recorded.
    const legacy = { ...plan.plist.document, EnvironmentVariables: plan.legacyEnvironment }
    const managed = managedServicePlist({ legacy, node: plan.runtime.node, root, checkout: plan.checkout })
    const daemon = daemonPlist({ legacy, node: plan.runtime.node, root, checkout: plan.checkout, tokenFile: plan.tokenFile, logsDir })
    return {
      dryRun,
      root,
      checkout: plan.checkout,
      sha: plan.sha,
      callerSha: plan.callerSha,
      node: plan.runtime.node,
      nodeVersion: plan.runtime.version,
      tokenFile: plan.tokenFile,
      port: plan.port,
      recoveryPort: plan.recoveryPort,
      serviceMode: plan.service.mode,
      resumingPhase: plan.installed?.phase || null,
      strippedEnvironment: managed.stripped,
      servicePlist: managed.document,
      daemonPlist: daemon,
      preservedPlist: plan.installed?.preservedPlist || null,
    }
  }

  async function enable({ tokenFile = null, dryRun = false, rebaseline = false } = {}) {
    const plan = await preflight({ tokenFile })
    const summary = describePlan(plan, { dryRun })
    if (dryRun) {
      log(`[self-update] dry run: would bootstrap ${REPOSITORY} ${plan.sha.slice(0, 12)} from ${plan.checkout} into ${root}`)
      return { ...summary, changed: false }
    }
    return withMaintenanceLock(async () => {
      let installed = await readInstalled()
      const { config } = await readConfig(root, {})
      if (installed?.phase === 'completed' && config.enabled && plan.service.mode === 'managed') {
        log('[self-update] already enabled; nothing to do')
        return { ...summary, changed: false, alreadyEnabled: true }
      }
      // Re-enabling after maintenance: the checkout may have stayed where the
      // controller left off (reuse that release) or not (explicit --rebaseline).
      const previousPointer = await (await openStore(root, { now: iso })).readActivePointer()
      if (previousPointer && previousPointer.sha !== plan.sha && !rebaseline) {
        throw new BootstrapError(`the controller's active release is ${previousPointer.id} (${previousPointer.sha.slice(0, 12)}) but the checkout is at ${plan.sha.slice(0, 12)}; pass --rebaseline to adopt the checkout as the new baseline`, { code: 'baseline' })
      }

      // Phase 1: the maintenance lock the legacy updater honours.
      const reuseId = previousPointer && previousPointer.sha === plan.sha ? previousPointer.id : null
      const releaseId = installed?.baseline?.sha === plan.sha ? installed.baseline.id : reuseId || newReleaseId(plan.sha, now())
      installed = await reachPhase({
        ...(installed || {}),
        startedAt: installed?.startedAt || iso(),
        completedAt: null,
        checkout: plan.checkout,
        serviceLabel: SERVICE_LABEL,
        daemonLabel: DAEMON_LABEL,
        node: plan.runtime.node,
        legacyEnvironment: plan.legacyEnvironment,
        baseline: { id: releaseId, sha: plan.sha, root: join(paths.releasesDir, releaseId) },
      }, 'locked', { sha: plan.sha, releaseId })

      let drained = false
      let daemonInstalled = false
      let switched = false
      try {
        await waitForLegacyUpdaterIdle()
        // The updater may have moved the checkout while we waited; the baseline
        // must be what is on disk and what GitHub's main says, not a memory.
        if (plan.service.mode === 'legacy') {
          const recheck = await verifySource(plan.checkout)
          if (recheck.sha !== plan.sha) throw new BootstrapError(`the checkout moved from ${plan.sha.slice(0, 12)} to ${recheck.sha.slice(0, 12)} during bootstrap; rerun`, { code: 'source' })
          const current = await readServicePlist()
          if (current.text !== plan.plist.text) throw new BootstrapError(`${servicePlistPath} changed during bootstrap; rerun`, { code: 'plist' })
        }

        // Phase 2: the immutable baseline, built beside production, never in it.
        // First settle whatever an earlier, interrupted run may have left running.
        const { blockedPaths } = await reconcileBootstrapWorkers()
        const manifest = await stageBaseline({ id: releaseId, sha: plan.sha, checkout: plan.checkout, runtime: plan.runtime, callerSha: plan.callerSha, blockedPaths })
        installed = await reachPhase(installed, 'staged', { releaseRoot: manifest.root })

        // Phase 3: trusted controller copy, bridge key, disabled config.
        const copied = await installControllerCopy(root, { source: join(plan.checkout, CONTROLLER_SOURCE) })
        for (const required of ['daemon.mjs', 'launch.mjs']) {
          if (!copied.files.includes(join(paths.controllerDir, required))) throw new BootstrapError(`controller copy is missing ${required}`, { code: 'controller' })
        }
        await ensureBridgeKey(root)
        await writeControllerConfig(plan, { enabled: false })
        installed = await reachPhase(installed, 'configured', { controllerSha: plan.sha, controllerFiles: copied.files.length })

        // Phase 4: the pointer the trusted launcher will follow.
        const pointer = await adoptBaseline(manifest, { rebaseline })
        installed = await reachPhase(installed, 'adopted', { pointer: { id: pointer.id, sha: pointer.sha } })

        // Phase 5: keep the legacy definition byte-for-byte before touching it.
        if (plan.service.mode === 'legacy') {
          const preservedPlist = await preservePlist(plan.plist.text, 'legacy')
          installed = await reachPhase(installed, 'preserved', { preservedPlist })
        } else if (!installed.preservedPlist || !await isFile(installed.preservedPlist)) {
          throw new BootstrapError('the service is already managed but no preserved legacy plist is recorded; cannot resume safely', { code: 'plist' })
        } else {
          installed = await reachPhase(installed, 'preserved', { preservedPlist: installed.preservedPlist })
        }

        // Phase 6: the controller daemon, restarted fresh if a copy was loaded.
        await mkdir(logsDir, { recursive: true, mode: 0o700 })
        await installService(DAEMON_LABEL, daemonPlistPath, summary.daemonPlist)
        daemonInstalled = true
        await waitForDaemon()
        installed = await reachPhase(installed, 'daemon')

        // Phases 7–8: drain, then switch the launcher. If the managed launcher
        // is already live on the right release (resumed run), leave it be.
        const already = plan.service.mode === 'managed'
          ? judgeManaged({ sha: plan.sha, releaseId })(await observeApp(plan.port))
          : { healthy: false }
        if (!already.healthy) {
          const store = await openStore(root, { now: iso })
          assertNoPendingWork(store.state)
          await drainApp(plan.port, releaseId)
          drained = true
          installed = await reachPhase(installed, 'drained')
          await installService(SERVICE_LABEL, servicePlistPath, summary.servicePlist)
          switched = true
          drained = false
          installed = await reachPhase(installed, 'switched')
        } else {
          installed = await reachPhase(installed, 'switched', { alreadyLive: true })
        }

        // Phase 9: the proof. build.sha and build.releaseId, not a checkout report.
        const verdict = await waitForApp(plan.port, judgeManaged({ sha: plan.sha, releaseId }), clock.healthGraceMs, `release ${releaseId}`)
        if (!verdict.healthy) throw new BootstrapError(`release ${releaseId} did not become healthy: ${verdict.reason}`, { code: 'health' })
        installed = await reachPhase(installed, 'verified', { reason: verdict.reason })

        // Phase 10: enabled last. From here the legacy updater defers to the controller.
        await writeControllerConfig(plan, { enabled: true })
        installed = await reachPhase(installed, 'completed', { completedAt: iso() })
        log(`[self-update] enabled: ${SERVICE_LABEL} serves release ${releaseId} (${plan.sha.slice(0, 12)}) through ${join(root, TRUSTED_LAUNCHER)}; ${DAEMON_LABEL} is running`)
        return { ...summary, changed: true, releaseId, pointer, verified: verdict.reason }
      } catch (error) {
        log(`[self-update] bootstrap failed at ${installed?.phase || 'start'}: ${error?.message || error}`)
        await journal('bootstrap.failed', { phase: installed?.phase || null, error: error?.message || String(error) })
        const restored = await restoreAfterFailure({ plan, installed, drained, daemonInstalled, switched })
        if (restored.ok) {
          throw new BootstrapError(`${error.message}\nProduction was restored to the legacy launcher and the legacy updater owns it again. Built artefacts under ${paths.releasesDir} were kept for a retry.`, { code: error.code || 'bootstrap', cause: error })
        }
        throw new BootstrapError(`${error.message}\nRESTORE FAILED: ${restored.reason}. Production may be down. ${installedPath} is left in place so the legacy updater stays out; inspect ${journalPath} and rerun 'enable' or restore ${installed?.preservedPlist || servicePlistPath} by hand.`, { code: 'restore', cause: error })
      }
    })
  }

  /** Put the legacy service back and return ownership to the legacy updater. */
  async function restoreAfterFailure({ plan, installed, drained, daemonInstalled, switched }) {
    try {
      if (drained) await resumeApp(plan.port)
      // Decide from the plist on disk, not from this run's memory: a resumed
      // run that failed after an earlier run's switch must restore too.
      const onDisk = classifyService(parsePlist(await readFile(servicePlistPath, 'utf8')))
      if (switched || onDisk.mode === 'managed') {
        const preserved = installed?.preservedPlist
        if (!preserved || !await isFile(preserved)) return { ok: false, reason: 'no preserved legacy plist to restore' }
        const document = parsePlist(await readFile(preserved, 'utf8'))
        await installService(SERVICE_LABEL, servicePlistPath, document)
        await journal('bootstrap.restored-service', { from: preserved })
        const verdict = await waitForApp(plan.port, judgeLegacy, clock.restoreGraceMs, 'restored legacy service')
        if (!verdict.healthy) return { ok: false, reason: `restored legacy service is not healthy: ${verdict.reason}` }
      }
      if (daemonInstalled) {
        await bootout(DAEMON_LABEL)
        await rm(daemonPlistPath, { force: true })
      }
      const { present } = await readConfig(root, {})
      if (present) await writeControllerConfig(plan, { enabled: false })
      await rm(installedPath, { force: true })
      await journal('bootstrap.restored', { switched, daemonInstalled })
      log('[self-update] restored the legacy launcher; the legacy updater owns production again')
      return { ok: true }
    } catch (error) {
      await journal('bootstrap.restore-failed', { error: error?.message || String(error) }).catch(() => {})
      return { ok: false, reason: error?.message || String(error) }
    }
  }

  // ── disable (maintenance) ────────────────────────────────────────────────

  async function disable({ force = false } = {}) {
    if (platform !== 'darwin') throw new BootstrapError('the self-update bootstrap supports macOS launchd only', { code: 'platform' })
    return withMaintenanceLock(async () => {
      const installed = await readInstalled()
      if (!installed) throw new BootstrapError(`nothing to disable: ${installedPath} does not exist`, { code: 'state' })
      const plist = await readServicePlist()
      const { config, present } = await readConfig(root, {})
      if (plist.service.mode !== 'managed') {
        if (present && config.enabled) {
          await writeConfig(root, { ...config, enabled: false })
          await journal('maintenance.disabled', { serviceMode: plist.service.mode })
        }
        await writeInstalled({ ...installed, phase: 'disabled', disabledAt: iso() })
        log(`[self-update] ${SERVICE_LABEL} already runs the legacy launcher; controller marked disabled`)
        return { changed: present && config.enabled, serviceMode: plist.service.mode }
      }
      const preserved = installed.preservedPlist
      if (!preserved || !await isFile(preserved)) throw new BootstrapError('no preserved legacy plist is recorded; restore by hand', { code: 'plist' })
      const legacyDocument = parsePlist(await readFile(preserved, 'utf8'))
      const legacy = classifyService(legacyDocument)
      if (legacy.mode !== 'legacy') throw new BootstrapError(`${preserved} is not a legacy service definition`, { code: 'plist' })
      if (!await isFile(join(legacy.checkout, LEGACY_LAUNCHER))) throw new BootstrapError(`${legacy.checkout} no longer has ${LEGACY_LAUNCHER}; cannot hand production back to it`, { code: 'plist' })
      if (!isSha(legacy.environment.CALLER_RELEASE_SHA) || !await isDirectory(legacy.environment.CALLER_RELEASE_ROOT || '')) {
        throw new BootstrapError('the preserved plist no longer points at an installed Caller release', { code: 'plist' })
      }
      const store = await openStore(root, { now: iso })
      if (!force) assertNoPendingWork(store.state)
      const pointer = await store.readActivePointer()
      const port = Number(plist.service.environment.POISE_PORT) || config.productionPort || DEFAULT_PRODUCTION_PORT

      // Disabled first: the daemon stops taking work and the legacy updater is
      // held in maintenance either way.
      const wasEnabled = present && config.enabled
      if (present) await writeConfig(root, { ...config, enabled: false })
      await journal('maintenance.begin', { activeRelease: pointer?.id || null, force })
      const daemonWasLoaded = (await servicePrint(DAEMON_LABEL)).loaded
      await bootout(DAEMON_LABEL)
      let drained = false
      let switched = false
      const managedText = plist.text
      try {
        await drainApp(port, 'maintenance')
        drained = true
        const managedCopy = await preservePlist(managedText, 'managed')
        await installService(SERVICE_LABEL, servicePlistPath, legacyDocument)
        switched = true
        const verdict = await waitForApp(port, judgeLegacy, clock.restoreGraceMs, 'legacy service')
        if (!verdict.healthy) throw new BootstrapError(`the legacy launcher did not become healthy: ${verdict.reason}`, { code: 'health' })
        await writeInstalled({ ...installed, phase: 'disabled', disabledAt: iso(), managedPlist: managedCopy })
        await journal('maintenance.disabled', { activeRelease: pointer?.id || null, managedPlist: managedCopy })
        const legacySha = (await observeApp(port)).health.body?.build?.sha || null
        log(`[self-update] maintenance: ${SERVICE_LABEL} runs the legacy launcher from ${legacy.checkout}${legacySha ? ` (build ${String(legacySha).slice(0, 12)})` : ''}; the controller is stopped and the legacy updater stays blocked until 'enable' or 'uninstall'`)
        if (pointer && legacySha && pointer.sha !== legacySha) {
          log(`[self-update] note: the controller's last active release was ${pointer.id} (${pointer.sha.slice(0, 12)}); the legacy checkout serves ${String(legacySha).slice(0, 12)}`)
        }
        return { changed: true, serviceMode: 'legacy', checkout: legacy.checkout, activeRelease: pointer ? { id: pointer.id, sha: pointer.sha } : null, legacySha }
      } catch (error) {
        await journal('maintenance.failed', { error: error?.message || String(error), switched })
        const reverted = await revertMaintenance({ port, switched, drained, managedText, daemonWasLoaded, reEnable: present && wasEnabled, config })
        if (reverted.ok) {
          throw new BootstrapError(`${error.message}\nThe managed service was left in place${present && wasEnabled ? ' and re-enabled' : ''}.`, { code: error.code || 'maintenance', cause: error })
        }
        throw new BootstrapError(`${error.message}\nREVERT FAILED: ${reverted.reason}. Production may be down; the managed definition is preserved under ${preservedDir}.`, { code: 'restore', cause: error })
      }
    })
  }

  /** Undo a failed maintenance switch: managed launcher back, daemon back, config back. */
  async function revertMaintenance({ port, switched, drained, managedText, daemonWasLoaded, reEnable, config }) {
    try {
      if (switched) {
        await installService(SERVICE_LABEL, servicePlistPath, parsePlist(managedText))
        const answering = ({ health }) => (health.body ? { healthy: true, reason: 'answering' } : { healthy: false, reason: health.error || `HTTP ${health.status}` })
        const verdict = await waitForApp(port, answering, clock.restoreGraceMs, 'managed service')
        if (!verdict.healthy) return { ok: false, reason: `the managed service did not come back: ${verdict.reason}` }
      } else if (drained) {
        await resumeApp(port)
      }
      if (daemonWasLoaded) await bootstrapService(daemonPlistPath)
      if (reEnable) await writeConfig(root, { ...config, enabled: true })
      await journal('maintenance.reverted', { switched, daemonWasLoaded, reEnable })
      return { ok: true }
    } catch (inner) {
      await journal('maintenance.revert-failed', { error: inner?.message || String(inner) }).catch(() => {})
      return { ok: false, reason: inner?.message || String(inner) }
    }
  }

  // ── uninstall ────────────────────────────────────────────────────────────

  async function uninstall() {
    if (platform !== 'darwin') throw new BootstrapError('the self-update bootstrap supports macOS launchd only', { code: 'platform' })
    return withMaintenanceLock(async () => {
      const installed = await readInstalled()
      if (!installed) { log('[self-update] not installed; nothing to remove'); return { changed: false } }
      const plist = await readServicePlist()
      if (plist.service.mode === 'managed') throw new BootstrapError(`${SERVICE_LABEL} still runs the trusted launcher; run 'disable' first`, { code: 'state' })
      const { config, present } = await readConfig(root, {})
      if (present && config.enabled) throw new BootstrapError("config is still enabled; run 'disable' first", { code: 'state' })
      await bootout(DAEMON_LABEL)
      await rm(daemonPlistPath, { force: true })
      await rm(installedPath, { force: true })
      await journal('maintenance.uninstalled', { keptRoot: root })
      log(`[self-update] uninstalled: the legacy updater owns production again; ${root} (releases, journal, preserved plists) was kept`)
      return { changed: true }
    })
  }

  // ── status / doctor ──────────────────────────────────────────────────────

  async function status() {
    const problems = []
    const report = { root, platform, installed: await readInstalled(), config: null, service: null, daemon: null, release: null, app: null }
    try {
      const { config, present } = await readConfig(root, {})
      report.config = {
        present, enabled: config.enabled, tokenFile: config.tokenFile, tokenFilePresent: await isFile(config.tokenFile),
        bridgeKeyPresent: await isFile(paths.bridgeKeyPath), callerSha: config.callerSha, nodeBin: config.nodeBin,
        productionPort: config.productionPort, recoveryPort: config.recoveryPort,
      }
      if (present && !report.config.tokenFilePresent) problems.push(`release token file ${config.tokenFile} is missing`)
    } catch (error) {
      report.config = { error: error.message }
      problems.push(`config unreadable: ${error.message}`)
    }
    report.controller = {
      daemon: await isFile(join(root, TRUSTED_DAEMON)),
      launcher: await isFile(join(root, TRUSTED_LAUNCHER)),
    }
    try {
      const plist = await readServicePlist()
      report.service = { path: servicePlistPath, mode: plist.service.mode, node: plist.service.node, script: plist.service.script, checkout: plist.service.checkout }
      if (platform === 'darwin') report.service.launchd = await servicePrint(SERVICE_LABEL)
    } catch (error) {
      report.service = { path: servicePlistPath, error: error.message }
      problems.push(error.message)
    }
    report.daemon = { path: daemonPlistPath, plistPresent: await isFile(daemonPlistPath), heartbeat: await readJson(paths.heartbeatPath, null), status: await probeDaemon() }
    if (platform === 'darwin' && report.daemon.plistPresent) report.daemon.launchd = await servicePrint(DAEMON_LABEL)
    try {
      // Read the pointer directly: status must not create the root as a side effect.
      const raw = await readJson(paths.activePointerPath, null)
      const pointer = validPointer(raw) ? raw : null
      const manifest = pointer ? await readManifest(pointer.root) : null
      report.release = pointer ? { pointer, manifest, complete: manifest ? await releaseIsComplete(pointer.root, pointer) : false } : null
      if (pointer && !report.release.complete) problems.push(`active release ${pointer.id} at ${pointer.root} is incomplete`)
    } catch (error) {
      report.release = { error: error.message }
      problems.push(`release state unreadable: ${error.message}`)
    }
    const port = report.config?.productionPort || DEFAULT_PRODUCTION_PORT
    const observed = await observeApp(port)
    report.app = { port, status: observed.health.body?.status ?? null, build: observed.health.body?.build ?? null, error: observed.health.error }
    if (!observed.health.body) problems.push(`production does not answer on ${port}: ${observed.health.error || `HTTP ${observed.health.status}`}`)

    const phase = report.installed?.phase || null
    if (report.installed && phase !== 'completed' && phase !== 'disabled') problems.push(`bootstrap is incomplete (phase ${phase}); rerun 'enable' or run 'disable'`)
    if (report.config?.enabled && report.service?.mode !== 'managed') problems.push('config is enabled but the service does not run the trusted launcher')
    if (report.service?.mode === 'managed' && !report.config?.enabled) problems.push('the service runs the trusted launcher but config is not enabled (maintenance or interrupted bootstrap)')
    if (report.service?.mode === 'managed' && report.release?.pointer && report.app?.build) {
      if (report.app.build.sha !== report.release.pointer.sha || report.app.build.releaseId !== report.release.pointer.id) {
        problems.push(`the app serves ${report.app.build.releaseId || 'no release'} (${String(report.app.build.sha || '').slice(0, 12)}) but the pointer names ${report.release.pointer.id}`)
      }
    }
    if (report.config?.enabled && !report.daemon.status) problems.push('config is enabled but the controller daemon is not answering on its socket')
    return { ...report, problems, ok: problems.length === 0 }
  }

  async function doctor() {
    const report = await status()
    for (const problem of report.problems) log(`[self-update] problem: ${problem}`)
    if (report.ok) log('[self-update] no problems found')
    return report
  }

  return { root, paths, servicePlistPath, daemonPlistPath, installedPath, journalPath, preflight, enable, disable, uninstall, status, doctor, describePlan }
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { command: null, tokenFile: null, dryRun: false, rebaseline: false, force: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--rebaseline') options.rebaseline = true
    else if (arg === '--force') options.force = true
    else if (arg === '--json') options.json = true
    else if (arg === '--token-file') { options.tokenFile = argv[index + 1] ? resolve(argv[index + 1]) : null; index += 1 }
    else if (arg.startsWith('--token-file=')) options.tokenFile = resolve(arg.slice('--token-file='.length))
    else if (arg.startsWith('-')) throw new BootstrapError(`unknown option ${arg}`, { code: 'usage' })
    else if (!options.command) options.command = arg
    else throw new BootstrapError(`unexpected argument ${arg}`, { code: 'usage' })
  }
  if (!['enable', 'disable', 'uninstall', 'status', 'doctor'].includes(options.command || '')) {
    throw new BootstrapError('usage: install-self-update.mjs <enable|disable|uninstall|status|doctor> [--token-file <path>] [--dry-run] [--rebaseline] [--force] [--json]', { code: 'usage' })
  }
  return options
}

export async function main(argv = process.argv.slice(2), installer = createInstaller()) {
  const options = parseArgs(argv)
  let result
  if (options.command === 'enable') result = await installer.enable({ tokenFile: options.tokenFile, dryRun: options.dryRun, rebaseline: options.rebaseline })
  else if (options.command === 'disable') result = await installer.disable({ force: options.force })
  else if (options.command === 'uninstall') result = await installer.uninstall()
  else if (options.command === 'status') result = await installer.status()
  else result = await installer.doctor()
  if (options.json || options.command === 'status' || options.dryRun) console.log(JSON.stringify(result, null, 2))
  return result
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (isEntrypoint) {
  try {
    const result = await main()
    process.exit(result && result.ok === false ? 1 : 0)
  } catch (error) {
    console.error(`[self-update] ${error?.message || error}`)
    process.exit(error?.code === 'usage' ? 64 : 1)
  }
}
