import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

let matchDir = ''
let workerRoot = ''
let workerScriptPath = ''

interface WorkerResult {
  ok: boolean
  message?: string
}

function startSnippetWorker(trigger: string): {
  ready: Promise<void>
  result: Promise<WorkerResult>
} {
  const child = spawn(process.execPath, [workerScriptPath], {
    env: {
      ...process.env,
      POISE_ESPANSO_MATCH_DIR: matchDir,
      SNIPPET_JOB: JSON.stringify({ trigger, replace: `value ${trigger}` }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let readySeen = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!readySeen && stdout.split('\n').includes('READY')) {
        readySeen = true
        resolveReady()
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      if (!readySeen) rejectReady(error)
      reject(error)
    })
    child.once('close', (code) => {
      if (!readySeen) rejectReady(new Error(`snippet worker exited before ready (${code}): ${stderr}`))
      const line = stdout.split('\n').find((value) => value.startsWith('RESULT '))
      if (!line) {
        reject(new Error(`snippet worker produced no result (${code}): ${stderr}`))
        return
      }
      resolve(JSON.parse(line.slice('RESULT '.length)) as WorkerResult)
    })
  })
  return { ready, result }
}

beforeAll(async () => {
  matchDir = await mkdtemp(join(tmpdir(), 'poise-snippet-process-test-'))
  workerRoot = await mkdtemp(join(process.cwd(), 'node_modules', '.poise-snippet-worker-'))
  const workerModulePath = join(workerRoot, 'snippets.mjs')
  workerScriptPath = join(workerRoot, 'worker.mjs')
  await build({
    entryPoints: [join(process.cwd(), 'server', 'snippets.ts')],
    outfile: workerModulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  })
  await writeFile(workerScriptPath, `
    import * as snippets from './snippets.mjs'
    const job = JSON.parse(process.env.SNIPPET_JOB)
    process.stdout.write('READY\\n')
    try {
      await snippets.addSnippet(job)
      process.stdout.write('RESULT ' + JSON.stringify({ ok: true }) + '\\n')
    } catch (error) {
      process.stdout.write('RESULT ' + JSON.stringify({
        ok: false,
        message: error?.message,
      }) + '\\n')
    }
  `, 'utf8')
})

afterAll(async () => {
  await rm(matchDir, { recursive: true, force: true })
  await rm(workerRoot, { recursive: true, force: true })
})

describe('snippet process integrity', () => {
  it('preserves appends made concurrently by separate Poise processes', async () => {
    const blocker = new Database(join(matchDir, '.poise-snippets-lock.sqlite3'), { timeout: 0 })
    blocker.exec('BEGIN IMMEDIATE')
    const workers = [startSnippetWorker(';process-a'), startSnippetWorker(';process-b')]

    try {
      await Promise.all(workers.map((worker) => worker.ready))
      await new Promise((resolve) => setTimeout(resolve, 150))
    } finally {
      if (blocker.inTransaction) blocker.exec('COMMIT')
      blocker.close()
    }

    await expect(Promise.all(workers.map((worker) => worker.result))).resolves.toEqual([
      { ok: true },
      { ok: true },
    ])
    const source = await readFile(join(matchDir, 'poise.yml'), 'utf8')
    const parsed = parseYaml(source) as { matches: Array<{ trigger: string }> }
    expect(parsed.matches.map((snippet) => snippet.trigger).sort()).toEqual([
      ';process-a',
      ';process-b',
    ])
  }, 20_000)
})
