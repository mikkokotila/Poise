// The production updater (update-caller.mjs, launchd every minute) records
// the outcome of each run here. Two readers: the health monitor, which tells
// the operator when the updater has been failing or has stopped running, and
// the server's /api/health, which lets Settings show the deployed commit
// against `main`.
//
// Without this record a stuck updater was invisible: the service stayed
// healthy on an old commit, every failure went to caller-update.err.log, and
// nothing said that a merge had not reached production.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Five consecutive failed ticks before anyone is told. One failure is a
// transient fetch error; five is a stuck updater.
export const FAILING_NOTIFY_AFTER_MS = 5 * 60_000
// The job runs every minute; ten minutes without a record means launchd is
// not running it at all (booted out, a moved checkout, a plist that points
// at nothing).
export const SILENT_NOTIFY_AFTER_MS = 10 * 60_000

const SHA_PATTERN = /^[0-9a-f]{40}$/

export function productionUpdatePath(home) {
  return process.env.POISE_PRODUCTION_UPDATE_REPORT || join(home, '.poise', 'production-update.json')
}

export async function readProductionUpdate(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'))
    return state && typeof state === 'object' ? state : null
  } catch {
    return null
  }
}

export async function writeProductionUpdate(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.tmp`
  await writeFile(staged, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(staged, path)
}

export function shortCommit(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value.slice(0, 7) : null
}

function parseTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : null
}

// What the record says about the updater right now.
//
//   ok        the last run succeeded
//   retrying  the last run failed, less than FAILING_NOTIFY_AFTER_MS ago
//   failing   runs have been failing for FAILING_NOTIFY_AFTER_MS or longer
//   silent    no run has been recorded for SILENT_NOTIFY_AFTER_MS or longer
//   unknown   no usable record
export function assessUpdater(state, now = Date.now()) {
  const at = parseTime(state?.at)
  if (at === null) return { status: 'unknown', since: null, minutes: 0 }
  if (now - at >= SILENT_NOTIFY_AFTER_MS) {
    return { status: 'silent', since: state.at, minutes: Math.floor((now - at) / 60_000) }
  }
  if (state.status === 'failed') {
    const since = parseTime(state.failingSince) ?? at
    const minutes = Math.floor((now - since) / 60_000)
    return {
      status: now - since >= FAILING_NOTIFY_AFTER_MS ? 'failing' : 'retrying',
      since: new Date(since).toISOString(),
      minutes,
    }
  }
  return { status: 'ok', since: null, minutes: 0 }
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || 'no error recorded'
}

function staysOn(state) {
  const deployed = shortCommit(state?.poise?.deployed)
  if (!deployed) return ''
  const behind = Number.isInteger(state?.poise?.behind) && state.poise.behind > 0
    ? `, ${state.poise.behind} commit${state.poise.behind === 1 ? '' : 's'} behind main`
    : ''
  return ` Production stays on ${deployed}${behind}.`
}

// The monitor runs every minute too, so an alert is raised once per episode
// and cleared once on recovery. `alerted` is the last alert the monitor sent
// ('failing' | 'silent' | null); `previous` is the status it saw last time.
//
// Silence needs two consecutive observations: after the machine sleeps, the
// monitor and the updater both fire on wake in no particular order, and one
// stale record at that moment is not a stuck updater.
export function updaterAlert({ previous = null, alerted = null }, assessment, state) {
  if (assessment.status === 'failing' && alerted !== 'failing') {
    return {
      alerted: 'failing',
      message: `Production updater has been failing for ${assessment.minutes} minutes: ${firstLine(state?.error)}.${staysOn(state)}`,
    }
  }
  if (assessment.status === 'silent' && previous === 'silent' && alerted !== 'silent') {
    return {
      alerted: 'silent',
      message: `Production updater has not run for ${assessment.minutes} minutes.${staysOn(state)}`,
    }
  }
  if (assessment.status === 'ok' && alerted) {
    const deployed = shortCommit(state?.poise?.deployed)
    return {
      alerted: null,
      message: `Production updater recovered${deployed ? `; production is on ${deployed}` : ''}.`,
    }
  }
  return { alerted, message: null }
}
