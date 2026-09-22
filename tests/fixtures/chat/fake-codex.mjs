// A stand-in for `codex app-server --listen stdio://` (codex-cli 0.154.0).
// Speaks the v2 app-server frames recorded in codex-handshake.trace.json and
// runs a scripted turn chosen by the prompt text, so the adapter tests never
// need the real binary. `--replay <trace>` serves a recorded trace instead.

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  const thread = (id, extra = {}) => ({
    id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null,
    sectionEnteredAt: null, projectId: null, historyMode: 'paginated', modelProvider: 'openai', model: 'gpt-6-astra',
    reasoningEffort: 'xhigh', createdAt: 1789737150, updatedAt: 1789737150, recencyAt: 1789737150, status: { type: 'idle' },
    path: null, cwd: '/tmp/fixture', cliVersion: '0.154.0', originator: 'poise', source: 'vscode', threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [], ...extra,
  })
  const threadResponse = (t) => ({
    thread: t, model: 'gpt-6-astra', modelProvider: 'openai', serviceTier: 'default', cwd: t.cwd, instructionSources: [],
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: 'xhigh',
  })
  const models = [
    {
      id: 'gpt-6-astra', model: 'gpt-6-astra', upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: 'GPT-6-Astra',
      description: '', modelSpecialty: null, hidden: false,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: false, multiAgentVersion: 'v2',
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: true,
    },
    {
      id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: 'GPT-5.6-Sol',
      description: '', modelSpecialty: null, hidden: false,
      supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: false, multiAgentVersion: null,
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: false,
    },
  ]

  let threadId = null
  let turn = null // { id, interrupted, steered: [] }

  const turnObject = (id, status, error = null) => ({ id, items: [], itemsView: 'notLoaded', status, error, startedAt: null, completedAt: null, durationMs: null })
  const itemEvent = (kind, item) => peer.notify(kind, { item, threadId, turnId: turn.id, ...(kind === 'item/started' ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }) })

  const peer = createPeer({
    request: async (method, params, id) => {
      switch (method) {
        case 'initialize':
          return { userAgent: 'fake-codex/0.154.0', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'macos' }
        case 'model/list':
          return { data: models, nextCursor: null }
        case 'thread/start':
          threadId = uuid('thread')
          return threadResponse(thread(threadId, { cwd: params.cwd, model: params.model ?? 'gpt-6-astra' }))
        case 'thread/resume':
          threadId = params.threadId
          return threadResponse(thread(threadId))
        case 'thread/fork': {
          const forked = uuid('fork')
          if (!threadId) threadId = forked
          return threadResponse(thread(forked, { forkedFromId: params.threadId }))
        }
        case 'thread/compact/start': {
          const id2 = uuid('compact')
          writeFileSync('compact-admitted', 'yes')
          peer.notify('item/completed', { threadId, turnId: 'old-compact', item: { type: 'contextCompaction', id: 'old-item' } })
          peer.notify('turn/completed', { threadId, turn: turnObject('old-compact', 'completed') })
          peer.notify('turn/started', { threadId, turn: turnObject(id2, 'inProgress') })
          const complete = () => {
            if (process.argv.includes('--compact-gated') && !existsSync('compact-release')) { setTimeout(complete, 10); return }
            if (process.argv.includes('--compact-hold')) return
            const fail = process.argv.includes('--compact-fail')
            if (!fail) peer.notify('item/completed', { threadId, turnId: id2, item: { type: 'contextCompaction', id: uuid('item') } })
            peer.notify('turn/completed', { threadId, turn: turnObject(id2, fail ? 'failed' : 'completed', fail ? { message: 'summarizer failed', codexErrorInfo: null } : null) })
          }
          if (process.argv.includes('--compact-before-ack')) complete()
          else setTimeout(complete, 160)
          return {}
        }
        case 'turn/start': {
          if (turn) throw { code: -32000, message: 'turn already active' }
          turn = { id: uuid('turn'), interrupted: false, steered: [], input: params.input, effort: params.effort ?? null, model: params.model ?? null }
          peer.respond(id, { turn: turnObject(turn.id, 'inProgress') })
          runTurn().catch((error) => { process.stderr.write(`fake-codex turn failed: ${error?.stack ?? error}\n`) })
          return HANDLED
        }
        case 'turn/steer': {
          if (!turn || params.expectedTurnId !== turn.id) throw { code: -32000, message: `no active turn ${params.expectedTurnId}` }
          turn.steered.push(params.input.map((part) => part.text ?? '').join(''))
          return { turnId: turn.id }
        }
        case 'turn/interrupt': {
          if (!turn || params.turnId !== turn.id) throw { code: -32000, message: 'no such turn' }
          turn.interrupted = true
          return {}
        }
        default:
          throw { code: -32601, message: `Method not found: ${method}` }
      }
    },
    notification: () => {},
  })

  const text = () => (turn.input.find((part) => part.type === 'text')?.text ?? '')

  async function completeTurn(status, error = null) {
    peer.notify('turn/completed', { threadId, turn: turnObject(turn.id, status, error) })
    turn = null
  }

  async function streamMessage(itemId, chunks) {
    itemEvent('item/started', { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null, delivery: null, questions: null })
    for (const delta of chunks) {
      if (turn.interrupted) return false
      peer.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId, delta })
      await sleep(5)
    }
    itemEvent('item/completed', { type: 'agentMessage', id: itemId, text: chunks.join(''), phase: null, memoryCitation: null, delivery: null, questions: null })
    return true
  }

  async function runTurn() {
    const prompt = text()
    peer.notify('thread/started', { thread: thread(threadId) })
    peer.notify('deprecationNotice', { summary: 'fake deprecation', details: null })
    peer.notify('mcpServer/startupStatus/updated', { threadId, name: 'fake', status: 'ready', error: null, failureReason: null })
    peer.notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
    peer.notify('turn/started', { threadId, turn: turnObject(turn.id, 'inProgress') })

    if (prompt.startsWith('usage-limit')) {
      const error = { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 22nd, 2026 8:33 AM.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null }
      peer.notify('error', { error, willRetry: false, threadId, turnId: turn.id })
      await completeTurn('failed', error)
      return
    }

    if (prompt.startsWith('echo-input')) {
      await streamMessage(uuid('msg'), [JSON.stringify({ input: turn.input, model: turn.model, effort: turn.effort })])
      await completeTurn('completed')
      return
    }

    if (prompt.startsWith('exit')) {
      peer.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: uuid('msg'), delta: 'about to die' })
      process.stderr.write('fake-codex: simulated crash\n')
      await sleep(10)
      process.exit(1)
    }

    if (prompt.startsWith('slow')) {
      const itemId = uuid('msg')
      itemEvent('item/started', { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null, delivery: null, questions: null })
      for (let tick = 0; tick < 200 && !turn.interrupted; tick++) {
        peer.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId, delta: `${tick} ` })
        await sleep(20)
      }
      await completeTurn(turn.interrupted ? 'interrupted' : 'completed')
      return
    }

    if (prompt.startsWith('steer')) {
      const itemId = uuid('msg')
      itemEvent('item/started', { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null, delivery: null, questions: null })
      for (let tick = 0; tick < 100 && !turn.steered.length && !turn.interrupted; tick++) {
        peer.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId, delta: `${tick} ` })
        await sleep(20)
      }
      itemEvent('item/completed', { type: 'agentMessage', id: itemId, text: 'first', phase: null, memoryCitation: null, delivery: null, questions: null })
      if (turn.steered.length) await streamMessage(uuid('msg'), [`steered: ${turn.steered[0]}`])
      await completeTurn(turn.interrupted ? 'interrupted' : 'completed')
      return
    }

    if (prompt.startsWith('unknown-request')) {
      const reply = await peer.request('attestation/generate', { nonce: 'abc' })
      const elicitation = await peer.request('mcpServer/elicitation/request', { threadId, turnId: turn.id, serverName: 'fake', mode: 'url', _meta: null, message: 'open', url: 'https://example.invalid', elicitationId: 'e1' })
      const legacy = await peer.request('execCommandApproval', { conversation_id: threadId, call_id: 'c1', command: ['rm'], cwd: '/tmp', reason: null })
      await streamMessage(uuid('msg'), [
        `attestation:${reply.error ? reply.error.code : 'ok'} `,
        `elicitation:${elicitation.result?.action ?? 'none'} `,
        `legacy:${JSON.stringify(legacy.result?.decision ?? null)}`,
      ])
      await completeTurn('completed')
      return
    }

    if (prompt.startsWith('malformed')) {
      peer.raw('this is not json\n')
      peer.raw('[1,2,3]\n')
      peer.raw('{"nothing":"here"}\n')
      peer.raw('{"id":"unknown-response","result":{}}\n')
      await streamMessage(uuid('msg'), ['survived'])
      await completeTurn('completed')
      return
    }

    if (prompt.startsWith('big-output')) {
      const itemId = uuid('cmd')
      itemEvent('item/started', { type: 'commandExecution', id: itemId, pluginId: null, scriptPath: null, command: 'yes', cwd: '/tmp/fixture', processId: null, source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null })
      const chunk = 'y'.repeat(64 * 1024)
      for (let index = 0; index < 6; index++) {
        peer.notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId, delta: chunk })
        await sleep(2)
      }
      await sleep(200)
      itemEvent('item/completed', { type: 'commandExecution', id: itemId, pluginId: null, scriptPath: null, command: 'yes', cwd: '/tmp/fixture', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: null, exitCode: 0, durationMs: 12 })
      await completeTurn('completed')
      return
    }

    // Default scripted turn: text, reasoning, a command that needs approval
    // and streams output, a file change, an MCP tool, a question, a plan.
    await streamMessage(uuid('msg'), ['Hello', ' from', ' fake Codex'])

    const reasoningId = uuid('reasoning')
    itemEvent('item/started', { type: 'reasoning', id: reasoningId, summary: [], content: [] })
    peer.notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: reasoningId, delta: 'thinking…', summaryIndex: 0 })
    itemEvent('item/completed', { type: 'reasoning', id: reasoningId, summary: ['thinking…'], content: [] })

    const wholeReasoningId = uuid('reasoning')
    itemEvent('item/completed', { type: 'reasoning', id: wholeReasoningId, summary: ['whole reasoning'], content: [] })

    const commandId = uuid('cmd')
    const command = { type: 'commandExecution', id: commandId, pluginId: null, scriptPath: null, command: 'rm -f marker.txt', cwd: '/tmp/fixture', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'rm -f marker.txt' }], aggregatedOutput: null, exitCode: null, durationMs: null }
    itemEvent('item/started', command)
    const approval = await peer.request('item/commandExecution/requestApproval', {
      kind: 'command', threadId, turnId: turn.id, itemId: commandId, startedAtMs: Date.now(), approvalId: null, environmentId: null,
      reason: 'needs approval', command: command.command, cwd: command.cwd, commandActions: command.commandActions,
    })
    const decision = approval.result?.decision ?? 'decline'
    if (decision === 'cancel') {
      itemEvent('item/completed', { ...command, status: 'declined' })
      await completeTurn('interrupted')
      return
    }
    if (decision === 'decline') {
      itemEvent('item/completed', { ...command, status: 'declined', aggregatedOutput: '', exitCode: null })
    } else {
      peer.notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: commandId, delta: 'removed marker\n' })
      await sleep(20)
      itemEvent('item/completed', { ...command, status: 'completed', aggregatedOutput: 'removed marker\n', exitCode: 0, durationMs: 15 })
    }
    await streamMessage(uuid('msg'), [`decision:${decision}`])

    // The file change really happens on disk (the checkout is the cwd), so
    // the adapter's before/after snapshots are genuine.
    const changeId = uuid('patch')
    const checkout = process.cwd()
    const changes = [
      { path: join(checkout, 'README.md'), kind: { type: 'update', move_path: null }, diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n' },
      { path: join(checkout, 'NEW.md'), kind: { type: 'add' }, diff: '--- /dev/null\n+++ b/NEW.md\n@@ -0,0 +1 @@\n+hello\n' },
      { path: join(checkout, 'GONE.md'), kind: { type: 'delete' }, diff: '--- a/GONE.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' },
      { path: join(checkout, 'BIG.md'), kind: { type: 'update', move_path: null }, diff: '--- a/BIG.md\n+++ b/BIG.md\n@@ -1 +1 @@\n-big\n+bigger\n' },
      // A diff that does not describe what lands on disk (Codex reformatted
      // after the fact): the adapter must not claim a pre-image for it.
      { path: join(checkout, 'WEIRD.md'), kind: { type: 'update', move_path: null }, diff: '--- a/WEIRD.md\n+++ b/WEIRD.md\n@@ -1 +1 @@\n-weird\n+odd\n' },
    ]
    itemEvent('item/started', { type: 'fileChange', id: changeId, changes, status: 'inProgress' })
    const fileApproval = await peer.request('item/fileChange/requestApproval', { threadId, turnId: turn.id, itemId: changeId, startedAtMs: Date.now(), reason: null, grantRoot: null })
    const applied = !!fileApproval.result?.decision?.startsWith('accept')
    if (applied) {
      writeFileSync(join(checkout, 'README.md'), 'new\n')
      writeFileSync(join(checkout, 'NEW.md'), 'hello\n')
      if (existsSync(join(checkout, 'GONE.md'))) unlinkSync(join(checkout, 'GONE.md'))
      writeFileSync(join(checkout, 'BIG.md'), 'bigger\n')
      writeFileSync(join(checkout, 'WEIRD.md'), 'strange\n')
    }
    itemEvent('item/completed', { type: 'fileChange', id: changeId, changes, status: applied ? 'completed' : 'declined' })

    const mcpId = uuid('mcp')
    itemEvent('item/started', { type: 'mcpToolCall', id: mcpId, server: 'github', tool: 'search', status: 'inProgress', arguments: { q: 'poise' }, appContext: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null })
    itemEvent('item/completed', { type: 'mcpToolCall', id: mcpId, server: 'github', tool: 'search', status: 'completed', arguments: { q: 'poise' }, appContext: null, pluginId: null, readOnlyHint: true, result: { content: [{ type: 'text', text: 'one hit' }], structuredContent: null, _meta: null }, error: null, durationMs: 3 })

    const permission = await peer.request('item/permissions/requestApproval', {
      threadId, turnId: turn.id, itemId: uuid('perm'), environmentId: null, startedAtMs: Date.now(), cwd: '/tmp/fixture', reason: 'needs network',
      permissions: { network: { enabled: true }, fileSystem: null },
    })

    const questionId = uuid('question')
    const answer = await peer.request('item/tool/requestUserInput', {
      threadId, turnId: turn.id, itemId: questionId, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'letter', header: 'Letter', question: 'Which letter?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }],
    })
    const chosen = answer.result?.answers?.letter?.answers?.join('|') ?? 'none'
    await streamMessage(uuid('msg'), [`answer:${chosen} permission:${JSON.stringify(permission.result ?? null)}`])

    peer.notify('turn/plan/updated', { threadId, turnId: turn.id, explanation: 'the plan', plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }, { step: 'three', status: 'pending' }] })

    peer.notify('thread/tokenUsage/updated', { threadId, turnId: turn.id, tokenUsage: { total: usage(120, 40), last: usage(100, 30), modelContextWindow: 200000 } })
    // A straggling tool the fake never completes: the adapter must still close it.
    itemEvent('item/started', { type: 'webSearch', id: uuid('search'), query: 'never completes', action: null, results: null })
    await completeTurn(turn.interrupted ? 'interrupted' : 'completed')
  }

  function usage(input, output) {
    return { totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 }
  }
}
