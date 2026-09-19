// The stable production launcher. launchd runs this file from the trusted
// controller copy; it reads the active-release pointer, checks that the
// release directory really is the one the pointer names, and starts that
// release's bundle in-process so launchd keeps supervising the real server.
//
// It deliberately knows nothing else: no git, no build, no network. A switch
// or rollback is a pointer rewrite followed by a restart, and this file is
// what makes the restart land on the pointer.
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJson } from './atomic.mjs'
import { layout, selfUpdateRoot } from './paths.mjs'
import { BUNDLE_PATH, readManifest } from './releases.mjs'
import { validPointer } from './store.mjs'

export class LaunchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LaunchError'
  }
}

/** Resolve what to run. Throws LaunchError rather than guessing. */
export async function resolveLaunch(root = selfUpdateRoot()) {
  const pointer = await readJson(layout(root).activePointerPath, null)
  if (!validPointer(pointer)) throw new LaunchError(`no valid active release pointer at ${layout(root).activePointerPath}`)
  const manifest = await readManifest(pointer.root)
  if (!manifest) throw new LaunchError(`release directory ${pointer.root} has no release manifest`)
  if (manifest.id !== pointer.id || manifest.sha !== pointer.sha) {
    throw new LaunchError(`release at ${pointer.root} is ${manifest.id}@${manifest.sha.slice(0, 12)}, pointer expects ${pointer.id}@${pointer.sha.slice(0, 12)}`)
  }
  const bundle = join(pointer.root, BUNDLE_PATH)
  return {
    releaseId: pointer.id,
    sha: pointer.sha,
    root: pointer.root,
    bundle,
    env: {
      POISE_RELEASE_ID: pointer.id,
      POISE_RELEASE_SHA: pointer.sha,
      POISE_RELEASE_ROOT: pointer.root,
    },
  }
}

export async function main() {
  const launch = await resolveLaunch()
  Object.assign(process.env, launch.env)
  process.chdir(launch.root)
  const { startProductionServer, createProductionShutdown } = await import(pathToFileURL(launch.bundle).href)
  const server = await startProductionServer()
  const shutdown = createProductionShutdown(server)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(`[poise] serving release ${launch.releaseId} (${launch.sha.slice(0, 12)}) from ${launch.root}`)
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (isEntrypoint) {
  try {
    await main()
  } catch (error) {
    console.error(`[poise] cannot launch release: ${error?.message || error}`)
    // EX_CONFIG: launchd's KeepAlive will retry after ThrottleInterval, and
    // the recovery UI stays reachable from the controller in the meantime.
    process.exit(78)
  }
}
