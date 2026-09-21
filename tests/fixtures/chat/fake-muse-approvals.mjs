// MSP approval regressions: the next stage can precede the previous RPC ack.
import { createPeer, HANDLED, sleep } from './fake-rpc.mjs'
let sessionId = 'approval-session'
let turnId = ''
let scenario = ''
let current = null
let decisions = []
let cursor = 0
const notify = (method, data) => peer.notify(method, { sessionId, viewCursor: `v:${++cursor}`, ...data })
const choices = [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' }, { choiceId: 'abort', label: 'Reject', decision: 'abort', scope: 'once' }]
function approval(index) {
  return { sessionId, turnId, approvalId: 'compound', itemId: 'shell', taskId: 'shell', toolCallId: 'shell', toolName: 'bash', rawArgs: '{"command":"git status; git diff"}',
    currentRequirementId: { approvalId: 'compound', sourceIndex: index }, availableChoices: choices,
    subject: { kind: 'shell', command: 'git status; git diff', stages: [{ position: index + 1, totalStages: 9 }] }, protectedWrite: false, judgeEscalated: false }
}
function announce() {
  notify('approval/requested', current)
  void peer.request('approval/request', current)
}
function complete() {
  notify('item/delta', { itemId: 'reply', field: 'text', delta: JSON.stringify({ decisions }) })
  notify('turn/completed', { turnId, terminal: 'completed' })
}
const peer = createPeer({ request: async (method, params, id) => {
  if (method === 'initialize') return { serverInfo: { name: 'muse', version: '1.3.0' } }
  if (method === 'model/list') return { models: [{ modelId: 'muse-spark-1.3-contributor', isDefault: true }] }
  if (method === 'session/start' || method === 'session/resume') return { session: { sessionId, modelId: 'muse-spark-1.3-contributor' } }
  if (method === 'session/setReasoningEffort') return { status: 'accepted', commandId: params.commandId }
  if (method === 'session/setApprovalMode') return { status: 'accepted', effectiveMode: { mode: params.mode } }
  if (method === 'approval/listPending') return { approvals: current ? [current] : [], userInputs: [] }
  if (method === 'turn/start') {
    turnId = params.commandId; scenario = params.input[0].text; decisions = []
    peer.respond(id, { status: 'accepted', commandId: turnId, turnId, startedNewTurn: true })
    notify('turn/started', { turnId, commandId: turnId })
    current = approval(0); announce()
    if (scenario === 'external') {
      await sleep(50); current = null
      notify('approval/resolved', { approvalId: 'compound', turnId, itemId: 'shell', decision: 'approved', resolvedBy: 'policy', policyResult: 'allow' })
      complete()
    }
    return HANDLED
  }
  if (method === 'approval/decide') {
    if (scenario === 'delivery-failure') throw { code: -32000, message: 'fixture approval delivery failed' }
    if (scenario === 'rejected-ack') return { status: 'rejected', terminal: false }
    if (!current || params.requirementId.sourceIndex !== current.currentRequirementId.sourceIndex) throw { code: -32053, message: 'stale approval stage' }
    const index = current.currentRequirementId.sourceIndex
    if (decisions.includes(index)) throw { code: -32054, message: 'duplicate stage decision' }
    decisions.push(index)
    if (index === 8 || params.choiceId === 'abort') {
      current = null
      notify('approval/resolved', { approvalId: 'compound', turnId, itemId: 'shell', decision: params.choiceId === 'abort' ? 'abort' : 'approved', policyResult: 'allow' })
      peer.respond(id, { commandId: params.commandId, status: 'accepted', terminal: true })
      complete(); return HANDLED
    }
    const old = current
    current = approval(index + 1)
    if (scenario !== 'lost-update') {
      // Deliberately update and duplicate BEFORE acknowledging this stage.
      notify('approval/updated', current); announce()
      notify('approval/requested', old)
    }
    await sleep(10)
    if (scenario === 'stale-response' && index === 0) throw { code: -32053, message: 'another actor advanced this stage' }
    return { commandId: params.commandId, status: 'accepted', terminal: false }
  }
  if (method === 'turn/interrupt') {
    current = null
    notify('turn/completed', { turnId, terminal: 'cancelled' })
    return { commandId: params.commandId, status: 'accepted' }
  }
  throw { code: -32601, message: `Unsupported fixture method ${method}` }
}, notification: () => {} })
