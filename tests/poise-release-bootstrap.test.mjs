import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOTSTRAP_WORKERS_NAME, DAEMON_LABEL, LEGACY_UPDATER_LABEL, SERVICE_LABEL, TRUSTED_LAUNCHER, assertSubprocessEnvironment,
  classifyService, createBootstrapRegistry, createBootstrapRunner, createInstaller, daemonPlist, isSecretName,
  managedServicePlist, parseArgs, parsePlist, plistXml, stripSecrets,
} from '../scripts/install-self-update.mjs'
import { selfUpdateEnabled } from '../scripts/self-update-bridge.mjs'
import { readConfig } from '../scripts/self-update/config.mjs'
import { layout } from '../scripts/self-update/paths.mjs'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const NEXT_SHA = 'b'.repeat(40)
const CALLER_SHA = 'cddc30284e6057c1f835fcc8ffa6924d07a2537d'
const TOKEN = `github_pat_${'x'.repeat(60)}`
// File ownership is real even though launchd is simulated.
const UID = process.getuid?.() ?? 501

let home
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'poise-bootstrap-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

// The production plist install-production.mjs writes today, including one
// credential-shaped variable that must not travel and one functional one that must.
function legacyDocument({ checkout, callerRoot, node, extraEnvironment = {} }) {
  return {
    Label: SERVICE_LABEL,
    ProgramArguments: [node, join(checkout, 'scripts', 'start-production.mjs')],
    WorkingDirectory: checkout,
    EnvironmentVariables: {
      AGENT_INTERFACE_DATA_DIR: join(home, 'dev', 'caller', 'agent_interface', 'data'),
      AGENT_INTERFACE_ROOT: join(callerRoot, 'source', 'agent_interface'),
      CALLER_BIN_ROOT: join(callerRoot, 'venv', 'bin'),
      CALLER_RELEASE_ROOT: callerRoot,
      CALLER_RELEASE_SHA: CALLER_SHA,
      HOME: home,
      LANG: 'en_US.UTF-8',
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=4096',
      PATH: `${join(callerRoot, 'venv', 'bin')}:${join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/bin:/bin`,
      POISE_DB: join(home, '.poise', 'cache.db'),
      POISE_ENFORCE_CALLER_RELEASE: '1',
      TMPDIR: '/tmp',
      ...extraEnvironment,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: 'Interactive',
    ThrottleInterval: 10,
    StandardOutPath: join(home, '.poise', 'logs', 'production.out.log'),
    StandardErrorPath: join(home, '.poise', 'logs', 'production.err.log'),
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

/**
 * A fake macOS: launchd, git, npm, the GitHub API and the running app are all
 * simulated from one state object. The app "serves" whatever the production
 * plist on disk points at once launchd has bootstrapped it.
 */
async function world(overrides = {}) {
  const root = join(home, '.poise', 'self-update')
  const checkout = join(home, '.poise', 'production')
  const callerRoot = join(home, '.poise', 'releases', 'caller', CALLER_SHA)
  const node = join(home, 'node22', 'bin', 'node')
  const launchAgents = join(home, 'Library', 'LaunchAgents')
  const tokenFile = join(home, '.poise', 'release-token')
  await mkdir(join(checkout, '.git'), { recursive: true })
  await mkdir(join(checkout, 'scripts', 'self-update'), { recursive: true })
  for (const name of ['daemon.mjs', 'launch.mjs', 'atomic.mjs', 'paths.mjs', 'worker-gate.mjs']) {
    await writeFile(join(checkout, 'scripts', 'self-update', name), `// trusted ${name}\nexport {}\n`)
  }
  await writeFile(join(checkout, 'scripts', 'self-update', 'README.md'), 'not copied\n')
  await writeFile(join(checkout, 'scripts', 'start-production.mjs'), 'export {}\n')
  await mkdir(join(callerRoot, 'venv', 'bin'), { recursive: true })
  await mkdir(join(home, 'node22', 'bin'), { recursive: true })
  await writeFile(node, '#!/bin/sh\necho v22.13.1\n', { mode: 0o755 })
  await mkdir(launchAgents, { recursive: true })
  await mkdir(join(home, '.poise'), { recursive: true })
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const legacy = legacyDocument({ checkout, callerRoot, node, extraEnvironment: overrides.extraEnvironment || { GH_TOKEN: 'ghp_legacy_secret_value' } })
  const servicePlistPath = join(launchAgents, `${SERVICE_LABEL}.plist`)
  await writeFile(servicePlistPath, plistXml(legacy))
  const legacyText = await readFile(servicePlistPath, 'utf8')

  const state = {
    sha: SHA, remoteMain: SHA, branch: 'main', dirty: '', remote: 'https://github.com/mikkokotila/Poise.git',
    runningSha: SHA, served: 'legacy', updaterBusyPolls: 0, readyAfter: 2, readinessPolls: 0, drains: [], resumes: 0,
    loaded: {}, launchctl: [], commands: [], buildFails: false, managedNeverHealthy: false, legacyNeverHealthy: false,
    tokenSeen: [], bootstrapFails: {}, clockMs: 0, sleeps: [], logs: [], stagedSha: {}, githubRepo: null,
    nodeVersion: 'v22.13.1', onManagedHealth: null, serviceRestarts: 0,
    ...overrides.state,
  }
  const label = (target) => target.split('/').pop()

  const isWrite = (command, args) => (command === 'git' && (args[0] === 'clone' || args[0] === '-c' || (args[0] === 'remote' && args[1] === 'set-url')))
    || (command === 'npm' && (args[0] === 'ci' || args[0] === 'run'))
  async function run(command, args, options = {}) {
    state.commands.push({ command, args, cwd: options.cwd, env: options.env, write: options.write === true, staging: options.staging || null })
    if (options.env) {
      for (const [name, value] of Object.entries(options.env)) {
        if (typeof value === 'string' && value.includes(TOKEN)) state.tokenSeen.push(`env:${name}`)
        if (/TOKEN|SECRET|PASSWORD|^GH_|^GITHUB_/i.test(name)) state.tokenSeen.push(`envname:${name}`)
      }
    }
    // Everything that writes into staging must come as a registered worker naming its path.
    const writes = isWrite(command, args)
    if (writes !== (options.write === true)) throw new Error(`${command} ${args[0]} write flag mismatch (${options.write})`)
    if (writes && (!options.staging || !options.staging.includes('.staging'))) throw new Error(`${command} ${args[0]} without staging path`)
    if (state.failUnsettled && command === 'npm' && args[1] === 'build') {
      const error = new Error('npm run build left processes running that did not die')
      error.result = { settled: false, timedOut: false, code: null }
      throw error
    }
    const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
    if (command === node) return ok(`${state.nodeVersion}\n`)
    if (command === 'git') {
      const [first] = args
      if (first === 'remote' && args[1] === 'get-url') return ok(`${state.remote}\n`)
      if (first === 'remote' && args[1] === 'set-url') return ok()
      if (first === 'branch') return ok(`${state.branch}\n`)
      if (first === 'status') return ok(options.cwd === checkout ? state.dirty : '')
      if (first === 'rev-parse') return ok(`${options.cwd === checkout ? state.sha : state.stagedSha[options.cwd] || 'unknown'}\n`)
      if (first === 'ls-remote') return ok(`${state.remoteMain}\trefs/heads/main\n`)
      if (first === 'clone') {
        const dest = args[args.length - 1]
        await mkdir(join(dest, '.git'), { recursive: true })
        state.stagedSha[dest] = state.sha
        return ok()
      }
      if (args.includes('checkout')) return ok()
    }
    if (command === 'npm') {
      if (args[0] === 'ci') { await mkdir(join(options.cwd, 'node_modules'), { recursive: true }); return ok() }
      if (args[0] === 'run' && args[1] === 'build') {
        if (state.buildFails) throw new Error('npm run build exited 1: tsc failed')
        await mkdir(join(options.cwd, 'dist'), { recursive: true })
        await writeFile(join(options.cwd, 'dist', 'server.js'), `// build ${options.env?.POISE_RELEASE_SHA}\n`)
        return ok()
      }
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`)
  }

  async function launchctl(args, { allowFailure = false } = {}) {
    state.launchctl.push(args)
    const [verb] = args
    if (verb === 'print') {
      const name = label(args[1])
      if (name === LEGACY_UPDATER_LABEL) {
        if (state.updaterBusyPolls > 0) { state.updaterBusyPolls -= 1; return { code: 0, stdout: 'state = running\n\tpid = 4242\n', stderr: '' } }
        return { code: 0, stdout: 'state = waiting\n', stderr: '' }
      }
      if (state.loaded[name]) return { code: 0, stdout: 'state = running\n\tpid = 77\n', stderr: '' }
      if (allowFailure) return { code: 113, stdout: '', stderr: 'Could not find service' }
      throw new Error('Could not find service')
    }
    if (verb === 'bootout') {
      const name = label(args[1])
      if (!state.loaded[name] && !allowFailure) throw new Error('not loaded')
      delete state.loaded[name]
      if (name === SERVICE_LABEL) state.served = null
      return { code: state.loaded[name] ? 0 : 3, stdout: '', stderr: '' }
    }
    if (verb === 'enable') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'bootstrap') {
      const plistPath = args[2]
      const document = parsePlist(await readFile(plistPath, 'utf8'))
      const name = document.Label
      if (state.bootstrapFails[name]) throw new Error(`Bootstrap failed: 5: Input/output error (${name})`)
      state.loaded[name] = plistPath
      if (name === SERVICE_LABEL) { state.served = classifyService(document).mode; state.serviceRestarts += 1 }
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`)
  }

  async function currentBuild() {
    // `legacyNeverHealthy` models a legacy launcher that was fine when bootstrap
    // began but cannot come back after a restart.
    if (state.served === 'legacy') return state.legacyNeverHealthy && state.serviceRestarts > 0 ? null : { sha: state.runningSha, releaseId: null }
    if (state.served === 'managed') {
      if (state.managedNeverHealthy) return null
      const pointer = JSON.parse(await readFile(join(root, 'active-release.json'), 'utf8'))
      return { sha: pointer.sha, releaseId: pointer.id }
    }
    return null
  }

  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    const target = new URL(url)
    if (target.hostname === 'api.github.com') {
      const auth = headers.authorization || ''
      if (auth.includes(TOKEN)) state.tokenSeen.push('github')
      return response(200, state.githubRepo || { full_name: 'mikkokotila/Poise', default_branch: 'main', permissions: { push: true, pull: true } })
    }
    if (target.pathname === '/api/health') {
      const build = await currentBuild()
      if (!build) throw new Error('fetch failed: ECONNREFUSED')
      if (state.served === 'managed' && state.onManagedHealth) await state.onManagedHealth()
      return response(200, { status: state.served === 'managed' ? 'degraded' : 'ok', build, scheduler: { status: 'ok' }, claudeAuth: { status: 'authenticated' } })
    }
    if (target.pathname === '/api/chat/sessions') return response(200, { sessions: [] })
    if (target.pathname.startsWith('/api/self-update/')) {
      const key = (await readFile(join(root, 'bridge.key'), 'utf8')).trim()
      if (headers['x-poise-release-key'] !== key) return response(401, { error: 'invalid release key' })
      if (target.pathname.endsWith('/drain')) { state.drains.push(JSON.parse(init.body).releaseId); state.readinessPolls = 0; return response(200, { ready: false, busy: 1 }) }
      if (target.pathname.endsWith('/readiness')) { state.readinessPolls += 1; const ready = state.readinessPolls >= state.readyAfter; return response(200, { ready, busy: ready ? 0 : 1 }) }
      if (target.pathname.endsWith('/resume')) { state.resumes += 1; return response(200, { ready: false, busy: 0 }) }
    }
    return response(404, { error: 'not found' })
  }

  const installer = createInstaller({
    // The installer's own environment carries the token path and a gh token;
    // neither may reach any subprocess.
    home, env: overrides.env || { HOME: home, PATH: '/usr/bin:/bin', POISE_RELEASE_TOKEN_FILE: tokenFile, GH_TOKEN: 'ghp_operator_secret' }, platform: overrides.platform || 'darwin', uid,
    reap: overrides.reap,
    now: () => new Date(1_800_000_000_000 + state.clockMs),
    sleep: async (ms) => { state.sleeps.push(ms); state.clockMs += ms },
    run, launchctl, fetch,
    daemonStatus: async () => (state.loaded[DAEMON_LABEL] ? { enabled: false, available: false, changes: [] } : null),
    log: (line) => { if (line.includes(TOKEN)) state.tokenSeen.push('log'); state.logs.push(line) },
    timing: { pollMs: 1_000, drainMaxMs: 5_000, healthGraceMs: 5_000, restoreGraceMs: 5_000, updaterIdleMaxMs: 5_000, daemonStartMaxMs: 3_000 },
  })
  return { root, checkout, callerRoot, node, tokenFile, servicePlistPath, launchAgents, legacy, legacyText, state, installer, paths: layout(root) }
}

const uid = UID

async function filesUnder(directory) {
  const out = []
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

async function noFileContains(directory, needle) {
  for (const path of await filesUnder(directory)) {
    if ((await readFile(path, 'utf8').catch(() => '')).includes(needle)) return path
  }
  return null
}

const labelsTouched = (calls, verb) => calls.filter((call) => call[0] === verb).map((call) => (verb === 'bootstrap' ? call[2].split('/').pop().replace(/\.plist$/, '') : call[1].split('/').pop()))

describe('property lists', () => {
  it('parses the one-line plist install-production.mjs writes, entities included', () => {
    const document = parsePlist([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.vaquum.poise</string><key>ProgramArguments</key><array><string>/opt/node</string><string>/x/scripts/start-production.mjs</string></array>',
      '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/a &amp; b:/c</string><key>Q</key><string>&quot;x&quot;&#39;y&#x27;</string></dict>',
      '<key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ThrottleInterval</key><integer>10</integer><key>Empty</key><dict/>',
      '</dict></plist>', '',
    ].join('\n'))
    expect(document).toEqual({
      Label: 'com.vaquum.poise',
      ProgramArguments: ['/opt/node', '/x/scripts/start-production.mjs'],
      EnvironmentVariables: { PATH: '/a & b:/c', Q: '"x"\'y\'' },
      RunAtLoad: true, KeepAlive: false, ThrottleInterval: 10, Empty: {},
    })
    expect(parsePlist(plistXml(document))).toEqual(document)
    expect(classifyService(document)).toMatchObject({ mode: 'legacy', node: '/opt/node', checkout: '/x' })
  })

  it('tolerates pretty-printed plists and rejects malformed ones', () => {
    const pretty = '<?xml version="1.0"?>\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>x</string>\n    <key>A</key>\n    <array>\n      <string>1</string>\n    </array>\n  </dict>\n</plist>\n'
    expect(parsePlist(pretty)).toEqual({ Label: 'x', A: ['1'] })
    expect(() => parsePlist('<plist><dict><key>a</key></dict></plist>')).toThrow(/plist/)
    expect(() => parsePlist('<plist><array/></plist>')).toThrow(/root must be a dict/)
  })

  it('classifies the trusted launcher and unknown programs', () => {
    expect(classifyService({ ProgramArguments: ['/n', '/r/controller/launch.mjs'], EnvironmentVariables: { POISE_ENV_ROOT: '/co' } })).toMatchObject({ mode: 'managed', checkout: '/co' })
    expect(classifyService({ ProgramArguments: ['/n', '/somewhere/else.js'] })).toMatchObject({ mode: 'unknown' })
    expect(classifyService({})).toMatchObject({ mode: 'unknown', node: null })
  })
})

describe('service environments', () => {
  it('strips credential-shaped names and keeps functional ones', () => {
    expect(isSecretName('GH_TOKEN')).toBe(true)
    expect(isSecretName('OPENAI_API_KEY')).toBe(true)
    expect(isSecretName('POISE_RELEASE_TOKEN_FILE')).toBe(true)
    expect(isSecretName('NODE_OPTIONS')).toBe(false)
    expect(isSecretName('CLAUDE_CONFIG_DIR')).toBe(false)
    expect(stripSecrets({ A: '1', DB_PASSWORD: 'x', NODE_OPTIONS: '--x' })).toEqual({ environment: { A: '1', NODE_OPTIONS: '--x' }, stripped: ['DB_PASSWORD'] })
  })

  it('builds the managed service on the legacy definition plus the data-root paths', () => {
    const legacy = { Label: 'com.vaquum.poise', ProgramArguments: ['/n', '/co/scripts/start-production.mjs'], WorkingDirectory: '/co', EnvironmentVariables: { POISE_DB: '/db', SECRET_X: 's', PATH: '/p' }, KeepAlive: true, StandardOutPath: '/log' }
    const { document, stripped } = managedServicePlist({ legacy, node: '/n', root: '/r', checkout: '/co' })
    expect(stripped).toEqual(['SECRET_X'])
    expect(document).toEqual({
      Label: 'com.vaquum.poise', ProgramArguments: ['/n', '/r/controller/launch.mjs'], WorkingDirectory: '/r',
      EnvironmentVariables: { POISE_DB: '/db', PATH: '/p', POISE_ENV_ROOT: '/co', POISE_CHAT_ROOT: '/co/.poise-chat', POISE_SELF_UPDATE_ROOT: '/r' },
      KeepAlive: true, StandardOutPath: '/log',
    })
    const daemon = daemonPlist({ legacy, node: '/n/bin/node', root: '/r', checkout: '/co', tokenFile: '/t', logsDir: '/logs' })
    expect(daemon.Label).toBe(DAEMON_LABEL)
    expect(daemon.ProgramArguments).toEqual(['/n/bin/node', '/r/controller/daemon.mjs'])
    expect(daemon.EnvironmentVariables).toMatchObject({ PATH: '/n/bin:/p', POISE_RELEASE_TOKEN_FILE: '/t', POISE_SELF_UPDATE_ROOT: '/r' })
    expect(daemon.EnvironmentVariables.SECRET_X).toBeUndefined()
  })

  it('respects an explicit chat or env root already present in the legacy plist', () => {
    const legacy = { ProgramArguments: [], EnvironmentVariables: { POISE_CHAT_ROOT: '/custom', POISE_ENV_ROOT: '/envroot' } }
    expect(managedServicePlist({ legacy, node: '/n', root: '/r', checkout: '/co' }).document.EnvironmentVariables).toMatchObject({ POISE_CHAT_ROOT: '/custom', POISE_ENV_ROOT: '/envroot' })
  })
})

describe('enable', () => {
  it('dry run plans everything and writes nothing', async () => {
    const w = await world()
    const plan = await w.installer.enable({ tokenFile: w.tokenFile, dryRun: true })
    expect(plan).toMatchObject({ dryRun: true, changed: false, sha: SHA, callerSha: CALLER_SHA, checkout: w.checkout, node: w.node, serviceMode: 'legacy', strippedEnvironment: ['GH_TOKEN'] })
    expect(plan.servicePlist.ProgramArguments).toEqual([w.node, join(w.root, TRUSTED_LAUNCHER)])
    expect(plan.daemonPlist.EnvironmentVariables.POISE_RELEASE_TOKEN_FILE).toBe(w.tokenFile)
    await expect(stat(w.root)).rejects.toThrow()
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    expect(w.state.launchctl).toEqual([])
    expect(w.state.commands.filter((c) => c.command === 'npm')).toEqual([])
    expect(w.state.tokenSeen).toEqual(['github'])
  })

  it('bootstraps end to end: lock, stage, configure, adopt, preserve, daemon, drain, switch, verify, enable', async () => {
    const w = await world()
    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    expect(result.changed).toBe(true)
    const { paths, root, state } = w

    // Ownership records.
    const installed = JSON.parse(await readFile(w.installer.installedPath, 'utf8'))
    expect(installed).toMatchObject({ phase: 'completed', checkout: w.checkout, baseline: { sha: SHA, id: result.releaseId } })
    expect(installed.legacyEnvironment).toEqual(w.legacy.EnvironmentVariables)
    const { config } = await readConfig(root, {})
    expect(config).toMatchObject({ enabled: true, tokenFile: w.tokenFile, callerSha: CALLER_SHA, nodeBin: join(home, 'node22', 'bin'), productionPort: 5555, productionServiceLabel: SERVICE_LABEL })
    expect(await selfUpdateEnabled(root)).toBe(true)
    expect((await stat(paths.bridgeKeyPath)).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)

    // Trusted copy comes from the verified checkout, .mjs only.
    expect((await readdir(paths.controllerDir)).sort()).toEqual(['atomic.mjs', 'daemon.mjs', 'launch.mjs', 'paths.mjs', 'worker-gate.mjs'])

    // Baseline release is complete, exact, retained beside (not in) production.
    const manifest = JSON.parse(await readFile(join(paths.releasesDir, result.releaseId, 'release.json'), 'utf8'))
    expect(manifest).toMatchObject({ id: result.releaseId, sha: SHA, callerSha: CALLER_SHA, builder: 'poise-self-update-bootstrap', node: 'v22.13.1' })
    await expect(stat(join(paths.releasesDir, result.releaseId, 'dist', 'server.js'))).resolves.toBeTruthy()
    await expect(stat(join(w.checkout, 'dist'))).rejects.toThrow()
    await expect(stat(join(w.checkout, 'node_modules'))).rejects.toThrow()
    const npmCi = state.commands.find((c) => c.command === 'npm' && c.args[0] === 'ci')
    expect(npmCi.args).toEqual(['ci', '--include=dev'])
    expect(npmCi.env.NODE_ENV).toBeUndefined()
    expect(npmCi.env.PATH.startsWith(join(home, 'node22', 'bin'))).toBe(true)
    const build = state.commands.find((c) => c.command === 'npm' && c.args[1] === 'build')
    expect(build.env.POISE_RELEASE_SHA).toBe(SHA)
    expect(Object.keys(build.env).some((k) => /TOKEN|GH_/.test(k))).toBe(false)
    const clone = state.commands.find((c) => c.command === 'git' && c.args[0] === 'clone')
    expect(clone.args).toContain(w.checkout)
    const pointer = JSON.parse(await readFile(paths.activePointerPath, 'utf8'))
    expect(pointer).toMatchObject({ id: result.releaseId, sha: SHA, root: join(paths.releasesDir, result.releaseId), previousId: null })
    const stateDocument = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(stateDocument.releases[result.releaseId]).toMatchObject({ sha: SHA, callerSha: CALLER_SHA })

    // Legacy plist preserved byte-for-byte; new plist points at the trusted launcher with the same environment.
    expect(await readFile(installed.preservedPlist, 'utf8')).toBe(w.legacyText)
    const service = parsePlist(await readFile(w.servicePlistPath, 'utf8'))
    expect(service.ProgramArguments).toEqual([w.node, join(root, TRUSTED_LAUNCHER)])
    expect(service.EnvironmentVariables).toEqual({
      ...w.legacy.EnvironmentVariables, GH_TOKEN: undefined,
      POISE_ENV_ROOT: w.checkout, POISE_CHAT_ROOT: join(w.checkout, '.poise-chat'), POISE_SELF_UPDATE_ROOT: root,
    })
    expect(service.EnvironmentVariables.GH_TOKEN).toBeUndefined()
    expect(service.EnvironmentVariables.CALLER_RELEASE_SHA).toBe(CALLER_SHA)
    expect(service.EnvironmentVariables.POISE_DB).toBe(join(home, '.poise', 'cache.db'))
    expect(service.EnvironmentVariables.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(service).toMatchObject({ KeepAlive: true, RunAtLoad: true, ThrottleInterval: 10, ProcessType: 'Interactive' })
    const daemon = parsePlist(await readFile(w.installer.daemonPlistPath, 'utf8'))
    expect(daemon.ProgramArguments).toEqual([w.node, join(root, 'controller', 'daemon.mjs')])
    expect(daemon.EnvironmentVariables.GH_TOKEN).toBeUndefined()
    expect(daemon.EnvironmentVariables.POISE_RELEASE_TOKEN_FILE).toBe(w.tokenFile)
    expect(daemon.KeepAlive).toBe(true)

    // Only the two labels we own were bootstrapped; the updater was only inspected.
    expect(labelsTouched(state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL, SERVICE_LABEL])
    expect(labelsTouched(state.launchctl, 'bootout')).toEqual([DAEMON_LABEL, SERVICE_LABEL])
    expect(labelsTouched(state.launchctl, 'print')).toEqual([LEGACY_UPDATER_LABEL])
    expect(state.launchctl.some((call) => call.join(' ').includes('datastore') || call.join(' ').includes('health'))).toBe(false)

    // Drain happened with the bridge key, before the service switch.
    expect(state.drains).toEqual([result.releaseId])
    expect(state.resumes).toBe(0)
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event)
    expect(journal).toEqual([
      'bootstrap.locked', 'bootstrap.staged', 'bootstrap.configured', 'bootstrap.adopted', 'bootstrap.preserved',
      'bootstrap.daemon', 'bootstrap.drained', 'bootstrap.switched', 'bootstrap.verified', 'bootstrap.completed',
    ])
    expect(state.served).toBe('managed')

    // The token never lands anywhere but the GitHub check.
    expect(state.tokenSeen).toEqual(['github'])
    expect(await noFileContains(root, TOKEN)).toBeNull()
    expect(await noFileContains(w.launchAgents, TOKEN)).toBeNull()

    // Second run is a no-op.
    const again = await w.installer.enable({ tokenFile: w.tokenFile })
    expect(again).toMatchObject({ changed: false, alreadyEnabled: true })
    expect(labelsTouched(state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL, SERVICE_LABEL])
  })

  it('writes config enabled only after the release proved healthy, and keeps the legacy updater blocked meanwhile', async () => {
    const w = await world()
    const seen = []
    // Snapshot the guards at the moment the managed build first answers health:
    // config must still be disabled and the legacy updater must already be locked out.
    w.state.onManagedHealth = async () => {
      const { config, present } = await readConfig(w.root, {})
      seen.push({ present, enabled: config.enabled, legacy: await selfUpdateEnabled(w.root).then(() => 'allowed', (error) => error.message) })
    }
    await w.installer.enable({ tokenFile: w.tokenFile })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toEqual({ present: true, enabled: false, legacy: 'Managed controller requires maintenance' })
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event)
    expect(journal.indexOf('bootstrap.completed')).toBe(journal.indexOf('bootstrap.verified') + 1)
    expect(await selfUpdateEnabled(w.root)).toBe(true)
  })

  it('waits for an in-flight legacy updater run before touching anything', async () => {
    const w = await world({ state: { updaterBusyPolls: 2 } })
    await w.installer.enable({ tokenFile: w.tokenFile })
    expect(labelsTouched(w.state.launchctl, 'print').filter((l) => l === LEGACY_UPDATER_LABEL)).toHaveLength(3)
    expect(w.state.sleeps.length).toBeGreaterThanOrEqual(2)
  })

  it('restores the legacy launcher and returns ownership when the release never becomes healthy', async () => {
    const w = await world({ state: { managedNeverHealthy: true } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/did not become healthy[\s\S]*restored to the legacy launcher/)
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    expect(w.state.served).toBe('legacy')
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL, SERVICE_LABEL, SERVICE_LABEL])
    expect(w.state.loaded[DAEMON_LABEL]).toBeUndefined()
    await expect(stat(w.installer.daemonPlistPath)).rejects.toThrow()
    await expect(stat(w.installer.installedPath)).rejects.toThrow()
    expect(await selfUpdateEnabled(w.root)).toBe(false)
    const { config } = await readConfig(w.root, {})
    expect(config.enabled).toBe(false)
    // Built artefacts and the preserved plist are kept for a retry.
    const releases = await readdir(w.paths.releasesDir)
    expect(releases.filter((name) => !name.startsWith('.'))).toHaveLength(1)
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event)
    expect(journal.slice(-3)).toEqual(['bootstrap.failed', 'bootstrap.restored-service', 'bootstrap.restored'])
  })

  it('releases the drain and leaves production untouched when the app never goes idle', async () => {
    const w = await world({ state: { readyAfter: 1_000 } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/did not become idle/)
    expect(w.state.resumes).toBe(1)
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL])
    expect(labelsTouched(w.state.launchctl, 'bootout')).toEqual([DAEMON_LABEL, DAEMON_LABEL])
    await expect(stat(w.installer.installedPath)).rejects.toThrow()
    expect(w.state.served).toBe('legacy')
  })

  it('keeps the maintenance lock and reports loudly when even the restore fails', async () => {
    const w = await world({ state: { managedNeverHealthy: true, legacyNeverHealthy: true } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/RESTORE FAILED/)
    await expect(stat(w.installer.installedPath)).resolves.toBeTruthy()
    await expect(selfUpdateEnabled(w.root)).rejects.toThrow()
  })

  it('leaves nothing built in production when the build fails, and the checkout untouched', async () => {
    const w = await world({ state: { buildFails: true } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/tsc failed/)
    expect((await readdir(w.paths.releasesDir)).filter((name) => !name.startsWith('.'))).toEqual([])
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    expect(w.state.launchctl.filter((call) => call[0] !== 'print')).toEqual([])
    await expect(stat(w.installer.installedPath)).rejects.toThrow()
  })

  it('resumes a bootstrap killed between the switch and the enable without re-staging, re-preserving or re-switching', async () => {
    const w = await world()
    const first = await w.installer.enable({ tokenFile: w.tokenFile })
    // Rewind the records to what a SIGKILL right after the switch leaves: the
    // managed plist is live, the release and preserved plist exist, config is
    // still disabled and installed.json stopped at 'switched'.
    const installed = JSON.parse(await readFile(w.installer.installedPath, 'utf8'))
    await writeFile(w.installer.installedPath, JSON.stringify({ ...installed, phase: 'switched', completedAt: null }))
    const { config } = await readConfig(w.root, {})
    await writeFile(w.paths.configPath, JSON.stringify({ ...config, enabled: false }), { mode: 0o600 })
    await expect(selfUpdateEnabled(w.root)).rejects.toThrow(/maintenance/)
    const npmRuns = w.state.commands.filter((c) => c.command === 'npm').length
    w.state.launchctl.length = 0

    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    expect(result).toMatchObject({ changed: true, releaseId: first.releaseId })
    expect(w.state.commands.filter((c) => c.command === 'npm')).toHaveLength(npmRuns)
    const after = JSON.parse(await readFile(w.installer.installedPath, 'utf8'))
    expect(after.phase).toBe('completed')
    expect(after.preservedPlist).toBe(installed.preservedPlist)
    expect(await readdir(join(w.root, 'preserved'))).toHaveLength(1)
    expect(await readFile(installed.preservedPlist, 'utf8')).toBe(w.legacyText)
    expect(await selfUpdateEnabled(w.root)).toBe(true)
    // The already-live managed service was not drained or switched again; only the daemon was restarted.
    expect(w.state.drains).toEqual([first.releaseId])
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL])
    expect(labelsTouched(w.state.launchctl, 'bootout')).toEqual([DAEMON_LABEL])
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(journal.filter((entry) => entry.event === 'bootstrap.switched').at(-1)).toMatchObject({ alreadyLive: true })
  })
})

