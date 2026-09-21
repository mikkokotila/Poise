// The Chat v1 session runtime: the session table, one native agent process
// per session, the checkout it runs in, and the transcript mirror.
//
// The runtime owns everything the adapters do not: which branch a session is
// bound to and how the shared checkout follows the active session, the
// per-checkout lease that serializes turns with the other Poise server and
// with Caller's fix-failing-ci, the worker gates every writer runs under,
// the session-scoped permission memory, the Caller row that makes a turn
// visible in Swarm, the staged Editor document, and crash reconciliation on
// startup. Every event a browser sees goes through `emit_()`, which appends
// to SQLite first and broadcasts second — a reload renders from the mirror
// alone, and a transcript that cannot be recorded stops the turn.
//
// Lifecycle rules that matter:
// - a turn is reserved synchronously in `prompt()` before anything is
//   awaited, so two prompts in one tick cannot both be accepted;
// - the checkout lease is held from before the first git mutation until the
//   agent reported the turn finished, every Poise-served file operation
//   returned, and — when the agent misbehaved — its process group is
//   verifiably gone; an orphan keeps the lease and is reported;
// - close/delete cancel and stop outside the per-session operation chain,
//   so they are never queued behind a whole coding turn.

import { readMemories } from './memories'
import { appendMemories } from './memory-content'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { enqueueMessage, transferQueuedContext, readQueue, updateQueuedModel, removeQueuedMessage, pauseQueue, QueueError, queueOwner, delegateQueue } from './message-queue'
import type { MessageQueue, QueuedMessage } from './protocol'
import { autoMergeInstructions, withAutoMergeInstructions } from './auto-merge'
import { steeringContext } from './steering-context'
import { parseChatCommandChain, commandBody } from './commands'
import { latestReviewTarget, prepareReview, type ReviewTarget } from './review'
import type { AutoMergeAck, SafeModeAck } from './protocol'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { loadCatalog, catalogModel, type Catalog, type CatalogModel } from '../models'
import { claudeAuth } from '../claude-auth'
import { HttpError } from '../http'
import { localCheckoutPath } from '../gh'
import { ensureLocalWorkspace, LOCAL_CHAT_ROOT } from './local-workspace'
import { catalogueAgents } from './catalog-agents'
import { runFile } from '../process'
import { CheckoutLease, canonicalCheckout, describeHolder, type AcquireResult, type CheckoutLeaseOptions } from './checkout-lock'
import { ATTACHMENT_DIR, attachmentPath, ensureExcluded, inlineText, safeAttachmentName, sha256Of } from './attachments'
import { readCheckoutBytes, readCheckoutTextFile, writeCheckoutTextFile } from './client-fs'
import { captureCheckoutSnapshot, emitCheckoutChanges, type CheckoutSnapshot } from './change-mirror'
import { CallerCompatError, callerTurns as defaultCallerTurns, type CallerTurns } from './caller-turns'
import { forkStagedDocument, isBridgeProblem, refreshDocument, stageDocument, stagedDocumentPrompt, unstageDocument, writeBackDocument, type StagedDocument } from './editor-bridge'
import {
  GitError, PathError, assertBranchName, branchExists, branchTip, checkoutPrHead, checkpoint, createBranch, deleteBranch,
  inspectCheckout, resolveInsideCheckout, revertDiff, switchBranch, type RecordedDiff,
} from './git'
import {
  AGENT_IDS, CHAT_LIMITS, type AgentId, type Attachment, type BranchRequest, type ChatEnvelope, type ChatEvent, type NewSessionRequest,
  type PermissionOption, type PromptInput, type Question, type SessionContext, type SessionRecord, type SessionStatus, type StopReason, type WorkspaceState,
} from './protocol'
import * as storage from './storage'
import { pgidAlive, pidAlive, signalGroup, spawnWorker, workerIdentityMatches, type WorkerHandle } from './worker'
import { createClaudeAdapter } from './adapters/claude'
import { createCodexAdapter } from './adapters/codex'
import { createGrokAdapter } from './adapters/grok'
import { createMuseAdapter } from './adapters/muse'
import type { Adapter, AdapterHost, PermissionRequest, QuestionAnswers, QuestionRequest } from './adapters/types'
import { SELF_UPDATE_REPOSITORY, SelfUpdateBridgeError, SelfUpdateUnavailableError, UUID_PATTERN, type SelfUpdateBridge } from '../self-update-bridge'
import * as finishOutbox from '../self-update-outbox'
import { poiseChangePrompt, poiseChangeTitle } from '../self-update-runbook'
import type { SelfChange } from '../../src/self-update-types'

export type AdapterFactory = (host: AdapterHost) => Adapter

export const DEFAULT_ADAPTERS: Record<AgentId, AdapterFactory> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  grok: createGrokAdapter,
  muse: createMuseAdapter,
}

/** Which agent a catalog provider maps to. Antigravity is not in Chat v1. */
const PROVIDER_AGENT: Record<string, AgentId> = { claude: 'claude', codex: 'codex', grok: 'grok', muse: 'muse' }
const AGENT_COMMAND: Record<AgentId, string> = { claude: 'claude', codex: 'codex', grok: 'grok', muse: 'muse' }
const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', muse: 'Muse' }

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 120
export const DEFAULT_BRANCH_PREFIX = 'chat/'
const STOP_SETTLE_MS = 2_000
const CLOSE_GRACE_MS = 5_000
const SERVICE_SETTLE_MS = 5_000
/** How long an upload waits for a busy checkout before it is refused. */
const ATTACHMENT_LEASE_WAIT_MS = 15_000
const TITLE_CHARS = 60
const AVAILABILITY_TTL_MS = 60_000

export class ChatError extends HttpError {
  constructor(statusCode: number, message: string, readonly code: string) {
    super(statusCode, message)
    this.name = 'ChatError'
  }
}

interface PendingRequest {
  kind: 'permission' | 'question'
  turnId: string
  options?: PermissionOption[]
  questions?: Question[]
  grantKey?: string
  resolve: (value: any) => void
  reject: (error: Error) => void
}

interface RunningTurn {
  id: string
  callId: string | null
  startedAt: number
  abort: AbortController
  stopping: boolean
  /** Set when the turn must end as an error (mirror failure, lost lease, forced stop). */
  failure?: string
  /** The one implementing turn of a `/poise` change: its settlement is the
   *  change's outcome; later discussion turns in the session are not. */
  implementsChange?: boolean
  /** What the transcript shows as the prompt when the agent got more (a
   *  server-injected runbook around the person's request). */
  shown?: PromptInput
  /** True only once the native prompt was invoked, not while queued/startup. */
  agentInvoked?: boolean
  /** Settles at native prompt invocation, cancellation, or failed startup. */
  promptReady: Promise<void>
  releasePrompt(): void
  queueItem?: QueuedMessage
  queueContext?: string
  commandModel?: string
  review?: { target: ReviewTarget, throughSeq: number }
}

interface LiveSession {
  record: SessionRecord
  adapter: Adapter | null
  /** Cancellation of native startup is independent of a running turn. */
  startup: AbortController | null
  nativeSafeMode?: boolean
  worker: WorkerHandle | null
  lease: CheckoutLease | null
  turn: RunningTurn | null
  pending: Map<string, PendingRequest>
  grants: Map<string, Pick<PermissionOption, 'id' | 'kind'>>
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Aborted by close/delete/stop: wakes lease waits and startup. */
  lifecycle: AbortController
  /** Poise-served file operations still running for the agent. */
  services: number
  /** Set while a turn waits for its services to return; no new one may join. */
  draining: boolean
  staged: StagedDocument | null
  /** Serializes lifecycle operations on one session. */
  chain: Promise<unknown>
  /** Mode updates and steering serialize separately from the running turn. */
  steering: Promise<unknown>
  /** Operations queued on or running in `chain`; part of the busy count. */
  pendingOps: number
}

export interface RuntimeOptions {
  /** `poise-dev:<db>` or `poise-prod:<db>`; sessions of another instance are never adopted. */
  instance: string
  instanceLabel: string
  adapters?: Partial<Record<AgentId, AdapterFactory>>
  callerTurns?: CallerTurns | null
  catalog?: () => Promise<Catalog>
  resolveCheckout?: (repo: string) => Promise<string>
  localWorkspaceRoot?: string
  idleTimeoutMinutes?: () => number
  branchPrefix?: () => string
  requireClaudeReady?: () => Promise<void>
  /** Whether an agent's CLI is launchable; replaced in tests. */
  probeAgent?: (agent: AgentId) => Promise<{ ok: boolean, reason?: string }>
  /** Lease liveness probes; tests use them to make this host look dead. */
  leaseProbes?: CheckoutLeaseOptions
  /** The self-update controller client. Absent or unconfigured: `/poise`
   *  answers with an actionable error and no controller IO ever happens. */
  selfUpdate?: SelfUpdateBridge | null
}

/** What the release controller sees before restarting this server. */
export interface DrainState { releaseId: string, since: string }

export interface PoiseChangeResult { session: SessionRecord, change: SelfChange }

const ACTIVE_STATUSES: readonly SessionStatus[] = ['starting', 'queued', 'running', 'waiting', 'stopping']

export interface AgentAvailability {
  id: string
  label: string
  available: boolean
  reason?: string
  models: CatalogModel[]
  efforts: string[]
}

export class ChatRuntime extends EventEmitter {
  readonly instance: string
  private readonly live = new Map<string, LiveSession>()
  private readonly adapters: Record<AgentId, AdapterFactory>
  private readonly caller: CallerTurns | null
  private readonly catalog: () => Promise<Catalog>
  private readonly resolveCheckout: (repo: string) => Promise<string>
  private readonly idleTimeoutMinutes: () => number
  private readonly branchPrefix: () => string
  private readonly requireClaudeReady: () => Promise<void>
  private readonly probeAgent: (agent: AgentId) => Promise<{ ok: boolean, reason?: string }>
  private readonly leaseProbes: CheckoutLeaseOptions
  private readonly hostPid: number
  private readonly availability = new Map<AgentId, { at: number, result: { ok: boolean, reason?: string } }>()
  private readonly selfUpdate: SelfUpdateBridge | null
  private readonly changeStarts = new Map<string, { sourceId: string, request: string, contextKey: string, promise: Promise<PoiseChangeResult> }>()
  private readonly queuePumps = new Set<string>()
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queueReleaseWait = new Set<string>()
  private stopped = false
  private drainState: DrainState | null = null
  /** Public operations in flight that are not (yet) a turn or a chain entry. */
  private inflightOps = 0
  private recovering = false

  constructor(private readonly options: RuntimeOptions) {
    super()
    this.instance = options.instance
    this.selfUpdate = options.selfUpdate ?? null
    this.adapters = { ...DEFAULT_ADAPTERS, ...(options.adapters ?? {}) } as Record<AgentId, AdapterFactory>
    this.caller = options.callerTurns === undefined ? defaultCallerTurns : options.callerTurns
    this.catalog = options.catalog ?? (() => loadCatalog())
    this.resolveCheckout = options.resolveCheckout ?? (async (repo) => {
      const [owner, name] = repo.split('/', 2)
      return localCheckoutPath(owner, name)
    })
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? (() => DEFAULT_IDLE_TIMEOUT_MINUTES)
    this.branchPrefix = options.branchPrefix ?? (() => DEFAULT_BRANCH_PREFIX)
    this.requireClaudeReady = options.requireClaudeReady ?? (() => claudeAuth.requireReady())
    this.probeAgent = options.probeAgent ?? defaultProbeAgent
    this.leaseProbes = options.leaseProbes ?? {}
    this.hostPid = this.leaseProbes.hostPid ?? process.pid
  }

  // ── Startup and shutdown ───────────────────────────────────────────────

  /** Crash reconciliation. Leftover workers this instance recorded are
   *  terminated only after their identity is verified and never while the
   *  lease they hold belongs to a live process (another server with the
   *  same instance name). Turns that were open are marked interrupted and
   *  their prompts cancelled; nothing is replayed. */
  async recover(): Promise<void> {
    this.recovering = true
    try {
      await this.recoverState()
    } finally {
      this.recovering = false
    }
    for (const record of storage.listSessions(this.instance)) this.scheduleQueue(this.requireLive(record.id))
  }

