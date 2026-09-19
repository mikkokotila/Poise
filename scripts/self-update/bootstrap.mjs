// Bootstrap helpers for the coordinator's installer and for the CLI. None of
// this runs on import, and none of it touches production: it prepares the
// controller root (config, bridge key, trusted controller copy) and can adopt
// a first release so that the controller has a known baseline to reason from.
import { randomBytes } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensurePrivateDirectory, isFile, pathExists, writeFileAtomic } from './atomic.mjs'
import { normalizeConfig, readConfig, writeConfig } from './config.mjs'
import { layout } from './paths.mjs'
import { newReleaseId, readManifest, releaseIsComplete, toRelease } from './releases.mjs'
import { openStore } from './store.mjs'

const CONTROLLER_SOURCE = fileURLToPath(new URL('.', import.meta.url))

/** Create the root and its private subdirectories. Idempotent. */
export async function initializeRoot(root) {
  const paths = layout(root)
  await ensurePrivateDirectory(root)
  for (const dir of [paths.releasesDir, paths.workspacesDir, paths.logsDir, paths.controllerDir]) {
    await ensurePrivateDirectory(dir)
  }
  return paths
}

/** Write config. Enabling requires the token file to exist and be private. */
export async function configure(root, document) {
  await initializeRoot(root)
  const { config: existing } = await readConfig(root)
  return writeConfig(root, normalizeConfig({ ...existing, ...document }, root))
}

export async function setEnabled(root, enabled) {
  const { config } = await readConfig(root)
  return writeConfig(root, { ...config, enabled })
}

/** The shared secret the server bridge and the controller use for drain/readiness. */
export async function ensureBridgeKey(root) {
  const paths = layout(root)
  await initializeRoot(root)
  if (await isFile(paths.bridgeKeyPath)) return paths.bridgeKeyPath
  await writeFileAtomic(paths.bridgeKeyPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
  return paths.bridgeKeyPath
}

/**
 * Copy the controller's own modules into <root>/controller so the daemon and
 * the launcher run from a location no candidate release can rewrite. The
 * copy is what launchd should point at.
 */
export async function installControllerCopy(root, { source = CONTROLLER_SOURCE } = {}) {
  const paths = await initializeRoot(root)
  const entries = await readdir(source, { withFileTypes: true })
  const copied = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const target = join(paths.controllerDir, entry.name)
    await copyFile(join(source, entry.name), target)
    copied.push(target)
  }
  return { directory: paths.controllerDir, files: copied.sort() }
}

/**
 * Adopt a release directory as the active baseline. `stage` is the release
 * manager's stage function (or any function returning a manifest) so callers
 * can build for real or, in tests, point at a prepared directory.
 */
export async function adoptInitialRelease(root, { sha, stage, id = newReleaseId(sha), now = () => new Date().toISOString() }) {
  const paths = await initializeRoot(root)
  const store = await openStore(paths.root, { now })
  const existing = await store.readActivePointer()
  if (existing) throw new Error(`an active release (${existing.id}) is already recorded; refusing to overwrite it`)
  const manifest = await stage({ id, sha })
  if (!await releaseIsComplete(manifest.root, manifest)) throw new Error(`release ${manifest.id} at ${manifest.root} is incomplete`)
  await store.commit('release.adopted', (draft) => {
    draft.releases[manifest.id] = { ...toRelease(manifest), rejected: false }
  }, { releaseId: manifest.id, sha })
  await store.writeActivePointer({ id: manifest.id, sha: manifest.sha, root: manifest.root, previousId: null })
  return toRelease(manifest)
}

/** What an installer needs to know before it can enable the controller. */
export async function bootstrapReport(root) {
  const paths = layout(root)
  const { config, present } = await readConfig(root)
  const pointerPresent = await pathExists(paths.activePointerPath)
  const controllerInstalled = await isFile(join(paths.controllerDir, 'daemon.mjs')) && await isFile(join(paths.controllerDir, 'launch.mjs'))
  let release = null
  if (pointerPresent) {
    const store = await openStore(root)
    const pointer = await store.readActivePointer()
    release = pointer ? await readManifest(pointer.root) : null
  }
  return {
    root,
    configPresent: present,
    enabled: config.enabled,
    tokenFile: config.tokenFile,
    tokenFilePresent: await isFile(config.tokenFile),
    bridgeKeyPresent: await isFile(config.bridgeKeyFile),
    controllerInstalled,
    activeRelease: release ? toRelease(release) : null,
  }
}
