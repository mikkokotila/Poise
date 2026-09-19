import type { AgentInfo, AgentModel } from './chat-client'

export interface ModelFamily {
  key: string
  label: string
  agent: AgentInfo
  models: AgentModel[]
}

/** One visible family, with exactly the effort variants the catalogue contains. */
export function catalogueFamilies(agents: AgentInfo[]): ModelFamily[] {
  return agents.flatMap(agent => {
    const groups = new Map<string, AgentModel[]>()
    for (const model of agent.models) {
      const rows = groups.get(model.selector) ?? []
      rows.push(model)
      groups.set(model.selector, rows)
    }
    return [...groups.values()].map(models => {
      const first = models[0]
      const suffix = `-${first.effort}`
      return { key: first.identity, label: first.identity.endsWith(suffix) ? first.identity.slice(0, -suffix.length) : first.selector, agent, models }
    })
  })
}

export function familyForIdentity(families: ModelFamily[], identity: string): ModelFamily | undefined {
  return families.find(family => family.models.some(model => model.identity === identity))
}

/** The fresh console has a deliberate default, independent of dialog settings.
 * Resolve it in the current catalogue; never silently send to another model. */
export function quickSessionRequest(agents: AgentInfo[]): import('../server/chat/protocol').NewSessionRequest {
  const agent = agents.find(candidate => candidate.id === 'claude')
  const model = agent?.models.find(candidate => candidate.identity === 'opus-5-high' && candidate.effort === 'high')
  if (!model) throw new Error('Opus 5 High is not in the current catalogue. Choose a model with New session.')
  if (!agent?.available) throw new Error(`Opus 5 High is unavailable: ${agent?.reason || 'Claude Code is not ready'}. Choose a model with New session.`)
  return { agent: 'claude', model: model.identity, effort: model.effort }
}
