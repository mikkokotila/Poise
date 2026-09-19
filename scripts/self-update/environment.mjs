// The environment handed to git, npm and the build. Built from an allowlist
// rather than by deleting known-bad names: the release token, the operator's
// gh/GitHub credentials, NODE_OPTIONS/NODE_PATH preloads, npm config
// overrides and git hooks/config redirections must all be absent in a
// subprocess that runs candidate code, and an allowlist cannot forget one.
import { dirname } from 'node:path'

const PASSTHROUGH = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM']

// Never forwarded even when a caller asks for them explicitly.
const BLOCKED_PATTERNS = [
  /^GH_/, /^GITHUB_/, /^GIT_/, /^NODE_OPTIONS$/, /^NODE_PATH$/, /^NODE_EXTRA_CA_CERTS$/, /^NODE_REPL_/,
  /^NPM_CONFIG_/i, /^npm_/, /^POISE_RELEASE_TOKEN/, /^AWS_/, /^ANTHROPIC_/, /^OPENAI_/, /^CLAUDE/,
  /^YARN_/, /^PNPM_/, /^SSH_AUTH_SOCK$/, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i,
]

export const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function isBlockedName(name) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Build a subprocess environment. `nodeBin` (a directory) goes first on PATH
 * so npm and node resolve to the install the controller was configured with,
 * not whatever launchd or a shell happened to provide. `extra` adds explicit
 * non-secret values such as POISE_RELEASE_SHA for a release build.
 */
export function scrubEnvironment({ base = process.env, nodeBin = null, extra = {} } = {}) {
  const env = {}
  for (const name of PASSTHROUGH) {
    if (typeof base[name] === 'string' && base[name]) env[name] = base[name]
  }
  if (!env.HOME) throw new Error('HOME is required to build a subprocess environment')
  if (!env.TMPDIR) env.TMPDIR = '/tmp'
  env.LANG ||= 'en_US.UTF-8'
  const nodeDir = nodeBin || dirname(process.execPath)
  env.PATH = [nodeDir, ...SYSTEM_PATH].filter((entry, index, all) => all.indexOf(entry) === index).join(':')
  env.CI = '1'
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  // These processes install, test and build; the production service sets
  // NODE_ENV separately. Inheriting production here omits the build tools
  // and changes the semantics of the test run.
  env.npm_config_update_notifier = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_audit = 'false'
  env.npm_config_progress = 'false'
  // Never block on a credential prompt; a missing credential is a failure.
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  for (const [name, value] of Object.entries(extra)) {
    if (isBlockedName(name)) throw new Error(`refusing to forward ${name} to a subprocess`)
    if (typeof value === 'string') env[name] = value
  }
  return env
}
