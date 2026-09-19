// Ordinary Poise frontend and backend changes are automatic. Only the
// agreed release/authorization/credential, destructive-migration and
// external-package publication boundaries require human review. This policy
// is loaded from the independent controller, never the candidate checkout.
import { posix } from 'node:path'

export const PROTECTED_PATHS = new Set([
  'server/http.ts', 'server/process.ts', 'server/claude-auth.ts',
  'server/caller-release.ts', 'server/build-identity.ts', 'server/release-background.ts',
  'src/build-identity.ts', 'src/poise-request-intent.ts',
  'scripts/install-production.mjs', 'scripts/start-production.mjs',
  'scripts/update-caller.mjs', 'scripts/install-self-update.mjs',
  'scripts/build-identity.mjs', 'scripts/build-identity.d.mts', 'scripts/build-server.mjs',
  'scripts/claude-subscription.mjs', 'scripts/chat-worker-gate.mjs',
  'scripts/clean-dist.mjs', 'scripts/prepare-e2e.mjs',
  'config/caller-release.json',
])
const PROTECTED_PREFIXES = [
  'scripts/self-update/', 'scripts/self-update-', 'scripts/stop-gate',
  'server/self-update', 'src/self-update', '.github/workflows/',
]

// Tests that guard server credential handling, production install/update and
// the controller. An agent that may not change the code under test may not
// weaken the tests that fence it either.
export const PROTECTED_TEST_PATTERNS = [
  /^tests\/self-update-/,
  /^tests\/build-identity/,
  /^tests\/production-/,
  /^tests\/runtime-reconciler/,
  /^tests\/stop-gate-runtime/,
  /^tests\/caller-release/,
  /^tests\/settings-production/,
  /^tests\/http\.test\./,
  /^tests\/gh-token/,
  /^tests\/gh-merge-order/,
  /^tests\/claude-auth/,
  /^tests\/chat\/checkout-lock/,
  /^tests\/chat\/worker-gate-path/,
  /^tests\/chat-lock-review/,
]

const CREDENTIAL_SEGMENTS = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials(?:\..*)?|secrets(?:\..*)?)$/i
const CREDENTIAL_EXTENSIONS = /\.(?:pem|key|p12|pfx)$/i
const SYMLINK_MODE = '120000'
const GITLINK_MODE = '160000'

function pathViolation(path) {
  if (typeof path !== 'string' || !path) return 'empty path'
  if (/[\x00-\x1f\x7f]/.test(path)) return 'control characters in path'
  if (path !== path.trim()) return 'leading or trailing whitespace in path'
  if (path.startsWith('/') || path.includes('\\')) return 'absolute or non-canonical path'
  const segments = path.split('/')
  if (segments.some(part => !part || part === '.' || part === '..')) return 'path traversal'
  if (segments.some(part => CREDENTIAL_SEGMENTS.test(part)) || CREDENTIAL_EXTENSIONS.test(path)) return 'credential or Git-internal path'
  const lower = path.toLowerCase()
  if (PROTECTED_PATHS.has(lower) || PROTECTED_PREFIXES.some(prefix => lower.startsWith(prefix))) return 'protected release or authorization machinery'
  if (PROTECTED_TEST_PATTERNS.some(pattern => pattern.test(lower))) return 'protected security or release test'
  if (segments.some(part => part.toLowerCase() === '.gitmodules')) return 'external repository configuration'
  return null
}

/** Validate actual diff paths and modes, including both sides of renames. */
export function evaluatePolicy(entries) {
  const violations = []
  if (!Array.isArray(entries) || !entries.length) return { allowed: false, violations: [{ path: '', reason: 'no changed files' }] }
  for (const entry of entries) {
    for (const path of [entry.path, entry.oldPath].filter(value => value !== undefined)) {
      const reason = pathViolation(path)
      if (reason) violations.push({ path, reason })
    }
    if (entry.newMode === GITLINK_MODE || entry.oldMode === GITLINK_MODE) violations.push({ path: entry.path, reason: 'submodule change targets another repository' })
    if (entry.status && !/^[ACDMRT]$/.test(entry.status)) violations.push({ path: entry.path, reason: `unsupported change type ${entry.status}` })
  }
  return { allowed: !violations.length, violations }
}

