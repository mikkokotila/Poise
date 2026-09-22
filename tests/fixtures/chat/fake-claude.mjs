// A stand-in for the Claude Code CLI as the Claude Agent SDK 0.3.274 drives
// it over stream-json stdio (control_request/control_response frames plus
// the user/assistant/stream_event/result stream). It runs scripted native
// turns chosen by the prompt text, so the adapter tests never need the real
// binary, a sign-in, or a model. Queue semantics follow the SDK's typed
// contract: every result names the user message uuids it consumed and how
// many user sends are still queued.
//
// Scripts (by prompt text):
//   echo …            one native turn: text, result (queued_turn_count 0)
//   slow              runs until a queued message or an interrupt arrives;
//                     a message queued meanwhile becomes its own native turn
//                     (the result reports queued_turn_count 1)
//   slow-zero         like slow, but the result reports queued_turn_count 0
//                     for the queued message, as claude 2.1.274 does for a
//                     send still in flight; the message still runs next
//   slow-drop         like slow-zero, but the queued message is discarded
//                     and never runs (the adapter must not wait forever)
//   result-first      like slow, but on interrupt the result frame is written
//                     BEFORE the interrupt receipt
//   write <path>      PreToolUse hook, can_use_tool, Write tool_use/result
//   old-cli           result without user_message_uuids/queued_turn_count
//   linger            like slow, but the process ignores stdin EOF and
//                     SIGTERM for a while (exit cannot be verified in time)

import { appendFileSync, writeFileSync, existsSync } from 'node:fs'

const SESSION_ID = process.env.FAKE_CLAUDE_SESSION_ID || 'a1b2c3d4-0000-4000-8000-000000000001'
const MODEL = 'claude-opus-5'
const stateFile = process.env.FAKE_CLAUDE_STATE_FILE || ''

let counter = 0
const id = (prefix) => `${prefix}-${String(++counter).padStart(4, '0')}`
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const note = (line) => { if (stateFile) appendFileSync(stateFile, `${line}\n`) }

let hookIds = { PreToolUse: [] }
let running = null // { uuid, text, resolveQueued, interrupted }
const queue = []   // user messages received while a turn runs
const pendingControl = new Map() // request_id → resolve(response)
let linger = false

