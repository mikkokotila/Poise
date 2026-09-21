import { memorySuffix } from '../memory-content'
// Codex adapter: one `codex app-server --listen stdio://` process per session,
// speaking the v2 app-server JSON-RPC protocol (codex-cli 0.154.0, types under
// server/chat/generated/codex — regenerate with `codex app-server generate-ts`).
//
// Shape of a session:
//   initialize → initialized → model/list → thread/start | thread/resume |
//   thread/fork, then one `turn/start` per prompt. Codex streams the turn as
//   `item/*` notifications keyed by item id and ends it with `turn/completed`
//   (or an `error` with willRetry=false). Approvals, permission grants and
//   questions come back as server requests we must answer; an unanswered one
//   hangs the turn, so every method Codex can ask for gets a reply here, even
//   if that reply is a JSON-RPC error.
//
// Model and effort are per turn on this protocol, so `setModel` only records
// the choice and the next `turn/start` carries it.
//
// Nothing here persists or talks to the browser: the host stamps sessionId
// and seq, keeps the permission memory, and stores the transcript mirror.

import { randomUUID } from 'node:crypto'
import { basename, resolve, sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type {
  ApplyPatchApprovalResponse,
  ClientNotification,
  ClientRequest,
  ExecCommandApprovalResponse,
  ServerNotification,
  ServerRequest,
  v2,
} from '../generated/codex'
import { CHAT_LIMITS } from '../protocol'
import type { ChatEvent, ContentBlock, PlanEntry, PromptInput, StopReason, ToolKind, ToolLocation, ToolStatus, TurnUsage } from '../protocol'
import { RpcError, StdioRpc } from '../rpc'
import { AdapterError } from './types'
import type { Adapter, AdapterHost, AdapterStartOptions, AdapterStartResult, PermissionRequest, TurnResult } from './types'
import pkg from '../../../package.json'

const AGENT = 'codex' as const
const LABEL = 'Codex'

const CAPABILITIES = {
  steer: true,
  fork: true,
  thought: true,
  plan: true,
  commands: false,
  modes: false,
  permissions: true,
  questions: true,
  resume: true,
  images: false,
} as const

/** The four decisions Codex accepts for command and file-change approvals,
 *  presented as Poise permission options. `acceptForSession` is what Codex
 *  would remember itself; the runtime keeps its own session grants and may
 *  answer later prompts without asking, so both paths stay consistent. */
const APPROVAL_OPTIONS: PermissionRequest['options'] = [
  { id: 'accept', name: 'Allow once', kind: 'allow_once' },
  { id: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
  { id: 'decline', name: 'Reject', kind: 'reject_once' },
  { id: 'cancel', name: 'Reject and stop', kind: 'reject_always' },
]

/** How long stdin may stay closed before the process is signalled. */
const EXIT_GRACE_MS = 3_000
/** Output cards are re-emitted at most this often while a command streams. */
const OUTPUT_FLUSH_MS = 150
const TRUNCATION_MARKER = '\n… [output truncated by Poise]'

// ── Generated-type pins ─────────────────────────────────────────────────
// Every method name used on the wire goes through these aliases so a Codex
// release that renames or drops a method fails the typecheck, not a session.

type ClientMethod = ClientRequest['method']
type ClientParams<M extends ClientMethod> = Extract<ClientRequest, { method: M }>['params']
type NotificationMethod = ServerNotification['method']
type NotificationParams<M extends NotificationMethod> = Extract<ServerNotification, { method: M }>['params']
type ServerMethod = ServerRequest['method']
type ServerParams<M extends ServerMethod> = Extract<ServerRequest, { method: M }>['params']

interface ServerResponses {
  'item/commandExecution/requestApproval': v2.CommandExecutionRequestApprovalResponse
  'item/fileChange/requestApproval': v2.FileChangeRequestApprovalResponse
  'item/tool/requestUserInput': v2.ToolRequestUserInputResponse
  'mcpServer/elicitation/request': v2.McpServerElicitationRequestResponse
  'item/permissions/requestApproval': v2.PermissionsRequestApprovalResponse
  'item/tool/call': v2.DynamicToolCallResponse
  'account/chatgptAuthTokens/refresh': v2.ChatgptAuthTokensRefreshResponse
  'attestation/generate': v2.AttestationGenerateResponse
  'applyPatchApproval': ApplyPatchApprovalResponse
  'execCommandApproval': ExecCommandApprovalResponse
}

const INITIALIZED: ClientNotification['method'] = 'initialized'

/** Notifications Codex sends that carry nothing the transcript needs. Each is
 *  logged the first time it shows up so a new Codex build is visible in the
 *  server log without flooding it. */
const IGNORED_NOTIFICATIONS: readonly NotificationMethod[] = [
  'mcpServer/startupStatus/updated',
  'deprecationNotice',
  'thread/status/changed',
  'thread/started',
  'thread/settings/updated',
  'thread/goal/cleared',
  'account/updated',
  'account/rateLimits/updated',
  'account/login/completed',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'turn/diff/updated',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'turn/moderationMetadata',
]

// ── Per-turn state ──────────────────────────────────────────────────────

class OutputBuffer {
  text = ''
  bytes = 0
  truncated = false

  append(delta: string): void {
    if (this.truncated) return
    const size = Buffer.byteLength(delta)
    if (this.bytes + size <= CHAT_LIMITS.toolOutputBytes) {
      this.text += delta
      this.bytes += size
      return
    }
    const room = Math.max(0, CHAT_LIMITS.toolOutputBytes - this.bytes)
    this.text += Buffer.from(delta).subarray(0, room).toString('utf8') + TRUNCATION_MARKER
    this.bytes = CHAT_LIMITS.toolOutputBytes
    this.truncated = true
  }
}

interface OpenTool {
  id: string
  kind: ToolKind
  startedAt: number
  output: OutputBuffer
  lastFlush: number
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Pre-images of the files a fileChange item touches, keyed by path. */
}

/** What a file looked like at one moment, or why that could not be read. */
type Snapshot = { ok: true, exists: boolean, text: string } | { ok: false, reason: string }

interface ActiveTurn {
  /** Poise turn id, stamped on every event. */
  id: string
  /** Codex turn id, known from the `turn/start` response or first event. */
  nativeId: string | null
  done: boolean
  interruptRequested: boolean
  tools: Map<string, OpenTool>
  /** Item ids that streamed through deltas, so completion does not repeat them. */
  streamed: Set<string>
  usage?: TurnUsage
  /** Item completions still reading file snapshots; the turn settles after them. */
  pending: Set<Promise<void>>
  finishing: boolean
  resolve: (result: TurnResult) => void
}

function isMissingFile(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'ENOENT') return true
  return /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))
}

