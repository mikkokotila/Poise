import {
  claudeSubscriptionEnvironment,
  CLAUDE_SUBSCRIPTION_CLI,
  runFile as defaultRunFile,
  type RunFileOptions,
  type RunFileResult,
} from './process'
import { HttpError } from './http'

export const CLAUDE_AUTH_POLL_MS = 60_000
export const CLAUDE_AUTH_LIVE_INTERVAL_MS = 6 * 60 * 60_000
export const CLAUDE_AUTH_LOGIN_TIMEOUT_MS = 10 * 60_000
export const CLAUDE_AUTH_RETRY_BASE_MS = 60_000
export const CLAUDE_AUTH_RETRY_MAX_MS = 60 * 60_000

const STATUS_TIMEOUT_MS = 30_000
const LIVE_TIMEOUT_MS = 90_000
const MAX_AUTH_OUTPUT_BYTES = 64 * 1024
const LIVE_PROMPT = 'Reply with exactly OK.'
const CLAUDE_COMMAND = CLAUDE_SUBSCRIPTION_CLI

export type ClaudeAuthStatus =
  | 'checking'
  | 'authenticated'
  | 'reauth_required'
  | 'signing_in'
  | 'degraded'
  | 'unavailable'

export interface ClaudeAuthSnapshot {
  status: ClaudeAuthStatus
  reason: string | null
  checkedAt: string | null
  verifiedAt: string | null
  authMethod: string | null
  subscriptionType: string | null
  loginInProgress: boolean
}

export type ClaudeAuthRunFile = (
  command: string,
  args: readonly string[],
  options?: RunFileOptions,
) => Promise<RunFileResult>

export type ClaudeAuthTimer = number | { unref?: () => void }

export interface ClaudeAuthClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ClaudeAuthTimer
  clearTimeout(timer: ClaudeAuthTimer): void
}

export interface ClaudeAuthMonitorOptions {
  runFile?: ClaudeAuthRunFile
  clock?: ClaudeAuthClock
}

export interface ClaudeAuthCheckOptions {
  forceLive?: boolean
}

export interface ClaudeAuthReadyOptions {
  /** Require a successful live canary no older than this many milliseconds. */
  liveWithinMs?: number
}

const systemClock: ClaudeAuthClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

const REASONS: Record<ClaudeAuthStatus, string | null> = {
  checking: 'Checking Claude subscription authentication.',
  authenticated: null,
  reauth_required: 'Claude subscription sign-in is required.',
  signing_in: 'Waiting for Claude subscription sign-in.',
  degraded: 'Claude subscription authentication could not be verified.',
  unavailable: 'Claude CLI authentication is unavailable.',
}

interface LocalAuthStatus {
  ready: boolean
  authMethod: string | null
  subscriptionType: string | null
}

export class ClaudeAuthReadinessError extends HttpError {
  readonly code: 'CLAUDE_AUTH_REQUIRED' | 'CLAUDE_AUTH_NOT_READY'
  readonly authStatus: ClaudeAuthStatus

  constructor(status: ClaudeAuthStatus) {
    const required = status === 'reauth_required'
    super(503, required
      ? 'Claude subscription sign-in is required'
      : 'Claude subscription authentication is not ready')
    this.name = 'ClaudeAuthReadinessError'
    this.code = required ? 'CLAUDE_AUTH_REQUIRED' : 'CLAUDE_AUTH_NOT_READY'
    this.authStatus = status
  }
}

function sanitizeSubscriptionType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,31}$/.test(normalized)
    ? normalized
    : null
}

function parseStatusJson(raw: string): LocalAuthStatus | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = value as Record<string, unknown>
  const ready = status.loggedIn === true
    && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
  return {
    ready,
    authMethod: ready ? 'claude.ai' : null,
    subscriptionType: ready ? sanitizeSubscriptionType(status.subscriptionType) : null,
  }
}

function failureText(error: unknown): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return ''
  const record = error as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['message', 'stderr', 'stdout']) {
    const value = record[key]
    if (typeof value === 'string') parts.push(value)
    else if (Buffer.isBuffer(value)) parts.push(value.toString('utf8'))
  }
  if (record.error && record.error !== error) parts.push(failureText(record.error))
  return parts.join('\n')
}

