import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CheckoutLease } from '../../server/chat/checkout-lock'
import { CLIENT_FILE_MAX_BYTES, readCheckoutTextFile, writeCheckoutTextFile } from '../../server/chat/client-fs'
import { branchExists, branchTip, checkpoint, createBranch, deleteBranch, inspectCheckout, resolveInsideCheckout, revertDiff, switchBranch } from '../../server/chat/git'

let root = ''
let checkout = ''
let outside = ''

function git(args: string[], cwd = checkout): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-git-fs-'))
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  checkout = join(root, 'repo')
  outside = join(root, 'outside')
  await mkdir(checkout)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'outside secret')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(checkout, 'README.md'), '# repo\n')
  await mkdir(join(checkout, 'src'))
  await writeFile(join(checkout, 'src', 'a.txt'), 'alpha\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
})

afterAll(async () => {
  delete process.env.POISE_LOCK_DIR
  await rm(root, { recursive: true, force: true })
})

function lease(): CheckoutLease {
  const l = new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'test', ownerLabel: 'test', instance: 'test' })
  if (!l.tryAcquire().acquired) throw new Error('could not acquire test lease')
  return l
}

describe('checkout-scoped paths', () => {
  it('serves files inside the checkout and refuses traversal, .git and symlink escapes', async () => {
    await expect(readCheckoutTextFile(checkout, 'src/a.txt')).resolves.toBe('alpha\n')
    await expect(readCheckoutTextFile(checkout, join(checkout, 'src/a.txt'))).resolves.toBe('alpha\n')
    await expect(readCheckoutTextFile(checkout, '../outside/secret.txt')).rejects.toThrow(/outside the checkout/)
    await expect(readCheckoutTextFile(checkout, join(outside, 'secret.txt'))).rejects.toThrow(/outside the checkout/)
    await expect(readCheckoutTextFile(checkout, '.git/config')).rejects.toThrow(/\.git/)
    await expect(readCheckoutTextFile(checkout, '.GIT/config')).rejects.toThrow(/\.git/)
    await expect(readCheckoutTextFile(checkout, 'src/../.git/HEAD')).rejects.toThrow(/\.git/)
    await expect(writeCheckoutTextFile(checkout, '.git/hooks/pre-commit', '#!/bin/sh')).rejects.toThrow(/\.git/)
    // .gitignore is an ordinary file.
    await writeCheckoutTextFile(checkout, '.gitignore', 'node_modules\n')
    await expect(readCheckoutTextFile(checkout, '.gitignore')).resolves.toBe('node_modules\n')
    // A symlink to the outside, and an ancestor symlink to the outside.
    await symlink(join(outside, 'secret.txt'), join(checkout, 'link.txt'))
    await symlink(outside, join(checkout, 'linkdir'))
    await expect(readCheckoutTextFile(checkout, 'link.txt')).rejects.toThrow(/symbolic links|outside/)
    await expect(readCheckoutTextFile(checkout, 'linkdir/secret.txt')).rejects.toThrow(/outside the checkout/)
    await expect(writeCheckoutTextFile(checkout, 'linkdir/new.txt', 'x')).rejects.toThrow(/outside the checkout/)
    // An ancestor symlink that aliases .git from inside the checkout.
    await symlink(join(checkout, '.git'), join(checkout, 'alias'))
    await expect(readCheckoutTextFile(checkout, 'alias/config')).rejects.toThrow(/\.git/)
    await expect(writeCheckoutTextFile(checkout, 'alias/new-file', 'x')).rejects.toThrow(/\.git/)
    await expect(readCheckoutTextFile(checkout, 'alias/HEAD')).rejects.toThrow(/\.git/)
    // A nested .git directory is off limits too.
    await mkdir(join(checkout, 'vendor', '.git'), { recursive: true })
    await writeFile(join(checkout, 'vendor', '.git', 'config'), 'x')
    await expect(readCheckoutTextFile(checkout, 'vendor/.git/config')).rejects.toThrow(/\.git/)
    await rm(join(checkout, 'alias'))
    await rm(join(checkout, 'link.txt'))
    await rm(join(checkout, 'linkdir'))
    await rm(join(checkout, 'vendor'), { recursive: true })
    await rm(join(checkout, '.gitignore'))
  })

  it('bounds reads without allocating the whole file and refuses non-regular files', async () => {
    const big = join(checkout, 'big.bin')
    // A sparse file larger than the bound: the size check fires before any read.
    const { open } = await import('node:fs/promises')
    const handle = await open(big, 'w')
    await handle.truncate(CLIENT_FILE_MAX_BYTES + 10)
    await handle.close()
    await expect(readCheckoutTextFile(checkout, 'big.bin')).rejects.toThrow(/exceeds/)
    await rm(big)
    if (process.platform !== 'win32') {
      const fifo = join(checkout, 'pipe')
      spawnSync('mkfifo', [fifo])
      await expect(readCheckoutTextFile(checkout, 'pipe')).rejects.toThrow(/not a regular file|cannot read/)
      await rm(fifo, { force: true })
    }
    await expect(resolveInsideCheckout(checkout, 'a\0b')).rejects.toThrow(/invalid path/)
  })

  it('writes atomically', async () => {
    await writeCheckoutTextFile(checkout, 'src/new/deep.txt', 'deep\n')
    await expect(readFile(join(checkout, 'src/new/deep.txt'), 'utf8')).resolves.toBe('deep\n')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(checkout, 'src/new'))).filter((n) => n.includes('poise-tmp'))).toEqual([])
    await rm(join(checkout, 'src/new'), { recursive: true })
  })
})

