import { describe, expect, it } from 'vitest'
import { productionSummary, type ProductionUpdate } from '../src/production-status'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const NOW = Date.parse('2026-09-18T12:00:00.000Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function update(overrides: Partial<ProductionUpdate> = {}): ProductionUpdate {
  return {
    status: 'current',
    checkedAt: minutesBefore(1),
    deployedCommit: A,
    remoteCommit: A,
    behind: 0,
    failingSince: null,
    error: null,
    ...overrides,
  }
}

// The Settings line is the one place that says whether a merge reached
// production. It reads as a sentence, names both commits, and turns red only
// when the updater is failing or has stopped.
describe('production summary in Settings', () => {
  it('says nothing without a record, so the group can hide', () => {
    expect(productionSummary(update({ status: 'unknown', checkedAt: null }), NOW)).toBeNull()
  })

  it('shows both commits and when the updater last looked', () => {
    expect(productionSummary(update(), NOW)).toEqual({
      text: 'Deployed aaaaaaa · main aaaaaaa — up to date, checked 1 min ago.',
      level: 'info',
    })
    expect(productionSummary(update({ status: 'updated', checkedAt: minutesBefore(0) }), NOW)?.text)
      .toBe('Deployed aaaaaaa · main aaaaaaa — up to date, checked just now.')
  })

  it('names the failure, how long it has lasted and how far behind main is', () => {
    const failing = update({
      status: 'failed',
      remoteCommit: B,
      behind: 2,
      failingSince: '2026-09-18T11:52:00.000Z',
      error: 'Remote Poise main is not a fast-forward of the deployed commit',
    })
    const summary = productionSummary(failing, NOW)
    expect(summary?.level).toBe('error')
    expect(summary?.text).toMatch(/^Deployed aaaaaaa · main bbbbbbb — 2 commits behind; updater failing since \d{1,2}:\d{2}(?: [AP]M)?: Remote Poise main is not a fast-forward of the deployed commit$/)
    expect(productionSummary(update({ status: 'failed', remoteCommit: null, behind: null }), NOW)?.text)
      .toBe('Deployed aaaaaaa; updater failing: no error recorded')
  })

  it('treats a record that stopped arriving as the most important fact', () => {
    const summary = productionSummary(update({ checkedAt: minutesBefore(10) }), NOW)
    expect(summary?.level).toBe('error')
    expect(summary?.text).toMatch(/^Deployed aaaaaaa — the updater has not run since \d{1,2}:\d{2}(?: [AP]M)?; merges are not reaching production\.$/)
  })
})
