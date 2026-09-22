// Real ACP process used only by the message-queue integration. No provider calls.
import { randomUUID } from 'node:crypto'
import { createPeer, sleep } from './fake-rpc.mjs'
const sessionId = randomUUID()
let cancelled = false
let interjected = false
const peer = createPeer({
  async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new' || method === 'session/resume') {
      peer.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact context' }] } })
      return { sessionId }
    }
    if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, currentValue: params.value }] }
    if (method === '_x.ai/interject') { interjected = true; return {} }
    if (method === 'session/prompt') {
      cancelled = false; interjected = false
      const text = (params.prompt || []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      if (text.startsWith('/compact')) { await sleep(80); return { stopReason: 'end_turn' } }
      if (text.includes('QC steering task')) {
        for (let i = 0; i < 500 && !interjected && !cancelled; i++) await sleep(20)
        if (!interjected && !cancelled) throw new Error('fixture steering never arrived')
      } else await sleep(text.includes('First now') ? 1800 : 120)
      peer.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `DONE: ${text}` } } })
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
    }
    throw { code: -32601, message: `unsupported fixture method ${method}` }
  },
  notification(method) { if (method === 'session/cancel') cancelled = true },
})