function turnStopReason(status: v2.TurnStatus): StopReason {
  switch (status) {
    case 'completed': return 'end_turn'
    case 'interrupted': return 'cancelled'
    case 'failed': return 'error'
    default: return 'end_turn'
  }
}

/** Codex's own message plus, for a usage limit, a prefix that names the
 *  provider so the user knows which account to look at. */
function describeTurnError(error: v2.TurnError | null): string {
  if (!error) return `${LABEL} reported a failed turn`
  const info = error.codexErrorInfo
  if (info === 'usageLimitExceeded') return `${LABEL} usage limit reached: ${error.message}`
  if (info === 'rateLimitExceeded') return `${LABEL} rate limit reached: ${error.message}`
  if (info === 'unauthorized') return `${LABEL} is not signed in: ${error.message}`
  return `${LABEL}: ${error.message}`
}

function itemStatus(status: v2.CommandExecutionStatus | v2.PatchApplyStatus | v2.McpToolCallStatus | v2.DynamicToolCallStatus): ToolStatus {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'declined': return 'cancelled'
    default: return 'completed'
  }
}

function planStatus(status: v2.TurnPlanStepStatus): PlanEntry['status'] {
  return status === 'inProgress' ? 'in_progress' : status
}

function boundedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
  const buffer = new OutputBuffer()
  buffer.append(text)
  return buffer.text
}

function fileChangeTitle(changes: v2.FileUpdateChange[]): string {
  if (changes.length === 1) return `Edit ${basename(changes[0].path)}`
  return `Edit ${changes.length} files`
}

/** Reverse-apply a unified diff to the file it produced, giving the exact
 *  pre-image without ever having read it. Returns null when the diff does
 *  not fit `after` (context or added lines differ), so a wrong pre-image is
 *  never recorded. Handles "\ No newline at end of file" markers. */
export function reverseUnifiedDiff(diff: string, after: string): string | null {
  const afterEol = after.endsWith('\n')
  const afterLines = after === '' ? [] : after.split('\n')
  if (afterEol) afterLines.pop()
  const before: string[] = []
  let position = 0 // index into afterLines
  let oldEol: boolean | null = null
  let lastOld = false // whether the previous hunk line belongs to the old side
  const lines = diff.split('\n')
  let index = lines.findIndex((line) => line.startsWith('@@'))
  if (index === -1) return null
  for (; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!header) return null
      const newStart = Number(header[3])
      const newLength = header[4] === undefined ? 1 : Number(header[4])
      const target = newLength === 0 ? newStart : newStart - 1
      if (target < position || target > afterLines.length) return null
      while (position < target) before.push(afterLines[position++])
      continue
    }
    if (line === '' && index === lines.length - 1) break
    const marker = line[0]
    const text = line.slice(1)
    if (marker === ' ') {
      if (afterLines[position] !== text) return null
      before.push(text)
      position++
      lastOld = true
    } else if (marker === '+') {
      if (afterLines[position] !== text) return null
      position++
      lastOld = false
    } else if (marker === '-') {
      before.push(text)
      lastOld = true
    } else if (marker === '\\') {
      // The side the marker follows ends without a newline.
      if (lastOld) oldEol = false
      else oldEol = true
    } else {
      return null
    }
  }
  while (position < afterLines.length) before.push(afterLines[position++])
  if (!before.length) return ''
  // An emptied post-image says nothing about the old trailing newline; the
  // diff marks its absence explicitly, so it defaults to present.
  return before.join('\n') + ((oldEol ?? (after === '' ? true : afterEol)) ? '\n' : '')
}

function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms)
    void promise.then(() => { clearTimeout(timer); resolveWait(true) })
  })
}

/** "Codex exited (code): last stderr lines" once the process is gone; the
 *  link's own reason when it is still running (a framing failure). */
