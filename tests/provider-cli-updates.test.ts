import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProviderCli, ensureProviderClis, runUpdateCommand, type Provider } from '../scripts/provider-cli-updates.mjs'
import { modelRefreshSummary } from '../src/model-refresh'

let root = ''
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-cli-update-'))
  await mkdir(join(root, 'bin'))
  for (const name of ['claude', 'codex', 'grok', 'agy', 'muse']) await writeFile(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  env = { HOME: root, PATH: join(root, 'bin'), ANTHROPIC_API_KEY: 'must-not-reach-updaters' }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function fakeRunner() {
  let version = '1.0.0'
  return vi.fn<typeof runUpdateCommand>(async (_command, args, options) => {
    if (args[0] !== '--version' || options.env.MUSE_SYNC_UPDATE === '1') version = '1.1.0'
    return { stdout: `Version: ${version}\n`, stderr: '' }
  })
}

describe('provider CLI maintenance', () => {
  it.each(['claude', 'codex', 'grok', 'antigravity', 'muse'] as Provider[])('updates %s before verifying the actual launcher again', async provider => {
    const run = fakeRunner()
    const result = await ensureProviderCli(provider, { root, env, run })
    expect(result).toMatchObject({ provider, status: 'updated', before: '1.0.0', after: '1.1.0' })
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[0][1]).toEqual(['--version'])
    const [, args, options] = run.mock.calls[1]
    expect(args).toEqual(provider === 'claude' ? ['install', 'latest'] : provider === 'muse' ? ['--version'] : ['update'])
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(options.cwd).toBe(root)
    if (provider === 'muse') expect(options.env).toMatchObject({ MUSE_SYNC_UPDATE: '1', MUSE_NO_AUTO_UPDATE: '0' })
    expect(run.mock.calls[2][1]).toEqual(['--version'])
  })
  it('coalesces overlapping launches, but checks again on the next launch', async () => {
    const run = fakeRunner()
    const a = ensureProviderCli('claude', { root, env, run })
    const b = ensureProviderCli('claude', { root, env, run })
    expect(a).toBe(b)
    await Promise.all([a, b]); expect(run).toHaveBeenCalledTimes(3)
    // A later launch gets a fresh check, not a time-to-live cache.
    await new Promise(resolve => setTimeout(resolve, 2))
    await ensureProviderCli('claude', { root, env, run })
    expect(run).toHaveBeenCalledTimes(6)
  })
  it('does not claim success when PATH still launches a different version', async () => {
    const run = vi.fn<typeof runUpdateCommand>(async (_command, args) => ({ stdout: args[0] === 'install' ? 'Version: 1.2.0' : '1.0.0', stderr: '' }))
    expect(await ensureProviderCli('claude', { root, env, run })).toMatchObject({ status: 'unavailable', after: '1.0.0', error: expect.stringContaining('duplicate CLI installations') })
  })
  it('settles a failed update and allows retry instead of keeping a pending promise', async () => {
    const run = fakeRunner()
    run.mockImplementationOnce(async () => ({ stdout: '1.0.0', stderr: '' })).mockRejectedValueOnce(new Error('download unavailable'))
    expect(await ensureProviderCli('grok', { root, env, run })).toMatchObject({ status: 'unavailable', before: '1.0.0', error: 'download unavailable' })
    expect(await ensureProviderCli('grok', { root, env, run })).toMatchObject({ status: 'updated', after: '1.1.0' })
  })
  it('reports a missing provider without installing another provider or launching a model', async () => {
    await rm(join(root, 'bin', 'muse'))
    const run = fakeRunner()
    const report = await ensureProviderClis({ root, env, run })
    expect(report.muse).toMatchObject({ status: 'unavailable', error: expect.stringContaining('not installed') })
    expect(report.claude.status).not.toBe('unavailable')
    expect(run.mock.calls.every(([, args]) => !args.includes('--print') && !args.includes('exec'))).toBe(true)
  })
  it('bounds an updater that never finishes without leaving its pipes open', async () => {
    await expect(runUpdateCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, cwd: root, timeoutMs: 50 })).rejects.toThrow(/timed out/)
  })
})

describe('truthful model-check feedback', () => {
  it('does not report nothing new after a quota-limited provider check', () => {
    const report = { changed: false, families: { claude: { status: 'unavailable', error: JSON.stringify({ result: 'Weekly limit reached', session_id: 'not-user-facing' }) }, codex: { status: 'ok' } } }
    const result = modelRefreshSummary(report)
    expect(result.level).toBe('error'); expect(result.text).toContain('Weekly limit reached')
    expect(result.text).not.toContain('nothing new'); expect(result.text).not.toContain('session_id')
  })
  it('does not mistake a successful old-CLI probe for a verified latest version', () => {
    const result = modelRefreshSummary({ changed: false, families: { claude: { status: 'ok' } }, cli_updates: { claude: { status: 'unavailable', error: 'update download timed out' } } })
    expect(result).toMatchObject({ level: 'error', text: expect.stringContaining('download timed out') })
    expect(result.text).not.toContain('nothing new')
  })
  it('separates CLI changes from model changes and rejects an empty report', () => {
    expect(modelRefreshSummary({})).toMatchObject({ level: 'error' })
    expect(modelRefreshSummary({ changed: true, families: { claude: { status: 'ok' } }, cli_updates: { claude: { status: 'updated', before: '2.1.274', after: '2.1.280' } } })).toMatchObject({ level: 'ok', text: expect.stringContaining('2.1.274 → 2.1.280') })
  })
})

it('persists only version evidence and excludes update output and credentials', async () => {
  await ensureProviderCli('claude', { root, env, run: fakeRunner() })
  const { readdir } = await import('node:fs/promises')
  const receipt = (await readdir(root)).find(name => name.endsWith('.json'))!
  const saved = await readFile(join(root, receipt), 'utf8')
  expect(saved).toContain('1.1.0'); expect(saved).not.toContain('must-not-reach-updaters')
})

it('updates the existing npm Codex prefix, including optional native packages', async () => {
  const { symlink, realpath } = await import('node:fs/promises')
  const prefix = join(root, 'custom-prefix')
  const bin = join(prefix, 'lib/node_modules/@openai/codex/bin')
  await mkdir(bin, { recursive: true }); await writeFile(join(bin, 'codex.js'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await rm(join(root, 'bin/codex')); await symlink(join(bin, 'codex.js'), join(root, 'bin/codex'))
  await writeFile(join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const run = fakeRunner()
  expect((await ensureProviderCli('codex', { root, env, run })).status).toBe('updated')
  expect(run.mock.calls[1][1]).toEqual(['install', '--global', '--prefix', await realpath(prefix), '--include=optional', '--prefer-online', '@openai/codex@latest'])
})
it('detects Muse release changes even when the reported semantic version is unchanged', async () => {
  const state = join(root, 'bin/.muse-version')
  await writeFile(state, '1.3.0-R3401.1')
  const run = vi.fn<typeof runUpdateCommand>(async (_command, _args, options) => {
    if (options.env.MUSE_SYNC_UPDATE === '1') await writeFile(state, '1.3.0-R3402.1')
    return { stdout: 'Muse Code 1.3.0', stderr: '' }
  })
  expect(await ensureProviderCli('muse', { root, env, run })).toMatchObject({ status: 'updated', before: '1.3.0-R3401.1', after: '1.3.0-R3402.1' })
})
