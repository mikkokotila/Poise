import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function paths(home) {
  const root = join(home, '.local', 'share', 'caller-pr-stop-gate')
  return {
    root,
    python: join(root, 'bin', 'python'),
    agentInterface: join(root, 'bin', 'agent-interface'),
    githubInterface: join(root, 'bin', 'github-interface'),
    marker: join(root, 'release.json'),
  }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function sameManifest(actual, expected) {
  return actual?.repository === expected.repository
    && actual?.ref === expected.ref
    && actual?.commit === expected.commit
    && JSON.stringify(actual?.packages) === JSON.stringify(expected.packages)
}

async function scopeEnvironment(home, run, environment = process.env) {
  let organization = environment.POISE_GITHUB_ORG?.trim()
  if (!organization) {
    try {
      const result = await run('/usr/bin/sqlite3', [
        join(home, '.poise', 'cache.db'),
        "SELECT value FROM meta WHERE key = 'org' LIMIT 1;",
      ], { capture: true })
      organization = result.stdout.trim()
    } catch {
      // A first install can precede organization setup.
    }
  }
  if (organization
    && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(organization)) {
    throw new Error('Configured GitHub organization is invalid')
  }
  return {
    ...environment,
    ...(organization ? { CALLER_PR_GATE_SCOPE: `${organization}/*` } : {}),
  }
}

export async function stopGateIsCurrent({ home, manifest }) {
  const hook = paths(home)
  try {
    const marker = JSON.parse(await readFile(hook.marker, 'utf8'))
    return sameManifest(marker, manifest)
      && await executable(hook.python)
      && await executable(hook.agentInterface)
      && await executable(hook.githubInterface)
  } catch {
    return false
  }
}

export async function configureStopGate({ home, run, environment = process.env }) {
  const hook = paths(home)
  if (!await executable(hook.agentInterface)) {
    throw new Error('Caller stop gate is not installed')
  }
  await run(hook.agentInterface, ['--install-pr-stop-gate'], {
    capture: true,
    env: await scopeEnvironment(home, run, environment),
  })
}

export async function installStopGate({
  home,
  manifest,
  python,
  releaseRoot,
  run,
  environment = process.env,
}) {
  const hook = paths(home)
  if (!await executable(hook.python)) {
    await mkdir(hook.root, { recursive: true, mode: 0o700 })
    await run(python, ['-m', 'venv', '--clear', hook.root])
  }
  await run(hook.python, ['-m', 'ensurepip', '--upgrade'], { capture: true })
  await run(hook.python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--force-reinstall',
    join(releaseRoot, 'source', 'github_interface'),
    join(releaseRoot, 'source', 'agent_interface'),
  ])
  await configureStopGate({ home, run, environment })
  await writeFile(hook.marker, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await chmod(hook.marker, 0o600)
}