describe('bootstrap worker registry', () => {
  it('records, releases and forgets durably in a private file', async () => {
    const path = join(home, 'bootstrap-workers.json')
    const registry = createBootstrapRegistry(path)
    expect(await registry.read()).toEqual({ version: 1, workers: {} })
    await registry.register({ pid: 41, pgid: 41, ident: 'a', argv: ['x'], command: 'npm ci', purpose: 'p', staging: '/s' })
    await registry.register({ pid: 42, pgid: 42, ident: 'b', argv: ['y'], command: 'npm run build', purpose: 'p', staging: '/s' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    expect(Object.keys(onDisk.workers)).toEqual(['41', '42'])
    expect(onDisk.workers[41]).toMatchObject({ pid: 41, ident: 'a', staging: '/s' })
    expect(onDisk.workers[41].registeredAt).toMatch(/T/)
    await registry.release(41)
    expect(Object.keys((await registry.read()).workers)).toEqual(['42'])
    await registry.forget([42, 99])
    expect((await registry.read()).workers).toEqual({})
    // Garbage on disk reads as empty rather than throwing the bootstrap off.
    await writeFile(path, '"nonsense"')
    expect(await registry.read()).toEqual({ version: 1, workers: {} })
  })
})

describe('bootstrap runner (real processes)', () => {
  const env = () => ({ PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home })
  const pgidDead = (pgid) => { try { process.kill(-pgid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
  const waitFor = async (check, ms = 5_000) => {
    const deadline = Date.now() + ms
    while (!check()) { if (Date.now() >= deadline) return false; await new Promise((resolve) => setTimeout(resolve, 25)) }
    return true
  }

  it('registers a write-bearing command durably, naming its staging path, before it runs and releases it after', async () => {
    const registryPath = join(home, BOOTSTRAP_WORKERS_NAME)
    const marker = join(home, 'registry-as-seen-by-command.json')
    const { run } = createBootstrapRunner({ registryPath })
    const result = await run('sh', ['-c', `cat ${registryPath} > ${marker}`], { env: env(), write: true, staging: '/tmp/staging-x', purpose: 'test' })
    expect(result).toMatchObject({ code: 0, settled: true, tracked: true })
    const seen = JSON.parse(await readFile(marker, 'utf8'))
    expect(Object.keys(seen.workers)).toEqual([String(result.pid)])
    expect(seen.workers[result.pid]).toMatchObject({ pid: result.pid, pgid: result.pid, ident: result.ident, staging: '/tmp/staging-x', purpose: 'test' })
    expect(seen.workers[result.pid].argv).toEqual(result.argv)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).workers).toEqual({})
  })

  it('runs read-only commands through the gate without creating the registry', async () => {
    const registryPath = join(home, BOOTSTRAP_WORKERS_NAME)
    const { run } = createBootstrapRunner({ registryPath })
    const result = await run('sh', ['-c', 'echo hello'], { env: env() })
    expect(result).toMatchObject({ code: 0, stdout: 'hello\n', settled: true, tracked: false })
    expect(existsSync(registryPath)).toBe(false)
    expect((await readdir(home)).filter((name) => name !== 'node22')).toEqual([])
    const { run: withoutRegistry } = createBootstrapRunner({})
    await expect(withoutRegistry('true', [], { env: env(), write: true })).rejects.toThrow(/needs the bootstrap worker registry/)
  })

  it('kills the whole group, backgrounded descendants included, on timeout and releases the settled record', async () => {
    const registryPath = join(home, BOOTSTRAP_WORKERS_NAME)
    const { run } = createBootstrapRunner({ registryPath })
    const failure = await run('sh', ['-c', 'sleep 30 & echo $!; sleep 30'], { env: env(), write: true, staging: '/s', timeoutMs: 400 }).catch((error) => error)
    expect(failure.message).toMatch(/timed out after 400 ms/)
    expect(failure.result).toMatchObject({ timedOut: true, settled: true })
    const orphan = Number(failure.result.stdout.trim())
    expect(orphan).toBeGreaterThan(1)
    expect(await waitFor(() => pgidDead(failure.result.pgid))).toBe(true)
    expect(await waitFor(() => { try { process.kill(orphan, 0); return false } catch (error) { return error.code === 'ESRCH' } })).toBe(true)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).workers).toEqual({})
  })

  it('takes the group down when the bootstrap process itself is killed', async () => {
    const registryPath = join(home, BOOTSTRAP_WORKERS_NAME)
    const marker = join(home, 'pgid')
    const installer = fileURLToPath(new URL('../scripts/install-self-update.mjs', import.meta.url))
    const script = [
      `import { createBootstrapRunner } from ${JSON.stringify(installer)}`,
      `import { writeFileSync } from 'node:fs'`,
      `const { run } = createBootstrapRunner({ registryPath: ${JSON.stringify(registryPath)} })`,
      `const registry = (await import(${JSON.stringify(installer)})).createBootstrapRegistry(${JSON.stringify(registryPath)})`,
      `const poll = setInterval(async () => { const w = Object.values((await registry.read()).workers); if (w.length) { writeFileSync(${JSON.stringify(marker)}, String(w[0].pgid)); clearInterval(poll) } }, 20)`,
      `await run('sh', ['-c', 'sleep 60 & sleep 60'], { env: ${JSON.stringify(env())}, write: true, staging: '/s', timeoutMs: 120000 })`,
    ].join('\n')
    const scriptPath = join(home, 'parent.mjs')
    await writeFile(scriptPath, script)
    const parent = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    parent.stderr.on('data', (chunk) => { stderr += chunk })
    expect(await waitFor(() => existsSync(marker), 8_000)).toBe(true)
    const pgid = Number(await readFile(marker, 'utf8'))
    expect(pgid).toBeGreaterThan(1)
    expect(pgidDead(pgid)).toBe(false)
    parent.kill('SIGKILL')
    await new Promise((resolve) => parent.once('exit', resolve))
    expect(await waitFor(() => pgidDead(pgid), 8_000)).toBe(true)
    expect(stderr).toBe('')
    // The record outlives the parent: it is what the next run reconciles.
    expect(Object.keys(JSON.parse(await readFile(registryPath, 'utf8')).workers)).toEqual([String(pgid)])
  })

  it('refuses to start any subprocess whose environment names a token', () => {
    expect(() => assertSubprocessEnvironment({ PATH: '/bin', HOME: '/h' })).not.toThrow()
    expect(() => assertSubprocessEnvironment({ PATH: '/bin', POISE_RELEASE_TOKEN_FILE: '/t' })).toThrow(/POISE_RELEASE_TOKEN_FILE/)
    expect(() => assertSubprocessEnvironment({ GH_TOKEN: 'x', GITHUB_TOKEN: 'y' })).toThrow(/GH_TOKEN, GITHUB_TOKEN/)
    expect(() => assertSubprocessEnvironment(null)).toThrow(/required/)
  })
})

describe('worker reconciliation and staging quarantine', () => {
  const seedRegistry = async (w, records) => {
    await mkdir(w.root, { recursive: true, mode: 0o700 })
    await writeFile(join(w.root, BOOTSTRAP_WORKERS_NAME), JSON.stringify({ version: 1, workers: records }), { mode: 0o600 })
  }

  it('forgets groups the reaper proves gone and stages normally', async () => {
    const reaps = []
    const w = await world({ reap: async (workers) => { reaps.push(workers); return { killed: [{ pid: 11, reason: 'killed' }], cleared: [{ pid: 12, reason: 'dead' }], retained: [] } } })
    await seedRegistry(w, { 11: { pid: 11, ident: 'a', argv: [], staging: '/old' }, 12: { pid: 12, ident: 'b', argv: [], staging: '/old' } })
    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    expect(result.changed).toBe(true)
    expect(reaps).toHaveLength(1)
    expect(JSON.parse(await readFile(join(w.root, BOOTSTRAP_WORKERS_NAME), 'utf8')).workers).toEqual({})
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(journal.find((entry) => entry.event === 'bootstrap.workers-reconciled')).toMatchObject({ killed: [{ pid: 11 }], cleared: [{ pid: 12 }], retained: [] })
  })

  it('retains an unverifiable group and refuses to re-enter its staging path', async () => {
    const w = await world({ reap: async () => ({ killed: [], cleared: [], retained: [{ pid: 13, reason: 'survived SIGKILL' }] }) })
    const stagingId = '20270101T000000Z-a1b2c3d4e5f6'
    const staging = join(w.paths.releasesDir, `.${stagingId}.staging`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'half-written'), 'x')
    await seedRegistry(w, { 13: { pid: 13, ident: 'c', argv: [], staging } })
    // Point installed.json at that release id so the run wants the same staging path.
    await writeFile(w.installer.installedPath, JSON.stringify({ version: 1, phase: 'locked', checkout: w.checkout, baseline: { id: stagingId, sha: SHA, root: join(w.paths.releasesDir, stagingId) } }), { mode: 0o600 })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/refusing to reuse .*\.staging: a bootstrap worker group/)
    expect(existsSync(join(staging, 'half-written'))).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(join(w.root, BOOTSTRAP_WORKERS_NAME), 'utf8')).workers)).toEqual(['13'])
    expect(w.state.commands.some((c) => c.command === 'npm')).toBe(false)
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
  })

  it('keeps the staging directory when a build worker group did not settle', async () => {
    const w = await world({ state: { failUnsettled: true } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/did not die/)
    const stagings = (await readdir(w.paths.releasesDir)).filter((name) => name.endsWith('.staging'))
    expect(stagings).toHaveLength(1)
    expect(existsSync(join(w.paths.releasesDir, stagings[0], 'node_modules'))).toBe(true)
    const journal = (await readFile(w.installer.journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(journal.find((entry) => entry.event === 'bootstrap.staging-quarantined')).toMatchObject({ staging: join(w.paths.releasesDir, stagings[0]) })
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
  })

  it('never hands the token path or gh credentials to git, npm or node', async () => {
    const w = await world()
    await w.installer.enable({ tokenFile: w.tokenFile })
    expect(w.state.tokenSeen).toEqual(['github'])
    for (const command of w.state.commands) {
      expect(Object.keys(command.env)).not.toContain('POISE_RELEASE_TOKEN_FILE')
      expect(Object.keys(command.env)).not.toContain('GH_TOKEN')
    }
  })
})

describe('preflight refusals', () => {
  it('refuses a dirty checkout', async () => {
    const w = await world({ state: { dirty: ' M server/production.ts' } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/local modifications/)
    await expect(stat(w.root)).rejects.toThrow()
  })

  it('refuses a checkout that is not at GitHub main', async () => {
    const w = await world({ state: { remoteMain: NEXT_SHA } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/fast-forward first/)
  })

  it('refuses another branch, another remote, or a checkout without the controller', async () => {
    const branch = await world({ state: { branch: 'feat/x' } })
    await expect(branch.installer.enable({ tokenFile: branch.tokenFile })).rejects.toThrow(/not main/)
    const remote = await world({ state: { remote: 'https://github.com/someone/Poise.git' } })
    await expect(remote.installer.enable({ tokenFile: remote.tokenFile })).rejects.toThrow(/not mikkokotila\/Poise/)
    const missing = await world()
    await rm(join(missing.checkout, 'scripts', 'self-update', 'daemon.mjs'))
    await expect(missing.installer.enable({ tokenFile: missing.tokenFile })).rejects.toThrow(/does not contain the self-update controller/)
  })

  it('refuses when the running server does not serve the checkout SHA', async () => {
    const w = await world({ state: { runningSha: NEXT_SHA } })
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/serves build b{12} but the checkout/)
  })

  it('refuses a token file that is missing, world-readable, inside the root, or lacking push', async () => {
    const w = await world({ env: { HOME: home, PATH: '/usr/bin:/bin' } })
    await expect(w.installer.enable({})).rejects.toThrow(/--token-file/)
    await expect(w.installer.enable({ tokenFile: join(home, 'nope') })).rejects.toThrow(/does not exist/)
    await chmod(w.tokenFile, 0o644)
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/chmod 600/)
    await chmod(w.tokenFile, 0o600)
    await expect(w.installer.enable({ tokenFile: join(w.root, 'release-token') })).rejects.toThrow(/outside the controller root/)
    w.state.githubRepo = { full_name: 'mikkokotila/Poise', default_branch: 'main', permissions: { push: false, pull: true } }
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/cannot push/)
    w.state.githubRepo = { full_name: 'mikkokotila/Other', default_branch: 'main', permissions: { push: true } }
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/instead of mikkokotila\/Poise/)
    expect(w.state.tokenSeen.every((where) => where === 'github')).toBe(true)
  })

  it('refuses an unsupported Node runtime, a missing Caller pin, or a non-macOS host', async () => {
    const oldNode = await world({ state: { nodeVersion: 'v18.20.0' } })
    await expect(oldNode.installer.enable({ tokenFile: oldNode.tokenFile })).rejects.toThrow(/v18.20.0/)
    const noCaller = await world()
    const document = parsePlist(await readFile(noCaller.servicePlistPath, 'utf8'))
    delete document.EnvironmentVariables.CALLER_RELEASE_SHA
    await writeFile(noCaller.servicePlistPath, plistXml(document))
    await expect(noCaller.installer.enable({ tokenFile: noCaller.tokenFile })).rejects.toThrow(/CALLER_RELEASE_SHA/)
    const linux = await world({ platform: 'linux' })
    await expect(linux.installer.enable({ tokenFile: linux.tokenFile })).rejects.toThrow(/macOS/)
    await expect(linux.installer.disable()).rejects.toThrow(/macOS/)
  })

  it('refuses a missing or unrecognised service plist', async () => {
    const w = await world()
    await writeFile(w.servicePlistPath, plistXml({ Label: SERVICE_LABEL, ProgramArguments: ['/n', '/elsewhere/server.js'] }))
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/expected scripts\/start-production.mjs/)
    await rm(w.servicePlistPath)
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/install production first/)
  })
})