  private async recoverState(): Promise<void> {
    // Sessions whose lease another live server of this instance holds are
    // that server's: their workers, turns and Caller rows are left alone.
    const protectedSessions = new Set<string>()
    for (const worker of storage.listWorkers()) {
      if (storage.sessionInstance(worker.sessionId) !== this.instance) continue
      const record = storage.getSession(worker.sessionId)
      let holderAlive = false
      if (worker.leaseToken) {
        try {
          const row = new CheckoutLease(worker.checkout, { ownerKind: 'poise:chat', ownerId: worker.sessionId, ownerLabel: '', instance: this.instance }, this.leaseProbes).read()
          holderAlive = !!row && row.token === worker.leaseToken && row.host_pid !== this.hostPid && (this.leaseProbes.pidAlive ?? pidAlive)(row.host_pid)
        } catch { holderAlive = true } // the lock file is unreadable: do not touch anything
      }
      if (holderAlive) { protectedSessions.add(worker.sessionId); continue }
      const verified = await workerIdentityMatches(worker.gatePid, worker.ident)
      const groupAlive = pgidAlive(worker.gatePgid)
      if (!verified && groupAlive) {
        if (record) {
          record.orphanNotice = `a worker recorded for this session (pid ${worker.gatePid}) is still running but could not be verified; stop it by hand`
          storage.saveSession(record)
        }
        continue
      }
      if (verified) {
        signalGroup(worker.gatePgid, 'SIGTERM')
        if (!(await waitDead(worker.gatePgid, CLOSE_GRACE_MS))) {
          signalGroup(worker.gatePgid, 'SIGKILL')
          if (!(await waitDead(worker.gatePgid, CLOSE_GRACE_MS))) {
            if (record) {
              record.orphanNotice = `the worker group ${worker.gatePgid} of this session survived termination; stop it by hand`
              storage.saveSession(record)
            }
            continue
          }
        }
      }
      if (worker.leaseToken) { try { CheckoutLease.releaseByToken(worker.checkout, worker.leaseToken) } catch { /* the lock file may be gone */ } }
      storage.forgetWorker(worker.sessionId)
    }
    for (const open of storage.listOpenTurns(this.instance)) {
      if (protectedSessions.has(open.sessionId)) continue
      const record = storage.getSession(open.sessionId)
      if (!record) continue
      for (const pending of storage.listPendingRequests(open.sessionId)) {
        this.emit_(open.sessionId, pending.kind === 'permission'
          ? { type: 'permission.resolved', id: pending.requestId, optionId: '', by: 'cancelled' }
          : { type: 'question.answered', id: pending.requestId, answers: {}, by: 'cancelled' })
      }
      const envelope = storage.finalizeTurn(open.sessionId,
        { type: 'turn.finished', turnId: open.turnId, stopReason: 'interrupted', error: 'Poise restarted while this turn was running' },
        open.callId ? { callId: open.callId, instance: this.instance } : undefined)
      const terminal = envelope.event as Extract<ChatEvent, { type: 'turn.finished' }>
      // Older builds could leave open flags after recording a terminal event.
      // Honor that event instead of overwriting it with an interruption.
      const interrupted = terminal.stopReason === 'interrupted'
      if (interrupted) record.interruptedTurnId = open.turnId
      record.status = interrupted || terminal.stopReason === 'error' ? 'interrupted' : 'idle'
      record.lastSeq = envelope.seq
      storage.saveSession(record)
      this.emit('event', envelope)
      this.emit_(open.sessionId, { type: 'status.changed', status: record.status,
        detail: interrupted ? 'Poise restarted while this turn was running' : 'previous turn outcome recovered' })
    }
    if (this.caller) {
      for (const row of storage.listFinishOutbox(this.instance)) {
        if (protectedSessions.has(row.sessionId)) continue
        try {
          await this.caller.finish(row.callId, row.status, row.error ?? undefined)
          storage.finishDelivered(row.callId)
        } catch (error) {
          this.emit('log', `[chat] Caller finish for ${row.callId.slice(0, 8)} still undelivered: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    for (const record of storage.listSessions(this.instance)) {
      if (protectedSessions.has(record.id)) continue
      if (['running', 'waiting', 'stopping', 'queued', 'starting'].includes(record.status)) {
        record.status = record.nativeSessionId ? 'interrupted' : 'idle'
        storage.saveSession(record)
      }
      // A change session whose outcome was never recorded ended with the
      // crash: the workers above are gone, nothing is replayed, and the
      // controller must hear "failed" rather than wait forever. A turn that
      // did finish before the outbox row was written keeps its own outcome.
      if (record.selfChangeId && !finishOutbox.getFinish(record.selfChangeId)) {
        const terminal = implementingTurnOutcome(record.id).finished
        finishOutbox.queueFinish({
          changeId: record.selfChangeId, instance: this.instance, sessionId: record.id,
          outcome: terminal?.stopReason === 'end_turn' && !record.orphanNotice ? 'completed' : 'failed',
          error: terminal ? (terminal.stopReason === 'end_turn' ? record.orphanNotice ?? null : terminal.error || `the change turn ended with ${terminal.stopReason}`)
            : 'Poise restarted before the change turn settled',
        })
      }
    }
    await this.flushSelfUpdateOutbox()
  }

  /** Deliver every recorded change outcome the controller has not
   *  acknowledged. Safe to call at any time: rows are immutable and a
   *  delivery that fails stays queued. */
  async flushSelfUpdateOutbox(): Promise<void> {
    if (!this.selfUpdate?.configured) return
    for (const row of finishOutbox.listUndelivered(this.instance)) {
      try {
        await this.selfUpdate.finish(row.changeId, { outcome: row.outcome, ...(row.error ? { error: row.error } : {}) })
        finishOutbox.markDelivered(row.changeId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finishOutbox.markAttempt(row.changeId, message)
        this.emit('log', `[chat] self-update finish for change ${row.changeId.slice(0, 8)} still undelivered: ${message}`)
        // A refusal (unknown or already settled change) does not block the
        // rows behind it; an unreachable controller ends the pass.
        if (error instanceof SelfUpdateUnavailableError) return
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    await Promise.all([...this.live.values()].map(async (session) => {
      session.lifecycle.abort()
      await this.forceStop(session, 'server stopping')
      await this.serialized(session, () => this.shutdownSession(session)).catch(() => undefined)
    }))
  }

  /** Outside the operation chain: cancel a turn and, if the agent does not
   *  settle, terminate its process. Resolves once the turn's own cleanup
   *  can run (or the process is gone). */
  private async forceStop(session: LiveSession, reason: string): Promise<void> {
    const turn = session.turn
    if (!turn) return
    turn.stopping = true
    turn.failure ??= reason
    this.settlePending(session, 'cancelled')
    turn.abort.abort()
    try { await session.adapter?.cancel() } catch { /* terminating below */ }
    if (await this.waitForTurnEnd(session, STOP_SETTLE_MS)) return
    // The agent did not acknowledge: the process goes, verifiably, and the
    // turn's finally block then runs with the adapter's rejection.
    await this.stopProcess(session).catch(() => undefined)
    await this.waitForTurnEnd(session, CLOSE_GRACE_MS * 2)
  }

  private async shutdownSession(session: LiveSession): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.turn) return // still running after forceStop: leave it, the lease stays
    await this.stopProcess(session)
    this.releaseSettledLease(session)
    if (session.record.status !== 'closed' && session.record.status !== 'error') this.setStatus(session, 'idle')
  }

  /** A failed worker stop deliberately retains the lease. Once a later close
   * or resume verifies termination, release that same token, not a new lease. */
  private releaseSettledLease(session: LiveSession): void {
    const lease = session.lease
    if (!lease?.held) return
    if (session.startup || session.services || session.turn?.agentInvoked || session.worker?.alive || session.adapter?.alive) {
      throw new ChatError(409, 'the checkout still has active work; its lease remains held', 'checkout_busy')
    }
    lease.clearWorker()
    lease.release()
    session.lease = null
    session.record.orphanNotice = undefined
    this.saveRecord(session)
  }

  // ── Drain and readiness ────────────────────────────────────────────────
  //
  // The release controller drains this server before restarting it: from
  // that moment no new turn, session, upload or model change is accepted,
  // while everything already running finishes on its own. Cancel, close,
  // answering the agent's requests and reads stay available, so a person is
  // never locked out of ending a turn that is in the way.

  get draining(): DrainState | null {
    return this.drainState
  }

  /** Refuse new work from now on. Synchronous: no request that arrives
   *  after this returns can start a turn. Idle agent processes are then
   *  closed in each session's own lifecycle queue (their native ids stay,
   *  so they resume on the next prompt after the restart); a turn that is
   *  running finishes on its own and closes its process afterwards.
   *  Calling it again only updates the release it is for. */
  startDrain(releaseId: string): DrainState {
    if (!this.drainState || this.drainState.releaseId !== releaseId) this.drainState = { releaseId, since: new Date().toISOString() }
    for (const session of this.live.values()) {
      if (session.turn || !(session.adapter?.alive || session.worker?.alive)) continue
      void this.serialized(session, () => this.closeForDrain(session)).catch(() => undefined)
    }
    return this.drainState
  }

  endDrain(): void {
    this.drainState = null
    for (const session of this.live.values()) this.scheduleQueue(session)
  }

  /** Inside the session's chain: close an idle agent process for the
   *  restart. Verifiable — a process that will not go stays counted. */
  private async closeForDrain(session: LiveSession): Promise<void> {
    if (!this.drainState || session.turn || session.record.status === 'closed') return
    if (!(session.adapter?.alive || session.worker?.alive)) return
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    await this.stopProcess(session)
    this.emit_(session.record.id, { type: 'status.changed', status: session.record.status, detail: 'agent process closed for the Poise update; it resumes on the next prompt' })
  }

  /** Work that a restart would cut: turns, startups, the agent's Poise-served
   *  file operations, queued lifecycle operations, live agent processes,
   *  recovery and any public operation still between its call and its
   *  acknowledgement. Zero means quiescent; anything the runtime is unsure
   *  about counts. */
  busy(): number {
    let count = this.inflightOps + (this.recovering ? 1 : 0)
    for (const session of this.live.values()) {
      const own = (session.turn ? 1 : 0) + session.services + session.pendingOps
      count += own > 0 ? own : ACTIVE_STATUSES.includes(session.record.status) || session.adapter?.alive || session.worker?.alive ? 1 : 0
    }
    return count
  }

  private assertAcceptingWork(): void {
    if (this.drainState) throw new ChatError(503, 'Poise is installing an update; new work is refused until it restarts', 'draining')
  }

  /** Count a public operation from its call to its settlement. */
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.inflightOps += 1
    try {
      return await operation()
    } finally {
      this.inflightOps -= 1
    }
  }

  // ── Catalog and agents ─────────────────────────────────────────────────

  async agents(): Promise<{ agents: AgentAvailability[], catalog: Catalog }> {
    const catalog = await this.catalog()
    const agents = await catalogueAgents(catalog, claudeAuth.snapshot().status === 'authenticated', (id) => this.availabilityOf(id))
    return { agents, catalog }
  }

  private async availabilityOf(agent: AgentId): Promise<{ ok: boolean, reason?: string }> {
    const cached = this.availability.get(agent)
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.result
    const result = await this.probeAgent(agent).catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    this.availability.set(agent, { at: Date.now(), result })
    return result
  }

  /** The local checkout a repository's sessions run in. */
  checkoutFor(repo: string): Promise<string> {
    return this.resolveCheckout(repo)
  }

  private async resolveModel(identity: string, effortOverride?: string, efforts?: string[]): Promise<{ agent: AgentId, model: CatalogModel, effort: string }> {
    const catalog = await this.catalog()
    const model = catalogModel(catalog, identity)
    if (!model) throw new ChatError(400, `unknown model ${identity}`, 'invalid')
    const agent = PROVIDER_AGENT[model.provider]
    if (!agent) throw new ChatError(400, `${identity} runs on ${model.provider}, which is not in Chat v1`, 'unsupported')
    const effort = effortOverride || model.effort
    const variants = catalog.models.filter(m => m.provider === model.provider && m.selector === model.selector)
    const selected = variants.find(m => m.effort === effort)
    if (!selected || (efforts?.length && !efforts.includes(effort))) {
      throw new ChatError(400, `${model.selector} offers catalogue efforts ${variants.map(m => m.effort).join(', ')}`, 'invalid')
    }
    return { agent, model: selected, effort: selected.effort }
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  list(): SessionRecord[] {
    return storage.listSessions(this.instance).map((record) => this.withLive(record))
  }

  get(id: string): SessionRecord | null {
    const record = storage.getSession(id)
    if (!record) return null
    if (record.instance !== this.instance) throw new ChatError(409, `this session belongs to another Poise server (${record.instance})`, 'foreign_session')
    return this.withLive(record)
  }

  events(id: string, afterSeq: number): { events: ChatEnvelope[], truncated: boolean } {
    this.get(id)
    return storage.listEvents(id, afterSeq)
  }

  ownsSession(id: string): boolean {
    return storage.sessionInstance(id) === this.instance
  }

  private withLive(record: SessionRecord): SessionRecord {
    const live = this.live.get(record.id)
    if (live) { live.record.pendingRequests = [...live.pending.keys()]; record = live.record }
    const queue = this.messageQueue(record.id)
    return queue.revision ? { ...record, queue } : record
  }

  private requireLive(id: string): LiveSession {
    const record = this.get(id)
    if (!record) throw new ChatError(404, 'unknown session', 'unknown_session')
    let live = this.live.get(id)
    if (!live) {
      // The staged document rides on the record: the live object and the
      // persisted one are the same reference, so saving the record saves it.
      live = { record, adapter: null, startup: null, worker: null, lease: null, turn: null, pending: new Map(), grants: new Map(), idleTimer: null, lifecycle: new AbortController(), services: 0, draining: false, staged: record.staged ?? null, chain: Promise.resolve(), steering: Promise.resolve(), pendingOps: 0 }
      this.live.set(id, live)
    }
    return live
  }

  private serialized<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    session.pendingOps += 1
    const settle = <R>(value: R): R => { session.pendingOps -= 1; return value }
    const run = session.chain.then(operation, operation).then(settle, (error) => { settle(undefined); throw error })
    session.chain = run.catch(() => undefined)
    return run
  }

  async create(request: NewSessionRequest): Promise<SessionRecord> {
    this.assertAcceptingWork() // before any await: the drain flag is checked atomically
    return this.track(() => this.createSession(request))
  }

  private async createSession(request: NewSessionRequest): Promise<SessionRecord> {
    if (this.stopped) throw new ChatError(503, 'the chat runtime is stopping', 'agent_error')
    if (request.deferStart !== undefined && typeof request.deferStart !== 'boolean') throw new ChatError(400, 'deferStart must be a boolean', 'invalid')
    if (request.safeMode !== undefined && typeof request.safeMode !== 'boolean') throw new ChatError(400, 'safeMode must be a boolean', 'invalid')
    if (request.autoMerge !== undefined && typeof request.autoMerge !== 'boolean') throw new ChatError(400, 'autoMerge must be a boolean', 'invalid')
    if (!AGENT_IDS.includes(request.agent)) throw new ChatError(400, `unknown agent ${String(request.agent)}`, 'invalid')
    const { agent, model, effort } = await this.resolveModel(request.model, request.effort)
    if (agent !== request.agent) throw new ChatError(400, `${request.model} is a ${agent} model, not ${request.agent}`, 'invalid')
    const local = !request.repo
    const id = randomUUID()
    if (!local && !/^[^/\s]+\/[^/\s]+$/.test(request.repo!)) throw new ChatError(400, 'repo must be owner/name', 'invalid')
    const branch = normalizeBranchRequest(request.branch ?? { new: `chat/${id}` }, this.branchPrefix())
    if (agent === 'claude' && !request.deferStart) await this.requireClaudeReady()
    const checkout = local
      ? await ensureLocalWorkspace(this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT, this.instance)
      : canonicalCheckout(await this.resolveCheckout(request.repo!))
    const now = new Date().toISOString()
    const title = (request.title || request.context?.title || 'New session').slice(0, CHAT_LIMITS.titleChars)
    const record: SessionRecord = {
      id,
      agent,
      model: model.identity,
      modelId: model.selector,
      effort,
      repo: request.repo || '',
      checkout,
      ...(local ? { workspaceKind: 'poise-local' as const } : {}),
      branch: { name: branch.name, origin: branch.origin, pr: branch.pr, provisional: branch.origin === 'new' },
      title,
      createdAt: now,
      updatedAt: now,
      status: request.deferStart ? 'idle' : 'starting',
      capabilities: emptyCapabilities(),
      lastSeq: 0,
      pendingRequests: [],
      instance: this.instance,
      context: request.context,
      ...(request.autoMerge !== undefined ? { autoMerge: request.autoMerge } : {}),
      safeMode: request.safeMode === true,
    }
    storage.insertSession(record)
    const live = this.requireLive(record.id)
    this.emit_(record.id, { type: 'session.created', session: record })
    if (!request.deferStart) void this.serialized(live, () => this.startSession(live, { fresh: true })).catch(() => undefined)
    return live.record
  }

  /** Bring the native process up under the checkout lease: prepare the
   *  branch (fresh sessions), switch the checkout to it, register the gate,
   *  then create/resume/fork the native session. Failures become a readable
   *  error event and the `error` status; nothing is retried on its own. */
  private async startSession(session: LiveSession, options: { fresh?: boolean, forkFrom?: SessionRecord, lease?: CheckoutLease } = {}): Promise<void> {
    if (session.adapter?.alive) return
    if (!options.lease && session.lease?.held) {
      await this.stopProcess(session)
      this.releaseSettledLease(session)
    }
    const record = session.record
    const startup = new AbortController()
    session.startup = startup
    const signal = AbortSignal.any([session.lifecycle.signal, startup.signal, ...(session.turn ? [session.turn.abort.signal] : [])])
    this.setStatus(session, 'starting')
    const lease = options.lease ?? this.leaseFor(session)
    let freed = true
    try {
      if (!options.lease) await lease.acquire({ signal, onBusy: (busy) => this.reportBusy(session, busy) })
      else if (!lease.held) throw new Error('the checkout lease was lost before native startup')
      signal.throwIfAborted()
      session.lease = lease
      const fresh = options.fresh || (!record.nativeSessionId && record.branch.provisional && !record.branch.baseSha)
      if (fresh) await this.prepareBranch(session, lease)
      await this.prepareCheckout(session, lease)
      if ((fresh || options.forkFrom) && record.context?.kind === 'document' && record.context.slug) {
        session.staged = options.forkFrom
          ? await forkStagedDocument(record.checkout, record.id, record.context.slug, { sessionId: options.forkFrom.id, staged: options.forkFrom.staged })
          : await stageDocument(record.checkout, record.id, record.context.slug)
        record.staged = session.staged
        this.saveRecord(session)
      }
      signal.throwIfAborted()
      const host = this.hostFor(session)
      const adapter = this.adapters[record.agent](host)
      session.adapter = adapter
      adapter.onExit((code, signal) => this.onAdapterExit(session, adapter, code, signal))
      const startOptions = {
        modelId: record.modelId,
        effort: record.effort,
        safeMode: record.safeMode === true,
        ...(record.mode ? { mode: record.mode } : {}),
        ...(options.forkFrom
          ? (record.agent === 'claude' ? { forkFrom: options.forkFrom.nativeSessionId } : { resume: record.nativeSessionId })
          : record.nativeSessionId ? { resume: record.nativeSessionId } : {}),
      }
      const started = await adapter.start(startOptions)
      signal.throwIfAborted()
      session.nativeSafeMode = startOptions.safeMode
      record.safeModePending = session.nativeSafeMode !== (record.safeMode === true)
      record.nativeSessionId = started.nativeSessionId
      record.capabilities = started.capabilities
      record.modelId = started.modelId || record.modelId
      record.effort = started.effort || record.effort
      record.efforts = started.efforts
      record.mode = started.mode
      record.modes = started.modes
      record.commands = started.commands
      record.interruptedTurnId = undefined
      await this.refreshWorkspace(session)
      this.setStatus(session, 'idle')
      this.emit_(record.id, { type: 'session.resumed', session: record })
      this.armIdleTimer(session)
      // A start that was already under way when the drain began ends idle.
      if (this.drainState && !session.turn) await this.closeForDrain(session).catch(() => undefined) // an orphan stays counted
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted) {
        try { this.emit_(record.id, { type: 'error', message, recoverable: true }) } catch { /* mirror */ }
        this.setStatus(session, 'error', message)
      } else if (!session.turn) this.setStatus(session, 'idle')
      try { await this.stopProcess(session) } catch { freed = false }
      throw error
    } finally {
      // The idle agent holds no lease; the next turn takes one. Release only
      // when nothing of this start can still write (a stopped orphan keeps it).
      // A turn-owned lease remains registered and held through its own cleanup.
      if (!options.lease && lease.held) {
        if (freed) { lease.clearWorker(); lease.release() }
        else this.emit('log', `[chat ${record.id.slice(0, 8)}] checkout lease kept: worker not settled`)
      }
      if (session.lease === lease && !lease.held) session.lease = null
      if (session.startup === startup) session.startup = null
    }
  }

  async resume(id: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    await this.serialized(session, async () => {
      if (session.record.status === 'closed' || session.lifecycle.signal.aborted) { session.lifecycle = new AbortController(); session.record.status = 'idle' }
      if (!session.adapter?.alive) await this.startSession(session)
    })
    return session.record
  }

  async rename(id: string, title: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const next = String(title || '').trim().slice(0, CHAT_LIMITS.titleChars)
    if (!next) throw new ChatError(400, 'title is required', 'invalid')
    session.record.title = next
    this.saveRecord(session)
    this.emit_(id, { type: 'session.updated', session: session.record })
    return session.record
  }

  /** Allowed while draining: closing settles work rather than starting it. */
  close(id: string): Promise<SessionRecord> {
    return this.track(async () => {
      const session = this.requireLive(id)
      pauseQueue(queueOwner(id))
      this.publishQueue(session)
      session.lifecycle.abort()
      await this.forceStop(session, 'session closed')
      await this.serialized(session, async () => {
        await this.shutdownSession(session)
        if (session.turn) throw new ChatError(409, 'the agent could not be stopped; the session stays open', 'agent_error')
        this.setStatus(session, 'closed')
        this.emit_(id, { type: 'session.closed', reason: 'closed by user' })
      })
      return session.record
    })
  }

  async delete(id: string): Promise<void> {
    this.assertAcceptingWork()
    return this.track(() => this.deleteSession(id))
  }

  private async deleteSession(id: string): Promise<void> {
    const session = this.requireLive(id)
    session.lifecycle.abort()
    await this.forceStop(session, 'session deleted')
    await this.serialized(session, async () => {
      await this.shutdownSession(session)
      if (session.turn || session.worker?.alive) throw new ChatError(409, 'the agent could not be stopped; the session was not deleted', 'agent_error')
      const record = session.record
      if (session.staged) { await unstageDocument(record.checkout, record.id); session.staged = null; record.staged = undefined }
      await this.preserveBorrowedQueueContext(id)
      await this.removeAttachments(session)
      if (record.branch.origin === 'new' && record.branch.provisional && record.branch.baseSha) {
        // A branch Poise created whose tip never moved goes with the session.
        const lease = this.leaseFor(session)
        try {
          await lease.acquire({ onBusy: (busy) => this.reportBusy(session, busy) })
          if (await branchExists(record.checkout, record.branch.name) && (await branchTip(record.checkout, record.branch.name)) === record.branch.baseSha) {
            await deleteBranch(lease, record.checkout, record.branch.name)
          }
        } catch (error) {
          this.emit_(id, { type: 'error', message: `branch ${record.branch.name} was kept: ${error instanceof Error ? error.message : String(error)}`, recoverable: true })
        } finally {
          if (lease.held) lease.release()
        }
      }
      this.emit_(id, { type: 'session.closed', reason: 'deleted' })
      storage.deleteSession(id)
      this.live.delete(id)
      this.emit('deleted', id)
    })
  }

  async fork(id: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const source = this.requireLive(id)
    if (source.record.selfChangeId) throw new ChatError(409, 'a Poise change session cannot be forked; its checkout belongs to the release controller', 'unsupported')
    return this.serialized(source, async () => {
      if (!source.record.capabilities.fork) throw new ChatError(409, `${AGENT_LABEL[source.record.agent]} sessions cannot be forked`, 'unsupported')
      if (source.turn) throw new ChatError(409, 'a turn is running; fork after it finishes', 'turn_in_progress')
      if (!source.adapter?.alive) await this.startSession(source)
      const now = new Date().toISOString()
      const nativeId = source.record.agent === 'claude' ? source.record.nativeSessionId : await source.adapter!.fork()
      const record: SessionRecord = {
        ...structuredClone(source.record),
        id: randomUUID(),
        title: `${source.record.title} (fork)`.slice(0, CHAT_LIMITS.titleChars),
        createdAt: now,
        updatedAt: now,
        status: 'starting',
        nativeSessionId: nativeId,
        lastSeq: 0,
        pendingRequests: [],
        forkedFrom: source.record.id,
        interruptedTurnId: undefined,
        orphanNotice: undefined,
        workspace: undefined,
        queue: undefined,
        queuedHandoff: undefined,
        staged: undefined, // the fork stages its own copy on start
        branch: { ...source.record.branch, provisional: false },
      }
      storage.insertSession(record)
      const live = this.requireLive(record.id)
      this.emit_(record.id, { type: 'session.created', session: record })
      // The visible transcript starts here; the native context was inherited
      // by the agent, which the header states through `forkedFrom`.
      this.emit_(record.id, { type: 'status.changed', status: 'starting', detail: `forked from "${source.record.title}"; the agent keeps that conversation's context` })
      void this.serialized(live, () => this.startSession(live, { forkFrom: source.record })).catch(() => undefined)
      return live.record
    })
  }

  /** Explicit cross-agent handoff: a new session for another agent whose
   *  first turn is a labelled summary — never a pretence that the native
   *  session moved. The new session binds to the same branch as it is. */
  async handoff(id: string, target: { agent: AgentId, model: string, effort?: string }): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const source = this.requireLive(id)
    if (source.turn) throw new ChatError(409, 'a turn is running; hand off after it finishes', 'turn_in_progress')
    if (source.record.selfChangeId) throw new ChatError(409, 'a Poise change session cannot be handed off; its checkout belongs to the release controller', 'unsupported')
    const summary = this.handoffSummary(source.record)
    const created = await this.create({
      agent: target.agent,
      model: target.model,
      effort: target.effort,
      repo: source.record.repo,
      branch: { existing: source.record.branch.name },
      title: `${source.record.title} → ${AGENT_LABEL[target.agent]}`.slice(0, CHAT_LIMITS.titleChars),
      autoMerge: source.record.autoMerge,
      safeMode: source.record.safeMode === true,
      context: { kind: 'handoff', title: source.record.title, body: summary, fromSession: source.record.id },
    })
    const live = this.requireLive(created.id)
    void this.serialized(live, async () => {
      if (live.record.status === 'error' || live.lifecycle.signal.aborted) return
      const turn = this.reserveTurn(live)
      await this.runTurn(live, turn, { text: summary, attachments: [], mentions: [] })
    }).catch(() => undefined)
    return created
  }

  private handoffSummary(record: SessionRecord): string {
    const turns: Array<{ prompt: string, text: string, files: Set<string> }> = []
    let cursor = 0
    while (true) {
      const page = storage.listEvents(record.id, cursor)
      for (const { event } of page.events) {
        if (event.type === 'turn.started') {
          turns.push({ prompt: clip(event.prompt.text, 600), text: '', files: new Set() })
          if (turns.length > 6) turns.shift()
        } else if (event.type === 'text.delta' && turns.length) {
          const turn = turns[turns.length - 1]
          // Keep a bounded tail so the outcome survives a long streamed turn.
          turn.text = (turn.text + event.delta).slice(-1800)
        } else if (event.type === 'diff' && turns.length) {
          const paths = turns[turns.length - 1].files
          if (paths.size < 40) paths.add(event.path)
        }
      }
      if (!page.truncated || !page.events.length) break
      cursor = page.events[page.events.length - 1].seq
    }
    const recent = turns
    const files = new Set(recent.flatMap(turn => [...turn.files]))
    const lines = [
      `[Handoff from a ${AGENT_LABEL[record.agent]} session "${record.title}" in ${record.repo} on branch ${record.branch.name}]`,
      'This conversation continues here with a different agent. Nothing from the previous native session carried over except this summary.',
      '',
      'Recent turns:',
      ...recent.map((t, i) => `${i + 1}. User: ${clip(t.prompt, 600)}\n   Agent: ${clip(t.text.trim(), 900)}`),
    ]
    if (files.size) lines.push('', `Files the previous agent changed: ${[...files].slice(0, 40).join(', ')}`)
    lines.push('', 'Continue from here.')
    return lines.join('\n')
  }

  // ── Poise self-improvement ─────────────────────────────────────────────

  /** `/poise <request>` typed in `sourceId`: ask the controller to prepare an
   *  isolated checkout for the change, open a dedicated session in it with
   *  the source session's model, bind that session to the change, and
   *  reserve its one implementing turn (runbook + the exact request) before
   *  answering — so no browser prompt can slip in first and a resend of the
   *  same `changeId` finds the session instead of making a second one. */
  async startPoiseChange(sourceId: string, text: string, changeId: string, context: Pick<PromptInput, 'attachments' | 'mentions'> = { attachments: [], mentions: [] }): Promise<PoiseChangeResult> {
    this.assertAcceptingWork()
    const request = String(text || '').trim()
    const input = this.validatePrompt(sourceId, { text: request, ...context })
    const contextKey = input.attachments.length || input.mentions.length
      ? sha256Of(Buffer.from(canonicalJson({ attachments: input.attachments, mentions: input.mentions }))) : ''
    // Two arrivals of one change id (a resend under a new request id while
    // the first is still preparing) share the one start — but only for the
    // same request from the same session; a second prepare and bind would
    // make the controller refuse the real session, and a different request
    // under a reused id is a conflict, not a replay.
    const key = String(changeId).toLowerCase()
    const running = this.changeStarts.get(key)
    if (running) {
      if (running.sourceId !== sourceId || running.request !== request || running.contextKey !== contextKey) throw changeIdConflict()
      return running.promise
    }
    const promise = this.track(() => this.startChange(sourceId, request, changeId, input, contextKey)).finally(() => this.changeStarts.delete(key))
    this.changeStarts.set(key, { sourceId, request, contextKey, promise })
    return promise
  }

  private async startChange(sourceId: string, request: string, changeId: string, input: PromptInput, contextKey: string): Promise<PoiseChangeResult> {
    if (this.stopped) throw new ChatError(503, 'the chat runtime is stopping', 'agent_error')
    const bridge = this.selfUpdate
    if (!bridge?.configured) {
      throw new ChatError(503, 'Poise self-improvement is not set up on this server: install and enable the self-update controller before using /poise', 'self_update_unavailable')
    }
    if (!UUID_PATTERN.test(changeId)) throw new ChatError(400, 'changeId must be a UUID', 'invalid')
    if (!request) throw new ChatError(400, 'say what to change: /poise <request>', 'invalid')
    if (Buffer.byteLength(request, 'utf8') > CHAT_LIMITS.promptBytes) throw new ChatError(413, `request exceeds ${CHAT_LIMITS.promptBytes} bytes`, 'invalid')
    const source = this.get(sourceId)
    if (!source) throw new ChatError(404, 'unknown session', 'unknown_session')
    const id = changeId.toLowerCase()

    // The same change id from the same session with the same request is
    // the same change: answer with the session it already has rather than
    // preparing a second checkout. Anything else under that id is refused.
    const existing = storage.listSessions(this.instance).find((record) => record.selfChangeId === id)
    if (existing) {
      if (existing.context?.kind !== 'poise-change' || existing.context.fromSession !== source.id || existing.context.body !== request || (existing.selfChangeContextKey || '') !== contextKey) throw changeIdConflict()
      const status = await this.bridgeCall(() => bridge.status())
      const change = status.changes.find((c) => String(c.id).toLowerCase() === id)
      if (!change || change.instance !== this.instance) throw new ChatError(409, 'this change is no longer known to the release controller', 'self_update_unavailable')
      return { session: this.withLive(existing), change }
    }

    if (source.agent === 'claude') await this.requireClaudeReady()
    const title = poiseChangeTitle(request)
    const prepared = await this.bridgeCall(() => bridge.prepareChange({ id, sessionId: source.id, instance: this.instance, request, title }))
    const change = prepared.change
    if (String(change?.id).toLowerCase() !== id || change.repository !== SELF_UPDATE_REPOSITORY || change.instance !== this.instance) {
      await this.abandonChange(bridge, id, 'the controller answered for a different change')
      throw new ChatError(502, 'the release controller answered for a different change or repository; nothing was started', 'agent_error')
    }
    if (typeof prepared.workspace !== 'string' || !prepared.workspace.startsWith('/') || typeof prepared.branch !== 'string' || !prepared.branch) {
      await this.abandonChange(bridge, id, 'the controller returned no usable workspace')
      throw new ChatError(502, 'the release controller returned no usable workspace; nothing was started', 'agent_error')
    }
    let checkout: string
    try {
      checkout = canonicalCheckout(prepared.workspace)
      const state = await inspectCheckout(checkout)
      if (state.currentBranch !== prepared.branch) throw new Error(`the prepared checkout is on ${state.currentBranch || 'a detached HEAD'}, not ${prepared.branch}`)
      if (state.dirty) throw new Error(`the prepared checkout has ${state.dirtyFiles} uncommitted change(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.abandonChange(bridge, id, message)
      throw new ChatError(502, `the prepared workspace is not usable: ${message}`, 'agent_error')
    }

    const now = new Date().toISOString()
    const record: SessionRecord = {
      id: randomUUID(),
      agent: source.agent,
      model: source.model,
      modelId: source.modelId,
      effort: source.effort,
      repo: SELF_UPDATE_REPOSITORY,
      checkout,
      workspaceKind: 'poise-change',
      selfChangeId: id,
      ...(contextKey ? { selfChangeContextKey: contextKey } : {}),
      autoMerge: source.autoMerge,
      safeMode: source.safeMode === true,
      branch: { name: prepared.branch, origin: 'existing', provisional: false, baseSha: prepared.baseSha },
      title: `Poise: ${title}`.slice(0, CHAT_LIMITS.titleChars),
      createdAt: now,
      updatedAt: now,
      status: 'starting',
      capabilities: emptyCapabilities(),
      lastSeq: 0,
      pendingRequests: [],
      instance: this.instance,
      context: { kind: 'poise-change', title, body: request, fromSession: source.id },
    }
    storage.insertSession(record)
    const live = this.requireLive(record.id)
    this.emit_(record.id, { type: 'session.created', session: record })
    let bound: SelfChange
    try {
      bound = await this.bridgeCall(() => bridge.bindSession(id, { sessionId: record.id, instance: this.instance }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try { this.emit_(record.id, { type: 'error', message: `the release controller did not accept this session: ${message}`, recoverable: false }) } catch { /* mirror */ }
      this.setStatus(live, 'error', message)
      await this.abandonChange(bridge, id, `the runtime session could not be bound: ${message}`, record.id)
      throw error
    }
    let transferred: PromptInput
    try {
      transferred = await this.copyPromptContext(source.id, record.id, input)
      await this.copyQueuedContext(source.id, record.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus(live, 'error', message)
      await this.abandonChange(bridge, id, `Could not transfer the request context: ${message}`, record.id)
      throw error
    }
    delegateQueue(source.id, record.id)
    this.publishQueue(live)
    // Reserved synchronously: the ack goes out with the turn already taken.
    // The agent gets the runbook around the request; the transcript shows
    // the request as the person typed it.
    const turn = this.reserveTurn(live)
    turn.implementsChange = true
    turn.shown = transferred
    const prompt: PromptInput = { ...transferred, text: poiseChangePrompt({ request, branch: prepared.branch, baseSha: prepared.baseSha, workspace: checkout }) }
    void this.serialized(live, () => this.runTurn(live, turn, prompt)).catch(() => undefined)
    return { session: this.withLive(live.record), change: bound }
  }

  /** Uploaded evidence must outlive the source conversation. Reissue it under
   *  the target session, verifying bytes rather than trusting browser text. */
  private async copyPromptContext(sourceId: string, targetId: string, input: PromptInput): Promise<PromptInput> {
    const attachments: Attachment[] = []
    const source = this.get(sourceId)
    if (!source) throw new ChatError(404, 'The attachment source conversation no longer exists', 'unknown_session')
    for (const attachment of input.attachments) {
      const record = storage.getAttachment(attachment.id)
      if (!record || record.sessionId !== sourceId || record.path !== attachment.path || record.size !== attachment.size) {
        throw new ChatError(400, 'The attachment does not belong to the source conversation', 'invalid')
      }
      const { bytes } = await readCheckoutBytes(source.checkout, record.path, CHAT_LIMITS.attachmentBytes)
      if (bytes.byteLength !== record.size || sha256Of(bytes) !== record.sha256) throw new Error(`Attachment ${record.name} changed since upload`)
      attachments.push(await this.saveAttachment(targetId, record.name, bytes))
    }
    return { ...input, attachments }
  }

  private async copyQueuedContext(sourceId: string, targetId: string): Promise<void> {
    const source = this.requireLive(sourceId)
    await this.control(source, async () => {
      const owner = queueOwner(sourceId)
      for (const item of readQueue(owner).items) {
        if (item.state !== 'waiting' || !item.prompt.attachments.length) continue
        const prompt = await this.copyPromptContext(item.sourceSessionId || sourceId, targetId, item.prompt)
        this.mutateQueue(source, () => transferQueuedContext(owner, item.id, targetId, prompt))
      }
    })
  }

  /** Legacy/delegated queues can still borrow a conversation's uploaded files.
   *  Preserve waiting work under its surviving executor before deleting its source. */
  private async preserveBorrowedQueueContext(deletingId: string): Promise<void> {
    const seen = new Set<string>()
    for (const record of storage.listSessions(this.instance)) {
      const owner = queueOwner(record.id)
      if (seen.has(owner)) continue
      seen.add(owner)
      const queue = readQueue(owner)
      const targetId = queue.executorSessionId && queue.executorSessionId !== deletingId ? queue.executorSessionId : owner
      if (targetId === deletingId || !this.ownsSession(targetId)) continue
      for (const item of queue.items) {
        if (item.state !== 'waiting' || item.sourceSessionId !== deletingId || !item.prompt.attachments.length) continue
        const prompt = await this.copyPromptContext(deletingId, targetId, item.prompt)
        this.mutateQueue(this.requireLive(targetId), () => transferQueuedContext(owner, item.id, targetId, prompt))
      }
    }
  }

  /** The controller's own refusals are shown as they are; an unreachable
   *  controller is the actionable "not set up" error. */
  private async bridgeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof SelfUpdateUnavailableError) throw new ChatError(503, error.message, 'self_update_unavailable')
      if (error instanceof SelfUpdateBridgeError) throw new ChatError(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502, error.message, 'agent_error')
      throw error
    }
  }

  /** A change that never got its turn is failed at the controller so the
   *  single lane is free again; a controller that cannot hear it now hears
   *  it from the outbox on the next start. */
  private async abandonChange(bridge: SelfUpdateBridge, changeId: string, error: string, sessionId = ''): Promise<void> {
    finishOutbox.queueFinish({ changeId, instance: this.instance, sessionId, outcome: 'failed', error })
    try {
      await bridge.finish(changeId, { outcome: 'failed', error })
      finishOutbox.markDelivered(changeId)
    } catch (failure) {
      finishOutbox.markAttempt(changeId, failure instanceof Error ? failure.message : String(failure))
    }
  }

  /** The change turn's settlement, after the worker is verifiably gone and
   *  the checkout released: the first outcome is recorded durably, then
   *  delivered; the controller checks the branch itself, so nothing the
   *  agent said is forwarded — only whether the turn ended cleanly. */
  private async settleChange(session: LiveSession, outcome: { stopReason: StopReason, error?: string, freed: boolean, terminalRecorded: boolean }): Promise<void> {
    const changeId = session.record.selfChangeId
    if (!changeId) return
    const completed = outcome.terminalRecorded && outcome.freed && outcome.stopReason === 'end_turn'
    const error = completed ? undefined
      : !outcome.terminalRecorded ? 'the turn outcome could not be recorded'
      : !outcome.freed ? (session.record.orphanNotice || 'the agent process could not be stopped')
      : outcome.error || `the change turn ended with ${outcome.stopReason}`
    const { fresh } = finishOutbox.queueFinish({ changeId, instance: this.instance, sessionId: session.record.id, outcome: completed ? 'completed' : 'failed', error })
    if (fresh) {
      try {
        this.emit_(session.record.id, { type: 'status.changed', status: session.record.status,
          detail: completed ? 'handed to the release controller: it checks, opens the PR, merges and releases from here' : `not released: ${error}` })
      } catch { /* mirror */ }
    }
    await this.flushSelfUpdateOutbox()
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  /** Reserve the turn synchronously — before any await — so a second prompt
   *  in the same tick is refused, and persist it before acknowledging. */
  private reserveTurn(session: LiveSession, queueItem?: QueuedMessage): RunningTurn {
    if (session.turn) throw new ChatError(409, 'a turn is already running; Enter steers it', 'turn_in_progress')
    if (session.record.status === 'closed') throw new ChatError(409, 'the session is closed; resume it first', 'no_turn')
    if (session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closing', 'no_turn')
    let releasePrompt!: () => void
    const promptReady = new Promise<void>(resolve => { releasePrompt = resolve })
    const turn: RunningTurn = { id: randomUUID(), callId: null, startedAt: Date.now(), abort: new AbortController(), stopping: false, promptReady, releasePrompt }
    turn.abort.signal.addEventListener('abort', releasePrompt, { once: true })
    storage.reserveQueueTurn(session.record.id, turn.id, queueItem?.id)
    if (queueItem) turn.queueItem = queueItem
    session.turn = turn
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    return turn
  }

  prompt(id: string, input: PromptInput): { turnId: string } {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const prompt = this.validatePrompt(id, input)
    const chain = parseChatCommandChain(prompt.text)
    if (chain.missingModel) throw new ChatError(400, 'Choose a model from /model first.', 'invalid')
    if (chain.queue) throw new ChatError(400, 'Use the queue command to defer a message.', 'invalid')
    if (chain.model && !chain.text && !chain.review && !prompt.attachments.length) throw new ChatError(400, 'A model-only selection uses set_model; add a task to send a message.', 'invalid')
    const throughSeq = session.record.lastSeq
    const target = chain.review ? latestReviewTarget(id, throughSeq) : null
    if (chain.review && !target) throw new ChatError(400, 'There is no assistant reply to review yet.', 'invalid')
    const turn = this.reserveTurn(session)
    turn.commandModel = chain.model
    if (target) turn.review = { target, throughSeq }
    if (chain.model || chain.review) turn.shown = prompt
    void this.serialized(session, () => this.runTurn(session, turn, { ...prompt, text: chain.text })).catch(() => undefined)
    return { turnId: turn.id }
  }

  private validatePrompt(id: string, input: PromptInput): PromptInput {
    const text = String(input.text || '').trim()
    if (!text && !input.attachments?.length) throw new ChatError(400, 'prompt is required', 'invalid')
    if (Buffer.byteLength(text, 'utf8') > CHAT_LIMITS.promptBytes) throw new ChatError(413, `prompt exceeds ${CHAT_LIMITS.promptBytes} bytes`, 'invalid')
    // What the browser says about an attachment is checked against the
    // record this server issued; only the id, name, path and size it
    // recorded go on, never client-supplied text.
    const attachments: Attachment[] = []
    for (const claimed of (input.attachments ?? []).slice(0, 20)) {
      const record = claimed && typeof claimed.id === 'string' ? storage.getAttachment(claimed.id) : null
      if (!record || record.sessionId !== id) throw new ChatError(400, `attachment ${claimed?.name ?? ''} does not belong to this session`, 'invalid')
      if (claimed.path !== record.path || claimed.size !== record.size) throw new ChatError(400, `attachment ${record.name} does not match its record`, 'invalid')
      attachments.push({ id: record.id, name: record.name, path: record.path, size: record.size })
    }
    const mentions = (input.mentions ?? []).filter((m) => m && typeof m.path === 'string').slice(0, 50).map((m) => ({ path: m.path }))
    return { text, attachments, mentions }
  }

  // ── Deferred messages ───────────────────────────────────────────────────

  async enqueue(id: string, itemId: string, input: PromptInput, model?: string, effort?: string): Promise<MessageQueue> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (!UUID_PATTERN.test(itemId)) throw new ChatError(400, 'itemId must be a UUID', 'invalid')
    return this.control(session, async () => {
      const submitted = this.validatePrompt(id, input)
      const chain = parseChatCommandChain(submitted.text)
      if (chain.missingModel) throw new ChatError(400, 'Choose a model from /model first.', 'invalid')
      const prompt = this.validatePrompt(id, { ...submitted, text: commandBody(chain) })
      const target = await this.resolveModel(model || chain.model || session.record.model, effort)
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      return this.mutateQueue(session, () => enqueueMessage(queueOwner(id), { id: itemId, sourceSessionId: id, prompt, agent: target.agent, model: target.model.identity,
        effort: target.effort, createdAt: new Date().toISOString(), state: 'waiting' }))
    })
  }

  async updateQueue(id: string, itemId: string, model: string, effort?: string): Promise<MessageQueue> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    return this.control(session, async () => {
      const target = await this.resolveModel(model, effort)
      return this.mutateQueue(session, () => updateQueuedModel(queueOwner(id), itemId, { agent: target.agent, model: target.model.identity, effort: target.effort }))
    })
  }

  removeQueue(id: string, itemId: string): MessageQueue {
    const session = this.requireLive(id)
    return this.mutateQueue(session, () => removeQueuedMessage(queueOwner(id), itemId))
  }

  private queueOperation<T>(operation: () => T): T {
    try { return operation() } catch (error) {
      if (error instanceof QueueError) throw new ChatError(409, error.message, error.code)
      throw error
    }
  }

  private mutateQueue(session: LiveSession, operation: () => MessageQueue): MessageQueue {
    const envelope = storage.commitQueueMutation(session.record.id, () => this.queueOperation(operation))
    session.record.lastSeq = envelope.seq
    // The durable receipt is authoritative even if a browser disconnected.
    try { this.emit('event', envelope) } catch { /* reconnect reads the mirror */ }
    const queue = this.messageQueue(session.record.id)
    for (const id of [queueOwner(session.record.id), queue.executorSessionId]) {
      if (id && id !== session.record.id && this.ownsSession(id)) {
        try { this.emit_(id, { type: 'queue.updated', queue }) } catch { /* REST also includes the committed queue */ }
      }
    }
    return queue
  }

  private messageQueue(id: string): MessageQueue {
    const queue = readQueue(queueOwner(id))
    return this.queueReleaseWait.has(queue.executorSessionId || id) ? { ...queue, waitingForRelease: true } : queue
  }

  private publishQueue(session: LiveSession): MessageQueue {
    const owner = queueOwner(session.record.id)
    const queue = this.messageQueue(session.record.id)
    if (queue.revision) {
      this.emit_(session.record.id, { type: 'queue.updated', queue })
      for (const id of [owner, queue.executorSessionId]) {
        if (id && id !== session.record.id && this.ownsSession(id)) this.emit_(id, { type: 'queue.updated', queue })
      }
    }
    return queue
  }

  /** Never called by enqueue. A known completed turn arms the persistent
   *  queue; execution waits for its lifecycle/lease cleanup to finish. */
  private scheduleQueue(session: LiveSession): void {
    const id = session.record.id
    if (this.stopped || this.recovering || this.drainState || session.lifecycle.signal.aborted || session.record.status === 'closed'
      || session.record.orphanNotice || session.turn || this.queuePumps.has(id) || this.queueTimers.has(id) || !this.messageQueue(id).ready) return
    const executor = this.messageQueue(id).executorSessionId
    if (executor && executor !== id) return
    this.queuePumps.add(id)
    let ran = false
    void this.serialized(session, async () => {
      if (this.stopped || this.drainState || session.lifecycle.signal.aborted || session.turn || storage.getOpenTurn(id)) return
      // An isolated implementation hands its checkout to the release
      // controller after its turn. Never let a follow-up edit that checkout
      // while checks/build/deployment still own it. This is a wait, not an
      // extra confirmation; the durable queue continues after deployment.
      if (session.record.selfChangeId && this.selfUpdate?.configured) {
        let done = false
        try {
          const status = await this.selfUpdate.status()
          const change = status.changes.find(change => change.id === session.record.selfChangeId)
          done = !!change && ['live', 'failed', 'blocked', 'reverted', 'superseded'].includes(change.state)
        } catch { /* retry after the controller is reachable */ }
        if (!done) {
          if (!this.queueReleaseWait.has(id)) { this.queueReleaseWait.add(id); this.publishQueue(session) }
          const timer = setTimeout(() => { this.queueTimers.delete(id); this.scheduleQueue(session) }, 1_000)
          timer.unref(); this.queueTimers.set(id, timer)
          return
        }
        this.queueReleaseWait.delete(id)
      }
      const queue = this.messageQueue(id)
      const item = queue.ready && queue.items.find(candidate => candidate.state === 'waiting')
      if (!item || this.stopped || this.drainState || session.turn || session.lifecycle.signal.aborted) return
      const turn = this.reserveTurn(session, item)
      ran = true
      await this.runTurn(session, turn, item.prompt)
    }).catch(error => {
      this.emit('log', `[chat queue ${id}] ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.queuePumps.delete(id)
      // runTurn's completion armed the following item while this pump was held.
      if (ran && !session.turn && !storage.getOpenTurn(id)) this.scheduleQueue(session)
    })
  }

  /** A different queued agent is a real native handoff, not a renamed
   *  model. Keep the Poise conversation, workspace and draft; start a new
   *  native context with a labelled summary of the actual preceding turns. */
  private async prepareQueuedAgent(session: LiveSession, turn: RunningTurn): Promise<void> {
    const item = turn.queueItem!
    const target = await this.resolveModel(item.model, item.effort)
    if (target.agent !== item.agent) throw new ChatError(409, 'The queued model now belongs to a different agent.', 'invalid')
    await this.selectSessionModel(session, item.model, item.effort)
  }

  /** Selecting another provider is a real adapter handoff in this conversation.
   *  Merely selecting never starts a model call; the next admitted task does. */
  private async selectSessionModel(session: LiveSession, identity: string, effortOverride?: string): Promise<void> {
    const target = await this.resolveModel(identity, effortOverride)
    const record = session.record
    let nativeModelId = target.model.selector
    if (target.agent === 'claude') await this.requireClaudeReady()
    if (target.agent === record.agent && target.model.selector === record.modelId && record.efforts?.length && !record.efforts.includes(target.effort)) {
      throw new ChatError(400, `${target.model.selector} offers native efforts ${record.efforts.join(', ')}`, 'invalid')
    }
    if (record.agent !== target.agent) {
      const context = this.handoffSummary(record)
      await this.stopProcess(session)
      record.queuedHandoff = context
      record.agent = target.agent
      record.nativeSessionId = undefined
      record.capabilities = emptyCapabilities()
      record.mode = undefined; record.modes = undefined; record.commands = undefined; record.efforts = undefined
      session.grants.clear()
    } else if (session.adapter?.alive && (record.model !== target.model.identity || record.effort !== target.effort)) {
      const applied = await session.adapter.setModel(target.model.selector, target.effort)
      if (applied.efforts || record.modelId !== target.model.selector) record.efforts = applied.efforts
      // Providers may resolve a catalogue selector to a dated native alias.
      nativeModelId = applied.modelId || target.model.selector
      if (applied.effort && applied.effort !== target.effort) throw new ChatError(409, 'The agent did not apply the selected effort.', 'agent_error')
    } else if (record.modelId !== target.model.selector) record.efforts = undefined
    record.model = target.model.identity; record.modelId = nativeModelId; record.effort = target.effort
    this.saveRecord(session)
    this.emit_(record.id, { type: 'model.updated', model: record.model, modelId: record.modelId, effort: record.effort, efforts: record.efforts })
    this.emit_(record.id, { type: 'session.updated', session: record })
  }

  /** Stage an uploaded file inside the session's checkout, under the lease.
   *  While this session's own turn holds the checkout the write is one of
   *  the turn's services (the turn does not release before it returns);
   *  otherwise it runs in the session's operation chain under a lease of its
   *  own, so it cannot interleave with close, delete or the next turn. The
   *  record is issued inside the protected operation. */
  async saveAttachment(id: string, filename: string, body: Buffer): Promise<Attachment> {
    this.assertAcceptingWork()
    return this.track(() => this.stageAttachment(id, filename, body))
  }

  private async stageAttachment(id: string, filename: string, body: Buffer): Promise<Attachment> {
    const session = this.requireLive(id)
    const record = session.record
    if (record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closed', 'no_turn')
    if (body.byteLength > CHAT_LIMITS.attachmentBytes) throw new ChatError(413, `attachment exceeds ${CHAT_LIMITS.attachmentBytes} bytes`, 'invalid')
    const name = safeAttachmentName(filename)
    const attachmentId = randomUUID()
    const relative = attachmentPath(record.id, attachmentId, name)
    const write = async () => {
      if (record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closing', 'no_turn')
      const { absolute } = await resolveInsideCheckout(record.checkout, relative)
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
      await ensureExcluded(record.checkout)
      await writeFile(absolute, body, { flag: 'wx', mode: 0o600 })
      storage.insertAttachment({ id: attachmentId, sessionId: record.id, name, path: relative, size: body.byteLength, sha256: sha256Of(body), createdAt: new Date().toISOString() })
    }
    if (!(await this.asTurnService(session, write))) {
      await this.serialized(session, async () => {
        const lease = this.leaseFor(session)
        const deadline = AbortSignal.timeout(ATTACHMENT_LEASE_WAIT_MS)
        const signal = AbortSignal.any([session.lifecycle.signal, deadline])
        let holder = ''
        try {
          await lease.acquire({ signal, onBusy: (busy) => { holder = describeHolder(busy.holder) } })
        } catch {
          throw new ChatError(409, deadline.aborted ? `the checkout is busy (${holder}); try again when that turn is over` : 'the session is closing', 'checkout_busy')
        }
        try {
          await write()
        } finally {
          lease.release()
        }
      })
    }
    return { id: attachmentId, name, path: relative, size: body.byteLength }
  }

  /** Run `operation` as a service of the session's running turn, counted so
   *  the turn drains it before releasing the checkout. False when there is
   *  no such turn (or it is already draining), in which case the caller
   *  takes its own lease. */
  private async asTurnService(session: LiveSession, operation: () => Promise<void>): Promise<boolean> {
    const turn = session.turn
    if (!turn || turn.stopping || session.draining || !session.lease?.held) return false
    session.services += 1
    try {
      if (session.draining || !session.lease?.held) return false
      await operation()
      return true
    } finally {
      session.services -= 1
    }
  }

  private async removeAttachments(session: LiveSession): Promise<void> {
    for (const directory of [ATTACHMENT_DIR, '.poise-chat/reviews']) {
      try {
        const { absolute } = await resolveInsideCheckout(session.record.checkout, `${directory}/${session.record.id}`)
        await rm(absolute, { recursive: true, force: true })
      } catch { /* missing or inaccessible private staging is never followed outside the checkout */ }
    }
  }

  /** Under the held lease, on the session's branch: read every attachment
   *  from its record (bounded, regular files only, content verified against
   *  the recorded hash) and check every @mention names a real file inside
   *  the checkout. A claim that does not hold fails the turn readably. */
  private async resolveInput(session: LiveSession, input: PromptInput, sourceSessionId = session.record.id): Promise<PromptInput> {
    const checkout = session.record.checkout
    const attachments: Attachment[] = []
    for (const attachment of input.attachments) {
      const record = storage.getAttachment(attachment.id)
      if (!record || record.sessionId !== sourceSessionId) throw new Error(`attachment ${attachment.name} is not one of this session's`)
      const source = sourceSessionId === session.record.id ? session.record : this.get(sourceSessionId)
      if (!source) throw new Error('The queued attachment source session no longer exists')
      let text: string | undefined
      try {
        const { bytes } = await readCheckoutBytes(source.checkout, record.path, CHAT_LIMITS.attachmentBytes)
        if (bytes.byteLength !== record.size || sha256Of(bytes) !== record.sha256) throw new Error(`attachment ${record.name} changed on disk since it was uploaded`)
        if (source.checkout !== checkout) {
          const target = await resolveInsideCheckout(checkout, record.path)
          await mkdir(dirname(target.absolute), { recursive: true, mode: 0o700 })
          await ensureExcluded(checkout)
          await writeFile(target.absolute, bytes, { mode: 0o600 })
        }
        text = inlineText(bytes)
      } catch (error) {
        if (error instanceof PathError) throw new Error(`attachment ${record.name} is no longer readable in the checkout (${error.message})`)
        throw error
      }
      attachments.push({ id: record.id, name: record.name, path: record.path, size: record.size, ...(text !== undefined ? { text } : {}) })
    }
    const mentions: PromptInput['mentions'] = []
    for (const mention of input.mentions) {
      try {
        const { relative } = await readCheckoutBytes(checkout, mention.path)
        mentions.push({ path: relative })
      } catch (error) {
        throw new Error(`@${mention.path} is not a file in the checkout (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    return { ...input, attachments, mentions }
  }

  private async runTurn(session: LiveSession, turn: RunningTurn, input: PromptInput): Promise<void> {
    const record = session.record
    let lease: CheckoutLease | null = null
    let stopReason: StopReason = 'error'
    let error: string | undefined
    let usage
    let terminate = false
    let agentSettled = false
    let agentInvoked = false
    let checkoutBefore: CheckoutSnapshot | null = null
    let started = false
    session.draining = false
    try {
      if (turn.abort.signal.aborted) throw new Error(turn.failure || 'cancelled before it started')
      await session.steering
      if (record.safeModePending && session.adapter?.alive) await this.stopProcess(session)
      if (turn.queueItem) {
        const chain = parseChatCommandChain(input.text)
        if (chain.review) {
          const throughSeq = record.lastSeq
          const target = latestReviewTarget(record.id, throughSeq)
          if (!target) throw new ChatError(400, 'There is no assistant reply to review yet.', 'invalid')
          turn.review = { target, throughSeq }; turn.shown = input
          input = { ...input, text: chain.text }
        }
        this.publishQueue(session); await this.prepareQueuedAgent(session, turn)
      } else if (turn.commandModel) await this.selectSessionModel(session, turn.commandModel)
      if (!session.adapter?.alive) await this.startSession(session, { fresh: !record.nativeSessionId && !record.branch.baseSha && record.branch.provisional })
      let adapter = session.adapter!
      const isFirst = !storage.findEvent(record.id, (e) => e.type === 'turn.started')
      // A change session is titled by its request, not by the runbook's first line.
      if ((record.title === 'New session' || isFirst) && !record.selfChangeId) {
        record.title = (input.text.split('\n')[0] || record.title).slice(0, TITLE_CHARS) || record.title
        this.saveRecord(session)
        this.emit_(record.id, { type: 'session.updated', session: record })
      }
      // The Caller row first, so its id is part of the durable turn record.
      if (this.caller) {
        turn.callId = await this.caller.start({ model: record.model, sessionId: record.id, repo: record.repo, pr: record.branch.pr, correlationId: turn.id })
        storage.setOpenTurn(record.id, turn.id, turn.callId)
      }
      const nativeInput = await this.composePrompt(session, input, isFirst)
      this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? nativeInput, callId: turn.callId ?? undefined, agent: record.agent, model: record.model, ...(turn.queueItem ? { queueItemId: turn.queueItem.id } : {}) })
      started = true
      this.setStatus(session, 'queued')
      // Created after the title settled: the label names what is queued behind.
      lease = this.leaseFor(session)
      await lease.acquire({ signal: turn.abort.signal, onBusy: (busy) => this.reportBusy(session, busy) })
      session.lease = lease
      lease.onLost(() => {
        try { this.emit_(record.id, { type: 'error', message: 'the checkout lease was lost; stopping the turn', recoverable: true }) } catch { /* mirror */ }
        turn.failure = 'the checkout lease was lost'
        turn.abort.abort()
        void adapter.cancel()
      })
      await this.prepareCheckout(session, lease)
      if (session.worker) {
        if (!lease.registerWorker({ pid: session.worker.pid, pgid: session.worker.pgid, ident: session.worker.ident })) throw new Error('the checkout lease was lost before the turn started')
        storage.setWorkerLeaseToken(record.id, lease.currentToken)
      }
      let adapterInput = await this.resolveInput(session, nativeInput, turn.queueItem?.sourceSessionId)
      if (turn.review) adapterInput = await prepareReview(record.checkout, record.id, turn.id, turn.review.throughSeq, turn.review.target, { ...adapterInput, text: input.text }, turn.abort.signal)
      if (session.staged) {
        const report = await refreshDocument(record.checkout, session.staged)
        if (report.kind === 'refreshed' || report.kind === 'staged') this.saveRecord(session)
        if (isBridgeProblem(report)) this.emit_(record.id, { type: 'error', message: report.message, recoverable: true })
      }
      // Capture before the native prompt can write, not in an asynchronous
      // item/started notification that races the tool's filesystem effects.
      checkoutBefore = await captureCheckoutSnapshot(record.checkout, session.staged ? [session.staged.path] : [])
      // Settings may change during the handshake or a checkout wait. No native
      // user prompt has started yet, so use the newest acknowledged policy now.
      await session.steering
      while (record.safeModePending) {
        turn.abort.signal.throwIfAborted()
        try {
          await this.stopProcess(session)
          await this.startSession(session, { lease })
        } catch (failure) {
          // A failed replacement may still own a live worker even though the
          // prompt was never invoked. Final cleanup must verify its exit too.
          terminate = true
          throw failure
        }
        await session.steering
      }
      adapter = session.adapter!
      if (turn.abort.signal.aborted) throw new Error(turn.failure || 'cancelled before the agent prompt')
      this.setStatus(session, 'running')
      agentInvoked = true
      turn.agentInvoked = true
      if (record.queuedHandoff) adapterInput.text = `${record.queuedHandoff}\n\n[Current task]\n${adapterInput.text}`
      const response = adapter.prompt(turn.id, withAutoMergeInstructions({ ...adapterInput, memories: readMemories().text }, record.autoMerge, turn.implementsChange), turn.abort.signal)
      turn.releasePrompt()
      const result = await response
      agentSettled = true
      if (record.queuedHandoff && result.stopReason === 'end_turn') { record.queuedHandoff = undefined; this.saveRecord(session) }
      stopReason = turn.stopping || turn.abort.signal.aborted ? 'cancelled' : result.stopReason
      error = result.error
      usage = result.usage
      terminate = result.terminate === true
      if (turn.failure && stopReason !== 'cancelled') { stopReason = 'error'; error = turn.failure }
    } catch (err) {
      const cancelled = turn.abort.signal.aborted
      stopReason = cancelled ? 'cancelled' : 'error'
      error = cancelled
        ? (turn.failure && turn.failure !== 'cancelled before it started' ? turn.failure : undefined)
        : err instanceof CallerCompatError ? err.message : `${err instanceof Error ? err.message : String(err)}`
      try {
        if (!started) this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? input, callId: turn.callId ?? undefined })
        if (!cancelled) this.emit_(record.id, { type: 'error', message: error || 'turn failed', recoverable: true })
      } catch { /* mirror */ }
    } finally {
      turn.releasePrompt()
      turn.abort.signal.removeEventListener('abort', turn.releasePrompt)
      this.settlePending(session, 'cancelled')
      // The lease is released only once nothing of this turn can still write:
      // the agent reported the turn finished (or its process is verifiably
      // gone) and every Poise-served file operation returned.
      let freed = true
      // An agent that was asked and did not report back is not trusted with
      // the checkout; a failure before it was asked leaves it alone.
      // An agent that ended its own process (Claude does after a stop) has
      // its worker group verified gone, or is terminated when it asked for
      // that, before the lease can go.
      if (terminate || (agentInvoked && session.adapter && (!agentSettled || !session.adapter.alive))) {
        try { await this.stopProcess(session) } catch { freed = false }
      }
      session.draining = true
      if (!(await this.waitForServices(session, SERVICE_SETTLE_MS))) {
        // The agent is not letting go; end it. A Poise-side file operation
        // that is already executing cannot be cancelled by that, so the
        // checkout stays held until every service has actually returned
        // (each is bounded: capped reads, atomic writes, single uploads).
        try { await this.stopProcess(session) } catch { freed = false }
        await this.waitForServices(session, Number.POSITIVE_INFINITY)
      }
      if (checkoutBefore && agentInvoked && lease?.held && freed) {
        try { await emitCheckoutChanges(record.checkout, turn.id, checkoutBefore, event => this.emit_(record.id, event)) }
        catch (failure) {
          try { this.emit_(record.id, { type: 'error', recoverable: true,
            message: `Checkout change capture failed: ${failure instanceof Error ? failure.message : String(failure)}. Native tool records remain available.` }) } catch { /* mirror */ }
        }
      }
      if (session.staged && lease?.held) {
        const report = await writeBackDocument(record.checkout, session.staged, record.id).catch((e) => ({ kind: 'conflict' as const, message: `document write-back failed: ${e instanceof Error ? e.message : String(e)}` }))
        if (report.kind !== 'unchanged' && report.kind !== 'missing') this.saveRecord(session) // revision/version moved
        if (isBridgeProblem(report)) { try { this.emit_(record.id, { type: 'error', message: report.message, recoverable: true }) } catch { /* mirror */ } }
      }
      let terminalRecorded = false
      try {
        const envelope = storage.finalizeTurn(record.id,
          { type: 'turn.finished', turnId: turn.id, stopReason, error, usage, durationMs: Date.now() - turn.startedAt },
          turn.callId ? { callId: turn.callId, instance: this.instance } : undefined,
          freed && !turn.stopping && !this.stopped && !session.lifecycle.signal.aborted)
        terminalRecorded = true
        record.lastSeq = envelope.seq
        this.emit('event', envelope)
      } catch (failure) {
        // Preserve the open turn on storage failure; do not acknowledge a
        // ledger result whose recovery record was never made durable.
        this.emit('log', `[chat] terminal outcome could not be published: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
      session.turn = null
      if (terminalRecorded && turn.callId && this.caller) {
        const outcome = storage.listFinishOutbox(this.instance).find(row => row.callId === turn.callId)
        try {
          if (outcome) await this.caller.finish(turn.callId, outcome.status, outcome.error ?? undefined)
          storage.finishDelivered(turn.callId)
        } catch (e) {
          try { this.emit_(record.id, { type: 'error', message: `Caller did not record the turn end (it will be retried when Poise restarts): ${e instanceof Error ? e.message : String(e)}`, recoverable: true }) } catch { /* mirror */ }
        }
      }
      if (lease?.held) {
        if (freed) { lease.clearWorker(); lease.release() }
        else { try { this.emit_(record.id, { type: 'error', message: 'the checkout stays locked: the agent process could not be stopped', recoverable: false }) } catch { /* mirror */ } }
      }
      if (lease && session.lease === lease && !lease.held) session.lease = null
      // A fork learns its native id from the agent's first frames.
      if (session.adapter?.nativeSessionId && session.adapter.nativeSessionId !== record.nativeSessionId) {
        record.nativeSessionId = session.adapter.nativeSessionId
        this.saveRecord(session)
      }
      await this.refreshWorkspace(session).catch(() => undefined)
      if (record.status !== 'closed') {
        if (!freed) this.setStatus(session, 'error', record.orphanNotice || 'the agent process could not be stopped')
        else if (session.adapter?.alive) this.setStatus(session, 'idle')
        // An agent that closed itself after a turn (Claude does after a stop,
        // so a queued interjection can never run) resumes on the next prompt.
        else if (stopReason === 'cancelled' || stopReason === 'end_turn') this.setStatus(session, 'idle', 'agent process closed after the turn; it resumes on the next prompt')
        else this.setStatus(session, 'interrupted')
      }
      this.armIdleTimer(session)
      // Last: the controller hears about a change only once its worker is
      // verifiably gone and the checkout is released above. Only the
      // implementing turn settles it; later discussion in the session does not.
      if (turn.implementsChange && record.selfChangeId) {
        try { await this.settleChange(session, { stopReason, error, freed, terminalRecorded }) }
        catch (failure) { this.emit('log', `[chat ${record.id.slice(0, 8)}] change settlement failed: ${failure instanceof Error ? failure.message : String(failure)}`) }
      }
      if (terminalRecorded) this.publishQueue(session)
      if (this.drainState) await this.closeForDrain(session).catch(() => undefined)
      else if (terminalRecorded && freed) this.scheduleQueue(session)
    }
  }

  /** The first prompt of a session carries its context (card, document,
   *  handoff) to the agent; the transcript records what the agent got. */
  private async composePrompt(session: LiveSession, input: PromptInput, isFirst: boolean): Promise<PromptInput> {
    const context = session.record.context
    if (!isFirst || !context) return input
    const parts: string[] = []
    if (context.kind === 'card') {
      parts.push(`[Context: ${context.title}]`)
      if (context.url) parts.push(context.url)
      if (context.headSha) parts.push(`Head: ${context.headSha}`)
      if (context.body) parts.push('', context.body)
    } else if (context.kind === 'document' && session.staged) {
      parts.push(stagedDocumentPrompt(session.staged, context.title))
    } else {
      return input // a handoff summary or a change runbook is the prompt itself
    }
    return { ...input, text: `${parts.join('\n')}\n\n${input.text}` }
  }

  /** Independent of the lifecycle chain: waiting on that chain would wait
   *  for the very turn the user is trying to steer to finish. */
  private control<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    const task = this.track(() => session.steering.then(operation, operation))
    session.steering = task.catch(() => undefined)
    return task
  }

  /** Permissions and merge delegation are independent session settings. */
  setSafeMode(id: string, enabled: boolean): Promise<SafeModeAck> {
    if (typeof enabled !== 'boolean') throw new ChatError(400, 'enabled must be a boolean', 'invalid')
    const session = this.requireLive(id)
    return this.control(session, async () => {
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      if (session.lifecycle.signal.aborted || session.record.status === 'closed') throw new ChatError(409, 'the session is closed', 'no_turn')
      const record = session.record
      const previous = { safeMode: record.safeMode, safeModePending: record.safeModePending }
      record.safeMode = enabled
      record.safeModePending = !!session.adapter && session.nativeSafeMode !== enabled
      try { this.saveRecord(session) } catch (error) { Object.assign(record, previous); throw error }
      // Old allow-always grants must not silently disable a newly enabled checkpoint.
      session.grants.clear()
      this.emit_(id, { type: 'session.updated', session: record })
      let applies: SafeModeAck['applies'] = 'next_turn'
      let warning: string | undefined
      if (session.adapter?.alive && !session.startup && !session.turn?.stopping && session.nativeSafeMode !== enabled) {
        try {
          applies = await session.adapter.setSafeMode?.(enabled) ?? 'next_turn'
          if (applies === 'current_turn') session.nativeSafeMode = enabled
        } catch (error) {
          warning = `Safe mode ${enabled ? 'on' : 'off'} is saved, but the native agent could not switch yet: ${error instanceof Error ? error.message : String(error)}. It will apply on the next turn; Stop remains available.`
        }
      } else if (session.nativeSafeMode === enabled && !session.startup) applies = 'current_turn'
      // No native process means there is nothing still running with an old policy.
      record.safeModePending = !!session.adapter && session.nativeSafeMode !== enabled
      if (record.safeModePending && !warning) warning = `${AGENT_LABEL[record.agent]} applies this permission change on the next turn. The current turn keeps its previous native permissions.`
      if (!this.ownsSession(id) || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session closed while permissions were changing', 'no_turn')
      this.saveRecord(session)
      this.emit_(id, { type: 'session.updated', session: record })
      if (!enabled && session.turn && !session.turn.stopping) {
        for (const [requestId, pending] of session.pending) {
          const once = pending.kind === 'permission' && pending.options?.find(option => option.kind === 'allow_once')
          if (once) this.resolvePermission(session, requestId, once.id, 'unrestricted')
        }
      }
      return { session: this.withLive(record), applies, ...(warning ? { warning } : {}) }
    })
  }

  setAutoMerge(id: string, enabled: boolean): Promise<AutoMergeAck> {
    this.assertAcceptingWork()
    if (typeof enabled !== 'boolean') throw new ChatError(400, 'enabled must be a boolean', 'invalid')
    const session = this.requireLive(id)
    return this.control(session, async () => {
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      const previous = session.record.autoMerge
      if (previous === enabled) return { session: session.record, applies: 'next_turn' }
      session.record.autoMerge = enabled
      try { this.saveRecord(session) } catch (error) { session.record.autoMerge = previous; throw error }
      this.emit_(id, { type: 'session.updated', session: session.record })
      const turn = session.turn
      let applies: AutoMergeAck['applies'] = 'next_turn'
      let warning: string | undefined
      if (turn?.agentInvoked && !turn.stopping && !turn.abort.signal.aborted && session.adapter?.alive) {
        try {
          await session.adapter.steer(appendMemories(autoMergeInstructions(enabled, turn.implementsChange), readMemories().text))
          applies = 'current_turn'
        } catch (error) {
          warning = `Auto-merge ${enabled ? 'on' : 'off'} is saved for the next message, but the running agent could not receive the update: ${error instanceof Error ? error.message : String(error)}. Use Stop to end its current work.`
        }
      }
      // Merge delegation never overrides Safe mode or resolves its risk prompts.
      return { session: session.record, applies, ...(warning ? { warning } : {}) }
    })
  }

  async steer(id: string, text: string, context: Pick<PromptInput, 'attachments' | 'mentions'> = { attachments: [], mentions: [] }): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const turn = session.turn
    if (!turn || turn.stopping) throw new ChatError(409, 'no turn is running', 'no_turn')
    const shown = this.validatePrompt(id, { text, attachments: context.attachments, mentions: context.mentions })
    // Do not put this wait on the control chain: startup drains that chain
    // before invoking the prompt. Early interjections belong after that boundary.
    if (!turn.agentInvoked) await this.track(() => turn.promptReady)
    await this.control(session, async () => {
      if (session.turn !== turn || !turn.agentInvoked || turn.stopping || turn.abort.signal.aborted) throw new ChatError(409, 'the turn has ended', 'no_turn')
      if (!session.record.capabilities.steer) throw new ChatError(409, `${AGENT_LABEL[session.record.agent]} does not support steering`, 'unsupported')
      await this.serve(session, async () => {
        const resolved = await this.resolveInput(session, shown)
        if (session.turn !== turn || session.draining || turn.stopping || turn.abort.signal.aborted) throw new ChatError(409, 'the turn has ended', 'no_turn')
        const input = withAutoMergeInstructions({ ...resolved, text: steeringContext(resolved) }, session.record.autoMerge, turn.implementsChange)
        await session.adapter!.steer(appendMemories(input.text, readMemories().text))
        this.emit_(id, { type: 'steer.sent', turnId: turn.id, text: shown.text,
          ...(shown.attachments.length ? { attachments: shown.attachments } : {}), ...(shown.mentions.length ? { mentions: shown.mentions } : {}) })
      })
    })
  }

  /** Cancel the running turn. Resolves when the agent acknowledged or after
   *  the stop target elapsed with the session in `stopping` — never by
   *  pretending the turn ended. */
  cancel(id: string): Promise<{ settled: boolean }> {
    return this.track(async () => {
      const session = this.requireLive(id)
      pauseQueue(queueOwner(id))
      const timer = this.queueTimers.get(id)
      if (timer) { clearTimeout(timer); this.queueTimers.delete(id) }
      this.queueReleaseWait.delete(id)
      this.publishQueue(session)
      session.startup?.abort()
      const turn = session.turn
      if (!turn) {
        const deadline = Date.now() + STOP_SETTLE_MS
        while (session.startup && Date.now() < deadline) await delay(25)
        return { settled: !session.startup }
      }
      turn.stopping = true
      this.settlePending(session, 'cancelled')
      turn.abort.abort()
      try { await session.adapter?.cancel() } catch { /* the abort signal also reaches prompt() */ }
      const settled = await this.waitForTurnEnd(session, STOP_SETTLE_MS)
      if (!settled) this.setStatus(session, 'stopping', 'the agent has not acknowledged the stop yet')
      return { settled }
    })
  }

  private waitForTurnEnd(session: LiveSession, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    return new Promise((resolve) => {
      const check = () => {
        if (!session.turn) resolve(true)
        else if (Date.now() >= deadline) resolve(false)
        else setTimeout(check, 25)
      }
      check()
    })
  }

  private async waitForServices(session: LiveSession, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (session.services > 0) {
      if (Date.now() >= deadline) return false
      await delay(25)
    }
    return true
  }

  // ── Requests from the agent ────────────────────────────────────────────

  respondPermission(id: string, requestId: string, optionId: string): void {
    this.resolvePermission(this.requireLive(id), requestId, optionId, 'user')
  }

  private resolvePermission(session: LiveSession, requestId: string, optionId: string, by: 'user' | 'auto_merge' | 'unrestricted'): void {
    const id = session.record.id
    const pending = session.pending.get(requestId)
    if (!pending || pending.kind !== 'permission') {
      // A request that outlived its process (crash, restart) is closed out
      // rather than left hanging in the transcript.
      if (storage.listPendingRequests(id).some((p) => p.requestId === requestId)) {
        this.emit_(id, { type: 'permission.resolved', id: requestId, optionId: '', by: 'cancelled' })
      }
      throw new ChatError(409, 'this permission request is no longer pending', 'no_turn')
    }
    const option = pending.options!.find((o) => o.id === optionId)
    if (!option) throw new ChatError(400, 'unknown option', 'invalid')
    // Keep the native waiter reachable until its decision is durable.
    this.emit_(id, { type: 'permission.resolved', id: requestId, optionId, by })
    session.pending.delete(requestId)
    // "Always" means this session, in Poise's memory — never the agent's own
    // persistence, which outlives the session. The agent is told "once".
    let onWire = optionId
    if (option.kind === 'allow_always' || option.kind === 'reject_always') {
      if (pending.grantKey) session.grants.set(pending.grantKey, { id: optionId, kind: option.kind })
      const once = pending.options!.find((o) => o.kind === (option.kind === 'allow_always' ? 'allow_once' : 'reject_once'))
      if (once) onWire = once.id
    }
    pending.resolve(onWire)
    this.afterRequestAnswered(session)
  }

  answerQuestion(id: string, requestId: string, answers: QuestionAnswers): void {
    const session = this.requireLive(id)
    const pending = session.pending.get(requestId)
    if (!pending || pending.kind !== 'question') {
      if (storage.listPendingRequests(id).some((p) => p.requestId === requestId)) {
        this.emit_(id, { type: 'question.answered', id: requestId, answers: {}, by: 'cancelled' })
      }
      throw new ChatError(409, 'this question is no longer pending', 'no_turn')
    }
    const validated = validateAnswers(pending.questions ?? [], answers)
    this.emit_(id, { type: 'question.answered', id: requestId, answers: validated, by: 'user' })
    session.pending.delete(requestId)
    pending.resolve(validated)
    this.afterRequestAnswered(session)
  }

  private afterRequestAnswered(session: LiveSession): void {
    if (session.turn && !session.turn.stopping && session.pending.size === 0 && session.record.status === 'waiting') this.setStatus(session, 'running')
  }

  private settlePending(session: LiveSession, by: 'cancelled'): void {
    for (const [requestId, pending] of session.pending) {
      session.pending.delete(requestId)
      try {
        this.emit_(session.record.id, pending.kind === 'permission'
          ? { type: 'permission.resolved', id: requestId, optionId: '', by }
          : { type: 'question.answered', id: requestId, answers: {}, by })
      } catch { /* mirror failure is handled by the turn */ }
      pending.reject(new Error('cancelled'))
    }
  }

  // ── Model, mode, revert ────────────────────────────────────────────────

  async setModel(id: string, identity: string, effortOverride?: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (session.turn) throw new ChatError(409, 'Choose a model for the next task or change it between turns.', 'turn_in_progress')
    return this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'A turn started before the model could change.', 'turn_in_progress')
      if (session.record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'The session is closed.', 'no_turn')
      await this.selectSessionModel(session, identity, effortOverride)
      return session.record
    })
  }

  async setMode(id: string, mode: string): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    await this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'change the mode between turns', 'turn_in_progress')
      if (!session.adapter?.alive) await this.startSession(session)
      if (!session.record.capabilities.modes) throw new ChatError(409, `${AGENT_LABEL[session.record.agent]} sessions have no modes`, 'unsupported')
      await session.adapter!.setMode(mode)
      session.record.mode = mode
      this.saveRecord(session)
    })
  }

  async revert(id: string, diffId: string): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const found = storage.findEvent(id, (e) => e.type === 'diff' && e.diffId === diffId)
    if (!found || found.event.type !== 'diff') throw new ChatError(404, 'unknown change', 'invalid')
    const diff: RecordedDiff = found.event
    await this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'revert after the turn finishes', 'turn_in_progress')
      const lease = this.leaseFor(session)
      try {
        await lease.acquire({ signal: session.lifecycle.signal, onBusy: (busy) => this.reportBusy(session, busy) })
        const state = await inspectCheckout(session.record.checkout)
        if (state.currentBranch !== session.record.branch.name) {
          throw new GitError(`the checkout is on ${state.currentBranch}, not ${session.record.branch.name}; switch back before reverting`, 'branch_drift')
        }
        await revertDiff(lease, session.record.checkout, diff)
        this.emit_(id, { type: 'diff.reverted', diffId, path: diff.path, ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.emit_(id, { type: 'diff.reverted', diffId, path: diff.path, ok: false, error: message })
        throw new ChatError(409, message, 'checkout_dirty')
      } finally {
        if (lease.held) lease.release()
        await this.refreshWorkspace(session).catch(() => undefined)
      }
    })
  }

  // ── Checkout and branch ────────────────────────────────────────────────

  private leaseFor(session: LiveSession): CheckoutLease {
    const record = session.record
    return new CheckoutLease(record.checkout, {
      ownerKind: 'poise:chat',
      ownerId: record.id,
      ownerLabel: `chat "${record.title}" on ${record.branch.name} (Poise ${this.options.instanceLabel})`,
      instance: this.instance,
      branch: record.branch.name,
    }, this.leaseProbes)
  }

  private reportBusy(session: LiveSession, busy: Extract<AcquireResult, { acquired: false }>): void {
    const label = describeHolder(busy.holder) + (busy.orphan ? ' — its worker is still running' : '')
    if (session.record.queuedBehind !== label || session.record.status !== 'queued') {
      session.record.queuedBehind = label
      this.setStatus(session, 'queued', label)
    }
  }

  /** Fresh session: cut/verify/check out its branch under the lease. */
  private async prepareBranch(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const checkout = record.checkout
    if (record.branch.origin === 'pr') {
      await this.makeCheckoutSwitchable(session, lease)
      record.branch.name = await checkoutPrHead(lease, checkout, record.branch.pr!)
      this.saveRecord(session)
      return
    }
    if (record.branch.origin === 'existing') {
      if (!(await branchExists(checkout, record.branch.name))) throw new GitError(`branch ${record.branch.name} does not exist in ${checkout}`, 'invalid')
      return
    }
    const state = await inspectCheckout(checkout)
    record.branch.baseSha = await createBranch(lease, checkout, record.branch.name, state.defaultBranch)
    this.saveRecord(session)
  }

  /** The checkout must be on the session's branch before the agent runs.
   *  The outgoing session's uncommitted work is committed on its own
   *  branch; a dirty checkout on a branch no session owns is refused by name. */
  private async prepareCheckout(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const state = await inspectCheckout(record.checkout)
    if (state.currentBranch === record.branch.name) { lease.setBranch(record.branch.name); return }
    await this.makeCheckoutSwitchable(session, lease)
    await switchBranch(lease, record.checkout, record.branch.name)
    lease.setBranch(record.branch.name)
  }

  private async makeCheckoutSwitchable(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const state = await inspectCheckout(record.checkout)
    if (!state.dirty) return
    const owner = storage.listSessions(this.instance).find((s) => s.checkout === record.checkout && s.branch.name === state.currentBranch && s.status !== 'closed')
    if (!owner) {
      throw new GitError(`the checkout at ${record.checkout} has ${state.dirtyFiles} uncommitted change(s) on ${state.currentBranch || 'a detached HEAD'}, which no chat session owns; commit or stash them yourself`, 'dirty_unowned')
    }
    const result = await checkpoint(lease, record.checkout, state.currentBranch)
    if (result.committed) {
      const ownerLive = this.live.get(owner.id)
      if (ownerLive) {
        ownerLive.record.branch.provisional = false
        this.saveRecord(ownerLive)
      } else {
        owner.branch.provisional = false
        storage.saveSession(owner)
      }
      this.emit_(record.id, { type: 'status.changed', status: session.record.status, detail: `checkpointed ${owner.title}'s changes on ${state.currentBranch}` })
    }
  }

  private async refreshWorkspace(session: LiveSession): Promise<void> {
    try {
      const state = await inspectCheckout(session.record.checkout)
      const workspace: WorkspaceState = {
        currentBranch: state.currentBranch,
        onBranch: state.currentBranch === session.record.branch.name,
        dirty: state.dirty,
        dirtyFiles: state.dirtyFiles,
        checkedAt: new Date().toISOString(),
      }
      session.record.workspace = workspace
      this.saveRecord(session)
    } catch { /* not a git checkout yet; the header shows nothing */ }
  }

  // ── Process and host ───────────────────────────────────────────────────

  private hostFor(session: LiveSession): AdapterHost {
    const record = session.record
    return {
      sessionId: record.id,
      checkout: record.checkout,
      spawn: async (command, args, options) => this.spawnAgent(session, command, args, options?.env),
      emit: (event) => {
        if (session.record.status === 'closed') return
        try {
          this.emit_(record.id, event)
        } catch (error) {
          // An unrecorded transcript is not a transcript: the turn stops.
          const turn = session.turn
          if (turn && !turn.failure) {
            turn.failure = `the transcript could not be recorded: ${error instanceof Error ? error.message : String(error)}`
            turn.abort.abort()
            void session.adapter?.cancel()
          }
        }
      },
      requestPermission: (request) => this.askPermission(session, request),
      askQuestion: (request) => this.askUser(session, request),
      readTextFile: (path, options) => this.serve(session, () => readCheckoutTextFile(record.checkout, path, options)),
      writeTextFile: (path, content) => this.serve(session, () => writeCheckoutTextFile(record.checkout, path, content)),
      log: (message) => this.emit('log', `[chat ${record.id.slice(0, 8)}] ${message}`),
    }
  }

  /** Poise-served file operations run only for a turn that holds the
   *  checkout lease on the session's branch; anything else is refused. */
  private async serve<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    const turn = session.turn
    if (!turn || turn.stopping || turn.abort.signal.aborted || session.draining) throw new Error('no turn is running; file services are closed')
    if (!session.lease?.held) throw new Error('the checkout lease is not held; file services are closed')
    // Admission, including its branch check, is part of the service lifetime.
    session.services += 1
    try {
      const head = await runFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: session.record.checkout, timeoutMs: 10_000 }).then((r) => r.stdout.trim()).catch(() => '')
      if (head !== session.record.branch.name) throw new Error(`the checkout is on ${head || 'a detached HEAD'}, not ${session.record.branch.name}; file services are closed`)
      if (session.turn !== turn || turn.stopping || turn.abort.signal.aborted || session.draining || !session.lease?.held) throw new Error('the turn is settling; file services are closed')
      return await operation()
    } finally {
      session.services -= 1
    }
  }

  private async spawnAgent(session: LiveSession, command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ChildProcess> {
    if (session.lifecycle.signal.aborted || session.startup?.signal.aborted || session.turn?.abort.signal.aborted) throw new Error('agent startup was cancelled')
    if (session.worker?.alive) throw new Error('the session already has a worker')
    const record = session.record
    const lease = session.lease
    if (!lease?.held) throw new Error('the checkout lease is not held; the agent cannot start')
    const worker = spawnWorker(command, args, {
      cwd: record.checkout,
      env,
      // The Claude SDK asks for `node <wrapper>`: scrub by the wrapper's name.
      envCommand: command === process.execPath && args[0] ? basename(args[0]) : undefined,
    })
    session.worker = worker
    storage.recordWorker({
      sessionId: record.id,
      gatePid: worker.pid,
      gatePgid: worker.pgid,
      ident: worker.ident,
      checkout: record.checkout,
      leaseToken: lease.currentToken,
      command,
      startedAt: new Date().toISOString(),
    })
    // Registered before GO: nothing runs unregistered.
    if (!lease.registerWorker({ pid: worker.pid, pgid: worker.pgid, ident: worker.ident })) {
      await worker.terminate(1_000).catch(() => undefined)
      storage.forgetWorker(record.id)
      throw new Error('the checkout lease was lost before the agent could start')
    }
    worker.go()
    void worker.exited.then(() => {
      // Only a settled group is forgotten; a dead leader with live children
      // stays recorded so startup cleanup and the lease keep seeing it.
      if (session.worker === worker && !worker.alive) {
        session.worker = null
        storage.forgetWorker(record.id)
      }
    })
    return worker.child
  }

  private onAdapterExit(session: LiveSession, adapter: Adapter, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.adapter !== adapter) return
    if (session.record.status === 'closed') return
    const turn = session.turn
    try {
      if (turn && !turn.stopping) {
        this.emit_(session.record.id, { type: 'error', message: `${AGENT_LABEL[session.record.agent]} exited (${code ?? signal ?? 'unknown'}) during the turn`, recoverable: true })
      }
      if (!turn) this.setStatus(session, 'interrupted', `${AGENT_LABEL[session.record.agent]} exited (${code ?? signal ?? 'unknown'})`)
    } catch { /* mirror */ }
  }

  /** Close the adapter and terminate its process group, verified. On
   *  failure the worker stays recorded, the session says so, and the error
   *  propagates so no caller releases the checkout. */
  private async stopProcess(session: LiveSession): Promise<void> {
    const adapter = session.adapter
    session.adapter = null
    if (adapter) { try { await adapter.close() } catch { /* terminating below */ } }
    const worker = session.worker
    if (!worker) return
    try {
      await worker.terminate(CLOSE_GRACE_MS)
    } catch (error) {
      session.record.orphanNotice = error instanceof Error ? error.message : String(error)
      this.saveRecord(session)
      try { this.emit_(session.record.id, { type: 'error', message: session.record.orphanNotice, recoverable: false }) } catch { /* mirror */ }
      throw error
    }
    if (session.worker === worker) session.worker = null
    storage.forgetWorker(session.record.id)
  }

  private async askPermission(session: LiveSession, request: PermissionRequest): Promise<string> {
    const turn = session.turn
    if (!turn || turn.stopping) throw new Error('no turn is running')
    if (request.signal?.aborted) throw new Error('permission is no longer pending')
    const grantKey = `${request.title}\0${canonicalJson(request.input)}`
    const granted = session.grants.get(grantKey)
    const requestId = randomUUID()
    const remembered = granted ? request.options.find(option => option.id === granted.id && option.kind === granted.kind) : undefined
    if (granted && remembered && (remembered.kind === 'allow_always' || remembered.kind === 'reject_always')) {
      const onWire = request.options.find((o) => o.kind === (remembered.kind === 'reject_always' ? 'reject_once' : 'allow_once'))
      this.emit_(session.record.id, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
      this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: granted.id, by: 'session' })
      return onWire?.id ?? granted.id
    }
    if (granted) session.grants.delete(grantKey) // Native choices changed: never reinterpret an old decision.
    const once = session.record.safeMode !== true && request.options.find(option => option.kind === 'allow_once')
    if (once) {
      this.emit_(session.record.id, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
      this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: once.id, by: 'unrestricted' })
      return once.id
    }
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => request.signal?.removeEventListener('abort', superseded)
      const superseded = () => {
        if (!session.pending.delete(requestId)) return
        cleanup()
        // The native request is already obsolete. Always release its waiter,
        // even if its cancellation cannot be recorded; never throw from an
        // AbortSignal listener and crash the server with an unanswered promise.
        reject(new Error('permission is no longer pending'))
        try {
          this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: '', by: 'cancelled' })
          this.afterRequestAnswered(session)
        } catch (error) {
          const message = `the withdrawn permission could not be recorded: ${error instanceof Error ? error.message : String(error)}`
          this.emit('log', `[chat ${session.record.id.slice(0, 8)}] ${message}`)
          if (session.turn === turn) {
            turn.failure ??= message
            turn.abort.abort()
            void session.adapter?.cancel().catch(failure => this.emit('log', `[chat] cancellation failed: ${String(failure)}`))
          }
        }
      }
      session.pending.set(requestId, { kind: 'permission', turnId: turn.id, options: request.options, grantKey,
        resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
      request.signal?.addEventListener('abort', superseded, { once: true })
      this.emit_(session.record.id, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
      this.setStatus(session, 'waiting')
    })
  }

  private async askUser(session: LiveSession, request: QuestionRequest): Promise<QuestionAnswers> {
    const turn = session.turn
    if (!turn || turn.stopping) throw new Error('no turn is running')
    const requestId = randomUUID()
    return new Promise<QuestionAnswers>((resolve, reject) => {
      session.pending.set(requestId, { kind: 'question', turnId: turn.id, questions: request.questions, resolve, reject })
      this.emit_(session.record.id, { type: 'question.asked', id: requestId, turnId: turn.id, toolId: request.toolId, questions: request.questions })
      this.setStatus(session, 'waiting')
    })
  }

  private armIdleTimer(session: LiveSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    const minutes = this.idleTimeoutMinutes()
    if (!Number.isFinite(minutes) || minutes <= 0) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turn || !session.adapter) return
      void this.serialized(session, async () => {
        if (session.turn) return
        await this.stopProcess(session)
        this.emit_(session.record.id, { type: 'status.changed', status: 'idle', detail: 'agent process closed after idle timeout; it resumes on the next prompt' })
      }).catch(() => undefined)
    }, minutes * 60_000)
    session.idleTimer.unref()
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private setStatus(session: LiveSession, status: SessionStatus, detail?: string): void {
    session.record.status = status
    if (status !== 'queued') session.record.queuedBehind = undefined
    this.saveRecord(session)
    this.emit_(session.record.id, { type: 'status.changed', status, queuedBehind: session.record.queuedBehind, detail })
  }

  private saveRecord(session: LiveSession): void {
    session.record.updatedAt = new Date().toISOString()
    storage.saveSession(session.record)
  }

  /** Append to the mirror, then broadcast. Throws when the mirror cannot be
   *  written; callers that run on the agent's behalf turn that into a stop. */
  private emit_(sessionId: string, event: ChatEvent): ChatEnvelope {
    if (event.type === 'session.created' || event.type === 'session.resumed' || event.type === 'session.updated') {
      event = { ...event, session: this.withLive(event.session) }
    }
    const envelope = storage.appendEvent(sessionId, event)
    const live = this.live.get(sessionId)
    if (live) live.record.lastSeq = envelope.seq
    this.emit('event', envelope)
    return envelope
  }

  /** For Swarm and Stop: the session and turn behind a Caller call id. */
  describeTurn(callId: string): { sessionId: string, turnId: string, events: Array<{ at: string, message: string }> } | null {
    for (const record of storage.listSessions(this.instance)) {
      const started = storage.findEvent(record.id, (e) => e.type === 'turn.started' && e.callId === callId)
      const open = storage.getOpenTurn(record.id)
      const turnId = started?.event.type === 'turn.started' ? started.event.turnId : open?.callId === callId ? open.turnId : null
      if (!turnId) continue
      const { events } = storage.listEvents(record.id, 0)
      const summary = events
        .filter((e) => 'turnId' in e.event && (e.event as any).turnId === turnId && (e.event.type === 'tool.started' || e.event.type === 'turn.finished' || e.event.type === 'permission.requested'))
        .slice(-40)
        .map((e) => ({ at: e.at, message: e.event.type === 'tool.started' ? `${e.event.kind}: ${e.event.title}` : e.event.type === 'permission.requested' ? `waiting for permission: ${e.event.title}` : `turn ${(e.event as any).stopReason}` }))
      return { sessionId: record.id, turnId, events: summary }
    }
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function defaultProbeAgent(agent: AgentId): Promise<{ ok: boolean, reason?: string }> {
  const command = AGENT_COMMAND[agent]
  try {
    await runFile(command, ['--version'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 })
    return { ok: true }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: false, reason: `${command} is not installed on the PATH the server runs with` }
    return { ok: false, reason: `${command} --version failed: ${String(error?.stderr || error?.message || error).trim().slice(0, 200)}` }
  }
}

