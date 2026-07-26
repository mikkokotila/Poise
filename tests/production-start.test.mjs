import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeBuildStamp, ensureFreshBundle } from '../scripts/start-production.mjs'

// A checkout whose shape matches what computeBuildStamp reads.
async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'poise-start-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'server'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'server', 'production.ts'), 'export const b = 2\n')
  await writeFile(join(root, 'index.html'), '<!doctype html>\n')
  await writeFile(join(root, 'package.json'), '{}\n')
  return root
}

// Stand in for a completed `npm run build`: it also clears dist/ first, the
// way `npm run clean` does, so the fallback path is exercised honestly.
async function writeBundle(root, body = 'export const startProductionServer = () => {}\n') {
  await rm(join(root, 'dist'), { recursive: true, force: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'server.js'), body)
}

const silent = { log: () => {}, error: () => {} }

describe('production build stamp', () => {
  let root
  beforeEach(async () => { root = await scaffold() })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('is stable across repeated reads of an unchanged checkout', async () => {
    expect(await computeBuildStamp(root)).toBe(await computeBuildStamp(root))
  })

  it('changes when a source file changes', async () => {
    const before = await computeBuildStamp(root)
    await writeFile(join(root, 'src', 'main.ts'), 'export const a = 99\n')
    expect(await computeBuildStamp(root)).not.toBe(before)
  })

  it('changes when a source file is added', async () => {
    const before = await computeBuildStamp(root)
    await writeFile(join(root, 'src', 'extra.ts'), 'export const c = 3\n')
    expect(await computeBuildStamp(root)).not.toBe(before)
  })

  it('changes when the lockfile appears', async () => {
    const before = await computeBuildStamp(root)
    await writeFile(join(root, 'package-lock.json'), '{}\n')
    expect(await computeBuildStamp(root)).not.toBe(before)
  })
})

describe('ensureFreshBundle', () => {
  let root
  beforeEach(async () => { root = await scaffold() })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('builds when no bundle exists', async () => {
    let built = 0
    const result = await ensureFreshBundle({
      root, log: silent, build: async () => { built += 1; await writeBundle(root) },
    })
    expect(result).toBe('rebuilt')
    expect(built).toBe(1)
    // The stamp is written after the build, inside the freshly created dist.
    expect((await readFile(join(root, 'dist', '.build-stamp'), 'utf8')).trim())
      .toBe(await computeBuildStamp(root))
  })

  it('skips the build when the stamp still matches the checkout', async () => {
    await ensureFreshBundle({ root, log: silent, build: async () => writeBundle(root) })
    let rebuilds = 0
    const result = await ensureFreshBundle({
      root, log: silent, build: async () => { rebuilds += 1; await writeBundle(root) },
    })
    expect(result).toBe('current')
    expect(rebuilds).toBe(0)
  })

  it('rebuilds after a source file changes — the case a plain restart used to miss', async () => {
    await ensureFreshBundle({ root, log: silent, build: async () => writeBundle(root, 'v1\n') })
    await writeFile(join(root, 'src', 'main.ts'), 'export const a = 2\n')
    const result = await ensureFreshBundle({
      root, log: silent, build: async () => writeBundle(root, 'v2\n'),
    })
    expect(result).toBe('rebuilt')
    expect(await readFile(join(root, 'dist', 'server.js'), 'utf8')).toBe('v2\n')
  })

  it('restores the previous bundle when the rebuild fails', async () => {
    await ensureFreshBundle({ root, log: silent, build: async () => writeBundle(root, 'good\n') })
    await writeFile(join(root, 'src', 'main.ts'), 'export const a = 3\n')
    const result = await ensureFreshBundle({
      root,
      log: silent,
      // Clear dist/ the way `npm run clean` does, then fail.
      build: async () => {
        await rm(join(root, 'dist'), { recursive: true, force: true })
        throw new Error('typecheck failed')
      },
    })
    expect(result).toBe('stale')
    // Serving something beats a dead service.
    expect(await readFile(join(root, 'dist', 'server.js'), 'utf8')).toBe('good\n')
    await expect(stat(join(root, 'dist.previous'))).rejects.toThrow()
  })

  it('keeps the stale stamp after a failed rebuild so the next start retries', async () => {
    await ensureFreshBundle({ root, log: silent, build: async () => writeBundle(root, 'good\n') })
    const stampAfterGoodBuild = await computeBuildStamp(root)
    await writeFile(join(root, 'src', 'main.ts'), 'export const a = 4\n')
    await ensureFreshBundle({
      root,
      log: silent,
      build: async () => {
        await rm(join(root, 'dist'), { recursive: true, force: true })
        throw new Error('boom')
      },
    })
    const recorded = (await readFile(join(root, 'dist', '.build-stamp'), 'utf8')).trim()
    expect(recorded).toBe(stampAfterGoodBuild)
    expect(recorded).not.toBe(await computeBuildStamp(root))

    let retried = 0
    const result = await ensureFreshBundle({
      root, log: silent, build: async () => { retried += 1; await writeBundle(root, 'fixed\n') },
    })
    expect(retried).toBe(1)
    expect(result).toBe('rebuilt')
  })

  it('propagates the failure when there is no previous bundle to fall back to', async () => {
    await expect(ensureFreshBundle({
      root, log: silent, build: async () => { throw new Error('first build failed') },
    })).rejects.toThrow('first build failed')
  })
})
