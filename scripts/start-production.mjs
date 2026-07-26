// Production entry point. The launchd service runs this instead of
// dist/server.js directly, so a restart can never serve a bundle that no
// longer matches the checkout.
//
// The build used to happen only inside `npm run install:production`, while
// the service itself was `ProgramArguments: [node, dist/server.js]`. Any
// relaunch — launchd KeepAlive, a crash, a reboot — re-ran whatever dist/
// happened to contain. Pulling or merging therefore left the service healthy
// and on the new commit while the browser was served the previous assets,
// which is a silent failure: the code on disk and the code in the page
// disagree with nothing to indicate it. (It bites harder here because the
// production checkout is a git worktree of the same repository, so its HEAD
// moves with a merge while its dist/ does not.)
//
// So: stamp the inputs that feed the build, compare them on every start, and
// rebuild only when they differ. An unchanged restart pays one directory
// walk. A failed rebuild falls back to the previous bundle rather than
// leaving the service down — `npm run build` cleans dist/ first, so the
// previous bundle is moved aside and restored rather than trusted in place.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

// Everything `npm run build` reads. Nothing outside this set can change the
// output, so keeping the list tight is what makes an unchanged restart cheap.
const SOURCE_DIRECTORIES = ['src', 'server']
const SOURCE_FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
]

async function collectDirectory(root, dir, into) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return into
  }
  // Sort so the stamp is stable regardless of directory iteration order.
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectDirectory(root, full, into)
    else if (entry.isFile()) {
      const info = await stat(full)
      into.push(`${relative(root, full)}:${info.size}:${Math.round(info.mtimeMs)}`)
    }
  }
  return into
}

// Size + mtime rather than content hashes: this runs on every service start,
// and it is the same signal a build cache uses. A checkout, pull or merge
// rewrites mtimes, which is exactly the case that must force a rebuild.
export async function computeBuildStamp(root = projectRoot) {
  const parts = []
  for (const dir of SOURCE_DIRECTORIES) {
    await collectDirectory(root, join(root, dir), parts)
  }
  for (const file of SOURCE_FILES) {
    try {
      const info = await stat(join(root, file))
      parts.push(`${file}:${info.size}:${Math.round(info.mtimeMs)}`)
    } catch {
      parts.push(`${file}:absent`)
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function runBuild(root) {
  return new Promise((resolveBuild, rejectBuild) => {
    // The service's PATH is built for the Caller venv and Homebrew, and does
    // not necessarily contain the node launchd started us with. The build
    // shells out to npm, so put that node's bin directory first to guarantee
    // npm and node resolve to the same install as this process.
    const env = {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
    }
    const child = spawn('npm', ['run', 'build'], { cwd: root, env, stdio: 'inherit' })
    child.once('error', rejectBuild)
    child.once('close', (code, signal) => {
      if (code === 0) return resolveBuild()
      rejectBuild(new Error(`npm run build failed (${signal ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

/**
 * Bring dist/ in line with the checkout. Returns 'current' when the existing
 * bundle already matches, 'rebuilt' after a successful build, or 'stale' when
 * the build failed and the previous bundle was restored to keep serving.
 * `build` is injectable so tests don't shell out to npm.
 */
export async function ensureFreshBundle({ root = projectRoot, build = runBuild, log = console } = {}) {
  const distDir = join(root, 'dist')
  const bundle = join(distDir, 'server.js')
  const stampPath = join(distDir, '.build-stamp')
  const backupDir = join(root, 'dist.previous')

  const wanted = await computeBuildStamp(root)
  const recorded = await readFile(stampPath, 'utf8').then((v) => v.trim()).catch(() => null)
  const built = await isFile(bundle)

  if (built && recorded === wanted) {
    log.log('[poise] bundle matches the checkout; skipping rebuild')
    return 'current'
  }
  log.log(`[poise] rebuilding bundle (${
    !built ? 'no bundle present' : recorded ? 'sources changed since last build' : 'no build stamp'
  })`)

  // Move the current bundle aside instead of leaving it for `npm run build`
  // to delete, so there is something to fall back to if the build fails.
  await rm(backupDir, { recursive: true, force: true })
  const hadPrevious = built
  if (hadPrevious) await rename(distDir, backupDir)

  try {
    await build(root)
    await writeFile(stampPath, `${wanted}\n`, { mode: 0o600 })
    await rm(backupDir, { recursive: true, force: true })
    log.log('[poise] rebuild complete')
    return 'rebuilt'
  } catch (error) {
    if (!hadPrevious) throw error
    // A degraded service beats a dead one, but this must be impossible to
    // miss: the running assets no longer correspond to the checkout.
    log.error('[poise] REBUILD FAILED — restoring the previous bundle, which does '
      + 'NOT match the checkout. Fix the build and restart:', error)
    await rm(distDir, { recursive: true, force: true })
    await rename(backupDir, distDir)
    return 'stale'
  }
}

async function main() {
  await ensureFreshBundle()
  // The bundle only self-starts when it is process.argv[1]; imported, it just
  // exposes its entry points, so start it explicitly. Running the server in
  // this process (rather than spawning a child) keeps launchd supervising the
  // real server, so KeepAlive and signal handling behave as before.
  const bundle = pathToFileURL(join(projectRoot, 'dist', 'server.js')).href
  const { startProductionServer, createProductionShutdown } = await import(bundle)
  const server = await startProductionServer()
  const shutdown = createProductionShutdown(server)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false
if (isEntrypoint) {
  await main()
}