// Package manifests are not blanket-protected: dependencies, metadata and
// ordinary scripts can change. The commands used to judge, build and release
// the candidate, and registry/publication identity, cannot change themselves.
const GATE_SCRIPTS = /^(?:(?:pre|post)?(?:ci|install|prepare|publish|publishOnly|pack|check|verify|test|lint|build|typecheck|clean)(?::.*)?|prepare:e2e|self-update(?::.*)?|(?:install|start):production|update:.*)$/
const VALIDATION_CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|(?:eslint|vitest|playwright|vite)\.config\.[^/]+)$/i
const MIGRATION_FILE = /(?:^|\/)(?:migrations?\/|[^/]*migration[^/]*\.)|^server\/db\.ts$/i
const DESTRUCTIVE_SQL = /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+[^;]+?\s+SET|ALTER\s+TABLE\s+[^;]+?\s+(?:DROP|RENAME|ALTER))\b/i
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export async function reviewPolicy(entries, readText) {
  const verdict = evaluatePolicy(entries)
  const violations = [...verdict.violations]
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (pathViolation(entry.path)) continue
    const path = entry.path
    const symlink = entry.newMode === SYMLINK_MODE || entry.oldMode === SYMLINK_MODE
    const manifest = /(?:^|\/)package\.json$/i.test(path)
    const migration = MIGRATION_FILE.test(path)
    if (VALIDATION_CONFIG.test(path)) { violations.push({ path, reason: 'validation/build configuration needs review' }); continue }
    if (!symlink && !manifest && !migration) continue
    const before = entry.oldMode === '000000' ? null : await readText('base', entry.oldPath || path)
    const after = entry.newMode === '000000' ? null : await readText('head', path)
    if (symlink) {
      for (const [mode, value] of [[entry.oldMode, before], [entry.newMode, after]]) {
        if (mode !== SYMLINK_MODE) continue
        const target = posix.normalize(posix.join(posix.dirname(path), String(value || '').trim()))
        if (!value || value.startsWith('/') || value.includes('\\') || target.startsWith('../') || pathViolation(target)) violations.push({ path, reason: 'symbolic link crosses the delegated workspace or protected boundary' })
      }
    }
    if (manifest) {
      let previous, next
      try { previous = before === null ? {} : JSON.parse(before); next = after === null ? {} : JSON.parse(after) }
      catch { violations.push({ path, reason: 'package manifest cannot be validated' }); continue }
      for (const key of ['repository', 'publishConfig', 'packageManager']) {
        if (stable(previous[key]) !== stable(next[key])) violations.push({ path, reason: `${key} changes release identity or validation tooling` })
      }
      const names = new Set([...Object.keys(previous.scripts || {}), ...Object.keys(next.scripts || {})])
      for (const name of names) if (GATE_SCRIPTS.test(name) && previous.scripts?.[name] !== next.scripts?.[name]) violations.push({ path, reason: `script ${name} controls validation or release` })
    }
    if (migration) {
      const oldLines = new Set(String(before || '').split('\n'))
      const changed = String(after || '').split('\n').filter(line => !oldLines.has(line)).join('\n')
      if (after === null || DESTRUCTIVE_SQL.test(changed)) violations.push({ path, reason: 'destructive data migration needs explicit review' })
    }
  }
  return { allowed: !violations.length, violations }
}

export function describeViolations(violations, limit = 12) {
  const lines = violations.slice(0, limit).map((violation) => (violation.path ? `${violation.path}: ${violation.reason}` : violation.reason))
  if (violations.length > limit) lines.push(`… and ${violations.length - limit} more`)
  return lines.join('; ')
}
