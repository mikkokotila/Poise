import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSecureDotenv } from '../server/runtime-config'
import { scrubbedChildEnvironment } from '../server/process'

const marker = 'jev-fixture-server-only'
vi.mock('vite', () => ({ defineConfig: (value: unknown) => value, loadEnv: () => ({ JEV_API_KEY: marker }) }))
vi.mock('../scripts/build-identity.mjs', () => ({ buildSourceSha: () => 'fixture-build' }))
vi.mock('../server/cache-plugin', () => ({ attachChatSockets: vi.fn(), createPoiseMiddleware: vi.fn(), stopPoiseRuntime: vi.fn() }))
let root = ''
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); root = '' })

it('loads the key only into the development server, never client build defines or child CLIs', async () => {
  vi.stubEnv('JEV_API_KEY', undefined); vi.stubEnv('POISE_DB', undefined)
  const configModule = await import('../vite.config')
  const config = (configModule.default as (env: { mode: string }) => any)({ mode: 'test' })
  expect(process.env.JEV_API_KEY).toBeUndefined()
  expect(JSON.stringify(config.define)).not.toContain(marker)
  await config.plugins[0].configureServer({ middlewares: { use: vi.fn() } })
  expect(process.env.JEV_API_KEY).toBe(marker)
  for (const command of ['agent-interface', 'claude', 'codex', 'grok', 'muse', 'gh']) expect(scrubbedChildEnvironment(command)).not.toHaveProperty('JEV_API_KEY')
})

it('loads JEV from the private production environment without leaking it to model workers', async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-jev-env-'))
  vi.stubEnv('JEV_API_KEY', undefined)
  await writeFile(join(root, '.env'), `JEV_API_KEY=${marker}\n`, { mode: 0o600 })
  await loadSecureDotenv(root)
  expect(process.env.JEV_API_KEY).toBe(marker)
  expect(scrubbedChildEnvironment('agent-interface')).not.toHaveProperty('JEV_API_KEY')
})
