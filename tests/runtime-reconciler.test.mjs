import { describe, expect, it, vi } from 'vitest'
import { reconcileRuntime } from '../scripts/update-caller.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

function harness(overrides = {}) {
  let head = overrides.localPoise || A
  const calls = []
  const run = vi.fn(async (command, args) => {
    calls.push([command, ...args])
    const operation = [command, ...args].join(' ')
    if (operation === 'git branch --show-current') {
      return { stdout: overrides.branch ?? 'main', stderr: '' }
    }
    if (operation === 'git status --porcelain') {
      return { stdout: overrides.dirty ?? '', stderr: '' }
    }
    if (operation === 'git rev-parse HEAD') return { stdout: head, stderr: '' }
    if (operation === 'git fetch --quiet https://github.com/mikkokotila/Poise.git refs/heads/main') {
      return { stdout: '', stderr: '' }
    }
    if (operation === 'git rev-parse FETCH_HEAD') {
      return { stdout: overrides.remotePoise || A, stderr: '' }
    }
    if (operation.startsWith('git merge-base --is-ancestor')) {
      if (overrides.diverged) throw new Error('not an ancestor')
      return { stdout: '', stderr: '' }
    }
    if (operation.startsWith('git merge --ff-only')) {
      head = overrides.remotePoise || A
      return { stdout: '', stderr: '' }
    }
    if (operation.startsWith('git rev-list --count')) {
      return { stdout: String(overrides.behind ?? 1), stderr: '' }
    }
    if (command === 'gh') return { stdout: overrides.remoteCaller || C, stderr: '' }
    throw new Error(`Unexpected command: ${operation}`)
  })
  const writeState = vi.fn()
  return {
    calls,
    run,
    install: vi.fn(),
    repairHookConfiguration: vi.fn(),
    // The record the run leaves behind, whatever the outcome.
    recorded: () => writeState.mock.calls.at(-1)?.[1],
    options: {
      projectRoot: '/production',
      home: '/home/test',
      statePath: '/home/test/.poise/production-update.json',
      readState: vi.fn().mockResolvedValue(overrides.previous ?? null),
      writeState,
      poiseRepository: 'https://github.com/mikkokotila/Poise.git',
      callerRelease: {
        repository: 'mikkokotila/caller',
        ref: 'main',
        packages: { 'agent-interface': '0.2.0' },
      },
      run,
      install: vi.fn(),
      readHealth: vi.fn().mockResolvedValue(overrides.localCaller ?? C),
      hookCurrent: vi.fn().mockResolvedValue(overrides.hookCurrent ?? true),
      datastoreCurrent: vi.fn().mockResolvedValue(overrides.datastoreCurrent ?? true),
      repairHookConfiguration: vi.fn(),
      log: vi.fn(),
    },
  }
}

describe('production runtime reconciliation', () => {
  it('leaves current releases in place and repairs hook configuration', async () => {
    const test = harness()
    const result = await reconcileRuntime(test.options)

    expect(result.action).toBe('current')
    expect(test.options.install).not.toHaveBeenCalled()
    expect(test.options.repairHookConfiguration).toHaveBeenCalledOnce()
  })

  it('fast-forwards Poise main and installs from the updated checkout', async () => {
    const test = harness({ remotePoise: B })
    const result = await reconcileRuntime(test.options)

    expect(result).toEqual({ action: 'updated-poise', poiseCommit: B })
    expect(test.calls).toContainEqual(['git', 'merge-base', '--is-ancestor', A, B])
    expect(test.calls).toContainEqual(['git', 'merge', '--ff-only', B])
    expect(test.options.install).toHaveBeenCalledOnce()
  })

  it('refuses to mutate a dirty production worktree', async () => {
    const test = harness({ dirty: ' M package.json', remotePoise: B })

    await expect(reconcileRuntime(test.options)).rejects.toThrow(/clean managed worktree/)
    expect(test.calls.some((call) => call.includes('fetch'))).toBe(false)
    expect(test.options.install).not.toHaveBeenCalled()
  })

  it('refuses a non-fast-forward remote main', async () => {
    const test = harness({ remotePoise: B, diverged: true })

    await expect(reconcileRuntime(test.options)).rejects.toThrow(/not a fast-forward/)
    expect(test.options.install).not.toHaveBeenCalled()
  })

  it('installs a changed Caller release', async () => {
    const test = harness({ localCaller: B, remoteCaller: C })
    const result = await reconcileRuntime(test.options)

    expect(result.action).toBe('reconciled-runtime')
    expect(test.options.install).toHaveBeenCalledOnce()
    expect(test.options.repairHookConfiguration).not.toHaveBeenCalled()
  })

  it('repairs a missing or stale stop-gate runtime', async () => {
    const test = harness({ hookCurrent: false })
    const result = await reconcileRuntime(test.options)

    expect(result.action).toBe('reconciled-runtime')
    expect(test.options.install).toHaveBeenCalledOnce()
  })

  it('repairs datastore services pinned to a stale Caller release', async () => {
    const test = harness({ datastoreCurrent: false })
    const result = await reconcileRuntime(test.options)

    expect(result.action).toBe('reconciled-runtime')
    expect(test.options.install).toHaveBeenCalledOnce()
  })
})