function errorStdout(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<string, unknown>).stdout
  if (typeof value === 'string') return value
  return Buffer.isBuffer(value) ? value.toString('utf8') : null
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  const text = failureText(error)
  return /(?:\b401\b|authentication[_ ]error|invalid\s+(?:x-)?api[- ]?key)/i.test(text)
    || /(?:oauth|token|credential)[^\n]{0,80}\bexpired\b/i.test(text)
    || /\bexpired\b[^\n]{0,80}(?:oauth|token|credential)/i.test(text)
}

function processFailed(resultOrError: unknown): boolean {
  if (resultOrError instanceof Error) return true
  if (typeof resultOrError === 'string') return resultOrError.length > 0
  if (!resultOrError || typeof resultOrError !== 'object') return false
  const result = resultOrError as Record<string, unknown>
  if (result.error) return true
  if (result.signal) return true
  if (typeof result.code === 'number') return result.code !== 0
  return result.code !== undefined && result.code !== null
}

export class ClaudeAuthMonitor {
  private readonly run: ClaudeAuthRunFile
  private readonly clock: ClaudeAuthClock
  private status: ClaudeAuthStatus = 'checking'
  private checkedAtMs: number | null = null
  private verifiedAtMs: number | null = null
  private authMethod: string | null = null
  private subscriptionType: string | null = null
  private started = false
  private lifecycleGeneration = 0
  private stateGeneration = 0
  private timer: ClaudeAuthTimer | null = null
  private checkPromise: Promise<ClaudeAuthSnapshot> | null = null
  private checkAbort: AbortController | null = null
  private loginPromise: Promise<ClaudeAuthSnapshot> | null = null
  private loginAbort: AbortController | null = null
  private loginInProgress = false
  private forceLiveRequested = false
  private stopped = false
  private liveFailureCount = 0
  private nextLiveAttemptAtMs: number | null = null

  constructor(options: ClaudeAuthMonitorOptions = {}) {
    this.run = options.runFile ?? defaultRunFile
    this.clock = options.clock ?? systemClock
  }

  snapshot(): ClaudeAuthSnapshot {
    return {
      status: this.status,
      reason: REASONS[this.status],
      checkedAt: this.checkedAtMs === null ? null : new Date(this.checkedAtMs).toISOString(),
      verifiedAt: this.verifiedAtMs === null ? null : new Date(this.verifiedAtMs).toISOString(),
      authMethod: this.authMethod,
      subscriptionType: this.subscriptionType,
      loginInProgress: this.loginInProgress,
    }
  }

  start(): void {
    if (this.started) return
    this.stopped = false
    this.started = true
    this.lifecycleGeneration += 1
    this.stateGeneration += 1
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.status = 'checking'
    const lifecycle = this.lifecycleGeneration
    void this.check({ forceLive: true })
    this.schedulePoll(lifecycle)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    this.lifecycleGeneration += 1
    this.stateGeneration += 1
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.forceLiveRequested = false
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.loginInProgress = false
    this.checkAbort?.abort()
    this.loginAbort?.abort()
    const pending = [this.checkPromise, this.loginPromise].filter(
      (value): value is Promise<ClaudeAuthSnapshot> => value !== null,
    )
    this.status = 'unavailable'
    this.authMethod = null
    this.subscriptionType = null
    await Promise.allSettled(pending)
  }

  check(options: ClaudeAuthCheckOptions = {}): Promise<ClaudeAuthSnapshot> {
    if (this.stopped) return Promise.resolve(this.snapshot())
    if (options.forceLive) this.forceLiveRequested = true
    if (this.loginInProgress) return Promise.resolve(this.snapshot())
    if (this.checkPromise) {
      const active = this.checkPromise
      return active.then(() => {
        if (this.forceLiveRequested && !this.loginInProgress) return this.check()
        return this.snapshot()
      })
    }
    return this.beginCheck(this.stateGeneration, false)
  }

