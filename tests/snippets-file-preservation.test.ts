import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

// server/snippets.ts reads POISE_ESPANSO_MATCH_DIR at module load, so each case
// gets a freshly-bundled copy pointed at its own directory.
type SnippetsModule = typeof import('../server/snippets')

let dir: string
let snippets: SnippetsModule

async function loadWith(matchDir: string): Promise<SnippetsModule> {
  process.env.POISE_ESPANSO_MATCH_DIR = matchDir
  const out = await build({
    entryPoints: [new URL('../server/snippets.ts', import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  })
  const file = join(matchDir, `mod-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(file, out.outputFiles[0].text, 'utf8')
  return import(file) as Promise<SnippetsModule>
}

const FILE = () => join(dir, 'poise.yml')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poise-espanso-'))
})
afterEach(async () => {
  delete process.env.POISE_ESPANSO_MATCH_DIR
  await rm(dir, { recursive: true, force: true })
})

// Poise owns the simple trigger/replace pairs in poise.yml. It used to rewrite
// the file as nothing but those pairs, so a user who hand-added an espanso
// feature lost it on the next save from the UI, silently.
describe('poise.yml preserves what Poise does not model', () => {
  it('keeps other top-level keys, non-simple matches, and comments', async () => {
    await writeFile(FILE(), [
      '# my expansions — hand written, keep me',
      'global_vars:',
      '  - name: today',
      '    type: date',
      'matches:',
      '  # a regex match Poise does not model',
      '  - regex: "hi(?P<n>.*)"',
      '    replace: "hello {{n}}"',
      '  - trigger: ";sig"',
      '    replace: "Best regards"',
    ].join('\n'), 'utf8')
    snippets = await loadWith(dir)

    const state = await snippets.readSnippetState()
    expect(state.snippets.map((s) => s.trigger)).toEqual([';sig'])

    await snippets.saveSnippets(
      [...state.snippets, { trigger: ';new', replace: 'added' }],
      state.version,
    )

    const after = await readFile(FILE(), 'utf8')
    expect(after).toContain('# my expansions — hand written, keep me')
    expect(after).toContain('global_vars:')
    expect(after).toContain('# a regex match Poise does not model')
    expect(after).toContain('regex:')
    expect(after).toContain(';new')
    expect(after).toContain(';sig')
  })

  it('writes a plain file when there was nothing there before', async () => {
    snippets = await loadWith(dir)
    const state = await snippets.readSnippetState()
    await snippets.saveSnippets([{ trigger: ';a', replace: 'one' }], state.version)
    const after = await readFile(FILE(), 'utf8')
    expect(after).toContain('matches:')
    expect(after).toContain(';a')
  })
})

// A file can carry the same trigger twice — a hand edit, a dotfiles merge, a
// sync that concatenated two versions. Reading them all made the file readable
// and unwritable at once: every save failed validation until the user found and
// fixed it by hand.
describe('a duplicate trigger does not wedge every save', () => {
  it('reads the first of a duplicated trigger and still saves', async () => {
    await writeFile(FILE(), [
      'matches:',
      '  - trigger: ";sig"',
      '    replace: "first"',
      '  - trigger: ";sig"',
      '    replace: "second"',
      '  - trigger: ";other"',
      '    replace: "kept"',
    ].join('\n'), 'utf8')
    snippets = await loadWith(dir)

    const state = await snippets.readSnippetState()
    expect(state.snippets.map((s) => s.trigger)).toEqual([';sig', ';other'])
    expect(state.snippets[0].replace).toBe('first')

    await expect(snippets.saveSnippets(
      [...state.snippets, { trigger: ';added', replace: 'x' }],
      state.version,
    )).resolves.toMatchObject({ snippets: expect.any(Array) })

    const reread = await snippets.readSnippetState()
    expect(reread.snippets.map((s) => s.trigger)).toEqual([';sig', ';other', ';added'])
  })
})

// Poise owns the trigger/replace pair, not the other espanso options a person
// may have put on that same entry. Those used to be destroyed by the next save
// from the UI: the owned entries were filtered out and re-emitted as fresh
// two-key nodes, so the trigger survived in the list while quietly losing the
// `vars` block that made it expand to anything.
describe('an entry Poise owns keeps the espanso options it did not write', () => {
  it('preserves vars, word, propagate_case and label through a save', async () => {
    await writeFile(FILE(), [
      'matches:',
      '  - trigger: ";date"',
      '    replace: "Today is {{mydate}}"',
      '    word: true',
      '    propagate_case: true',
      '    label: "insert the date"',
      '    vars:',
      '      - name: mydate',
      '        type: date',
      '        params:',
      '          format: "%d/%m/%Y"',
    ].join('\n'), 'utf8')
    snippets = await loadWith(dir)

    const state = await snippets.readSnippetState()
    // It still reads as an ordinary pair — the UI is unchanged.
    expect(state.snippets.map((s) => s.trigger)).toEqual([';date'])

    // Adding an unrelated snippet rewrites the file.
    await snippets.saveSnippets(
      [...state.snippets, { trigger: ';sig', replace: 'Best regards' }],
      state.version,
    )

    const after = await readFile(FILE(), 'utf8')
    expect(after).toContain('vars:')
    expect(after).toContain('mydate')
    expect(after).toContain('%d/%m/%Y')
    expect(after).toContain('word: true')
    expect(after).toContain('propagate_case: true')
    expect(after).toContain('insert the date')
    expect(after).toContain(';sig')
  })

  it('applies an edit to the body without disturbing the options beside it', async () => {
    await writeFile(FILE(), [
      'matches:',
      '  - trigger: ";date"',
      '    replace: "old body {{mydate}}"',
      '    vars:',
      '      - name: mydate',
      '        type: date',
    ].join('\n'), 'utf8')
    snippets = await loadWith(dir)
    const state = await snippets.readSnippetState()

    await snippets.saveSnippets([{ trigger: ';date', replace: 'new body {{mydate}}' }], state.version)

    const after = await readFile(FILE(), 'utf8')
    expect(after).toContain('new body')
    expect(after).not.toContain('old body')
    expect(after).toContain('vars:')
    expect(after).toContain('mydate')
  })

  it('lets a trigger the person removed actually go', async () => {
    await writeFile(FILE(), [
      'matches:',
      '  - trigger: ";gone"',
      '    replace: "bye"',
      '    word: true',
      '  - trigger: ";kept"',
      '    replace: "hello"',
    ].join('\n'), 'utf8')
    snippets = await loadWith(dir)
    const state = await snippets.readSnippetState()

    await snippets.saveSnippets([{ trigger: ';kept', replace: 'hello' }], state.version)

    const after = await readFile(FILE(), 'utf8')
    expect(after).not.toContain(';gone')
    expect(after).toContain(';kept')
  })
})
