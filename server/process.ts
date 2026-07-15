import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const MAX_PROCESS_ARG_BYTES = 64 * 1024
export const CLAUDE_SUBSCRIPTION_CLI = fileURLToPath(new URL(
  '../scripts/claude-subscription.mjs',
  import.meta.url,
))

export function assertProcessArgSize(value: string, label = 'argument'): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROCESS_ARG_BYTES) {
    throw new Error(`${label} too large (max ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes)`)
  }
}

function assertProcessArgs(args: readonly string[]): void {
  args.forEach((value, index) => assertProcessArgSize(value, `argument ${index + 1}`))
}

export interface RunFileOptions {
  cwd?: string
  /** Variables overlaid on the scrubbed parent environment. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  killSignal?: NodeJS.Signals
  signal?: AbortSignal
}

export interface RunFileResult {
  stdout: string
  stderr: string
}

// Start from a small, exact base rather than trying to recognize every secret
// spelling. Paths/locales needed to launch a CLI survive; application,
// credential, URL/URI, JWT, AUTH, loader-injection, and proxy variables do not.
const SAFE_BASE_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Known non-secret integration paths used by agent-interface.
  'AGENT_INTERFACE_ROOT',
  'AGENT_INTERFACE_DATA_DIR',
])

const NETWORK_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]

// A Claude subscription is resolved from Claude Code's own credential store
// (the macOS Keychain on macOS). Explicit provider credentials can override
// that account and route work through metered API billing, so subscription-
// backed calls remove every such override at the process boundary and force
// the monitored wrapper, which also neutralizes provider settings loaded by
// Claude Code itself.
export function claudeSubscriptionEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    throw new Error('Claude subscription isolation requires macOS, Linux, or WSL')
  }
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
  }
}

const GITHUB_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  ...NETWORK_ENV,
]

const MODEL_ENV = [
  // Non-secret agent-interface controls. These preserve configured wrapper
  // binaries, debate recursion, and Claude's command guard rather than
  // silently falling back to raw provider executables.
  'AGENT_INTERFACE_CLI',
  'AGENT_INTERFACE_BASH_ALLOW',
  'CLAUDE_CLI',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CODEX_CLI',
  'CURSOR_AGENT_CLI',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CURSOR_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'XAI_BASE_URL',
  // Model backends can use cloud workload credentials and config.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CONFIG_DIR',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  ...NETWORK_ENV,
]

// Direct Claude Code invocations need their configured credential location,
// command guard, and network route, but never inherit provider credentials.
// Callers additionally pass claudeSubscriptionEnvironment() to make that
// subscription-only intent explicit and resilient to future allowlist edits.
const CLAUDE_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SHELL_PREFIX',
  ...NETWORK_ENV,
]

// Browser launchers on Linux and WSL rely on these non-secret desktop/session
// coordinates. Keep them out of ordinary status/model workers and inherit them
// only for Poise's exact Claude.ai login command.
const CLAUDE_LOGIN_ENV = new Set([
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
])

// Credentials are inherited only by the binaries that intentionally consume
// them. A caller can still pass a one-off value explicitly through options.env.
const COMMAND_ENV = new Map<string, ReadonlySet<string>>([
  ['gh', new Set(GITHUB_ENV)],
  ['github-interface', new Set(GITHUB_ENV)],
  ['agent-interface', new Set([...GITHUB_ENV, ...MODEL_ENV])],
  ['claude', new Set(CLAUDE_ENV)],
  ['claude-subscription', new Set(CLAUDE_ENV)],
  ['claude-subscription.mjs', new Set(CLAUDE_ENV)],
])

function commandName(command: string): string {
  return basename(command).replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase()
}

function isClaudeSubscriptionLogin(command: string, args: readonly string[]): boolean {
  const name = commandName(command)
  return (name === 'claude-subscription' || name === 'claude-subscription.mjs')
    && args.length === 3
    && args[0] === 'auth'
    && args[1] === 'login'
    && args[2] === '--claudeai'
}

function childEnvironment(
  command: string,
  overrides: NodeJS.ProcessEnv = {},
  args: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const commandEnv = COMMAND_ENV.get(commandName(command))
  const loginEnvironment = isClaudeSubscriptionLogin(command, args)
    ? CLAUDE_LOGIN_ENV
    : undefined
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase()
    if (
      SAFE_BASE_ENV.has(normalized)
      || commandEnv?.has(normalized)
      || loginEnvironment?.has(normalized)
    ) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    // Avoid case-variant duplicates on Windows and make an explicit undefined
    // reliably remove an inherited variable on every platform.
    for (const inheritedKey of Object.keys(env)) {
      if (inheritedKey.toUpperCase() === key.toUpperCase()) delete env[inheritedKey]
    }
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function abortError(signal: AbortSignal, killSignal: NodeJS.Signals): Error {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return Object.assign(error, {
    code: 'ABORT_ERR',
    killed: true,
    signal: killSignal,
  })
}

async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid
  if (!pid) return

  if (process.platform !== 'win32') {
    // runFile children are process-group leaders. Negative pid targets the
    // complete group, including grandchildren that inherited it.
    try { process.kill(-pid, signal) }
    catch {
      // The group may have exited between the deadline and this call. A direct
      // kill is a safe fallback if group creation or lookup failed.
      try { child.kill(signal) } catch { /* already gone */ }
    }
    return
  }

  // Windows has no process-group signal equivalent. taskkill /T walks the
  // descendant tree; /F is the only dependable hard-deadline behavior.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(fallback)
      resolve()
    }
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      env: childEnvironment('taskkill.exe'),
      stdio: 'ignore',
      windowsHide: true,
    })
    const fallback = setTimeout(finish, 2_000)
    killer.once('error', finish)
    killer.once('close', finish)
  })
  try { child.kill(signal) } catch { /* taskkill already reaped it */ }
}

