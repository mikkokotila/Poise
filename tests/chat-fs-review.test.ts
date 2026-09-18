import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveInsideCheckout } from '../server/chat/git'
import { readCheckoutTextFile, writeCheckoutTextFile } from '../server/chat/client-fs'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-fs-review-'))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), 'fixture metadata')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Chat filesystem metadata confinement', () => {
  it('rejects reads through an ancestor symlink pointing into Git metadata', async () => {
    await symlink(join(root, '.git'), join(root, 'alias'), 'dir')
    await expect(readCheckoutTextFile(root, 'alias/config')).rejects.toThrow()
  })

  it('rejects new writes through an ancestor symlink into Git metadata', async () => {
    await symlink(join(root, '.git'), join(root, 'alias'), 'dir')
    await expect(writeCheckoutTextFile(root, 'alias/new-config', 'unexpected')).rejects.toThrow()
    await expect(readFile(join(root, '.git', 'new-config'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects nested repository metadata rather than treating it as document content', async () => {
    await mkdir(join(root, 'nested', '.git'), { recursive: true })
    await writeFile(join(root, 'nested', '.git', 'config'), 'nested metadata')
    await expect(resolveInsideCheckout(root, 'nested/.git/config')).rejects.toThrow()
  })

  it('rejects a metadata alias spelled with different case on case-insensitive filesystems', async () => {
    let caseInsensitive = false
    try { caseInsensitive = (await readFile(join(root, '.GIT', 'config'), 'utf8')) === 'fixture metadata' } catch { /* case-sensitive platform */ }
    if (caseInsensitive) await expect(readCheckoutTextFile(root, '.GIT/config')).rejects.toThrow()
  })
})
