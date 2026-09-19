// Muse adapter: one `muse serve` process per session, speaking the Muse
// Session Protocol (MSP v1, Muse 1.3.0; types in server/chat/generated/muse/
// msp.d.ts — regenerate with `muse schema generate-ts`).
//
// Shape of a session:
//   initialize → initialized → model/list → session/start | session/resume |
//   session/fork, then one `turn/start` per prompt. Every command carries a
//   client-minted UUIDv7 `commandId` (Muse's idempotency handle; the turn id
//   of a fresh turn is that same command id). The turn streams as view
//   notifications keyed by item id and ends with `turn/completed`.
//
// Approvals arrive as an `approval/requested` notification and — for clients
// that announce dialog support — also as an `approval/request` server request;
// the same is true of `userInput/request(ed)`. Both forms are honoured and
// de-duplicated by their id, since answering twice is a wire error (-32056 in
// the recorded trace). The decision goes back through `approval/decide`.
//
// Muse offers "always allow in this workspace" choices that would write to the
// user's own Muse config (`localPersistent`). Poise keeps session-scoped grants
// itself, so a user's "allow always" is sent to Muse as the once-only choice
// and never as a persistent policy amendment.

import { randomBytes } from 'node:crypto'
import { basename, resolve, sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type {
  ApprovalChoice,
  ApprovalDecideParams,
  ApprovalDecideResult,
  ApprovalRequestParams,
  InitializeParams,
  InitializeResult,
  Item,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  ModelListParams,
  ModelListResult,
  MspMethod,
  MspNotification,
  MspServerRequest,
  ReasoningEffort,
  SessionForkParams,
  SessionForkResult,
  SessionModelChangedParams,
  SessionReasoningEffortChangedParams,
  SessionResumeParams,
  SessionResumeResult,
  SessionSetModelParams,
  SessionSetModelResult,
  SessionSetReasoningEffortParams,
  SessionSetReasoningEffortResult,
  SessionStartParams,
  SessionStartResult,
  SessionStatusChangedParams,
  SessionTokenUsageParams,
  TurnCompletedParams,
  TurnInputPart,
  TurnInterruptParams,
  TurnInterruptResult,
  TurnStartParams,
  TurnStartResult,
  TurnStartedParams,
  TurnSteerParams,
  TurnSteerResult,
  TurnUnqueueParams,
  TurnUnqueueResult,
  TurnUnqueuedParams,
  UserInputAnswer,
  UserInputAnswerParams,
  UserInputAnswerResult,
  UserInputCancelParams,
  UserInputCancelResult,
  UserInputRequestParams,
  ViewSubscribeParams,
  ViewSubscribeResult,
} from '../generated/muse/msp'
import { CHAT_LIMITS } from '../protocol'
import type { ChatEvent, ContentBlock, PermissionOption, PermissionOptionKind, PromptInput, Question, ToolKind, ToolLocation, ToolStatus, TurnUsage } from '../protocol'
import { StdioRpc } from '../rpc'
import { AdapterError } from './types'
import type { Adapter, AdapterHost, AdapterStartOptions, AdapterStartResult, TurnResult } from './types'
import pkg from '../../../package.json'

const AGENT = 'muse' as const
const LABEL = 'Muse'

const CAPABILITIES = {
  steer: true,
  fork: true,
  thought: true,
  plan: false,
  commands: false,
  modes: false,
  permissions: true,
  questions: true,
  resume: true,
  images: false,
} as const

/** MSP fixes the effort vocabulary in the schema rather than per model. */
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const EXIT_GRACE_MS = 3_000
/** How long a steered message may take to start its native turn (observed
 *  ~0.1 s on 1.3.0; the bound only catches a message that never runs). */
const STEER_SETTLE_MS = 30_000
const OUTPUT_FLUSH_MS = 150
const TRUNCATION_MARKER = '\n… [output truncated by Poise]'

// ── Generated-type pins ─────────────────────────────────────────────────
// msp.d.ts only lists method names as string unions, so the params/result
// pairing is declared here and checked against those unions: a Muse release
// that drops a method or renames a notification fails the typecheck.

interface Methods {
  'initialize': { params: InitializeParams, result: InitializeResult }
  'model/list': { params: ModelListParams, result: ModelListResult }
  'session/start': { params: SessionStartParams, result: SessionStartResult }
  'session/resume': { params: SessionResumeParams, result: SessionResumeResult }
  'session/fork': { params: SessionForkParams, result: SessionForkResult }
  'session/setModel': { params: SessionSetModelParams, result: SessionSetModelResult }
  'session/setReasoningEffort': { params: SessionSetReasoningEffortParams, result: SessionSetReasoningEffortResult }
  'view/subscribe': { params: ViewSubscribeParams, result: ViewSubscribeResult }
  'turn/start': { params: TurnStartParams, result: TurnStartResult }
  'turn/steer': { params: TurnSteerParams, result: TurnSteerResult }
  'turn/interrupt': { params: TurnInterruptParams, result: TurnInterruptResult }
  'turn/unqueue': { params: TurnUnqueueParams, result: TurnUnqueueResult }
  'approval/decide': { params: ApprovalDecideParams, result: ApprovalDecideResult }
  'userInput/answer': { params: UserInputAnswerParams, result: UserInputAnswerResult }
  'userInput/cancel': { params: UserInputCancelParams, result: UserInputCancelResult }
}
type Method = keyof Methods & MspMethod

interface Notifications {
  'turn/started': TurnStartedParams
  'turn/completed': TurnCompletedParams
  'turn/unqueued': TurnUnqueuedParams
  'item/started': ItemStartedParams
  'item/updated': ItemUpdatedParams
  'item/delta': ItemDeltaParams
  'item/completed': ItemCompletedParams
  'approval/requested': ApprovalRequestParams
  'userInput/requested': UserInputRequestParams
  'session/statusChanged': SessionStatusChangedParams
  'session/modelChanged': SessionModelChangedParams
  'session/reasoningEffortChanged': SessionReasoningEffortChangedParams
  'session/tokenUsage': SessionTokenUsageParams
}
type Notification = keyof Notifications & MspNotification

interface ServerRequests {
  'approval/request': ApprovalRequestParams
  'userInput/request': UserInputRequestParams
}
type ServerRequest = keyof ServerRequests & MspServerRequest

const INITIALIZED: MspNotification = 'initialized'

/** View notifications Muse sends that the transcript does not need; each is
 *  logged once so a new Muse build stays visible in the server log. */
const IGNORED_NOTIFICATIONS: readonly MspNotification[] = [
  'approval/updated',
  'approval/resolved',
  'userInput/settled',
  'session/branchChanged',
  'session/contextUsage',
  'session/approvalModeChanged',
  'session/goalChanged',
  'session/todoListChanged',
  'session/nameChanged',
  'session/viewHealthChanged',
  'session/listChanged',
  'session/modelRouteUnserved',
  'turn/retracted',
  'turn/retryScheduled',
  'skill/changed',
  'usage/changed',
  'view/gap',
]

// ── Helpers ─────────────────────────────────────────────────────────────

/** UUIDv7 (RFC 9562): 48-bit unix-ms timestamp, version nibble, 12 random
 *  bits, RFC variant, 62 random bits. Muse requires v7 for `commandId`. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
  const ms = BigInt(now)
  for (let index = 0; index < 6; index++) bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

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
  tool: string
  args: unknown
  startedAt: number
  output: OutputBuffer
  lastFlush: number
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Pre-images of the files an edit-family tool targets, keyed by path,
   *  taken while the tool waited for its approval — the one moment the
   *  edit provably has not run yet. Without an approval round-trip there
   *  is no such moment, and no pre-image is claimed. */
  snapshots?: Map<string, Promise<Snapshot>>
}

