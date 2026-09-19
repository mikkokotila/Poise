// Controller configuration and the release token. The controller is disabled
// until an operator writes this file by hand (or through the bootstrap
// helpers) with `enabled: true` and points it at a token file that holds a
// fine-grained token scoped to mikkokotila/Poise alone. The user's `gh`
// login, GH_TOKEN and GITHUB_TOKEN are never consulted: a controller that
// silently borrowed the operator's credentials would be a controller that
// could merge into any repository the operator can.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPrivateFile, readJson, writeJsonAtomic } from './atomic.mjs'
import { BASE_BRANCH, DEFAULT_PRODUCTION_PORT, DEFAULT_RECOVERY_PORT, REPOSITORY, isSha, layout } from './paths.mjs'

export const CONFIG_VERSION = 1
export const PRODUCTION_SERVICE_LABEL = 'com.vaquum.poise'
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/

function port(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${label} must be a TCP port`)
  return value
}

/** Normalise and validate a config document. Throws on anything unexpected. */
export function normalizeConfig(raw, root) {
  const paths = layout(root)
  const document = raw && typeof raw === 'object' ? raw : {}
  if (document.repository !== undefined && document.repository !== REPOSITORY) {
    throw new Error(`self-update is pinned to ${REPOSITORY}; refusing repository ${JSON.stringify(document.repository)}`)
  }
  if (document.branch !== undefined && document.branch !== BASE_BRANCH) {
    throw new Error(`self-update is pinned to branch ${BASE_BRANCH}; refusing ${JSON.stringify(document.branch)}`)
  }
  if (document.callerSha !== undefined && document.callerSha !== null && !isSha(document.callerSha)) {
    throw new Error('callerSha must be a 40-character commit SHA')
  }
  for (const key of ['tokenFile', 'bridgeKeyFile', 'nodeBin']) {
    const value = document[key]
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.startsWith('/'))) {
      throw new Error(`${key} must be an absolute path`)
    }
  }
  return {
    version: CONFIG_VERSION,
    enabled: document.enabled === true,
    repository: REPOSITORY,
    branch: BASE_BRANCH,
    tokenFile: document.tokenFile || join(root, 'release-token'),
    bridgeKeyFile: document.bridgeKeyFile || paths.bridgeKeyPath,
    productionPort: port(document.productionPort, DEFAULT_PRODUCTION_PORT, 'productionPort'),
    recoveryPort: port(document.recoveryPort, DEFAULT_RECOVERY_PORT, 'recoveryPort'),
    productionServiceLabel: typeof document.productionServiceLabel === 'string' && document.productionServiceLabel
      ? document.productionServiceLabel
      : PRODUCTION_SERVICE_LABEL,
    callerSha: document.callerSha || null,
    nodeBin: document.nodeBin || null,
  }
}

/** Absent config means disabled; a malformed one is an error the status reports. */
export async function readConfig(root, env = process.env) {
  const document = await readJson(layout(root).configPath, null)
  const config = normalizeConfig(document ?? { enabled: false }, root)
  if (env.POISE_RELEASE_TOKEN_FILE) config.tokenFile = env.POISE_RELEASE_TOKEN_FILE
  return { config, present: document !== null }
}

export async function writeConfig(root, document) {
  const config = normalizeConfig(document, root)
  await writeJsonAtomic(layout(root).configPath, config)
  return config
}

/** The release token, read fresh on each use so rotation needs no restart. */
export async function loadReleaseToken(tokenFile, options) {
  await assertPrivateFile(tokenFile, 'release token file', options)
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (!TOKEN_PATTERN.test(token)) throw new Error('release token file does not contain a GitHub token')
  return token
}

/** Whether the controller may act at all, and why not when it cannot. */
export async function assessEnablement(root, env = process.env) {
  let config
  let present
  try {
    ({ config, present } = await readConfig(root, env))
  } catch (error) {
    return { enabled: false, config: null, reason: `self-update config is invalid: ${error.message}` }
  }
  if (!present) return { enabled: false, config, reason: 'self-update is not bootstrapped' }
  if (!config.enabled) return { enabled: false, config, reason: 'self-update is disabled in config' }
  try {
    await loadReleaseToken(config.tokenFile)
  } catch (error) {
    return { enabled: false, config, reason: `release token unavailable: ${error.message}` }
  }
  return { enabled: true, config, reason: null }
}
