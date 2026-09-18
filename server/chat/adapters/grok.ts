// Grok Build over the Agent Client Protocol (protocol version 1), which is
// Chat's internal vocabulary, so this adapter is mostly a pass-through.
// Verified against grok 1.0.34 on 2026-09-18 (docs/Chat-v1.md):
//
//   launch      grok --permission-mode default agent stdio
//   session     session/new · session/resume (no history replay) ·
//               _x.ai/session/fork {sourceSessionId, sourceCwd, newCwd}
//   turn        session/prompt → {stopReason}; session/cancel notification
//   steer       _x.ai/interject {sessionId, text} → {result:{status:'queued'}}
//   model       session/set_config_option {configId:'model'|'reasoning_effort'}
//   permission  agent→client session/request_permission {options[{kind}]}
//   question    agent→client _x.ai/ask_user_question {questions} →
//               {outcome:'accepted', answers:{[question]: label|labels}}
//   files       agent→client fs/read_text_file, fs/write_text_file
//
// The client terminal capability is not advertised (see client-fs.ts): Grok
// then runs commands itself and reports them as tool calls.
//
// Grok also pushes `_x.ai/*` notifications; the one listing MCP servers
// carries the user's server config including env secrets. Only the methods
// named below are read; every other notification is dropped by name.

import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { CHAT_LIMITS, type Capabilities, type CommandOption, type ContentBlock, type PermissionOption, type PermissionOptionKind, type PromptInput, type Question, type StopReason, type ToolKind, type ToolStatus } from '../protocol'
import { RpcError, StdioRpc } from '../rpc'
import { readCheckoutTextFile } from '../client-fs'
import { AdapterError, assertRequiredCapabilities, type Adapter, type AdapterHost, type AdapterStartOptions, type AdapterStartResult, type TurnResult } from './types'

export const GROK_COMMAND = 'grok'
export const GROK_ARGS = ['--permission-mode', 'default', 'agent', 'stdio'] as const
export const GROK_ACP_VERSION = 1

const CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  thought: true,
  plan: true,
  commands: true,
  modes: false,
  permissions: true,
  questions: true,
  resume: true,
  images: false,
}

const INLINE_MENTION_BYTES = CHAT_LIMITS.inlineAttachmentBytes

interface ConfigOption { id: string, currentValue?: string, options?: Array<{ value: string, name?: string }> }

function toolKind(update: any): ToolKind {
  const kind = String(update?.kind || update?._meta?.['x.ai/tool']?.kind || '')
  switch (kind) {
    case 'read': return 'read'
    case 'edit': case 'write': case 'delete': case 'move': return 'edit'
    case 'execute': return 'execute'
    case 'search': return 'search'
    case 'fetch': return 'fetch'
    case 'think': return 'think'
    default: return 'other'
  }
}

function toolStatus(value: unknown): ToolStatus | undefined {
  switch (value) {
    case 'pending': return 'pending'
    case 'in_progress': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return undefined
  }
}

function optionKind(value: unknown): PermissionOptionKind {
  switch (value) {
    case 'allow_always': return 'allow_always'
    case 'reject_once': return 'reject_once'
    case 'reject_always': return 'reject_always'
    default: return 'allow_once'
  }
}

function stopReason(value: unknown): StopReason {
  switch (value) {
    case 'end_turn': return 'end_turn'
    case 'cancelled': return 'cancelled'
    case 'max_tokens': return 'max_tokens'
    case 'refusal': return 'refusal'
    case 'max_turn_requests': return 'max_tokens'
    default: return 'end_turn'
  }
}

