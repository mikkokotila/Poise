import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import release from '../config/caller-release.json'
import { getCallerReleaseHealth } from '../server/caller-release'

const EXPECTED_COMMIT = release.commit
const ENV_KEYS = [
  'POISE_ENFORCE_CALLER_RELEASE',
  'CALLER_RELEASE_SHA',
  'CALLER_RELEASE_ROOT',
  'CALLER_BIN_ROOT',
  'AGENT_INTERFACE_ROOT',
] as const

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-caller-release-'))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key]
  await rm(root, { recursive: true, force: true })
})

async function configureRelease(commit = EXPECTED_COMMIT): Promise<void> {
  const bin = join(root, 'venv', 'bin')
  const agent = join(root, 'source', 'agent_interface')
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(agent, { recursive: true }),
  ])
  for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
    const path = join(bin, command)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o700)
  }
  await writeFile(join(root, 'release.json'), JSON.stringify({
    repository: 'mikkokotila/caller',
    commit: EXPECTED_COMMIT,
    packages: {
      'agent-interface': '0.2.0',
      'github-datastore': '0.2.0',
      'github-interface': '0.2.0',
    },
  }))
  process.env.POISE_ENFORCE_CALLER_RELEASE = '1'
  process.env.CALLER_RELEASE_SHA = commit
  process.env.CALLER_RELEASE_ROOT = root
  process.env.CALLER_BIN_ROOT = bin
  process.env.AGENT_INTERFACE_ROOT = agent
}

describe('Caller release health', () => {
  it('allows an unmanaged development runtime without claiming a pin', async () => {
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'unmanaged',
      required: false,
      actualCommit: null,
    })
  })

  it('accepts the exact executable release declared by Poise', async () => {
    await configureRelease()
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'ready',
      required: true,
      actualCommit: EXPECTED_COMMIT,
      error: null,
    })
  })

  it('fails closed when the configured commit differs', async () => {
    await configureRelease('a'.repeat(40))
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'invalid',
      required: true,
      error: 'Caller release commit does not match the Poise manifest',
    })
  })
})