// Run a short-lived CLI with production-safe bounds. spawn keeps argv separate
// from the shell. POSIX children lead an isolated process group so timeout,
// abort, and output-limit termination includes their complete descendant tree.
export function runFile(
  command: string,
  args: readonly string[],
  options: RunFileOptions = {},
): Promise<RunFileResult> {
  assertProcessArgs(args)
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('timeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new Error('maxOutputBytes must be a positive integer')
  }
  const killSignal = options.killSignal ?? 'SIGKILL'
  if (options.signal?.aborted) {
    return Promise.reject(Object.assign(abortError(options.signal, killSignal), {
      stdout: '',
      stderr: '',
    }))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: childEnvironment(command, options.env, args),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalError: Error | undefined
    let termination: Promise<void> | undefined
    let finishing = false

    const requestTermination = (error: Error) => {
      if (terminalError || finishing) return
      terminalError = error
      termination = terminateProcessTree(child, killSignal)
    }

    const collect = (stream: 'stdout' | 'stderr', value: Buffer | string) => {
      if (terminalError || finishing) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = maxBuffer - used
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        if (stream === 'stdout') stdoutBytes = maxBuffer
        else stderrBytes = maxBuffer
        requestTermination(Object.assign(
          new Error(`${stream} maxBuffer length exceeded`),
          {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
            signal: killSignal,
          },
        ))
        return
      }
      chunks.push(chunk)
      if (stream === 'stdout') stdoutBytes += chunk.byteLength
      else stderrBytes += chunk.byteLength
    }

    const cleanup = () => {
      clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finishing) return
      finishing = true
      cleanup()
      await termination
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8')
      if (terminalError) {
        Object.assign(terminalError, { stdout, stderr })
        reject(terminalError)
        return
      }
      if (code !== 0) {
        const error = Object.assign(
          new Error(`Command failed (${code ?? signal ?? 'unknown'}): ${command}`),
          {
            code,
            killed: false,
            signal,
            stdout,
            stderr,
          },
        )
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    }

    const onAbort = () => requestTermination(abortError(options.signal!, killSignal))
    child.stdout?.on('data', (chunk) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk) => collect('stderr', chunk))
    child.stdout?.on('error', requestTermination)
    child.stderr?.on('error', requestTermination)
    child.once('error', (error) => {
      if (child.pid) {
        requestTermination(error)
        return
      }
      terminalError = error
      void finish(null, null)
    })
    child.once('close', (code, signal) => { void finish(code, signal) })

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const timeoutHandle = setTimeout(() => {
      requestTermination(Object.assign(
        new Error(`Command timed out after ${timeout}ms: ${command}`),
        { code: null, killed: true, signal: killSignal },
      ))
    }, timeout)
  })
}

export interface DetachedSpawnOptions {
  cwd?: string
  /** Variables overlaid on the scrubbed parent environment. */
  env?: NodeJS.ProcessEnv
  /** Observe termination after a successful spawn (including late failure). */
  onExit?: (result: DetachedProcessExit) => void | Promise<void>
}

export interface DetachedProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

// Resolve only after the OS accepted the launch. In particular, ENOENT and
// invalid cwd errors are observed and rejected instead of becoming an
// unhandled ChildProcess error that can terminate the Poise server.
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: DetachedSpawnOptions = {},
): Promise<void> {
  assertProcessArgs(args)
  return new Promise((resolve, reject) => {
    let launched = false
    let exitReported = false
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: childEnvironment(command, options.env),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    const reportExit = (result: DetachedProcessExit) => {
      if (!launched || exitReported || !options.onExit) return
      exitReported = true
      try {
        void Promise.resolve(options.onExit(result)).catch((error: unknown) => {
          console.error('[process] detached exit callback failed:', error)
        })
      } catch (error) {
        console.error('[process] detached exit callback failed:', error)
      }
    }

    child.on('error', (error) => {
      if (!launched) reject(error)
      else reportExit({ code: null, signal: null, error })
    })
    child.once('spawn', () => {
      launched = true
      child.unref()
      resolve()
    })
    child.once('exit', (code, signal) => reportExit({ code, signal }))
  })
}
