import { describe, expect, it } from 'vitest'
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  CLAUDE_SUBSCRIPTION_CLI,
  MAX_PROCESS_ARG_BYTES,
  assertProcessArgSize,
  claudeSubscriptionEnvironment,
  runFile,
  spawnDetached,
} from '../server/process'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processExists(pid)
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('grandchild pid was not written')
}

function forkingParentSource(): string {
  const grandchild = 'setInterval(() => {}, 1_000)'
  return [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    'writeFileSync(process.argv[1], String(child.pid))',
    'setInterval(() => {}, 1_000)',
  ].join(';')
}

async function namedNode(root: string, name: string): Promise<string> {
  const path = join(root, name + (process.platform === 'win32' ? '.exe' : ''))
  if (process.platform === 'win32') await link(process.execPath, path)
  else await symlink(process.execPath, path)
  return path
}

describe('bounded process helpers', () => {
  it('passes arguments without shell interpretation', async () => {
    const value = 'literal $(touch should-not-run); `echo nope`'
    const { stdout } = await runFile(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', value],
    )

    expect(stdout).toBe(value)
  })

  it('terminates commands that exceed their deadline', async () => {
    const started = Date.now()

    await expect(runFile(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { timeoutMs: 50 },
    )).rejects.toMatchObject({ killed: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('aborts an active command during graceful shutdown', async () => {
    const controller = new AbortController()
    const running = runFile(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { timeoutMs: 30_000, signal: controller.signal },
    )
    controller.abort()

    await expect(running).rejects.toMatchObject({ code: 'ABORT_ERR' })
  })

  it('terminates grandchildren when a command exceeds its deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-process-tree-'))
    const pidFile = join(root, 'grandchild.pid')
    let grandchildPid = 0
    try {
      await expect(runFile(
        process.execPath,
        ['-e', forkingParentSource(), pidFile],
        { timeoutMs: 500 },
      )).rejects.toMatchObject({ killed: true })
      grandchildPid = await waitForPid(pidFile)
      expect(await waitForProcessExit(grandchildPid)).toBe(true)
    } finally {
      if (grandchildPid && processExists(grandchildPid)) {
        try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates grandchildren when an active command is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-process-tree-'))
    const pidFile = join(root, 'grandchild.pid')
    const controller = new AbortController()
    const running = runFile(
      process.execPath,
      ['-e', forkingParentSource(), pidFile],
      { timeoutMs: 30_000, signal: controller.signal },
    )
    let grandchildPid = 0
    try {
      grandchildPid = await waitForPid(pidFile)
      controller.abort()
      await expect(running).rejects.toMatchObject({ code: 'ABORT_ERR' })
      expect(await waitForProcessExit(grandchildPid)).toBe(true)
    } finally {
      controller.abort()
      await running.catch(() => undefined)
      if (grandchildPid && processExists(grandchildPid)) {
        try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects output beyond the configured cap', async () => {
    await expect(runFile(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4_096))"],
      { maxOutputBytes: 128 },
    )).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('preserves stderr on command failures', async () => {
    const error = await runFile(
      process.execPath,
      ['-e', "process.stderr.write('diagnostic'); process.exit(7)"],
    ).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ code: 7, stderr: 'diagnostic' })
  })

  it('uses command-scoped credentials, a safe base environment, and explicit overrides', async () => {
    const values: Record<string, string> = {
      CONFAB_API_KEY: 'must-not-leak',
      CONFAB_URL: 'https://user:password@confab.invalid',
      UNRELATED_DATABASE_PASSWORD: 'also-must-not-leak',
      INTERNAL_SIGNING_KEY: 'still-must-not-leak',
      SERVICE_URI: 'postgres://user:password@database.invalid/app',
      SESSION_JWT: 'header.payload.signature',
      CUSTOM_AUTH_HEADER: 'Bearer must-not-leak',
      SAFE_LOOKING_BUT_UNLISTED: 'allowlists-block-this-too',
      AGENT_INTERFACE_DATA_DIR: '/tmp/poise-agent-data',
      AGENT_INTERFACE_CLI: '/opt/poise/agent-interface-wrapper',
      AGENT_INTERFACE_BASH_ALLOW: '["git status"]',
      CLAUDE_CLI: '/opt/poise/claude-wrapper',
      CLAUDE_CODE_SHELL_PREFIX: '/opt/poise/bash-guard',
      CODEX_CLI: '/opt/poise/codex-wrapper',
      CURSOR_AGENT_CLI: '/opt/poise/cursor-wrapper',
      GH_TOKEN: 'inherited-gh-token',
      OPENAI_API_KEY: 'inherited-model-key',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.invalid',
    }
    const originals = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    const root = await mkdtemp(join(tmpdir(), 'poise-env-scope-'))
    const probe = "process.stdout.write(JSON.stringify({ confab: process.env.CONFAB_API_KEY, confabUrl: process.env.CONFAB_URL, password: process.env.UNRELATED_DATABASE_PASSWORD, signing: process.env.INTERNAL_SIGNING_KEY, uri: process.env.SERVICE_URI, jwt: process.env.SESSION_JWT, auth: process.env.CUSTOM_AUTH_HEADER, unlisted: process.env.SAFE_LOOKING_BUT_UNLISTED, agentData: process.env.AGENT_INTERFACE_DATA_DIR, agentCli: process.env.AGENT_INTERFACE_CLI, bashAllow: process.env.AGENT_INTERFACE_BASH_ALLOW, claudeCli: process.env.CLAUDE_CLI, shellPrefix: process.env.CLAUDE_CODE_SHELL_PREFIX, codexCli: process.env.CODEX_CLI, cursorCli: process.env.CURSOR_AGENT_CLI, gh: process.env.GH_TOKEN, model: process.env.OPENAI_API_KEY, proxy: process.env.HTTPS_PROXY, explicit: process.env.EXPLICIT_PASSWORD, hasPath: !!process.env.PATH }))"
    try {
      const unrelated = await runFile(process.execPath, ['-e', probe], {
        env: { EXPLICIT_PASSWORD: 'deliberate-override' },
      })
      expect(JSON.parse(unrelated.stdout)).toEqual({
        agentData: '/tmp/poise-agent-data',
        explicit: 'deliberate-override',
        hasPath: true,
      })

      const githubCli = await namedNode(root, 'github-interface')
      const github = await runFile(githubCli, ['-e', probe])
      expect(JSON.parse(github.stdout)).toEqual({
        agentData: '/tmp/poise-agent-data',
        gh: 'inherited-gh-token',
        proxy: 'https://proxy-user:proxy-password@proxy.invalid',
        hasPath: true,
      })

      const agentCli = await namedNode(root, 'agent-interface')
      const agent = await runFile(agentCli, ['-e', probe])
      expect(JSON.parse(agent.stdout)).toEqual({
        agentData: '/tmp/poise-agent-data',
        agentCli: '/opt/poise/agent-interface-wrapper',
        bashAllow: '["git status"]',
        claudeCli: '/opt/poise/claude-wrapper',
        shellPrefix: '/opt/poise/bash-guard',
        codexCli: '/opt/poise/codex-wrapper',
        cursorCli: '/opt/poise/cursor-wrapper',
        gh: 'inherited-gh-token',
        model: 'inherited-model-key',
        proxy: 'https://proxy-user:proxy-password@proxy.invalid',
        hasPath: true,
      })
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('defines an explicit Claude subscription-only environment', () => {
    if (process.platform === 'win32') {
      expect(() => claudeSubscriptionEnvironment())
        .toThrow('Claude subscription isolation requires macOS, Linux, or WSL')
      return
    }
    expect(claudeSubscriptionEnvironment()).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
    })
  })

  it('runs direct Claude with local config but without billing credentials or shell interpretation', async () => {
    if (process.platform === 'win32') return
    const values: Record<string, string> = {
      ANTHROPIC_API_KEY: 'metered-api-key',
      ANTHROPIC_AUTH_TOKEN: 'metered-auth-token',
      ANTHROPIC_BASE_URL: 'https://metered-provider.invalid',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: metered',
      CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token',
      AWS_ACCESS_KEY_ID: 'cloud-access-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/provider-credentials.json',
      AZURE_CLIENT_SECRET: 'cloud-client-secret',
      FUTURE_PROVIDER_API_KEY: 'future-provider-key',
      CLAUDE_CONFIG_DIR: '/tmp/poise-claude-config',
      CLAUDE_CODE_SHELL_PREFIX: '/opt/poise/bash-guard',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.invalid',
      INTERNAL_SIGNING_KEY: 'must-not-leak',
    }
    const originals = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    const root = await mkdtemp(join(tmpdir(), 'poise-claude-env-'))
    const literal = 'literal $(touch should-not-run); `echo nope`'
    const probe = "process.stdout.write(JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN, baseUrl: process.env.ANTHROPIC_BASE_URL, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, configDir: process.env.CLAUDE_CONFIG_DIR, shellPrefix: process.env.CLAUDE_CODE_SHELL_PREFIX, proxy: process.env.HTTPS_PROXY, signing: process.env.INTERNAL_SIGNING_KEY, literal: process.argv[1] }))"
    try {
      const claudeCli = await namedNode(root, 'claude')
      const result = await runFile(claudeCli, ['-e', probe, literal], {
        env: claudeSubscriptionEnvironment(),
      })

      expect(JSON.parse(result.stdout)).toEqual({
        configDir: '/tmp/poise-claude-config',
        shellPrefix: '/opt/poise/bash-guard',
        proxy: 'https://proxy-user:proxy-password@proxy.invalid',
        literal,
      })
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forces the monitored Claude binary without dropping other model integrations', async () => {
    if (process.platform === 'win32') return
    const values: Record<string, string> = {
      ANTHROPIC_API_KEY: 'metered-api-key',
      ANTHROPIC_AUTH_TOKEN: 'metered-auth-token',
      ANTHROPIC_BASE_URL: 'https://metered-provider.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token',
      CLAUDE_CONFIG_DIR: '/tmp/poise-claude-config',
      CLAUDE_CLI: '/opt/poise/claude-wrapper',
      OPENAI_API_KEY: 'other-model-key',
    }
    const originals = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    const root = await mkdtemp(join(tmpdir(), 'poise-agent-subscription-env-'))
    const probe = "process.stdout.write(JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN, baseUrl: process.env.ANTHROPIC_BASE_URL, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, configDir: process.env.CLAUDE_CONFIG_DIR, claudeCli: process.env.CLAUDE_CLI, openai: process.env.OPENAI_API_KEY }))"
    try {
      const agentCli = await namedNode(root, 'agent-interface')
      const result = await runFile(agentCli, ['-e', probe], {
        env: claudeSubscriptionEnvironment(),
      })

      expect(JSON.parse(result.stdout)).toEqual({
        configDir: '/tmp/poise-claude-config',
        claudeCli: CLAUDE_SUBSCRIPTION_CLI,
        openai: 'other-model-key',
      })
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('neutralizes provider settings and environment overrides in the Claude wrapper', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'poise-claude-wrapper-'))
    const rawClaude = join(root, 'claude')
    const callLog = join(root, 'calls')
    const probe = `#!/usr/bin/env node
const { appendFileSync, statSync } = require('node:fs')
const args = process.argv.slice(2)
const authStatus = args.includes('auth') && args.includes('status')
appendFileSync(${JSON.stringify(callLog)}, authStatus ? 'status\\n' : 'model\\n')
const observed = {
  args,
  apiKey: process.env.ANTHROPIC_API_KEY,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  customHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS,
  anthropicConfigDir: process.env.ANTHROPIC_CONFIG_DIR,
  anthropicConfigMode: (statSync(process.env.ANTHROPIC_CONFIG_DIR).mode & 0o777).toString(8),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  profile: process.env.ANTHROPIC_PROFILE,
  identityToken: process.env.ANTHROPIC_IDENTITY_TOKEN,
  identityTokenFile: process.env.ANTHROPIC_IDENTITY_TOKEN_FILE,
  unixSocket: process.env.ANTHROPIC_UNIX_SOCKET,
  gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  ccrTokenFile: process.env.CCR_OAUTH_TOKEN_FILE,
  aws: process.env.AWS_ACCESS_KEY_ID,
  google: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  azure: process.env.AZURE_CLIENT_SECRET,
  future: process.env.FUTURE_PROVIDER_API_KEY,
  providerManaged: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  maxRetries: process.env.CLAUDE_CODE_MAX_RETRIES,
  retryWatchdog: process.env.CLAUDE_CODE_RETRY_WATCHDOG,
  claudeCli: process.env.CLAUDE_CLI,
  shellPrefix: process.env.CLAUDE_CODE_SHELL_PREFIX,
  bashAllow: process.env.AGENT_INTERFACE_BASH_ALLOW,
}
if (authStatus) Object.assign(observed, {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
})
process.stdout.write(JSON.stringify(observed))
`
    try {
      await writeFile(rawClaude, probe, { mode: 0o700 })
      const options = {
        env: {
          PATH: `${root}${delimiter}${process.env.PATH || ''}`,
          ANTHROPIC_API_KEY: 'metered-api-key',
          ANTHROPIC_AUTH_TOKEN: 'metered-auth-token',
          ANTHROPIC_BASE_URL: 'https://metered-provider.invalid',
          ANTHROPIC_CONFIG_DIR: '/tmp/poisoned-anthropic-profile',
          ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: metered',
          ANTHROPIC_PROFILE: 'metered-profile',
          ANTHROPIC_IDENTITY_TOKEN: 'metered-identity-token',
          ANTHROPIC_IDENTITY_TOKEN_FILE: '/tmp/metered-identity-token',
          ANTHROPIC_UNIX_SOCKET: '/tmp/metered-provider.sock',
          CLAUDE_CODE_USE_GATEWAY: '1',
          CCR_OAUTH_TOKEN_FILE: '/tmp/metered-oauth-token',
          AWS_ACCESS_KEY_ID: 'cloud-access-key',
          GOOGLE_APPLICATION_CREDENTIALS: '/tmp/provider-credentials.json',
          AZURE_CLIENT_SECRET: 'cloud-client-secret',
          FUTURE_PROVIDER_API_KEY: 'future-provider-key',
          CLAUDE_CONFIG_DIR: '/tmp/poise-claude-config',
          CLAUDE_CLI: '/opt/alternate-claude',
          CLAUDE_CODE_SHELL_PREFIX: '/opt/poise/bash-guard',
          AGENT_INTERFACE_BASH_ALLOW: '["git status"]',
        },
      }
      const firstSettings = JSON.stringify({
        hooks: { SessionStart: [] },
        env: {
          ANTHROPIC_API_KEY: 'settings-api-key',
          FORWARDED_SETTING_ONE: 'preserved-one',
        },
      })
      const secondSettings = JSON.stringify({
        permissions: { allow: ['Bash(git status)'] },
        env: { FORWARDED_SETTING_TWO: 'preserved-two' },
      })
      const result = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        [
          `--settings=${firstSettings}`,
          '--settings',
          secondSettings,
          '--print',
          'literal prompt',
        ],
        options,
      )
      const observed = JSON.parse(result.stdout)
      const settings = JSON.parse(observed.args[1])
      expect((await readFile(callLog, 'utf8')).trim().split('\n')).toEqual(['status', 'model'])
      expect(observed).toMatchObject({
        args: ['--settings', expect.any(String), '--print', '--', 'literal prompt'],
        anthropicConfigDir: expect.stringContaining('poise-anthropic-profile-'),
        anthropicConfigMode: '700',
        claudeConfigDir: '/tmp/poise-claude-config',
      })
      expect(observed).not.toHaveProperty('apiKey')
      expect(observed).not.toHaveProperty('authToken')
      expect(observed).not.toHaveProperty('baseUrl')
      expect(observed).not.toHaveProperty('customHeaders')
      expect(observed).not.toHaveProperty('profile')
      expect(observed).not.toHaveProperty('identityToken')
      expect(observed).not.toHaveProperty('identityTokenFile')
      expect(observed).not.toHaveProperty('unixSocket')
      expect(observed).not.toHaveProperty('gateway')
      expect(observed).not.toHaveProperty('ccrTokenFile')
      expect(observed).not.toHaveProperty('aws')
      expect(observed).not.toHaveProperty('google')
      expect(observed).not.toHaveProperty('azure')
      expect(observed).not.toHaveProperty('future')
      expect(observed).not.toHaveProperty('providerManaged')
      expect(observed).toMatchObject({
        maxRetries: '0',
        retryWatchdog: '',
        claudeCli: CLAUDE_SUBSCRIPTION_CLI,
        shellPrefix: '/opt/poise/bash-guard',
        bashAllow: '["git status"]',
      })
      expect(settings).toMatchObject({
        hooks: { SessionStart: [] },
        permissions: { allow: ['Bash(git status)'] },
        apiKeyHelper: '',
        awsAuthRefresh: '',
        awsCredentialExport: '',
        env: {
          FORWARDED_SETTING_ONE: 'preserved-one',
          FORWARDED_SETTING_TWO: 'preserved-two',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_BASE_URL: '',
          ANTHROPIC_CONFIG_DIR: observed.anthropicConfigDir,
          ANTHROPIC_CUSTOM_HEADERS: '',
          ANTHROPIC_AWS_API_KEY: '',
          ANTHROPIC_AWS_AUTH: '',
          ANTHROPIC_FOUNDRY_AUTH_TOKEN: '',
          ANTHROPIC_FEDERATION_RULE_ID: '',
          ANTHROPIC_IDENTITY_TOKEN: '',
          ANTHROPIC_IDENTITY_TOKEN_FILE: '',
          ANTHROPIC_ORGANIZATION_ID: '',
          ANTHROPIC_PROFILE: '',
          ANTHROPIC_UNIX_SOCKET: '',
          CCR_OAUTH_TOKEN_FILE: '',
          CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
          CLAUDE_CODE_HOST_CREDS_FILE: '',
          CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: '',
          CLAUDE_CODE_USE_BEDROCK: '',
          CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
          CLAUDE_CODE_USE_GATEWAY: '',
          CLAUDE_CODE_USE_MANTLE: '',
          CLAUDE_CODE_USE_VERTEX: '',
          CLAUDE_CODE_MAX_RETRIES: '0',
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          CLAUDE_CODE_RETRY_WATCHDOG: '',
          CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
          CLAUDE_CODE_SHELL_PREFIX: '/opt/poise/bash-guard',
          AGENT_INTERFACE_BASH_ALLOW: '["git status"]',
        },
      })
      expect(observed.args.filter((value: string) => value === '--settings')).toHaveLength(1)
      await expect(stat(observed.anthropicConfigDir)).rejects.toMatchObject({ code: 'ENOENT' })

      for (const literalPrompt of [
        '--settings',
        '--settings={"hooks":{"SessionStart":[{"command":"untrusted"}]}}',
      ]) {
        const promptResult = await runFile(
          CLAUDE_SUBSCRIPTION_CLI,
          ['--print', literalPrompt],
          options,
        )
        const promptObserved = JSON.parse(promptResult.stdout)
        const promptSettings = JSON.parse(promptObserved.args[1])
        expect(promptObserved.args.at(-1)).toBe(literalPrompt)
        expect(promptObserved.args.at(-2)).toBe('--')
        expect(promptObserved.args.slice(0, -1)
          .filter((value: string) => value === '--settings'))
          .toHaveLength(1)
        expect(promptSettings).not.toHaveProperty('hooks')
      }

      const statusResult = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        ['auth', 'status', '--json'],
        options,
      )
      const statusObserved = JSON.parse(statusResult.stdout)
      expect(statusObserved).toMatchObject({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        anthropicConfigDir: expect.stringContaining('poise-anthropic-profile-'),
        anthropicConfigMode: '700',
        claudeConfigDir: '/tmp/poise-claude-config',
      })
      expect(statusObserved.anthropicConfigDir).not.toBe(observed.anthropicConfigDir)
      await expect(stat(statusObserved.anthropicConfigDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes desktop session coordinates only to the exact Claude.ai login command', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'poise-claude-login-env-'))
    const rawClaude = join(root, 'claude')
    const loginEnvironment: Record<string, string> = {
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/xauth',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'GNOME',
      DESKTOP_SESSION: 'gnome',
      WSL_DISTRO_NAME: 'Ubuntu',
      WSL_INTEROP: '/run/WSL/123_interop',
      BROWSER: 'must-not-be-inherited',
      SSH_AUTH_SOCK: '/tmp/must-not-be-inherited',
      SESSION_TOKEN: 'must-not-leak',
    }
    const originals = new Map(Object.keys(loginEnvironment)
      .map((key) => [key, process.env[key]]))
    const probe = `#!/usr/bin/env node
const args = process.argv.slice(2)
const observed = {
  display: process.env.DISPLAY,
  waylandDisplay: process.env.WAYLAND_DISPLAY,
  xauthority: process.env.XAUTHORITY,
  dbus: process.env.DBUS_SESSION_BUS_ADDRESS,
  sessionType: process.env.XDG_SESSION_TYPE,
  desktop: process.env.XDG_CURRENT_DESKTOP,
  desktopSession: process.env.DESKTOP_SESSION,
  wslDistro: process.env.WSL_DISTRO_NAME,
  wslInterop: process.env.WSL_INTEROP,
  browser: process.env.BROWSER,
  sshAuthSock: process.env.SSH_AUTH_SOCK,
  sessionToken: process.env.SESSION_TOKEN,
}
if (args.includes('auth') && args.includes('status')) Object.assign(observed, {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
})
process.stdout.write(JSON.stringify(observed))
`
    try {
      await writeFile(rawClaude, probe, { mode: 0o700 })
      Object.assign(process.env, loginEnvironment)
      const options = { env: { PATH: `${root}${delimiter}${process.env.PATH || ''}` } }

      const login = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        ['auth', 'login', '--claudeai'],
        options,
      )
      expect(JSON.parse(login.stdout)).toEqual({
        display: ':0',
        waylandDisplay: 'wayland-0',
        xauthority: '/run/user/1000/xauth',
        dbus: 'unix:path=/run/user/1000/bus',
        sessionType: 'wayland',
        desktop: 'GNOME',
        desktopSession: 'gnome',
        wslDistro: 'Ubuntu',
        wslInterop: '/run/WSL/123_interop',
      })

      const forcedEnvironment = {
        env: {
          ...options.env,
          ...loginEnvironment,
        },
      }
      const status = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        ['auth', 'status', '--json'],
        forcedEnvironment,
      )
      expect(JSON.parse(status.stdout)).toEqual({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      })
      const worker = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        ['--print', '--model', 'haiku', 'status probe'],
        forcedEnvironment,
      )
      expect(JSON.parse(worker.stdout)).toEqual({})
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed before a model call and never exposes rejected auth metadata', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'poise-claude-preflight-'))
    const rawClaude = join(root, 'claude')
    const modelMarker = join(root, 'model-launched')
    const profilePath = join(root, 'profile-path')
    const source = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('auth') && args.includes('status')) {
  writeFileSync(${JSON.stringify(profilePath)}, process.env.ANTHROPIC_CONFIG_DIR)
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'profile',
    apiProvider: 'firstParty',
    email: 'private@example.invalid',
    organization: 'private-organization',
    token: 'private-token',
  }))
  process.exit(0)
}
writeFileSync(${JSON.stringify(modelMarker)}, 'launched')
`
    try {
      await writeFile(rawClaude, source, { mode: 0o700 })
      const failure = await runFile(
        CLAUDE_SUBSCRIPTION_CLI,
        ['--model', 'haiku', '--print', 'blocked prompt'],
        { env: { PATH: `${root}${delimiter}${process.env.PATH || ''}` } },
      ).catch((error: unknown) => error)

      expect(failure).toMatchObject({
        code: 77,
        stdout: '',
        stderr: expect.stringContaining('subscription preflight failed'),
      })
      expect(JSON.stringify(failure)).not.toContain('private@example.invalid')
      expect(JSON.stringify(failure)).not.toContain('private-organization')
      expect(JSON.stringify(failure)).not.toContain('private-token')
      await expect(readFile(modelMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const isolatedProfilePath = await readFile(profilePath, 'utf8')
      await expect(stat(isolatedProfilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks repeated model attempts from one failed worker without another provider call', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'poise-claude-retry-breaker-'))
    const rawClaude = join(root, 'claude')
    const attempts = join(root, 'attempts')
    const failureMarker = join(tmpdir(), `poise-claude-failure-${process.pid}`)
    const source = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('auth') && args.includes('status')) {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
  }))
  process.exit(0)
}
appendFileSync(process.argv.at(-1), 'attempt\\n')
process.stderr.write('Provider Error: 502 Bad Gateway')
process.exit(1)
`
    try {
      await rm(failureMarker, { force: true })
      await writeFile(rawClaude, source, { mode: 0o700 })
      const options = { env: { PATH: `${root}${delimiter}${process.env.PATH || ''}` } }
      await expect(runFile(CLAUDE_SUBSCRIPTION_CLI, [
        '--model', 'opus', '--print', attempts,
      ], options)).rejects.toMatchObject({ code: 1 })
      await expect(runFile(CLAUDE_SUBSCRIPTION_CLI, [
        '--model', 'opus', '--print', attempts,
      ], options)).rejects.toMatchObject({
        code: 75,
        stderr: expect.stringContaining('Repeated Claude launch blocked'),
      })
      expect((await readFile(attempts, 'utf8')).trim().split('\n')).toHaveLength(1)
    } finally {
      await rm(failureMarker, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps a single process argument by UTF-8 bytes', () => {
    expect(MAX_PROCESS_ARG_BYTES).toBe(64 * 1024)
    expect(() => assertProcessArgSize('x'.repeat(MAX_PROCESS_ARG_BYTES), 'prompt')).not.toThrow()
    expect(() => assertProcessArgSize('€'.repeat(Math.floor(MAX_PROCESS_ARG_BYTES / 3) + 1), 'prompt'))
      .toThrow(`prompt too large (max ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes)`)
  })

  it('enforces the argument cap before run and detached process creation', () => {
    const oversized = 'x'.repeat(MAX_PROCESS_ARG_BYTES + 1)
    expect(() => runFile(process.execPath, [oversized]))
      .toThrow(`argument 1 too large (max ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes)`)
    expect(() => spawnDetached(process.execPath, [oversized]))
      .toThrow(`argument 1 too large (max ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes)`)
  })

  it('reports a missing detached executable without an uncaught error', async () => {
    await expect(spawnDetached(
      `poise-missing-binary-${process.pid}-${Date.now()}`,
      [],
    )).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('acknowledges a successfully detached launch', async () => {
    await expect(spawnDetached(process.execPath, ['-e', 'process.exit(0)']))
      .resolves.toBeUndefined()
  })

  it('reports a non-zero exit after a detached launch was accepted', async () => {
    let observeExit!: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
      observeExit = resolve
    })

    await spawnDetached(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(7), 25)'],
      { onExit: observeExit },
    )

    await expect(exited).resolves.toMatchObject({ code: 7, signal: null })
  })
})