async function exitMessage(process: ChildProcess, link: StdioRpc, fallback: Error): Promise<string> {
  if (process.exitCode === null && process.signalCode === null) {
    const exited = new Promise<void>((resolveExit) => process.once('exit', () => resolveExit()))
    if (!(await withTimeout(exited, EXIT_GRACE_MS))) return fallback.message
  }
  const tail = link.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ')
  return `${LABEL} exited (${process.exitCode ?? process.signalCode ?? 'unknown'})${tail ? `: ${tail}` : ''}`
}

// ── Adapter ─────────────────────────────────────────────────────────────

export function createCodexAdapter(host: AdapterHost): Adapter {
  let child: ChildProcess | null = null
  let rpc: StdioRpc | null = null
  let safeMode = false
  let threadId: string | undefined
  let modelId = ''
  let effort = ''
  let efforts: string[] = []
  let active: ActiveTurn | null = null
  let lastFinishedNativeId: string | null = null
  let closing = false
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const loggedOnce = new Set<string>()

  function logOnce(key: string, message: string): void {
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    host.log(message)
  }

  function link(): StdioRpc {
    if (!rpc || rpc.isClosed) throw new AdapterError(AGENT, `${LABEL} is not running`, 'exited')
    return rpc
  }

  function call<M extends ClientMethod, R = unknown>(method: M, params: ClientParams<M>, options?: { timeoutMs?: number }): Promise<R> {
    return link().request<R>(method, params, options)
  }

  function on<M extends NotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void): void {
    rpc!.onNotification(method, (params) => handler(params as NotificationParams<M>))
  }

  // The link aborts `signal` when it fails; a handler still waiting on the
  // user then has nobody to answer, and StdioRpc discards the late reply.
  function serve<M extends ServerMethod>(method: M, handler: (params: ServerParams<M>, signal: AbortSignal) => Promise<ServerResponses[M]> | ServerResponses[M]): void {
    rpc!.onRequest(method, (params, _id, signal) => handler(params as ServerParams<M>, signal))
  }

  // Events belong to the turn whose prompt() is pending. Codex reports the
  // turn id in the `turn/start` response, but the first notifications can
  // overtake that response, so the id is also accepted from the stream —
  // unless it is the id of the turn that just ended (a straggler).
  function turnFor(nativeTurnId: string): ActiveTurn | null {
    const turn = active
    if (!turn || turn.done) return null
    if (turn.nativeId === null) {
      if (nativeTurnId === lastFinishedNativeId) return null
      turn.nativeId = nativeTurnId
    }
    return turn.nativeId === nativeTurnId ? turn : null
  }

  function emit(event: ChatEvent): void {
    host.emit(event)
  }

  function openTool(turn: ActiveTurn, id: string, kind: ToolKind, title: string, input?: unknown, locations?: ToolLocation[]): OpenTool {
    const tool: OpenTool = { id, kind, startedAt: Date.now(), output: new OutputBuffer(), lastFlush: 0, flushTimer: null }
    turn.tools.set(id, tool)
    emit({ type: 'tool.started', turnId: turn.id, id, kind, title, ...(locations?.length ? { locations } : {}), ...(input !== undefined ? { input } : {}) })
    return tool
  }

  function closeTool(turn: ActiveTurn, id: string, status: ToolStatus, content?: ContentBlock[], durationMs?: number): void {
    const tool = turn.tools.get(id)
    if (!tool) return
    turn.tools.delete(id)
    if (tool.flushTimer) clearTimeout(tool.flushTimer)
    emit({
      type: 'tool.finished',
      turnId: turn.id,
      id,
      status,
      ...(content?.length ? { content } : {}),
      durationMs: durationMs ?? Date.now() - tool.startedAt,
    })
  }

  function terminalBlock(tool: OpenTool, exitCode?: number | null): ContentBlock {
    return { type: 'terminal', text: tool.output.text, exitCode: exitCode ?? null, ...(tool.output.truncated ? { truncated: true } : {}) }
  }

  // Leading-edge throttle: the first chunk of output shows up at once, later
  // chunks are batched so a chatty command does not write a transcript row
  // per byte.
  function flushOutput(turn: ActiveTurn, tool: OpenTool): void {
    const now = Date.now()
    const send = () => {
      tool.flushTimer = null
      tool.lastFlush = Date.now()
      if (turn.done || !turn.tools.has(tool.id)) return
      emit({ type: 'tool.updated', turnId: turn.id, id: tool.id, status: 'running', content: [terminalBlock(tool)] })
    }
    if (now - tool.lastFlush >= OUTPUT_FLUSH_MS) { send(); return }
    if (!tool.flushTimer) tool.flushTimer = setTimeout(send, OUTPUT_FLUSH_MS - (now - tool.lastFlush))
  }

  /** A file's contents through the host, scoped to the checkout. A missing
   *  file is a legitimate answer (created or deleted file); any other failure
   *  is kept so the diff can fall back and say why. */
  function snapshot(path: string): Promise<Snapshot> {
    return host.readTextFile(path).then(
      (text) => ({ ok: true, exists: true, text }),
      (error: unknown) => isMissingFile(error)
        ? { ok: true, exists: false, text: '' }
        : { ok: false, reason: error instanceof Error ? error.message : String(error) },
    )
  }

  function track(turn: ActiveTurn, task: Promise<void>): void {
    turn.pending.add(task)
    void task.catch((error) => host.log(`${LABEL}: item completion failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => turn.pending.delete(task))
  }

  // Turn completion waits for item completions that are still reading file
  // snapshots, so every diff lands before prompt() resolves.
  function finish(turn: ActiveTurn, result: TurnResult): void {
    if (turn.done || turn.finishing) return
    turn.finishing = true
    const settle = async () => { while (turn.pending.size) await Promise.allSettled([...turn.pending]) }
    void settle().then(() => complete(turn, result))
  }

  function complete(turn: ActiveTurn, result: TurnResult): void {
    if (turn.done) return
    turn.done = true
    if (turn.nativeId) lastFinishedNativeId = turn.nativeId
    // Every tool that started gets a finish, even when Codex never sent one.
    const straggler: ToolStatus = result.stopReason === 'end_turn' ? 'completed' : 'cancelled'
    for (const id of [...turn.tools.keys()]) closeTool(turn, id, straggler)
    if (active === turn) active = null
    turn.resolve({ ...result, ...(turn.usage ? { usage: turn.usage } : {}) })
  }

  // ── Notifications ───────────────────────────────────────────────────

  function handleItemStarted(turn: ActiveTurn, item: v2.ThreadItem): void {
    switch (item.type) {
      case 'commandExecution':
        openTool(turn, item.id, 'execute', item.command, { command: item.command, cwd: item.cwd, actions: item.commandActions })
        return
      case 'fileChange': {
        openTool(turn, item.id, 'edit', fileChangeTitle(item.changes), undefined, item.changes.map((change) => ({ path: change.path })))
        return
      }
      case 'mcpToolCall':
        openTool(turn, item.id, 'other', `${item.server}: ${item.tool}`, item.arguments)
        return
      case 'dynamicToolCall':
        openTool(turn, item.id, 'other', item.namespace ? `${item.namespace}: ${item.tool}` : item.tool, item.arguments)
        return
      case 'webSearch':
        openTool(turn, item.id, 'fetch', `Search: ${item.query}`, item.action ?? { query: item.query })
        return
      case 'imageView':
        openTool(turn, item.id, 'read', `View ${basename(item.path)}`, { path: item.path }, [{ path: item.path }])
        return
      case 'collabAgentToolCall':
        openTool(turn, item.id, 'other', `Agent ${item.tool}`, { prompt: item.prompt, model: item.model })
        return
      default:
        // agentMessage/reasoning/plan stream through deltas; userMessage,
        // hooks, review-mode markers and compaction have no card.
        return
    }
  }

  function handleItemCompleted(turn: ActiveTurn, item: v2.ThreadItem, completedAtMs: number): void {
    const open = turn.tools.get(item.id)
    const durationMs = open ? Math.max(0, completedAtMs - open.startedAt) : undefined
    switch (item.type) {
      case 'agentMessage':
        if (!turn.streamed.has(item.id) && item.text) emit({ type: 'text.delta', turnId: turn.id, messageId: item.id, delta: item.text })
        return
      case 'plan':
        if (!turn.streamed.has(item.id) && item.text) emit({ type: 'text.delta', turnId: turn.id, messageId: item.id, delta: item.text })
        return
      case 'reasoning': {
        if (turn.streamed.has(item.id)) return
        const text = [...item.summary, ...item.content].filter(Boolean).join('\n\n')
        if (!text) return
        // Reasoning that arrived whole (no deltas) is shown as a think card
        // rather than a thought stream so the transcript keeps its order.
        openTool(turn, item.id, 'think', 'Reasoning')
        closeTool(turn, item.id, 'completed', [{ type: 'text', text: boundedText(text) }], 0)
        return
      }
      case 'commandExecution': {
        const tool = open ?? openTool(turn, item.id, 'execute', item.command, { command: item.command, cwd: item.cwd })
        if (item.aggregatedOutput !== null) {
          tool.output = new OutputBuffer()
          tool.output.append(item.aggregatedOutput)
        }
        closeTool(turn, item.id, itemStatus(item.status), [terminalBlock(tool, item.exitCode)], item.durationMs ?? durationMs)
        return
      }
      case 'fileChange': {
        if (!open) openTool(turn, item.id, 'edit', fileChangeTitle(item.changes), undefined, item.changes.map((change) => ({ path: change.path })))
        track(turn, recordFileChanges(turn, item, durationMs))
        return
      }
      case 'mcpToolCall': {
        if (!open) openTool(turn, item.id, 'other', `${item.server}: ${item.tool}`, item.arguments)
        const body = item.error ? item.error.message : item.result?.structuredContent ?? item.result?.content ?? ''
        const content: ContentBlock[] = body ? [{ type: 'text', text: boundedText(body) }] : []
        closeTool(turn, item.id, itemStatus(item.status), content, item.durationMs ?? durationMs)
        return
      }
      case 'dynamicToolCall': {
        if (!open) openTool(turn, item.id, 'other', item.tool, item.arguments)
        const text = (item.contentItems ?? []).map((entry) => entry.type === 'inputText' ? entry.text : `[${entry.type}]`).join('\n')
        const status: ToolStatus = item.success === false ? 'failed' : itemStatus(item.status)
        closeTool(turn, item.id, status, text ? [{ type: 'text', text: boundedText(text) }] : undefined, item.durationMs ?? durationMs)
        return
      }
      case 'webSearch': {
        if (!open) openTool(turn, item.id, 'fetch', `Search: ${item.query}`)
        const content: ContentBlock[] = item.results?.length ? [{ type: 'text', text: boundedText(item.results) }] : []
        closeTool(turn, item.id, 'completed', content, durationMs)
        return
      }
      case 'imageView':
      case 'collabAgentToolCall':
        if (open) closeTool(turn, item.id, 'completed', undefined, durationMs)
        return
      default:
        return
    }
  }

  // One diff per path with the full before/after contents, so Revert can put
  // the exact pre-image back and detect a conflicting later edit. The
  // post-image is read once the item completed; the pre-image is rebuilt by
  // reverse-applying Codex's unified diff to it. A read taken when the item
  // started is not used: Codex applies auto-approved patches right after
  // announcing them, so such a read can see a half-written file, and a
  // pre-image that might be wrong must never be offered as revertible. When
  // the diff does not describe what landed, or the file cannot be read (over
  // the host's limit, outside the checkout), the unified text is recorded
  // with `unified: true` — shown, not revertible — and the reason is logged.
  async function recordFileChanges(turn: ActiveTurn, item: Extract<v2.ThreadItem, { type: 'fileChange' }>, durationMs: number | undefined): Promise<void> {
    const seen = new Set<string>()
    for (const change of item.changes) {
      if (seen.has(change.path)) continue
      seen.add(change.path)
      if (item.status === 'declined') continue // nothing reached the disk
      const after = await snapshot(change.path)
      const oldExists = change.kind.type !== 'add'
      let before: Snapshot = { ok: false, reason: 'no pre-image could be established' }
      if (after.ok) {
        const rebuilt = oldExists ? reverseUnifiedDiff(change.diff, after.exists ? after.text : '') : ''
        if (rebuilt !== null) before = { ok: true, exists: oldExists, text: rebuilt }
        else before = { ok: false, reason: 'the diff Codex sent does not fit the file on disk, so its pre-image is unknown' }
      }
      if (!before.ok || !after.ok) {
        const reason = !after.ok ? after.reason : !before.ok ? before.reason : ''
        host.log(`${LABEL}: recording ${change.path} as a unified diff, its contents could not be read: ${reason}`)
        emit({
          type: 'diff', turnId: turn.id, toolId: item.id, diffId: randomUUID(), path: change.path,
          oldText: '', newText: change.diff, oldExists, newExists: change.kind.type !== 'delete', unified: true,
        })
        continue
      }
      if (before.exists === after.exists && before.text === after.text) continue // a no-op
      emit({
        type: 'diff', turnId: turn.id, toolId: item.id, diffId: randomUUID(), path: change.path,
        oldText: before.text, newText: after.text, oldExists: before.exists, newExists: after.exists,
      })
    }
    closeTool(turn, item.id, itemStatus(item.status), undefined, durationMs)
  }

  function registerNotifications(): void {
    on('turn/started', ({ turn }) => { turnFor(turn.id) })

    on('item/agentMessage/delta', ({ turnId, itemId, delta }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      turn.streamed.add(itemId)
      emit({ type: 'text.delta', turnId: turn.id, messageId: itemId, delta })
    })

    on('item/plan/delta', ({ turnId, itemId, delta }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      turn.streamed.add(itemId)
      emit({ type: 'text.delta', turnId: turn.id, messageId: itemId, delta })
    })

    const thought = ({ turnId, itemId, delta }: { turnId: string, itemId: string, delta: string }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      turn.streamed.add(itemId)
      emit({ type: 'thought.delta', turnId: turn.id, messageId: itemId, delta })
    }
    on('item/reasoning/summaryTextDelta', thought)
    on('item/reasoning/textDelta', thought)
    on('item/reasoning/summaryPartAdded', ({ turnId, itemId }) => {
      const turn = turnFor(turnId)
      if (turn && turn.streamed.has(itemId)) emit({ type: 'thought.delta', turnId: turn.id, messageId: itemId, delta: '\n\n' })
    })

    on('item/started', ({ turnId, item }) => {
      const turn = turnFor(turnId)
      if (turn) handleItemStarted(turn, item)
    })

    on('item/completed', ({ turnId, item, completedAtMs }) => {
      const turn = turnFor(turnId)
      if (turn) handleItemCompleted(turn, item, completedAtMs)
    })

    on('item/commandExecution/outputDelta', ({ turnId, itemId, delta }) => {
      const turn = turnFor(turnId)
      const tool = turn?.tools.get(itemId)
      if (!turn || !tool) return
      tool.output.append(delta)
      flushOutput(turn, tool)
    })

    on('item/mcpToolCall/progress', ({ turnId, itemId, message }) => {
      const turn = turnFor(turnId)
      if (turn?.tools.has(itemId)) emit({ type: 'tool.updated', turnId: turn.id, id: itemId, status: 'running', content: [{ type: 'text', text: boundedText(message) }] })
    })

    on('turn/plan/updated', ({ turnId, plan, explanation }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      emit({
        type: 'plan.updated',
        turnId: turn.id,
        entries: plan.map((step) => ({ content: step.step, status: planStatus(step.status) })),
        ...(explanation ? { explanation } : {}),
      })
    })

    on('thread/tokenUsage/updated', ({ turnId, tokenUsage }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      turn.usage = { inputTokens: tokenUsage.last.inputTokens, outputTokens: tokenUsage.last.outputTokens, totalTokens: tokenUsage.last.totalTokens }
    })

    on('turn/completed', ({ turn: native }) => {
      const turn = turnFor(native.id)
      if (!turn) return
      const stopReason = turnStopReason(native.status)
      finish(turn, stopReason === 'error' ? { stopReason, error: describeTurnError(native.error) } : { stopReason })
    })

    on('error', ({ turnId, error, willRetry }) => {
      const turn = turnFor(turnId)
      if (willRetry) {
        emit({ type: 'error', message: `${LABEL}: ${error.message} (retrying)`, recoverable: true })
        return
      }
      if (turn) finish(turn, { stopReason: 'error', error: describeTurnError(error) })
      else emit({ type: 'error', message: describeTurnError(error), recoverable: true })
    })

    on('warning', ({ message }) => { host.log(`${LABEL} warning: ${message}`) })
    on('thread/closed', ({ threadId: closed }) => {
      if (closed === threadId && active) finish(active, { stopReason: 'error', error: `${LABEL} closed the thread` })
    })

    for (const method of IGNORED_NOTIFICATIONS) {
      on(method, () => logOnce(`ignored:${method}`, `${LABEL}: ignoring ${method} notifications`))
    }
  }

  // ── Server requests ─────────────────────────────────────────────────

  async function ask(request: PermissionRequest): Promise<string> {
    try {
      return await host.requestPermission(request)
    } catch {
      // The runtime rejects when the turn was cancelled; Codex still needs a
      // decision or its turn hangs behind the prompt.
      return 'cancel'
    }
  }

  function registerServerRequests(): void {
    serve('item/commandExecution/requestApproval', async (params) => {
      const command = params.command ?? (params.kind === 'writeStdin' ? 'Send input to the running command' : 'Run a command')
      const decision = await ask({
        toolId: params.itemId,
        title: command,
        ...(params.reason ? { description: params.reason } : {}),
        input: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          kind: params.kind,
          actions: params.commandActions ?? null,
          network: params.networkApprovalContext ?? null,
        },
        options: APPROVAL_OPTIONS,
      })
      return { decision: toDecision(decision) }
    })

    serve('item/fileChange/requestApproval', async (params) => {
      const decision = await ask({
        toolId: params.itemId,
        title: params.grantRoot ? `Write files under ${params.grantRoot}` : 'Apply file changes',
        ...(params.reason ? { description: params.reason } : {}),
        input: { grantRoot: params.grantRoot ?? null },
        options: APPROVAL_OPTIONS,
      })
      return { decision: toDecision(decision) }
    })

    serve('item/permissions/requestApproval', async (params) => {
      const decision = await ask({
        toolId: params.itemId,
        title: 'Grant additional permissions',
        ...(params.reason ? { description: params.reason } : {}),
        input: { cwd: params.cwd, permissions: params.permissions },
        options: APPROVAL_OPTIONS,
      })
      const accepted = decision === 'accept' || decision === 'acceptForSession'
      const granted: v2.GrantedPermissionProfile = accepted
        ? {
            ...(params.permissions.network ? { network: params.permissions.network } : {}),
            ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          }
        : {}
      return { permissions: granted, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
    })

    serve('item/tool/requestUserInput', async (params) => {
      const questions = params.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description })),
        multiSelect: false,
        freeText: question.isOther,
      }))
      const answers: v2.ToolRequestUserInputResponse['answers'] = {}
      try {
        const replies = await host.askQuestion({ toolId: params.itemId, questions })
        for (const question of params.questions) {
          const reply = replies[question.id]
          answers[question.id] = { answers: reply === undefined ? [] : Array.isArray(reply) ? reply : [reply] }
        }
      } catch {
        for (const question of params.questions) answers[question.id] = { answers: [] }
      }
      return { answers }
    })

    serve('mcpServer/elicitation/request', (params) => {
      host.log(`${LABEL}: declining MCP elicitation from ${params.serverName} (${params.mode})`)
      return { action: 'decline', content: null, _meta: null }
    })

    // Codex asks for these only from clients that opted in (attestation,
    // ChatGPT token brokering, dynamic tools) or over the legacy v1 approval
    // path. Poise offers none of them; a definite "no" keeps the turn moving.
    serve('applyPatchApproval', () => ({ decision: { denied: { rejection: 'Poise answers only v2 approval requests' } } }))
    serve('execCommandApproval', () => ({ decision: { denied: { rejection: 'Poise answers only v2 approval requests' } } }))
    for (const method of ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call'] as const) {
      serve(method, () => { throw new RpcError(-32601, `Method not found: ${method} (Poise does not serve it)`) })
    }
  }

  function toDecision(optionId: string): v2.CommandExecutionApprovalDecision & v2.FileChangeApprovalDecision {
    switch (optionId) {
      case 'accept': return 'accept'
      case 'acceptForSession': return 'acceptForSession'
      case 'cancel': return 'cancel'
      default: return 'decline'
    }
  }

  // ── Process lifecycle ───────────────────────────────────────────────

  async function launch(): Promise<void> {
    const process = await host.spawn('codex', ['app-server', '--listen', 'stdio://'])
    child = process
    const link = new StdioRpc(process, { label: LABEL, onStderr: (text) => { if (text.trim()) host.log(`${LABEL} stderr: ${text.trimEnd()}`) } })
    rpc = link
    link.on('malformed', (frame: string) => logOnce('malformed', `${LABEL} sent a frame that is not JSON-RPC (dropped): ${frame}`))
    link.on('unhandled-notification', (method: string) => logOnce(`unhandled:${method}`, `${LABEL}: no handler for ${method} notifications`))
    link.on('unknown-method', (method: string) => logOnce(`unknown:${method}`, `${LABEL} asked for ${method}; answered with -32601`))
    link.on('orphan-response', (id: unknown) => logOnce(`orphan:${String(id)}`, `${LABEL} answered request ${String(id)} nobody was waiting for`))
    link.on('handler-error', (error: unknown) => host.log(`${LABEL} handler failed: ${error instanceof Error ? error.message : String(error)}`))
    // The link fails when Codex exits, closes stdout or breaks framing; the
    // rpc layer has already terminated the process by then, so all that is
    // left is to settle the turn with a message naming the agent. Stdout EOF
    // usually lands before `exit`, so the exit code is awaited briefly to
    // report "Codex exited (1): …" rather than "closed its stdout".
    link.on('close', (error: Error) => {
      const turn = active
      if (!turn) return
      if (closing) { finish(turn, { stopReason: 'cancelled' }); return }
      void exitMessage(process, link, error).then((message) => finish(turn, { stopReason: 'error', error: message }))
    })
    process.once('exit', (code, signal) => {
      for (const listener of exitListeners) {
        try { listener(code, signal) } catch (error) { host.log(`${LABEL} exit listener failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    })
    registerNotifications()
    registerServerRequests()
  }

  async function loadModel(wanted: string): Promise<{ model: v2.Model, available: string[] }> {
    const available: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const response: v2.ModelListResponse = await call<'model/list', v2.ModelListResponse>('model/list', cursor ? { cursor } : {}, { timeoutMs: 30_000 })
      for (const model of response.data) {
        if (model.id === wanted || model.model === wanted) return { model, available }
        available.push(model.id)
      }
      cursor = response.nextCursor
      if (!cursor) break
    }
    throw new AdapterError(AGENT, `${LABEL} does not offer model "${wanted}" (available: ${available.join(', ') || 'none'})`, 'start_failed')
  }

  function chooseEffort(model: v2.Model, wanted: string): string {
    const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    if (!supported.length || supported.includes(wanted)) return wanted
    host.log(`${LABEL}: model ${model.id} does not support effort "${wanted}"; using ${model.defaultReasoningEffort}`)
    return model.defaultReasoningEffort
  }

  function userInput(input: PromptInput): v2.UserInput[] {
    const parts: v2.UserInput[] = []
    let text = input.text
    for (const attachment of input.attachments) {
      if (attachment.text !== undefined) {
        text += `\n\n${attachment.name} (${attachment.path}):\n\`\`\`\n${attachment.text}\n\`\`\``
      } else {
        const path = insideCheckout(attachment.path)
        if (path) parts.push({ type: 'mention', name: attachment.name, path })
        else host.log(`${LABEL}: dropping attachment outside the checkout: ${attachment.path}`)
      }
    }
    parts.unshift({ type: 'text', text, text_elements: [] })
    for (const mention of input.mentions) {
      const path = insideCheckout(mention.path)
      if (path) parts.push({ type: 'mention', name: basename(path), path })
      else host.log(`${LABEL}: dropping mention outside the checkout: ${mention.path}`)
    }
    const suffix = memorySuffix(input.memories)
    if (suffix) parts.push({ type: 'text', text: suffix, text_elements: [] })
    return parts
  }

  function insideCheckout(relativePath: string): string | null {
    const absolute = resolve(host.checkout, relativePath)
    return absolute === host.checkout || absolute.startsWith(host.checkout + sep) ? absolute : null
  }

  async function interrupt(turn: ActiveTurn): Promise<void> {
    if (!threadId || !turn.nativeId || turn.done) return
    try {
      await call('turn/interrupt', { threadId, turnId: turn.nativeId }, { timeoutMs: 10_000 })
    } catch (error) {
      if (!turn.done) host.log(`${LABEL}: turn/interrupt failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const adapter: Adapter = {
    agent: AGENT,
    capabilities: CAPABILITIES,

    get nativeSessionId() { return threadId },
    get alive() { return !!child && child.exitCode === null && child.signalCode === null },

    onExit(listener) { exitListeners.push(listener) },

    async start(options: AdapterStartOptions): Promise<AdapterStartResult> {
      safeMode = options.safeMode === true
      if (child) throw new AdapterError(AGENT, `${LABEL} adapter already started`, 'protocol')
      try {
        await launch()
      } catch (error) {
        throw new AdapterError(AGENT, `${LABEL} could not be launched: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      try {
        await call('initialize', {
          clientInfo: { name: 'poise', title: 'Poise', version: pkg.version },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }, { timeoutMs: 30_000 })
        link().notify(INITIALIZED)
        const { model } = await loadModel(options.modelId)
        modelId = model.id
        effort = chooseEffort(model, options.effort)
        efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort)

        let thread: v2.Thread
        if (options.resume) {
          const response = await call<'thread/resume', v2.ThreadResumeResponse>('thread/resume', { threadId: options.resume, excludeTurns: true, approvalPolicy: safeMode ? 'on-request' : 'never', sandbox: 'danger-full-access' }, { timeoutMs: 60_000 })
          thread = response.thread
        } else if (options.forkFrom) {
          const response = await call<'thread/fork', v2.ThreadForkResponse>('thread/fork', { threadId: options.forkFrom, excludeTurns: true, approvalPolicy: safeMode ? 'on-request' : 'never', sandbox: 'danger-full-access' }, { timeoutMs: 60_000 })
          thread = response.thread
        } else {
          const response = await call<'thread/start', v2.ThreadStartResponse>('thread/start', {
            cwd: host.checkout,
            approvalPolicy: safeMode ? 'on-request' : 'never',
            sandbox: 'danger-full-access',
            model: modelId,
            ephemeral: false,
          }, { timeoutMs: 60_000 })
          thread = response.thread
        }
        threadId = thread.id
      } catch (error) {
        if (error instanceof AdapterError) throw error
        throw new AdapterError(AGENT, `${LABEL} failed to start: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      return { nativeSessionId: threadId, capabilities: CAPABILITIES, modelId, effort, efforts }
    },

    async prompt(turnId, input, signal): Promise<TurnResult> {
      if (!threadId) throw new AdapterError(AGENT, `${LABEL} adapter has no thread; call start() first`, 'protocol')
      if (active) throw new AdapterError(AGENT, `${LABEL} is already running a turn`, 'protocol')
      if (signal.aborted) return { stopReason: 'cancelled' }
      link()

      const turn: ActiveTurn = {
        id: turnId,
        nativeId: null,
        done: false,
        interruptRequested: false,
        tools: new Map(),
        streamed: new Set(),
        pending: new Set(),
        finishing: false,
        resolve: () => {},
      }
      const result = new Promise<TurnResult>((resolveTurn) => { turn.resolve = resolveTurn })
      active = turn
      const onAbort = () => { void adapter.cancel() }
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        const response = await call<'turn/start', v2.TurnStartResponse>('turn/start', {
          threadId,
          input: userInput(input),
          approvalPolicy: safeMode ? 'on-request' : 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
          model: modelId,
          effort,
        }, { timeoutMs: 60_000 })
        if (turn.nativeId === null && response.turn.id !== lastFinishedNativeId) turn.nativeId = response.turn.id
        if (response.turn.status !== 'inProgress') {
          const stopReason = turnStopReason(response.turn.status)
          finish(turn, stopReason === 'error' ? { stopReason, error: describeTurnError(response.turn.error) } : { stopReason })
        } else if (turn.interruptRequested) {
          void interrupt(turn)
        }
      } catch (error) {
        finish(turn, { stopReason: 'error', error: `${LABEL} could not start the turn: ${error instanceof Error ? error.message : String(error)}` })
      }

      return result.finally(() => signal.removeEventListener('abort', onAbort))
    },

    async steer(text) {
      const turn = active
      if (!threadId || !turn || turn.done || !turn.nativeId) throw new AdapterError(AGENT, `${LABEL} has no running turn to steer`, 'protocol')
      await call('turn/steer', {
        threadId,
        expectedTurnId: turn.nativeId,
        input: [{ type: 'text', text, text_elements: [] }],
      }, { timeoutMs: 30_000 })
    },

    async cancel() {
      const turn = active
      if (!turn || turn.done) return
      turn.interruptRequested = true
      // The prompt resolves when Codex reports the turn interrupted.
      await interrupt(turn)
    },

    async setModel(nextModelId, nextEffort) {
      const { model } = await loadModel(nextModelId)
      modelId = model.id
      effort = chooseEffort(model, nextEffort)
      efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
      return { modelId, effort, efforts }
    },

    async setSafeMode(enabled) {
      // Policy belongs to turn/start. Never inject an empty turn to change it.
      if (active && !active.done) return 'next_turn'
      safeMode = enabled
      return 'current_turn'
    },

    async setMode() {
      throw new AdapterError(AGENT, `${LABEL} has no modes`, 'unsupported')
    },

    async fork() {
      if (!threadId) throw new AdapterError(AGENT, `${LABEL} adapter has no thread to fork`, 'protocol')
      const response = await call<'thread/fork', v2.ThreadForkResponse>('thread/fork', { threadId, excludeTurns: true }, { timeoutMs: 60_000 })
      return response.thread.id
    },

    async close() {
      const process = child
      if (!process) return
      closing = true
      if (process.exitCode !== null || process.signalCode !== null) return
      const exited = new Promise<void>((resolveExit) => process.once('exit', () => resolveExit()))
      rpc?.end()
      if (await withTimeout(exited, EXIT_GRACE_MS)) return
      process.kill('SIGTERM')
      if (await withTimeout(exited, EXIT_GRACE_MS)) return
      process.kill('SIGKILL')
      await exited
    },
  }

  return adapter
}