describe('checkpoint, switch and branches', () => {
  it('refuses to checkpoint when the checkout drifted off the expected branch', async () => {
    const l = lease()
    try {
      await writeFile(join(checkout, 'dirty.txt'), 'x')
      await expect(checkpoint(l, checkout, 'not-main')).rejects.toMatchObject({ code: 'branch_drift' })
      const result = await checkpoint(l, checkout, 'main')
      expect(result.committed).toBe(true)
      expect(git(['log', '-1', '--format=%s'])).toBe('wip(poise): checkpoint')
      expect((await inspectCheckout(checkout)).dirty).toBe(false)
      expect(await checkpoint(l, checkout, 'main')).toEqual({ committed: false })
    } finally {
      l.release()
    }
  })

  it('creates a branch at a recorded base, refuses switching a dirty tree, deletes only an untouched branch', async () => {
    const l = lease()
    try {
      const base = await createBranch(l, checkout, 'chat/test', 'main')
      expect(base).toBe(git(['rev-parse', 'main']))
      await expect(createBranch(l, checkout, 'chat/test', 'main')).rejects.toMatchObject({ code: 'invalid' })
      await writeFile(join(checkout, 'dirty2.txt'), 'x')
      await expect(switchBranch(l, checkout, 'chat/test')).rejects.toMatchObject({ code: 'dirty_unowned' })
      await checkpoint(l, checkout, 'main')
      await switchBranch(l, checkout, 'chat/test')
      expect((await inspectCheckout(checkout)).currentBranch).toBe('chat/test')
      // A commit on the branch moves its tip: deletion policy compares to base.
      await writeFile(join(checkout, 'work.txt'), 'work')
      await checkpoint(l, checkout, 'chat/test')
      expect(await branchTip(checkout, 'chat/test')).not.toBe(base)
      await switchBranch(l, checkout, 'main')
      await deleteBranch(l, checkout, 'chat/test')
      expect(await branchExists(checkout, 'chat/test')).toBe(false)
      await expect(createBranch(l, checkout, '../evil', 'main')).rejects.toMatchObject({ code: 'invalid' })
      await expect(createBranch(l, checkout, '-flag', 'main')).rejects.toMatchObject({ code: 'invalid' })
    } finally {
      l.release()
    }
  })
})

describe('revert', () => {
  it('reverses a recorded change only when the file still holds what the agent left', async () => {
    const l = lease()
    try {
      const path = 'src/a.txt'
      await writeFile(join(checkout, path), 'beta\n')
      await revertDiff(l, checkout, { path, oldText: 'alpha\n', newText: 'beta\n', oldExists: true, newExists: true })
      expect(await readFile(join(checkout, path), 'utf8')).toBe('alpha\n')
      // Later edit: conflict, nothing clobbered.
      await writeFile(join(checkout, path), 'gamma\n')
      await expect(revertDiff(l, checkout, { path, oldText: 'alpha\n', newText: 'beta\n', oldExists: true, newExists: true })).rejects.toMatchObject({ code: 'conflict' })
      expect(await readFile(join(checkout, path), 'utf8')).toBe('gamma\n')
      await writeFile(join(checkout, path), 'alpha\n')
      // Created file: revert deletes it; an empty created file is not "missing".
      await writeFile(join(checkout, 'created.txt'), '')
      await revertDiff(l, checkout, { path: 'created.txt', oldText: '', newText: '', oldExists: false, newExists: true })
      await expect(readFile(join(checkout, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      // Deleted file: revert restores it, but not if it came back meanwhile.
      await revertDiff(l, checkout, { path: 'gone.txt', oldText: 'was here\n', newText: '', oldExists: true, newExists: false })
      expect(await readFile(join(checkout, 'gone.txt'), 'utf8')).toBe('was here\n')
      await expect(revertDiff(l, checkout, { path: 'gone.txt', oldText: 'x', newText: '', oldExists: true, newExists: false })).rejects.toMatchObject({ code: 'conflict' })
      await rm(join(checkout, 'gone.txt'))
      // Unified-only records and paths outside the checkout are refused.
      await expect(revertDiff(l, checkout, { path, oldText: '', newText: '@@', oldExists: true, newExists: true, unified: true })).rejects.toMatchObject({ code: 'conflict' })
      await expect(revertDiff(l, checkout, { path: '../outside/secret.txt', oldText: 'a', newText: 'outside secret', oldExists: true, newExists: true })).rejects.toThrow(/outside the checkout/)
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
    } finally {
      l.release()
    }
    const released = new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'x', ownerLabel: 'x', instance: 'test' })
    await expect(revertDiff(released, checkout, { path: 'src/a.txt', oldText: 'a', newText: 'alpha\n', oldExists: true, newExists: true })).rejects.toMatchObject({ code: 'conflict' })
  })
})
