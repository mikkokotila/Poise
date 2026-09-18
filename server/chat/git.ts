// Git operations on the shared repository checkout a chat session runs in.
//
// One checkout, one branch per session. The checkout follows the active
// session: before a turn the runtime makes sure the session's branch is
// checked out, committing the previous session's uncommitted work on its own
// branch first (`wip(poise): checkpoint` — never stashed, never lost) and
// refusing to touch a dirty checkout on a branch no session owns. Every
// mutating command runs under a registered worker gate while the caller
// holds the checkout lease (see checkout-lock.ts), so a crash mid-command
// cannot leave an unregistered writer behind.
//
// Paths handed to revert and to the client file services are validated the
// same way: resolved inside the checkout, no symlink escape, never inside
// `.git`.

import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { runFile } from '../process'
import type { CheckoutLease } from './checkout-lock'
import { spawnWorker } from './worker'

export const CHECKPOINT_MESSAGE = 'wip(poise): checkpoint'
const GIT_TIMEOUT_MS = 60_000
const GUARDED_OUTPUT_BYTES = 4 * 1024 * 1024
const BRANCH_NAME = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\))[^\s~^:?*[\x00-\x1f\x7f]+(?<!\/|\.lock|\.)$/

export class GitError extends Error {
  constructor(message: string, readonly code: 'dirty_unowned' | 'branch_drift' | 'invalid' | 'conflict' | 'git' = 'git') {
    super(message)
    this.name = 'GitError'
  }
}

export interface CheckoutInspection {
  currentBranch: string
  /** True while HEAD is detached. */
  detached: boolean
  dirty: boolean
  dirtyFiles: number
  defaultBranch: string
  branches: string[]
  headSha: string
}

async function git(checkout: string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await runFile('git', args, { cwd: checkout, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS })
    return stdout
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim()
    throw new GitError(`git ${args[0]} failed: ${detail}`)
  }
}

export function assertBranchName(name: string): string {
  const value = String(name || '').trim()
  if (!value || value.length > 200 || !BRANCH_NAME.test(value) || value === 'HEAD' || value.startsWith('-')) {
    throw new GitError(`invalid branch name: ${JSON.stringify(name)}`, 'invalid')
  }
  return value
}

