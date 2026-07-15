import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('test-results/e2e')
await rm(root, { recursive: true, force: true })
await Promise.all([
  'agent-interface',
  'chat-attachments',
  'editor',
  'espanso-match',
  'tmp',
].map((directory) => mkdir(resolve(root, directory), { recursive: true })))
