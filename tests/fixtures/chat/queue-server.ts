// Test-only server: the production ChatRuntime, ACP adapter, SQLite and WS.
// The native executable is always a scripted ACP peer, never a live model.
// All repository/database state stays under the test root.
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ChatRuntime } from '../../../server/chat/runtime'
import { ChatSocketServer, handleChatApi } from '../../../server/chat/transport'
import { createGrokAdapter } from '../../../server/chat/adapters/grok'
import { enforceApiRequest } from '../../../server/http'
import { CATALOG } from '../../model-catalog-fixture'

const root = process.env.LATENCY_ROOT!
const checkout = join(root, 'repo')
const sourceRoot = process.env.LATENCY_SOURCE_ROOT!
const live = false
await mkdir(checkout, { recursive: true })
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' })
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Poise latency fixture')
git('config', 'user.email', 'latency@example.invalid')
git('config', 'commit.gpgsign', 'false')
git('config', 'core.hooksPath', '/dev/null')
await writeFile(join(checkout, 'README.md'), '# Isolated latency fixture\n')
git('add', 'README.md'); git('commit', '-q', '-m', 'fixture')
const nativeFrames: Array<{ at: number, text: string }> = []
const nativeInputs: unknown[] = []
let spawnCount = 0
const runtime = new ChatRuntime({
  instance: 'latency-fixture', instanceLabel: 'test', callerTurns: null,
  catalog: async () => CATALOG, resolveCheckout: async () => checkout,
  idleTimeoutMinutes: () => 0, probeAgent: async () => ({ ok: true }),
  adapters: { grok: host => createGrokAdapter({ ...host, async spawn(command, args, options) {
    spawnCount++
    const child = await host.spawn(live ? command : process.execPath,
      live ? args : [join(sourceRoot, 'tests/fixtures/chat/queue-agent.mjs')], options)
    // Observe before StdioRpc installs its listener. Keep only assistant text,
    // never native settings/MCP/environment messages.
    let tail = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      const at = Date.now(); tail += chunk.toString('utf8')
      const lines = tail.split('\n'); tail = lines.pop() || ''
      if (tail.length > 1024 * 1024) tail = ''
      for (const line of lines) {
        try {
          const frame = JSON.parse(line)
          if (frame.method === 'session/update' && frame.params?.update?.sessionUpdate === 'agent_message_chunk') {
            nativeFrames.push({ at, text: String(frame.params.update.content?.text || '') })
          }
        } catch { /* partial/non-protocol diagnostic */ }
      }
    })
    // Test-only capture of the serialized human message, after all adapters.
    const write = child.stdin!.write.bind(child.stdin!)
    let outgoing = ''
    child.stdin!.write = ((chunk: any, ...rest: any[]) => {
      outgoing += String(chunk)
      const lines = outgoing.split('\n'); outgoing = lines.pop() || ''
      for (const line of lines) {
        try { const frame = JSON.parse(line); if (frame.method === 'session/prompt') nativeInputs.push(frame.params.prompt) } catch { /* partial frame */ }
      }
      return (write as any)(chunk, ...rest)
    }) as typeof write
    return child
  } }) },
})
const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: 'fixture/latency', branch: { existing: 'main' }, title: 'Queue integration', deferStart: true })
const deadline = Date.now() + 60_000
while (runtime.get(record.id)?.status !== 'idle') {
  if (Date.now() > deadline || runtime.get(record.id)?.status === 'error') throw new Error('latency fixture could not start the agent')
  await new Promise(resolve => setTimeout(resolve, 25))
}
const sockets = new ChatSocketServer(runtime)
function json(res: ServerResponse, value: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
const server = createServer((req, res) => {
  void (async () => {
    enforceApiRequest(req)
    const path = (req.url || '/').split('?')[0]
    if (path === '/__test__/timings') return json(res, { nativeFrames, nativeInputs, spawnCount, live, sessionId: record.id, session: runtime.get(record.id), events: runtime.events(record.id, 0).events })
    if (path === '/api/settings') return json(res, { org: 'fixture', me: 'test', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 0 } })
    if (path === '/api/claude-auth') return json(res, { status: 'authenticated', reason: null, loginInProgress: false })
    if (path === '/api/models') return json(res, { catalog: CATALOG, places: [], fixed: [], refresh: null })
    if (path === '/api/chat/agents') return json(res, { agents: [{ id: 'grok', label: 'Grok Build', available: true, models: CATALOG.models.filter(m => m.provider === 'grok'), efforts: ['high'] }], defaults: { model: 'grok-4.6-high', fallback: 'grok-4.6-high' }, settings: { branchPrefix: 'chat/', idleTimeoutMinutes: 0 } })
    if (await handleChatApi(req, res, req.url || '', runtime)) return
    if (path.startsWith('/api/')) return json(res, {})
    // Serve the built app from Playwright's existing preview server; no API
    // or WebSocket request is proxied to that server or to production.
    const response = await fetch(new URL(req.url || '/', process.env.LATENCY_ASSETS_URL!), { signal: AbortSignal.timeout(10_000) })
    res.statusCode = response.status
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream')
    res.end(Buffer.from(await response.arrayBuffer()))
  })().catch(error => { res.statusCode = 500; json(res, { error: error instanceof Error ? error.message : String(error) }) })
})
sockets.attach(server)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
console.log(JSON.stringify({ port: (server.address() as { port: number }).port, sessionId: record.id }))
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await sockets.close(); await runtime.stop(); server.close(); process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
