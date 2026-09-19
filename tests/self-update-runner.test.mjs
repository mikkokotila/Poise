import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isBlockedName, scrubEnvironment } from '../scripts/self-update/environment.mjs'
import { createGit, parseRawDiff } from '../scripts/self-update/git.mjs'
import { SubprocessError, createRunner, reapWorkers } from '../scripts/self-update/runner.mjs'

const node = process.execPath
let root

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-su-runner-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('scrubbed subprocess environment', () => {
  it('forwards only an allowlist and never credentials or Node/npm/git injection variables', () => {
    const base = {
      HOME: '/home/u', PATH: '/evil/bin:/usr/bin', LANG: 'fi_FI.UTF-8', TMPDIR: '/tmp/x', USER: 'u',
      GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', POISE_RELEASE_TOKEN_FILE: '/t', NODE_OPTIONS: '--require evil',
      NODE_PATH: '/evil', NPM_CONFIG_REGISTRY: 'http://evil', npm_config_script_shell: '/evil', GIT_DIR: '/evil',
      GIT_CONFIG_PARAMETERS: 'x', ANTHROPIC_API_KEY: 'k', MY_SECRET: 's', AWS_PROFILE: 'p', SSH_AUTH_SOCK: '/s',
    }
    const env = scrubEnvironment({ base, nodeBin: '/opt/node/bin' })
    expect(env.HOME).toBe('/home/u')
    expect(env.LANG).toBe('fi_FI.UTF-8')
    expect(env.PATH.split(':')[0]).toBe('/opt/node/bin')
    expect(env.PATH).not.toContain('/evil')
    for (const name of Object.keys(base)) {
      if (['HOME', 'PATH', 'LANG', 'TMPDIR', 'USER'].includes(name)) continue
      expect(env, name).not.toHaveProperty(name)
    }
    expect(env.CI).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('refuses to forward blocked names even when asked explicitly', () => {
    expect(() => scrubEnvironment({ base: { HOME: '/h' }, extra: { GITHUB_TOKEN: 'x' } })).toThrow(/refusing to forward GITHUB_TOKEN/)
    expect(() => scrubEnvironment({ base: { HOME: '/h' }, extra: { NODE_OPTIONS: 'x' } })).toThrow(/refusing/)
    expect(() => scrubEnvironment({ base: { HOME: '/h' }, extra: { MY_PASSWORD: 'x' } })).toThrow(/refusing/)
    expect(scrubEnvironment({ base: { HOME: '/h' }, extra: { POISE_RELEASE_SHA: 'a'.repeat(40) } }).POISE_RELEASE_SHA).toBe('a'.repeat(40))
    expect(isBlockedName('POISE_RELEASE_TOKEN_FILE')).toBe(true)
    expect(isBlockedName('POISE_RELEASE_SHA')).toBe(false)
  })

  it('does not inherit production-only dependency installation or test behavior', () => {
    const env = scrubEnvironment({ base: { HOME: '/h', NODE_ENV: 'production', npm_config_omit: 'dev', npm_config_production: 'true' } })
    expect(env).not.toHaveProperty('NODE_ENV')
    expect(env).not.toHaveProperty('npm_config_omit')
    expect(env).not.toHaveProperty('npm_config_production')
  })

  it('requires HOME', () => {
    expect(() => scrubEnvironment({ base: {} })).toThrow(/HOME/)
  })
})

describe('bounded runner', () => {
  const env = () => scrubEnvironment({ base: { HOME: root, PATH: process.env.PATH } })

  it('captures stdout and stderr, tracks the worker and releases it', async () => {
    const registry = { registered: [], released: [], register(worker) { this.registered.push(worker) }, release(pid) { this.released.push(pid) } }
    const runner = createRunner({ workers: registry })
    const result = await runner.run(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], { env: env(), purpose: 'probe' })
    expect(result).toMatchObject({ code: 0, stdout: 'out', stderr: 'err', truncated: false, timedOut: false, purpose: 'probe' })
    expect(registry.registered[0]).toMatchObject({ pid: result.pid, purpose: 'probe' })
    expect(registry.released).toEqual([result.pid])
  })

  it('rejects non-zero exits with a summary unless allowed', async () => {
    const runner = createRunner()
    const error = await runner.run(node, ['-e', 'console.error("bad thing"); process.exit(3)'], { env: env() }).catch((caught) => caught)
    expect(error).toBeInstanceOf(SubprocessError)
    expect(error.message).toMatch(/exited 3/)
    expect(error.message).toMatch(/bad thing/)
    const tolerated = await runner.run(node, ['-e', 'process.exit(2)'], { env: env(), allowFailure: true })
    expect(tolerated.code).toBe(2)
  })

  it('kills a process that exceeds its time budget', async () => {
    const runner = createRunner()
    const started = Date.now()
    const error = await runner.run(node, ['-e', 'setTimeout(() => {}, 60_000)'], { env: env(), timeoutMs: 300 }).catch((caught) => caught)
    expect(error).toBeInstanceOf(SubprocessError)
    expect(error.result.timedOut).toBe(true)
    expect(error.message).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('bounds captured output while streaming the full output to log files', async () => {
    const runner = createRunner()
    const stdoutFile = join(root, 'logs', 'nested', 'out.log')
    const result = await runner.run(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { env: env(), maxOutputBytes: 1000, stdoutFile })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThan(1200)
    expect(result.stdout).toContain('[output truncated]')
    expect((await readFile(stdoutFile, 'utf8')).length).toBe(5000)
  })

  it('demands an explicit environment and reports spawn failures', async () => {
    const runner = createRunner()
    await expect(runner.run(node, ['-v'], {})).rejects.toThrow(/explicit environment/)
    await expect(runner.run('/definitely/not/a/binary', [], { env: env() })).rejects.toThrow()
  })

  it('keeps unidentified live groups and clears only proven-dead records', () => {
    const killed = []
    const original = process.kill
    process.kill = (pid, signal) => { killed.push([pid, signal]); return true }
    try {
      const reaped = reapWorkers({ 4242: { pid: 4242 }, 1: { pid: 1 }, bad: { pid: 'x' }, 5151: { pid: 5151 } }, { alive: (pid) => pid === 4242 })
      expect(reaped).toEqual([5151])
      expect(killed).toEqual([])
    } finally {
      process.kill = original
    }
  })
})

describe('git adapter against real repositories', () => {
  function sh(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim()
  }

  async function seedRepository() {
    const upstream = join(root, 'upstream')
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', upstream])
    const work = join(root, 'seed')
    execFileSync('git', ['clone', '--quiet', upstream, work])
    await writeFile(join(work, 'README.md'), 'hello\n')
    sh(work, 'add', '.')
    sh(work, 'commit', '--quiet', '-m', 'init')
    const base = sh(work, 'rev-parse', 'HEAD')
    sh(work, 'push', '--quiet', 'origin', 'HEAD:main')
    return { upstream, work, base }
  }

  function adapter(url) {
    const runner = createRunner()
    return createGit({ runner, url, baseEnv: { HOME: root, PATH: process.env.PATH } })
  }

  it('clones an exact commit onto a branch and inspects it', async () => {
    const { upstream, work, base } = await seedRepository()
    const git = adapter(upstream)
    const dest = join(root, 'ws')
    expect(await git.clone({ dest, sha: base, branch: 'poise/change-1' })).toBe(base)
    expect(await git.currentBranch(dest)).toBe('poise/change-1')
    expect(await git.revParse(dest, 'HEAD')).toBe(base)
    expect(await git.dirtyFiles(dest)).toBe('')
    expect(await git.treeSha(dest, base)).toMatch(/^[0-9a-f]{40}$/)

    // The agent edits and commits inside the workspace.
    await writeFile(join(dest, 'src.ts'), 'export const a = 1\n')
    await writeFile(join(dest, 'README.md'), 'changed\n')
    expect(await git.dirtyFiles(dest)).toContain('README.md')
    sh(dest, 'add', '.')
    sh(dest, 'commit', '--quiet', '-m', 'change')
    const head = sh(dest, 'rev-parse', 'HEAD')
    expect(await git.isAncestor(dest, base, head)).toBe(true)
    expect(await git.isAncestor(dest, head, base)).toBe(false)
    const entries = await git.changedEntries(dest, base, head)
    expect(entries).toEqual([
      { status: 'M', oldMode: '100644', newMode: '100644', path: 'README.md' },
      { status: 'A', oldMode: '000000', newMode: '100644', path: 'src.ts' },
    ])

    // Publishing exactly the head, then observing the remote ref.
    expect(await git.remoteRef({ branch: 'poise/change-1' })).toBeNull()
    await expect(git.push({ cwd: dest, sha: head, branch: 'poise/change-1', token: null })).rejects.toThrow(/release token/)
    await git.push({ cwd: dest, sha: head, branch: 'poise/change-1', token: 'ghp_' + 'x'.repeat(36) })
    expect(await git.remoteRef({ branch: 'poise/change-1' })).toBe(head)
    // The token travels as an HTTP header, which a file:// remote ignores; it
    // must not have been written into the checkout's configuration.
    expect(sh(dest, 'config', '--list')).not.toContain('extraheader')
    expect(sh(work, 'ls-remote', upstream, 'refs/heads/poise/change-1')).toContain(head)
    await expect(git.clone({ dest: join(root, 'ws2'), sha: 'f'.repeat(40) })).rejects.toThrow()
  })

  it('reverts a merge commit and reports conflicts without leaving the checkout dirty', async () => {
    const { upstream, work, base } = await seedRepository()
    // A feature branch merged into main with --no-ff, so main has a merge commit.
    sh(work, 'checkout', '--quiet', '-b', 'feature')
    await writeFile(join(work, 'feature.txt'), 'feature\n')
    sh(work, 'add', '.')
    sh(work, 'commit', '--quiet', '-m', 'feature')
    sh(work, 'checkout', '--quiet', 'main')
    sh(work, 'merge', '--quiet', '--no-ff', '--no-edit', 'feature')
    const merge = sh(work, 'rev-parse', 'HEAD')
    sh(work, 'push', '--quiet', 'origin', 'HEAD:main')
    const git = adapter(upstream)
    const dest = join(root, 'revert')
    await git.clone({ dest, sha: merge, branch: 'poise/revert-1' })
    const outcome = await git.revertMerge(dest, merge)
    expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.isAncestor(dest, merge, outcome.sha)).toBe(true)
    expect(sh(dest, 'ls-files')).not.toContain('feature.txt')

    // A conflicting revert: main changed the same file after the merge.
    await writeFile(join(work, 'feature.txt'), 'edited after merge\n')
    sh(work, 'add', '.')
    sh(work, 'commit', '--quiet', '-m', 'edit')
    const later = sh(work, 'rev-parse', 'HEAD')
    sh(work, 'push', '--quiet', 'origin', 'HEAD:main')
    const conflicted = join(root, 'revert2')
    await git.clone({ dest: conflicted, sha: later, branch: 'poise/revert-2' })
    const result = await git.revertMerge(conflicted, merge)
    expect(result.conflict).toBe(true)
    expect(await git.dirtyFiles(conflicted)).toBe('')
    expect(await git.revParse(conflicted, 'HEAD')).toBe(later)
    expect(base).toMatch(/^[0-9a-f]{40}$/)
  })

  it('parses raw diff-tree output including renames', () => {
    const raw = [':100644 100644 aaaa bbbb M', 'src/a.ts', ':000000 100644 0000 cccc A', 'src/b.ts', ':100644 100644 dddd dddd R100', 'old.ts', 'new.ts', ''].join('\0')
    expect(parseRawDiff(raw)).toEqual([
      { status: 'M', oldMode: '100644', newMode: '100644', path: 'src/a.ts' },
      { status: 'A', oldMode: '000000', newMode: '100644', path: 'src/b.ts' },
      { status: 'R', oldMode: '100644', newMode: '100644', oldPath: 'old.ts', path: 'new.ts' },
    ])
    expect(parseRawDiff('')).toEqual([])
  })
})
