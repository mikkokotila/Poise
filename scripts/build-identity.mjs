import { execFileSync } from 'node:child_process'

/** Embed source identity at build time, never infer it from a running checkout.
 * An uncommitted development build has no releasable SHA. Release builds fail
 * rather than stamping different or dirty bytes with a requested identity. */
export function buildSourceSha(root = process.cwd(), expected = process.env.POISE_RELEASE_SHA) {
  let sha = null
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const head = git('rev-parse', '--verify', 'HEAD')
    if (/^[0-9a-f]{40}$/.test(head) && !git('status', '--porcelain', '--untracked-files=normal')) sha = head
  } catch { /* Source archives and development builds are not releases. */ }
  if (expected && (!/^[0-9a-f]{40}$/.test(expected) || sha !== expected)) {
    throw new Error('Release build requires a clean checkout at the exact requested SHA')
  }
  return sha
}
