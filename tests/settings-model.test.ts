import { beforeEach, describe, expect, it, vi } from 'vitest'

// server/settings.ts is the whole persisted settings model. It writes through
// setMeta, and now also drops the org-scoped repo cache when the org changes.
const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  invalidateRepoListCache: vi.fn(),
}))

vi.mock('../server/db', () => ({
  getMeta: (k: string) => mocks.store.get(k) ?? '',
  setMeta: (k: string, v: string) => { mocks.store.set(k, v) },
}))
vi.mock('../server/gh', () => ({ invalidateRepoListCache: mocks.invalidateRepoListCache }))

const { getSettings, setSettings, isReady } = await import('../server/settings')

beforeEach(() => {
  mocks.store.clear()
  mocks.invalidateRepoListCache.mockClear()
})

describe('what the settings model accepts', () => {
  it('stores a well-formed org, username and timezone', () => {
    const s = setSettings({ org: ' Vaquum ', me: ' mikkokotila ', timezone: 'Europe/Helsinki' })
    expect(s).toEqual({ org: 'Vaquum', me: 'mikkokotila', timezone: 'Europe/Helsinki' })
  })

  it('refuses a pasted URL rather than storing something no query can use', () => {
    expect(() => setSettings({ org: 'https://github.com/Vaquum' })).toThrow(/GitHub name/)
    expect(() => setSettings({ me: 'me@example.com' })).toThrow(/GitHub name/)
  })

  it('refuses a name that starts or ends with a hyphen', () => {
    expect(() => setSettings({ org: '-leading' })).toThrow(/GitHub name/)
    expect(() => setSettings({ org: 'trailing-' })).toThrow(/GitHub name/)
  })

  it('allows clearing a field back to empty', () => {
    setSettings({ org: 'Vaquum', me: 'mikkokotila' })
    expect(setSettings({ org: '' }).org).toBe('')
  })

  it('ignores a field that is not a string instead of coercing it', () => {
    setSettings({ org: 'Vaquum' })
    expect(setSettings({ org: undefined, me: 'mikkokotila' }).org).toBe('Vaquum')
  })
})

// The write loop applied key by key, so a value rejected halfway through left
// the keys before it already written — a save that reported failure but had
// partly happened.
describe('a rejected save changes nothing at all', () => {
  it('does not keep the valid half of an invalid update', () => {
    setSettings({ org: 'Vaquum', me: 'mikkokotila', timezone: 'UTC' })
    expect(() => setSettings({ timezone: 'Europe/Berlin', org: 'not a valid org' })).toThrow()
    // The timezone in the same call must not have landed.
    expect(getSettings()).toEqual({ org: 'Vaquum', me: 'mikkokotila', timezone: 'UTC' })
  })
})

// The repo list is scoped to the organization, so it cannot survive a change
// of organization — the pickers would keep offering the old org's repos, and
// opening an issue against one would go somewhere else entirely.
describe('changing the organization drops the org-scoped repo cache', () => {
  it('invalidates when the org actually changes', () => {
    setSettings({ org: 'Vaquum' })
    expect(mocks.invalidateRepoListCache).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate when the org is re-saved unchanged', () => {
    setSettings({ org: 'Vaquum' })
    mocks.invalidateRepoListCache.mockClear()
    setSettings({ org: 'Vaquum', me: 'mikkokotila' })
    expect(mocks.invalidateRepoListCache).not.toHaveBeenCalled()
  })
})

describe('readiness', () => {
  it('needs both an org and a username', () => {
    expect(isReady()).toBe(false)
    setSettings({ org: 'Vaquum' })
    expect(isReady()).toBe(false)
    setSettings({ me: 'mikkokotila' })
    expect(isReady()).toBe(true)
  })
})
