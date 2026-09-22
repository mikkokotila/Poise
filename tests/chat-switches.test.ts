import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSwitchCreation, parseChatSwitches, RESERVED_SWITCHES, SWITCH_LIMITS } from '../src/chat-switches'
import { commandBody, modelCompletion, parseChatCommandChain } from '../server/chat/commands'
import { commandDraftText, editableCommandDraft } from '../src/chat-command-draft'
let root: string
let store: typeof import('../server/chat/custom-switches')
let database: typeof import('../server/db')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-switch-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  store = await import('../server/chat/custom-switches'); database = await import('../server/db')
})
beforeEach(() => database.setMeta('chat_custom_switches', ''))
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
const definition = (name = 'velocin-voice', content = 'Write with precision.\nKeep it human. äö 🪶\n') => ({ name, content, revision: 0 })
const names = new Set(['velocin-voice', 'terse'])
describe('saved Chat switches', () => {
  it('parses creation and preserves multiline body literally, including command-looking text', () => {
    const content = '  Use this voice.\n/reset\n/model not-a-model\n'
    expect(parseSwitchCreation('/create /Velocin-Voice\n' + content)).toEqual({ name: 'velocin-voice', content })
    const draft = { text: '/velocin-voice\n' + content, mode: 'create', attachments: [], mentions: [] }
    expect(parseSwitchCreation(commandDraftText(draft)).content).toBe(content)
    expect(editableCommandDraft({ ...draft, text: commandDraftText(draft) })).toEqual(draft)
  })
  it('stores definitions without sessions, and updates only the intended revision', async () => {
    expect(store.readSwitches()).toEqual({ revision: 0, switches: [] })
    const saved = store.saveSwitch(definition())
    expect(saved.switches[0]).toMatchObject({ ...definition(), revision: 1 })
    expect(store.saveSwitch(definition())).toEqual(saved)
    store.saveSwitch(definition('terse', 'Keep it short.'))
    expect(() => store.saveSwitch({ ...definition(), content: 'Stale replacement' })).toThrow(/another tab/)
    const changed = store.saveSwitch({ ...definition(), content: 'Deliberate replacement', revision: 1 })
    expect(changed.switches.find(item => item.name === 'velocin-voice')).toMatchObject({ content: 'Deliberate replacement', revision: 2 })
    vi.resetModules()
    expect((await import('../server/chat/custom-switches')).readSwitches()).toEqual(changed)
    ;(await import('../server/db')).closeDatabase()
  })
  it('refuses reserved, native and malformed names without overwriting any command', () => {
    for (const name of [...RESERVED_SWITCHES, '../outside', 'two words', '<script>', 'a'.repeat(65), '__proto__']) expect(() => store.saveSwitch(definition(name))).toThrow()
    expect(() => store.saveSwitch(definition('native-command'), ['native-command'])).toThrow(/native/)
    expect(() => parseSwitchCreation('/create /name')).toThrow(/instructions/)
    expect(() => parseSwitchCreation('/create missing-slash content')).toThrow(/\/create/)
    expect(store.readSwitches().switches).toEqual([])
  })
  it('bounds UTF-8 text and total expansion without silently truncating', () => {
    expect(() => store.saveSwitch(definition('too-big', 'ä'.repeat(SWITCH_LIMITS.contentBytes)))).toThrow(/64 KiB/)
    for (let i = 0; i < 5; i++) store.saveSwitch(definition(`s${i}`, 'x'.repeat(60 * 1024)))
    expect(() => store.expandSwitches('Task', ['s0', 's1', 's2', 's3', 's4'])).toThrow(/256 KiB/)
    expect(() => store.saveSwitch(definition('empty', ' \n'))).toThrow(/empty/)
    expect(store.readSwitches().switches).toHaveLength(5)
  })
  it('expands only explicitly used switches, once each, without interpreting their bodies', () => {
    store.saveSwitch(definition('velocin-voice', '/reset\n/terse\nSpeak clearly.'))
    store.saveSwitch(definition('terse', 'Unrequested instructions'))
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
  it('retains custom names through queue serialization and model completion', () => {
    const chain = parseChatCommandChain('/queue /velocin-voice /terse /model opus-5-high /review focus', names)
    expect(commandBody(chain)).toBe('/review /velocin-voice /terse focus')
    expect(modelCompletion('/velocin-voice /model op /review', names)?.query).toBe('op')
    expect(modelCompletion('/create /velocin-voice /model op', names)).toBeNull()
    expect(parseChatCommandChain('/create /velocin-voice /reset', names)).toMatchObject({ create: true, text: '/velocin-voice /reset' })
    expect(parseChatCommandChain('Explain /velocin-voice', names).switches).toBeUndefined()
    expect(parseChatCommandChain('/velocin-voice-longer', names).switches).toBeUndefined()
  })
  it('refuses corrupt saved catalogues instead of silently replacing them', () => {
    database.setMeta('chat_custom_switches', '{bad json')
    expect(() => store.readSwitches()).toThrow(/could not be read/)
    expect(() => store.saveSwitch(definition())).toThrow(/could not be read/)
    expect(parseChatSwitches({ revision: 1, switches: [{ ...definition(), revision: 1, name: 'reset', updatedAt: '' }] })).toBeNull()
  })
})

it('keeps the prior definition and revision when the database write fails', () => {
  const current = store.saveSwitch(definition('transaction-skill', 'Original instructions'))
  database.db.exec("CREATE TRIGGER reject_switch_save BEFORE UPDATE ON meta WHEN NEW.key = 'chat_custom_switches' BEGIN SELECT RAISE(ABORT, 'injected save failure'); END")
  try {
    expect(() => store.saveSwitch({ name: 'transaction-skill', content: 'Replacement', revision: 1 })).toThrow(/injected save failure/)
    expect(store.readSwitches()).toEqual(current)
  } finally { database.db.exec('DROP TRIGGER reject_switch_save') }
})

it('bounds the library and validates incoming catalogues without changing saved definitions', () => {
  for (let i = 0; i < SWITCH_LIMITS.count; i++) store.saveSwitch(definition(`custom-${i}`, `Instruction ${i}`))
  const current = store.readSwitches()
  expect(() => store.saveSwitch(definition('one-too-many'))).toThrow(/128-switch/)
  expect(store.readSwitches()).toEqual(current)
  expect(parseChatSwitches({ revision: 1, switches: [{ ...definition(), revision: 2, updatedAt: 'now' }] })).toBeNull()
  expect(parseChatSwitches({ revision: 1, switches: [{ ...definition('large', 'ä'.repeat(SWITCH_LIMITS.contentBytes)), revision: 1, updatedAt: 'now' }] })).toBeNull()
})