  startLogin(): ClaudeAuthSnapshot {
    if (this.stopped) return this.snapshot()
    if (this.status === 'authenticated' || this.loginInProgress) return this.snapshot()
    const staleCheck = this.checkPromise
    this.stateGeneration += 1
    const generation = this.stateGeneration
    this.forceLiveRequested = false
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.checkAbort?.abort()
    this.loginInProgress = true
    this.status = 'signing_in'
    const controller = new AbortController()
    this.loginAbort = controller

    const operation = (async () => {
      try {
        await this.run(
          CLAUDE_COMMAND,
          ['auth', 'login', '--claudeai'],
          {
            env: claudeSubscriptionEnvironment(),
            timeoutMs: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
            maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
            signal: controller.signal,
          },
        )
        await staleCheck?.catch(() => undefined)
        if (generation !== this.stateGeneration) return this.snapshot()
        this.forceLiveRequested = true
        return await this.beginCheck(generation, true)
      } catch (error) {
        if (generation === this.stateGeneration) {
          this.status = isDefinitiveAuthFailure(error) ? 'reauth_required' : 'unavailable'
        }
        return this.snapshot()
      }
    })()
    this.loginPromise = operation
    const finish = () => {
      if (this.loginPromise === operation) this.loginPromise = null
      if (this.loginAbort === controller) this.loginAbort = null
      if (generation === this.stateGeneration) this.loginInProgress = false
    }
    void operation.then(finish, finish)
    return this.snapshot()
  }

  async requireReady(options: ClaudeAuthReadyOptions = {}): Promise<void> {
    const liveWithinMs = options.liveWithinMs
    if (liveWithinMs !== undefined && (!Number.isFinite(liveWithinMs) || liveWithinMs < 0)) {
      throw new TypeError('liveWithinMs must be a non-negative finite number')
    }
    const liveIsStale = liveWithinMs !== undefined
      && (this.verifiedAtMs === null || this.clock.now() - this.verifiedAtMs >= liveWithinMs)
    if (this.status === 'authenticated' && !liveIsStale) return
    if (!this.stopped && this.status !== 'reauth_required' && !this.loginInProgress) {
      await this.check({
        forceLive: liveIsStale || this.status === 'degraded' || this.status === 'unavailable',
      })
    }
    const current = this.snapshot().status
    if (current !== 'authenticated') throw new ClaudeAuthReadinessError(current)
  }

  observeProcessFailure(resultOrError: unknown): void {
    if (this.stopped || !processFailed(resultOrError)) return
    // The login path always ends with a forced live canary. Let it own the
    // transition so an older worker cannot invalidate or strand that flow.
    if (this.loginInProgress) return
    // Worker failures can include GitHub and other model providers, so their
    // text is never authoritative for Claude auth. Close the gate now, then
    // let the isolated Claude canary make the classification.
    if (this.status !== 'reauth_required' && this.status !== 'unavailable') {
      this.status = 'degraded'
    }
    this.forceLiveRequested = true
    void this.check({ forceLive: true })
  }

  private schedulePoll(lifecycle: number): void {
    if (!this.started || lifecycle !== this.lifecycleGeneration) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    const timer = this.clock.setTimeout(() => {
      if (this.timer === timer) this.timer = null
      if (!this.started || lifecycle !== this.lifecycleGeneration) return
      void this.check().finally(() => this.schedulePoll(lifecycle))
    }, CLAUDE_AUTH_POLL_MS)
    this.timer = timer
    if (typeof timer === 'object' && timer !== null) timer.unref?.()
  }

  private beginCheck(generation: number, preserveSigningIn: boolean): Promise<ClaudeAuthSnapshot> {
    if (this.checkPromise) return this.checkPromise
    const controller = new AbortController()
    this.checkAbort = controller
    let operation!: Promise<ClaudeAuthSnapshot>
    operation = this.performCheck(generation, controller.signal, preserveSigningIn)
      .catch(() => {
        if (generation === this.stateGeneration) {
          if (this.status !== 'reauth_required' && this.status !== 'unavailable') {
            this.status = this.status === 'authenticated' || this.status === 'degraded'
              ? 'degraded'
              : 'unavailable'
          }
        }
        return this.snapshot()
      })
      .finally(() => {
        if (this.checkPromise === operation) this.checkPromise = null
        if (this.checkAbort === controller) this.checkAbort = null
      })
    this.checkPromise = operation
    return operation
  }

