import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readJson, writeJsonAtomic } from '../scripts/self-update/atomic.mjs'
import {
  adoptInitialRelease, bootstrapReport, configure, ensureBridgeKey, initializeRoot, installControllerCopy, setEnabled,
} from '../scripts/self-update/bootstrap.mjs'
import { LaunchError, resolveLaunch } from '../scripts/self-update/launch.mjs'
import { layout } from '../scripts/self-update/paths.mjs'
import { createReleaseManager, newReleaseId, readManifest, releaseIsComplete } from '../scripts/self-update/releases.mjs'
import { openStore } from '../scripts/self-update/store.mjs'

const SHA = '1'.repeat(40)
const OTHER = '2'.repeat(40)
let root

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-su-rel-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** A git fake that "clones" by creating the directory, and a runner fake that "builds" by writing the bundle. */
function fakes({ buildFails = false, buildDirties = false, moveHead = false } = {}) {
  const calls = []
  const git = {
    async clone({ dest, sha }) {
      calls.push(['clone', dest, sha])
      await mkdir(dest, { recursive: true })
      await writeFile(join(dest, 'package.json'), '{}')
      return sha
    },
    async revParse(cwd) {
      calls.push(['rev-parse', cwd])
      return moveHead ? OTHER : SHA
    },
    async dirtyFiles() {
      return buildDirties ? ' M src/x.ts' : ''
    },
  }
  const runner = {
    async run(command, args, options) {
      calls.push([command, ...args, options.cwd, options.env.POISE_RELEASE_SHA ?? null])
      expect(options.env).not.toHaveProperty('GH_TOKEN')
      expect(options.env).not.toHaveProperty('GITHUB_TOKEN')
      expect(options.stdoutFile).toMatch(/\/logs\/releases\//)
      if (args[0] === 'ci') {
        expect(args).toContain('--include=dev')
        expect(options.env.NODE_ENV).not.toBe('production')
        return { code: 0 }
      }
      if (buildFails) throw new Error('build exploded')
      await mkdir(join(options.cwd, 'dist'), { recursive: true })
      await writeFile(join(options.cwd, 'dist', 'server.js'), 'export const startProductionServer = () => {}\n')
      return { code: 0 }
    },
  }
  return { calls, git, runner }
}

function manager(overrides = {}, fakeOptions = {}) {
  const { calls, git, runner } = fakes(fakeOptions)
  const paths = layout(root)
  const releases = createReleaseManager({
    releasesDir: paths.releasesDir, logsDir: paths.logsDir, git, runner, callerSha: 'c'.repeat(40),
    baseEnv: { HOME: root, GH_TOKEN: 'leak', GITHUB_TOKEN: 'leak' }, now: () => new Date('2026-09-19T10:00:00Z'), ...overrides,
  })
  return { calls, releases, paths }
}

describe('release ids', () => {
  it('are sortable timestamps plus the commit prefix', () => {
    expect(newReleaseId(SHA, new Date('2026-09-19T10:15:30.123Z'))).toBe('20260919T101530Z-111111111111')
  })
})

describe('release manager', () => {
  it('stages a release in a hidden directory, builds with the exact SHA, then renames it into place', async () => {
    const { calls, releases, paths } = manager()
    const id = newReleaseId(SHA)
    const manifest = await releases.stage({ id, sha: SHA })
    expect(manifest).toMatchObject({ id, sha: SHA, callerSha: 'c'.repeat(40), root: join(paths.releasesDir, id), createdAt: '2026-09-19T10:00:00.000Z' })
    expect(await readManifest(manifest.root)).toMatchObject({ id, sha: SHA })
    expect(await releaseIsComplete(manifest.root, { id, sha: SHA })).toBe(true)
    expect(await releases.isComplete(manifest)).toBe(true)
    const staging = join(paths.releasesDir, `.${id}.staging`)
    expect(calls[0]).toEqual(['clone', staging, SHA])
    const npmCi = calls.find((call) => call[0] === 'npm' && call[1] === 'ci')
    const build = calls.find((call) => call[0] === 'npm' && call[1] === 'run')
    expect(npmCi.at(-2)).toBe(staging)
    expect(npmCi.at(-1)).toBeNull()
    expect(build.at(-1)).toBe(SHA)
    expect((await readdir(paths.releasesDir)).filter((name) => name.startsWith('.'))).toEqual([])
    expect(((await stat(paths.releasesDir)).mode & 0o777)).toBe(0o700)
  })

  it('is idempotent for a complete release and refuses to reuse an id for a different SHA', async () => {
    const { calls, releases } = manager()
    const id = newReleaseId(SHA)
    await releases.stage({ id, sha: SHA })
    const before = calls.length
    await releases.stage({ id, sha: SHA })
    expect(calls.length).toBe(before)
    await expect(releases.stage({ id, sha: OTHER })).rejects.toThrow(/already exists/)
    await expect(releases.stage({ id: '../x', sha: SHA })).rejects.toThrow(/invalid release id/)
    await expect(releases.stage({ id, sha: 'nope' })).rejects.toThrow(/invalid release sha/)
  })

  it('discards the staging directory when the build fails and never touches an active directory', async () => {
    const { releases, paths } = manager({}, { buildFails: true })
    const id = newReleaseId(SHA)
    await expect(releases.stage({ id, sha: SHA })).rejects.toThrow(/build exploded/)
    expect(await readdir(paths.releasesDir)).toEqual([])
  })

  it('keeps staging intact while a worker group cannot be verified as settled', async () => {
    const fixture = fakes()
    const original = fixture.runner.run
    fixture.runner.run = async (command, args, options) => {
      if (args[0] === 'ci') throw Object.assign(new Error('unsettled worker'), { result: { settled: false } })
      return original(command, args, options)
    }
    const { releases, paths } = manager({ git: fixture.git, runner: fixture.runner })
    const id = newReleaseId(SHA)
    await expect(releases.stage({ id, sha: SHA })).rejects.toThrow('unsettled worker')
    expect((await stat(join(paths.releasesDir, `.${id}.staging`))).isDirectory()).toBe(true)
  })

  it('rejects a checkout that moved or was modified during the build', async () => {
    const moved = manager({}, { moveHead: true })
    await expect(moved.releases.stage({ id: newReleaseId(SHA), sha: SHA })).rejects.toThrow(/moved to/)
    const dirty = manager({}, { buildDirties: true })
    await expect(dirty.releases.stage({ id: newReleaseId(SHA), sha: SHA })).rejects.toThrow(/modified during build/)
    expect(await readdir(layout(root).releasesDir)).toEqual([])
  })

  it('refuses to rebuild in place over a release directory that lost its bundle', async () => {
    const { releases } = manager()
    const id = newReleaseId(SHA)
    const manifest = await releases.stage({ id, sha: SHA })
    await rm(join(manifest.root, 'dist'), { recursive: true })
    await expect(releases.stage({ id, sha: SHA })).rejects.toThrow(/without a bundle/)
    expect(await releaseIsComplete(manifest.root, manifest)).toBe(false)
  })
})

describe('stable launcher', () => {
  it('resolves the active release only when pointer and manifest agree', async () => {
    const { releases } = manager()
    const id = newReleaseId(SHA)
    const manifest = await releases.stage({ id, sha: SHA })
    const store = await openStore(root)
    await expect(resolveLaunch(root)).rejects.toBeInstanceOf(LaunchError)
    await store.writeActivePointer({ id, sha: SHA, root: manifest.root, previousId: null })
    const launch = await resolveLaunch(root)
    expect(launch).toMatchObject({ releaseId: id, sha: SHA, root: manifest.root, bundle: join(manifest.root, 'dist', 'server.js') })
    expect(launch.env).toEqual({ POISE_RELEASE_ID: id, POISE_RELEASE_SHA: SHA, POISE_RELEASE_ROOT: manifest.root })
    // A pointer that names a directory holding a different release is refused.
    await store.writeActivePointer({ id: 'other-id', sha: SHA, root: manifest.root, previousId: null })
    await expect(resolveLaunch(root)).rejects.toThrow(/pointer expects other-id/)
    await store.writeActivePointer({ id, sha: SHA, root: join(root, 'nowhere'), previousId: null })
    await expect(resolveLaunch(root)).rejects.toThrow(/no release manifest/)
  })

  it('exits with EX_CONFIG when run without a pointer instead of guessing', async () => {
    const { execFile } = await import('node:child_process')
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [join(process.cwd(), 'scripts', 'self-update', 'launch.mjs')], {
        env: { ...process.env, POISE_SELF_UPDATE_ROOT: root },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    })
    expect(result.code).toBe(78)
    expect(result.stderr).toMatch(/cannot launch release/)
  })
})

