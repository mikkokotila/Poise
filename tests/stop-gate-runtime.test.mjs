import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureStopGate,
  installStopGate,
  stopGateIsCurrent,
} from '../scripts/stop-gate-runtime.mjs'

const manifest = {
  repository: 'mikkokotila/caller',
  ref: 'main',
  commit: 'a'.repeat(40),
  packages: {
    'agent-interface': '0.2.0',
    'github-interface': '0.2.0',
  },
}
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'poise-stop-gate-'))
  roots.push(home)
  return home
}

async function executable(path) {
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o700)
}

describe('stop-gate runtime reconciliation', () => {
  it('creates a missing runtime, records its release, and configures both hooks', async () => {
    const home = await temporaryHome()
    const hookRoot = join(home, '.local', 'share', 'caller-pr-stop-gate')
    const bin = join(hookRoot, 'bin')
    const calls = []
    const run = vi.fn(async (command, args, options = {}) => {
      calls.push({ command, args, options })
      if (command === '/python3.13') {
        await mkdir(bin, { recursive: true })
        await executable(join(bin, 'python'))
        return { stdout: '', stderr: '' }
      }
      if (command === join(bin, 'python') && args.includes('pip')) {
        await executable(join(bin, 'agent-interface'))
        await executable(join(bin, 'github-interface'))
        return { stdout: '', stderr: '' }
      }
      if (command === '/usr/bin/sqlite3') return { stdout: 'Vaquum', stderr: '' }
      return { stdout: '', stderr: '' }
    })

    await installStopGate({
      home,
      manifest,
      python: '/python3.13',
      releaseRoot: '/caller-release',
      run,
    })

    expect(await stopGateIsCurrent({ home, manifest })).toBe(true)
    expect(JSON.parse(await readFile(join(hookRoot, 'release.json'), 'utf8'))).toEqual(manifest)
    const configuration = calls.find((call) => call.args[0] === '--install-pr-stop-gate')
    expect(configuration.options.env.CALLER_PR_GATE_SCOPE).toBe('Vaquum/*')
  })

  it('reapplies hook configuration without reinstalling packages', async () => {
    const home = await temporaryHome()
    const bin = join(home, '.local', 'share', 'caller-pr-stop-gate', 'bin')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'agent-interface'))
    const run = vi.fn(async (command) => (
      command === '/usr/bin/sqlite3'
        ? { stdout: 'Vaquum', stderr: '' }
        : { stdout: '', stderr: '' }
    ))

    await configureStopGate({ home, run })

    expect(run).toHaveBeenLastCalledWith(
      join(bin, 'agent-interface'),
      ['--install-pr-stop-gate'],
      expect.objectContaining({
        env: expect.objectContaining({ CALLER_PR_GATE_SCOPE: 'Vaquum/*' }),
      }),
    )
  })
})