function respond(requestId, response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

function controlRequest(request) {
  const requestId = id('req')
  return new Promise((resolve) => {
    pendingControl.set(requestId, resolve)
    write({ type: 'control_request', request_id: requestId, request })
  })
}

function init() {
  write({
    type: 'system', subtype: 'init', session_id: SESSION_ID, cwd: process.cwd(), model: MODEL, permissionMode: 'default',
    tools: ['Read', 'Write', 'Edit', 'Bash'], mcp_servers: [], slash_commands: ['/compact', '/context'], apiKeySource: 'none',
    output_style: 'default', agents: [], skills: [], plugins: [], claude_code_version: '2.1.274', uuid: id('uuid'),
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
  })
}

function text(turnUuid, content) {
  const messageId = id('msg')
  write({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid'), user_message_uuid: turnUuid })
  write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid') })
  write({ type: 'assistant', message: { id: messageId, role: 'assistant', model: MODEL, content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid') })
}

function result(uuids, extra = {}) {
  write({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: 'done',
    stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], errors: [], session_id: SESSION_ID, uuid: id('uuid'),
    user_message_uuid: uuids.at(-1), user_message_uuids: uuids, queued_turn_count: queue.length,
    ...extra,
  })
}

async function runTurn(message) {
  const uuid = message.uuid
  const prompt = typeof message.message?.content === 'string' ? message.message.content : ''
  const [verb, ...rest] = prompt.split(/\s+/)
  running = { uuid, prompt, interrupted: false, wake: null }
  note(`turn ${uuid} ${verb}`)
  if (verb === '/compact') {
    writeFileSync('compact-input', prompt)
    while (process.argv.includes('--compact-gated') && !existsSync('compact-release')) await new Promise(resolve => setTimeout(resolve, 10))
    if (process.argv.includes('--compact-hold')) { await new Promise(resolve => { running.wake = resolve }); return }
    await new Promise(resolve => setTimeout(resolve, 160))
    if (process.argv.includes('--compact-fail')) write({ type: 'system', subtype: 'status', session_id: SESSION_ID, uuid: id('uuid'), status: null, compact_result: 'failed', compact_error: 'summarizer failed' })
    else if (!process.argv.includes('--compact-noop')) write({ type: 'system', subtype: 'compact_boundary', session_id: SESSION_ID, uuid: id('uuid'), compact_metadata: { trigger: 'manual', pre_tokens: 1200 } })
    result([uuid])
  } else if (verb === 'echo') {
    text(uuid, `echo: ${rest.join(' ')}`)
    result([uuid])
  } else if (verb === 'old-cli') {
    text(uuid, 'from an older producer')
    write({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: 'done',
      stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: [],
      session_id: SESSION_ID, uuid: id('uuid'),
    })
  } else if (verb === 'write') {
    const path = rest[0]
    const toolUseId = id('toolu')
    for (const callbackId of hookIds.PreToolUse) {
      await controlRequest({ subtype: 'hook_callback', callback_id: callbackId, input: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, transcript_path: '', cwd: process.cwd(), permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: path, content: 'new content\n' }, tool_use_id: toolUseId }, tool_use_id: toolUseId })
    }
    const decision = await controlRequest({ subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: path, content: 'new content\n' }, tool_use_id: toolUseId })
    write({ type: 'assistant', message: { id: id('msg'), role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: path, content: 'new content\n' } }], stop_reason: 'tool_use' }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid') })
    if (decision?.behavior === 'allow') {
      writeFileSync(path, 'new content\n')
      write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'File written' }] }, tool_use_result: { type: 'update', filePath: path, content: 'new content\n', structuredPatch: [] }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid') })
    } else {
      write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: decision?.message || 'denied', is_error: true }] }, session_id: SESSION_ID, parent_tool_use_id: null, uuid: id('uuid') })
    }
    text(uuid, 'wrote it')
    result([uuid])
  } else if (verb === 'slow' || verb === 'slow-zero' || verb === 'slow-drop' || verb === 'result-first' || verb === 'linger') {
    if (verb === 'linger') linger = true
    text(uuid, 'working…')
    // Wait for a queued message (which ends this native turn) or an interrupt.
    const why = await new Promise((resolve) => { running.wake = resolve })
    if (why === 'interrupt') {
      const receipt = { still_queued: queue.map((m) => m.uuid) }
      if (verb === 'result-first') {
        result([uuid], { stop_reason: null, queued_turn_count: queue.length })
        respond(running.interruptId, receipt)
      } else {
        respond(running.interruptId, receipt)
        result([uuid], { stop_reason: null, queued_turn_count: queue.length })
      }
      // A plain interrupt leaves queued messages alive: they run next.
    } else if (verb === 'slow-zero' || verb === 'slow-drop') {
      result([uuid], { queued_turn_count: 0 })
      if (verb === 'slow-drop') queue.length = 0
    } else {
      result([uuid])
    }
  } else {
    text(uuid, `unknown script: ${prompt}`)
    result([uuid])
  }
  running = null
  const next = queue.shift()
  if (next) await runTurn(next)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  note('stdin end')
  if (!linger) process.exit(0)
  // Stay alive (a referenced timer keeps the loop running) despite EOF.
  setTimeout(() => process.exit(0), 30_000)
})
process.on('SIGTERM', () => {
  note('sigterm')
  if (!linger) process.exit(0)
})

function handle(frame) {
  if (frame.type === 'control_request') {
    const { request_id: requestId, request } = frame
    switch (request.subtype) {
      case 'initialize':
        hookIds = { PreToolUse: [] }
        for (const matcher of request.hooks?.PreToolUse || []) hookIds.PreToolUse.push(...(matcher.hookCallbackIds || []))
        respond(requestId, {
          commands: [{ name: '/compact', description: 'Compact the conversation', argumentHint: '' }, { name: '/context', description: 'Show context usage', argumentHint: '' }],
          output_style: 'default', available_output_styles: ['default'],
          models: [
            { value: 'claude-opus-5', displayName: 'Opus 5', description: '', resolvedModel: 'claude-opus-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
          ],
          account: { email: 'fixture@example.invalid', subscriptionType: 'max' },
          agents: [], skills: [], plugins: [],
        })
        init()
        return
      case 'interrupt':
        note('interrupt')
        if (running && running.wake) {
          running.interrupted = true
          running.interruptId = requestId
          running.wake('interrupt')
        } else {
          respond(requestId, { still_queued: queue.map((m) => m.uuid) })
        }
        return
      case 'set_permission_mode':
      case 'set_model':
      case 'apply_flag_settings':
        respond(requestId, {})
        return
      default:
        write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `unsupported ${request.subtype}` } })
    }
    return
  }
  if (frame.type === 'control_response') {
    const resolve = pendingControl.get(frame.response?.request_id)
    if (resolve) { pendingControl.delete(frame.response.request_id); resolve(frame.response.response) }
    return
  }
  if (frame.type === 'user') {
    if (running) {
      queue.push(frame)
      note(`queued ${frame.uuid}`)
      if (running.wake && /^slow/.test(running.prompt)) running.wake('queued')
      return
    }
    void runTurn(frame)
  }
}
