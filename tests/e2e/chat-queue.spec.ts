import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real agent stdio -> ACP adapter -> SQLite -> WebSocket -> actual Chat view.
// A scripted native process always replaces the provider. No live-provider
// option exists in this queue test; only the browser/runtime path is real.
test('executes an idle five-item queue after the first task through real ACP, SQLite and WebSockets across reloads', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000)
  const root = info.outputPath('runtime')
  await mkdir(root, { recursive: true })
  const bundle = join(root, 'queue-server.mjs')
  await build({ entryPoints: ['tests/fixtures/chat/queue-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('server/process.ts')).href) }, logLevel: 'silent' })
  const child = spawn(process.execPath, [bundle], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, POISE_DB: join(root, 'chat.sqlite3'), POISE_EDITOR_DIR: join(root, 'editor'), POISE_LOCK_DIR: join(root, 'locks'),
      LATENCY_ROOT: root, LATENCY_SOURCE_ROOT: process.cwd(), LATENCY_ASSETS_URL: baseURL! },
  })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_096) })
  try {
    const ready = await new Promise<{ port: number, sessionId: string }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture startup deadline: ${stderr}`)), 60_000)
      let output = ''
      child.stdout!.on('data', chunk => {
        output += String(chunk)
        for (const line of output.split('\n')) {
          try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); done(value) } } catch { /* not the ready line */ }
        }
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)) })
    })
    const origin = `http://127.0.0.1:${ready.port}`
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'chat') })
    await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
    await page.goto(origin)
    const input = page.locator('.chat-v-composer .chat-input')
    await expect(input).toBeEnabled()
    for (let n = 1; n <= 5; n++) {
      await input.fill(`/queue Item ${n}`); await input.press('Enter')
      await expect(page.locator('.chat-queue-item')).toHaveCount(n)
      await expect(page.locator('.chat-queue-item').last().locator('select')).toBeEnabled()
    }
    const before = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(before.spawnCount).toBe(0)
    expect(before.events.filter((e: any) => e.event.type === 'turn.started')).toEqual([])
    await page.reload()
    await expect(page.locator('.chat-queue-item')).toHaveCount(5)
    await input.fill('First now'); await input.press('Enter')
    await expect(page.locator('.chat-msg-user')).toContainText('First now')
    await page.reload() // execution belongs to the server, not this tab's event listener
    await expect(page.locator('.chat-msg-user')).toHaveCount(6, { timeout: 30_000 })
    await expect(page.locator('.chat-msg-agent').last()).toContainText('DONE: Item 5')
    await expect(page.locator('.chat-message-queue')).toBeHidden()
    const after = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(after.events.filter((e: any) => e.event.type === 'turn.started').map((e: any) => e.event.prompt.text)).toEqual(['First now', 'Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5'])
    expect(after.spawnCount).toBe(1)
    await page.reload()
    await expect(page.locator('.chat-msg-user')).toHaveCount(6)
    expect((await (await page.request.get(`${origin}/__test__/timings`)).json()).spawnCount).toBe(1)
  } finally {
    await stop(child)
  }
})

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(done => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => { clearTimeout(timer); done() })
    child.kill('SIGTERM')
  })
}