describe('maintenance', () => {
  async function enabledWorld(overrides) {
    const w = await world(overrides)
    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    w.state.launchctl.length = 0
    w.state.drains.length = 0
    return { ...w, releaseId: result.releaseId }
  }

  it('disable restores the preserved legacy plist, stops the daemon, and keeps the legacy updater blocked', async () => {
    const w = await enabledWorld()
    const result = await w.installer.disable()
    expect(result).toMatchObject({ changed: true, serviceMode: 'legacy', checkout: w.checkout, activeRelease: { id: w.releaseId, sha: SHA } })
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    expect(w.state.served).toBe('legacy')
    expect(w.state.drains).toEqual(['maintenance'])
    expect(labelsTouched(w.state.launchctl, 'bootout')).toEqual([DAEMON_LABEL, SERVICE_LABEL])
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([SERVICE_LABEL])
    expect(w.state.loaded[DAEMON_LABEL]).toBeUndefined()
    const { config } = await readConfig(w.root, {})
    expect(config).toMatchObject({ enabled: false, callerSha: CALLER_SHA, tokenFile: w.tokenFile })
    await expect(selfUpdateEnabled(w.root)).rejects.toThrow(/maintenance/)
    const installed = JSON.parse(await readFile(w.installer.installedPath, 'utf8'))
    expect(installed.phase).toBe('disabled')
    expect(await readFile(installed.managedPlist, 'utf8')).toContain(TRUSTED_LAUNCHER)
    // Nothing built or recorded was lost.
    await expect(stat(join(w.paths.releasesDir, w.releaseId, 'dist', 'server.js'))).resolves.toBeTruthy()
    await expect(stat(w.paths.activePointerPath)).resolves.toBeTruthy()
    await expect(stat(w.paths.statePath)).resolves.toBeTruthy()
    // Caller stays pinned in the restored definition.
    expect(parsePlist(await readFile(w.servicePlistPath, 'utf8')).EnvironmentVariables.CALLER_RELEASE_SHA).toBe(CALLER_SHA)
    // A second disable is a no-op.
    expect(await w.installer.disable()).toMatchObject({ changed: false, serviceMode: 'legacy' })
  })

  it('disable refuses while the controller has work in flight, unless forced', async () => {
    const w = await enabledWorld()
    const state = JSON.parse(await readFile(w.paths.statePath, 'utf8'))
    state.switching = { releaseId: 'x' }
    await writeFile(w.paths.statePath, JSON.stringify(state))
    await expect(w.installer.disable()).rejects.toThrow(/release switch is in progress/)
    expect(await readFile(w.servicePlistPath, 'utf8')).toContain(TRUSTED_LAUNCHER)
    expect(await selfUpdateEnabled(w.root)).toBe(true)
    const result = await w.installer.disable({ force: true })
    expect(result.changed).toBe(true)
  })

  it('disable puts the managed service back and re-enables when the legacy launcher will not start', async () => {
    const w = await enabledWorld()
    const managedText = await readFile(w.servicePlistPath, 'utf8')
    w.state.legacyNeverHealthy = true
    await expect(w.installer.disable()).rejects.toThrow(/did not become healthy[\s\S]*left in place and re-enabled/)
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(managedText)
    expect(w.state.served).toBe('managed')
    expect(w.state.loaded[DAEMON_LABEL]).toBeTruthy()
    expect(await selfUpdateEnabled(w.root)).toBe(true)
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([SERVICE_LABEL, SERVICE_LABEL, DAEMON_LABEL])
  })

  it('disable releases the drain and re-enables when the app never goes idle', async () => {
    const w = await enabledWorld()
    w.state.readyAfter = 1_000
    await expect(w.installer.disable()).rejects.toThrow(/did not become idle/)
    expect(w.state.resumes).toBe(1)
    expect(w.state.served).toBe('managed')
    expect(await selfUpdateEnabled(w.root)).toBe(true)
    expect(labelsTouched(w.state.launchctl, 'bootstrap')).toEqual([DAEMON_LABEL])
  })

  it('re-enable after maintenance reuses the baseline when the checkout has not moved', async () => {
    const w = await enabledWorld()
    await w.installer.disable()
    w.state.launchctl.length = 0
    const before = w.state.commands.filter((c) => c.command === 'npm').length
    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    expect(result).toMatchObject({ changed: true, releaseId: w.releaseId })
    expect(w.state.commands.filter((c) => c.command === 'npm')).toHaveLength(before)
    expect(await selfUpdateEnabled(w.root)).toBe(true)
    expect(w.state.served).toBe('managed')
  })

  it('re-enable on a moved checkout requires --rebaseline and records the previous release', async () => {
    const w = await enabledWorld()
    await w.installer.disable()
    w.state.sha = NEXT_SHA
    w.state.remoteMain = NEXT_SHA
    w.state.runningSha = NEXT_SHA
    await expect(w.installer.enable({ tokenFile: w.tokenFile })).rejects.toThrow(/--rebaseline/)
    expect(await readFile(w.servicePlistPath, 'utf8')).toBe(w.legacyText)
    const result = await w.installer.enable({ tokenFile: w.tokenFile, rebaseline: true })
    expect(result.releaseId).not.toBe(w.releaseId)
    const pointer = JSON.parse(await readFile(w.paths.activePointerPath, 'utf8'))
    expect(pointer).toMatchObject({ id: result.releaseId, sha: NEXT_SHA, previousId: w.releaseId })
    const state = JSON.parse(await readFile(w.paths.statePath, 'utf8'))
    expect(Object.keys(state.releases).sort()).toEqual([w.releaseId, result.releaseId].sort())
    expect(await selfUpdateEnabled(w.root)).toBe(true)
  })

  it('uninstall hands ownership back only after disable, and keeps the root', async () => {
    const w = await enabledWorld()
    await expect(w.installer.uninstall()).rejects.toThrow(/run 'disable' first/)
    await w.installer.disable()
    expect(await w.installer.uninstall()).toEqual({ changed: true })
    await expect(stat(w.installer.installedPath)).rejects.toThrow()
    await expect(stat(w.installer.daemonPlistPath)).rejects.toThrow()
    expect(await selfUpdateEnabled(w.root)).toBe(false)
    await expect(stat(join(w.paths.releasesDir, w.releaseId, 'release.json'))).resolves.toBeTruthy()
    expect(await w.installer.uninstall()).toEqual({ changed: false })
  })
})

