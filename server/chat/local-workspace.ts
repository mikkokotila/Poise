// New Chat sessions use ignored Poise-owned storage. Its private Git
// repository is only a checkpoint mechanism; it never switches Poise itself.
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CLI, runFile } from '../process'
import { CheckoutLease, canonicalCheckout } from './checkout-lock'
import { runGuarded } from './git'
import { pgidAlive } from './worker'

export const POISE_ROOT = dirname(dirname(CLAUDE_SUBSCRIPTION_CLI))
const DEFAULT_LOCAL_CHAT_ROOT = join(POISE_ROOT, '.poise-chat')
// Immutable releases keep user data in the original installation's ignored
// workspace, selected by the trusted launcher, never a browser request.
export const LOCAL_CHAT_ROOT = process.env.POISE_CHAT_ROOT
  ? resolve(process.env.POISE_CHAT_ROOT) : DEFAULT_LOCAL_CHAT_ROOT
const OWNER = 'Poise local Chat workspace v1\n'

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error: any) { if (error?.code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Chat storage is not a plain directory: ${path}`)
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`Chat storage belongs to another user: ${path}`)
}

// Creating another session should not wait for an existing coding turn just
// to rediscover a workspace that has already been initialized.
async function readyWorkspace(checkout: string): Promise<boolean> {
  try {
    const marker = join(checkout, '.poise-workspace-owner')
    const mark = await lstat(marker)
    const metadata = await lstat(join(checkout, '.git'))
    if (!mark.isFile() || mark.isSymbolicLink() || (await readFile(marker, 'utf8')) !== OWNER) throw new Error('Invalid local Chat ownership marker')
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Local Chat Git metadata must not be a link or worktree')
    const top = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: checkout })).stdout.trim()
    if (canonicalCheckout(top) !== checkout) throw new Error('Local Chat storage must not use the enclosing Poise repository')
    return await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout }).then(() => true, () => false)
  } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error }
}

export async function ensureLocalWorkspace(root = LOCAL_CHAT_ROOT, instance = 'poise'): Promise<string> {
  if (root === DEFAULT_LOCAL_CHAT_ROOT) {
    await runFile('git', ['check-ignore', '--quiet', '--no-index', '.poise-chat/workspace'], { cwd: POISE_ROOT })
      .catch(() => { throw new Error('Poise must ignore /.poise-chat/ before local Chat storage can be created') })
  }
  await privateDirectory(root)
  const workspace = join(root, 'workspace')
  await privateDirectory(workspace)
  const checkout = canonicalCheckout(workspace)
  if (await readyWorkspace(checkout)) return checkout
  const lease = new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'local-workspace-init', ownerLabel: 'Preparing local Chat storage', instance })
  await lease.acquire({ signal: AbortSignal.timeout(15_000) })
  try {
    const marker = join(checkout, '.poise-workspace-owner')
    let owned = false
    try {
      const info = await lstat(marker)
      owned = info.isFile() && !info.isSymbolicLink() && (await readFile(marker, 'utf8')) === OWNER
      if (!owned) throw new Error('The local Chat workspace has an invalid ownership marker')
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    if (!owned) {
      if ((await readdir(checkout)).length) throw new Error('Refusing to adopt an existing non-empty directory as Chat storage')
      await writeFile(marker, OWNER, { flag: 'wx', mode: 0o600 })
    }
    const metadata = join(checkout, '.git')
    let initialized = false
    try {
      const info = await lstat(metadata)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local Chat Git metadata must be a private directory, not a link or worktree')
      initialized = true
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    const git = async (args: string[]) => {
      const result = await runGuarded(lease, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: checkout })
      if (result.code !== 0) throw new Error(`Preparing local Chat storage failed: ${result.stderr.slice(0, 1000)}`)
      return result.stdout.trim()
    }
    if (!initialized) await git(['init', '--quiet', '--initial-branch=main', '--template=', checkout])
    const top = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: checkout })).stdout.trim()
    if (canonicalCheckout(top) !== checkout) throw new Error('Local Chat storage must not use the enclosing Poise repository')
    const hasHead = await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout }).then(() => true, () => false)
    if (!hasHead) {
      await git(['config', 'user.name', 'Poise local Chat'])
      await git(['config', 'user.email', 'poise-chat@example.invalid'])
      await git(['config', 'commit.gpgSign', 'false'])
      await git(['config', 'core.hooksPath', '/dev/null'])
      await mkdir(join(metadata, 'info'), { recursive: true, mode: 0o700 })
      await writeFile(join(metadata, 'info', 'exclude'), '.poise-workspace-owner\n.poise-chat/\n', { mode: 0o600 })
      await git(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'Initialize private Chat workspace'])
    }
    return checkout
  } finally {
    if (lease.held) {
      const row = lease.read()
      // A bootstrap command that did not settle still owns the workspace.
      // Releasing here would defeat runGuarded's retained worker record.
      if (!(row?.token === lease.currentToken && row.worker_pgid && pgidAlive(row.worker_pgid))) lease.release()
    }
  }
}
