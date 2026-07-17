import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

const projectRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(await readFile(
  join(projectRoot, 'config', 'caller-release.json'),
  'utf8',
))
const home = homedir()
const stateRoot = join(home, '.poise')
const releaseRoot = join(stateRoot, 'releases', 'caller', manifest.commit)
const binRoot = join(releaseRoot, 'venv', 'bin')
const agentRoot = join(releaseRoot, 'source', 'agent_interface')
const launchAgents = join(home, 'Library', 'LaunchAgents')
const serviceLabel = 'com.vaquum.poise'
const monitorLabel = 'com.vaquum.poise.health'
const servicePlist = join(launchAgents, `${serviceLabel}.plist`)
const monitorPlist = join(launchAgents, `${monitorLabel}.plist`)
const logRoot = join(stateRoot, 'logs')
const domain = `gui/${process.getuid()}`
const dotenvPath = join(projectRoot, '.env')

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function commandOutput(command, args) {
  return (await run(command, args, { capture: true })).stdout.trim()
}

async function supportedNode() {
  const candidates = [
    process.env.POISE_NODE,
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
    '/opt/homebrew/opt/node@20/bin/node',
    '/usr/local/opt/node@20/bin/node',
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
    process.execPath,
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (!await executable(candidate)) continue
    const match = (await commandOutput(candidate, ['--version'])).match(/^v(\d+)\.(\d+)\./)
    if (!match) continue
    const major = Number(match[1])
    const minor = Number(match[2])
    if ((major === 20 && minor >= 19)
      || (major === 22 && minor >= 13)
      || major === 24) return candidate
  }
  throw new Error('Install supported Node.js 20.19+, 22.13+, or 24.x, or set POISE_NODE')
}

async function python313() {
  const candidates = [
    process.env.POISE_PYTHON,
    '/opt/homebrew/bin/python3.13',
    '/usr/local/bin/python3.13',
    'python3.13',
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    try {
      const version = await commandOutput(candidate, [
        '-c',
        'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")',
      ])
      if (version === '3.13') return candidate
    } catch {
      // Try the next explicit interpreter.
    }
  }
  throw new Error('Python 3.13 is required to install the pinned Caller release')
}

