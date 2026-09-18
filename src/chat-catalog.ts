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
