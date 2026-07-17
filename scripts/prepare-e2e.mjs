import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('test-results/e2e')
const releaseRoot = resolve(root, 'caller-release')
const binRoot = resolve(releaseRoot, 'venv/bin')
const agentRoot = resolve(releaseRoot, 'source/agent_interface')
await rm(root, { recursive: true, force: true })
await Promise.all([
  'chat-attachments',
  'editor',
  'espanso-match',
  'tmp',
].map((directory) => mkdir(resolve(root, directory), { recursive: true })))
await Promise.all([
  mkdir(binRoot, { recursive: true }),
  mkdir(agentRoot, { recursive: true }),
])

const release = JSON.parse(await readFile(resolve('config/caller-release.json'), 'utf8'))
await writeFile(resolve(releaseRoot, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
await Promise.all([
  'agent-interface',
  'github-datastore',
  'github-interface',
].map(async (command) => {
  const path = resolve(binRoot, command)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o700)
}))