async function validateExistingRelease() {
  try {
    const marker = JSON.parse(await readFile(join(releaseRoot, 'release.json'), 'utf8'))
    if (JSON.stringify(marker) !== JSON.stringify(manifest)) return false
    for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
      const path = join(binRoot, command)
      await access(path, constants.X_OK)
      const firstLine = (await readFile(path, 'utf8')).split('\n', 1)[0]
      if (!firstLine.startsWith('#!')) return false
      await access(firstLine.slice(2).trim().split(/\s+/, 1)[0], constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

async function rewriteVenvEntrypoints(staging) {
  const stagingBin = join(staging, 'venv', 'bin')
  const from = `#!${stagingBin}/`
  const to = `#!${binRoot}/`
  for (const name of await readdir(stagingBin)) {
    const path = join(stagingBin, name)
    let content
    try {
      content = await readFile(path, 'utf8')
    } catch {
      continue
    }
    if (content.startsWith(from)) {
      await writeFile(path, to + content.slice(from.length))
    }
  }
}

async function installCallerRelease(python) {
  if (await validateExistingRelease()) return
  try {
    await stat(releaseRoot)
    const marker = JSON.parse(await readFile(join(releaseRoot, 'release.json'), 'utf8'))
    if (JSON.stringify(marker) !== JSON.stringify(manifest)) {
      throw new Error(`Refusing to replace unknown Caller release at ${releaseRoot}`)
    }
    await rm(releaseRoot, { recursive: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const parent = dirname(releaseRoot)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(parent, `.${manifest.commit}.`))
  try {
    const source = join(staging, 'source')
    const venv = join(staging, 'venv')
    await run('gh', ['repo', 'clone', manifest.repository, source, '--', '--filter=blob:none', '--no-checkout'])
    await run('git', ['-C', source, 'checkout', '--detach', manifest.commit])
    const actual = await commandOutput('git', ['-C', source, 'rev-parse', 'HEAD'])
    if (actual !== manifest.commit) throw new Error('Caller checkout did not resolve to the pinned commit')
    await run(python, ['-m', 'venv', venv])
    const venvPython = join(venv, 'bin', 'python')
    await run(venvPython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      join(source, 'github_datastore'),
      join(source, 'github_interface'),
      join(source, 'agent_interface'),
    ])
    const expectedVersions = JSON.stringify(manifest.packages)
    const installedVersions = JSON.parse(await commandOutput(venvPython, [
      '-c',
      [
        'import importlib.metadata, json',
        `names = ${expectedVersions}`,
        'print(json.dumps({name: importlib.metadata.version(name) for name in names}, sort_keys=True))',
      ].join('; '),
    ]))
    if (JSON.stringify(installedVersions) !== JSON.stringify(manifest.packages)) {
      throw new Error('Installed Caller package versions do not match the release manifest')
    }
    await rewriteVenvEntrypoints(staging)
    await writeFile(join(staging, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(staging, releaseRoot)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function array(values) {
  return `<array>${values.map((value) => `<string>${xml(value)}</string>`).join('')}</array>`
}

function dictionary(values) {
  return `<dict>${Object.entries(values)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('')}</dict>`
}

function plist(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    entries.join(''),
    '</dict></plist>',
    '',
  ].join('\n')
}

function key(name, value) {
  return `<key>${xml(name)}</key>${value}`
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function bootout(label) {
  try {
    await run('/bin/launchctl', ['bootout', `${domain}/${label}`], { capture: true })
  } catch {
    // A first install has nothing to unload.
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The supervised production installer currently supports macOS launchd')
  }
  const dotenvStat = await stat(dotenvPath)
  if (!dotenvStat.isFile() || (dotenvStat.mode & 0o077) !== 0) {
    throw new Error('.env must exist and be owner-readable only (chmod 600 .env)')
  }
  loadDotenv({ path: dotenvPath, quiet: true })
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(
    process.env.REVIEW_AGENT_USERNAME || '',
  )) throw new Error('REVIEW_AGENT_USERNAME must be configured before production installation')

  const [node, python] = await Promise.all([supportedNode(), python313()])
  await installCallerRelease(python)
  const nodeEnvironment = {
    ...process.env,
    PATH: `${dirname(node)}:${process.env.PATH || '/usr/bin:/bin'}`,
  }
  await run('npm', ['ci'], {
    cwd: projectRoot,
    env: nodeEnvironment,
  })
  await run('npm', ['run', 'build'], {
    cwd: projectRoot,
    env: nodeEnvironment,
  })

  const legacyData = join(home, 'dev', 'caller', 'agent_interface', 'data')
  let agentData = process.env.AGENT_INTERFACE_DATA_DIR || join(stateRoot, 'agent-interface')
  try {
    if (!process.env.AGENT_INTERFACE_DATA_DIR && (await stat(legacyData)).isDirectory()) {
      agentData = legacyData
    }
  } catch {
    // A new installation uses the state directory.
  }
  await Promise.all([
    mkdir(launchAgents, { recursive: true, mode: 0o700 }),
    mkdir(logRoot, { recursive: true, mode: 0o700 }),
    mkdir(agentData, { recursive: true, mode: 0o700 }),
  ])
  const path = `${binRoot}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const environment = {
    AGENT_INTERFACE_DATA_DIR: agentData,
    AGENT_INTERFACE_ROOT: agentRoot,
    CALLER_BIN_ROOT: binRoot,
    CALLER_RELEASE_ROOT: releaseRoot,
    CALLER_RELEASE_SHA: manifest.commit,
    HOME: home,
    LANG: process.env.LANG || 'en_US.UTF-8',
    NODE_ENV: 'production',
    PATH: path,
    POISE_ENFORCE_CALLER_RELEASE: '1',
    TMPDIR: process.env.TMPDIR || '/tmp',
  }
  const service = plist([
    key('Label', `<string>${serviceLabel}</string>`),
    key('ProgramArguments', array([node, join(projectRoot, 'dist', 'server.js')])),
    key('WorkingDirectory', `<string>${xml(projectRoot)}</string>`),
    key('EnvironmentVariables', dictionary(environment)),
    key('RunAtLoad', '<true/>'),
    key('KeepAlive', '<true/>'),
    key('ProcessType', '<string>Interactive</string>'),
    key('ThrottleInterval', '<integer>10</integer>'),
    key('StandardOutPath', `<string>${xml(join(logRoot, 'production.out.log'))}</string>`),
    key('StandardErrorPath', `<string>${xml(join(logRoot, 'production.err.log'))}</string>`),
  ])
  const monitor = plist([
    key('Label', `<string>${monitorLabel}</string>`),
    key('ProgramArguments', array([node, join(projectRoot, 'scripts', 'monitor-production.mjs')])),
    key('WorkingDirectory', `<string>${xml(projectRoot)}</string>`),
    key('EnvironmentVariables', dictionary({
      HOME: home,
      LANG: process.env.LANG || 'en_US.UTF-8',
      PATH: path,
      POISE_HEALTH_URL: `http://127.0.0.1:${process.env.POISE_PORT || '5555'}/api/health`,
      TMPDIR: process.env.TMPDIR || '/tmp',
    })),
    key('RunAtLoad', '<true/>'),
    key('StartInterval', '<integer>60</integer>'),
    key('StandardOutPath', `<string>${xml(join(logRoot, 'health.out.log'))}</string>`),
    key('StandardErrorPath', `<string>${xml(join(logRoot, 'health.err.log'))}</string>`),
  ])
  await Promise.all([
    atomicWrite(servicePlist, service),
    atomicWrite(monitorPlist, monitor),
  ])
  await bootout(monitorLabel)
  await bootout(serviceLabel)
  await run('/bin/launchctl', ['bootstrap', domain, servicePlist])
  await run('/bin/launchctl', ['enable', `${domain}/${serviceLabel}`])
  await run('/bin/launchctl', ['kickstart', '-k', `${domain}/${serviceLabel}`])
  await run('/bin/launchctl', ['bootstrap', domain, monitorPlist])
  await run('/bin/launchctl', ['enable', `${domain}/${monitorLabel}`])
  await run('/bin/launchctl', ['kickstart', '-k', `${domain}/${monitorLabel}`])
  console.log(`Installed ${serviceLabel} with Caller ${manifest.commit}`)
}

await main()
