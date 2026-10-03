import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { runFile } from './process'
import { withProcessLock } from './process-lock'

export async function resolveReviewCheckout(
  owner: string, repo: string, number: number, actor: string, head: string, signal?: AbortSignal,
): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..'
    || !/^[A-Za-z0-9-]+$/.test(actor) || !Number.isSafeInteger(number) || number < 1
    || !/^[0-9a-f]{40}$/.test(head)) throw new Error('Invalid review repository, actor or head')
  try {
    const { stdout } = await runFile('github-interface', ['--local-checkout-path', owner, repo], {
      signal, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
    })
    const result = JSON.parse(stdout) as { action?: unknown, repository?: unknown, path?: unknown }
    if (result?.action !== 'local_checkout_path' || result.repository !== `${owner}/${repo}`
      || typeof result.path !== 'string' || !isAbsolute(result.path)) {
      throw new Error('github-interface --local-checkout-path returned malformed state')
    }
    return result.path
  } catch (error) {
    // Only the CLI's specific absence error permits provisioning. A denied
    // credential, timeout or malformed reply must still fail closed.
    const failure = error as { code?: unknown, stderr?: unknown }
    if (failure?.code !== 1 || typeof failure.stderr !== 'string'
      || !failure.stderr.trim().endsWith(`: ${owner}/${repo}`)
      || !failure.stderr.trim().startsWith('error: checkout not found under ')) throw error
  }
  // Caller's current checkout primitive fixes its token identity to bit-mis
  // and has no --token-user option. Never silently provision as another actor.
  if (actor.toLowerCase() !== 'bit-mis') {
    throw new Error(`Caller cannot provision a checkout as reviewer ${actor}; create a local checkout or update Caller to support an explicit checkout identity`)
  }
  const root = process.env.POISE_DB && process.env.POISE_DB !== ':memory:'
    ? dirname(resolve(process.env.POISE_DB)) : join(homedir(), '.poise')
  const base = join(root, 'review-checkouts', head, owner.toLowerCase())
  const path = join(base, repo.toLowerCase())
  const remote = `https://github.com/${owner}/${repo}.git`
  const verify = async (cwd: string): Promise<void> => {
    const origin = await runFile('git', ['remote', 'get-url', 'origin'], { cwd, signal, timeoutMs: 5_000 })
    const commit = await runFile('git', ['rev-parse', 'HEAD'], { cwd, signal, timeoutMs: 5_000 })
    const status = await runFile('git', ['status', '--porcelain'], { cwd, signal, timeoutMs: 5_000 })
    if (origin.stdout.trim().toLowerCase() !== remote.toLowerCase()
      || commit.stdout.trim() !== head || status.stdout.trim()) throw new Error('Managed review checkout differs from the expected repository/head or has local changes')
  }
  return withProcessLock({ path: `${path}.lock`, timeoutMs: 10_000 }, async () => {
    signal?.throwIfAborted()
    let exists = false
    try {
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Managed review checkout is not a directory')
      exists = true
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    if (exists) { await verify(path); return path }
    const temporary = await mkdtemp(join(base, '.staging-'))
    const checkout = join(temporary, owner, repo)
    try {
      await mkdir(dirname(checkout), { recursive: true, mode: 0o700 })
      const { stdout } = await runFile('github-interface', ['--checkout-repo', `${owner}/${repo}`, '--path', checkout], {
        signal, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
      })
      const result = JSON.parse(stdout) as { action?: unknown, repository?: unknown, path?: unknown }
      if (result?.action !== 'checkout_repo' || result.repository !== `${owner}/${repo}`
        || result.path !== checkout) throw new Error('github-interface --checkout-repo returned malformed state')
      // Caller owns network/authentication. Pin locally using only the history
      // Caller fetched; a fork commit absent from that history fails closed.
      await runFile('git', ['checkout', '--quiet', '--detach', head], { cwd: checkout, signal, timeoutMs: 5_000 })
      await verify(checkout)
      signal?.throwIfAborted()
      await rename(checkout, path)
      return path
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
