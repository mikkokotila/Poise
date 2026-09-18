// Claude Code through the Claude Agent SDK (pinned to the installed Claude
// Code: package.json pins @anthropic-ai/claude-agent-sdk 0.3.274, whose
// claudeCodeVersion is 2.1.274). The SDK runs in-process and spawns the CLI;
// `pathToClaudeCodeExecutable` points it at Poise's subscription wrapper, so
// credential isolation is exactly what every other Poise Claude launch gets:
// the wrapper scrubs the environment, neutralizes provider credentials in the
// settings overlay, and refuses to start a model process unless Claude Code
// reports the Claude.ai first-party provider. The spawn itself goes through
// the worker gate like every other agent.
//
// One `query()` with streaming input lives for the whole session. Every
// message Poise pushes carries a uuid it remembers; a Poise turn ends only
// when a `result` frame has consumed every uuid of the turn (its prompt and
// each steer, reported in `user_message_uuids`) and reports nothing queued
// (`queued_turn_count` 0) — Claude Code folds a steer into the running turn
// or runs it as its own native turn, and either way it stays inside the
// Poise turn that holds the checkout. Stop interrupts and then ends the
// process, waiting for the verified exit before the turn resolves, so no
// queued message can ever run after the checkout was released; the native
// session is resumed by id on the next prompt. Anything that leaves the
// queue state unknown is treated the same way. Permissions arrive through
// `canUseTool`; AskUserQuestion is routed to the question card through the
// same callback; pre-images for Revert come from a PreToolUse hook, so they
// are captured in every permission mode. The transcript is built from
// partial-message stream events (text and thinking deltas) plus the
// assistant/user frames that carry tool calls and their results.

import { query, type CanUseTool, type HookCallback, type Options, type Query, type SDKMessage, type SDKUserMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { CLAUDE_SUBSCRIPTION_CLI, claudeSubscriptionEnvironment, scrubbedChildEnvironment } from '../../process'
import { CHAT_LIMITS, type Capabilities, type CommandOption, type ContentBlock, type ModeOption, type PromptInput, type Question, type StopReason, type ToolKind } from '../protocol'
import { AdapterError, assertRequiredCapabilities, type Adapter, type AdapterHost, type AdapterStartOptions, type AdapterStartResult, type TurnResult } from './types'

export const CLAUDE_SDK_VERSION = '0.3.274'
export const CLAUDE_CODE_VERSION = '2.1.274'

const CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  thought: true,
  plan: false,
  commands: true,
  modes: true,
  permissions: true,
  questions: true,
  resume: true,
  images: false,
}

/** The permission modes Chat offers: the prompting ones. bypassPermissions,
 *  dontAsk and auto would silence the prompts v1 requires. */
const MODES: ModeOption[] = [
  { id: 'default', name: 'Default', description: 'Prompts for dangerous operations' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'File edits run without a prompt' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning, no execution' },
]

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** How long an ended query gets to exit before the runtime terminates it. */
const EXIT_GRACE_MS = 10_000
/** How long a pending message of a turn may go without any CLI activity. */
const QUEUE_SETTLE_MS = 20_000

function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read': case 'Glob': case 'NotebookRead': return 'read'
    case 'Grep': case 'LSP': return 'search'
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 'edit'
    case 'Bash': case 'Task': case 'Agent': return name === 'Bash' ? 'execute' : 'other'
    case 'WebFetch': case 'WebSearch': return 'fetch'
    default: return 'other'
  }
}

