import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// swarm-view.ts is a browser module that touches `document` at import time
// through its module-level `let viewEl: HTMLElement`. The pure helpers are the
// part worth locking in, so the module is bundled and the helpers are pulled
// out of it rather than importing the view wholesale into a node environment.
const SRC = new URL('../src/views/swarm-view.ts', import.meta.url).pathname

type Helpers = {
  sessionLabel: (id: string) => string
  targetText: (e: any) => string
  matchesSearch: (e: any) => boolean
  setSearch: (q: string) => void
  startedAtMs: (e: any) => number
  elapsedText: (e: any) => string
  hasDetail: (e: any) => boolean
}

async function loadHelpers(): Promise<Helpers> {
  const source = await readFile(SRC, 'utf8')
  // Re-export the internals and expose the module-level search state, which is
  // otherwise only reachable through a DOM input event.
  const patched = source + `
export const __test = {
  sessionLabel, targetText, matchesSearch, startedAtMs, elapsedText, hasDetail,
  setSearch: (q: string) => { searchQuery = q },
}
`
  const out = await build({
    stdin: { contents: patched, resolveDir: new URL('../src/views', import.meta.url).pathname, loader: 'ts' },
    bundle: true, platform: 'neutral', format: 'esm', write: false,
    external: ['*.css'],
  })
  const encoded = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  const mod = await import(encoded)
  const t = mod.__test
  return { ...t, setSearch: t.setSearch }
}

const helpers = await loadHelpers()

function entry(over: Record<string, unknown> = {}): any {
  return {
    id: 'a'.repeat(32), pr_id: null, repo: null, actor: null, model: 'opus-5',
    behavior: 'chat', session_id: null, prompt: '', started_at: '2026-07-29T21:26:23',
    started_at_precise: null, completed_at: null, time_elapsed: '', status: 'completed',
    outcome: null, response: '', error: '', ...over,
  }
}

// A chat run is not tied to a repo or pull request, and Swarm has no Prompt
// column, so the session id is the only thing that identifies the row. It was
// on the wire and never read.
describe('a run with no pull request is identified by its session', () => {
  it('labels a chat row by its session instead of a dash', () => {
    expect(helpers.targetText(entry({ session_id: 'debate-cd5805a5-gemini' })))
      .toBe('debate-cd5805a5-gemini')
  })

  it('strips the editor prefix and the uniqueness digits from an editor session', () => {
    // editorChatSessionId() mints `editor-<slug>-<digits>`; the digits exist
    // only to keep two sessions minted in the same millisecond apart.
    expect(helpers.sessionLabel('editor-my-notes-1785143835153')).toBe('my-notes')
  })

  it('shortens a session too long to read, and never returns the raw id', () => {
    const long = 'editor-untitled-20260727091613565-1de20996-e5bc-41e3-a9f2-a9401ba9704b-1785143835153'
    const label = helpers.sessionLabel(long)
    expect(label.length).toBeLessThanOrEqual(26)
    expect(label.endsWith('…')).toBe(true)
  })

  it('still says nothing when there is genuinely nothing to say', () => {
    expect(helpers.targetText(entry())).toBe('')
  })

  it('prefers the pull request when the run has one', () => {
    expect(helpers.targetText(entry({ repo: 'owner/poise', pr_id: '42' }))).toBe('poise#42')
  })
})

// Copying what the Target column shows and pasting it into the filter is the
// first thing anyone tries; it used to return nothing, because the filter
// matched repo and pr_id separately but never the rendered "name#123".
describe('the filter matches what the column shows', () => {
  it('matches the rendered target label', () => {
    helpers.setSearch('poise#42')
    expect(helpers.matchesSearch(entry({ repo: 'owner/poise', pr_id: '42' }))).toBe(true)
  })

  it('matches a session label', () => {
    helpers.setSearch('debate-cd5805a5')
    expect(helpers.matchesSearch(entry({ session_id: 'debate-cd5805a5-gemini' }))).toBe(true)
  })

  it('finds a failed run by its error text', () => {
    helpers.setSearch('rate limit')
    expect(helpers.matchesSearch(entry({ status: 'failed', error: 'GitHub rate limit exceeded' }))).toBe(true)
  })

  it('finds a review by its verdict', () => {
    helpers.setSearch('changes_requested')
    expect(helpers.matchesSearch(entry({ outcome: 'changes_requested' }))).toBe(true)
    helpers.setSearch('')
  })
})

// started_at is naive local time: ambiguous for the hour that repeats when the
// clock goes back, and nonexistent for the hour skipped when it goes forward.
describe('start time uses the exact instant when there is one', () => {
  it('prefers started_at_precise over the ambiguous local string', () => {
    const ms = helpers.startedAtMs(entry({
      started_at: '2026-07-29T21:26:23',
      started_at_precise: '2026-07-29T18:26:23.740Z',
    }))
    expect(ms).toBe(Date.parse('2026-07-29T18:26:23.740Z'))
  })

  it('falls back to the naive value for rows that predate it', () => {
    const ms = helpers.startedAtMs(entry({ started_at: '2026-07-29T21:26:23', started_at_precise: null }))
    expect(ms).toBe(new Date('2026-07-29T21:26:23').getTime())
  })
})

// agent-interface only fills time_elapsed when a run ends, so a running row's
// value sat still for up to a full refresh interval while Started ticked
// beside it — which reads as a stalled agent.
describe('elapsed is live while a run is still going', () => {
  it('derives elapsed for a running row', () => {
    const startedAgo = new Date(Date.now() - 90_000).toISOString()
    const text = helpers.elapsedText(entry({
      status: 'running', completed_at: null, time_elapsed: '', started_at_precise: startedAgo,
    }))
    expect(text).toMatch(/^1m \d+s$/)
  })

  it('keeps the recorded value once the run has finished', () => {
    expect(helpers.elapsedText(entry({
      status: 'completed', completed_at: '2026-07-29T18:34:00.262Z', time_elapsed: '7m 36s',
    }))).toBe('7m 36s')
  })
})

// Every failed run carries an error string. The row offered no way to open it,
// so diagnosing a failure meant leaving Poise for the CLI.
describe('a failed run can be opened', () => {
  it('offers detail for a failure with no response body', () => {
    expect(helpers.hasDetail(entry({ status: 'failed', response: '', error: 'boom' }))).toBe(true)
  })

  it('offers nothing when there is neither a body nor an error', () => {
    expect(helpers.hasDetail(entry({ response: '', error: '' }))).toBe(false)
  })
})
