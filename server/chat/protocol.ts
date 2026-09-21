// Chat v1 wire contract — one vocabulary for the runtime, the adapters and the
// browser. ACP-shaped because Grok speaks ACP natively and the other three
// agents map onto it with little loss. These objects go over the WebSocket
// unchanged and are what the SQLite transcript mirror stores, so this file has
// no runtime imports: the client bundles it as types only.
//
// Every event the runtime emits for a session is appended to `chat_events`
// with a strictly increasing `seq`; a browser that reconnects asks for
// everything after the last `seq` it acknowledged and renders the transcript
// from the mirror alone — the agent is never woken to show history.

import type { SelfChange } from '../../src/self-update-types'

export type AgentId = 'claude' | 'codex' | 'grok' | 'muse'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'grok', 'muse']

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  muse: 'Muse',
}

/** Which optional controls the view shows for a session. `permissions`,
 *  `questions`, `steer` and `resume` are required of every v1 adapter; the
 *  rest are honest flags — a control for a false flag is hidden, never faked. */
export interface Capabilities {
  steer: boolean
  fork: boolean
  thought: boolean
  plan: boolean
  commands: boolean
  modes: boolean
  permissions: boolean
  questions: boolean
  resume: boolean
  images: boolean
}

export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stopping'
  | 'interrupted'
  | 'closed'
  | 'error'

export type BranchOrigin = 'new' | 'existing' | 'pr'

export interface BranchBinding {
  /** The branch the session is bound to for its whole life. */
  name: string
  origin: BranchOrigin
  /** Pull request number when `origin === 'pr'`. */
  pr?: number
  /** True while a Poise-created branch has received no commit; such a branch
   *  is deleted together with the session. */
  provisional: boolean
  /** Commit a Poise-created branch started at; the branch is only deleted
   *  while its tip is still exactly this. */
  baseSha?: string
}

/** A queued task is not a native prompt until a preceding turn completes. */
export interface QueuedMessage {
  /** Validated attachment/mention provenance across an isolated Poise handoff. */
  sourceSessionId?: string
  id: string
  prompt: PromptInput
  agent: AgentId
  model: string
  effort: string
  createdAt: string
  state: 'waiting' | 'running' | 'failed'
  turnId?: string
  error?: string
}
export interface MessageQueue {
  executorSessionId?: string
  waitingForRelease?: boolean
  revision: number
  ready: boolean
  items: QueuedMessage[]
}

export interface SessionRecord {
  /** Server-owned pending tasks; never copied when a session is forked. */
  queue?: MessageQueue
  /** A queued cross-agent handoff survives a startup failure or restart. */
  queuedHandoff?: string
  id: string
  agent: AgentId
  /** Catalog identity, e.g. `opus-5-max`. */
  model: string
  /** Native model selector the adapter launched with, e.g. `claude-opus-5`. */
  modelId: string
  effort: string
  /** `owner/name` of the repository, or `''` for a bare local checkout. */
  repo: string
  /** Absolute canonical path of the checkout the session runs in. */
  checkout: string
  /** `poise-local`: Poise-owned scratch storage. `poise-change`: a checkout
   *  the self-update controller prepared for one `/poise` change; the
   *  session was created by the server, never from a browser repo choice. */
  workspaceKind?: 'poise-local' | 'poise-change'
  /** The self-update change this session implements (`workspaceKind` is
   *  `poise-change`). Its first turn's settlement is reported to the controller. */
  selfChangeId?: string
  /** Immutable attachment/mention identity for retry conflict detection. */
  selfChangeContextKey?: string
  /** User-enabled, session-scoped delegation to finish and merge the requested PRs in any repository. Missing means off. */
  autoMerge?: boolean
  /** Off/missing: unrestricted tools. On: native risk-based approvals, still unsandboxed. */
  safeMode?: boolean
  /** The native process cannot apply the saved choice until its next turn. */
  safeModePending?: boolean
  branch: BranchBinding
  title: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  /** Who holds the checkout while this session is `queued`. */
  queuedBehind?: string
  /** Native session/thread id kept for resume. Absent until the adapter created one. */
  nativeSessionId?: string
  capabilities: Capabilities
  mode?: string
  modes?: ModeOption[]
  commands?: CommandOption[]
  /** Efforts the agent advertises for the current model, when it does. */
  efforts?: string[]
  /** Last event sequence written for this session. */
  lastSeq: number
  /** Unanswered permission/question requests, by id. */
  pendingRequests: string[]
  forkedFrom?: string
  /** Which Poise server owns the session: `poise-dev:<db>` or `poise-prod:<db>`. */
  instance: string
  /** Set when a turn was cut by a crash or restart and never replayed. */
  interruptedTurnId?: string
  /** Set when the session's worker could not be verified for cleanup. */
  orphanNotice?: string
  /** Optional context handed over at creation (card, document, another session). */
  context?: SessionContext
  /** What the checkout looks like right now, refreshed on every status change. */
  workspace?: WorkspaceState
  /** The Editor document copy this session owns inside its checkout, when it
   *  has document context. Persisted so a restart neither loses the binding
   *  nor mistakes another session's copy for this one's. */
  staged?: StagedDocument
}

