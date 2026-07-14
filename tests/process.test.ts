import { describe, expect, it } from 'vitest'
import { link, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PROCESS_ARG_BYTES,
  assertProcessArgSize,
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