  private async performCheck(
    generation: number,
    signal: AbortSignal,
    preserveSigningIn: boolean,
  ): Promise<ClaudeAuthSnapshot> {
    const previousStatus = this.status
    let local: LocalAuthStatus | null = null
    let localError: unknown
    try {
      const result = await this.run(
        CLAUDE_COMMAND,
        ['auth', 'status', '--json'],
        {
          env: claudeSubscriptionEnvironment(),
          timeoutMs: STATUS_TIMEOUT_MS,
          maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
          signal,
        },
      )
      local = parseStatusJson(result.stdout)
    } catch (error) {
      localError = error
      const stdout = errorStdout(error)
      if (stdout !== null) local = parseStatusJson(stdout)
    }

    if (generation !== this.stateGeneration) return this.snapshot()
    this.checkedAtMs = this.clock.now()
    if (!local) {
      this.forceLiveRequested = false
      if (isDefinitiveAuthFailure(localError)) {
        this.status = 'reauth_required'
        this.authMethod = null
        this.subscriptionType = null
        this.liveFailureCount = 0
        this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_MAX_MS
      } else if (previousStatus === 'reauth_required') {
        this.status = 'reauth_required'
      } else if (previousStatus === 'authenticated' || previousStatus === 'degraded') {
        this.status = 'degraded'
      } else if (!preserveSigningIn) {
        this.status = 'unavailable'
      } else {
        this.status = 'unavailable'
      }
      return this.snapshot()
    }
    if (!local.ready) {
      this.forceLiveRequested = false
      this.status = 'reauth_required'
      this.authMethod = null
      this.subscriptionType = null
      this.liveFailureCount = 0
      this.nextLiveAttemptAtMs = null
      return this.snapshot()
    }

    this.authMethod = local.authMethod
    this.subscriptionType = local.subscriptionType
    const now = this.clock.now()
    const retryDue = this.nextLiveAttemptAtMs === null || now >= this.nextLiveAttemptAtMs
    const liveWanted = this.forceLiveRequested
      || this.verifiedAtMs === null
      || now - this.verifiedAtMs >= CLAUDE_AUTH_LIVE_INTERVAL_MS
      || previousStatus === 'degraded'
      || previousStatus === 'unavailable'
      || previousStatus === 'reauth_required'
      || preserveSigningIn
    const liveRequired = liveWanted && (retryDue || preserveSigningIn)

    if (!liveRequired) {
      this.forceLiveRequested = false
      this.status = previousStatus === 'reauth_required'
        ? 'reauth_required'
        : previousStatus === 'degraded'
          ? 'degraded'
          : 'authenticated'
      if (this.status === 'reauth_required') {
        this.authMethod = null
        this.subscriptionType = null
      }
      return this.snapshot()
    }

    try {
      await this.run(
        CLAUDE_COMMAND,
        [
          '--print',
          '--model',
          'haiku',
          '--permission-mode',
          'dontAsk',
          '--tools',
          '',
          '--no-session-persistence',
          LIVE_PROMPT,
        ],
        {
          env: claudeSubscriptionEnvironment(),
          timeoutMs: LIVE_TIMEOUT_MS,
          maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
          signal,
        },
      )
      if (generation === this.stateGeneration) {
        this.verifiedAtMs = this.clock.now()
        this.status = 'authenticated'
        this.liveFailureCount = 0
        this.nextLiveAttemptAtMs = null
      }
    } catch (error) {
      if (generation === this.stateGeneration) {
        if (isDefinitiveAuthFailure(error)) {
          this.status = 'reauth_required'
          this.authMethod = null
          this.subscriptionType = null
          this.liveFailureCount = 0
          // Local status can continue reporting a stale, apparently valid
          // Claude.ai session after OAuth expiry. Keep polling that status,
          // but do not turn the known 401 into a once-per-minute live probe.
          // A user-initiated login resets this deadline and verifies at once.
          this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_MAX_MS
        } else {
          this.liveFailureCount += 1
          const delay = Math.min(
            CLAUDE_AUTH_RETRY_BASE_MS * (2 ** Math.min(this.liveFailureCount - 1, 20)),
            CLAUDE_AUTH_RETRY_MAX_MS,
          )
          this.nextLiveAttemptAtMs = this.clock.now() + delay
          this.status = previousStatus === 'reauth_required' && !preserveSigningIn
            ? 'reauth_required'
            : 'degraded'
          if (this.status === 'reauth_required') {
            this.authMethod = null
            this.subscriptionType = null
          }
        }
      }
    } finally {
      if (generation === this.stateGeneration) this.forceLiveRequested = false
    }
    return this.snapshot()
  }
}

export const claudeAuth = new ClaudeAuthMonitor()
