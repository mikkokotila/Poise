// Layout of the self-update root. Everything the controller trusts — its
// config, its token, its journal, the active-release pointer and the trusted
// copy of the controller itself — lives here, outside any promoted source or
// build artifact, so a candidate release can never rewrite the rules that
// judge it.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const REPOSITORY = 'mikkokotila/Poise'
export const BASE_BRANCH = 'main'
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`
export const DEFAULT_RECOVERY_PORT = 5556
export const DEFAULT_PRODUCTION_PORT = 5555

export function selfUpdateRoot(env = process.env, home = homedir()) {
  const configured = env.POISE_SELF_UPDATE_ROOT
  return configured && configured.trim() ? configured : join(home, '.poise', 'self-update')
}

export function layout(root) {
  return {
    root,
    configPath: join(root, 'config.json'),
    statePath: join(root, 'state.json'),
    journalPath: join(root, 'journal.ndjson'),
    lockPath: join(root, 'controller.lock'),
    heartbeatPath: join(root, 'heartbeat.json'),
    socketPath: join(root, 'control.sock'),
    activePointerPath: join(root, 'active-release.json'),
    releasesDir: join(root, 'releases'),
    workspacesDir: join(root, 'workspaces'),
    logsDir: join(root, 'logs'),
    controllerDir: join(root, 'controller'),
    bridgeKeyPath: join(root, 'bridge.key'),
  }
}

export function changeBranch(changeId) {
  return `poise/change-${changeId}`
}

export function revertBranch(changeId) {
  return `poise/revert-${changeId}`
}

export function pullRequestUrl(number) {
  return `https://github.com/${REPOSITORY}/pull/${number}`
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SHA_PATTERN = /^[0-9a-f]{40}$/
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value)
}

export function isReleaseId(value) {
  return typeof value === 'string' && RELEASE_ID_PATTERN.test(value)
}
