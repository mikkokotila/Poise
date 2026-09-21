// The plug between the session runtime and one native agent process.
//
// One adapter instance owns one native session (Grok ACP session, Claude SDK
// query, Codex thread, Muse session) inside one process. The runtime owns
// everything else: the checkout, the transcript mirror, the browser, the
// permission memory, the Caller row. An adapter translates the agent's own
// protocol into `ChatEvent`s and asks the host to answer the agent's
// requests; it never persists anything and never talks to the browser.

import type { ChildProcess } from 'node:child_process'
import type {
  AgentId,
  Capabilities,
  ChatEvent,
  CommandOption,
  ModeOption,
  PermissionOption,
  PromptInput,
  Question,
  StopReason,
  TurnUsage,
} from '../protocol'

/** Spawns the native agent through the registered worker gate (see
 *  server/chat/worker.ts). The returned process has piped stdio that is the
 *  agent's own stdin/stdout/stderr. */
export type SpawnAgent = (command: string, args: readonly string[], options?: {
  /** Overlaid on the scrubbed environment for `command`. */
  env?: NodeJS.ProcessEnv
}) => Promise<ChildProcess>

export interface PermissionRequest {
  /** Native request superseded or resolved elsewhere; closes its old UI card. */
  signal?: AbortSignal
  toolId?: string
  title: string
  description?: string
  input?: unknown
  options: PermissionOption[]
}

export interface QuestionRequest {
  toolId?: string
  questions: Question[]
}

export type QuestionAnswers = Record<string, string | string[]>

/** What the runtime offers an adapter. Every callback is scoped to the
 *  adapter's session; the runtime stamps `sessionId` and `seq`. */
export interface AdapterHost {
  readonly sessionId: string
  /** Absolute canonical checkout path — the agent's cwd. */
  readonly checkout: string
  spawn: SpawnAgent
  /** Emit one transcript event. Events that belong to a turn carry the
   *  `turnId` the runtime handed to `prompt()`. */
  emit(event: ChatEvent): void
  /** Ask the user; resolves with the chosen option id. Rejects when the turn
   *  is cancelled — the adapter then answers the agent with its reject option. */
  requestPermission(request: PermissionRequest): Promise<string>
  /** Ask the user a question; resolves with answers keyed by question id. */
  askQuestion(request: QuestionRequest): Promise<QuestionAnswers>
  /** Checkout-scoped text file services for agents that use the client side
   *  of ACP. Paths outside the checkout are rejected. */
  readTextFile(path: string, options?: { line?: number, limit?: number }): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
  log(message: string): void
}

export interface AdapterStartOptions {
  /** Native risk approvals when true, unrestricted when false/missing; neither enables a sandbox. */
  safeMode?: boolean
  /** Native model selector (`claude-opus-5`, `grok-4.6`, `gpt-6-astra`, `muse-spark-1.3-contributor`). */
  modelId: string
  effort: string
  /** Resume this native session instead of creating one. */
  resume?: string
  /** Create the native session by forking this one (agents with `fork`). */
  forkFrom?: string
}

export interface AdapterStartResult {
  nativeSessionId: string
  capabilities: Capabilities
  modelId: string
  effort: string
  efforts?: string[]
  mode?: string
  modes?: ModeOption[]
  commands?: CommandOption[]
}

export interface TurnResult {
  stopReason: StopReason
  error?: string
  usage?: TurnUsage
  /** The adapter asked its process to end but could not verify the exit:
   *  the runtime terminates the worker group (verified) before the checkout
   *  is released. */
  terminate?: boolean
}

export interface Adapter {
  readonly agent: AgentId
  /** Set once `start()` resolved. */
  readonly nativeSessionId: string | undefined
  readonly capabilities: Capabilities
  /** Launch the process and create/resume the native session. Rejects with a
   *  readable message naming the agent and the reason. */
  start(options: AdapterStartOptions): Promise<AdapterStartResult>
  /** Run one turn. Resolves when the agent reports the turn finished; the
   *  `signal` aborts it (same as `cancel()`). */
  prompt(turnId: string, input: PromptInput, signal: AbortSignal): Promise<TurnResult>
  /** Interject into the running turn. Rejects with `unsupported` when the
   *  agent has no steering. */
  steer(text: string): Promise<void>
  /** Cancel the running turn; the pending `prompt()` then resolves with
   *  `stopReason: 'cancelled'`. */
  cancel(): Promise<void>
  setModel(modelId: string, effort: string): Promise<{ modelId: string, effort: string, efforts?: string[] }>
  setMode(mode: string): Promise<void>
  /** Applies a native permission choice; next_turn must never be presented as live protection. */
  setSafeMode?(enabled: boolean): Promise<'current_turn' | 'next_turn'>
  /** Create a new native session from this one; returns its native id. */
  fork(): Promise<string>
  /** Close the native session and end the process gracefully. */
  close(): Promise<void>
  /** True while the native process is alive. */
  readonly alive: boolean
  /** Process exit observer. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export class AdapterError extends Error {
  constructor(
    readonly agent: AgentId,
    message: string,
    readonly code: 'unsupported' | 'start_failed' | 'protocol' | 'exited' = 'protocol',
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

export const REQUIRED_CAPABILITIES: ReadonlyArray<keyof Capabilities> = ['permissions', 'questions', 'steer', 'resume']

export function assertRequiredCapabilities(agent: AgentId, capabilities: Capabilities): void {
  const missing = REQUIRED_CAPABILITIES.filter((key) => !capabilities[key])
  if (missing.length) {
    throw new AdapterError(agent, `${agent} adapter does not provide required capabilities: ${missing.join(', ')}`, 'start_failed')
  }
}