export async function inspectCheckout(checkout: string): Promise<CheckoutInspection> {
  const status = await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all', '--branch'])
  const lines = status.split('\n').filter((line) => line.length > 0)
  const header = lines[0] || ''
  const detached = header.includes('(no branch)') || header.includes('HEAD (no branch)')
  const currentBranch = detached ? '' : header.replace(/^## /, '').split('...')[0].split(' ')[0]
  const dirtyFiles = lines.slice(1).length
  const branches = (await git(checkout, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split('\n').map((line) => line.trim()).filter(Boolean)
  const headSha = (await git(checkout, ['rev-parse', 'HEAD']).catch(() => '')).trim()
  return {
    currentBranch,
    detached,
    dirty: dirtyFiles > 0,
    dirtyFiles,
    defaultBranch: await defaultBranch(checkout, branches),
    branches,
    headSha,
  }
}

export async function defaultBranch(checkout: string, branches?: string[]): Promise<string> {
  const remoteHead = (await git(checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
  if (remoteHead) return remoteHead.replace(/^origin\//, '')
  const known = branches ?? (await git(checkout, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').map((line) => line.trim())
  for (const candidate of ['main', 'master']) if (known.includes(candidate)) return candidate
  return known[0] || 'main'
}

export async function branchExists(checkout: string, name: string): Promise<boolean> {
  try {
    await git(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${assertBranchName(name)}`])
    return true
  } catch {
    return false
  }
}

/** Commits on `branch` that `base` does not have — zero means a Poise-created
 *  branch never received a commit and may be deleted with its session. */
export async function commitsAhead(checkout: string, branch: string, base: string): Promise<number> {
  const out = await git(checkout, ['rev-list', '--count', `${assertBranchName(base)}..${assertBranchName(branch)}`])
  return Number(out.trim()) || 0
}

// ── Guarded (mutating) commands ───────────────────────────────────────────

export interface GuardedResult { stdout: string, stderr: string, code: number | null }

/** Run a mutating command under the caller's checkout lease: the gate is
 *  registered as the lease's worker before it may start, and cleared after
 *  it exited. The lease must be held. */
export async function runGuarded(lease: CheckoutLease, command: string, args: readonly string[], options: { cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }): Promise<GuardedResult> {
  if (!lease.held) throw new GitError('checkout lease is not held', 'conflict')
  const worker = spawnWorker(command, args, { cwd: options.cwd, env: options.env })
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0 }
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    output.bytes += chunk.byteLength
    if (output.bytes <= GUARDED_OUTPUT_BYTES) chunks.push(chunk)
  }
  worker.child.stdout?.on('data', collect(output.stdout))
  worker.child.stderr?.on('data', collect(output.stderr))
  if (!lease.registerWorker({ pid: worker.pid, pgid: worker.pgid, ident: worker.ident })) {
    await worker.terminate(1_000)
    throw new GitError('checkout lease was lost before the command could start', 'conflict')
  }
  const timeout = setTimeout(() => { worker.terminate(2_000).catch(() => undefined) }, options.timeoutMs ?? GIT_TIMEOUT_MS)
  let settled = false
  try {
    worker.go()
    const exit = await worker.exited
    // The gate exits only after its group is empty; a killed gate can still
    // leave descendants, and those keep the lease's worker registration.
    if (worker.alive) await worker.terminate(2_000)
    settled = true
    return {
      stdout: Buffer.concat(output.stdout).toString('utf8'),
      stderr: Buffer.concat(output.stderr).toString('utf8'),
      code: exit.code,
    }
  } finally {
    clearTimeout(timeout)
    // Only a settled group may be unregistered: the lease keeps blocking
    // other writers while anything of this command could still write.
    if (settled && !worker.alive) lease.clearWorker()
  }
}

async function guardedGit(lease: CheckoutLease, checkout: string, args: string[]): Promise<string> {
  const result = await runGuarded(lease, 'git', args, { cwd: checkout })
  if (result.code !== 0) {
    throw new GitError(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 2_000)}`)
  }
  return result.stdout
}

/** Commit everything (tracked and untracked, not ignored) on `branch` as a
 *  checkpoint. Refuses when the checkout is not on `branch` — the caller's
 *  view of the world has drifted and nothing may be committed blindly. */
export async function checkpoint(lease: CheckoutLease, checkout: string, branch: string): Promise<{ committed: boolean, sha?: string }> {
  const state = await inspectCheckout(checkout)
  if (state.currentBranch !== branch) {
    throw new GitError(`checkout is on ${state.currentBranch || 'a detached HEAD'}, not ${branch}; refusing to checkpoint`, 'branch_drift')
  }
  if (!state.dirty) return { committed: false }
  await guardedGit(lease, checkout, ['add', '--all'])
  // --no-verify: a checkpoint is mechanical, the author squashes before a
  // PR; a slow or failing pre-commit hook must not block switching sessions.
  await guardedGit(lease, checkout, ['commit', '--quiet', '--no-verify', '-m', CHECKPOINT_MESSAGE])
  const sha = (await git(checkout, ['rev-parse', 'HEAD'])).trim()
  return { committed: true, sha }
}

export async function switchBranch(lease: CheckoutLease, checkout: string, branch: string): Promise<void> {
  const name = assertBranchName(branch)
  const state = await inspectCheckout(checkout)
  if (state.currentBranch === name) return
  if (state.dirty) throw new GitError(`checkout on ${state.currentBranch} has ${state.dirtyFiles} uncommitted change(s); refusing to switch`, 'dirty_unowned')
  await guardedGit(lease, checkout, ['switch', '--quiet', name])
}

/** Create `name` at `from`; returns the commit it starts at, which is what
 *  "never received a commit" is measured against later (a branch whose
 *  commits were merged into the default branch still has history). */
export async function createBranch(lease: CheckoutLease, checkout: string, name: string, from: string): Promise<string> {
  const branch = assertBranchName(name)
  if (await branchExists(checkout, branch)) throw new GitError(`branch ${branch} already exists`, 'invalid')
  await guardedGit(lease, checkout, ['branch', '--quiet', branch, assertBranchName(from)])
  return (await git(checkout, ['rev-parse', `refs/heads/${branch}`])).trim()
}

export async function branchTip(checkout: string, name: string): Promise<string> {
  return (await git(checkout, ['rev-parse', `refs/heads/${assertBranchName(name)}`])).trim()
}

export async function deleteBranch(lease: CheckoutLease, checkout: string, name: string): Promise<void> {
  const branch = assertBranchName(name)
  const state = await inspectCheckout(checkout)
  if (state.currentBranch === branch) {
    if (state.dirty) throw new GitError(`checkout on ${branch} is dirty; not deleting it`, 'dirty_unowned')
    await guardedGit(lease, checkout, ['switch', '--quiet', state.defaultBranch])
  }
  await guardedGit(lease, checkout, ['branch', '--quiet', '-D', branch])
}

/** The step fix-failing-ci uses: github-interface fetches the PR head into
 *  `github-interface-pr-<n>` and checks it out (`checkout -B`). Run once at
 *  session creation; later switches are plain `git switch`. */
export async function checkoutPrHead(lease: CheckoutLease, checkout: string, pr: number): Promise<string> {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new GitError('invalid pull request number', 'invalid')
  // `checkout -B` would reset a branch that already exists — and with it any
  // commit a session made on it. An existing local PR branch is reused as
  // it is; refreshing it to the PR head is the user's call.
  const existing = `github-interface-pr-${pr}`
  if (await branchExists(checkout, existing)) {
    await switchBranch(lease, checkout, existing)
    return existing
  }
  const state = await inspectCheckout(checkout)
  if (state.dirty) throw new GitError(`checkout on ${state.currentBranch} has ${state.dirtyFiles} uncommitted change(s); refusing to check out the pull request`, 'dirty_unowned')
  const result = await runGuarded(lease, 'github-interface', ['--checkout-pr-head', `#${pr}`], { cwd: checkout, timeoutMs: 120_000 })
  if (result.code !== 0) throw new GitError(`github-interface --checkout-pr-head failed: ${(result.stderr || result.stdout).trim().slice(0, 2_000)}`)
  let parsed: any
  try { parsed = JSON.parse(result.stdout) } catch { throw new GitError('github-interface --checkout-pr-head returned no JSON') }
  const branch = String(parsed?.branch || '')
  if (parsed?.action !== 'checkout_pr_head' || !branch) throw new GitError('github-interface --checkout-pr-head returned malformed state')
  return assertBranchName(branch)
}

// ── Paths ─────────────────────────────────────────────────────────────────

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function hasGitComponent(rel: string): boolean {
  // Exact component match only: `.gitignore` and `.github` are ordinary files.
  return rel.split(sep).some((part) => part.toLowerCase() === '.git')
}

/** Resolve `input` (absolute or checkout-relative) to a path inside the
 *  checkout, refusing traversal, anything under a `.git` directory (in the
 *  request or in what it resolves to, case-insensitively), and symlinks
 *  that lead outside. The file itself may not exist yet; every existing
 *  ancestor is realpath'd and checked again after resolution. */
export async function resolveInsideCheckout(checkout: string, input: string): Promise<{ absolute: string, relative: string }> {
  const raw = String(input || '')
  if (!raw || raw.includes('\0')) throw new PathError('invalid path')
  const root = await realpath(checkout)
  // An absolute request is normalized the way the root was (/tmp → /private/tmp
  // on macOS) before the textual containment check.
  const candidate = isAbsolute(raw) ? await realpathWithMissingTail(raw) : resolve(root, raw)
  if (!insideRoot(root, candidate)) throw new PathError(`path is outside the checkout: ${raw}`)
  const rel = relative(root, candidate)
  if (hasGitComponent(rel)) throw new PathError('paths inside .git are not served')
  // Walk from the deepest existing ancestor: a symlink anywhere on the way
  // may lead out of the checkout — or into its .git — even when the textual
  // path looks fine. The resolved tail (the part that does not exist yet) is
  // checked with the same rule as the request.
  let probe = candidate
  let missingTail = ''
  while (true) {
    try {
      const real = await realpath(probe)
      if (!insideRoot(root, real)) throw new PathError(`path resolves outside the checkout: ${raw}`)
      const resolvedRel = relative(root, missingTail ? resolve(real, missingTail) : real)
      if (hasGitComponent(resolvedRel)) throw new PathError('paths inside .git are not served')
      break
    } catch (error: any) {
      if (error instanceof PathError) throw error
      if (error?.code !== 'ENOENT') throw new PathError(`cannot resolve ${raw}: ${error?.message || error}`)
      const parent = dirname(probe)
      if (parent === probe) break
      missingTail = missingTail ? `${basenameOf(probe)}${sep}${missingTail}` : basenameOf(probe)
      probe = parent
    }
  }
  try {
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new PathError(`symbolic links are not served: ${raw}`)
  } catch (error: any) {
    if (error instanceof PathError) throw error
    if (error?.code !== 'ENOENT') throw new PathError(`cannot access ${raw}: ${error?.message || error}`)
  }
  return { absolute: candidate, relative: rel }
}

async function realpathWithMissingTail(path: string): Promise<string> {
  let probe = resolve(path)
  let tail = ''
  while (true) {
    try {
      const real = await realpath(probe)
      return tail ? resolve(real, tail) : real
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return resolve(path)
      const parent = dirname(probe)
      if (parent === probe) return resolve(path)
      tail = tail ? `${basenameOf(probe)}${sep}${tail}` : basenameOf(probe)
      probe = parent
    }
  }
}

function basenameOf(path: string): string {
  return path.slice(dirname(path).length).replace(/^\/+/, '')
}

/** Write a file atomically inside the checkout: temp file in the same
 *  directory, fsync, rename — a failure mid-write never truncates the
 *  target (the Editor's writeAtomic standard). */
export async function writeFileAtomic(absolute: string, content: string): Promise<void> {
  const tmp = `${absolute}.poise-tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  let handle
  try {
    let mode = 0o600
    try { mode = (await stat(absolute)).mode & 0o777 } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    handle = await open(tmp, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, absolute)
  } catch (error) {
    try { await handle?.close() } catch { /* best effort */ }
    try { await rm(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

// ── Revert ────────────────────────────────────────────────────────────────

export interface RecordedDiff {
  path: string
  oldText: string
  newText: string
  oldExists: boolean
  newExists: boolean
  unified?: boolean
}

/** Reverse one recorded change: only when the file still holds exactly what
 *  the agent left (`newText`, or absence for a deletion). Anything else is a
 *  conflict — later work is never clobbered. Runs under the caller's lease. */
export async function revertDiff(lease: CheckoutLease, checkout: string, diff: RecordedDiff): Promise<void> {
  if (!lease.held) throw new GitError('checkout lease is not held', 'conflict')
  if (diff.unified) throw new GitError('this change was recorded without the file contents (the agent reported a patch only); it cannot be reverted from the transcript', 'conflict')
  const { absolute, relative: rel } = await resolveInsideCheckout(checkout, diff.path)
  let current: string | null = null
  try {
    current = await readFile(absolute, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw new GitError(`cannot read ${rel}: ${error?.message || error}`)
  }
  if (diff.newExists) {
    if (current === null) throw new GitError(`${rel} no longer exists; the agent's change was already reverted or replaced`, 'conflict')
    if (current !== diff.newText) throw new GitError(`${rel} changed since the agent edited it; not reverting`, 'conflict')
  } else if (current !== null) {
    throw new GitError(`${rel} exists again; not reverting the deletion`, 'conflict')
  }
  if (diff.oldExists) {
    await mkdir(dirname(absolute), { recursive: true })
    await writeFileAtomic(absolute, diff.oldText)
  } else {
    await rm(absolute, { force: true })
  }
}
