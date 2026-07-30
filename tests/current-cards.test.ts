import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

// server/current.ts binds to the database at module load, so each case gets a
// freshly-bundled copy pointed at its own file.
type CurrentModule = typeof import('../server/current')

let dir: string
let current: CurrentModule

async function loadWith(dbPath: string): Promise<CurrentModule> {
  process.env.POISE_DB = dbPath
  const out = await build({
    entryPoints: [new URL('../server/current.ts', import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  })
  const file = join(dir, `mod-${Math.random().toString(36).slice(2)}.mjs`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, out.outputFiles[0].text, 'utf8')
  return import(file) as Promise<CurrentModule>
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poise-current-'))
  current = await loadWith(join(dir, 'cards.db'))
})

afterEach(async () => {
  delete process.env.POISE_DB
  await rm(dir, { recursive: true, force: true })
})

function laneOrder(lane: 'idea' | 'concept' | 'plan'): string[] {
  return current.listCards()
    .filter((c) => c.lane === lane)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.text)
}

// updated_at is the only per-card recency signal on the board. Re-densifying a
// lane touches every card in it, and stamping them all made a card that had sat
// untouched for weeks report that it had just changed because a neighbour was
// nudged.
describe('reordering does not restamp the cards that did not move', () => {
  it('leaves the neighbours untouched on a same-lane reorder', async () => {
    const a = current.createCard('first', 'idea')
    const b = current.createCard('second', 'idea')
    const c = current.createCard('third', 'idea')
    const before = new Map(current.listCards().map((x) => [x.id, x.updated_at]))

    await new Promise((r) => setTimeout(r, 5))
    current.moveCard(c.id, 'idea', 0)

    expect(laneOrder('idea')).toEqual(['third', 'first', 'second'])
    const after = new Map(current.listCards().map((x) => [x.id, x.updated_at]))
    // The moved card is genuinely modified.
    expect(after.get(c.id)).not.toBe(before.get(c.id))
    // Its neighbours are not.
    expect(after.get(a.id)).toBe(before.get(a.id))
    expect(after.get(b.id)).toBe(before.get(b.id))
  })

  it('leaves both lanes untouched on a cross-lane move, apart from the card moved', async () => {
    const a = current.createCard('stays in idea', 'idea')
    const b = current.createCard('moves', 'idea')
    const c = current.createCard('already in plan', 'plan')
    const before = new Map(current.listCards().map((x) => [x.id, x.updated_at]))

    await new Promise((r) => setTimeout(r, 5))
    current.moveCard(b.id, 'plan', 0)

    expect(laneOrder('plan')).toEqual(['moves', 'already in plan'])
    const after = new Map(current.listCards().map((x) => [x.id, x.updated_at]))
    expect(after.get(b.id)).not.toBe(before.get(b.id))
    expect(after.get(a.id)).toBe(before.get(a.id))
    expect(after.get(c.id)).toBe(before.get(c.id))
  })

  it('leaves the survivors untouched when a card is deleted', async () => {
    const a = current.createCard('keep me', 'idea')
    const b = current.createCard('delete me', 'idea')
    const before = current.listCards().find((x) => x.id === a.id)!.updated_at

    await new Promise((r) => setTimeout(r, 5))
    current.removeCard(b.id)

    expect(laneOrder('idea')).toEqual(['keep me'])
    expect(current.listCards().find((x) => x.id === a.id)!.updated_at).toBe(before)
  })
})

// Positions stay contiguous whatever the caller asks for — the client sends an
// index it computed from its own view of the lane.
describe('positions stay a dense sequence', () => {
  it('clamps an index past the end', () => {
    current.createCard('a', 'idea')
    current.createCard('b', 'idea')
    const c = current.createCard('c', 'idea')
    current.moveCard(c.id, 'idea', 99)
    expect(laneOrder('idea')).toEqual(['a', 'b', 'c'])
    expect(current.listCards().filter((x) => x.lane === 'idea').map((x) => x.position).sort())
      .toEqual([0, 1, 2])
  })

  it('clamps a negative index', () => {
    current.createCard('a', 'idea')
    const b = current.createCard('b', 'idea')
    current.moveCard(b.id, 'idea', -5)
    expect(laneOrder('idea')).toEqual(['b', 'a'])
  })
})
