import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), invalidate: vi.fn() }))
vi.mock('../server/process', () => ({
  CLAUDE_SUBSCRIPTION_CLI: '/poise/scripts/claude-subscription.mjs',
  claudeSubscriptionEnvironment: () => ({}), scrubbedChildEnvironment: () => ({}), runFile: mocks.run,
}))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/caller', catalogReportPath: () => '/poise/report.json', invalidateCatalog: mocks.invalidate }))
import { refreshModelCatalog } from '../server/models-refresh'
beforeEach(() => { mocks.run.mockReset(); mocks.invalidate.mockClear() })
it('coalesces manual checks and invalidates the catalogue only after settlement', async () => {
  let finish!: (result: { stdout: string }) => void
  mocks.run.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = refreshModelCatalog(), second = refreshModelCatalog()
  expect(first).toBe(second); expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(mocks.invalidate).not.toHaveBeenCalled()
  finish({ stdout: JSON.stringify({ families: { claude: { status: 'ok' } } }) })
  await first; expect(mocks.invalidate).toHaveBeenCalledTimes(1)
})
it('returns a structured discovery failure even when the script exits nonzero', async () => {
  const report = { families: {}, error: 'Discovery timed out', cli_updates: { claude: { status: 'current', after: '2.1.280' } } }
  mocks.run.mockRejectedValueOnce(Object.assign(new Error('process exited 1'), { stdout: JSON.stringify(report) }))
  await expect(refreshModelCatalog()).resolves.toEqual(report)
  expect(mocks.invalidate).toHaveBeenCalledTimes(1)
})
it('a failed process clears the pending check so retry can run', async () => {
  mocks.run.mockRejectedValueOnce(new Error('process unavailable'))
  await expect(refreshModelCatalog()).rejects.toThrow('process unavailable')
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify({ families: { claude: { status: 'ok' } } }) })
  await expect(refreshModelCatalog()).resolves.toHaveProperty('families'); expect(mocks.run).toHaveBeenCalledTimes(2)
})
