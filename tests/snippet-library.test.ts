import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { parseChatSwitches } from '../src/chat-switches'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
let root: string, file: string
let library: typeof import('../server/snippet-library')
let database: typeof import('../server/db')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-unified-library-'))
  vi.stubEnv('POISE_DB', join(root, 'db.sqlite3'))
  vi.stubEnv('POISE_ESPANSO_MATCH_DIR', join(root, 'match'))
  file = join(root, 'match', 'poise.yml')
  library = await import('../server/snippet-library'); database = await import('../server/db')
})
beforeEach(async () => {
  database.setMeta('chat_custom_switches', '')
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_%'").run()
  await rm(join(root, 'match'), { recursive: true, force: true }); await mkdir(join(root, 'match'))
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('uses one body for a snippet, a Chat invocation and subsequent edits from either surface', async () => {
  const body = '  Literal instructions.\n/reset\nUse äö 🪶.\n'
  await library.addSkillSnippet({ trigger: ';voice', replace: body })
  expect(library.readSwitches().switches).toMatchObject([{ name: 'voice', content: body, snippetTrigger: ';voice' }])
  await library.saveSwitch({ name: 'voice', content: 'Updated from Chat', revision: 1 })
  let state = await library.readSkillSnippets()
  expect(state.snippets).toEqual([{ trigger: ';voice', replace: 'Updated from Chat' }])
  state = await library.saveSkillSnippets([{ trigger: ';voice', replace: 'Updated in Snippets' }], state.version)
  expect(library.expandSwitches('Task', ['voice'])).toContain('Updated in Snippets')
  expect(parse(await readFile(file, 'utf8')).matches).toEqual(state.snippets)
  expect(parseChatSwitches(state.skills)).toEqual(state.skills)
})

it('shows Chat-created skills in Snippets, and renames and deletes them in both places', async () => {
  await library.saveSwitch({ name: 'outline', content: 'Make an outline.', revision: 0 })
  const initial = await library.readSkillSnippets()
  expect(initial.snippets).toEqual([{ trigger: ';outline', replace: 'Make an outline.' }])
  const renamed = await library.saveSkillSnippets([{ trigger: ';plan-outline', replace: 'Make an outline.' }], initial.version)
  expect(renamed.skills.switches.map(item => item.name)).toEqual(['plan-outline'])
  expect(() => library.expandSwitches('Task', ['outline'])).toThrow(/unavailable/)
  const removed = await library.saveSkillSnippets([], renamed.version)
  expect(removed.snippets).toEqual([]); expect(removed.skills.switches).toEqual([])
  expect(library.savedSwitchNames().has('plan-outline')).toBe(true)
  expect(() => library.expandSwitches('Task', ['plan-outline'])).toThrow(/unavailable/)
})

function legacyLibrary() {
  const legacy = { revision: 7, switches: [
    { name: 'voice', content: 'Existing Chat voice', revision: 3, updatedAt: '2026-09-22' },
    { name: 'equal', content: 'Same text', revision: 1, updatedAt: '2026-09-22' },
  ] }
  database.setMeta('chat_custom_switches', JSON.stringify(legacy))
  return legacy
}
it('imports old skills once without overwriting colliding snippets, comments or Espanso options', async () => {
  const legacy = legacyLibrary()
  await writeFile(file, '# Personal comments\nlabel: Keep this\nmatches:\n  - trigger: ;voice\n    replace: Existing snippet voice\n    word: true\n  - trigger: ;equal\n    replace: Same text\n')
  const state = await library.readSkillSnippets()
  expect(state.snippets).toHaveLength(3)
  expect(state.skills.switches.find(item => item.name === 'voice')?.content).toBe('Existing Chat voice')
  expect(state.skills.switches.find(item => item.snippetTrigger === ';voice')?.content).toBe('Existing snippet voice')
  const raw = await readFile(file, 'utf8')
  expect(raw).toContain('# Personal comments')
  expect(parse(raw).label).toBe('Keep this')
  expect(parse(raw).matches.find((item: { trigger: string }) => item.trigger === ';voice').word).toBe(true)
  expect(await library.readSkillSnippets()).toEqual(state)
  expect(JSON.parse(database.getMeta('chat_custom_switches')!)).toEqual(legacy)
  await library.saveSkillSnippets([], state.version)
  database.closeDatabase(); vi.resetModules()
  library = await import('../server/snippet-library'); database = await import('../server/db')
  expect((await library.readSkillSnippets()).snippets).toEqual([])
  await rm(file)
  expect((await library.readSkillSnippets()).skills.switches).toEqual([])
})

it('keeps both old sources when an import cannot commit, then retries without duplicates', async () => {
  legacyLibrary()
  const original = '# Keep\nmatches:\n  - trigger: ;before\n    replace: Prior snippet\n'
  await writeFile(file, original)
  const files = await import('node:fs/promises')
  vi.mocked(files.rename).mockRejectedValueOnce(new Error('injected import failure'))
  await expect(library.readSkillSnippets()).rejects.toThrow('injected import failure')
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(database.getMeta('chat_custom_switches')).toContain('Existing Chat voice')
  expect((await library.readSkillSnippets()).snippets).toHaveLength(3)
})

it('recognizes the atomic file receipt after a crash between import and database bookkeeping', async () => {
  legacyLibrary()
  database.db.exec("CREATE TRIGGER fail_import_receipt BEFORE INSERT ON meta WHEN NEW.key LIKE 'chat_snippet_import:%' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END")
  try { await expect(library.readSkillSnippets()).rejects.toThrow('injected receipt failure') }
  finally { database.db.exec('DROP TRIGGER fail_import_receipt') }
  expect(parse(await readFile(file, 'utf8')).matches).toHaveLength(2)
  const state = await library.readSkillSnippets()
  expect(state.snippets).toHaveLength(2)
  expect((await library.readSkillSnippets()).version).toBe(state.version)
})

it('makes arbitrary snippet triggers available without reserved-name or normalization collisions', async () => {
  const initial = await library.readSkillSnippets()
  const triggers = [';review', ';model', 'Hello World', ';hello-world', ';123', '🪶', ';CAFÉ', '/cafe']
  const state = await library.saveSkillSnippets(triggers.map(trigger => ({ trigger, replace: `Text for ${trigger}` })), initial.version)
  const skills = state.skills.switches
  expect(skills).toHaveLength(triggers.length)
  expect(new Set(skills.map(skill => skill.name)).size).toBe(triggers.length)
  expect(skills.some(skill => skill.name === 'review' || skill.name === 'model')).toBe(false)
  for (const skill of skills) expect(library.expandSwitches('Task', [skill.name])).toContain(`Text for ${skill.snippetTrigger}`)
  const next = await library.addSkillSnippet({ trigger: ';café', replace: 'Another case' })
  for (const skill of skills) expect(next.skills.switches.find(item => item.snippetTrigger === skill.snippetTrigger)?.name).toBe(skill.name)
})

it('serializes simultaneous Chat and Snippets additions without losing either', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
    ? library.saveSwitch({ name: `entry-${i}`, content: `Body ${i}`, revision: 0 })
    : library.addSkillSnippet({ trigger: `;entry-${i}`, replace: `Body ${i}` })))
  const state = await library.readSkillSnippets()
  expect(state.snippets).toHaveLength(12); expect(state.skills.switches).toHaveLength(12)
  expect(new Set(state.skills.switches.map(skill => skill.name)).size).toBe(12)
  for (let i = 0; i < 12; i++) expect(library.expandSwitches('', [`entry-${i}`])).toContain(`Body ${i}`)
})