export function createGrokAdapter(host: AdapterHost): Adapter {
  let rpc: StdioRpc | null = null
  let child: ChildProcess | null = null
  let sessionId: string | undefined
  let modelId = ''
  let effort = ''
  let efforts: string[] | undefined
  let commands: CommandOption[] = []
  let alive = false
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const loggedMethods = new Set<string>()

  // Per-turn rendering state.
  let turnId: string | null = null
  let messageCounter = 0
  let messageId = ''
  let thoughtId = ''
  // Grok sends a tool call's diff block with every update of that call, and
  // an early one may predate its read of the file (an empty pre-image for a
  // file that has content). Only the blocks on the completing update are
  // recorded — that is the change as it landed — one per path.
  const openTools = new Map<string, { startedAt: number }>()
  let cancelRequested = false

  function newMessageIds() {
    messageCounter += 1
    messageId = `${turnId}:m${messageCounter}`
    thoughtId = `${turnId}:t${messageCounter}`
  }

  function requireRpc(): StdioRpc {
    if (!rpc || rpc.isClosed) throw new AdapterError('grok', 'Grok Build is not running', 'exited')
    return rpc
  }

  function logOnce(method: string, note: string) {
    if (loggedMethods.has(method)) return
    loggedMethods.add(method)
    host.log(`grok: ${note} ${method}`)
  }

  function contentBlocks(content: unknown): ContentBlock[] {
    if (!Array.isArray(content)) return []
    const blocks: ContentBlock[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const entry = item as any
      if (entry.type === 'diff' && typeof entry.path === 'string') {
        blocks.push({ type: 'diff', path: entry.path, oldText: entry.oldText ?? '', newText: entry.newText ?? '' })
      } else if (entry.type === 'content' && entry.content?.type === 'text' && typeof entry.content.text === 'string') {
        blocks.push({ type: 'text', text: entry.content.text.slice(0, CHAT_LIMITS.toolOutputBytes) })
      } else if (entry.type === 'terminal' && typeof entry.terminalId === 'string') {
        blocks.push({ type: 'terminal', text: '' })
      }
    }
    return blocks
  }

  function handleSessionUpdate(params: any) {
    if (!params || (params.sessionId !== sessionId && !(!sessionId && params.update?.sessionUpdate === 'available_commands_update'))) return
    const update = params.update
    if (!update || typeof update !== 'object') return
    const kind = update.sessionUpdate
    if (kind === 'available_commands_update') {
      // Grok announces its commands while session/new is still in flight.
      commands = (Array.isArray(update.availableCommands) ? update.availableCommands : [])
        .filter((c: any) => c && typeof c.name === 'string')
        .map((c: any) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : undefined, hint: typeof c.input?.hint === 'string' ? c.input.hint : undefined }))
      host.emit({ type: 'commands.updated', commands })
      return
    }
    if (kind === 'config_option_update') {
      applyConfigOptions(update.configOptions)
      return
    }
    if (!turnId) return
    switch (kind) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
        if (text) host.emit({ type: 'text.delta', turnId, messageId, delta: text })
        return
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
        if (text) host.emit({ type: 'thought.delta', turnId, messageId: thoughtId, delta: text })
        return
      }
      case 'tool_call': {
        const id = String(update.toolCallId || '')
        if (!id) return
        const meta = update._meta?.['x.ai/tool']
        if (meta?.kind === 'ask_user') return // rendered as the question card
        newMessageIds()
        openTools.set(id, { startedAt: Date.now() })
        host.emit({
          type: 'tool.started',
          turnId,
          id,
          kind: toolKind(update),
          title: String(update.title || meta?.label || 'tool'),
          locations: Array.isArray(update.locations) ? update.locations.filter((l: any) => typeof l?.path === 'string') : undefined,
          input: update.rawInput,
        })
        return
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId || '')
        if (!id || !openTools.has(id)) return
        const status = toolStatus(update.status)
        const blocks = contentBlocks(update.content)
        const recorded = new Set<string>()
        for (const block of status === 'completed' ? blocks : []) {
          if (block.type === 'diff') {
            if (recorded.has(block.path)) continue
            recorded.add(block.path)
            host.emit({
              type: 'diff',
              turnId,
              toolId: id,
              diffId: randomUUID(),
              path: block.path,
              oldText: block.oldText,
              newText: block.newText,
              oldExists: (update.content as any[]).some((c) => c?.type === 'diff' && c.path === block.path && c.oldText !== null && c.oldText !== undefined),
              newExists: true,
            })
          }
        }
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          const started = openTools.get(id)!.startedAt
          openTools.delete(id)
          host.emit({ type: 'tool.finished', turnId, id, status, content: blocks.filter((b) => b.type !== 'diff'), durationMs: Date.now() - started })
        } else {
          host.emit({
            type: 'tool.updated',
            turnId,
            id,
            ...(update.kind ? { kind: toolKind(update) } : {}),
            ...(typeof update.title === 'string' ? { title: update.title } : {}),
            ...(status ? { status } : {}),
            ...(blocks.length ? { content: blocks.filter((b) => b.type !== 'diff') } : {}),
          })
        }
        return
      }
      case 'plan': {
        const entries = (Array.isArray(update.entries) ? update.entries : [])
          .filter((e: any) => e && typeof e.content === 'string')
          .map((e: any) => ({
            content: e.content,
            status: e.status === 'in_progress' ? 'in_progress' : e.status === 'completed' ? 'completed' : 'pending',
            ...(e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? { priority: e.priority } : {}),
          }))
        host.emit({ type: 'plan.updated', turnId, entries })
        return
      }
      default:
        // user_message_chunk (history replay), session_info_update, and
        // anything newer are not transcript material here.
        return
    }
  }

  function applyConfigOptions(options: unknown) {
    if (!Array.isArray(options)) return
    let changed = false
    for (const option of options as ConfigOption[]) {
      if (option?.id === 'model' && typeof option.currentValue === 'string' && option.currentValue !== modelId) {
        modelId = option.currentValue
        changed = true
      }
      if (option?.id === 'reasoning_effort') {
        const list = (option.options ?? []).map((o) => o.value).filter((v) => typeof v === 'string')
        if (list.length) efforts = list
        if (typeof option.currentValue === 'string' && option.currentValue !== effort) {
          effort = option.currentValue
          changed = true
        }
      }
    }
    if (changed && sessionId) host.emit({ type: 'model.updated', model: '', modelId, effort, efforts })
  }

  async function setConfigOption(configId: string, value: string): Promise<void> {
    const result = await requireRpc().request<any>('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 30_000 })
    applyConfigOptions(result?.configOptions)
  }

  async function launch(): Promise<void> {
    child = await host.spawn(GROK_COMMAND, GROK_ARGS)
    alive = true
    rpc = new StdioRpc(child, { label: 'Grok Build', onStderr: () => {} })
    rpc.on('unhandled-notification', (method: string) => logOnce(String(method), 'ignored notification'))
    rpc.on('unknown-method', (method: string) => logOnce(String(method), 'rejected unknown request'))
    rpc.on('malformed', () => logOnce('malformed', 'dropped malformed frame'))
    child.once('exit', (code, signal) => {
      alive = false
      for (const listener of exitListeners) listener(code, signal)
    })
    rpc.onNotification('session/update', handleSessionUpdate)
    rpc.onNotification('_x.ai/session_notification', () => {})
    rpc.onNotification('_x.ai/sessions/changed', () => {})
    rpc.onNotification('_x.ai/queue/changed', () => {})
    rpc.onNotification('_x.ai/session/prompt_complete', () => {})
    rpc.onNotification('_x.ai/models/update', () => {})
    rpc.onNotification('_x.ai/settings/update', () => {})
    rpc.onNotification('_x.ai/announcements/update', () => {})
    rpc.onNotification('_x.ai/mcp/servers_updated', () => {}) // carries user MCP config: never read
    rpc.onRequest('session/request_permission', async (params: any, _id, signal) => {
      if (!params || params.sessionId !== sessionId) throw new RpcError(-32602, 'unknown session')
      const options: PermissionOption[] = (Array.isArray(params.options) ? params.options : [])
        .filter((o: any) => o && typeof o.optionId === 'string')
        .map((o: any) => ({ id: o.optionId, name: String(o.name || o.optionId), kind: optionKind(o.kind) }))
      if (!options.length) throw new RpcError(-32602, 'permission request without options')
      const toolCall = params.toolCall || {}
      try {
        if (signal.aborted) throw new Error('closed')
        const optionId = await host.requestPermission({
          toolId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
          title: String(toolCall.title || 'Allow this action?'),
          input: toolCall.rawInput,
          options,
        })
        return { outcome: { outcome: 'selected', optionId } }
      } catch {
        return { outcome: { outcome: 'cancelled' } }
      }
    })
    rpc.onRequest('_x.ai/ask_user_question', async (params: any, _id, signal) => {
      if (!params || params.sessionId !== sessionId) throw new RpcError(-32602, 'unknown session')
      const raw: any[] = Array.isArray(params.questions) ? params.questions : []
      const questions: Question[] = raw
        .filter((q) => q && typeof q.question === 'string')
        .map((q, index) => ({
          id: String(index),
          question: q.question,
          options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === 'string')
            .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
          multiSelect: q.multiSelect === true,
          freeText: false,
        }))
      if (!questions.length) throw new RpcError(-32602, 'question without questions')
      try {
        if (signal.aborted) throw new Error('closed')
        const answers = await host.askQuestion({ toolId: typeof params.toolCallId === 'string' ? params.toolCallId : undefined, questions })
        const byQuestion: Record<string, string | string[]> = {}
        questions.forEach((q) => {
          const answer = answers[q.id]
          if (answer !== undefined) byQuestion[q.question] = answer
        })
        return { outcome: 'accepted', answers: byQuestion }
      } catch {
        return { outcome: 'cancelled' }
      }
    })
    rpc.onRequest('fs/read_text_file', async (params: any) => {
      if (!params || params.sessionId !== sessionId || typeof params.path !== 'string') throw new RpcError(-32602, 'invalid params')
      const content = await host.readTextFile(params.path, {
        line: typeof params.line === 'number' ? params.line : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
      })
      return { content }
    })
    rpc.onRequest('fs/write_text_file', async (params: any) => {
      if (!params || params.sessionId !== sessionId || typeof params.path !== 'string' || typeof params.content !== 'string') throw new RpcError(-32602, 'invalid params')
      await host.writeTextFile(params.path, params.content)
      return {}
    })
    const init = await rpc.request<any>('initialize', {
      protocolVersion: GROK_ACP_VERSION,
      clientInfo: { name: 'poise', title: 'Poise', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    }, { timeoutMs: 60_000 })
    if (init?.protocolVersion !== GROK_ACP_VERSION) {
      throw new AdapterError('grok', `Grok Build speaks ACP protocol version ${init?.protocolVersion}, Poise needs ${GROK_ACP_VERSION}`, 'start_failed')
    }
  }

  const adapter: Adapter = {
    agent: 'grok',
    get nativeSessionId() { return sessionId },
    capabilities: CAPABILITIES,
    get alive() { return alive },
    onExit(listener) { exitListeners.push(listener) },

    async start(options: AdapterStartOptions): Promise<AdapterStartResult> {
      try {
        await launch()
      } catch (error) {
        throw new AdapterError('grok', `Grok Build could not start: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      const link = requireRpc()
      let result: any
      try {
        if (options.forkFrom) {
          const fork = await link.request<any>('_x.ai/session/fork', { sourceSessionId: options.forkFrom, sourceCwd: host.checkout, newCwd: host.checkout }, { timeoutMs: 60_000 })
          sessionId = String(fork?.newSessionId || '')
          if (!sessionId) throw new Error('fork returned no session id')
          result = await link.request<any>('session/resume', { sessionId, cwd: host.checkout, mcpServers: [] }, { timeoutMs: 120_000 })
        } else if (options.resume) {
          sessionId = options.resume
          result = await link.request<any>('session/resume', { sessionId, cwd: host.checkout, mcpServers: [] }, { timeoutMs: 120_000 })
        } else {
          result = await link.request<any>('session/new', { cwd: host.checkout, mcpServers: [] }, { timeoutMs: 120_000 })
          sessionId = String(result?.sessionId || '')
          if (!sessionId) throw new Error('session/new returned no session id')
        }
      } catch (error) {
        throw new AdapterError('grok', `Grok Build could not ${options.forkFrom ? 'fork' : options.resume ? 'resume' : 'open'} its session: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      applyConfigOptions(result?.configOptions)
      if (options.modelId && options.modelId !== modelId) await setConfigOption('model', options.modelId)
      if (options.effort && options.effort !== effort) await setConfigOption('reasoning_effort', options.effort)
      assertRequiredCapabilities('grok', CAPABILITIES)
      return { nativeSessionId: sessionId!, capabilities: CAPABILITIES, modelId, effort, efforts, commands }
    },

    async prompt(id: string, input: PromptInput, signal: AbortSignal): Promise<TurnResult> {
      const link = requireRpc()
      turnId = id
      messageCounter = 0
      newMessageIds()
      cancelRequested = false
      const blocks: any[] = [{ type: 'text', text: input.text }]
      for (const mention of input.mentions) {
        try {
          const text = await readCheckoutTextFile(host.checkout, mention.path)
          if (Buffer.byteLength(text, 'utf8') <= INLINE_MENTION_BYTES) {
            blocks.push({ type: 'resource', resource: { uri: `file://${host.checkout}/${mention.path}`, text, mimeType: 'text/plain' } })
            continue
          }
        } catch { /* fall through to a link */ }
        blocks.push({ type: 'resource_link', uri: `file://${host.checkout}/${mention.path}`, name: mention.path })
      }
      for (const attachment of input.attachments) {
        if (typeof attachment.text === 'string') {
          blocks.push({ type: 'resource', resource: { uri: `file://${host.checkout}/${attachment.path}`, text: attachment.text, mimeType: 'text/plain' } })
        } else {
          blocks.push({ type: 'resource_link', uri: `file://${host.checkout}/${attachment.path}`, name: attachment.name })
        }
      }
      const onAbort = () => { void adapter.cancel() }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await link.request<any>('session/prompt', { sessionId, prompt: blocks }, { timeoutMs: 0 })
        const meta = result?._meta || {}
        const usage = meta.usage || {}
        return {
          stopReason: cancelRequested && stopReason(result?.stopReason) === 'end_turn' ? 'cancelled' : stopReason(result?.stopReason),
          usage: {
            inputTokens: numberOr(usage.inputTokens ?? meta.inputTokens),
            outputTokens: numberOr(usage.outputTokens ?? meta.outputTokens),
            totalTokens: numberOr(usage.totalTokens ?? meta.totalTokens),
          },
        }
      } catch (error) {
        if (signal.aborted || cancelRequested) return { stopReason: 'cancelled' }
        return { stopReason: 'error', error: `Grok Build: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        signal.removeEventListener('abort', onAbort)
        for (const [toolId, open] of openTools) {
          host.emit({ type: 'tool.finished', turnId: id, id: toolId, status: 'cancelled', durationMs: Date.now() - open.startedAt })
        }
        openTools.clear()
        turnId = null
      }
    },

    async steer(text: string): Promise<void> {
      await requireRpc().request('_x.ai/interject', { sessionId, text }, { timeoutMs: 30_000 })
    },

    async cancel(): Promise<void> {
      cancelRequested = true
      if (rpc && !rpc.isClosed) rpc.notify('session/cancel', { sessionId })
    },

    async setModel(nextModel: string, nextEffort: string) {
      if (nextModel && nextModel !== modelId) await setConfigOption('model', nextModel)
      if (nextEffort && nextEffort !== effort) await setConfigOption('reasoning_effort', nextEffort)
      return { modelId, effort, efforts }
    },

    async setMode(): Promise<void> {
      throw new AdapterError('grok', 'Grok Build sessions have no modes', 'unsupported')
    },

    async fork(): Promise<string> {
      const fork = await requireRpc().request<any>('_x.ai/session/fork', { sourceSessionId: sessionId, sourceCwd: host.checkout, newCwd: host.checkout }, { timeoutMs: 60_000 })
      const id = String(fork?.newSessionId || '')
      if (!id) throw new AdapterError('grok', 'Grok Build fork returned no session id')
      return id
    },

    async close(): Promise<void> {
      if (rpc && !rpc.isClosed && sessionId) {
        try { await rpc.request('session/close', { sessionId }, { timeoutMs: 10_000 }) } catch { /* best effort */ }
        rpc.end()
      }
      if (child && alive) {
        await Promise.race([
          new Promise<void>((resolve) => child!.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ])
        if (alive) { try { child.kill('SIGTERM') } catch { /* gone */ } }
      }
    },
  }
  return adapter
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
