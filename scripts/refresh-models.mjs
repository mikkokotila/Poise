#!/usr/bin/env node

// Daily model catalog check, run by launchd (com.vaquum.poise.model-catalog)
// at 07:00: ask Caller to check every model family against its CLI, keep the
// runtime catalog current, and leave the report where the settings pane reads
// it (~/.poise/model-catalog.json). Same environment as the service, so the
// Claude probes go through the subscription wrapper like every other launch.

import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const reportPath = process.env.POISE_MODEL_CATALOG_REPORT || join(homedir(), '.poise', 'model-catalog.json')
const timeoutMs = 10 * 60_000

function refresh() {
  return new Promise((resolve, reject) => {
    const child = spawn('agent-interface', ['--refresh-models'], {
      cwd: process.env.AGENT_INTERFACE_ROOT || join(homedir(), 'dev', 'caller', 'agent_interface'),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CLI: join(projectRoot, 'scripts', 'claude-subscription.mjs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `agent-interface --refresh-models exited ${code}`))
    })
  })
}

const report = JSON.parse(await refresh())
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 })
const staged = `${reportPath}.${process.pid}.tmp`
await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
await rename(staged, reportPath)
const families = Object.entries(report.families || {})
  .map(([name, family]) => `${name}: ${family.status}${family.status === 'ok' ? '' : ` (${family.error})`}`)
  .join('; ')
console.log(`${report.checked_at} ${report.changed ? 'catalog updated' : 'catalog unchanged'} — ${families}`)
