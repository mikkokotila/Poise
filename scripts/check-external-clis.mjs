import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

const envPath = join(process.cwd(), '.env')
let failed = false
let dotenvSecure = true
if (existsSync(envPath) && process.platform !== 'win32') {
  const envStat = statSync(envPath)
  const permissions = envStat.mode & 0o777
  if (!envStat.isFile()) {
    dotenvSecure = false
    failed = true
    console.error('fail  .env must be a regular file')
  } else if ((permissions & 0o077) === 0) {
    console.log('ok  .env permissions are owner-only')
  } else {
    dotenvSecure = false
    failed = true
    console.error(`fail  .env permissions are ${permissions.toString(8)}; run: chmod 600 .env`)
  }
}
if (dotenvSecure) loadDotenv({ path: envPath, quiet: true })

const SAFE_CHILD_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR', 'SHELL', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'NO_COLOR', 'CI',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]

function diagnosticEnvironment(command) {
  const env = Object.fromEntries(SAFE_CHILD_ENV
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]))
  if (command === 'gh') {
    for (const key of ['GH_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
  }
  return env
}

const checks = [
  {
    command: 'gh',
    args: ['auth', 'status', '--active', '--hostname', 'github.com'],
    label: 'GitHub CLI authentication',
  },
  {
    command: 'github-datastore',
    args: ['--help'],
    label: 'github-datastore contract',
    requiredOutput: [
      'view',
      'pr',
      'issue',
      'user',
      '--author',
      '--format',
      '--item-type',
      '--limit',
      '--status',
      '--updated-since-datetime',
      '--username',
    ],
  },
  {
    command: 'github-interface',
    args: ['--help'],
    label: 'github-interface contract',
    requiredOutput: [
      '--head-sha',
      '--local-checkout-path',
      '--mergeable',
      '--requested-changes-addressed',
      '--resolve-nonblocking-conversations-if-ready',
      '--username',
      '--view-repos',
    ],
  },
  {
    command: 'agent-interface',
    args: ['--help'],
    label: 'agent-interface contract',
    requiredOutput: [
      '--author-content',
      '--chat',
      '--debate',
      '--logs',
      '--model',
      '--note',
      '--p',
      '--pwd',
      '--pr-approve',
      '--pr-review',
      '--read-response',
      '--rounds',
      '--session',
      '--session-id',
    ],
  },
]

for (const check of checks) {
  const result = spawnSync(check.command, check.args, {
    encoding: 'utf8',
    env: diagnosticEnvironment(check.command),
    timeout: 10_000,
    windowsHide: true,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const missing = (check.requiredOutput || []).filter((capability) => !output.includes(capability))
  if (result.status === 0 && missing.length === 0) {
    console.log(`ok  ${check.label}`)
    continue
  }
  failed = true
  const reason = result.status === 0
    ? `missing required capabilities: ${missing.join(', ')}`
    : result.error?.code || result.signal || `exit ${result.status ?? 'unknown'}`
  console.error(`fail  ${check.label}: ${reason}`)
}

const agentRoot = process.env.AGENT_INTERFACE_ROOT
  || join(homedir(), 'dev', 'caller', 'agent_interface')
if (existsSync(agentRoot) && statSync(agentRoot).isDirectory()) console.log(`ok  agent-interface root: ${agentRoot}`)
else {
  failed = true
  console.error(`fail  agent-interface root not found: ${agentRoot}`)
}

if (failed) process.exitCode = 1
