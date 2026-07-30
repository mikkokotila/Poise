import { beforeEach, describe, expect, it, vi } from 'vitest'

// server/gh.ts merges two scopes when a review agent is configured: what the
// user is involved in, and what the agent authored. The merge used to go out
// in scope order on the single-kind paths, on the strength of a comment saying
// the caller re-sorted — which it only did for record_type 'all'.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), getMeta: vi.fn() }))

vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
vi.mock('../server/db', () => ({
  getMeta: mocks.getMeta,
  setMeta: vi.fn(),
}))

const { handleGhBody, setReviewAgentUsername } = await import('../server/gh')

function record(number: number, updatedAt: string, author: string) {
  return {
    repo: 'owner/poise', number, title: `item ${number}`, author,
    url: `https://github.com/owner/poise/pull/${number}`,
    status: 'open', updated_at: updatedAt, created_at: updatedAt,
    closed_at: null, owner_login: null, owner_avatar: null, draft: false,
  }
}

beforeEach(() => {
  mocks.runFile.mockReset()
  mocks.getMeta.mockReset()
  mocks.getMeta.mockImplementation((k: string) => (k === 'me' ? 'mikkokotila' : ''))
  // Not read from the database — cachePlugin threads it in at server start.
  setReviewAgentUsername('bit-mis')
})

describe('a merged scope comes back newest-first', () => {
  it('interleaves the agent-authored rows by date instead of appending them', async () => {
    // Scope 1 (the user's involvement) is old; scope 2 (the agent's authored
    // set) is new. Appended, the newest rows would sit at the bottom.
    mocks.runFile.mockImplementation(async (_cmd: string, args: string[]) => {
      const authored = args.includes('--author')
      return {
        stdout: JSON.stringify(authored
          ? [record(10, '2026-07-30T12:00:00Z', 'bit-mis'), record(11, '2026-07-29T12:00:00Z', 'bit-mis')]
          : [record(1, '2026-07-28T12:00:00Z', 'mikkokotila'), record(2, '2026-01-01T12:00:00Z', 'mikkokotila')]),
        stderr: '',
      }
    })

    const res = await handleGhBody({ operation: 'list', record_type: 'pull_request', limit: 10 })
    expect(res.status).toBe(200)
    const numbers = (res.body as any).records.map((r: any) => r.number)
    expect(numbers).toEqual([10, 11, 1, 2])
  })

  it('still dedupes an item both scopes report', async () => {
    mocks.runFile.mockImplementation(async () => ({
      stdout: JSON.stringify([record(7, '2026-07-30T12:00:00Z', 'mikkokotila')]),
      stderr: '',
    }))
    const res = await handleGhBody({ operation: 'list', record_type: 'issue', limit: 10 })
    expect((res.body as any).records.map((r: any) => r.number)).toEqual([7])
  })
})
