// Test-only ACP peer. No provider calls or user workspaces.
import { randomUUID } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'
import { createPeer, sleep } from './fake-rpc.mjs'
const sessionId = randomUUID()
const peer = createPeer({
  async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new' || method === 'session/resume') {
      peer.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact context' }] } })
      return { sessionId }
    }
    if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, currentValue: params.value }] }
    if (method === 'session/close') return {}
    if (method === 'session/prompt') {
      const text = params.prompt.filter(part => part.type === 'text').map(part => part.text).join('\n')
      writeFileSync('compact-input', text)
      while (process.argv.includes('--compact-gated') && !existsSync('compact-release')) await sleep(10)
      if (!text.startsWith('/compact')) throw new Error('Expected a native compact command')
      if (process.argv.includes('--compact-hold')) return new Promise(() => {})
      await sleep(160)
      if (process.argv.includes('--compact-fail')) throw { code: -32000, message: 'summarizer failed' }
      return { stopReason: 'end_turn' }
    }
    throw { code: -32601, message: `unsupported fixture method ${method}` }
  },
  notification() {},
})