/** A session's own copy of an Editor document inside the checkout, at
 *  `.poise-chat/docs/<sessionId>/<slug>.md`. One session, one copy: the path
 *  carries the session id so two sessions on one document never share a file. */
export interface StagedDocument {
  slug: string
  /** Checkout-relative path of the staged copy. */
  path: string
  /** Editor version the copy was taken from. */
  baseVersion: string
  /** sha256 of the staged content, to tell an agent edit from an untouched copy. */
  stagedHash: string
  revision: number
  /** Set when the copy's content was taken from another session's stage (a fork). */
  provenance?: { fromSession: string }
}

export interface WorkspaceState {
  /** Branch currently checked out in the shared checkout. */
  currentBranch: string
  /** True when the checkout is on this session's branch. */
  onBranch: boolean
  /** Uncommitted changes (tracked or untracked, not ignored) in the checkout. */
  dirty: boolean
  dirtyFiles: number
  /** Who holds the checkout lock when it is not this session. */
  lockedBy?: string
  checkedAt: string
}

export interface SessionContext {
  /** `poise-change`: the exact `/poise` request (`body`) and the session it
   *  was typed in (`fromSession`); the server composes the first prompt. */
  kind: 'card' | 'document' | 'handoff' | 'poise-change'
  title: string
  body?: string
  url?: string
  headSha?: string
  /** Editor document slug for `document` context. */
  slug?: string
  /** Source session for an explicit cross-agent handoff or a `/poise` change. */
  fromSession?: string
}

export interface ModeOption { id: string, name: string, description?: string }
export interface CommandOption { name: string, description?: string, hint?: string }

export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ContentBlock =
  | { type: 'text', text: string }
  | { type: 'terminal', text: string, exitCode?: number | null, truncated?: boolean }
  | { type: 'diff', path: string, oldText: string, newText: string, previewOnly?: boolean }

export interface ToolLocation { path: string, line?: number }

/** Tool cards are keyed by `turnId + id`: native tool ids can recur across
 *  turns. A `diff` carries its own `diffId` so a Revert always reverses one
 *  recorded change and never a later edit of the same file. `oldExists` /
 *  `newExists` distinguish a created or deleted file from an empty one. */

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error' | 'interrupted'

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionOption { id: string, name: string, kind: PermissionOptionKind }

export interface QuestionOption { label: string, description?: string }

