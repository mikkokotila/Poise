import { spawnSync } from 'node:child_process'
import {
  closeSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

const envPath = join(process.cwd(), '.env')
const claudeSubscriptionWrapper = join(process.cwd(), 'scripts', 'claude-subscription.mjs')
let failed = false
let dotenvSecure = true
if (process.platform === 'win32') {
  failed = true
  console.error('fail  native Windows is unsupported; run Poise in WSL')
} else {
  console.log('ok  supported macOS/Linux platform')
}
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
  'USER', 'USERNAME', 'LOGNAME',
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
  if (command === 'claude') {
    for (const key of ['CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
  }
  return env
}

let wrapperProbeDirectory = null
let wrapperProbe = null
if (process.platform !== 'win32') {
  wrapperProbeDirectory = mkdtempSync(join(tmpdir(), 'poise-wrapper-contract-'))
  wrapperProbe = join(wrapperProbeDirectory, 'claude-probe')
  writeFileSync(wrapperProbe, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (!args.includes('--model') || !args.includes('opus') || args.at(-1) !== 'Poise wrapper contract probe') {
  process.stderr.write('invalid wrapper invocation')
  process.exit(64)
}
process.stdout.write('POISE_CLAUDE_WRAPPER_CONTRACT_OK')
`)
  chmodSync(wrapperProbe, 0o700)
}

const checks = [
  {
    command: 'claude',
    args: ['--help'],
    label: 'Claude Code monitor contract',
    captureStdoutToFile: true,
    requiredOutput: [
      '--print',
      '--model',
      '--permission-mode',
      '--settings',
      '--tools',
      '--no-session-persistence',
    ],
  },
  {
    command: 'claude',
    args: ['auth', 'login', '--help'],
    label: 'Claude.ai login contract',
    requiredOutput: ['--claudeai'],
  },
  {
    command: process.execPath,
    args: [claudeSubscriptionWrapper, 'auth', 'status', '--json'],
    envCommand: 'claude',
    label: 'Claude subscription authentication',
    validateOutput(result) {
      try {
        const status = JSON.parse(result.stdout || '{}')
        return status.loggedIn === true
          && status.authMethod === 'claude.ai'
          && status.apiProvider === 'firstParty'
      } catch {
        return false
      }
    },
    validationFailure: 'not authenticated with a Claude.ai subscription',
  },
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
  ...(wrapperProbe ? [{
    command: 'agent-interface',
    args: [
      '--chat',
      'Poise wrapper contract probe',
      '--model',
      'opus',
      '--pwd',
      wrapperProbeDirectory,
      '--no-tools',
    ],
    label: 'agent-interface Claude wrapper contract',
    requiredOutput: ['POISE_CLAUDE_WRAPPER_CONTRACT_OK'],
    env: {
      AGENT_INTERFACE_DATA_DIR: join(wrapperProbeDirectory, 'agent-data'),
      CLAUDE_CLI: wrapperProbe,
    },
  }] : []),
]

function runCheck(check) {
  const options = {
    encoding: 'utf8',
    env: {
      ...diagnosticEnvironment(check.envCommand || check.command),
      ...check.env,
    },
    timeout: 10_000,
    windowsHide: true,
  }
  if (!check.captureStdoutToFile) return spawnSync(check.command, check.args, options)

  // Claude Code caps help text written directly to a Node child-process pipe.
  // A regular file preserves the complete contract output on every platform.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'poise-doctor-'))
  const outputPath = join(temporaryDirectory, 'stdout')
  let outputDescriptor
  try {
    outputDescriptor = openSync(outputPath, 'w')
    const result = spawnSync(check.command, check.args, {
      ...options,
      stdio: ['ignore', outputDescriptor, 'pipe'],
    })
    closeSync(outputDescriptor)
    outputDescriptor = undefined
    return { ...result, stdout: readFileSync(outputPath, 'utf8') }
  } finally {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor)
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

for (const check of checks) {
  const result = runCheck(check)
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const missing = (check.requiredOutput || []).filter((capability) => !output.includes(capability))
  const validOutput = check.validateOutput ? check.validateOutput(result) : true
  if (result.status === 0 && missing.length === 0 && validOutput) {
    console.log(`ok  ${check.label}`)
    continue
  }
  failed = true
  const reason = result.status !== 0
    ? result.error?.code || result.signal || `exit ${result.status ?? 'unknown'}`
    : missing.length > 0
      ? `missing required capabilities: ${missing.join(', ')}`
      : check.validationFailure || 'output validation failed'
  console.error(`fail  ${check.label}: ${reason}`)
}

if (wrapperProbeDirectory) rmSync(wrapperProbeDirectory, { recursive: true, force: true })

const agentRoot = process.env.AGENT_INTERFACE_ROOT
  || join(homedir(), 'dev', 'caller', 'agent_interface')
if (existsSync(agentRoot) && statSync(agentRoot).isDirectory()) console.log(`ok  agent-interface root: ${agentRoot}`)
else {
  failed = true
  console.error(`fail  agent-interface root not found: ${agentRoot}`)
}

if (failed) process.exitCode = 1
