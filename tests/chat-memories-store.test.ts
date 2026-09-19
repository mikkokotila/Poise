import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { MEMORIES_MAX_BYTES } from '../src/chat-memories-types'
import { appendMemories } from '../server/chat/memory-content'
let root: string
let memories: typeof import('../server/chat/memories')
let http: Server
let origin: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-memories-test-'))
  vi.stubEnv('POISE_DB', join(root, 'db.sqlite3'))
  memories = await import('../server/chat/memories')
  const { handleChatApi } = await import('../server/chat/transport')
  const { enforceApiRequest } = await import('../server/http')
  http = createServer((req, res) => {
    try { enforceApiRequest(req) } catch { res.statusCode = 403; res.end(); return }
    void handleChatApi(req, res, req.url || '', {} as import('../server/chat/runtime').ChatRuntime)
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>(resolve => http.close(() => resolve()))
  ;(await import('../server/db')).closeDatabase()
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
})
describe('shared Chat memories', () => {
  it('defaults empty and stores multiline Unicode text verbatim', () => {
    expect(memories.readMemories()).toEqual({ text: '', revision: 0 })
    const text = '  Use TypeScript.\n\nMuista: ääkköset. 🧠\n'
    expect(memories.saveMemories({ text, revision: 0 })).toEqual({ text, revision: 1 })
    expect(memories.readMemories().text).toBe(text)
  })
  it('deduplicates a repeated save and refuses stale competing writes', () => {
    const current = memories.readMemories()
    expect(memories.saveMemories({ ...current, revision: 0 })).toEqual(current)
    expect(() => memories.saveMemories({ text: 'stale', revision: 0 })).toThrow(/another tab/)
    expect(memories.readMemories()).toEqual(current)
  })
  it('rejects malformed or oversized writes without truncation', () => {
    const current = memories.readMemories()
    for (const value of [null, {}, { text: false, revision: 0 }, { text: 'x', revision: -1 }]) expect(() => memories.saveMemories(value)).toThrow()
    expect(() => memories.saveMemories({ text: 'a'.repeat(MEMORIES_MAX_BYTES + 1), revision: current.revision })).toThrow(/64 KiB/)
    expect(memories.readMemories()).toEqual(current)
  })
  it('clearing removes future suffixes while leaving exact whitespace intact', () => {
    expect(appendMemories('message', '  note\n')).toBe('message\n\n[Memories]\n  note\n')
    expect(appendMemories('message', ' \n')).toBe('message')
    expect(memories.saveMemories({ text: '', revision: memories.readMemories().revision }).text).toBe('')
  })
  it('serves the editor without any session and enforces API origin checks', async () => {
    const data = await (await fetch(`${origin}/api/chat/memories`)).json()
    const saved = await fetch(`${origin}/api/chat/memories`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ text: 'API memory', revision: data.revision }) })
    expect(saved.status).toBe(200)
    expect((await saved.json()).text).toBe('API memory')
    const refused = await fetch(`${origin}/api/chat/memories`, { method: 'PUT', headers: { Origin: 'https://elsewhere.invalid' }, body: '{}' })
    expect(refused.status).toBe(403)
    expect(memories.readMemories().text).toBe('API memory')
  })
})
