import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessUpdater,
  productionUpdatePath,
  readProductionUpdate,
  updaterAlert,
  writeProductionUpdate,
} from '../scripts/production-update.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const NOW = Date.parse('2026-09-18T12:00:00.000Z')
const minutesBefore = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

function record(overrides = {}) {
  return {
    at: minutesBefore(1),
    status: 'current',
    action: 'current',
    error: null,
    failingSince: null,
    poise: { deployed: A, installed: A, remote: A, behind: 0 },
    caller: B,
    ...overrides,
  }
}

describe('production update record', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
    delete process.env.POISE_PRODUCTION_UPDATE_REPORT
  })

  it('lives under ~/.poise unless overridden for tests', () => {
    expect(productionUpdatePath('/home/test')).toBe('/home/test/.poise/production-update.json')
    process.env.POISE_PRODUCTION_UPDATE_REPORT = '/elsewhere/update.json'
    expect(productionUpdatePath('/home/test')).toBe('/elsewhere/update.json')
  })

  it('round-trips a record and reads a missing or broken one as null', async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-update-'))
    const path = join(root, 'nested', 'production-update.json')
    expect(await readProductionUpdate(path)).toBeNull()
    await writeProductionUpdate(path, record())
    expect(await readProductionUpdate(path)).toEqual(record())
    expect(await readFile(path, 'utf8')).toMatch(/\n$/)
    await writeProductionUpdate(path, record({ status: 'failed' }))
    expect((await readProductionUpdate(path)).status).toBe('failed')
  })
})

describe('updater assessment', () => {
  it('is unknown without a usable record', () => {
    expect(assessUpdater(null, NOW)).toEqual({ status: 'unknown', since: null, minutes: 0 })
    expect(assessUpdater({ at: 'yesterday' }, NOW).status).toBe('unknown')
  })

  it('is ok after a successful run', () => {
    expect(assessUpdater(record(), NOW)).toEqual({ status: 'ok', since: null, minutes: 0 })
    expect(assessUpdater(record({ status: 'updated' }), NOW).status).toBe('ok')
  })

  it('tolerates a fresh failure and reports a sustained one', () => {
    const fresh = record({ status: 'failed', failingSince: minutesBefore(2), error: 'fetch failed' })
    expect(assessUpdater(fresh, NOW)).toEqual({ status: 'retrying', since: minutesBefore(2), minutes: 2 })
    const sustained = record({ status: 'failed', failingSince: minutesBefore(7), error: 'fetch failed' })
    expect(assessUpdater(sustained, NOW)).toEqual({ status: 'failing', since: minutesBefore(7), minutes: 7 })
    // A failed record without a start time counts from the run itself.
    expect(assessUpdater(record({ at: minutesBefore(6), status: 'failed' }), NOW).status).toBe('failing')
  })

  it('reports silence when the job has stopped running, whatever it last found', () => {
    expect(assessUpdater(record({ at: minutesBefore(10) }), NOW)).toEqual({ status: 'silent', since: minutesBefore(10), minutes: 10 })
    expect(assessUpdater(record({ at: minutesBefore(9) }), NOW).status).toBe('ok')
    expect(assessUpdater(record({ at: minutesBefore(30), status: 'failed', failingSince: minutesBefore(45) }), NOW).status).toBe('silent')
  })
})

describe('updater alerts', () => {
  const failing = record({
    status: 'failed',
    failingSince: minutesBefore(6),
    error: 'Remote Poise main is not a fast-forward of the deployed commit\n    at reconcile',
    poise: { deployed: A, installed: A, remote: B, behind: 2 },
  })

  it('raises one alert for a sustained failure and none while it persists', () => {
    const first = updaterAlert({ previous: 'retrying', alerted: null }, assessUpdater(failing, NOW), failing)
    expect(first).toEqual({
      alerted: 'failing',
      message: `Production updater has been failing for 6 minutes: Remote Poise main is not a fast-forward of the deployed commit. Production stays on ${A.slice(0, 7)}, 2 commits behind main.`,
    })
    const again = updaterAlert({ previous: 'failing', alerted: 'failing' }, assessUpdater(failing, NOW), failing)
    expect(again).toEqual({ alerted: 'failing', message: null })
  })

  it('stays quiet while a failure is fresh', () => {
    const fresh = record({ status: 'failed', failingSince: minutesBefore(1), error: 'gh: Not Found' })
    expect(updaterAlert({ previous: 'ok', alerted: null }, assessUpdater(fresh, NOW), fresh)).toEqual({ alerted: null, message: null })
  })

  it('needs two consecutive silent observations before alerting', () => {
    const silent = record({ at: minutesBefore(12) })
    const assessment = assessUpdater(silent, NOW)
    expect(updaterAlert({ previous: 'ok', alerted: null }, assessment, silent)).toEqual({ alerted: null, message: null })
    expect(updaterAlert({ previous: 'silent', alerted: null }, assessment, silent)).toEqual({
      alerted: 'silent',
      message: `Production updater has not run for 12 minutes. Production stays on ${A.slice(0, 7)}.`,
    })
    expect(updaterAlert({ previous: 'silent', alerted: 'silent' }, assessment, silent)).toEqual({ alerted: 'silent', message: null })
  })

  it('announces recovery once and clears the alert', () => {
    const healthy = record({ poise: { deployed: B, installed: B, remote: B, behind: 0 } })
    expect(updaterAlert({ previous: 'failing', alerted: 'failing' }, assessUpdater(healthy, NOW), healthy)).toEqual({
      alerted: null,
      message: `Production updater recovered; production is on ${B.slice(0, 7)}.`,
    })
    expect(updaterAlert({ previous: 'ok', alerted: null }, assessUpdater(healthy, NOW), healthy)).toEqual({ alerted: null, message: null })
  })
})
