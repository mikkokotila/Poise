import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// src/behaviors.ts is the browser-side mirror of the behaviour state. It has
// no imports, so it loads under the node environment with `fetch` and
// `window.dispatchEvent` stubbed. Each case gets a fresh module so the
// module-level mirror and write counters start clean.
type BehaviorsModule = typeof import('../src/behaviors')

let behaviors: BehaviorsModule
let deferredGets: Array<{ resolve: (body: unknown) => void }>

const KEYS = ['review-new-prs', 'approve-prs', 'resolve-unblocking'] as const

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { diagnostics: null }
  for (const key of KEYS) {
    base[key] = { enabled: false, setting: 'p2', scratchpad: '', lastTriggered: null, owner: null }
  }
  for (const [key, value] of Object.entries(over)) {
    base[key] = { ...(base[key] as object), ...(value as object) }
  }
  return base
}

// A GET that does not answer until the test says so — the whole point is what
// happens to a write while a read is still on the wire.
function deferGet(): Promise<unknown> {
  return new Promise((resolve) => { deferredGets.push({ resolve }) })
}

beforeEach(async () => {
  deferredGets = []
  vi.stubGlobal('window', { dispatchEvent: () => true, CustomEvent })
  vi.resetModules()
  behaviors = await import('../src/behaviors')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function respond(body: unknown): void {
  const next = deferredGets.shift()
  if (!next) throw new Error('no deferred GET outstanding')
  next.resolve(body)
}

// GET /api/behaviors blocks on an `agent-interface --logs` subprocess with a
// 30-second timeout, so a refresh started before a click is routinely still
// unanswered when that click's POST has completed. Ordering reads against
// other reads does not help: the slow read is the *newest* read, and it
// carries a snapshot from before the change.
describe('a read already on the wire cannot undo a write that completed', () => {
  it('keeps the toggled value when the pre-toggle refresh finally answers', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, enabled: true }) })
      }
      return deferGet().then((body) => ({ ok: true, status: 200, json: async () => body }))
    })

    // A refresh goes out and blocks.
    const refresh = behaviors.refreshState()
    // The person switches the behaviour on; the cheap POST lands first.
    await behaviors.setEnabled('review-new-prs', true)
    expect(behaviors.isEnabled('review-new-prs')).toBe(true)

    // The refresh now answers, carrying the pre-toggle snapshot.
    respond(payload({ 'review-new-prs': { enabled: false } }))
    await refresh

    expect(behaviors.isEnabled('review-new-prs')).toBe(true)
  })

  it('keeps a just-saved memory when the pre-save refresh finally answers', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, scratchpad: 'new note' }) })
      }
      return deferGet().then((body) => ({ ok: true, status: 200, json: async () => body }))
    })

    const refresh = behaviors.refreshState()
    await behaviors.setScratchpad('review-new-prs', 'new note', '')
    respond(payload({ 'review-new-prs': { scratchpad: 'old note' } }))
    await refresh

    // Reopening the panel reads this mirror; the pre-save text coming back
    // here is what made a saved memory look unsaved.
    expect(behaviors.getScratchpad('review-new-prs')).toBe('new note')
  })

  it('still applies the read to behaviours the write did not touch', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, enabled: true }) })
      }
      return deferGet().then((body) => ({ ok: true, status: 200, json: async () => body }))
    })

    const refresh = behaviors.refreshState()
    await behaviors.setEnabled('review-new-prs', true)
    respond(payload({
      'review-new-prs': { enabled: false },
      'approve-prs': { enabled: true },
    }))
    await refresh

    expect(behaviors.isEnabled('review-new-prs')).toBe(true)
    // Discarding the whole response would have thrown this away with it.
    expect(behaviors.isEnabled('approve-prs')).toBe(true)
    expect(behaviors.isBehaviorStateLoaded()).toBe(true)
  })

  it('accepts a read that started after the write settled', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, enabled: true }) })
      }
      return deferGet().then((body) => ({ ok: true, status: 200, json: async () => body }))
    })

    await behaviors.setEnabled('review-new-prs', true)
    const refresh = behaviors.refreshState()
    // The server is authoritative: something else turned it off.
    respond(payload({ 'review-new-prs': { enabled: false } }))
    await refresh

    expect(behaviors.isEnabled('review-new-prs')).toBe(false)
  })
})

// The server stores whichever request arrives last, and a ceiling decides
// which pull requests the automation acts on — so two in flight at once could
// leave it on a value the person had already moved past.
describe('setting writes are serialized per behaviour', () => {
  it('never leaves the ceiling on a superseded value', async () => {
    const arrivals: string[] = []
    let inFlight = 0
    let maxConcurrent = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // The first request is slow, so without serialization the second would
      // arrive at the server first and the first would win by landing last.
      await new Promise((resolve) => setTimeout(resolve, arrivals.length === 0 ? 40 : 0))
      arrivals.push(body.setting)
      inFlight--
      return { ok: true, status: 200, json: async () => ({ ok: true, setting: body.setting }) }
    })

    const first = behaviors.setSetting('review-new-prs', 'p1')
    const second = behaviors.setSetting('review-new-prs', 'p4')
    await Promise.all([first, second])

    expect(maxConcurrent).toBe(1)
    expect(arrivals).toEqual(['p1', 'p4'])
    expect(behaviors.getSetting('review-new-prs')).toBe('p4')
  })

  it('lets a later write through after an earlier one fails', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls === 1) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ok: true, setting: 'p4' }) }
    })

    await expect(behaviors.setSetting('review-new-prs', 'p1')).rejects.toThrow()
    await behaviors.setSetting('review-new-prs', 'p4')
    expect(behaviors.getSetting('review-new-prs')).toBe('p4')
  })
})
