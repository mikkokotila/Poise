import { describe, expect, it, vi } from 'vitest'
import { catalogueAgents } from '../../server/chat/catalog-agents'
import { catalogueFamilies, familyForIdentity, quickSessionRequest, consoleModelLabel } from '../../src/chat-catalog'
import { CATALOG } from '../model-catalog-fixture'

describe('Chat uses the whole catalogue', () => {
  it('includes all five providers and every identity even when an adapter is unavailable', async () => {
    const probe = vi.fn(async () => ({ ok: true }))
    const agents = await catalogueAgents(CATALOG, true, probe)
    expect(agents.map(a => a.id)).toEqual(['claude', 'codex', 'grok', 'antigravity', 'muse'])
    expect(agents.flatMap(a => a.models.map(m => m.identity))).toEqual(CATALOG.models.map(m => m.identity))
    expect(agents.find(a => a.id === 'antigravity')).toMatchObject({ available: false, efforts: ['high', 'medium'], reason: expect.stringContaining('permission/question') })
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('does not drop models merely because their provider is signed out', async () => {
    const agents = await catalogueAgents(CATALOG, false, async () => ({ ok: false, reason: 'sign-in needed' }))
    expect(agents.every(a => !a.available)).toBe(true)
    expect(agents.flatMap(a => a.models)).toHaveLength(CATALOG.models.length)
  })

  it('groups model families without combining their effort variants', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    const families = catalogueFamilies(agents)
    for (const row of CATALOG.models) {
      const family = familyForIdentity(families, row.identity)!
      expect(family.agent.id).toBe(row.provider)
      expect(family.models.find(m => m.effort === row.effort)).toEqual(row)
      expect(family.models.every(m => m.selector === row.selector)).toBe(true)
    }
    expect(familyForIdentity(families, 'gemini-3.8-flash-medium')?.models.map(m => m.effort)).toEqual(['high', 'medium'])
    expect(familyForIdentity(families, 'gpt-6-astra-ultra')?.models.map(m => m.effort)).toEqual(['ultra', 'max'])
  })
})


describe('Fresh console model policy', () => {
  const model = { identity: 'opus-5-high', provider: 'claude', selector: 'claude-opus-5', effort: 'high' }
  const catalog = { ...CATALOG, models: [...CATALOG.models, model] }
  it('uses exactly the catalogue Opus 5 High variant, independent of the configured default', async () => {
    const agents = await catalogueAgents(catalog, true, async () => ({ ok: true }))
    expect(quickSessionRequest(agents)).toEqual({ agent: 'claude', model: 'opus-5-high', effort: 'high' })
  })
  it('does not substitute another effort when the requested default has retired', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents)).toThrow(/not in the current catalogue/)
  })
  it('does not silently fall back when Claude is signed out', async () => {
    const agents = await catalogueAgents(catalog, false, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents)).toThrow(/unavailable/)
  })
})


describe('Console model selection', () => {
  it('resolves every launchable catalogue variant, not just the default', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    for (const agent of agents.filter(a => a.available)) for (const model of agent.models) {
      expect(quickSessionRequest(agents, model.identity)).toEqual({ agent: agent.id, model: model.identity, effort: model.effort })
    }
  })
  it('keeps unavailable and retired selections from silently becoming a different model', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents, 'gemini-3.8-flash-high')).toThrow(/unavailable/)
    expect(() => quickSessionRequest(agents, 'retired-model-max')).toThrow(/not in the current catalogue/)
  })
  it('labels the actual family and effort without changing catalogue identities', () => {
    expect(consoleModelLabel('opus-5-high')).toBe('Opus 5 · High')
    expect(consoleModelLabel('gpt-6-astra-max')).toBe('GPT 6 Astra · Max')
    expect(consoleModelLabel('muse-spark-1.3-contributor-xhigh')).toBe('Muse Spark 1.3 Contributor · Extra high')
  })
})

// New CLI releases retire yesterday's concrete default, not the Opus/High policy.
it('follows the latest discovered Opus High without rewriting explicit choices', async () => {
  const models = [
    { identity: 'opus-5-high', provider: 'claude', selector: 'claude-opus-5', effort: 'high' },
    { identity: 'opus-5.5-high', provider: 'claude', selector: 'claude-opus-5-5', effort: 'high' },
    { identity: 'opus-5.10-high', provider: 'claude', selector: 'claude-opus-5-10', effort: 'high' },
  ]
  const agents = await catalogueAgents({ ...CATALOG, models }, true, async () => ({ ok: true }))
  expect(quickSessionRequest(agents)).toMatchObject({ model: 'opus-5.10-high', effort: 'high' })
  expect(quickSessionRequest(agents, 'opus-5-high')).toMatchObject({ model: 'opus-5-high' })
  agents.find(a => a.id === 'claude')!.models = models.slice(1)
  expect(() => quickSessionRequest(agents, 'opus-5-high')).toThrow(/not in the current catalogue/)
  expect(consoleModelLabel('opus-5.5-high')).toBe('Opus 5.5 · High')
})
