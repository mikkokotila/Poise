#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Claude settings can inject provider credentials after the parent process
// environment has been scrubbed. This command-line settings overlay takes
// precedence over ordinary settings on Poise-owned Claude launches while
// preserving unrelated user settings, hooks, and project instructions.
const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_WORKSPACE_ID',
  'CCR_OAUTH_TOKEN_FILE',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLOUD_ML_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_CONFIG_FILE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CONFIG_DIR',
]

const SAFE_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SHELL_PREFIX',
  'AGENT_INTERFACE_BASH_ALLOW',
]

const LOGIN_ENV = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
]

const wrapperPath = fileURLToPath(import.meta.url)
const SETTINGS_MAX_BYTES = 1024 * 1024

function settingsRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseSettings(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) throw new Error('missing settings value')
  let source = trimmed
  if (!trimmed.startsWith('{')) {
    const metadata = statSync(trimmed)
    if (!metadata.isFile() || metadata.size > SETTINGS_MAX_BYTES) {
      throw new Error('settings file is invalid')
    }
    source = readFileSync(trimmed, 'utf8')
  }
  const parsed = settingsRecord(JSON.parse(source))
  if (!parsed) throw new Error('settings must be an object')
  return parsed
}

function mergeSettings(base, incoming) {
  const baseEnvironment = settingsRecord(base.env) || {}
  const incomingEnvironment = settingsRecord(incoming.env) || {}
  return {
    ...base,
    ...incoming,
    env: { ...baseEnvironment, ...incomingEnvironment },
  }
}

function extractSettings(commandArgs, preserveFinalArgument = false) {
  const remaining = []
  let forwarded = {}
  const settingsBoundary = preserveFinalArgument
    ? Math.max(0, commandArgs.length - 1)
    : commandArgs.length
  for (let index = 0; index < settingsBoundary; index += 1) {
    const value = commandArgs[index]
    if (value === '--settings') {
      if (index + 1 >= settingsBoundary) throw new Error('missing settings value')
      forwarded = mergeSettings(forwarded, parseSettings(commandArgs[index + 1]))
      index += 1
    } else if (value.startsWith('--settings=')) {
      forwarded = mergeSettings(forwarded, parseSettings(value.slice('--settings='.length)))
    } else {
      remaining.push(value)
    }
  }
  if (preserveFinalArgument && commandArgs.length > 0) {
    if (remaining.at(-1) !== '--') remaining.push('--')
    remaining.push(commandArgs.at(-1))
  }
  return { args: remaining, settings: forwarded }
}

let command
try {
  const rawArgs = process.argv.slice(2)
  // Poise's print-mode callers place the raw user/model prompt last. Never
  // reinterpret that positional value as a trusted command option.
  const printMode = rawArgs.includes('--print') || rawArgs.includes('-p')
  const promptIsStdin = rawArgs.at(-2) === '--system-prompt'
  const hasPositionalPrompt = printMode && !promptIsStdin
  command = extractSettings(rawArgs, hasPositionalPrompt)
} catch {
  console.error('[poise] Invalid Claude settings; launch blocked.')
  process.exit(64)
}
const args = command.args
const subscriptionLogin = args.length === 3
  && args[0] === 'auth'
  && args[1] === 'login'
  && args[2] === '--claudeai'
const inheritedEnv = subscriptionLogin ? [...SAFE_ENV, ...LOGIN_ENV] : SAFE_ENV
const env = Object.fromEntries(inheritedEnv
  .filter((key) => process.env[key] !== undefined)
  .map((key) => [key, process.env[key]]))
env.CLAUDE_CLI = wrapperPath
env.CLAUDE_CODE_MAX_RETRIES = '0'
env.CLAUDE_CODE_RETRY_WATCHDOG = ''

const modelIndex = args.indexOf('--model')
const retryProtected = modelIndex >= 0 && args[modelIndex + 1] !== 'haiku'
const failureMarker = join(tmpdir(), `poise-claude-failure-${process.ppid}`)
const FAILURE_TTL_MS = 30_000

function recentFailure() {
  try {
    if (Date.now() - statSync(failureMarker).mtimeMs <= FAILURE_TTL_MS) return true
    rmSync(failureMarker, { force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return false
}

function markFailure() {
  try {
    const descriptor = openSync(failureMarker, 'wx', 0o600)
    closeSync(descriptor)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

if (retryProtected && recentFailure()) {
  console.error('[poise] Repeated Claude launch blocked after a recent failure.')
  process.exit(75)
}

// Anthropic CLI profiles are a separate credential store from Claude Code's
// Claude.ai login. Point only that profile store at a fresh empty directory;
// HOME and CLAUDE_CONFIG_DIR remain intact so macOS Keychain and Linux/WSL
// .credentials.json subscription login continue to work normally.
const anthropicConfigDirectory = mkdtempSync(join(tmpdir(), 'poise-anthropic-profile-'))
chmodSync(anthropicConfigDirectory, 0o700)
env.ANTHROPIC_CONFIG_DIR = anthropicConfigDirectory

const forwardedEnvironment = { ...(settingsRecord(command.settings.env) || {}) }
for (const key of [
  ...PROVIDER_ENV,
  'AGENT_INTERFACE_BASH_ALLOW',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CLAUDE_CLI',
]) delete forwardedEnvironment[key]

// Consume every caller-supplied --settings argument and emit exactly one
// merged object. Security-controlled fields are written last so a later
// duplicate option cannot bypass subscription isolation.
const settings = JSON.stringify({
  ...command.settings,
  apiKeyHelper: '',
  awsAuthRefresh: '',
  awsCredentialExport: '',
  env: {
    ...forwardedEnvironment,
    ...Object.fromEntries(PROVIDER_ENV.map((key) => [key, ''])),
    ANTHROPIC_CONFIG_DIR: anthropicConfigDirectory,
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_RETRY_WATCHDOG: '',
    CLAUDE_CLI: wrapperPath,
    ...(env.CLAUDE_CODE_SHELL_PREFIX
      ? { CLAUDE_CODE_SHELL_PREFIX: env.CLAUDE_CODE_SHELL_PREFIX }
      : {}),
    ...(env.AGENT_INTERFACE_BASH_ALLOW
      ? { AGENT_INTERFACE_BASH_ALLOW: env.AGENT_INTERFACE_BASH_ALLOW }
      : {}),
  },
})

const modelInvocation = args.includes('--print')
  || args.includes('-p')
  || args.some((value) => value.startsWith('--print='))

function subscriptionReady() {
  const result = spawnSync(
    'claude',
    ['--settings', settings, 'auth', 'status', '--json'],
    {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  if (result.error || result.signal || result.status !== 0) return false
  try {
    const status = JSON.parse(result.stdout || '{}')
    return status?.loggedIn === true
      && status?.authMethod === 'claude.ai'
      && status?.apiProvider === 'firstParty'
  } catch {
    return false
  }
}

let exitCode = 1
try {
  if (modelInvocation && !subscriptionReady()) {
    if (retryProtected) markFailure()
    console.error('[poise] Claude subscription preflight failed; model launch blocked.')
    exitCode = 77
  } else {
    const result = spawnSync('claude', ['--settings', settings, ...args], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    })

    if (result.error) {
      if (retryProtected) markFailure()
      console.error(`[poise] Claude subscription command failed: ${result.error.message}`)
      exitCode = 1
    } else {
      if (retryProtected) {
        if (result.status === 0) rmSync(failureMarker, { force: true })
        else markFailure()
      }
      exitCode = result.status ?? 1
    }
  }
} finally {
  rmSync(anthropicConfigDirectory, { recursive: true, force: true })
}
process.exit(exitCode)