describe('bootstrap helpers', () => {
  it('initialises a private root, config, bridge key and controller copy without enabling anything', async () => {
    const paths = await initializeRoot(root)
    for (const dir of [root, paths.releasesDir, paths.workspacesDir, paths.logsDir, paths.controllerDir]) {
      expect(((await stat(dir)).mode & 0o777), dir).toBe(0o700)
    }
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'ghp_' + 'a'.repeat(36), { mode: 0o600 })
    const config = await configure(root, { tokenFile, callerSha: 'c'.repeat(40) })
    expect(config).toMatchObject({ enabled: false, tokenFile, callerSha: 'c'.repeat(40), repository: 'mikkokotila/Poise' })
    await expect(configure(root, { repository: 'x/y' })).rejects.toThrow(/pinned/)
    const keyPath = await ensureBridgeKey(root)
    expect(keyPath).toBe(paths.bridgeKeyPath)
    expect(((await stat(keyPath)).mode & 0o777)).toBe(0o600)
    const key = (await readFile(keyPath, 'utf8')).trim()
    expect(key.length).toBeGreaterThanOrEqual(32)
    expect(await ensureBridgeKey(root)).toBe(keyPath)
    expect((await readFile(keyPath, 'utf8')).trim()).toBe(key)

    const copy = await installControllerCopy(root)
    const names = copy.files.map((file) => file.split('/').pop())
    for (const required of ['daemon.mjs', 'launch.mjs', 'controller.mjs', 'policy.mjs', 'cli.mjs', 'store.mjs']) {
      expect(names).toContain(required)
    }
    expect(await readFile(join(copy.directory, 'policy.mjs'), 'utf8')).toBe(await readFile(join(process.cwd(), 'scripts', 'self-update', 'policy.mjs'), 'utf8'))

    expect((await setEnabled(root, true)).enabled).toBe(true)
    expect((await setEnabled(root, false)).enabled).toBe(false)
    const report = await bootstrapReport(root)
    expect(report).toMatchObject({ configPresent: true, enabled: false, tokenFilePresent: true, bridgeKeyPresent: true, controllerInstalled: true, activeRelease: null })
  })

  it('adopts a first release once and records it as the active baseline', async () => {
    const { releases, paths } = manager()
    const release = await adoptInitialRelease(root, { sha: SHA, stage: ({ id, sha }) => releases.stage({ id, sha }) })
    expect(release).toMatchObject({ sha: SHA, callerSha: 'c'.repeat(40) })
    expect(await readJson(paths.activePointerPath)).toMatchObject({ id: release.id, sha: SHA, root: release.root, previousId: null })
    const store = await openStore(root)
    expect(store.state.releases[release.id]).toMatchObject({ id: release.id, sha: SHA, rejected: false })
    await expect(adoptInitialRelease(root, { sha: OTHER, stage: ({ id, sha }) => releases.stage({ id, sha }) })).rejects.toThrow(/already recorded/)
    expect((await bootstrapReport(root)).activeRelease).toMatchObject({ id: release.id })
    // A stage that returns an incomplete directory is not adopted.
    await rm(paths.activePointerPath)
    await mkdir(join(root, 'bogus'), { recursive: true })
    await writeJsonAtomic(join(root, 'bogus', 'release.json'), { id: 'bogus-id', sha: OTHER, root: join(root, 'bogus') })
    await expect(adoptInitialRelease(root, { sha: OTHER, stage: async () => ({ id: 'bogus-id', sha: OTHER, root: join(root, 'bogus') }) })).rejects.toThrow(/incomplete/)
  })
})
