import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_AUTH_LIVE_INTERVAL_MS,
  CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
  CLAUDE_AUTH_POLL_MS,
  CLAUDE_AUTH_RETRY_BASE_MS,
  CLAUDE_AUTH_RETRY_MAX_MS,
  ClaudeAuthMonitor,
  type ClaudeAuthClock,
  type ClaudeAuthRunFile,
  type ClaudeAuthTimer,
} from '../server/claude-auth'
import { CLAUDE_SUBSCRIPTION_CLI } from '../server/process'

const VALID_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'private@example.com',
  orgId: 'private-org',
  subscriptionType: 'max',
})

const OK = { stdout: 'OK\n', stderr: '' }

interface FakeTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
  unrefSpy: ReturnType<typeof vi.fn>
  unref(): void
}

class FakeClock implements ClaudeAuthClock {
  nowMs = Date.parse('2026-07-15T12:00:00.000Z')
  readonly timers: FakeTimer[] = []

  now(): number { return this.nowMs }

  setTimeout(callback: () => void, delayMs: number): ClaudeAuthTimer {
    const unrefSpy = vi.fn()
    const timer: FakeTimer = {
      callback,
      delayMs,
      cleared: false,
      unrefSpy,
      unref: () => { unrefSpy() },
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer: ClaudeAuthTimer): void {
    ;(timer as FakeTimer).cleared = true
  }

  advance(ms: number): void { this.nowMs += ms }

  fire(timer: FakeTimer): void {
    this.advance(timer.delayMs)
    timer.callback()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function validRun(): ReturnType<typeof vi.fn<ClaudeAuthRunFile>> {
  return vi.fn<ClaudeAuthRunFile>(async (_command, args) => (
    args[0] === 'auth' ? { stdout: VALID_STATUS, stderr: '' } : OK
  ))
}

let originalClaudeCli: string | undefined

beforeEach(() => {
  originalClaudeCli = process.env.CLAUDE_CLI
  delete process.env.CLAUDE_CLI
})

afterEach(() => {
  if (originalClaudeCli === undefined) delete process.env.CLAUDE_CLI
  else process.env.CLAUDE_CLI = originalClaudeCli
})

describe('Claude subscription authentication monitor', () => {
  it('verifies Claude.ai with a live subscription canary and exposes only sanitized fields', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })

    const snapshot = await monitor.check({ forceLive: true })

    expect(snapshot).toEqual({
      status: 'authenticated',
      reason: null,
      checkedAt: '2026-07-15T12:00:00.000Z',
      verifiedAt: '2026-07-15T12:00:00.000Z',
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginInProgress: false,
    })
    expect(Object.keys(snapshot)).toEqual([
      'status',
      'reason',
      'checkedAt',
      'verifiedAt',
      'authMethod',
      'subscriptionType',
      'loginInProgress',
    ])
    expect(run).toHaveBeenNthCalledWith(1, CLAUDE_SUBSCRIPTION_CLI, ['auth', 'status', '--json'], expect.objectContaining({
      env: expect.objectContaining({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
      }),
    }))
    expect(run).toHaveBeenNthCalledWith(2, CLAUDE_SUBSCRIPTION_CLI, [
      '--print',
      '--model',
      'haiku',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--no-session-persistence',
      'Reply with exactly OK.',
    ], expect.any(Object))
    expect(JSON.stringify(snapshot)).not.toContain('private@example.com')
    expect(JSON.stringify(snapshot)).not.toContain('private-org')
  })

  it.each([
    { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty' },
  ])('requires reauthentication for a non-subscription local status: %j', async (status) => {
    const run = vi.fn<ClaudeAuthRunFile>().mockResolvedValue({
      stdout: JSON.stringify(status),
      stderr: '',
    })
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      authMethod: null,
      subscriptionType: null,
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('catches an expired credential that local auth status falsely reports as logged in', async () => {
    const expired = Object.assign(new Error('API Error: 401 authentication_error: OAuth token has expired'), {
      stderr: '401 authentication_error',
    })
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(expired)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      verifiedAt: null,
      loginInProgress: false,
    })
  })

  it('does not repeat an expired-token canary on every local-status poll', async () => {
    const clock = new FakeClock()
    const status = { stdout: VALID_STATUS, stderr: '' }
    const expired = new Error('401 authentication_error: OAuth token expired')
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(expired)
      .mockResolvedValue(status)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })

    await monitor.check({ forceLive: true })
    for (let poll = 0; poll < 3; poll += 1) {
      clock.advance(CLAUDE_AUTH_POLL_MS)
      await monitor.check()
    }

    expect(monitor.snapshot().status).toBe('reauth_required')
    expect(run).toHaveBeenCalledTimes(5)

    clock.advance(CLAUDE_AUTH_RETRY_MAX_MS - (3 * CLAUDE_AUTH_POLL_MS))
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(7)
  })