export interface Question {
  id: string
  header?: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
  /** The agent accepts a free-text answer in addition to (or instead of) options. */
  freeText: boolean
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

export interface Attachment {
  /** Server-issued id; the record behind it is what a prompt is checked against. */
  id: string
  /** Display name. */
  name: string
  /** Path inside the checkout where the file was saved, relative to the checkout root. */
  path: string
  size: number
  /** Inlined text for text files under the inline limit. */
  text?: string
}

export interface Mention {
  /** Path relative to the checkout root. */
  path: string
}

export interface PromptInput {
  /** Runtime-only appendix; browsers cannot set it. Serialized last by every adapter. */
  memories?: string
  text: string
  attachments: Attachment[]
  mentions: Mention[]
}

// ── Events: runtime → view ────────────────────────────────────────────────

export type ChatEvent =
  | { type: 'session.created', session: SessionRecord }
  | { type: 'session.resumed', session: SessionRecord }
  | { type: 'session.updated', session: SessionRecord }
  | { type: 'queue.updated', queue: MessageQueue }
  | { type: 'session.closed', reason: string }
  | { type: 'status.changed', status: SessionStatus, queuedBehind?: string, detail?: string }
  | { type: 'turn.started', turnId: string, prompt: PromptInput, callId?: string, queueItemId?: string, agent?: AgentId, model?: string }
  | { type: 'steer.sent', turnId: string, text: string, attachments?: Attachment[], mentions?: Mention[] }
  | { type: 'turn.finished', turnId: string, stopReason: StopReason, error?: string, usage?: TurnUsage, durationMs?: number }
  | { type: 'text.delta', turnId: string, messageId: string, delta: string }
  | { type: 'thought.delta', turnId: string, messageId: string, delta: string }
  | { type: 'tool.started', turnId: string, id: string, kind: ToolKind, title: string, locations?: ToolLocation[], input?: unknown }
  | { type: 'tool.updated', turnId: string, id: string, kind?: ToolKind, title?: string, status?: ToolStatus, content?: ContentBlock[], locations?: ToolLocation[] }
  | { type: 'tool.finished', turnId: string, id: string, status: ToolStatus, content?: ContentBlock[], durationMs?: number }
  | { type: 'diff', turnId: string, toolId: string, diffId: string, path: string, oldText: string, newText: string, oldExists: boolean, newExists: boolean, unified?: boolean, previewOnly?: boolean }
  | { type: 'diff.reverted', diffId: string, path: string, ok: boolean, error?: string }
  | { type: 'plan.updated', turnId: string, entries: PlanEntry[], explanation?: string }
  | { type: 'permission.requested', id: string, turnId: string, toolId?: string, title: string, description?: string, input?: unknown, options: PermissionOption[] }
  | { type: 'permission.resolved', id: string, optionId: string, by: 'user' | 'session' | 'auto_merge' | 'unrestricted' | 'cancelled' }
  | { type: 'question.asked', id: string, turnId: string, toolId?: string, questions: Question[] }
  | { type: 'question.answered', id: string, answers: Record<string, string | string[]>, by: 'user' | 'cancelled' }
  | { type: 'commands.updated', commands: CommandOption[] }
  | { type: 'mode.updated', mode: string, modes: ModeOption[] }
  | { type: 'model.updated', model: string, modelId: string, effort: string, efforts?: string[] }
  | { type: 'error', message: string, recoverable: boolean }

export type ChatEventType = ChatEvent['type']

/** One persisted transcript row, as the browser receives it. */
export interface ChatEnvelope {
  seq: number
  sessionId: string
  at: string
  event: ChatEvent
}

// ── Commands: view → runtime ──────────────────────────────────────────────

export type BranchRequest = { new: string } | { existing: string } | { pr: number }

export interface NewSessionRequest {
  agent: AgentId
  /** Catalog identity. */
  model: string
  /** Optional effort override, one of the agent's advertised efforts. */
  effort?: string
  repo?: string
  branch?: BranchRequest
  title?: string
  context?: SessionContext
  /** Explicit fallback choice when the default provider is not signed in. */
  fallbackModel?: string
  /** Save queue storage without starting a native session or a turn. */
  deferStart?: boolean
  autoMerge?: boolean
  safeMode?: boolean
}

export type ChatCommand =
  | { type: 'subscribe', sessionId: string, afterSeq: number }
  | { type: 'unsubscribe', sessionId: string }
  | { type: 'session.list' }
  | ({ type: 'session.new' } & NewSessionRequest)
  | { type: 'session.resume', id: string }
  | { type: 'session.fork', id: string }
  | { type: 'session.close', id: string }
  | { type: 'session.delete', id: string }
  | { type: 'session.rename', id: string, title: string }
  | { type: 'prompt', sessionId: string, text: string, attachments?: Attachment[], mentions?: Mention[] }
  | { type: 'queue.add', sessionId: string, itemId: string, text: string, attachments?: Attachment[], mentions?: Mention[], model?: string, effort?: string }
  | { type: 'queue.update', sessionId: string, itemId: string, model: string, effort?: string }
  | { type: 'queue.remove', sessionId: string, itemId: string }
  | { type: 'steer', sessionId: string, text: string, attachments?: Attachment[], mentions?: Mention[] }
  | { type: 'cancel', sessionId: string }
  | { type: 'permission.respond', sessionId: string, id: string, optionId: string }
  | { type: 'question.answer', sessionId: string, id: string, answers: Record<string, string | string[]> }
  | { type: 'set_model', sessionId: string, model: string, effort?: string }
  | { type: 'set_mode', sessionId: string, mode: string }
  | { type: 'set_auto_merge', sessionId: string, enabled: boolean }
  | { type: 'set_safe_mode', sessionId: string, enabled: boolean }
  | { type: 'revert', sessionId: string, diffId: string }
  /** Implement and auto-release one Poise change. Only ever sent by the
   *  browser for a typed `/poise …` message; `changeId` is minted once per
   *  request so a resend after an in-doubt answer never starts a second
   *  change. The ack is a `PoiseChangeAck`. */
  | { type: 'poise.change', sessionId: string, text: string, changeId: string, attachments?: Attachment[], mentions?: Mention[] }

export interface SafeModeAck { session: SessionRecord, applies: 'current_turn' | 'next_turn', warning?: string }

export interface AutoMergeAck { session: SessionRecord, applies: 'current_turn' | 'next_turn', warning?: string }

export type ChatCommandType = ChatCommand['type']

/** Ack payload of `poise.change`: the dedicated session the change runs in
 *  (already selected model, controller-prepared checkout) and the change. */
export interface PoiseChangeAck { session: SessionRecord, change: SelfChange }

/** Client → server frame. `id` is a client-chosen request id; a frame with an
 *  id the server already answered is answered again from its cache instead of
 *  being executed twice. */
export interface ClientFrame {
  id: string
  command: ChatCommand
}

/** Server → client frames. */
export type ServerFrame =
  | { kind: 'ack', id: string, ok: true, result?: unknown }
  | { kind: 'ack', id: string, ok: false, error: string, code?: string }
  | { kind: 'event', envelope: ChatEnvelope }
  | { kind: 'hello', instance: string, serverStartedAt: string }
  | { kind: 'gap', sessionId: string, fromSeq: number, toSeq: number }

/** Error codes a command ack can carry. */
export type ChatErrorCode =
  | 'turn_in_progress'
  | 'no_turn'
  | 'unknown_session'
  | 'foreign_session'
  | 'checkout_busy'
  | 'checkout_dirty'
  | 'unsupported'
  | 'invalid'
  | 'compat'
  | 'agent_error'
  /** Poise is installing an update: new work is refused until it restarts. */
  | 'draining'
  /** `/poise` needs the separately installed self-update controller. */
  | 'self_update_unavailable'

export const WS_PATH = '/ws/chat'

/** Hard bounds shared by the server and the client. */
export const CHAT_LIMITS = {
  frameBytes: 1 * 1024 * 1024,
  promptBytes: 256 * 1024,
  attachmentBytes: 2 * 1024 * 1024,
  inlineAttachmentBytes: 64 * 1024,
  titleChars: 200,
  /** Terminal output kept per tool card; more is truncated with a marker. */
  toolOutputBytes: 256 * 1024,
  /** Events a subscriber can be behind before the server closes the socket. */
  outboundQueue: 2_000,
} as const