function normalizeBranchRequest(branch: BranchRequest, prefix: string): { name: string, origin: 'new' | 'existing' | 'pr', pr?: number } {
  if (!branch || typeof branch !== 'object') throw new ChatError(400, 'branch is required', 'invalid')
  if ('pr' in branch) {
    const pr = Number(branch.pr)
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new ChatError(400, 'pr must be a positive integer', 'invalid')
    return { name: `github-interface-pr-${pr}`, origin: 'pr', pr }
  }
  if ('existing' in branch) {
    try { return { name: assertBranchName(branch.existing), origin: 'existing' } } catch (error) { throw new ChatError(400, (error as Error).message, 'invalid') }
  }
  if ('new' in branch) {
    const raw = String(branch.new || '').trim()
    const name = raw.includes('/') || raw.startsWith(prefix) ? raw : `${prefix}${raw}`
    try { return { name: assertBranchName(name), origin: 'new' } } catch (error) { throw new ChatError(400, (error as Error).message, 'invalid') }
  }
  throw new ChatError(400, 'branch must be { new }, { existing } or { pr }', 'invalid')
}

function validateAnswers(questions: Question[], answers: unknown): QuestionAnswers {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ChatError(400, 'answers must be an object', 'invalid')
  const input = answers as Record<string, unknown>
  const out: QuestionAnswers = {}
  for (const question of questions) {
    const value = input[question.id]
    if (value === undefined) throw new ChatError(400, `question "${question.question}" was not answered`, 'invalid')
    const labels = new Set(question.options.map((o) => o.label))
    if (question.multiSelect) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length <= 2_000)) throw new ChatError(400, 'multi-select answers must be an array of strings', 'invalid')
      if (!question.freeText && !value.every((v) => labels.has(v))) throw new ChatError(400, 'an answer is not one of the offered options', 'invalid')
      out[question.id] = value
    } else {
      if (typeof value !== 'string' || value.length > 2_000) throw new ChatError(400, 'an answer must be a string', 'invalid')
      if (!question.freeText && !labels.has(value)) throw new ChatError(400, 'an answer is not one of the offered options', 'invalid')
      out[question.id] = value
    }
  }
  return out
}

