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

/** Keep the Opus/High policy, not a version string that discovery can retire. */
export function quickSessionModel(agents: AgentInfo[]): AgentModel | undefined {
  const models = agents.find(agent => agent.id === 'claude')?.models.filter(model => /^claude-opus-\d+(?:-\d+)*$/.test(model.selector)) || []
  const latest = [...models].sort((a, b) => b.selector.localeCompare(a.selector, 'en', { numeric: true }))[0]?.selector
  return models.find(model => model.selector === latest && model.effort === 'high')
}

/** Display only: submission always uses an actual catalogue row, never a label. */
export function consoleModelLabel(identity: string, effort = identity.split('-').pop() || ''): string {
  const suffix = `-${effort}`
  const family = identity.endsWith(suffix) ? identity.slice(0, -suffix.length) : identity
  const name = family.split('-').map(part => part === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  const level = effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1)
  return `${name} · ${level}`
}

/** Resolve the draft's choice again at Send/Attach, without silent fallback. */
export function quickSessionRequest(agents: AgentInfo[], identity?: string | null): import('../server/chat/protocol').NewSessionRequest {
  identity ||= quickSessionModel(agents)?.identity
  if (!identity) throw new Error('Opus High is not in the current catalogue. Choose a model in the console.')
  const selected = identity
  const agent = agents.find(candidate => candidate.models.some(model => model.identity === selected))
  const model = agent?.models.find(candidate => candidate.identity === identity)
  const label = consoleModelLabel(identity)
  if (!model) throw new Error(`${label} is not in the current catalogue. Choose another model in the console or with New session.`)
  if (!agent?.available) throw new Error(`${label} is unavailable: ${agent?.reason || 'The provider is not ready'}. Choose another model in the console or with New session.`)
  return { agent: agent.id as import('../server/chat/protocol').AgentId, model: model.identity, effort: model.effort }
}
