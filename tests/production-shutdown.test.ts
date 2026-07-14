import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stopPoiseRuntime: vi.fn<() => Promise<void>>(),
  closeDatabase: vi.fn<() => void>(),
  createPoiseMiddleware: vi.fn(() => (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next()),
}))

vi.mock('../server/cache-plugin', () => ({
  createPoiseMiddleware: mocks.createPoiseMiddleware,
  stopPoiseRuntime: mocks.stopPoiseRuntime,
}))

vi.mock('../server/db', () => ({
  closeDatabase: mocks.closeDatabase,
}))

beforeEach(() => {
  vi.resetModules()
  mocks.stopPoiseRuntime.mockReset()
  mocks.closeDatabase.mockReset()
  mocks.createPoiseMiddleware.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('production shutdown', () => {
  it('is idempotent and closes the database only after runtime shutdown', async () => {
    let releaseRuntime!: () => void
    mocks.stopPoiseRuntime.mockReturnValue(new Promise<void>((resolve) => {
      releaseRuntime = resolve
    }))
    const production = await import('../server/production')
    const server = production.createProductionServer()

    const first = production.shutdownProductionServer(server)
    const second = production.shutdownProductionServer(server)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1))
    expect(mocks.closeDatabase).not.toHaveBeenCalled()

    releaseRuntime()
    await first
    expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('forces shutdown once after the ten-second deadline', async () => {
    vi.useFakeTimers()
    let releaseRuntime!: () => void
    mocks.stopPoiseRuntime.mockReturnValue(new Promise<void>((resolve) => {
      releaseRuntime = resolve
    }))
    const production = await import('../server/production')
    const server = production.createProductionServer()
    const exits: number[] = []
    const shutdown = production.createProductionShutdown(server, (code) => { exits.push(code) })

    shutdown()
    shutdown()
    await Promise.resolve()
    expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1)
    expect(production.PRODUCTION_SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(mocks.closeDatabase).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])

    releaseRuntime()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
  })
})