function changeIdConflict(): ChatError {
  return new ChatError(409, 'this change id was already used for a different request or session; start the request again', 'invalid')
}

/** The implementing turn of a change session is its first turn; its
 *  terminal event, if any, is the change's outcome — later discussion is not. */
function implementingTurnOutcome(sessionId: string): { started: boolean, finished: Extract<ChatEvent, { type: 'turn.finished' }> | null } {
  let cursor = 0
  let turnId: string | null = null
  while (turnId === null) {
    const page = storage.listEvents(sessionId, cursor)
    for (const { event } of page.events) {
      if (event.type === 'turn.started') { turnId = event.turnId; break }
    }
    if (turnId !== null || !page.truncated || !page.events.length) break
    cursor = page.events[page.events.length - 1].seq
  }
  if (turnId === null) return { started: false, finished: null }
  const found = storage.findEvent(sessionId, (e) => e.type === 'turn.finished' && e.turnId === turnId)
  return { started: true, finished: found?.event.type === 'turn.finished' ? found.event : null }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Recursive canonical form: nested input keys count, so two commands that
 *  differ below the top level never share a permission grant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`).join(',')}}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitDead(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (pgidAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await delay(50)
  }
  return true
}

export function emptyCapabilities() {
  return { steer: false, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: false, questions: false, resume: false, images: false }
}

export type { SessionContext }
