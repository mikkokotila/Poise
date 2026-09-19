// Git as the controller uses it: exact SHAs in, exact SHAs out, and the
// release token present only in the environment of the git processes that
// talk to GitHub — never in a URL, never on a command line, never written to
// a checkout's config, never in a process that runs candidate code.
import { scrubEnvironment } from './environment.mjs'
import { REPOSITORY_URL, isSha } from './paths.mjs'

const COMMITTER = ['-c', 'user.name=Poise Release Controller', '-c', 'user.email=poise-release-controller@localhost']
const QUIET_CHECKOUT = ['-c', 'advice.detachedHead=false']

function authorisedEnvironment(env, token) {
  if (!token) return env
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: header,
  }
}

/** Parse `git diff-tree -r --raw -z` output into policy entries. */
export function parseRawDiff(output) {
  const fields = output.split('\0')
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index]
    if (!meta.startsWith(':')) continue
    const [oldMode, newMode, , , statusField] = meta.slice(1).split(' ')
    const status = statusField?.[0]
    const path = fields[index + 1]
    if (path === undefined || path === '') break
    if (status === 'R' || status === 'C') {
      entries.push({ status, oldMode, newMode, oldPath: path, path: fields[index + 2] })
      index += 2
    } else {
      entries.push({ status, oldMode, newMode, path })
      index += 1
    }
  }
  return entries
}

function requireSha(value, label) {
  const sha = String(value || '').trim().toLowerCase()
  if (!isSha(sha)) throw new Error(`${label} did not resolve to a commit SHA`)
  return sha
}

export function createGit({ runner, nodeBin = null, baseEnv = process.env, url = REPOSITORY_URL, timeoutMs = 5 * 60_000 } = {}) {
  const env = () => scrubEnvironment({ base: baseEnv, nodeBin })
  const git = async (args, { cwd, token = null, allowFailure = false, purpose = 'git', timeout = timeoutMs, logs = {} } = {}) => runner.run('git', args, {
    cwd, env: authorisedEnvironment(env(), token), timeoutMs: timeout, allowFailure, purpose, ...logs,
  })

  return {
    url,
    async revParse(cwd, ref) {
      return requireSha((await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd })).stdout, ref)
    },
    async fileText(cwd, ref, path) {
      return (await git(['show', `${ref}:${path}`], { cwd })).stdout
    },
    async treeSha(cwd, ref) {
      return requireSha((await git(['rev-parse', '--verify', `${ref}^{tree}`], { cwd })).stdout, `${ref} tree`)
    },
    async currentBranch(cwd) {
      return (await git(['branch', '--show-current'], { cwd })).stdout.trim()
    },
    /** Tracked modifications only; build output in ignored directories is fine. */
    async dirtyFiles(cwd) {
      return (await git(['status', '--porcelain', '--untracked-files=no'], { cwd })).stdout.trim()
    },
    async isAncestor(cwd, ancestor, descendant) {
      const result = await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFailure: true })
      if (result.code === 0) return true
      if (result.code === 1) return false
      throw new Error(`git merge-base failed: ${result.stderr.trim()}`)
    },
    async changedEntries(cwd, base, head) {
      const result = await git(['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-commit-id', base, head], { cwd })
      return parseRawDiff(result.stdout)
    },
    /**
     * Fresh clone at an exact commit. `branch`, when given, becomes a local
     * branch pointing at `sha`. The token is only needed for private access;
     * it never lands in the clone.
     */
    async clone({ dest, sha, branch = null, token = null, purpose = 'clone' }) {
      await git(['clone', '--quiet', '--no-checkout', url, dest], { token, purpose, timeout: 15 * 60_000 })
      await git([...QUIET_CHECKOUT, 'checkout', '--quiet', '--detach', sha], { cwd: dest, purpose })
      const head = await this.revParse(dest, 'HEAD')
      if (head !== sha) throw new Error(`checkout resolved to ${head}, expected ${sha}`)
      if (branch) await git(['checkout', '--quiet', '-B', branch, sha], { cwd: dest, purpose })
      return head
    },
    async remoteRef({ branch, token = null }) {
      const result = await git(['ls-remote', '--exit-code', url, `refs/heads/${branch}`], { token, allowFailure: true, purpose: 'ls-remote' })
      if (result.code === 2) return null
      if (result.code !== 0) throw new Error(`git ls-remote failed: ${result.stderr.trim()}`)
      return requireSha(result.stdout.split(/\s+/)[0], `refs/heads/${branch}`)
    },
    /** Publish exactly `sha` to `branch`; never forced. */
    async push({ cwd, sha, branch, token }) {
      if (!token) throw new Error('push requires the release token')
      await git(['push', '--quiet', url, `${sha}:refs/heads/${branch}`], { cwd, token, purpose: 'push' })
    },
    /**
     * Revert a merge commit's first-parent side. Returns { sha } on success or
     * { conflict: true, detail } after aborting a conflicted revert, leaving
     * the checkout clean either way.
     */
    async revertMerge(cwd, mergeSha) {
      const result = await git([...COMMITTER, 'revert', '-m', '1', '--no-edit', mergeSha], { cwd, allowFailure: true, purpose: 'revert' })
      if (result.code === 0) return { sha: await this.revParse(cwd, 'HEAD') }
      await git(['revert', '--abort'], { cwd, allowFailure: true, purpose: 'revert-abort' })
      return { conflict: true, detail: (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n') }
    },
  }
}
