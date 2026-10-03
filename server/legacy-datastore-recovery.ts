import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { db } from './db'
import { runFile } from './process'
import type { Organization } from './organizations'

const LABEL = 'com.vaquum.github-datastore.sync'
const RETRY_MS = 60_000
const shell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// Wake only Poise's installed sync job, never take over an external datastore
// or kill a running sync. launchd coalesces kickstart for an already live job.
export async function recoverLegacyDatastore(org: Organization | null, signal?: AbortSignal): Promise<boolean> {
  const bin = process.env.CALLER_BIN_ROOT
  const databasePath = org?.datastorePath
  if (process.platform !== 'darwin' || org?.managed !== false || !databasePath
    || !bin || !isAbsolute(bin)) return false
  signal?.throwIfAborted()
  const now = Date.now()
  const key = `legacy_datastore_sync_recovery:${databasePath}`
  const claimed = db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(meta.value AS INTEGER) <= ?
  `).run(key, String(now + RETRY_MS), now).changes
  if (!claimed) return false
  const { stdout } = await runFile('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  ], { signal, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 })
  const job = JSON.parse(stdout) as { Label?: unknown, ProgramArguments?: unknown }
  const args = job.ProgramArguments
  if (job.Label !== LABEL || !Array.isArray(args) || args.length !== 3
    || args[0] !== '/bin/zsh' || args[1] !== '-lc' || typeof args[2] !== 'string'
    || !["'sync' '--workers' '12'", "'sync' '--loop' '--interval' '60' '--workers' '12'"].some((syncArgs) =>
      args[2].endsWith(`exec ${shell(join(bin, 'github-datastore'))} --db ${shell(databasePath)} ${syncArgs}`))) return false
  if (typeof process.getuid !== 'function') return false
  await runFile('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`], {
    signal, timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  })
  return true
}
