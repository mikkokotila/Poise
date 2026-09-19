// Real ACP process used only by the message-queue integration. No provider calls.
import { randomUUID } from 'node:crypto'
import { createPeer, sleep } from './fake-rpc.mjs'
const sessionId = randomUUID()
let cancelled = false
const peer = createPeer({
  async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new' || method === 'session/resume') return { sessionId }
    if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, currentValue: params.value }] }
    if (method === 'session/prompt') {
      cancelled = false
      const text = (params.prompt || []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      await sleep(text.includes('First now') ? 1800 : 120)
      peer.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `DONE: ${text}` } } })
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
    }
    throw { code: -32601, message: `unsupported fixture method ${method}` }
  },
  notification(method) { if (method === 'session/cancel') cancelled = true },
})
