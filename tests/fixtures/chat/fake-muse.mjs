// A stand-in for `muse serve` (Muse 1.3.0, MSP v1). Speaks the frames recorded
// in muse-session.trace.json and runs a scripted turn chosen by the prompt
// text, so the adapter tests never need the real binary. `--replay <trace>`
// serves a recorded trace instead.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { HANDLED, createPeer, replayTrace, sleep } from './fake-rpc.mjs'

const replayAt = process.argv.indexOf('--replay')
if (replayAt !== -1) {
  replayTrace(process.argv[replayAt + 1])
} else {
  scripted()
}

function scripted() {
  let counter = 0
  const uuid = (prefix) => `${prefix}-${String(++counter).padStart(4, '0')}`
  let cursor = 0
  const viewCursor = () => `v:${sessionId}:${++cursor}`
  const range = () => ({ stream: { kind: 'session', id: sessionId }, first: { id: uuid('rec'), sequence: cursor }, last: { id: uuid('rec'), sequence: cursor } })

  let sessionId = null
  let modelId = 'muse-spark-1.3-contributor'
  let reasoningEffort = 'medium'
  let approvalMode = 'onRequest'
  let turn = null // { id, interrupted, steered: [], decided: [], answered: [] }
  const requireDialogs = process.argv.includes('--require-dialogs')
  const dropSteer = process.argv.includes('--drop-steer')
  const holdAfterSteer = process.argv.includes('--hold-after-steer')
  const reclaimRace = process.argv.includes('--reclaim-race')
  let dialogs = false

  const sessionObject = (id, extra = {}) => ({
    sessionId: id, path: `/tmp/muse/${id}/session.jsonl`, status: 'idle', activeTurnId: null, createdAt: '2026-09-18T13:17:02.687053Z',
    updatedAt: '2026-09-18T13:17:02.687057Z', workspaceRoot: '/tmp/fixture', providerId: 'meta', modelId, turnCount: 0, forkedFrom: null,
    approvalMode: { mode: approvalMode, source: 'startup', lastCommandId: null }, ...extra,
  })
  const models = ['muse-spark-1.3', 'muse-spark-1.3-contributor'].map((id) => ({
    modelId: id, displayLabel: id, providerId: 'meta', profileId: 'tbh', releaseDate: '2026-09-02', description: null,
    contextLimit: 1007997, outputLimit: 128000, cost: null, isActive: false, isDefault: id.endsWith('contributor'),
  }))

  const view = (method, params) => peer.notify(method, { sessionId, viewCursor: viewCursor(), sourceRange: range(), ...params })
  const item = (method, body) => view(method, { item: { revision: 1, status: 'inProgress', turnId: turn.id, recordedAt: new Date().toISOString(), ...body } })

  const peer = createPeer({
    request: async (method, params, id) => {
      switch (method) {
        case 'initialize':
          dialogs = !!params.capabilities?.userInputDialogs
          return {
            serverInfo: { name: 'muse', version: '1.3.0' }, userAgent: 'fake-muse/1.3.0', museHome: '/tmp/muse', platformFamily: 'unix',
            platformOs: 'macos', schema: { version: 1, fingerprint: 'sha256:fake' }, grantedCapabilities: [], experimentalApi: false, sessionDurability: 'durable',
          }
        case 'model/list':
          return { providerId: 'meta', profileId: 'tbh', source: 'providerCatalog', models }
        case 'session/start':
          sessionId = uuid('session')
          modelId = params.modelId ?? modelId
          approvalMode = params.approvalMode ?? 'onRequest'
          peer.notify('session/started', { session: sessionObject(sessionId) })
          return { session: sessionObject(sessionId), viewCursor: viewCursor() }
        case 'session/resume':
          sessionId = params.sessionId
          return { session: sessionObject(sessionId, { modelId: 'muse-spark-1.3' }), viewCursor: viewCursor(), history: { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' }, pendingRequests: [] }
        case 'session/fork': {
          const forked = uuid('fork')
          if (!sessionId) sessionId = forked
          return { session: sessionObject(forked, { forkedFrom: { sessionId: params.sessionId, cutCursor: 'x', cutExplicit: false, commandId: params.commandId } }), viewCursor: `v:${forked}:1`, history: { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' }, pendingRequests: [] }
        }
        case 'view/subscribe':
          return { viewCursor: viewCursor() }
        case 'session/setApprovalMode':
          approvalMode = params.mode
          return { commandId: params.commandId, status: 'accepted', applyOutcome: 'completed', effectiveMode: { mode: approvalMode, source: 'approvalReconfigure', lastCommandId: params.commandId } }
        case 'session/setModel':
          modelId = params.model.modelId
          view('session/modelChanged', { modelId, providerId: 'meta', source: 'user' })
          return { commandId: params.commandId, status: 'accepted' }
        case 'session/setReasoningEffort':
          reasoningEffort = params.reasoningEffort
          view('session/reasoningEffortChanged', { reasoningEffort, source: 'user' })
          return { commandId: params.commandId, status: 'accepted' }
        case 'turn/start': {
          if (turn) throw { code: -32000, message: 'turn already active' }
          turn = { id: params.commandId, interrupted: false, steered: [], decided: [], answered: [], input: params.input, effort: params.reasoningEffort ?? null }
          peer.respond(id, { commandId: params.commandId, status: 'accepted', turnId: turn.id, startedNewTurn: true, disposition: 'started' })
          runTurn().catch((error) => { process.stderr.write(`fake-muse turn failed: ${error?.stack ?? error}\n`) })
          return HANDLED
        }
        case 'turn/steer':
          if (!turn || params.expectedTurnId !== turn.id) throw { code: -32000, message: `no active turn ${params.expectedTurnId}` }
          turn.steered.push({ commandId: params.commandId, text: params.input.map((part) => part.text ?? '').join('') })
          return { commandId: params.commandId, status: 'accepted', turnId: turn.id }
        case 'turn/unqueue': {
          if (reclaimRace) throw { code: -32000, message: 'queued turn already launching' }
          const index = turn?.steered.findIndex(entry => entry.commandId === params.turnId) ?? -1
          if (index < 0) throw { code: -32000, message: 'no queued turn' }
          turn.steered.splice(index, 1)
          view('turn/unqueued', { turnId: params.turnId, commandId: params.turnId })
          return { commandId: params.commandId, status: 'accepted', turnId: params.turnId }
        }
        case 'turn/interrupt':
          if (!turn || (params.turnId && params.turnId !== turn.id)) throw { code: -32000, message: 'no such turn' }
          turn.interrupted = true
          return { commandId: params.commandId, status: 'accepted', turnId: turn.id }
        case 'approval/decide':
          if (!turn) throw { code: -32000, message: 'no turn' }
          if (turn.decided.some((entry) => entry.approvalId === params.approvalId)) throw { code: -32054, message: 'approval already resolved', data: { kind: 'approvalAlreadyResolved' } }
          turn.decided.push(params)
          return { commandId: params.commandId, status: 'accepted', approvalId: params.approvalId, terminal: true }
        case 'userInput/answer':
          if (process.argv.includes('--late-answer-error')) { await sleep(350); throw { code: -32056, message: 'old question already settled' } }
          if (!turn) throw { code: -32000, message: 'no turn' }
          if (turn.answered.some((entry) => entry.userInputId === params.userInputId)) throw { code: -32056, message: `user input ${params.userInputId} is already settled`, data: { kind: 'userInputAlreadySettled' } }
          turn.answered.push(params)
          return { commandId: params.commandId, status: 'accepted', userInputId: params.userInputId }
        case 'userInput/cancel':
          if (!turn) throw { code: -32000, message: 'no turn' }
          turn.answered.push({ ...params, cancelled: true })
          return { commandId: params.commandId, status: 'accepted', userInputId: params.userInputId }
        default:
          throw { code: -32601, message: `Method not found: ${method}`, data: { kind: 'methodNotFound' } }
      }
    },
    notification: () => {},
  })

  const text = () => (turn.input.find((part) => part.type === 'text')?.text ?? '')

  function waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (predicate() || turn.interrupted || Date.now() - started > timeoutMs) resolve()
        else setTimeout(tick, 5)
      }
      tick()
    })
  }

  async function completeTurn(terminal, extra = {}) {
    view('session/statusChanged', { status: 'idle' })
    view('turn/completed', { turnId: turn.id, terminal, durationMs: 42, ...extra })
    turn = null
  }

  async function streamMessage(itemId, chunks) {
    item('item/started', { itemId, kind: 'agentMessage', text: '' })
    for (const delta of chunks) {
      if (turn.interrupted) return false
      peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId, field: 'text', delta })
      await sleep(5)
    }
    item('item/completed', { itemId, kind: 'agentMessage', revision: 2, status: 'completed', text: chunks.join('') })
    return true
  }

  async function runTurn() {
    const prompt = text()
    if (requireDialogs && !dialogs) {
      await completeTurn('failed', { error: { kind: 'configError', message: 'client did not announce userInputDialogs', retryable: false } })
      return
    }
    view('session/branchChanged', { workspaceRoot: '/tmp/fixture', branch: 'main', vcs: 'git' })
    view('session/statusChanged', { status: 'running' })
    view('turn/started', { turnId: turn.id, commandId: turn.id })
    item('item/completed', { itemId: uuid('user'), kind: 'userMessage', status: 'completed', text: prompt, commandId: turn.id })
    const reminderId = uuid('reminder')
    item('item/started', { itemId: reminderId, kind: 'reminderChild', fallbackText: 'Reminder child session', childSessionId: uuid('child'), reminderAgentId: 'skill-reminder', generationId: 1, taskId: uuid('task') })
    view('item/delta', { itemId: reminderId, field: 'text', delta: 'reminder-internal-output' })
    item('item/updated', { itemId: reminderId, kind: 'reminderChild', fallbackText: 'Reminder child session', status: 'inProgress' })
    item('item/completed', { itemId: reminderId, kind: 'reminderChild', fallbackText: 'Reminder child session', status: 'completed' })

    if (prompt.startsWith('fail')) {
      await completeTurn('failed', { error: { kind: 'modelError', message: 'provider returned 503', retryable: true } })
      return
    }

    if (prompt.startsWith('echo-input')) {
      await streamMessage(uuid('msg'), [JSON.stringify({ input: turn.input, effort: turn.effort })])
      await completeTurn('completed')
      return
    }

    if (prompt.startsWith('exit')) {
      peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId: uuid('msg'), field: 'text', delta: 'about to die' })
      process.stderr.write('fake-muse: simulated crash\n')
      await sleep(10)
      process.exit(2)
    }

    if (prompt.startsWith('slow')) {
      const itemId = uuid('msg')
      item('item/started', { itemId, kind: 'agentMessage', text: '' })
      for (let tick = 0; tick < 200 && !turn.interrupted; tick++) {
        peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId, field: 'text', delta: `${tick} ` })
        await sleep(20)
      }
      await completeTurn(turn.interrupted ? 'cancelled' : 'completed', turn.interrupted ? { reason: 'cancelled during model step' } : {})
      return
    }

    if (prompt.startsWith('steer')) {
      const itemId = uuid('msg')
      item('item/started', { itemId, kind: 'agentMessage', text: '' })
      for (let tick = 0; tick < 100 && !turn.steered.length && !turn.interrupted; tick++) {
        peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId, field: 'text', delta: `${tick} ` })
        await sleep(20)
      }
      item('item/completed', { itemId, kind: 'agentMessage', revision: 2, status: 'completed', text: 'first' })
      if (holdAfterSteer) await waitFor(() => turn.interrupted)
      const steered = turn.steered[0]
      await completeTurn(turn.interrupted ? 'cancelled' : 'completed')
      // Muse 1.3.0 (observed live): a steer is accepted against the running
      // turn, that turn completes, and the steered input runs as a NEW turn
      // whose id is the steer's command id. `--drop-steer` never starts it.
      if (steered && !dropSteer) {
        turn = { id: steered.commandId, interrupted: false, steered: [], decided: [], answered: [], input: [{ type: 'text', text: steered.text }], effort: null }
        view('session/statusChanged', { status: 'running' })
        view('turn/started', { turnId: turn.id, commandId: turn.id })
        item('item/completed', { itemId: uuid('user'), kind: 'userMessage', status: 'completed', text: steered.text, steered: true })
        if (reclaimRace) {
          await waitFor(() => turn.interrupted)
          const statusItem = uuid('msg')
          item('item/started', { itemId: statusItem, kind: 'agentMessage', text: '' })
          peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId: statusItem, field: 'text', delta: turn.interrupted ? 'queued turn stopped' : 'queued turn escaped' })
          await completeTurn(turn.interrupted ? 'cancelled' : 'completed')
        } else {
          await streamMessage(uuid('msg'), [`steered: ${steered.text}`])
          await completeTurn('completed')
        }
      }
      return
    }

    if (prompt.startsWith('unknown-request')) {
      const reply = await peer.request('session/nonexistent', { sessionId })
      await streamMessage(uuid('msg'), [`unknown:${reply.error ? reply.error.code : 'ok'}`])
      await completeTurn('completed')
      return
    }

    if (prompt.startsWith('malformed')) {
      peer.raw('garbage line\n')
      peer.raw('42\n')
      peer.raw('{"result":{},"id":{"object":"id"}}\n')
      await streamMessage(uuid('msg'), ['survived'])
      await completeTurn('completed')
      return
    }

    // Default scripted turn: reasoning, a bash call gated by approval that
    // streams output, an edit, a question, then the answer.
    const reasoningId = uuid('reasoning')
    item('item/started', { itemId: reasoningId, kind: 'reasoning', summary: [] })
    peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId: reasoningId, field: 'summary.0', delta: 'thinking…' })
    item('item/completed', { itemId: reasoningId, kind: 'reasoning', revision: 2, status: 'completed', summary: ['thinking…'] })

    const approvalId = uuid('approval')
    const rawArgs = JSON.stringify({ command: 'rm -f marker.txt', description: 'Remove marker' })
    const requirementId = { approvalId, sourceIndex: 0 }
    const availableChoices = [
      { choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
      { choiceId: 'allow_session', label: 'Allow for this session', decision: 'approvedForSession', scope: 'session' },
      { choiceId: 'allow_local_prefix', label: 'Always allow in this workspace: rm ...', decision: 'approvedPolicyAmendment', scope: 'localPersistent', rulePreview: 'Always allow in this workspace: rm ...' },
      { choiceId: 'abort', label: 'Reject', decision: 'abort', scope: 'once', acceptsFeedback: true },
      { choiceId: 'deny_local_prefix', label: 'Always reject in this workspace', decision: 'deniedPolicyAmendment', scope: 'localPersistent' },
    ]
    const approvalParams = {
      sessionId, approvalId, turnId: turn.id, taskId: approvalId, itemId: approvalId, toolCallId: 'call_1', toolName: 'bash', rawArgs,
      viewCursor: viewCursor(), sourceRange: range(),
      subject: { kind: 'shell', command: 'rm -f marker.txt', workspaceRoot: '/tmp/fixture', stages: [{ requirementId, position: 1, totalStages: 1, argv: ['rm', '-f', 'marker.txt'], argvComplete: true, resolution: { kind: 'unresolved' } }] },
      currentRequirementId: requirementId, availableChoices, protectedWrite: false, judgeEscalated: false,
    }
    view('session/statusChanged', { status: 'running', attention: ['approvalPending'] })
    if (dialogs) void peer.request('approval/request', approvalParams)
    peer.notify('approval/requested', approvalParams)
    await waitFor(() => turn.decided.length > 0)
    if (turn.interrupted) { await completeTurn('cancelled'); return }
    const decision = turn.decided[0]
    const choice = availableChoices.find((entry) => entry.choiceId === decision.choiceId)
    view('approval/resolved', { approvalId, itemId: approvalId, turnId: turn.id, decision: choice?.decision ?? 'abort', policyResult: choice?.decision?.startsWith('approved') ? 'allow' : 'deny', resolvedBy: 'user', decidedByCommandId: decision.commandId, stageEvidence: [] })
    item('item/started', { itemId: approvalId, kind: 'toolCall', tool: 'bash', callId: 'call_1', args: rawArgs })
    if (choice?.decision?.startsWith('approved')) {
      peer.notify('item/delta', { sessionId, viewCursor: viewCursor(), itemId: approvalId, field: 'output', delta: 'removed marker\n' })
      await sleep(20)
      item('item/completed', { itemId: approvalId, kind: 'toolCall', revision: 2, status: 'completed', tool: 'bash', callId: 'call_1', args: rawArgs, visibleOutput: JSON.stringify({ chunk_id: 'exec-1-1', command: 'rm -f marker.txt', exit_code: 0, terminal_status: 'completed', output: 'removed marker\n', truncated: false }) })
    } else {
      item('item/completed', { itemId: approvalId, kind: 'toolCall', revision: 2, status: 'rejected', tool: 'bash', callId: 'call_1', args: rawArgs, failureReason: 'rejected by user' })
    }
    await streamMessage(uuid('msg'), [`decided:${decision.choiceId} requirement:${decision.requirementId?.sourceIndex}`])

    // Edit-family calls really touch the files (the checkout is the cwd).
    // Protected writes go through an approval first, as Muse's onRequest
    // mode does; the adapter takes its pre-images while the decision is
    // pending. A write that needs no approval is applied straight away, and
    // the adapter has no moment before it to capture.
    const approvedEdit = async (tool, args, apply, completed) => {
      const editId = uuid('edit')
      const rawArgs = JSON.stringify(args)
      const requirement = { approvalId: editId, sourceIndex: 0 }
      const editChoices = availableChoices.filter((entry) => entry.scope !== 'localPersistent')
      const params = {
        sessionId, approvalId: editId, turnId: turn.id, taskId: editId, itemId: editId, toolCallId: editId, toolName: tool, rawArgs,
        viewCursor: viewCursor(), sourceRange: range(),
        subject: { kind: 'fileAccess', path: args.path ?? args.file_path, access: 'write', workspaceRoot: '/tmp/fixture' },
        currentRequirementId: requirement, availableChoices: editChoices, protectedWrite: true, judgeEscalated: false,
      }
      peer.notify('approval/requested', params)
      await waitFor(() => turn.decided.some((entry) => entry.approvalId === editId))
      const picked = turn.decided.find((entry) => entry.approvalId === editId)
      const approved = editChoices.find((entry) => entry.choiceId === picked.choiceId)?.decision?.startsWith('approved')
      view('approval/resolved', { approvalId: editId, itemId: editId, turnId: turn.id, decision: approved ? 'approved' : 'abort', policyResult: approved ? 'allow' : 'deny', resolvedBy: 'user', decidedByCommandId: picked.commandId, stageEvidence: [] })
      item('item/started', { itemId: editId, kind: 'toolCall', tool, callId: editId, args: rawArgs })
      if (approved) {
        apply()
        item('item/completed', { itemId: editId, kind: 'toolCall', revision: 2, status: 'completed', tool, callId: editId, args: rawArgs, ...completed })
      } else {
        item('item/completed', { itemId: editId, kind: 'toolCall', revision: 2, status: 'rejected', tool, callId: editId, args: rawArgs, failureReason: 'rejected by user' })
      }
    }
    await approvedEdit('edit', { path: 'README.md', old_string: 'old', new_string: 'new' },
      () => { if (existsSync('README.md')) writeFileSync('README.md', readFileSync('README.md', 'utf8').replace('old', 'new')) },
      { patchSummary: { files: 1, added: 1, removed: 1 }, patchRef: { id: 'patch-1', kind: 'tool_patch', uri: 'muse://patch-1', byteLen: 10, availability: 'available', mediaType: 'application/json' } })

    // An unprotected write: applied without an approval round-trip.
    const writeId = uuid('write')
    const writeArgs = JSON.stringify({ file_path: 'NEW.md', content: 'hello\n' })
    item('item/started', { itemId: writeId, kind: 'toolCall', tool: 'write', callId: 'call_4', args: writeArgs })
    writeFileSync('NEW.md', 'hello\n')
    item('item/completed', { itemId: writeId, kind: 'toolCall', revision: 2, status: 'completed', tool: 'write', callId: 'call_4', args: writeArgs, visibleOutput: 'wrote NEW.md', patchSummary: { files: 1, added: 1, removed: 0 } })

    await approvedEdit('patch', { path: 'GONE.md', op: 'delete' },
      () => { if (existsSync('GONE.md')) unlinkSync('GONE.md') },
      { patchSummary: { files: 1, added: 0, removed: 1 } })

    await approvedEdit('edit', { path: 'BIG.md', old_string: 'big', new_string: 'bigger' },
      () => { if (existsSync('BIG.md')) writeFileSync('BIG.md', 'bigger\n') },
      { patchSummary: { files: 1, added: 1, removed: 1 } })

    const userInputId = uuid('input')
    const questions = [{ id: 'letter', header: 'Letter', question: 'Which letter?', selection: { mode: 'single' }, options: [{ label: 'A' }, { label: 'B' }] }, { id: 'toppings', header: 'Toppings', question: 'Which toppings?', selection: { mode: 'multiple', minSelections: 0, maxSelections: 2 }, options: [{ label: 'cheese' }, { label: 'olives' }] }]
    const inputParams = { sessionId, userInputId, turnId: turn.id, itemId: userInputId, toolCallId: 'call_3', toolName: 'request_user_input', viewCursor: viewCursor(), sourceRange: range(), questions }
    item('item/started', { itemId: userInputId, kind: 'toolCall', tool: 'request_user_input', callId: 'call_3', args: JSON.stringify({ questions }) })
    view('session/statusChanged', { status: 'running', attention: ['inputPending'] })
    if (dialogs) void peer.request('userInput/request', inputParams)
    peer.notify('userInput/requested', inputParams)
    await waitFor(() => turn.answered.length > 0)
    if (turn.interrupted) { await completeTurn('cancelled'); return }
    const answer = turn.answered[0]
    item('item/completed', { itemId: userInputId, kind: 'toolCall', revision: 2, status: 'completed', tool: 'request_user_input', callId: 'call_3', args: JSON.stringify({ questions }), visibleOutput: JSON.stringify(answer.cancelled ? { status: 'cancelled' } : { status: 'answered', answers: answer.answers }) })
    await streamMessage(uuid('msg'), [`answers:${JSON.stringify(answer.answers ?? null)} answered:${turn.answered.length}`])

    view('session/tokenUsage', { turnId: turn.id, modelId, usage: { inputTokens: 100, outputTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 5 }, promptTokens: 100, totalTokens: 130, durationMs: 10, cumulative: { promptTokens: 100, outputTokens: 30, totalTokens: 130 } })
    // A subagent that never completes: the adapter closes it at turn end.
    item('item/started', { itemId: uuid('sub'), kind: 'subagent', objective: 'never finishes', subagentId: 'sub-1' })
    await completeTurn(turn.interrupted ? 'cancelled' : 'completed')
  }
}
