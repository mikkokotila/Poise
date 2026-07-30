import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'

// Four views in a row shipped an exported leave-cleanup that nothing ever
// called — stopBehaviorsRefresh, stopSwarmRefresh, stopCurrentPolling and
// stopMainRefresh. Each one meant the view kept fetching and re-rendering for
// the rest of the session while hidden, and in one case left a panel floating
// over whatever came next. Every one was found by a separate audit, months
// apart. This is cheaper than a fifth audit.
const VIEWS_DIR = new URL('../src/views/', import.meta.url).pathname
const MAIN = new URL('../src/main.ts', import.meta.url).pathname

describe('every view that exports a leave-cleanup has it wired up', () => {
  it('calls each exported stop* from main.ts', async () => {
    const main = await readFile(MAIN, 'utf8')
    const files = (await readdir(VIEWS_DIR)).filter((f) => f.endsWith('-view.ts'))
    expect(files.length).toBeGreaterThan(0)

    const unwired: string[] = []
    for (const file of files) {
      const source = await readFile(VIEWS_DIR + file, 'utf8')
      for (const m of source.matchAll(/^export function (stop[A-Za-z0-9_]*)/gm)) {
        const name = m[1]
        // Imported and invoked, not merely mentioned in a comment.
        const imported = new RegExp(`\\b${name}\\b[^\\n]*from '\\./views/`).test(main)
          || new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\}`).test(main)
        const called = new RegExp(`\\b${name}\\s*\\(`).test(main)
        if (!imported || !called) unwired.push(`${file} exports ${name}`)
      }
    }
    expect(unwired).toEqual([])
  })
})
