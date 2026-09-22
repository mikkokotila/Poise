import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSwitchCreation, parseChatSwitches, RESERVED_SWITCHES, SWITCH_LIMITS } from '../src/chat-switches'
import { commandBody, modelCompletion, parseChatCommandChain } from '../server/chat/commands'
import { commandDraftText, editableCommandDraft } from '../src/chat-command-draft'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
let root: string
let store: typeof import('../server/chat/custom-switches')
let database: typeof import('../server/db')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-switch-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  store = await import('../server/chat/custom-switches'); database = await import('../server/db')
})
beforeEach(async () => {
  database.setMeta('chat_custom_switches', '')
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_index:%'").run()
  await rm(join(process.env.POISE_ESPANSO_MATCH_DIR!, 'poise.yml'), { force: true })
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
const definition = (name = 'velocin-voice', content = 'Write with precision.\nKeep it human. äö 🪶\n') => ({ name, content, revision: 0 })
const names = new Set(['velocin-voice', 'terse'])
describe('saved Chat switches', () => {
  it('parses creation and preserves multiline body literally, including command-looking text', async () => {
    const content = '  Use this voice.\n/reset\n/model not-a-model\n'
    expect(parseSwitchCreation('/create /Velocin-Voice\n' + content)).toEqual({ name: 'velocin-voice', content })
    const draft = { text: '/velocin-voice\n' + content, mode: 'create', attachments: [], mentions: [] }
    expect(parseSwitchCreation(commandDraftText(draft)).content).toBe(content)
    expect(editableCommandDraft({ ...draft, text: commandDraftText(draft) })).toEqual(draft)
  })
  it('stores definitions without sessions, and updates only the intended revision', async () => {
    expect(store.readSwitches()).toEqual({ revision: 0, switches: [] })
    const saved = await store.saveSwitch(definition())
    expect(saved.switches[0]).toMatchObject({ ...definition(), revision: 1 })
    expect(await store.saveSwitch(definition())).toEqual(saved)
    await store.saveSwitch(definition('terse', 'Keep it short.'))
    await expect(store.saveSwitch({ ...definition(), content: 'Stale replacement' })).rejects.toThrow(/another tab/)
    const changed = await store.saveSwitch({ ...definition(), content: 'Deliberate replacement', revision: 1 })
    expect(changed.switches.find(item => item.name === 'velocin-voice')).toMatchObject({ content: 'Deliberate replacement', revision: 2 })
    database.closeDatabase(); vi.resetModules()
    store = await import('../server/chat/custom-switches'); database = await import('../server/db')
    expect(store.readSwitches()).toEqual(changed)
  })
  it('refuses reserved, native and malformed names without overwriting any command', async () => {
    for (const name of [...RESERVED_SWITCHES, '../outside', 'two words', '<script>', 'a'.repeat(65), '__proto__']) await expect(store.saveSwitch(definition(name))).rejects.toThrow()
    await expect(store.saveSwitch(definition('native-command'), ['native-command'])).rejects.toThrow(/native/)
    expect(() => parseSwitchCreation('/create /name')).toThrow(/instructions/)
    expect(() => parseSwitchCreation('/create missing-slash content')).toThrow(/\/create/)
    expect(store.readSwitches().switches).toEqual([])
  })
  it('bounds UTF-8 text and total expansion without silently truncating', async () => {
    await expect(store.saveSwitch(definition('too-big', 'ä'.repeat(SWITCH_LIMITS.contentBytes)))).rejects.toThrow(/64 KiB/)
    for (let i = 0; i < 5; i++) await store.saveSwitch(definition(`s${i}`, 'x'.repeat(60 * 1024)))
    expect(() => store.expandSwitches('Task', ['s0', 's1', 's2', 's3', 's4'])).toThrow(/256 KiB/)
    await expect(store.saveSwitch(definition('empty', ' \n'))).rejects.toThrow(/empty/)
    expect(store.readSwitches().switches).toHaveLength(5)
  })
  it('expands only explicitly used switches, once each, without interpreting their bodies', async () => {
    await store.saveSwitch(definition('velocin-voice', '/reset\n/terse\nSpeak clearly.'))
    await store.saveSwitch(definition('terse', 'Unrequested instructions'))
    const expanded = store.expandSwitches('Write the introduction.', ['velocin-voice', 'velocin-voice'])
    expect(expanded).toBe('Write the introduction.\n\n[Saved switch: /velocin-voice]\n/reset\n/terse\nSpeak clearly.\n[End saved switch: /velocin-voice]')
    expect(expanded).not.toContain('Unrequested instructions')
    expect(store.expandSwitches('Explain /velocin-voice in prose', undefined)).toBe('Explain /velocin-voice in prose')
    expect(() => store.expandSwitches('Task', ['missing'])).toThrow(/unavailable/)
  })
  it.each(['/model opus-5-high /velocin-voice /review check claims', '/velocin-voice /model opus-5-high /review check claims'])(
    'composes model, custom switch and review in %s', text => {
      expect(parseChatCommandChain(text, names)).toEqual({ model: 'opus-5-high', switches: ['velocin-voice'], review: true, queue: false, missingModel: false, text: 'check claims' })
    })
  it('retains custom names through queue serialization and model completion', async () => {
    const chain = parseChatCommandChain('/queue /velocin-voice /terse /model opus-5-high /review focus', names)
    expect(commandBody(chain)).toBe('/review /velocin-voice /terse focus')
    expect(modelCompletion('/velocin-voice /model op /review', names)?.query).toBe('op')
    expect(modelCompletion('/create /velocin-voice /model op', names)).toBeNull()
    expect(parseChatCommandChain('/create /velocin-voice /reset', names)).toMatchObject({ create: true, text: '/velocin-voice /reset' })
    expect(parseChatCommandChain('Explain /velocin-voice', names).switches).toBeUndefined()
    expect(parseChatCommandChain('/velocin-voice-longer', names).switches).toBeUndefined()
  })
  it('refuses corrupt saved catalogues instead of silently replacing them', async () => {
    database.setMeta('chat_custom_switches', '{bad json')
    expect(() => store.readSwitches()).toThrow(/could not be read/)
    await expect(store.saveSwitch(definition())).rejects.toThrow(/could not be read/)
    expect(parseChatSwitches({ revision: 1, switches: [{ ...definition(), revision: 1, name: 'reset', updatedAt: '' }] })).toBeNull()
  })
})

it('keeps the prior definition and revision when the snippet file commit fails', async () => {
  const current = await store.saveSwitch(definition('transaction-skill', 'Original instructions'))
  const files = await import('node:fs/promises')
  const rename = vi.mocked(files.rename).mockRejectedValueOnce(new Error('injected save failure'))
  try {
    await expect(store.saveSwitch({ name: 'transaction-skill', content: 'Replacement', revision: 1 })).rejects.toThrow(/injected save failure/)
    expect(store.readSwitches()).toEqual(current)
  } finally { rename.mockClear() }
})

it('includes larger snippet libraries and rejects oversized file writes without changing them', async () => {
  const library = await import('../server/snippet-library')
  const initial = await library.readSkillSnippets()
  const entries = Array.from({ length: 130 }, (_, i) => ({ trigger: `;custom-${i}`, replace: `Instruction ${i}` }))
  const state = await library.saveSkillSnippets(entries, initial.version)
  expect(store.readSwitches().switches).toHaveLength(130)
  expect(parseChatSwitches(state.skills)).toEqual(state.skills)
  await expect(library.saveSkillSnippets([...entries, { trigger: ';too-large', replace: 'x'.repeat(1024 * 1024) }], state.version)).rejects.toThrow(/serialized snippets exceed/)
  expect(store.readSwitches()).toEqual(state.skills)
  expect(parseChatSwitches({ revision: 1, switches: [{ ...definition(), revision: 2, updatedAt: 'now' }] })).toBeNull()
  expect(parseChatSwitches({ revision: 1, switches: [{ ...definition('large', 'x'.repeat(1024 * 1024 + 1)), revision: 1, updatedAt: 'now' }] })).toBeNull()
})