/** What a file looked like at one moment, or why that could not be read. */
type Snapshot = { ok: true, exists: boolean, text: string } | { ok: false, reason: string }

function isMissingFile(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'ENOENT') return true
  return /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))
}

interface ActiveTurn {
  id: string
  nativeId: string | null
  done: boolean
  interruptRequested: boolean
  tools: Map<string, OpenTool>
  /** Item ids whose text streamed as deltas. */
  streamed: Set<string>
  /** Native reminder housekeeping, never conversation content. */
  internalItems: Set<string>
  usage?: TurnUsage
  /** Item completions still reading file snapshots; the turn settles after them. */
  pending: Set<Promise<void>>
  finishing: boolean
  /** Command ids of accepted steers: Muse (1.3.0) completes the running
   *  turn and starts a new native turn under the steer's command id, so the
   *  Poise turn stays open until each of those ran. */
  steers: Set<string>
  /** Native turn ids this Poise turn has owned, oldest first. */
  nativeIds: string[]
  endedNativeIds: Set<string>
  cancellationRequests: Map<string, Promise<void>>
  terminalError?: string
  /** Muse admitted the turn behind another one; it has not launched. */
  queued: boolean
  resolve: (result: TurnResult) => void
}

function toolKind(tool: string | undefined): ToolKind {
  const name = (tool ?? '').toLowerCase()
  if (!name) return 'other'
  if (/^(bash|shell|sh|exec|execute|run|command|zsh|powershell)$/.test(name)) return 'execute'
  if (/^(read|read_file|cat|view|list|ls|list_dir|list_directory|tree)$/.test(name)) return 'read'
  if (/^(grep|glob|search|find|rg|ripgrep|code_search)$/.test(name)) return 'search'
  if (/^(write|write_file|edit|edit_file|patch|apply_patch|multi_edit|str_replace|create_file)$/.test(name)) return 'edit'
  if (/^(fetch|web_fetch|http|web_search|browse|curl)$/.test(name)) return 'fetch'
  return 'other'
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return raw }
}

function argString(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function toolTitle(tool: string, kind: ToolKind, args: unknown): string {
  const command = argString(args, 'command', 'cmd')
  if (kind === 'execute' && command) return command
  const path = argString(args, 'path', 'file_path', 'filePath', 'file')
  if (path) return `${tool} ${basename(path)}`
  const pattern = argString(args, 'pattern', 'query', 'url')
  if (pattern) return `${tool} ${pattern}`
  return tool
}

function toolLocations(args: unknown): ToolLocation[] | undefined {
  const path = argString(args, 'path', 'file_path', 'filePath', 'file')
  return path ? [{ path }] : undefined
}

function itemToolStatus(status: Item['status']): ToolStatus {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': case 'timedOut': return 'failed'
    case 'cancelled': case 'rejected': return 'cancelled'
    case 'inProgress': return 'running'
    default: return 'completed'
  }
}

/** Muse's bash tool reports a JSON envelope in `visibleOutput`; when it parses
 *  the terminal card gets the real output and exit code instead of the JSON. */
function terminalFromVisibleOutput(text: string): { output: string, exitCode: number | null } | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
      return { output: parsed.output, exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : null }
    }
  } catch { /* plain text */ }
  return null
}

function boundedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
  const buffer = new OutputBuffer()
  buffer.append(text)
  return buffer.text
}

function choiceKind(choice: ApprovalChoice): PermissionOptionKind {
  switch (choice.decision) {
    case 'approved':
      return choice.scope === 'once' ? 'allow_once' : 'allow_always'
    case 'approvedForSession':
    case 'approvedPolicyAmendment':
      return 'allow_always'
    case 'deniedPolicyAmendment':
      return 'reject_always'
    default:
      return 'reject_once'
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms)
    void promise.then(() => { clearTimeout(timer); resolveWait(true) })
  })
}

