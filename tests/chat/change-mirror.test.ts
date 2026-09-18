import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCheckoutSnapshot, compareCheckoutSnapshots, emitCheckoutChanges } from '../../server/chat/change-mirror'
import type { ChatEvent } from '../../server/chat/protocol'

let root: string
let repo: string
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }) }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-change-mirror-'))
  repo = join(root, 'repo')
  await mkdir(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'base.txt'), 'original\n')
  git('add', 'base.txt'); git('commit', '-q', '-m', 'fixture')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const after = (before: Awaited<ReturnType<typeof captureCheckoutSnapshot>>) => captureCheckoutSnapshot(repo, [...before.files.keys()])

describe('turn-level checkout change mirror', () => {
  it('records actual pre-turn content rather than HEAD, including untracked edits, additions and deletions', async () => {
    await writeFile(join(repo, 'base.txt'), 'preexisting user work\n')
    await writeFile(join(repo, 'untracked.txt'), 'keep this\n')
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(repo, 'base.txt'), 'agent edit\n')
    await rm(join(repo, 'untracked.txt'))
    await writeFile(join(repo, 'new.txt'), 'new file\n')
    const result = compareCheckoutSnapshots(before, await after(before))
    expect(result.warnings).toEqual([])
    expect(result.changes).toEqual([
      { path: 'base.txt', oldText: 'preexisting user work\n', newText: 'agent edit\n', oldExists: true, newExists: true },
      { path: 'new.txt', oldText: '', newText: 'new file\n', oldExists: false, newExists: true },
      { path: 'untracked.txt', oldText: 'keep this\n', newText: '', oldExists: true, newExists: false },
    ])
  })

  it('distinguishes empty existing files from absent files', async () => {
    await writeFile(join(repo, 'empty.txt'), '')
    const before = await captureCheckoutSnapshot(repo)
    await rm(join(repo, 'empty.txt'))
    await writeFile(join(repo, 'created-empty.txt'), '')
    const { changes } = compareCheckoutSnapshots(before, await after(before))
    expect(changes).toContainEqual({ path: 'empty.txt', oldText: '', newText: '', oldExists: true, newExists: false })
    expect(changes).toContainEqual({ path: 'created-empty.txt', oldText: '', newText: '', oldExists: false, newExists: true })
  })

  it('does not invent a nonexistent pre-image when an ignored old file becomes visible', async () => {
    await writeFile(join(repo, '.gitignore'), 'hidden.txt\n')
    await writeFile(join(repo, 'hidden.txt'), 'existing ignored work\n')
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(repo, '.gitignore'), '')
    await writeFile(join(repo, 'hidden.txt'), 'changed\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(changes.some(change => change.path === 'hidden.txt')).toBe(false)
    expect(warnings.join(' ')).toContain('previously ignored file')
  })

  it('includes an explicitly named ignored Editor stage without copying ignored attachments', async () => {
    await writeFile(join(repo, '.gitignore'), '.poise-chat/\n')
    await mkdir(join(repo, '.poise-chat'), { recursive: true })
    await writeFile(join(repo, '.poise-chat', 'document.md'), 'before\n')
    await writeFile(join(repo, '.poise-chat', 'attachment.txt'), 'private upload\n')
    const before = await captureCheckoutSnapshot(repo, ['.poise-chat/document.md'])
    expect(before.files.has('.poise-chat/attachment.txt')).toBe(false)
    await writeFile(join(repo, '.poise-chat', 'document.md'), 'after\n')
    const { changes } = compareCheckoutSnapshots(before, await after(before))
    expect(changes).toContainEqual({ path: '.poise-chat/document.md', oldText: 'before\n', newText: 'after\n', oldExists: true, newExists: true })
  })

  it('refuses to follow symlinks and does not turn an unsafe path into a revertible new file', async () => {
    await writeFile(join(root, 'outside.txt'), 'outside contents')
    await symlink(join(root, 'outside.txt'), join(repo, 'link.txt'))
    const before = await captureCheckoutSnapshot(repo)
    expect(before.files.get('link.txt')?.text).toBeUndefined()
    await rm(join(repo, 'link.txt'))
    await writeFile(join(repo, 'link.txt'), 'now a regular file')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(changes.some(change => change.path === 'link.txt')).toBe(false)
    expect(warnings.join(' ')).toContain('not a regular')
  })

  it('reports changed binary and over-limit files instead of exposing a destructive Revert', async () => {
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(repo, 'large.txt'), 'a'.repeat(200))
    const before = await captureCheckoutSnapshot(repo, [], { maxFileBytes: 100 })
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 3, 4]))
    await writeFile(join(repo, 'large.txt'), 'b'.repeat(201))
    const next = await captureCheckoutSnapshot(repo, [...before.files.keys()], { maxFileBytes: 100 })
    const { changes, warnings } = compareCheckoutSnapshots(before, next)
    expect(changes).toEqual([])
    expect(warnings.join(' ')).toContain('binary or non-UTF-8')
    expect(warnings.join(' ')).toContain('exceeds 100 bytes')
  })

  it('fails closed on an incomplete file inventory', async () => {
    const before = await captureCheckoutSnapshot(repo, [], { maxFiles: 0 })
    await writeFile(join(repo, 'new.txt'), 'new\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await captureCheckoutSnapshot(repo))
    expect(changes).toEqual([])
    expect(warnings.join(' ')).toContain('incomplete checkout inventory')
  })

  it('emits a labelled whole-turn card rather than pretending shell changes came from a native edit tool', async () => {
    const before = await captureCheckoutSnapshot(repo)
    execFileSync('sh', ['-c', 'printf "shell edit\n" > base.txt'], { cwd: repo })
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['tool.started', 'diff', 'tool.finished'])
    expect(events[0]).toMatchObject({ title: 'Checkout changes during this turn', input: { source: 'poise', scope: 'whole turn' } })
    expect(events[1]).toMatchObject({ path: 'base.txt', oldText: 'original\n', newText: 'shell edit\n' })
  })
})
