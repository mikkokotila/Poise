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
    if (command === 'gh') return { stdout: overrides.remoteCaller || C, stderr: '' }
    throw new Error(`Unexpected command: ${operation}`)
  })
  return {
    calls,
    run,
    install: vi.fn(),
    repairHookConfiguration: vi.fn(),
    options: {
      projectRoot: '/production',
      home: '/home/test',
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
})
