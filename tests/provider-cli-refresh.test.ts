import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-refresh-process-'))
  await mkdir(join(root, 'bin'))
  const provider = `#!${process.execPath}
import fs from 'node:fs'; import p from 'node:path';
const name = p.basename(process.argv[1]);
const state = p.join(process.env.HOME, name + '.version');
const updating = process.argv[2] !== '--version' || process.env.MUSE_SYNC_UPDATE === '1';
if (updating) { fs.writeFileSync(state, '1.1.0'); fs.appendFileSync(p.join(process.env.HOME, 'order'), name + ':updated\\n'); }
console.log(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '1.0.0');
`
  for (const name of ['claude', 'codex', 'grok', 'agy', 'muse']) await writeFile(join(root, 'bin', name), provider, { mode: 0o700 })
  const discovery = `#!${process.execPath}
import fs from 'node:fs'; import p from 'node:path';
const order = fs.readFileSync(p.join(process.env.HOME, 'order'), 'utf8');
if (!['claude','codex','grok','agy','muse'].every(name => order.includes(name + ':updated'))) process.exit(42);
fs.appendFileSync(p.join(process.env.HOME, 'order'), 'discovery\\n');
console.log(JSON.stringify({ checked_at: new Date().toISOString(), changed: true, families: { claude: {status: 'ok'}, codex: {status: 'ok'}, grok: {status: 'ok'}, antigravity: {status: 'ok'}, muse: {status: 'ok'} }, added: ['opus-5.5-high'], removed: ['opus-5-high'] }));
`
  await writeFile(join(root, 'bin', 'agent-interface'), discovery, { mode: 0o700 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function refresh(): Promise<{ code: number | null, report: any, error: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/refresh-models.mjs'), '--json'], {
      env: { HOME: root, PATH: [join(root, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), AGENT_INTERFACE_ROOT: root, POISE_MODEL_CATALOG_REPORT: join(root, 'report.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { try { resolveResult({ code, report: stdout ? JSON.parse(stdout) : null, error: stderr }) } catch (error) { reject(error) } })
  })
}

it('the actual scheduled/manual script updates all CLIs before model discovery and persists the report', async () => {
  const result = await refresh()
  expect(result, result.error).toMatchObject({ code: 0, report: { changed: true, added: ['opus-5.5-high'] } })
  for (const item of Object.values(result.report.cli_updates) as any[]) expect(item).toMatchObject({ status: 'updated', before: '1.0.0', after: '1.1.0' })
  expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(result.report)
  expect((await readFile(join(root, 'order'), 'utf8')).trim().split('\n').at(-1)).toBe('discovery')
})
it('overlapping manual and scheduled processes share one complete discovery run', async () => {
  const results = await Promise.all([refresh(), refresh()])
  expect(results.map(result => result.code)).toEqual([0, 0])
  expect((await readFile(join(root, 'order'), 'utf8')).match(/discovery/g)).toHaveLength(1)
})

it('a failed discovery replaces the old green receipt and can be retried', async () => {
  const good = await refresh()
  expect(good.code).toBe(0)
  const discoveryPath = join(root, 'bin', 'agent-interface')
  const discovery = await readFile(discoveryPath, 'utf8')
  await writeFile(discoveryPath, `#!${process.execPath}\nconsole.log('not a discovery report')\n`, { mode: 0o700 })
  const bad = await refresh()
  expect(bad.code).toBe(1); expect(bad.report.error).toBeTruthy()
  expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(bad.report)
  await writeFile(discoveryPath, discovery, { mode: 0o700 })
  expect((await refresh()).code).toBe(0)
})

it('stopping the refresh runner also stops its in-flight native updater group', async () => {
  const { existsSync } = await import('node:fs')
  const marker = join(root, 'updater.pid')
  await writeFile(join(root, 'bin', 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv[2]==='--version') console.log('1.0.0');\nelse { fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000); }\n`, { mode: 0o700 })
  const child = spawn(process.execPath, [resolve('scripts/refresh-models.mjs'), '--json'], { env: { HOME: root, PATH: [join(root, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), AGENT_INTERFACE_ROOT: root, POISE_MODEL_CATALOG_REPORT: join(root, 'report.json') }, stdio: 'ignore' })
  const closed = new Promise(resolve => child.once('close', resolve))
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true)
    const pid = Number(await readFile(marker, 'utf8'))
    child.kill('SIGTERM'); await closed
    await expect.poll(() => { try { process.kill(pid, 0); return true } catch { return false } }).toBe(false)
  } finally { child.kill('SIGTERM'); await closed }
})
