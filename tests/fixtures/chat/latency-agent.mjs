// A separate ACP process: timestamps are taken before bytes enter stdout.
// No models, credentials, external services, or repository mutations.
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
      for (let index = 0; index < 8 && !cancelled; index++) {
        const text = `LATENCY_MARKER_${index}_${Date.now()}\n`
        peer.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
        await sleep(100)
      }
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
    }
    throw { code: -32601, message: `unsupported fixture method ${method}` }
  },
  notification(method) { if (method === 'session/cancel') cancelled = true },
})
