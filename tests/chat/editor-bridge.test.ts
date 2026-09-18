import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let root = ''
let checkout = ''
let outside = ''
let bridge: typeof import('../../server/chat/editor-bridge')
let editor: typeof import('../../server/editor')

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-editor-bridge-'))
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  checkout = join(root, 'repo')
  outside = join(root, 'outside')
  await mkdir(checkout)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.md'), 'outside the checkout\n')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(checkout, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  vi.resetModules()
  bridge = await import('../../server/chat/editor-bridge')
  editor = await import('../../server/editor')
})

afterAll(async () => {
  delete process.env.POISE_EDITOR_DIR
  delete process.env.POISE_DB
  delete process.env.POISE_LOCK_DIR
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

let docCounter = 0
async function seedDoc(content: string): Promise<string> {
  const slug = `doc-${++docCounter}`
  await editor.writeDoc(slug, content)
  return slug
}

const abs = (staged: { path: string }) => join(checkout, staged.path)
const exists = (path: string) => stat(path).then(() => true, () => false)

describe('staged Editor documents are owned by one session each', () => {
  it('gives two sessions on one document distinct copies under their own ids', async () => {
    const slug = await seedDoc('# One\n\nshared\n')
    const a = randomUUID()
    const b = randomUUID()
    const stagedA = await bridge.stageDocument(checkout, a, slug)
    const stagedB = await bridge.stageDocument(checkout, b, slug)
    expect(stagedA.path).toBe(`.poise-chat/docs/${a}/${slug}.md`)
    expect(stagedB.path).toBe(`.poise-chat/docs/${b}/${slug}.md`)
    expect(stagedA.path).not.toBe(stagedB.path)
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# One\n\nshared\n')
    expect(await readFile(abs(stagedB), 'utf8')).toBe('# One\n\nshared\n')
    expect(stagedA.baseVersion).toBe(stagedB.baseVersion)
  })

  it("keeps A's conflicting copy through B's creation, B's deletion and B's write-back", async () => {
    const slug = await seedDoc('# Two\n\noriginal\n')
    const a = randomUUID()
    const b = randomUUID()
    const stagedA = await bridge.stageDocument(checkout, a, slug)
    // The agent edits A's copy while the Editor moves on: A is in conflict.
    await writeFile(abs(stagedA), '# Two\n\nagent edit in A\n')
    await editor.writeDoc(slug, '# Two\n\nuser edit in the Editor\n')
    const conflict = await bridge.writeBackDocument(checkout, stagedA, a)
    expect(conflict.kind).toBe('conflict')
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')

    // B is created for the same document: it gets the Editor's content and A is untouched.
    const stagedB = await bridge.stageDocument(checkout, b, slug)
    expect(await readFile(abs(stagedB), 'utf8')).toBe('# Two\n\nuser edit in the Editor\n')
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')

    // B edits and writes back; A's copy is still A's.
    await writeFile(abs(stagedB), '# Two\n\nagent edit in B\n')
    const written = await bridge.writeBackDocument(checkout, stagedB, b)
    expect(written.kind).toBe('written-back')
    expect((await editor.readDoc(slug)).content).toBe('# Two\n\nagent edit in B\n')
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')

    // Deleting B removes only B's directory.
    await bridge.unstageDocument(checkout, b)
    expect(await exists(join(checkout, '.poise-chat', 'docs', b))).toBe(false)
    expect(await exists(abs(stagedA))).toBe(true)
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')

    // A is still a conflict, still preserved, after all of that.
    const still = await bridge.writeBackDocument(checkout, stagedA, a)
    expect(still.kind).toBe('conflict')
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')
    const refresh = await bridge.refreshDocument(checkout, stagedA)
    expect(refresh.kind).toBe('conflict')
    expect(await readFile(abs(stagedA), 'utf8')).toBe('# Two\n\nagent edit in A\n')
  })

  it('unstages one session without touching the other', async () => {
    const slug = await seedDoc('# Three\n')
    const a = randomUUID()
    const b = randomUUID()
    const stagedA = await bridge.stageDocument(checkout, a, slug)
    const stagedB = await bridge.stageDocument(checkout, b, slug)
    await bridge.unstageDocument(checkout, a)
    expect(await exists(abs(stagedA))).toBe(false)
    expect(await exists(join(checkout, '.poise-chat', 'docs', a))).toBe(false)
    expect(await readFile(abs(stagedB), 'utf8')).toBe('# Three\n')
    await bridge.unstageDocument(checkout, a) // idempotent
    expect(await exists(abs(stagedB))).toBe(true)
  })

  it('refuses a session id that is not a path-safe token', async () => {
    const slug = await seedDoc('# Bad id\n')
    await expect(bridge.stageDocument(checkout, '../escape', slug)).rejects.toThrow('invalid session id')
    await expect(bridge.stageDocument(checkout, randomUUID(), 'not a slug')).rejects.toThrow('invalid document slug')
  })
})

describe('forking a staged document', () => {
  it("copies the source's current copy into the fork's own stage with provenance and the source's version", async () => {
    const slug = await seedDoc('# Fork\n\nbase\n')
    const source = randomUUID()
    const fork = randomUUID()
    const stagedSource = await bridge.stageDocument(checkout, source, slug)
    await writeFile(abs(stagedSource), '# Fork\n\nedited in the source, not yet written back\n')
    const stagedFork = await bridge.forkStagedDocument(checkout, fork, slug, { sessionId: source, staged: stagedSource })
    expect(stagedFork.path).toBe(`.poise-chat/docs/${fork}/${slug}.md`)
    expect(stagedFork.path).not.toBe(stagedSource.path)
    expect(stagedFork.provenance).toEqual({ fromSession: source })
    expect(stagedFork.baseVersion).toBe(stagedSource.baseVersion)
    expect(stagedFork.stagedHash).toBe(stagedSource.stagedHash)
    expect(stagedFork.revision).toBe(0)
    expect(await readFile(abs(stagedFork), 'utf8')).toBe('# Fork\n\nedited in the source, not yet written back\n')
    // The pending edit is still an edit in the fork: it writes back as such,
    // and the source's copy is neither moved nor shared.
    const written = await bridge.writeBackDocument(checkout, stagedFork, fork)
    expect(written.kind).toBe('written-back')
    expect((await editor.readDoc(slug)).content).toBe('# Fork\n\nedited in the source, not yet written back\n')
    expect(await readFile(abs(stagedSource), 'utf8')).toBe('# Fork\n\nedited in the source, not yet written back\n')
    expect(stagedSource.baseVersion).not.toBe(stagedFork.baseVersion)
  })

  it("inherits the source's conflict rather than hiding it", async () => {
    const slug = await seedDoc('# Fork conflict\n\nbase\n')
    const source = randomUUID()
    const fork = randomUUID()
    const stagedSource = await bridge.stageDocument(checkout, source, slug)
    await writeFile(abs(stagedSource), '# Fork conflict\n\nagent\n')
    await editor.writeDoc(slug, '# Fork conflict\n\nuser\n')
    const stagedFork = await bridge.forkStagedDocument(checkout, fork, slug, { sessionId: source, staged: stagedSource })
    expect(await readFile(abs(stagedFork), 'utf8')).toBe('# Fork conflict\n\nagent\n')
    expect((await bridge.writeBackDocument(checkout, stagedFork, fork)).kind).toBe('conflict')
    expect((await bridge.refreshDocument(checkout, stagedFork)).kind).toBe('conflict')
    expect(await readFile(abs(stagedFork), 'utf8')).toBe('# Fork conflict\n\nagent\n')
    expect(await readFile(abs(stagedSource), 'utf8')).toBe('# Fork conflict\n\nagent\n')
  })

  it('stages the Editor document when the source has no copy on disk', async () => {
    const slug = await seedDoc('# Fork fresh\n')
    const source = randomUUID()
    const fork = randomUUID()
    const stagedSource = await bridge.stageDocument(checkout, source, slug)
    await rm(abs(stagedSource))
    const fromGone = await bridge.forkStagedDocument(checkout, fork, slug, { sessionId: source, staged: stagedSource })
    expect(fromGone.provenance).toBeUndefined()
    expect(await readFile(abs(fromGone), 'utf8')).toBe('# Fork fresh\n')
    const fromNone = await bridge.forkStagedDocument(checkout, randomUUID(), slug, { sessionId: source, staged: null })
    expect(fromNone.provenance).toBeUndefined()
    expect(await readFile(abs(fromNone), 'utf8')).toBe('# Fork fresh\n')
  })

  it("fails with the reason when the source's copy cannot be read", async () => {
    const slug = await seedDoc('# Fork unreadable\n')
    const source = randomUUID()
    const stagedSource = await bridge.stageDocument(checkout, source, slug)
    await rm(abs(stagedSource))
    await mkdir(abs(stagedSource))
    await expect(bridge.forkStagedDocument(checkout, randomUUID(), slug, { sessionId: source, staged: stagedSource })).rejects.toThrow(/could not be taken over.*not a regular file/)
    expect(await exists(abs(stagedSource))).toBe(true)
  })
})

describe('refresh and write-back', () => {
  it('reports a conflict when the Editor moved and the copy was touched, leaving the copy alone', async () => {
    const slug = await seedDoc('# R1\n\nbase\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await writeFile(abs(staged), '# R1\n\nagent\n')
    await editor.writeDoc(slug, '# R1\n\nuser\n')
    const report = await bridge.refreshDocument(checkout, staged)
    expect(report).toMatchObject({ kind: 'conflict' })
    expect(await readFile(abs(staged), 'utf8')).toBe('# R1\n\nagent\n')
    expect((await editor.readDoc(slug)).content).toBe('# R1\n\nuser\n')
  })

  it('refreshes an untouched copy when the Editor moved', async () => {
    const slug = await seedDoc('# R2\n\nbase\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    const before = staged.baseVersion
    const { version } = await editor.writeDoc(slug, '# R2\n\nuser\n')
    const report = await bridge.refreshDocument(checkout, staged)
    expect(report).toEqual({ kind: 'refreshed', path: staged.path })
    expect(await readFile(abs(staged), 'utf8')).toBe('# R2\n\nuser\n')
    expect(staged.baseVersion).toBe(version)
    expect(staged.baseVersion).not.toBe(before)
    expect(await bridge.refreshDocument(checkout, staged)).toEqual({ kind: 'unchanged' })
    expect(await bridge.writeBackDocument(checkout, staged, id)).toEqual({ kind: 'unchanged' })
  })

  it('writes an edited copy back with a new version and keeps writing after', async () => {
    const slug = await seedDoc('# R3\n\nbase\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await writeFile(abs(staged), '# R3\n\nfirst\n')
    const first = await bridge.writeBackDocument(checkout, staged, id)
    expect(first.kind).toBe('written-back')
    const doc = await editor.readDoc(slug)
    expect(doc.content).toBe('# R3\n\nfirst\n')
    expect(staged.baseVersion).toBe(doc.version)
    expect(staged.revision).toBe(1)
    await writeFile(abs(staged), '# R3\n\nsecond\n')
    expect((await bridge.writeBackDocument(checkout, staged, id)).kind).toBe('written-back')
    expect((await editor.readDoc(slug)).content).toBe('# R3\n\nsecond\n')
    expect(staged.revision).toBe(2)
  })

  it('stages again when the copy is gone and reports a deleted Editor document', async () => {
    const slug = await seedDoc('# R4\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await rm(abs(staged))
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'missing' })
    expect(await bridge.refreshDocument(checkout, staged)).toEqual({ kind: 'staged', path: staged.path })
    expect(await readFile(abs(staged), 'utf8')).toBe('# R4\n')
    await editor.deleteDoc(slug)
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'missing' })
    expect(await readFile(abs(staged), 'utf8')).toBe('# R4\n')
  })
})

describe('a staged copy that cannot be read', () => {
  it('is reported, not treated as missing, when it is a directory', async () => {
    const slug = await seedDoc('# U1\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await rm(abs(staged))
    await mkdir(abs(staged))
    await editor.writeDoc(slug, '# U1\n\nmoved\n')
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/not a regular file/) })
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/not a regular file/) })
    expect((await stat(abs(staged))).isDirectory()).toBe(true)
    expect((await editor.readDoc(slug)).content).toBe('# U1\n\nmoved\n')
  })

  it('is reported when it is a symlink, without following it', async () => {
    const slug = await seedDoc('# U2\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await rm(abs(staged))
    // Pointing outside: refused by the escape check.
    await symlink(join(outside, 'secret.md'), abs(staged))
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/outside the checkout/) })
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/outside the checkout/) })
    expect((await editor.readDoc(slug)).content).toBe('# U2\n')
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('outside the checkout\n')
    // Pointing inside: still a symlink, still refused, never followed.
    await rm(abs(staged))
    await symlink(join(checkout, 'README.md'), abs(staged))
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/symbolic link/) })
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/symbolic link/) })
    expect((await editor.readDoc(slug)).content).toBe('# U2\n')
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('# repo\n')
  })

  it('is reported when it exceeds the Editor document bound', async () => {
    const slug = await seedDoc('# U3\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await writeFile(abs(staged), Buffer.alloc(editor.MAX_DOC_BYTES + 1, 0x61))
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/exceeds/) })
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/exceeds/) })
    expect((await stat(abs(staged))).size).toBe(editor.MAX_DOC_BYTES + 1)
    expect((await editor.readDoc(slug)).content).toBe('# U3\n')
  })

  it('is reported when it is a FIFO, without blocking', async () => {
    const slug = await seedDoc('# U4\n')
    const id = randomUUID()
    const staged = await bridge.stageDocument(checkout, id, slug)
    await rm(abs(staged))
    const made = spawnSync('mkfifo', [abs(staged)])
    if (made.status !== 0) return // no mkfifo on this platform; the directory and symlink cases cover the rule
    expect(await bridge.writeBackDocument(checkout, staged, id)).toMatchObject({ kind: 'unreadable', message: expect.stringMatching(/not a regular file/) })
    expect(await bridge.refreshDocument(checkout, staged)).toMatchObject({ kind: 'unreadable' })
  })
})