const previousRecord = (overrides = {}) => ({
  at: '2026-09-18T11:59:00.000Z',
  status: 'current',
  action: 'current',
  error: null,
  failingSince: null,
  poise: { deployed: A, installed: A, remote: A, behind: 0 },
  caller: C,
  ...overrides,
})

describe('production update record', () => {
  it('records a current run with both commits', async () => {
    const test = harness({ previous: previousRecord() })
    await reconcileRuntime(test.options)

    expect(test.options.writeState).toHaveBeenCalledWith('/home/test/.poise/production-update.json', expect.anything())
    expect(test.recorded()).toMatchObject({
      status: 'current',
      action: 'current',
      error: null,
      failingSince: null,
      poise: { deployed: A, installed: A, remote: A, behind: 0 },
      caller: C,
    })
    expect(Date.parse(test.recorded().at)).not.toBeNaN()
  })

  it('records an update and the commit its install completed for', async () => {
    const test = harness({ remotePoise: B, previous: previousRecord() })
    await reconcileRuntime(test.options)

    expect(test.recorded()).toMatchObject({
      status: 'updated',
      action: 'updated-poise',
      poise: { deployed: B, installed: B, remote: B, behind: 0 },
    })
  })

  it('records a failure, keeps the first failure time, and counts how far behind main is', async () => {
    const test = harness({
      remotePoise: B,
      diverged: true,
      behind: 3,
      previous: previousRecord({ status: 'failed', failingSince: '2026-09-18T11:50:00.000Z', error: 'earlier' }),
    })
    await expect(reconcileRuntime(test.options)).rejects.toThrow(/not a fast-forward/)

    expect(test.recorded()).toMatchObject({
      status: 'failed',
      action: null,
      error: 'Remote Poise main is not a fast-forward of the deployed commit',
      failingSince: '2026-09-18T11:50:00.000Z',
      poise: { deployed: A, installed: A, remote: B, behind: 3 },
    })
    expect(test.calls).toContainEqual(['git', 'rev-list', '--count', `${A}..${B}`])
  })

  it('starts the failure clock when the previous run succeeded', async () => {
    const test = harness({ dirty: ' M package.json', previous: previousRecord() })
    await expect(reconcileRuntime(test.options)).rejects.toThrow(/clean managed worktree/)

    const recorded = test.recorded()
    expect(recorded.status).toBe('failed')
    expect(recorded.failingSince).toBe(recorded.at)
    expect(recorded.poise.remote).toBeNull()
    expect(recorded.poise.behind).toBeNull()
  })

  it('leaves the install commit alone when the install throws', async () => {
    const test = harness({ remotePoise: B, previous: previousRecord() })
    test.options.install.mockRejectedValue(new Error('npm ci exited 1'))
    await expect(reconcileRuntime(test.options)).rejects.toThrow(/npm ci exited 1/)

    expect(test.recorded()).toMatchObject({
      status: 'failed',
      error: 'npm ci exited 1',
      poise: { deployed: B, installed: A, remote: B, behind: 0 },
    })
  })

  it('retries the install when the checkout moved but the last install did not complete', async () => {
    const test = harness({ previous: previousRecord({ poise: { deployed: A, installed: 'd'.repeat(40), remote: A, behind: 0 } }) })
    const result = await reconcileRuntime(test.options)

    expect(result).toEqual({ action: 'installed-poise', poiseCommit: A })
    expect(test.options.install).toHaveBeenCalledOnce()
    expect(test.options.log).toHaveBeenCalledWith(`Installing Poise ${A}: the previous install did not complete`)
    expect(test.recorded()).toMatchObject({ status: 'updated', poise: { installed: A } })
  })

  it('adopts a checkout that predates the record without reinstalling', async () => {
    const test = harness()
    const result = await reconcileRuntime(test.options)

    expect(result.action).toBe('current')
    expect(test.options.install).not.toHaveBeenCalled()
    expect(test.recorded().poise.installed).toBe(A)
  })
})


it('uses one timestamp for a new failure even when the clock advances between reads', async () => {
  const RealDate = Date
  let reads = 0
  vi.stubGlobal('Date', class extends RealDate {
    constructor(value) { super(value ?? 1_700_000_000_000 + reads++) }
  })
  try {
    const test = harness({ dirty: ' M package.json', previous: previousRecord() })
    await expect(reconcileRuntime(test.options)).rejects.toThrow(/clean managed worktree/)
    expect(test.recorded().failingSince).toBe(test.recorded().at)
    expect(test.recorded().status).toBe('failed')
  } finally { vi.unstubAllGlobals() }
})
