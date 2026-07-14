import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ConfigModule = typeof import('../../src/config')

let config: ConfigModule

beforeAll(async () => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })
  config = await import('../../src/config')
})

beforeEach(() => {
  vi.useFakeTimers()
  config.setLocalSettings({ org: '', me: '', timezone: 'UTC' })
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('settings cache', () => {
  it('loads valid server settings into the synchronous cache', async () => {
    const settings = { org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(settings), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    await expect(config.loadSettings()).resolves.toEqual(settings)
    expect(config.getSettings()).toEqual(settings)
    expect(config.settingsLoaded()).toBe(true)
    expect(config.settingsReady()).toBe(true)
  })

  it('keeps the prior cache when the settings request fails', async () => {
    const prior = { org: 'acme', me: 'octocat', timezone: 'UTC' }
    config.setLocalSettings(prior)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(config.loadSettings()).resolves.toEqual(prior)
    expect(config.getSettings()).toEqual(prior)
  })
})

describe('configured timezone boundaries', () => {
  it('returns local midnight across standard and daylight time', () => {
    config.setLocalSettings({ org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' })

    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'))
    expect(config.midnightInZone().toISOString()).toBe('2026-01-13T22:00:00.000Z')

    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'))
    expect(config.midnightInZone().toISOString()).toBe('2026-07-09T21:00:00.000Z')
  })

  it('starts the local week at Monday midnight', () => {
    config.setLocalSettings({ org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' })
    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'))

    expect(config.startOfWeekInZone().toISOString()).toBe('2026-01-11T22:00:00.000Z')
  })
})