it('rejects stale edits from either surface while preserving unrelated additions', async () => {
  await library.saveSwitch({ name: 'shared', content: 'Original', revision: 0 })
  const initial = await library.readSkillSnippets()
  await library.saveSwitch({ name: 'shared', content: 'Chat edit', revision: 1 })
  await expect(library.saveSkillSnippets([{ trigger: ';shared', replace: 'Stale editor' }], initial.version)).rejects.toMatchObject({ statusCode: 409 })
  let current = await library.readSkillSnippets()
  current = await library.saveSkillSnippets([{ trigger: ';shared', replace: 'Snippet edit' }], current.version)
  await expect(library.saveSwitch({ name: 'shared', content: 'Stale chat', revision: 2 })).rejects.toMatchObject({ statusCode: 409 })
  await library.addSkillSnippet({ trigger: ';unrelated', replace: 'Keep me' })
  const saved = await library.saveSwitch({ name: 'shared', content: 'Latest edit', revision: current.skills.switches[0].revision })
  expect(saved.switches.map(skill => skill.content).sort()).toEqual(['Keep me', 'Latest edit'])
})

it('reads a manual file edit on the next invocation and advances its revision', async () => {
  await library.saveSwitch({ name: 'manual', content: 'Original text', revision: 0 })
  const before = library.readSwitches()
  await writeFile(file, (await readFile(file, 'utf8')).replace('Original text', 'Manually revised'))
  expect(library.expandSwitches('', ['manual'])).toContain('Manually revised')
  const after = library.readSwitches()
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.switches[0].revision).toBe(before.switches[0].revision + 1)
  await writeFile(file, '# poise-chat-library-v1 invalid\nmatches: []\n')
  expect(() => library.readSwitches()).toThrow(/metadata could not be read/)
})

it('rejects a stale edit after a skill was deleted and recreated with the same body', async () => {
  await library.saveSwitch({ name: 'recreated', content: 'Same original body', revision: 0 })
  const original = await library.readSkillSnippets()
  await library.saveSkillSnippets([], original.version)
  const recreated = await library.saveSwitch({ name: 'recreated', content: 'Same original body', revision: 0 })
  expect(recreated.switches[0].revision).toBeGreaterThan(original.skills.switches[0].revision)
  await expect(library.saveSwitch({ name: 'recreated', content: 'A stale editor', revision: original.skills.switches[0].revision })).rejects.toMatchObject({ statusCode: 409 })
  expect(library.readSwitches().switches[0].content).toBe('Same original body')
})