/** "Muse exited (code): last stderr lines" once the process is gone; the
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

export function createMuseAdapter(host: AdapterHost, options: { steerSettleMs?: number } = {}): Adapter {
  const steerSettleMs = options.steerSettleMs ?? STEER_SETTLE_MS
  let child: ChildProcess | null = null
  let rpc: StdioRpc | null = null
  let sessionId: string | undefined
  let modelId = ''
  let effort = ''
  let active: ActiveTurn | null = null
  let lastFinishedNativeId: string | null = null
  let closing = false
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const loggedOnce = new Set<string>()
  /** Approvals and questions already being answered, by their id. */
  const pendingApprovals = new Set<string>()
  /** Pre-images taken for an approval whose tool item had not started yet. */
  const preApproved = new Map<string, Map<string, Promise<Snapshot>>>()
  const pendingUserInputs = new Set<string>()

  function logOnce(key: string, message: string): void {
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    host.log(message)
  }

  function link(): StdioRpc {
    if (!rpc || rpc.isClosed) throw new AdapterError(AGENT, `${LABEL} is not running`, 'exited')
    return rpc
  }

  function call<M extends Method>(method: M, params: Methods[M]['params'], options?: { timeoutMs?: number }): Promise<Methods[M]['result']> {
    return link().request<Methods[M]['result']>(method, params, options)
  }

  function on<M extends Notification>(method: M, handler: (params: Notifications[M]) => void): void {
    rpc!.onNotification(method, (params) => {
      const view = params as Notifications[M]
      // A forked session stays subscribed on this connection; only this
      // session's view is ours.
      if (view.sessionId !== sessionId) return
      handler(view)
    })
  }

  function serve<M extends ServerRequest>(method: M, handler: (params: ServerRequests[M]) => void): void {
    rpc!.onRequest(method, (params) => {
      const request = params as ServerRequests[M]
      if (request.sessionId === sessionId) handler(request)
      // The request form is acknowledged with `{}`; the decision travels as
      // its own command, exactly like the notification form.
      return {}
    })
  }

  function session(): string {
    if (!sessionId) throw new AdapterError(AGENT, `${LABEL} adapter has no session; call start() first`, 'protocol')
    return sessionId
  }

  function turnFor(nativeTurnId: string | null | undefined): ActiveTurn | null {
    const turn = active
    if (!turn || turn.done || !nativeTurnId) return null
    if (turn.nativeId === null) {
      if (nativeTurnId === lastFinishedNativeId) return null
      turn.nativeId = nativeTurnId
      turn.nativeIds.push(nativeTurnId)
    }
    if (turn.nativeId === nativeTurnId || turn.nativeIds.includes(nativeTurnId)) return turn
    if (turn.steers.has(nativeTurnId)) {
      // The steer's own native turn: it belongs to this Poise turn.
      // A queued user-message item can precede turn/started. Associate it
      // with this turn without prematurely treating the queue as consumed.
      turn.nativeId = nativeTurnId
      if (!turn.nativeIds.includes(nativeTurnId)) turn.nativeIds.push(nativeTurnId)
      return turn
    }
    return null
  }

  // A completed native turn with steers still to run is not the end of the
  // Poise turn; if their turn does not start promptly the process is ended
  // rather than the checkout released over an unknown queue.
  let steerSettleTimer: ReturnType<typeof setTimeout> | null = null
  function clearSteerSettle() {
    if (steerSettleTimer) { clearTimeout(steerSettleTimer); steerSettleTimer = null }
  }
  function armSteerSettle(turn: ActiveTurn) {
    clearSteerSettle()
    steerSettleTimer = setTimeout(() => {
      steerSettleTimer = null
      if (active !== turn || turn.done) return
      void endForUnsettled(turn)
    }, steerSettleMs)
    steerSettleTimer.unref()
  }
  async function endForUnsettled(turn: ActiveTurn) {
    host.log(`${LABEL}: a steered message did not start its turn within the settle window; ending the process`)
    // The turn settles with the request that the runtime terminate the
    // worker group (verified) before the checkout goes; the close here is
    // the cooperative first step of that.
    finish(turn, { stopReason: 'error', error: `${LABEL} did not run a steered message of this turn within the settle window; the process was ended and resumes on the next prompt`, terminate: true })
    try { await adapter.close() } catch { /* the runtime terminates the group */ }
  }

  function emit(event: ChatEvent): void {
    host.emit(event)
  }

  function openTool(turn: ActiveTurn, item: Item): OpenTool {
    const name = item.tool ?? item.kind
    const kind = item.kind === 'toolCall' ? toolKind(item.tool) : 'other'
    const args = parseArgs(item.args)
    const title = item.kind === 'toolCall'
      ? toolTitle(name, kind, args)
      : item.fallbackText ?? item.objective ?? `${item.kind}${item.reminderAgentId ? ` ${item.reminderAgentId}` : ''}`
    const tool: OpenTool = { id: item.itemId, kind, tool: name, args, startedAt: Date.now(), output: new OutputBuffer(), lastFlush: 0, flushTimer: null }
    const early = preApproved.get(item.itemId)
    if (early) { tool.snapshots = early; preApproved.delete(item.itemId) }
    turn.tools.set(item.itemId, tool)
    const locations = toolLocations(args)
    emit({ type: 'tool.started', turnId: turn.id, id: item.itemId, kind, title, ...(locations ? { locations } : {}), ...(args !== undefined ? { input: args } : {}) })
    return tool
  }

  function closeTool(turn: ActiveTurn, id: string, status: ToolStatus, content?: ContentBlock[], durationMs?: number): void {
    const tool = turn.tools.get(id)
    if (!tool) return
    turn.tools.delete(id)
    if (tool.flushTimer) clearTimeout(tool.flushTimer)
    emit({ type: 'tool.finished', turnId: turn.id, id, status, ...(content?.length ? { content } : {}), durationMs: durationMs ?? Date.now() - tool.startedAt })
  }

  function outputBlock(tool: OpenTool): ContentBlock {
    if (tool.kind === 'execute') return { type: 'terminal', text: tool.output.text, exitCode: null, ...(tool.output.truncated ? { truncated: true } : {}) }
    return { type: 'text', text: tool.output.text }
  }

  function flushOutput(turn: ActiveTurn, tool: OpenTool): void {
    const now = Date.now()
    const send = () => {
      tool.flushTimer = null
      tool.lastFlush = Date.now()
      if (turn.done || !turn.tools.has(tool.id)) return
      emit({ type: 'tool.updated', turnId: turn.id, id: tool.id, status: 'running', content: [outputBlock(tool)] })
    }
    if (now - tool.lastFlush >= OUTPUT_FLUSH_MS) { send(); return }
    if (!tool.flushTimer) tool.flushTimer = setTimeout(send, OUTPUT_FLUSH_MS - (now - tool.lastFlush))
  }

  /** A file's contents through the host, scoped to the checkout. A missing
   *  file is a legitimate answer (created or deleted file); any other failure
   *  is kept so the completion can say why no diff was recorded. */
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
    clearSteerSettle()
    if (turn.nativeId) lastFinishedNativeId = turn.nativeId
    const straggler: ToolStatus = result.stopReason === 'end_turn' ? 'completed' : 'cancelled'
    for (const id of [...turn.tools.keys()]) closeTool(turn, id, straggler)
    if (active === turn) active = null
    turn.resolve({ ...result, ...(turn.usage ? { usage: turn.usage } : {}) })
  }

  function finishIfQuiescent(turn: ActiveTurn): void {
    if (turn.done || turn.steers.size || turn.nativeIds.some(id => !turn.endedNativeIds.has(id))) return
    finish(turn, turn.terminalError ? { stopReason: 'error', error: turn.terminalError }
      : { stopReason: turn.interruptRequested ? 'cancelled' : 'end_turn' })
  }

  // ── Items ───────────────────────────────────────────────────────────

  function completeTool(turn: ActiveTurn, item: Item): void {
    const tool = turn.tools.get(item.itemId) ?? openTool(turn, item)
    const content: ContentBlock[] = []
    const visible = item.visibleOutput ?? tool.output.text
    if (tool.kind === 'execute') {
      const parsed = item.visibleOutput ? terminalFromVisibleOutput(item.visibleOutput) : null
      const buffer = new OutputBuffer()
      buffer.append(parsed ? parsed.output : visible)
      const exitCode = parsed?.exitCode ?? item.exitCode ?? null
      if (buffer.text || exitCode !== null) {
        content.push({ type: 'terminal', text: buffer.text, exitCode, ...(buffer.truncated || item.truncated ? { truncated: true } : {}) })
      }
    } else if (visible) {
      content.push({ type: 'text', text: boundedText(visible) })
    }
    if (item.failureReason) content.push({ type: 'text', text: boundedText(item.failureReason) })
    if (item.result?.summary) content.push({ type: 'text', text: boundedText(item.result.text ?? item.result.summary) })
    if (item.patchSummary) {
      content.push({ type: 'text', text: `${item.patchSummary.files} file(s) changed, +${item.patchSummary.added} −${item.patchSummary.removed}` })
    }
    if (tool.snapshots) {
      track(turn, recordFileChanges(turn, tool, item, content))
      return
    }
    if (tool.kind === 'edit' && item.status === 'completed') {
      host.log(`${LABEL}: no reversible diff recorded for ${toolLocations(tool.args)?.map((l) => l.path).join(', ') || item.itemId}: the edit ran without an approval round-trip, so no moment before the write could be captured`)
    }
    closeTool(turn, item.itemId, itemToolStatus(item.status), content, item.durationMs)
  }

  // One diff per path with the full before/after contents, so Revert can put
  // the exact pre-image back and detect a conflicting later edit. Muse only
  // ships a patch summary and an opaque `patchRef` for edits (its structured
  // patch body has no verified format here), so the pre-image comes from the
  // approval-time read; when that could not be read (a file over the host's
  // limit, or outside the checkout) there is nothing reversible to record:
  // the card keeps the summary and the reason is logged.
  async function recordFileChanges(turn: ActiveTurn, tool: OpenTool, item: Item, content: ContentBlock[]): Promise<void> {
    for (const [path, pending] of tool.snapshots ?? []) {
      const before = await pending
      const after = before.ok ? await snapshot(path) : before
      if (!before.ok || !after.ok) {
        const reason = before.ok ? (after as { reason: string }).reason : before.reason
        host.log(`${LABEL}: no reversible diff recorded for ${path}, its contents could not be read: ${reason}`)
        continue
      }
      if (before.exists === after.exists && before.text === after.text) continue // rejected or a no-op
      emit({
        type: 'diff', turnId: turn.id, toolId: item.itemId, diffId: uuidv7(), path,
        oldText: before.text, newText: after.text, oldExists: before.exists, newExists: after.exists,
      })
    }
    closeTool(turn, item.itemId, itemToolStatus(item.status), content, item.durationMs)
  }

  function handleItemStarted(turn: ActiveTurn, item: Item): void {
    if (item.kind === 'reminderChild') { turn.internalItems.add(item.itemId); return }
    switch (item.kind) {
      case 'toolCall':
      case 'subagent':
      case 'workflow':
      case 'userShell':
        if (!turn.tools.has(item.itemId)) openTool(turn, item)
        return
      default:
        return
    }
  }

  function handleItemCompleted(turn: ActiveTurn, item: Item): void {
    if (item.kind === 'reminderChild') { turn.internalItems.add(item.itemId); return }
    switch (item.kind) {
      case 'agentMessage':
        if (!turn.streamed.has(item.itemId) && item.text) emit({ type: 'text.delta', turnId: turn.id, messageId: item.itemId, delta: item.text })
        return
      case 'reasoning': {
        if (turn.streamed.has(item.itemId)) return
        const text = [...(item.summary ?? []), item.text ?? ''].filter(Boolean).join('\n\n')
        if (text) emit({ type: 'thought.delta', turnId: turn.id, messageId: item.itemId, delta: text })
        return
      }
      case 'toolCall':
      case 'subagent':
      case 'workflow':
      case 'userShell':
        completeTool(turn, item)
        return
      default:
        return
    }
  }

  function registerNotifications(): void {
    on('turn/started', ({ turnId }) => {
      const turn = turnFor(turnId)
      if (!turn) return
      turn.queued = false
      turn.steers.delete(turnId)
      clearSteerSettle()
      if (turn.interruptRequested) void interrupt(turn)
    })

    on('turn/unqueued', ({ turnId }) => {
      const turn = active
      if (!turn || !(turn.steers.has(turnId) || turn.nativeIds.includes(turnId) || turn.nativeId === turnId)) return
      // Reclaiming one queued steer does not stop another native turn.
      turn.steers.delete(turnId)
      turn.endedNativeIds.add(turnId)
      if (!turn.nativeIds.includes(turnId)) turn.nativeIds.push(turnId)
      finishIfQuiescent(turn)
    })

    on('item/started', ({ item }) => {
      const turn = turnFor(item.turnId)
      if (turn) handleItemStarted(turn, item)
    })

    on('item/updated', ({ item }) => {
      const turn = turnFor(item.turnId)
      if (!turn) return
      if (item.kind === 'reminderChild') { turn.internalItems.add(item.itemId); return }
      if (item.status !== 'inProgress' && turn.tools.has(item.itemId)) {
        completeTool(turn, item)
        return
      }
      if (turn.tools.has(item.itemId)) {
        emit({ type: 'tool.updated', turnId: turn.id, id: item.itemId, status: 'running', ...(item.fallbackText ? { title: item.fallbackText } : {}) })
      }
    })

    on('item/completed', ({ item }) => {
      const turn = turnFor(item.turnId)
      if (turn) handleItemCompleted(turn, item)
    })

    on('item/delta', ({ itemId, field, delta }) => {
      const turn = active
      if (!turn || turn.done || turn.internalItems.has(itemId)) return
      const tool = turn.tools.get(itemId)
      if (tool) {
        if (field === 'output' || field === undefined) {
          tool.output.append(delta)
          flushOutput(turn, tool)
        }
        return
      }
      if (field === undefined || field === 'text') {
        turn.streamed.add(itemId)
        emit({ type: 'text.delta', turnId: turn.id, messageId: itemId, delta })
        return
      }
      if (field.startsWith('summary')) {
        turn.streamed.add(itemId)
        emit({ type: 'thought.delta', turnId: turn.id, messageId: itemId, delta })
      }
    })

    on('turn/completed', (params) => {
      const turn = turnFor(params.turnId)
      if (!turn) return
      turn.steers.delete(params.turnId)
      turn.endedNativeIds.add(params.turnId)
      if (params.terminal === 'cancelled') turn.interruptRequested = true
      else if (params.terminal !== 'completed') {
        turn.terminalError = `${LABEL}: ${params.error?.message ?? params.reason ?? `turn ended with ${params.terminal}`}`
        turn.interruptRequested = true
      }
      if (turn.steers.size > 0) {
        // Keep the checkout until every accepted send has either run to a
        // terminal event or been reclaimed by the native queue protocol.
        armSteerSettle(turn)
        if (turn.interruptRequested) void interrupt(turn)
      }
      finishIfQuiescent(turn)
    })

    on('session/tokenUsage', (params) => {
      const turn = turnFor(params.turnId)
      if (turn) turn.usage = { inputTokens: params.promptTokens, outputTokens: params.usage.outputTokens, totalTokens: params.totalTokens }
    })

    on('approval/requested', (params) => { void handleApproval(params) })
    on('userInput/requested', (params) => { void handleUserInput(params) })

    on('session/modelChanged', (params) => {
      modelId = params.modelId
      emit({ type: 'model.updated', model: modelId, modelId, effort, efforts: [...EFFORTS] })
    })
    on('session/reasoningEffortChanged', (params) => {
      effort = params.reasoningEffort
      emit({ type: 'model.updated', model: modelId, modelId, effort, efforts: [...EFFORTS] })
    })
    // Status is derived by the runtime from turn events; the attention flags
    // duplicate the approval/userInput notifications handled above.
    on('session/statusChanged', () => {})

    for (const method of IGNORED_NOTIFICATIONS) {
      rpc!.onNotification(method, () => logOnce(`ignored:${method}`, `${LABEL}: ignoring ${method} notifications`))
    }
  }

  // ── Approvals and questions ─────────────────────────────────────────

  function approvalTitle(params: ApprovalRequestParams): string {
    const subject = params.subject
    if (subject.command) return subject.command
    if (subject.path) return `${params.toolName} ${subject.path}`
    if (subject.host) return `${params.toolName} ${subject.host}${subject.port ? `:${subject.port}` : ''}`
    if (subject.target) return `${params.toolName} ${subject.target}`
    return params.toolName
  }

  /** Which choice to put on the wire for the option the user picked. An
   *  allow-always answer becomes Muse's once-only approval: the runtime holds
   *  the session grant, and Muse's persistent choices would edit the user's
   *  workspace policy. */
  function wireChoice(params: ApprovalRequestParams, optionId: string): ApprovalChoice | undefined {
    const picked = params.availableChoices.find((choice) => choice.choiceId === optionId)
    if (!picked) return undefined
    if (choiceKind(picked) !== 'allow_always') return picked
    return params.availableChoices.find((choice) => choice.decision === 'approved' && choice.scope === 'once')
      ?? params.availableChoices.find((choice) => choice.decision === 'approvedForSession')
      ?? picked
  }

  function rejectChoice(params: ApprovalRequestParams): ApprovalChoice | undefined {
    return params.availableChoices.find((choice) => choice.decision === 'abort')
      ?? params.availableChoices.find((choice) => choice.decision === 'denied')
      ?? params.availableChoices.find((choice) => choiceKind(choice) === 'reject_once')
      ?? params.availableChoices.find((choice) => choiceKind(choice) === 'reject_always')
  }

  async function handleApproval(params: ApprovalRequestParams): Promise<void> {
    if (pendingApprovals.has(params.approvalId)) return
    pendingApprovals.add(params.approvalId)
    const options: PermissionOption[] = params.availableChoices.map((choice) => ({ id: choice.choiceId, name: choice.label, kind: choiceKind(choice) }))
    // An edit that waits for this decision has not touched its files yet:
    // the pre-images read now (before the decision goes out) are exact.
    const approvedArgs = parseArgs(params.rawArgs)
    if (toolKind(params.toolName) === 'edit') {
      const tool = active?.tools.get(params.itemId)
      const locations = toolLocations(approvedArgs) ?? (tool ? toolLocations(tool.args) : undefined)
      if (locations) {
        const snapshots = new Map(locations.map((location) => [location.path, snapshot(location.path)]))
        await Promise.all(snapshots.values())
        if (tool) tool.snapshots = snapshots
        else preApproved.set(params.itemId, snapshots)
      }
    }
    let choice: ApprovalChoice | undefined
    try {
      const optionId = await host.requestPermission({
        toolId: params.itemId,
        title: approvalTitle(params),
        ...(params.subject.kind ? { description: `${params.toolName} (${params.subject.kind})` } : {}),
        input: { tool: params.toolName, args: approvedArgs, subject: params.subject, protectedWrite: params.protectedWrite },
        options,
      })
      choice = wireChoice(params, optionId) ?? rejectChoice(params)
    } catch {
      choice = rejectChoice(params)
    }
    if (!choice) {
      host.log(`${LABEL}: approval ${params.approvalId} offers no usable choice (${params.availableChoices.map((entry) => entry.choiceId).join(', ')})`)
      pendingApprovals.delete(params.approvalId)
      return
    }
    if (choice.scope === 'localPersistent') {
      // Never reached through wireChoice; guards a future choice set.
      host.log(`${LABEL}: refusing to send persistent choice ${choice.choiceId}`)
      choice = rejectChoice(params) ?? choice
    }
    try {
      await call('approval/decide', {
        commandId: uuidv7(),
        sessionId: session(),
        approvalId: params.approvalId,
        choiceId: choice.choiceId,
        requirementId: params.currentRequirementId,
      }, { timeoutMs: 30_000 })
    } catch (error) {
      host.log(`${LABEL}: approval/decide failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      pendingApprovals.delete(params.approvalId)
    }
  }

  async function handleUserInput(params: UserInputRequestParams): Promise<void> {
    if (pendingUserInputs.has(params.userInputId)) return
    pendingUserInputs.add(params.userInputId)
    const questions: Question[] = params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multiSelect: question.selection.mode === 'multiple',
      freeText: false,
    }))
    let answers: UserInputAnswer[] | null = null
    try {
      const replies = await host.askQuestion({ toolId: params.itemId, questions })
      answers = params.questions.map((question) => {
        const reply = replies[question.id]
        const labels = new Set(question.options.map((option) => option.label))
        if (question.selection.mode === 'multiple') {
          const picked = (Array.isArray(reply) ? reply : reply === undefined ? [] : [reply]).filter((label) => labels.has(label))
          return { questionId: question.id, selectedLabels: picked }
        }
        const single = Array.isArray(reply) ? reply[0] : reply
        if (single !== undefined && labels.has(single)) return { questionId: question.id, selectedLabel: single }
        return { questionId: question.id, freeText: (single ?? '').slice(0, 500) }
      })
    } catch {
      answers = null
    }
    try {
      if (answers) {
        await call('userInput/answer', { commandId: uuidv7(), sessionId: session(), userInputId: params.userInputId, answers }, { timeoutMs: 30_000 })
      } else {
        await call('userInput/cancel', { commandId: uuidv7(), sessionId: session(), userInputId: params.userInputId, reason: 'turn cancelled' }, { timeoutMs: 30_000 })
      }
    } catch (error) {
      host.log(`${LABEL}: userInput/${answers ? 'answer' : 'cancel'} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      pendingUserInputs.delete(params.userInputId)
    }
  }

  function registerServerRequests(): void {
    serve('approval/request', (params) => { void handleApproval(params) })
    serve('userInput/request', (params) => { void handleUserInput(params) })
  }

  // ── Process lifecycle ───────────────────────────────────────────────

  async function launch(): Promise<void> {
    const process = await host.spawn('muse', ['serve'])
    child = process
    const link = new StdioRpc(process, { label: LABEL, onStderr: (text) => { if (text.trim()) host.log(`${LABEL} stderr: ${text.trimEnd()}`) } })
    rpc = link
    link.on('malformed', (frame: string) => logOnce('malformed', `${LABEL} sent a frame that is not JSON-RPC (dropped): ${frame}`))
    link.on('unhandled-notification', (method: string) => logOnce(`unhandled:${method}`, `${LABEL}: no handler for ${method} notifications`))
    link.on('unknown-method', (method: string) => logOnce(`unknown:${method}`, `${LABEL} asked for ${method}; answered with -32601`))
    link.on('orphan-response', (id: unknown) => logOnce(`orphan:${String(id)}`, `${LABEL} answered request ${String(id)} nobody was waiting for`))
    link.on('handler-error', (error: unknown) => host.log(`${LABEL} handler failed: ${error instanceof Error ? error.message : String(error)}`))
    // The link fails when Muse exits, closes stdout or breaks framing; the
    // rpc layer terminates the process, this settles the turn. Stdout EOF
    // usually lands before `exit`, so the exit code is awaited briefly to
    // report "Muse exited (2): …" rather than "closed its stdout".
    link.on('close', (error: Error) => {
      const turn = active
      if (!turn) return
      if (closing) { finish(turn, { stopReason: 'cancelled', terminate: true }); return }
      void exitMessage(process, link, error).then((message) => finish(turn, { stopReason: 'error', error: message, terminate: true }))
    })
    process.once('exit', (code, signal) => {
      for (const listener of exitListeners) {
        try { listener(code, signal) } catch (error) { host.log(`${LABEL} exit listener failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    })
    registerNotifications()
    registerServerRequests()
  }

  async function validateModel(wanted: string): Promise<string> {
    const catalog = await call('model/list', {}, { timeoutMs: 30_000 })
    const match = catalog.models.find((model) => model.modelId === wanted)
    if (match) return match.modelId
    throw new AdapterError(AGENT, `${LABEL} does not offer model "${wanted}" (available: ${catalog.models.map((model) => model.modelId).join(', ') || 'none'})`, 'start_failed')
  }

  function chooseEffort(wanted: string): ReasoningEffort {
    if ((EFFORTS as readonly string[]).includes(wanted)) return wanted as ReasoningEffort
    throw new AdapterError(AGENT, `${LABEL} does not support reasoning effort "${wanted}"`, 'unsupported')
  }

  function insideCheckout(relativePath: string): string | null {
    const absolute = resolve(host.checkout, relativePath)
    return absolute === host.checkout || absolute.startsWith(host.checkout + sep) ? absolute : null
  }

  /** MSP input parts are text, image or skill; mentions and binary
   *  attachments become paths in the text so the model can read them. */
  function turnInput(input: PromptInput): TurnInputPart[] {
    let text = input.text
    const references: string[] = []
    for (const attachment of input.attachments) {
      if (attachment.text !== undefined) {
        text += `\n\n${attachment.name} (${attachment.path}):\n\`\`\`\n${attachment.text}\n\`\`\``
        continue
      }
      const path = insideCheckout(attachment.path)
      if (path) references.push(path)
      else host.log(`${LABEL}: dropping attachment outside the checkout: ${attachment.path}`)
    }
    for (const mention of input.mentions) {
      const path = insideCheckout(mention.path)
      if (path) references.push(path)
      else host.log(`${LABEL}: dropping mention outside the checkout: ${mention.path}`)
    }
    if (references.length) text += `\n\nReferenced files:\n${references.map((path) => `- ${path}`).join('\n')}`
    return [{ type: 'text', text }]
  }

  async function interrupt(turn: ActiveTurn): Promise<void> {
    if (!sessionId || turn.done) return
    const targets = [...new Set([...turn.steers, ...turn.nativeIds, ...(turn.nativeId ? [turn.nativeId] : [])])]
      .filter(id => !turn.endedNativeIds.has(id))
    await Promise.all(targets.map(nativeId => {
      const reclaim = turn.steers.has(nativeId) || (turn.queued && nativeId === turn.nativeId)
      const key = `${reclaim ? 'unqueue' : 'interrupt'}:${nativeId}`
      const existing = turn.cancellationRequests.get(key)
      if (existing) return existing
      const task = Promise.resolve().then(async () => {
        if (turn.done || turn.endedNativeIds.has(nativeId)) return
        if (reclaim) {
          try {
            const receipt = await call('turn/unqueue', { commandId: uuidv7(), sessionId: sessionId!, turnId: nativeId }, { timeoutMs: 2_000 })
            // MSP documents accepted unqueue admission as winning the race:
            // that exact queued turn cannot launch, even if its view event
            // arrives after this response.
            if (receipt.status !== 'accepted' || receipt.turnId !== nativeId) throw new Error('queue reclaim was not confirmed')
            turn.steers.delete(nativeId)
            turn.endedNativeIds.add(nativeId)
            if (!turn.nativeIds.includes(nativeId)) turn.nativeIds.push(nativeId)
            finishIfQuiescent(turn)
            return
          } catch (error) {
            if (!turn.done && !turn.endedNativeIds.has(nativeId)) host.log(`${LABEL}: reclaim did not confirm ${nativeId}; interrupting the exact turn (${error instanceof Error ? error.message : String(error)})`)
          }
        }
        if (turn.done || turn.endedNativeIds.has(nativeId)) return
        try {
          await call('turn/interrupt', { commandId: uuidv7(), sessionId: sessionId!, turnId: nativeId }, { timeoutMs: 2_000 })
        } catch (error) {
          if (!turn.done && !turn.endedNativeIds.has(nativeId)) host.log(`${LABEL}: turn/interrupt failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }).finally(() => turn.cancellationRequests.delete(key))
      turn.cancellationRequests.set(key, task)
      return task
    }))
  }

  const adapter: Adapter = {
    agent: AGENT,
    capabilities: CAPABILITIES,

    get nativeSessionId() { return sessionId },
    get alive() { return !!child && child.exitCode === null && child.signalCode === null },

    onExit(listener) { exitListeners.push(listener) },

    async start(options: AdapterStartOptions): Promise<AdapterStartResult> {
      if (child) throw new AdapterError(AGENT, `${LABEL} adapter already started`, 'protocol')
      try {
        await launch()
      } catch (error) {
        throw new AdapterError(AGENT, `${LABEL} could not be launched: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      try {
        await call('initialize', {
          clientInfo: { name: 'poise', title: 'Poise', version: pkg.version },
          capabilities: { userInputDialogs: true },
        }, { timeoutMs: 30_000 })
        link().notify(INITIALIZED)
        modelId = await validateModel(options.modelId)
        effort = chooseEffort(options.effort)

        let id: string
        if (options.resume) {
          // session/resume subscribes this connection to the session view.
          const response = await call('session/resume', { commandId: uuidv7(), sessionId: options.resume, excludeItems: true }, { timeoutMs: 60_000 })
          id = response.session.sessionId
          sessionId = id
          if (response.session.modelId !== modelId) {
            await call('session/setModel', { commandId: uuidv7(), sessionId: id, model: { modelId } }, { timeoutMs: 30_000 })
          }
        } else if (options.forkFrom) {
          const response = await call('session/fork', { commandId: uuidv7(), sessionId: options.forkFrom, excludeItems: true }, { timeoutMs: 60_000 })
          id = response.session.sessionId
          sessionId = id
          // The schema documents auto-subscription for resume only; subscribing
          // is idempotent, so a fork is attached explicitly.
          await call('view/subscribe', { sessionId: id }, { timeoutMs: 30_000 })
          if (response.session.modelId !== modelId) {
            await call('session/setModel', { commandId: uuidv7(), sessionId: id, model: { modelId } }, { timeoutMs: 30_000 })
          }
        } else {
          const response = await call('session/start', {
            commandId: uuidv7(),
            workspaceRoot: host.checkout,
            approvalMode: 'onRequest',
            modelId,
          }, { timeoutMs: 60_000 })
          id = response.session.sessionId
          sessionId = id
        }
        await call('session/setReasoningEffort', { commandId: uuidv7(), sessionId: id, reasoningEffort: effort as ReasoningEffort }, { timeoutMs: 30_000 })
      } catch (error) {
        if (error instanceof AdapterError) throw error
        throw new AdapterError(AGENT, `${LABEL} failed to start: ${error instanceof Error ? error.message : String(error)}`, 'start_failed')
      }
      return { nativeSessionId: sessionId!, capabilities: CAPABILITIES, modelId, effort, efforts: [...EFFORTS] }
    },

    async prompt(turnId, input, signal): Promise<TurnResult> {
      const id = session()
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
        internalItems: new Set(),
        pending: new Set(),
        finishing: false,
        steers: new Set(),
        nativeIds: [],
        endedNativeIds: new Set(),
        cancellationRequests: new Map(),
        queued: false,
        resolve: () => {},
      }
      const result = new Promise<TurnResult>((resolveTurn) => { turn.resolve = resolveTurn })
      active = turn
      const onAbort = () => { void adapter.cancel() }
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        const response = await call('turn/start', {
          commandId: uuidv7(),
          sessionId: id,
          input: turnInput(input),
          reasoningEffort: effort as ReasoningEffort,
        }, { timeoutMs: 60_000 })
        if (turn.nativeId === null && response.turnId !== lastFinishedNativeId) {
          turn.nativeId = response.turnId
          if (!turn.nativeIds.includes(response.turnId)) turn.nativeIds.push(response.turnId)
        }
        if (response.disposition === 'queued') { turn.queued = true; host.log(`${LABEL} queued the turn behind another one`) }
        if (turn.interruptRequested) void interrupt(turn)
      } catch (error) {
        finish(turn, { stopReason: 'error', error: `${LABEL} could not start the turn: ${error instanceof Error ? error.message : String(error)}` })
      }

      return result.finally(() => signal.removeEventListener('abort', onAbort))
    },

    async steer(text) {
      const turn = active
      if (!turn || turn.done || turn.interruptRequested || !turn.nativeId) throw new AdapterError(AGENT, `${LABEL} has no running turn to steer`, 'protocol')
      const commandId = uuidv7()
      turn.steers.add(commandId)
      try {
        await call('turn/steer', {
          commandId,
          sessionId: session(),
          expectedTurnId: turn.nativeId,
          input: [{ type: 'text', text }],
        }, { timeoutMs: 30_000 })
      } catch (error) {
        turn.steers.delete(commandId)
        finishIfQuiescent(turn)
        throw error
      }
    },

    async cancel() {
      const turn = active
      if (!turn || turn.done) return
      turn.interruptRequested = true
      await interrupt(turn)
    },

    async setModel(nextModelId, nextEffort) {
      const id = session()
      const chosen = chooseEffort(nextEffort)
      const validated = await validateModel(nextModelId)
      if (validated !== modelId) {
        await call('session/setModel', { commandId: uuidv7(), sessionId: id, model: { modelId: validated } }, { timeoutMs: 30_000 })
        modelId = validated
      }
      if (chosen !== effort) {
        await call('session/setReasoningEffort', { commandId: uuidv7(), sessionId: id, reasoningEffort: chosen }, { timeoutMs: 30_000 })
        effort = chosen
      }
      return { modelId, effort, efforts: [...EFFORTS] }
    },

    async setMode() {
      throw new AdapterError(AGENT, `${LABEL} has no modes`, 'unsupported')
    },

    async fork() {
      const response = await call('session/fork', { commandId: uuidv7(), sessionId: session(), excludeItems: true }, { timeoutMs: 60_000 })
      return response.session.sessionId
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
