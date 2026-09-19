import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSourceSha } from '../scripts/build-identity.mjs'

let root
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-build-id-'))
  git('init', '--quiet', '--initial-branch=main', '--template=')
  git('config', 'user.name', 'Poise test'); git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null')
  await writeFile(join(root, 'input.txt'), 'one\n')
  git('add', 'input.txt'); git('commit', '-q', '-m', 'fixture')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('compile-time release identity', () => {
  it('identifies a clean checkout by its full SHA', () => {
    const head = git('rev-parse', 'HEAD')
    expect(buildSourceSha(root, '')).toBe(head)
    expect(buildSourceSha(root, head)).toBe(head)
  })
  it('never assigns a committed SHA to modified build inputs', async () => {
    await writeFile(join(root, 'input.txt'), 'changed\n')
    expect(buildSourceSha(root, '')).toBeNull()
    expect(() => buildSourceSha(root, git('rev-parse', 'HEAD'))).toThrow(/clean checkout/)
  })
  it('includes untracked input files in the dirty check', async () => {
    await writeFile(join(root, 'new-source.ts'), 'export const value = 1\n')
    expect(buildSourceSha(root, '')).toBeNull()
  })
  it('rejects a mismatched or malformed requested release SHA', () => {
    expect(() => buildSourceSha(root, 'a'.repeat(40))).toThrow(/exact requested SHA/)
    expect(() => buildSourceSha(root, 'main')).toThrow(/exact requested SHA/)
  })
  it('treats source archives as development rather than trusting an environment claim', async () => {
    await rm(join(root, '.git'), { recursive: true, force: true })
    expect(buildSourceSha(root, '')).toBeNull()
    expect(() => buildSourceSha(root, 'b'.repeat(40))).toThrow(/clean checkout/)
  })
})
