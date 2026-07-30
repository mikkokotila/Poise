import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// main-view.ts is the Archive view (id="view-main", menu label "Archive"). It
// grabs DOM nodes at init, so the pure helpers are pulled out of a bundled copy
// rather than importing the view into a node environment.
const SRC = new URL('../src/views/main-view.ts', import.meta.url).pathname

type Helpers = {
  reviewButtonHtml: (item: any, st: { text: string, cls: string }) => string
  stateLabel: (item: any) => { text: string, cls: string }
  relativeDate: (iso: string) => string
  rowKey: (item: any) => string
  markReviewing: (url: string, on: boolean) => void
}

async function loadHelpers(): Promise<Helpers> {
  const source = await readFile(SRC, 'utf8')
  const patched = source + `
export const __test = {
  reviewButtonHtml, stateLabel, relativeDate, rowKey,
  markReviewing: (url: string, on: boolean) => { on ? reviewing.add(url) : reviewing.delete(url) },
}
`
  const out = await build({
    stdin: { contents: patched, resolveDir: new URL('../src/views', import.meta.url).pathname, loader: 'ts' },
    bundle: true, platform: 'neutral', format: 'esm', write: false, external: ['*.css'],
  })
  // The bundle pulls in src/config.ts, which registers a window listener at
  // module load, and main-view reads localStorage for its persisted filters.
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  ;(globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout: (globalThis as any).setTimeout,
  }
  const encoded = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  return (await import(encoded)).__test
}

const h = await loadHelpers()

function pr(over: Record<string, unknown> = {}): any {
  return {
    repo: 'owner/poise', number: 42, title: 'a change', html_url: 'https://github.com/owner/poise/pull/42',
    author: 'someone', is_pr: 1, state: 'open', owner_login: null, owner_avatar: null,
    updated_at: new Date().toISOString(), merged_at: null, ...over,
  }
}

// The review button dispatches a consensus review that posts back on the pull
// request. A merged or closed pull request is not a review target — Current was
// changed for exactly this and Archive was not.
describe('the review button is only armed where a review makes sense', () => {
  it('is enabled on an open pull request', () => {
    const item = pr()
    const html = h.reviewButtonHtml(item, h.stateLabel(item))
    expect(html).not.toContain('disabled')
    expect(html).toContain('Run consensus review')
  })

  it('is disabled on a merged pull request', () => {
    const item = pr({ merged_at: '2026-07-01T00:00:00Z', state: 'closed' })
    const html = h.reviewButtonHtml(item, h.stateLabel(item))
    expect(html).toContain('disabled')
    expect(html).toContain('merged — nothing to review')
  })

  it('is disabled on a closed pull request that never merged', () => {
    const item = pr({ state: 'closed' })
    const html = h.reviewButtonHtml(item, h.stateLabel(item))
    expect(html).toContain('disabled')
    expect(html).toContain('closed — nothing to review')
  })
})

// The in-flight guard used to live on the button element, which the table
// rebuild replaces — handing back an enabled button while the review was still
// running, so a second click posted a second review on the same pull request.
describe('a running review still reads as running after a rebuild', () => {
  it('renders disabled and spinning while in flight', () => {
    const item = pr()
    h.markReviewing(item.html_url, true)
    const html = h.reviewButtonHtml(item, h.stateLabel(item))
    expect(html).toContain('disabled')
    expect(html).toContain('running')
    expect(html).toContain('Consensus review running')
    h.markReviewing(item.html_url, false)
  })

  it('goes back to armed once the review settles', () => {
    const item = pr()
    h.markReviewing(item.html_url, true)
    h.markReviewing(item.html_url, false)
    expect(h.reviewButtonHtml(item, h.stateLabel(item))).not.toContain('disabled')
  })
})

// The formatter had drifted from the one every other view uses, collapsing
// everything under a day to the word "today" — which sat oddly beside the
// Yesterday pill and hid how recent a row actually was.
describe('relative dates use the same vocabulary as the other views', () => {
  it('reports minutes and hours rather than "today"', () => {
    expect(h.relativeDate(new Date(Date.now() - 90_000).toISOString())).toBe('1m')
    expect(h.relativeDate(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3h')
  })

  it('still reports days, months and years', () => {
    expect(h.relativeDate(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe('3d')
    expect(h.relativeDate(new Date(Date.now() - 90 * 86400_000).toISOString())).toBe('3mo')
  })

  it('says nothing rather than NaN for an unparseable date', () => {
    expect(h.relativeDate('not a date')).toBe('—')
  })
})

describe('rows are identified consistently', () => {
  it('keys a row by repo and number', () => {
    expect(h.rowKey(pr())).toBe('owner/poise#42')
  })
})
