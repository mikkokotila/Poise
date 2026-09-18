// The production updater (scripts/update-caller.mjs, launchd every minute)
// records each run in ~/.poise/production-update.json. /api/health passes a
// validated view of it through so Settings can show the deployed commit
// against `main`, and say so when a merge is not reaching production.
//
// The server only reads the record. Whether the updater is *stuck* is the
// health monitor's call (scripts/production-update.mjs holds the thresholds);
// the UI shows the facts — when it last ran, what it found, what went wrong.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProductionUpdateHealth {
  // `unknown` when there is no usable record (a dev server, or a production
  // install that predates the record).
  status: 'current' | 'updated' | 'failed' | 'unknown'
  checkedAt: string | null
  deployedCommit: string | null
  remoteCommit: string | null
  // Commits on `main` the checkout does not have; null when not known.
  behind: number | null
  failingSince: string | null
  error: string | null
}

const SHA_PATTERN = /^[0-9a-f]{40}$/

export function productionUpdatePath(): string {
  return process.env.POISE_PRODUCTION_UPDATE_REPORT || join(homedir(), '.poise', 'production-update.json')
}

const UNKNOWN: ProductionUpdateHealth = {
  status: 'unknown',
  checkedAt: null,
  deployedCommit: null,
  remoteCommit: null,
  behind: null,
  failingSince: null,
  error: null,
}

function commit(value: unknown): string | null {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value : null
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

export async function getProductionUpdateHealth(): Promise<ProductionUpdateHealth> {
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readFile(productionUpdatePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return UNKNOWN
    record = parsed as Record<string, unknown>
  } catch {
    return UNKNOWN
  }
  const checkedAt = timestamp(record.at)
  const status = record.status
  if (!checkedAt || (status !== 'current' && status !== 'updated' && status !== 'failed')) return UNKNOWN
  const poise = record.poise && typeof record.poise === 'object'
    ? record.poise as Record<string, unknown>
    : {}
  return {
    status,
    checkedAt,
    deployedCommit: commit(poise.deployed),
    remoteCommit: commit(poise.remote),
    behind: Number.isInteger(poise.behind) && (poise.behind as number) >= 0 ? poise.behind as number : null,
    failingSince: status === 'failed' ? timestamp(record.failingSince) : null,
    error: status === 'failed' && typeof record.error === 'string' && record.error.trim()
      ? record.error.trim().slice(0, 500)
      : null,
  }
}
