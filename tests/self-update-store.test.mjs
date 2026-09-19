import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireLock, appendLineDurable, assertPrivateFile, ensurePrivateDirectory, readJson, writeFileAtomic, writeJsonAtomic,
} from '../scripts/self-update/atomic.mjs'
import { assessEnablement, loadReleaseToken, normalizeConfig, readConfig, writeConfig } from '../scripts/self-update/config.mjs'
import { changeBranch, isReleaseId, isSha, isUuid, layout, selfUpdateRoot } from '../scripts/self-update/paths.mjs'
import { activeChange, emptyState, openStore, publicChange, validPointer } from '../scripts/self-update/store.mjs'

const SHA = 'a'.repeat(40)
let root

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-su-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('paths', () => {
  it('resolves the root from the environment or the home directory', () => {
    expect(selfUpdateRoot({ POISE_SELF_UPDATE_ROOT: '/x/y' }, '/home/u')).toBe('/x/y')
    expect(selfUpdateRoot({}, '/home/u')).toBe('/home/u/.poise/self-update')
    expect(selfUpdateRoot({ POISE_SELF_UPDATE_ROOT: '  ' }, '/home/u')).toBe('/home/u/.poise/self-update')
  })

  it('keeps every trusted file under the root and outside any release', () => {
    const paths = layout('/r')
    for (const value of Object.values(paths)) expect(value.startsWith('/r')).toBe(true)
    expect(paths.releasesDir).toBe('/r/releases')
    expect(paths.configPath).not.toContain('/releases/')
    expect(paths.journalPath).not.toContain('/releases/')
    expect(paths.controllerDir).not.toContain('/releases/')
  })

  it('validates identifiers strictly', () => {
    expect(isUuid('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(true)
    expect(isUuid('3B241101-E2BB-4255-8CAF-4136C566A962')).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isSha(SHA)).toBe(true)
    expect(isSha(SHA.toUpperCase())).toBe(false)
    expect(isReleaseId('20260919T100000Z-aaaaaaaaaaaa')).toBe(true)
    expect(isReleaseId('../etc')).toBe(false)
    expect(changeBranch('abc')).toBe('poise/change-abc')
  })
})

describe('atomic filesystem primitives', () => {
  it('writes files privately and atomically, leaving no temporary files behind', async () => {
    const path = join(root, 'doc.json')
    await writeJsonAtomic(path, { a: 1 })
    expect(await readJson(path)).toEqual({ a: 1 })
    expect(((await stat(path)).mode & 0o777)).toBe(0o600)
    await writeFileAtomic(path, 'plain')
    expect(await readFile(path, 'utf8')).toBe('plain')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns the fallback for missing JSON and throws on malformed JSON', async () => {
    expect(await readJson(join(root, 'missing.json'), 'fallback')).toBe('fallback')
    await writeFile(join(root, 'bad.json'), '{not json')
    await expect(readJson(join(root, 'bad.json'))).rejects.toThrow()
  })

  it('appends durable journal lines', async () => {
    const path = join(root, 'journal.ndjson')
    await appendLineDurable(path, '{"a":1}')
    await appendLineDurable(path, '{"a":2}')
    expect((await readFile(path, 'utf8')).trim().split('\n')).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('forces directories to 0700', async () => {
    const dir = join(root, 'private')
    await ensurePrivateDirectory(dir)
    await chmod(dir, 0o755)
    await ensurePrivateDirectory(dir)
    expect(((await stat(dir)).mode & 0o777)).toBe(0o700)
  })

  it('accepts only owner-only regular files as private', async () => {
    const path = join(root, 'secret')
    await writeFile(path, 'x', { mode: 0o600 })
    await expect(assertPrivateFile(path)).resolves.toBeTruthy()
    await chmod(path, 0o644)
    await expect(assertPrivateFile(path, 'token')).rejects.toThrow(/owner only/)
    await expect(assertPrivateFile(join(root, 'nope'), 'token')).rejects.toThrow(/does not exist/)
    await expect(assertPrivateFile(root, 'dir')).rejects.toThrow(/regular file/)
    await chmod(path, 0o600)
    await expect(assertPrivateFile(path, 'token', { uid: 424242 })).rejects.toThrow(/owned by the current user/)
  })
})

describe('controller lock', () => {
  it('is exclusive while the holder is alive and reclaimable when it is not', async () => {
    const path = join(root, 'controller.lock')
    const first = await acquireLock(path, { pid: 1001, alive: () => true })
    await expect(acquireLock(path, { pid: 1002, alive: () => true })).rejects.toMatchObject({ code: 'LOCKED' })
    // The holder died: the next controller reclaims the lock.
    const second = await acquireLock(path, { pid: 1003, alive: () => false })
    expect((await readJson(path)).pid).toBe(1003)
    // Releasing a lock we no longer own leaves the current holder's file alone.
    await first.release()
    expect((await readJson(path)).pid).toBe(1003)
    await second.release()
    expect(await readJson(path, null)).toBeNull()
  })
})

describe('store', () => {
  it('starts empty, commits atomically and journals each commit', async () => {
    const store = await openStore(root, { now: () => '2026-09-19T10:00:00.000Z' })
    expect(store.state).toEqual(emptyState())
    const result = await store.commit('test.event', (draft) => {
      draft.hold = { changeId: 'c', sha: SHA, reason: 'r' }
      return 'value'
    }, { detail: 1 })
    expect(result).toBe('value')
    expect(store.state.hold.reason).toBe('r')
    const reopened = await openStore(root)
    expect(reopened.state.hold).toEqual({ changeId: 'c', sha: SHA, reason: 'r' })
    const journal = (await readFile(layout(root).journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(journal).toEqual([{ at: '2026-09-19T10:00:00.000Z', event: 'test.event', detail: 1 }])
  })

  it('does not persist a mutation that throws and keeps later commits ordered', async () => {
    const store = await openStore(root)
    await expect(store.commit('bad', () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(store.state.hold).toBeNull()
    const results = await Promise.all([1, 2, 3].map((n) => store.commit('n', (draft) => { draft.rejectedShas.push(String(n)); return n })))
    expect(results).toEqual([1, 2, 3])
    expect(store.state.rejectedShas).toEqual(['1', '2', '3'])
  })

  it('refuses a state document from an unknown schema version', async () => {
    await writeJsonAtomic(layout(root).statePath, { version: 99 })
    await expect(openStore(root)).rejects.toThrow(/unsupported/)
  })

  it('reads and writes the active pointer, ignoring invalid documents', async () => {
    const store = await openStore(root)
    expect(await store.readActivePointer()).toBeNull()
    await expect(store.writeActivePointer({ id: 'r1', sha: 'short', root: '/x' })).rejects.toThrow(/invalid/)
    await store.writeActivePointer({ id: 'r1', sha: SHA, root: '/releases/r1', previousId: null })
    expect(await store.readActivePointer()).toMatchObject({ id: 'r1', sha: SHA, root: '/releases/r1' })
    await writeJsonAtomic(layout(root).activePointerPath, { id: 'r1' })
    expect(await store.readActivePointer()).toBeNull()
    expect(validPointer({ id: 'r', sha: SHA, root: 'relative' })).toBe(false)
  })

  it('finds the single in-flight change and strips internals from the public DTO', () => {
    const state = emptyState()
    state.changes.a = { id: 'a', state: 'live', createdAt: '1' }
    state.changes.b = { id: 'b', state: 'awaiting_ci', createdAt: '2', workspace: '/w', check: {}, deploy: {}, finish: {}, sourceSessionId: 's', prepared: true }
    expect(activeChange(state).id).toBe('b')
    const dto = publicChange(state.changes.b, false)
    expect(dto).toEqual({ id: 'b', state: 'awaiting_ci', createdAt: '2', canRevert: false })
    expect(publicChange(state.changes.a, true).canRevert).toBe(true)
  })
})

describe('config', () => {
  it('pins the repository and branch and rejects anything else', () => {
    expect(() => normalizeConfig({ repository: 'someone/else' }, root)).toThrow(/pinned to mikkokotila\/Poise/)
    expect(() => normalizeConfig({ branch: 'develop' }, root)).toThrow(/pinned to branch main/)
    expect(() => normalizeConfig({ tokenFile: 'relative/path' }, root)).toThrow(/absolute path/)
    expect(() => normalizeConfig({ recoveryPort: 70_000 }, root)).toThrow(/TCP port/)
    expect(() => normalizeConfig({ callerSha: 'nope' }, root)).toThrow(/callerSha/)
    const config = normalizeConfig({ enabled: 'yes' }, root)
    expect(config).toMatchObject({ enabled: false, repository: 'mikkokotila/Poise', branch: 'main', productionPort: 5555, recoveryPort: 5556 })
    expect(config.tokenFile).toBe(join(root, 'release-token'))
  })

  it('treats a missing config as disabled and not bootstrapped', async () => {
    const { present, config } = await readConfig(root)
    expect(present).toBe(false)
    expect(config.enabled).toBe(false)
    expect(await assessEnablement(root, {})).toMatchObject({ enabled: false, reason: 'self-update is not bootstrapped' })
  })

  it('requires an explicit enable and a private token file', async () => {
    await writeConfig(root, { enabled: false })
    expect((await assessEnablement(root, {})).reason).toMatch(/disabled in config/)
    await writeConfig(root, { enabled: true })
    expect((await assessEnablement(root, {})).reason).toMatch(/release token unavailable/)
    const tokenFile = join(root, 'release-token')
    await writeFile(tokenFile, 'github_pat_11ABCDEFG0123456789abcdefghijklmnop\n', { mode: 0o644 })
    expect((await assessEnablement(root, {})).reason).toMatch(/owner only/)
    await chmod(tokenFile, 0o600)
    expect(await assessEnablement(root, {})).toMatchObject({ enabled: true, reason: null })
    expect(await loadReleaseToken(tokenFile)).toBe('github_pat_11ABCDEFG0123456789abcdefghijklmnop')
  })

  it('never reads GH_TOKEN or GITHUB_TOKEN as the release token', async () => {
    await writeConfig(root, { enabled: true })
    const env = { GH_TOKEN: 'ghp_' + 'x'.repeat(36), GITHUB_TOKEN: 'ghp_' + 'y'.repeat(36) }
    expect((await assessEnablement(root, env)).enabled).toBe(false)
  })

  it('rejects token files without a token and honours POISE_RELEASE_TOKEN_FILE', async () => {
    const tokenFile = join(root, 'other-token')
    await writeFile(tokenFile, 'not a token!\n', { mode: 0o600 })
    await expect(loadReleaseToken(tokenFile)).rejects.toThrow(/does not contain a GitHub token/)
    await writeFile(tokenFile, 'ghp_' + 'z'.repeat(36), { mode: 0o600 })
    await writeConfig(root, { enabled: true })
    expect(await assessEnablement(root, { POISE_RELEASE_TOKEN_FILE: tokenFile })).toMatchObject({ enabled: true })
    const { config } = await readConfig(root, { POISE_RELEASE_TOKEN_FILE: tokenFile })
    expect(config.tokenFile).toBe(tokenFile)
  })

  it('reports an invalid config as disabled with the reason', async () => {
    await writeFile(layout(root).configPath, JSON.stringify({ repository: 'evil/repo', enabled: true }))
    const result = await assessEnablement(root, {})
    expect(result.enabled).toBe(false)
    expect(result.reason).toMatch(/invalid.*pinned/)
  })
})
