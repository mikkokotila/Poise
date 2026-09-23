// The normal suite must never upgrade the developer's real CLI installations.
// Updater tests exercise the real implementation with isolated fake executables.
import { vi } from 'vitest'

vi.mock('../server/provider-clis', () => ({
  prepareProviderCli: vi.fn(async (provider: string) => ({ provider, status: 'current', checkedAt: new Date().toISOString(), after: '1.0.0' })),
  prepareModelClis: vi.fn(async () => undefined),
}))