  it('classifies transient canary failures as degraded and retries the live check', async () => {
    const clock = new FakeClock()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({ status: 'degraded' })
    await expect(monitor.check()).resolves.toMatchObject({ status: 'degraded' })
    expect(run).toHaveBeenCalledTimes(3)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await expect(monitor.check()).resolves.toMatchObject({ status: 'authenticated' })
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('backs repeated transient canaries off exponentially', async () => {
    const clock = new FakeClock()
    const status = { stdout: VALID_STATUS, stderr: '' }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error('502 first'))
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error('502 second'))
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })

    await monitor.check({ forceLive: true })
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(3)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(5)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(6)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await expect(monitor.check()).resolves.toMatchObject({ status: 'authenticated' })
    expect(run).toHaveBeenCalledTimes(8)
  })

  it('preserves a known sign-in requirement across inconclusive checks', async () => {
    const loggedOut = {
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(loggedOut)
      .mockRejectedValueOnce(new Error('temporary status failure'))
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      authMethod: null,
      subscriptionType: null,
    })
  })

  it('keeps local CLI failures unavailable without turning them into login prompts', async () => {
    const run = vi.fn<ClaudeAuthRunFile>().mockRejectedValue(new Error('spawn claude ENOENT'))
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'unavailable',
      authMethod: null,
    })
  })

  it('parses a logged-out JSON status even when the CLI exits nonzero', async () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    })
    const run = vi.fn<ClaudeAuthRunFile>().mockRejectedValue(error)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
  })

  it('uses local status between six-hour live verifications', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })
    await monitor.check({ forceLive: true })

    clock.advance(CLAUDE_AUTH_LIVE_INTERVAL_MS - 1)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(3)

    clock.advance(1)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('requires a fresh live canary for fan-out launch gates', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })
    await monitor.check({ forceLive: true })

    clock.advance(CLAUDE_AUTH_POLL_MS - 1)
    await monitor.requireReady({ liveWithinMs: CLAUDE_AUTH_POLL_MS })
    expect(run).toHaveBeenCalledTimes(2)

    clock.advance(1)
    await monitor.requireReady({ liveWithinMs: CLAUDE_AUTH_POLL_MS })
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('closes a freshness gate when its pre-launch canary returns 502', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })
    await monitor.check({ forceLive: true })
    clock.advance(CLAUDE_AUTH_POLL_MS)
    run.mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))

    await expect(monitor.requireReady({ liveWithinMs: CLAUDE_AUTH_POLL_MS }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CLAUDE_AUTH_NOT_READY' })
    expect(monitor.snapshot().status).toBe('degraded')
  })

  it('starts an unrefed sixty-second local-status poll and stops it', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })

    monitor.start()
    await monitor.check({ forceLive: true })
    const firstTimer = clock.timers[0]
    expect(firstTimer.delayMs).toBe(CLAUDE_AUTH_POLL_MS)
    expect(firstTimer.unrefSpy).toHaveBeenCalledOnce()

    clock.fire(firstTimer)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(clock.timers).toHaveLength(2))
    await monitor.stop()
    expect(clock.timers.at(-1)?.cleared).toBe(true)
  })

  it('coalesces concurrent forced checks into one status and one canary', async () => {
    const status = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockImplementationOnce(() => status.promise)
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    const first = monitor.check({ forceLive: true })
    const second = monitor.check({ forceLive: true })
    expect(run).toHaveBeenCalledOnce()
    status.resolve({ stdout: VALID_STATUS, stderr: '' })

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'authenticated' },
      { status: 'authenticated' },
    ])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs one exact Claude.ai login and verifies it before becoming ready', async () => {
    const login = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        stderr: '',
      })
      .mockImplementationOnce(() => login.promise)
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check()

    expect(monitor.startLogin()).toMatchObject({ status: 'signing_in', loginInProgress: true })
    expect(monitor.startLogin()).toMatchObject({ status: 'signing_in', loginInProgress: true })
    expect(run).toHaveBeenNthCalledWith(2, CLAUDE_SUBSCRIPTION_CLI, ['auth', 'login', '--claudeai'], expect.objectContaining({
      timeoutMs: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
    }))
    login.resolve({ stdout: 'Login successful.', stderr: '' })

    await vi.waitFor(() => expect(monitor.snapshot()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
      verifiedAt: '2026-07-15T12:00:00.000Z',
    }))
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('does not open a login flow while authentication is healthy', async () => {
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check({ forceLive: true })

    expect(monitor.startLogin()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('aborts an active check and clears its timer during stop', async () => {
    let observedSignal: AbortSignal | undefined
    const run = vi.fn<ClaudeAuthRunFile>((_command, _args, options) => new Promise((_, reject) => {
      observedSignal = options?.signal
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock })
    monitor.start()

    await monitor.stop()

    expect(observedSignal?.aborted).toBe(true)
    expect(clock.timers[0].cleared).toBe(true)
    expect(monitor.snapshot()).toMatchObject({ status: 'unavailable', loginInProgress: false })
  })

  it('aborts login on stop without leaving the sign-in state stuck', async () => {
    let loginSignal: AbortSignal | undefined
    const run = vi.fn<ClaudeAuthRunFile>((_command, args, options) => {
      if (args[0] !== 'auth' || args[1] !== 'login') {
        return Promise.resolve({
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
          stderr: '',
        })
      }
      return new Promise((_, reject) => {
        loginSignal = options?.signal
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check()
    monitor.startLogin()

    await monitor.stop()

    expect(loginSignal?.aborted).toBe(true)
    expect(monitor.snapshot()).toMatchObject({ status: 'unavailable', loginInProgress: false })
  })

  it('does not let a stale pre-login check overwrite the verified login result', async () => {
    const stale = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ stdout: 'Login successful.', stderr: '' })
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    void monitor.check({ forceLive: true })
    monitor.startLogin()
    stale.resolve({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    })

    await vi.waitFor(() => expect(monitor.snapshot()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
    }))
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('forces a live canary after a failed worker and never treats a 502 as auth failure', async () => {
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check({ forceLive: true })
    run.mockReset()
    run.mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))

    monitor.observeProcessFailure({ code: 1, signal: null, error: new Error('worker failed') })

    expect(monitor.snapshot().status).toBe('degraded')
    await vi.waitFor(() => expect(monitor.snapshot().status).toBe('degraded'))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not attribute a mixed-provider 401 to Claude', async () => {
    const live = deferred<{ stdout: string, stderr: string }>()
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check({ forceLive: true })
    run.mockReset()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockImplementationOnce(() => live.promise)

    monitor.observeProcessFailure(new Error('401 invalid API key'))

    expect(monitor.snapshot().status).toBe('degraded')
    live.resolve(OK)
    await vi.waitFor(() => expect(monitor.snapshot().status).toBe('authenticated'))
  })

  it('does not let a late generic failure erase a known sign-in requirement', async () => {
    const retry = deferred<{ stdout: string, stderr: string }>()
    const loggedOut = {
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(loggedOut)
      .mockImplementationOnce(() => retry.promise)
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    await monitor.check()

    monitor.observeProcessFailure({ code: 1, signal: null, error: new Error('late exit') })
    expect(monitor.snapshot().status).toBe('reauth_required')

    retry.resolve(loggedOut)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(monitor.snapshot().status).toBe('reauth_required')
  })

  it('ignores late worker exits after stop', async () => {
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })
    monitor.start()
    await monitor.check({ forceLive: true })
    await monitor.stop()
    run.mockClear()

    monitor.observeProcessFailure({ code: 1, signal: null, error: new Error('late exit') })
    await Promise.resolve()

    expect(run).not.toHaveBeenCalled()
    expect(monitor.snapshot().status).toBe('unavailable')
  })

  it('marks definitive worker authentication errors and requireReady fails with a typed 503', async () => {
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('401 authentication_error'))
    const monitor = new ClaudeAuthMonitor({ runFile: run, clock: new FakeClock() })

    monitor.observeProcessFailure(Object.assign(new Error('OAuth token expired'), { code: 1 }))
    expect(monitor.snapshot().status).toBe('degraded')
    await vi.waitFor(() => expect(monitor.snapshot().status).toBe('reauth_required'))
    expect(run).toHaveBeenCalledTimes(2)
    await expect(monitor.requireReady()).rejects.toMatchObject({
      statusCode: 503,
      code: 'CLAUDE_AUTH_REQUIRED',
      authStatus: 'reauth_required',
    })
  })
})