describe('status and doctor', () => {
  it('reports a fresh machine as not bootstrapped with production answering', async () => {
    const w = await world()
    const report = await w.installer.status()
    expect(report).toMatchObject({ installed: null, config: { present: false, enabled: false }, service: { mode: 'legacy', checkout: w.checkout }, controller: { daemon: false, launcher: false }, release: null, app: { status: 'ok', build: { sha: SHA, releaseId: null } }, ok: true })
    await expect(stat(w.root)).rejects.toThrow()
  })

  it('describes an enabled installation and flags inconsistencies', async () => {
    const w = await world()
    const result = await w.installer.enable({ tokenFile: w.tokenFile })
    const healthy = await w.installer.doctor()
    expect(healthy).toMatchObject({ ok: true, problems: [], service: { mode: 'managed', launchd: { loaded: true } }, daemon: { plistPresent: true, launchd: { loaded: true } }, release: { pointer: { id: result.releaseId }, complete: true }, app: { build: { releaseId: result.releaseId } } })
    expect(w.state.logs.at(-1)).toMatch(/no problems/)
    // Daemon gone: doctor says so.
    delete w.state.loaded[DAEMON_LABEL]
    const broken = await w.installer.doctor()
    expect(broken.ok).toBe(false)
    expect(broken.problems.join('\n')).toMatch(/daemon is not answering/)
    // Interrupted bootstrap phase is called out.
    await writeFile(w.installer.installedPath, JSON.stringify({ ...JSON.parse(await readFile(w.installer.installedPath, 'utf8')), phase: 'drained' }))
    expect((await w.installer.status()).problems.join('\n')).toMatch(/incomplete \(phase drained\)/)
  })
})

describe('command line', () => {
  it('parses commands and options and rejects unknown ones', () => {
    expect(parseArgs(['enable', '--token-file', '/t', '--dry-run'])).toMatchObject({ command: 'enable', tokenFile: '/t', dryRun: true })
    expect(parseArgs(['enable', '--token-file=/t', '--rebaseline'])).toMatchObject({ tokenFile: '/t', rebaseline: true })
    expect(parseArgs(['disable', '--force'])).toMatchObject({ command: 'disable', force: true })
    expect(parseArgs(['status', '--json'])).toMatchObject({ command: 'status', json: true })
    expect(() => parseArgs([])).toThrow(/usage/)
    expect(() => parseArgs(['frobnicate'])).toThrow(/usage/)
    expect(() => parseArgs(['enable', '--nope'])).toThrow(/unknown option/)
  })
})
