import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import release from '../config/caller-release.json'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const COMMANDS = ['agent-interface', 'github-datastore', 'github-interface'] as const

interface ReleaseMarker {
  repository?: unknown
  commit?: unknown
  packages?: unknown
}

export interface CallerReleaseHealth {
  status: 'ready' | 'unmanaged' | 'invalid'
  required: boolean
  expectedCommit: string
  actualCommit: string | null
  packages: Record<string, string>
  error: string | null
}

function invalid(required: boolean, actualCommit: string | null, error: string): CallerReleaseHealth {
  return {
    status: 'invalid',
    required,
    expectedCommit: release.commit,
    actualCommit,
    packages: release.packages,
    error,
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function getCallerReleaseHealth(): Promise<CallerReleaseHealth> {
  const required = process.env.POISE_ENFORCE_CALLER_RELEASE === '1'
  const actualCommit = process.env.CALLER_RELEASE_SHA?.trim().toLowerCase() || null
  const releaseRoot = process.env.CALLER_RELEASE_ROOT?.trim() || ''
  const binRoot = process.env.CALLER_BIN_ROOT?.trim() || ''
  const agentRoot = process.env.AGENT_INTERFACE_ROOT?.trim() || ''
  if (!required && !actualCommit && !releaseRoot && !binRoot) {
    return {
      status: 'unmanaged',
      required,
      expectedCommit: release.commit,
      actualCommit: null,
      packages: release.packages,
      error: null,
    }
  }
  if (!SHA_PATTERN.test(release.commit) || actualCommit !== release.commit) {
    return invalid(required, actualCommit, 'Caller release commit does not match the Poise manifest')
  }
  if (![releaseRoot, binRoot, agentRoot].every(isAbsolute)) {
    return invalid(required, actualCommit, 'Caller release paths must be absolute')
  }

  try {
    const [resolvedReleaseRoot, resolvedBinRoot, resolvedAgentRoot] = await Promise.all([
      realpath(releaseRoot),
      realpath(binRoot),
      realpath(agentRoot),
    ])
    if (!isWithin(resolvedReleaseRoot, resolvedBinRoot)
      || !isWithin(resolvedReleaseRoot, resolvedAgentRoot)) {
      return invalid(required, actualCommit, 'Caller release paths escape the pinned release root')
    }
    const markerPath = join(resolvedReleaseRoot, 'release.json')
    const markerStat = await stat(markerPath)
    if (!markerStat.isFile()) {
      return invalid(required, actualCommit, 'Caller release marker is not a regular file')
    }
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as ReleaseMarker
    if (marker.repository !== release.repository
      || marker.commit !== release.commit
      || JSON.stringify(marker.packages) !== JSON.stringify(release.packages)) {
      return invalid(required, actualCommit, 'Caller release marker does not match the Poise manifest')
    }
    await Promise.all(COMMANDS.map(async (command) => {
      const commandPath = join(resolvedBinRoot, command)
      await access(commandPath, constants.X_OK)
      const firstLine = (await readFile(commandPath, 'utf8')).split('\n', 1)[0]
      if (!firstLine.startsWith('#!')) throw new Error('Caller entrypoint has no interpreter')
      const interpreter = firstLine.slice(2).trim().split(/\s+/, 1)[0]
      await access(interpreter, constants.X_OK)
    }))
  } catch {
    return invalid(required, actualCommit, 'Caller release files are missing or unreadable')
  }

  return {
    status: 'ready',
    required,
    expectedCommit: release.commit,
    actualCommit,
    packages: release.packages,
    error: null,
  }
}

export async function assertCallerRelease(): Promise<void> {
  if (process.env.POISE_ENFORCE_CALLER_RELEASE !== '1') {
    throw new Error('POISE_ENFORCE_CALLER_RELEASE=1 is required for production')
  }
  const health = await getCallerReleaseHealth()
  if (health.status !== 'ready') throw new Error(health.error || 'Caller release is not ready')
}
