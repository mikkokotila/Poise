import { describe, expect, it, vi } from 'vitest'
import { catalogueAgents } from '../../server/chat/catalog-agents'
import { catalogueFamilies, familyForIdentity } from '../../src/chat-catalog'
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
