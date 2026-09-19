// Immutable release artifacts. A release is a complete directory — source at
// an exact commit, its installed dependencies and its built bundle — staged
// under a dot-prefixed name and renamed into place only after the build
// succeeded and the checkout was re-verified. The active directory is never
// built in, so a failed build cannot leave production half-written, and the
// previous release stays on disk so rollback needs nothing but a pointer
// switch. Nothing here is garbage-collected in v1.
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectory, isFile, readJson, writeJsonAtomic } from './atomic.mjs'
import { scrubEnvironment } from './environment.mjs'
import { isReleaseId, isSha } from './paths.mjs'

export const MANIFEST_NAME = 'release.json'
export const BUNDLE_PATH = join('dist', 'server.js')
export const INSTALL_TIMEOUT_MS = 20 * 60_000
export const BUILD_TIMEOUT_MS = 20 * 60_000

export function newReleaseId(sha, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${sha.slice(0, 12)}`
}

export async function readManifest(root) {
  const manifest = await readJson(join(root, MANIFEST_NAME), null)
  if (!manifest || !isReleaseId(manifest.id) || !isSha(manifest.sha)) return null
  return manifest
}

/** A release directory is usable when its manifest matches and its bundle exists. */
export async function releaseIsComplete(root, { id, sha }) {
  const manifest = await readManifest(root)
  if (!manifest || manifest.id !== id || manifest.sha !== sha) return false
  return isFile(join(root, BUNDLE_PATH))
}

export function createReleaseManager({
  releasesDir,
  logsDir,
  git,
  runner,
  nodeBin = null,
  baseEnv = process.env,
  callerSha = null,
  now = () => new Date(),
  log = null,
}) {
  const environment = (extra = {}) => scrubEnvironment({ base: baseEnv, nodeBin, extra })

  async function npm(args, { cwd, id, step, extra = {}, timeoutMs }) {
    const logRoot = join(logsDir, 'releases', id)
    return runner.run('npm', args, {
      cwd,
      env: environment(extra),
      timeoutMs,
      purpose: `release ${id} ${step}`,
      stdoutFile: join(logRoot, `${step}.stdout.log`),
      stderrFile: join(logRoot, `${step}.stderr.log`),
    })
  }

  return {
    releasesDir,
    rootFor(id) {
      return join(releasesDir, id)
    },
    /**
     * Build the release for `sha` under `id`. Idempotent: a complete release
     * with the same identity is returned as-is; a partial staging directory
     * from a crashed attempt is discarded and rebuilt.
     */
    async stage({ id, sha, token = null }) {
      if (!isReleaseId(id)) throw new Error(`invalid release id ${id}`)
      if (!isSha(sha)) throw new Error(`invalid release sha ${sha}`)
      await ensurePrivateDirectory(releasesDir)
      const root = join(releasesDir, id)
      const existing = await readManifest(root)
      if (existing) {
        if (existing.sha !== sha) throw new Error(`release ${id} already exists for ${existing.sha}, not ${sha}`)
        if (await isFile(join(root, BUNDLE_PATH))) return existing
        throw new Error(`release ${id} exists without a bundle; refusing to rebuild in place`)
      }
      const staging = join(releasesDir, `.${id}.staging`)
      await rm(staging, { recursive: true, force: true })
      log?.(`[self-update] staging release ${id} from ${sha}`)
      try {
        await git.clone({ dest: staging, sha, token, purpose: `release ${id} clone` })
        await npm(['ci', '--include=dev'], { cwd: staging, id, step: 'npm-ci', timeoutMs: INSTALL_TIMEOUT_MS })
        // The build stamps the SHA it was asked for and refuses a checkout
        // that is dirty or elsewhere; re-verify after it, too.
        await npm(['run', 'build'], { cwd: staging, id, step: 'build', extra: { POISE_RELEASE_SHA: sha }, timeoutMs: BUILD_TIMEOUT_MS })
        const head = await git.revParse(staging, 'HEAD')
        if (head !== sha) throw new Error(`release checkout moved to ${head} during build`)
        const dirty = await git.dirtyFiles(staging)
        if (dirty) throw new Error(`release checkout was modified during build:\n${dirty}`)
        if (!await isFile(join(staging, BUNDLE_PATH))) throw new Error('build produced no dist/server.js')
        const manifest = {
          id,
          sha,
          root,
          callerSha,
          createdAt: now().toISOString(),
          node: process.version,
          builder: 'poise-self-update',
        }
        await writeJsonAtomic(join(staging, MANIFEST_NAME), manifest)
        await rename(staging, root)
        log?.(`[self-update] release ${id} staged at ${root}`)
        return manifest
      } catch (error) {
        // An unsettled worker may still write this directory. Its retained
        // registry record prevents automatic retries; do not delete under it.
        if (error?.result?.settled === false) log?.(`[self-update] retaining ${staging}: worker group not settled`)
        else await rm(staging, { recursive: true, force: true })
        throw error
      }
    },
    async isComplete(release) {
      return releaseIsComplete(release.root, release)
    },
  }
}

export function toRelease(manifest) {
  return {
    id: manifest.id,
    sha: manifest.sha,
    root: manifest.root,
    createdAt: manifest.createdAt,
    callerSha: manifest.callerSha ?? '',
  }
}