function toolTitle(name: string, input: any): string {
  const path = typeof input?.file_path === 'string' ? input.file_path : typeof input?.path === 'string' ? input.path : ''
  switch (name) {
    case 'Bash': return typeof input?.command === 'string' ? input.command.slice(0, 200) : 'Bash'
    case 'Read': return `Read ${path}`
    case 'Edit': case 'MultiEdit': return `Edit ${path}`
    case 'Write': return `Write ${path}`
    case 'Glob': return `Glob ${input?.pattern ?? ''}`
    case 'Grep': return `Grep ${input?.pattern ?? ''}`
    case 'WebFetch': return `Fetch ${input?.url ?? ''}`
    case 'WebSearch': return `Search ${input?.query ?? ''}`
    case 'Task': case 'Agent': return `Agent: ${input?.description ?? ''}`
    default: return name
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

export function createClaudeAdapter(host: AdapterHost, options: { exitGraceMs?: number, queueSettleMs?: number } = {}): Adapter {
  const exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS
  const queueSettleMs = options.queueSettleMs ?? QUEUE_SETTLE_MS
  let active: Query | null = null
  let sessionId: string | undefined
  let modelId = ''
  let effort = ''
  let mode = 'default'
  let commands: CommandOption[] = []
  let efforts: string[] = EFFORTS
  let alive = false
  let processExited = false
  let proxy: ProxyProcess | null = null
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  // Waiters for an exit Poise asked for; the runtime's listeners hear only
  // exits it did not ask for.
  const exitWaiters: Array<() => void> = []

  // Streaming input: the async iterator the SDK reads user messages from.
  const inbox: SDKUserMessage[] = []
  let inboxWake: (() => void) | null = null
  let inboxClosed = false
  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!inboxClosed) {
      if (inbox.length) { yield inbox.shift()!; continue }
      await new Promise<void>((resolve) => { inboxWake = resolve })
      inboxWake = null
    }
  }
  function push(message: SDKUserMessage) {
    inbox.push(message)
    inboxWake?.()
  }

  // Turn state.
  interface Turn {
    id: string
    resolve: (result: TurnResult) => void
    startedAt: number
    messageCounter: number
    messageId: string
    thoughtId: string
    textSeen: Set<string>
    tools: Map<string, { name: string, input: any, startedAt: number }>
    refused: boolean
    cancelled: boolean
    /** Uuids of the messages pushed for this turn that no result consumed yet. */
    sent: Set<string>
    inputTokens: number
    outputTokens: number
    /** Once set, the turn is settled by whoever ends the process, not by a result. */
    settling: boolean
    /** A result left sends unconsumed and their native turn has not started yet. */
    awaitingQueued: boolean
  }
  let turn: Turn | null = null
  // Set while Poise itself ends the query, so a process exit is not an error.
  let closing = false
  // Armed when a result left messages of the turn unconsumed; any frame
  // from the CLI disarms it, silence ends the process (fail closed).
  let queueSettleTimer: ReturnType<typeof setTimeout> | null = null
  function armQueueSettle(current: Turn) {
    clearQueueSettle()
    queueSettleTimer = setTimeout(() => {
      queueSettleTimer = null
      if (turn === current && !current.settling) {
        void settleByEnding(current, 'error', 'Claude Code did not run a message of this turn within the settle window; the process was ended and resumes on the next prompt')
      }
    }, queueSettleMs)
    queueSettleTimer.unref()
  }
  function clearQueueSettle() {
    if (queueSettleTimer) { clearTimeout(queueSettleTimer); queueSettleTimer = null }
  }
  // Pre-images captured before a file tool runs so a Write over an existing
  // file can be reverted with a conflict check. `null` means the file did
  // not exist; an unreadable file is not recorded at all, so a read error
  // can never masquerade as a newly created file that Revert would delete.
  const preImages = new Map<string, string | null>()
  async function capturePreImage(path: string): Promise<void> {
    try {
      preImages.set(path, await host.readTextFile(path))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no such file/.test(message)) preImages.set(path, null)
      else host.log(`claude: pre-image of ${path} not captured: ${message}`)
    }
  }

  function newMessageIds(t: Turn) {
    t.messageCounter += 1
    t.messageId = `${t.id}:m${t.messageCounter}`
    t.thoughtId = `${t.id}:t${t.messageCounter}`
  }

  function finishTurn(result: TurnResult) {
    const current = turn
    if (!current) return
    clearQueueSettle()
    turn = null
    for (const [id, tool] of current.tools) {
      host.emit({ type: 'tool.finished', turnId: current.id, id, status: 'cancelled', durationMs: Date.now() - tool.startedAt })
    }
    current.resolve({ ...result, usage: result.usage ?? usageOf(current) })
  }

  function usageOf(current: Turn) {
    return { inputTokens: current.inputTokens, outputTokens: current.outputTokens, totalTokens: current.inputTokens + current.outputTokens }
  }

  function send(current: Turn, content: string) {
    const uuid = randomUUID()
    current.sent.add(uuid)
    push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId || '' } as SDKUserMessage)
  }

  /** End the query and wait for the process to be gone. Resolves false when
   *  the exit could not be verified within the grace period; the runtime
   *  then terminates the worker group itself before releasing anything. */
  async function endProcess(): Promise<boolean> {
    closing = true
    inboxClosed = true
    inboxWake?.()
    const q = active
    active = null
    const exited = waitForExit(exitGraceMs)
    try { await q?.return(undefined) } catch { /* ending */ }
    return exited
  }

  function waitForExit(ms: number): Promise<boolean> {
    if (!proxy || processExited || !alive) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref()
      exitWaiters.push(() => { clearTimeout(timer); resolve(true) })
    })
  }

  /** Settle the turn by ending the process: Stop, or a queue state Poise
   *  cannot vouch for. Nothing native can run after this resolves without
   *  the runtime's verified termination. */
  async function settleByEnding(current: Turn, stopReason: StopReason, error?: string) {
    if (current.settling) return
    current.settling = true
    const exited = await endProcess()
    if (turn !== current) return
    finishTurn({ stopReason, error, ...(exited ? {} : { terminate: true }) })
  }

  const preToolUse: HookCallback = async (input) => {
    const data = input as { tool_name?: string, tool_input?: any }
    const path = data.tool_input?.file_path
    if ((data.tool_name === 'Write' || data.tool_name === 'Edit' || data.tool_name === 'MultiEdit') && typeof path === 'string') {
      await capturePreImage(path)
    }
    return {}
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') {
      const raw: any[] = Array.isArray((input as any).questions) ? (input as any).questions : []
      const questions: Question[] = raw.filter((q) => q && typeof q.question === 'string').map((q, index) => ({
        id: String(index),
        header: typeof q.header === 'string' ? q.header : undefined,
        question: q.question,
        options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === 'string')
          .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
        multiSelect: q.multiSelect === true,
        freeText: true,
      }))
      try {
        const answers = await host.askQuestion({ toolId: options.toolUseID, questions })
        const byQuestion: Record<string, string> = {}
        questions.forEach((q) => {
          const answer = answers[q.id]
          if (answer !== undefined) byQuestion[q.question] = Array.isArray(answer) ? answer.join(', ') : answer
        })
        return { behavior: 'allow', updatedInput: { ...input, answers: byQuestion }, toolUseID: options.toolUseID }
      } catch {
        return { behavior: 'deny', message: 'The user did not answer the question.', toolUseID: options.toolUseID }
      }
    }
    try {
      const optionId = await host.requestPermission({
        toolId: options.toolUseID,
        title: options.title || toolTitle(toolName, input),
        description: options.description || options.decisionReason,
        input,
        options: [
          { id: 'allow', name: 'Allow', kind: 'allow_once' },
          { id: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
          { id: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      })
      if (optionId === 'allow' || optionId === 'allow_session') {
        return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      }
      return { behavior: 'deny', message: 'The user rejected this action.', toolUseID: options.toolUseID }
    } catch {
      return { behavior: 'deny', message: 'The turn was cancelled.', interrupt: true, toolUseID: options.toolUseID }
    }
  }

  function handleMessage(message: SDKMessage) {
    clearQueueSettle()
    const current = turn
    const stamped = (message as { user_message_uuid?: unknown }).user_message_uuid
    if (current && typeof stamped === 'string' && current.sent.has(stamped)) current.awaitingQueued = false
    try {
      dispatch(message)
    } finally {
      // Silence after a result that left sends pending, without the next
      // native turn having started, ends the process (fail closed).
      if (turn && turn.awaitingQueued && !turn.settling) armQueueSettle(turn)
    }
  }

  function dispatch(message: SDKMessage) {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          sessionId = message.session_id
          modelId = message.model || modelId
          mode = message.permissionMode || mode
          if (typeof (message as any).effort === 'string') effort = (message as any).effort
          commands = (message.slash_commands || []).map((name) => ({ name: name.startsWith('/') ? name.slice(1) : name }))
          host.emit({ type: 'commands.updated', commands })
          host.emit({ type: 'mode.updated', mode, modes: MODES })
        }
        return
      }
      case 'stream_event': {
        if (!turn || message.parent_tool_use_id) return
        const event: any = message.event
        if (event?.type === 'message_start') newMessageIds(turn)
        if (event?.type === 'content_block_delta') {
          const delta = event.delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            turn.textSeen.add(turn.messageId)
            host.emit({ type: 'text.delta', turnId: turn.id, messageId: turn.messageId, delta: delta.text })
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            host.emit({ type: 'thought.delta', turnId: turn.id, messageId: turn.thoughtId, delta: delta.thinking })
          }
        }
        return
      }
      case 'assistant': {
        if (!turn || message.parent_tool_use_id) return
        const blocks: any[] = Array.isArray(message.message?.content) ? message.message.content : []
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && !turn.textSeen.has(turn.messageId) && block.text) {
            // No stream events came for this message (non-streaming path):
            // emit its text once so nothing the model said is lost.
            turn.textSeen.add(turn.messageId)
            host.emit({ type: 'text.delta', turnId: turn.id, messageId: turn.messageId, delta: block.text })
          }
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            const name = String(block.name || 'tool')
            turn.tools.set(block.id, { name, input: block.input, startedAt: Date.now() })
            const path = typeof block.input?.file_path === 'string' ? block.input.file_path : undefined
            host.emit({
              type: 'tool.started',
              turnId: turn.id,
              id: block.id,
              kind: toolKind(name),
              title: toolTitle(name, block.input),
              locations: path ? [{ path }] : undefined,
              input: block.input,
            })
            newMessageIds(turn)
          }
        }
        if (message.message?.stop_reason === 'refusal') turn.refused = true
        return
      }
      case 'user': {
        if (!turn || message.parent_tool_use_id) return
        const blocks: any[] = Array.isArray(message.message?.content) ? message.message.content : []
        for (const block of blocks) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          const tool = turn.tools.get(block.tool_use_id)
          if (!tool) continue
          turn.tools.delete(block.tool_use_id)
          const text = textOf(block.content)
          const content: ContentBlock[] = []
          const structured: any = message.tool_use_result
          if (tool.name === 'Bash') {
            const out = structured && typeof structured === 'object' ? `${structured.stdout ?? ''}${structured.stderr ? `\n${structured.stderr}` : ''}` : text
            content.push({ type: 'terminal', text: out.slice(0, CHAT_LIMITS.toolOutputBytes), truncated: out.length > CHAT_LIMITS.toolOutputBytes })
          } else if (text) {
            content.push({ type: 'text', text: text.slice(0, CHAT_LIMITS.toolOutputBytes) })
          }
          emitDiff(turn, block.tool_use_id, tool, structured)
          host.emit({
            type: 'tool.finished',
            turnId: turn.id,
            id: block.tool_use_id,
            status: block.is_error ? 'failed' : 'completed',
            content,
            durationMs: Date.now() - tool.startedAt,
          })
        }
        return
      }
      case 'result': {
        if (!turn) return
        const current = turn
        const usage = message.usage
        current.inputTokens += usage?.input_tokens ?? 0
        current.outputTokens += usage?.output_tokens ?? 0
        const consumed: string[] = Array.isArray(message.user_message_uuids) ? message.user_message_uuids
          : typeof message.user_message_uuid === 'string' ? [message.user_message_uuid] : []
        for (const uuid of consumed) current.sent.delete(uuid)
        // A stopped turn is settled by cancel() once the process is gone.
        if (current.cancelled || current.settling) return
        let stopReason: StopReason = 'end_turn'
        let error: string | undefined
        if (message.subtype !== 'success') {
          stopReason = 'error'
          error = `Claude Code: ${(message as any).errors?.join('; ') || message.subtype}`
        } else if (current.refused) stopReason = 'refusal'
        else if (message.stop_reason === 'max_tokens') stopReason = 'max_tokens'
        else if (message.is_error) { stopReason = 'error'; error = `Claude Code: ${message.result}` }
        const queued = typeof message.queued_turn_count === 'number' ? message.queued_turn_count : undefined
        const pending = current.sent.size > 0
        if (stopReason === 'end_turn' && (pending || (queued !== undefined && queued > 0))) {
          // A message of this Poise turn has not been consumed: the CLI runs
          // it as its own native turn next (verified against 2.1.274, whose
          // result reports queued_turn_count 0 for a send still in flight),
          // so the turn — and the checkout — stay. If nothing follows within
          // the settle window the message is presumed dropped and the
          // process is ended rather than the turn declared quiet.
          newMessageIds(current)
          current.awaitingQueued = true
          return
        }
        if (pending || (queued !== undefined && queued > 0)) {
          // An error result with sends still pending: end the process so
          // nothing runs after the turn is reported over.
          void settleByEnding(current, stopReason, error ?? 'Claude Code left queued messages Poise could not account for; the process was ended and resumes on the next prompt')
          return
        }
        finishTurn({ stopReason, error })
        return
      }
      default: {
        const kind = (message as any).type
        if (kind === 'commands_changed' && Array.isArray((message as any).commands)) {
          commands = (message as any).commands.map((c: any) => ({ name: String(c.name || c).replace(/^\//, ''), description: c.description }))
          host.emit({ type: 'commands.updated', commands })
        } else if (kind === 'model_refusal' || kind === 'model_refusal_no_fallback') {
          if (turn) turn.refused = true
        }
      }
    }
  }

  function emitDiff(current: Turn, toolId: string, tool: { name: string, input: any }, structured: any) {
    if (!structured || typeof structured !== 'object') return
    const rawPath = typeof structured.filePath === 'string' ? structured.filePath : tool.input?.file_path
    if (typeof rawPath !== 'string') return
    if (tool.name === 'Edit' || tool.name === 'MultiEdit') {
      const original = typeof structured.originalFile === 'string' ? structured.originalFile : preImages.get(rawPath) ?? null
      preImages.delete(rawPath)
      if (original === null) return
      const edits: Array<{ old_string: string, new_string: string, replace_all?: boolean }> = tool.name === 'MultiEdit' && Array.isArray(tool.input?.edits)
        ? tool.input.edits
        : [{ old_string: String(structured.oldString ?? tool.input?.old_string ?? ''), new_string: String(structured.newString ?? tool.input?.new_string ?? ''), replace_all: tool.input?.replace_all }]
      let updated = original
      for (const edit of edits) {
        const oldString = String(edit.old_string ?? '')
        const newString = String(edit.new_string ?? '')
        updated = edit.replace_all ? updated.split(oldString).join(newString) : updated.replace(oldString, () => newString)
      }
      host.emit({ type: 'diff', turnId: current.id, toolId, diffId: randomUUID(), path: rawPath, oldText: original, newText: updated, oldExists: true, newExists: true })
      return
    }
    if (tool.name === 'Write') {
      const content = String(structured.content ?? tool.input?.content ?? '')
      const created = structured.type === 'create'
      const pre = preImages.get(rawPath)
      preImages.delete(rawPath)
      if (created || pre === null) {
        host.emit({ type: 'diff', turnId: current.id, toolId, diffId: randomUUID(), path: rawPath, oldText: '', newText: content, oldExists: false, newExists: true })
      } else if (typeof pre === 'string') {
        host.emit({ type: 'diff', turnId: current.id, toolId, diffId: randomUUID(), path: rawPath, oldText: pre, newText: content, oldExists: true, newExists: true })
      } else {
        const patch = Array.isArray(structured.structuredPatch)
          ? structured.structuredPatch.map((hunk: any) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${(hunk.lines || []).join('\n')}`).join('\n')
          : ''
        host.emit({ type: 'diff', turnId: current.id, toolId, diffId: randomUUID(), path: rawPath, oldText: '', newText: patch, oldExists: true, newExists: true, unified: true })
      }
    }
  }

  async function consume(q: Query) {
    try {
      for await (const message of q) handleMessage(message)
    } catch (error) {
      if (turn && !turn.settling) finishTurn({ stopReason: 'error', error: `Claude Code: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      // An end Poise asked for is settled by the one who asked, after the
      // process exit is verified; any other end of the stream is a failure.
      if (turn && !turn.settling && !closing) finishTurn({ stopReason: 'error', error: 'Claude Code ended the session' })
    }
  }

  async function launch(options: AdapterStartOptions): Promise<void> {
    const env = {
      ...scrubbedChildEnvironment('claude-subscription.mjs', claudeSubscriptionEnvironment()),
    }
    // Poise mints the native session id for new and forked sessions; only a
    // resume takes the id it is given. The id is therefore known before the
    // first prompt without waiting on a frame the CLI may only send later.
    const minted = options.resume ? undefined : randomUUID()
    const sdkOptions: Options = {
      cwd: host.checkout,
      model: options.modelId || undefined,
      effort: EFFORTS.includes(options.effort) ? options.effort as Options['effort'] : undefined,
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [preToolUse] }] },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: CLAUDE_SUBSCRIPTION_CLI,
      env,
      ...(minted ? { sessionId: minted } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.forkFrom ? { resume: options.forkFrom, forkSession: true } : {}),
      // The SDK asks for `node <wrapper> …`; the gate runs exactly that.
      spawnClaudeCodeProcess: (spawnOptions) => spawnThroughGate(spawnOptions) as unknown as SpawnedProcess,
    }
    let pendingChild: Promise<ChildProcess> | null = null
    function spawnThroughGate(spawnOptions: { command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv }): ProxyProcess {
      proxy = new ProxyProcess((text) => host.log(`claude stderr: ${text.trim().slice(0, 300)}`))
      const current = proxy
      // The SDK names its own runtime as `node`; the gate runs the same one.
      const command = spawnOptions.command === 'node' ? process.execPath : spawnOptions.command
      pendingChild = host.spawn(command, spawnOptions.args, { env: spawnOptions.env })
      pendingChild.then((child) => {
        current.attach(child)
        alive = true
        child.once('exit', (code, signal) => {
          alive = false
          processExited = true
          for (const waiter of exitWaiters.splice(0)) waiter()
          if (!closing) for (const listener of exitListeners) listener(code, signal)
        })
      }, (error) => { processExited = true; current.fail(error) })
      return current
    }
    active = query({ prompt: inputStream(), options: sdkOptions })
    void consume(active)
    if (pendingChild) await pendingChild
    // The control-channel handshake is the explicit initialization: it
    // returns the real model list (with effort levels) and slash commands,
    // and fails readably when the wrapper's preflight blocked the launch.
    const init = await Promise.race([
      active.initializationResult(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Claude Code did not initialize within 120 s')), 120_000)
        timer.unref()
      }),
    ]).catch((error) => {
      if (processExited || !alive) throw new Error(`the Claude Code process exited before it initialized${proxy?.stderrTail ? `: ${proxy.stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`)
      throw error
    })
    sessionId = sessionId || minted || options.resume
    commands = (init.commands || []).map((c: any) => ({ name: String(c.name || '').replace(/^\//, ''), description: typeof c.description === 'string' ? c.description : undefined }))
    const model = (init.models || []).find((m: any) => m.value === options.modelId || m.resolvedModel === options.modelId) as any
    if (model?.supportedEffortLevels?.length) efforts = model.supportedEffortLevels
    else if (model && model.supportsEffort === false) efforts = []
    if (options.modelId && !(init.models || []).some((m: any) => m.value === options.modelId || m.resolvedModel === options.modelId)) {
      host.log(`claude: model ${options.modelId} is not in the CLI's model list; the CLI decides what it launches`)
    }
    if (options.effort && !efforts.includes(options.effort)) {
      throw new Error(`Claude Code offers efforts ${efforts.join(', ') || '(none)'} for ${options.modelId}, not ${options.effort}`)
    }
    modelId = model?.resolvedModel || model?.value || options.modelId || modelId
  }

  const adapter: Adapter = {
    agent: 'claude',
    get nativeSessionId() { return sessionId },
    capabilities: CAPABILITIES,
    get alive() { return alive },
    onExit(listener) { exitListeners.push(listener) },

    async start(options: AdapterStartOptions): Promise<AdapterStartResult> {
      try {
        await launch(options)
      } catch (error) {
        throw new AdapterError('claude', `Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      if (options.effort) effort = options.effort
      host.emit({ type: 'commands.updated', commands })
      host.emit({ type: 'mode.updated', mode, modes: MODES })
      assertRequiredCapabilities('claude', CAPABILITIES)
      return { nativeSessionId: sessionId!, capabilities: CAPABILITIES, modelId, effort, efforts, mode, modes: MODES, commands }
    },

    async prompt(id: string, input: PromptInput, signal: AbortSignal): Promise<TurnResult> {
      if (!active || !alive) throw new AdapterError('claude', 'Claude Code is not running', 'exited')
      const parts = [input.text]
      for (const mention of input.mentions) parts.push(`@${mention.path}`)
      for (const attachment of input.attachments) {
        parts.push(typeof attachment.text === 'string'
          ? `\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`
          : `\n[Attached file: ${attachment.path}]`)
      }
      return new Promise<TurnResult>((resolve) => {
        const current: Turn = { id, resolve, startedAt: Date.now(), messageCounter: 0, messageId: '', thoughtId: '', textSeen: new Set(), tools: new Map(), refused: false, cancelled: false, sent: new Set(), inputTokens: 0, outputTokens: 0, settling: false, awaitingQueued: false }
        turn = current
        newMessageIds(current)
        const onAbort = () => { void adapter.cancel() }
        signal.addEventListener('abort', onAbort, { once: true })
        current.resolve = (result: TurnResult) => { signal.removeEventListener('abort', onAbort); resolve(result) }
        send(current, parts.join('\n'))
      })
    },

    async steer(text: string): Promise<void> {
      if (!turn || turn.cancelled) throw new AdapterError('claude', 'no turn is running', 'unsupported')
      send(turn, text)
    },

    async cancel(): Promise<void> {
      const current = turn
      if (!current || current.cancelled) return
      current.cancelled = true
      // The interrupt stops the running native turn; its receipt lists
      // queued messages that would still run. Stop means none of them may,
      // and a receipt cannot list a message the CLI never stamped, so the
      // process is ended either way and the turn resolves only once the
      // exit is verified (or the runtime is told to terminate the group).
      try { await active?.interrupt() } catch (error) { host.log(`claude: interrupt failed: ${error instanceof Error ? error.message : String(error)}`) }
      await settleByEnding(current, 'cancelled')
    },

    async setModel(nextModel: string, nextEffort: string) {
      if (!active) throw new AdapterError('claude', 'Claude Code is not running', 'exited')
      if (nextModel && nextModel !== modelId) {
        const models = await active.supportedModels().catch(() => [] as Array<{ value: string, resolvedModel?: string, supportedEffortLevels?: string[] }>)
        const row = models.find((m) => m.value === nextModel || m.resolvedModel === nextModel)
        if (models.length && !row) throw new AdapterError('claude', `Claude Code does not offer model ${nextModel}`, 'unsupported')
        await active.setModel(nextModel)
        modelId = row?.resolvedModel || nextModel
        if (row?.supportedEffortLevels?.length) efforts = row.supportedEffortLevels
      }
      if (nextEffort && nextEffort !== effort) {
        if (!efforts.includes(nextEffort)) throw new AdapterError('claude', `Claude Code offers efforts ${efforts.join(', ') || '(none)'} for ${modelId}, not ${nextEffort}`, 'unsupported')
        await active.applyFlagSettings({ effortLevel: nextEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' })
        effort = nextEffort
      }
      return { modelId, effort, efforts }
    },

    async setMode(next: string): Promise<void> {
      if (!active) throw new AdapterError('claude', 'Claude Code is not running', 'exited')
      if (!MODES.some((m) => m.id === next)) throw new AdapterError('claude', `unknown mode ${next}`, 'unsupported')
      await active.setPermissionMode(next as 'default' | 'acceptEdits' | 'plan')
      mode = next
      host.emit({ type: 'mode.updated', mode, modes: MODES })
    },

    async fork(): Promise<string> {
      // Forking is a fresh process resumed with --fork-session; the runtime
      // starts the new session's adapter with forkFrom = this native id.
      if (!sessionId) throw new AdapterError('claude', 'no session to fork', 'unsupported')
      return sessionId
    },

    async close(): Promise<void> {
      const current = turn
      if (current && !current.settling) { await settleByEnding(current, 'cancelled'); return }
      await endProcess()
    },
  }
  return adapter
}

// The SDK wants a SpawnedProcess synchronously while the gate spawn (lease
// registration, GO) is asynchronous. This proxy hands the SDK stable
// streams and forwards them once the real child exists.
class ProxyProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderrTail = ''
  private child: ChildProcess | null = null
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
  private pendingKill: NodeJS.Signals | null = null

  constructor(private readonly onStderr: (text: string) => void) {}

  attach(child: ChildProcess) {
    this.child = child
    this.stdin.pipe(child.stdin!)
    // stdout is ended by its own EOF, never by the exit event: a final frame
    // written just before exit must still reach the SDK.
    child.stdout!.pipe(this.stdout)
    // stderr is drained and bounded so a chatty CLI can never stall on a
    // full pipe; the tail is what a startup failure is reported with.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-8_192)
      this.onStderr(text)
    })
    child.once('exit', (code, signal) => {
      this.exitCode = code
      this.signalCode = signal
      for (const listener of this.listeners.get('exit') || []) listener(code, signal)
    })
    child.once('error', (error) => { for (const listener of this.listeners.get('error') || []) listener(error) })
    if (this.pendingKill) child.kill(this.pendingKill)
  }

  fail(error: Error) {
    this.exitCode = 1
    this.stdout.end()
    for (const listener of this.listeners.get('error') || []) listener(error)
    for (const listener of this.listeners.get('exit') || []) listener(1, null)
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true
    if (this.child) return this.child.kill(signal)
    this.pendingKill = signal
    return true
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener])
  }

  once(event: string, listener: (...args: any[]) => void): void {
    const wrapped = (...args: any[]) => { this.off(event, wrapped); listener(...args) }
    this.on(event, wrapped)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, (this.listeners.get(event) || []).filter((l) => l !== listener))
  }
}
