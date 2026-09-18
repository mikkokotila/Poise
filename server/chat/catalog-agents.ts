import type { Catalog } from '../models'
import type { AgentId } from './protocol'
import { AGENT_IDS, AGENT_LABELS } from './protocol'
import type { AgentAvailability } from './runtime'

/** Catalogue membership is independent of native-adapter and sign-in readiness. */
export async function catalogueAgents(
  catalog: Catalog,
  claudeReady: boolean,
  probe: (agent: AgentId) => Promise<{ ok: boolean, reason?: string }>,
): Promise<AgentAvailability[]> {
  return Promise.all([...new Set(catalog.models.map(m => m.provider))].map(async provider => {
    const native = AGENT_IDS.find(id => id === provider)
    const models = catalog.models.filter(m => m.provider === provider)
    let available = !!native
    let reason = native ? undefined : provider === 'antigravity'
      ? 'Antigravity is in the catalogue, but its installed CLI has no interactive permission/question channel for Chat'
      : `No interactive Chat adapter is available for ${provider}`
    if (native === 'claude' && !claudeReady) { available = false; reason = 'Claude.ai sign-in is not ready' }
    if (native && available) {
      const result = await probe(native)
      available = result.ok
      reason = result.reason
    }
    return { id: provider, label: native ? AGENT_LABELS[native] : provider === 'antigravity' ? 'Antigravity (Google)' : provider,
      available, reason, models, efforts: [...new Set(models.map(m => m.effort))] }
  }))
}
