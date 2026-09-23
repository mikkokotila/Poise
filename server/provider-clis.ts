import { trackReleaseBackground } from './release-background'
import { ensureProviderCli, type Provider, type CliUpdate } from '../scripts/provider-cli-updates.mjs'
import type { Catalog } from './models'

/** Cancelling one startup must not cancel an update shared by another chat. */
export async function prepareProviderCli(provider: Provider, signal?: AbortSignal): Promise<CliUpdate> {
  signal?.throwIfAborted()
  const finished = trackReleaseBackground()
  const task = ensureProviderCli(provider).finally(finished)
  if (!signal) return task
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('CLI startup cancelled'))
    signal.addEventListener('abort', aborted, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

/** Existing Caller-backed surfaces use the same maintenance as native Chat. */
export async function prepareModelClis(catalog: Catalog, identities: string[]): Promise<void> {
  const providers = new Set(identities.map(identity => catalog.models.find(row => row.identity === identity)?.provider).filter(Boolean) as Provider[])
  await Promise.all([...providers].map(async provider => {
    const result = await prepareProviderCli(provider)
    if (result.status === 'unavailable') console.warn(`[models] ${provider}: latest CLI could not be verified — ${result.error}`)
  }))
}
