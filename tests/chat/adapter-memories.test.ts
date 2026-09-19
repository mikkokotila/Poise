import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import { createCodexAdapter } from '../../server/chat/adapters/codex'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import { createFakeHost } from './adapter-harness'

const cases = [
  { name: 'Claude', script: 'fake-claude.mjs', factory: createClaudeAdapter, model: 'claude-opus-5' },
  { name: 'Codex', script: 'fake-codex.mjs', factory: createCodexAdapter, model: 'gpt-6-astra' },
  { name: 'Grok', script: 'queue-agent.mjs', factory: createGrokAdapter, model: 'grok-4.6' },
  { name: 'Muse', script: 'fake-muse.mjs', factory: createMuseAdapter, model: 'muse-spark-1.3-contributor' },
]
describe('memories are last on the actual native wire', () => {
  it.each(cases)('$name appends memories after text, mentions and attachments', async ({ script, factory, model }) => {
    const host = createFakeHost(script)
    let raw = ''
    const spawn = host.spawn
    host.spawn = async (...args) => {
      const child = await spawn(...args)
      const write = child.stdin!.write.bind(child.stdin!)
      child.stdin!.write = ((chunk: any, ...rest: any[]) => {
        raw += String(chunk)
        return (write as any)(chunk, ...rest)
      }) as typeof write
      return child
    }
    writeFileSync(join(host.checkout, 'README.md'), 'Mentioned context')
    const adapter = factory(host)
    const memory = 'Use short sentences.\nKeep Unicode: ä 🧠\n'
    try {
      await adapter.start({ modelId: model, effort: 'high' })
      await adapter.prompt('test-memory', { text: 'echo-input', mentions: [{ path: 'README.md' }], memories: memory,
        attachments: [{ id: 'attachment', name: 'notes.txt', path: 'notes.txt', size: 7, text: 'Details' }],
      }, new AbortController().signal)
      const frames = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      const frame = frames.find(f => f.type === 'user' || f.method === 'session/prompt' || f.method === 'turn/start')
      expect(frame).toBeTruthy()
      const content = frame.message?.content ?? frame.params?.prompt ?? frame.params?.input
      const texts: string[] = typeof content === 'string' ? [content] : content.map((part: any) => part.text ?? part.resource?.text ?? '')
      expect(texts.join('\n')).toContain('Details')
      expect(texts.at(-1)).toMatch(/\[Memories\]/)
      expect(texts.at(-1)!.endsWith(memory)).toBe(true)
      expect(texts.join('\n').split(memory)).toHaveLength(2)
    } finally { await adapter.close().catch(() => undefined); host.dispose() }
  }, 15_000)
})
