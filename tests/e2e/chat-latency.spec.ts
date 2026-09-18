import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real agent stdio -> ACP adapter -> SQLite -> WebSocket -> actual Chat view.
// Default uses a timestamping fixture process. POISE_CHAT_LATENCY_LIVE=grok
// explicitly opts into one harmless installed-agent turn using its own login.
test('renders native streamed events within one second through the real transport', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000)
  const root = info.outputPath('runtime')
  await mkdir(root, { recursive: true })
  const bundle = join(root, 'latency-server.mjs')
  await build({ entryPoints: ['tests/fixtures/chat/latency-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
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
    const live = process.env.POISE_CHAT_LATENCY_LIVE === 'grok'
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'chat') })
    await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
    await page.goto(origin)
    const input = page.locator('.chat-v-composer .chat-input')
    await expect(input).toBeEnabled()
    await expect(page.locator('.chat-session-item.active')).toContainText('Streaming latency')
    await page.evaluate(isLive => {
      const samples: Array<{ index: number, paintAt: number, emittedAt?: number }> = []
      ;(window as any).__latencySamples = samples
      const seen = new Set<number>()
      new MutationObserver(() => {
        const text = [...document.querySelectorAll('.chat-msg-agent .chat-msg-body')].map(node => node.textContent).join('')
        const pattern = isLive ? /LATENCY_MARKER_(\d+)(?!\d)/g : /LATENCY_MARKER_(\d+)_(\d{13})/g
        for (const match of text.matchAll(pattern)) {
          const index = Number(match[1]); if (seen.has(index)) continue
          seen.add(index)
          // The second animation frame is after at least one rendering
          // opportunity for the DOM change, not just socket receipt.
          requestAnimationFrame(() => requestAnimationFrame(() => samples.push({ index, paintAt: performance.timeOrigin + performance.now(), ...(match[2] ? { emittedAt: Number(match[2]) } : {}) })))
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    }, live)
    await input.fill(live ? 'Reply with exactly LATENCY_MARKER_0 and nothing else. Do not use tools.' : 'Stream the fixture samples.')
    await input.press('Enter')
    await expect.poll(() => page.evaluate(() => (window as any).__latencySamples.length), { timeout: 60_000 }).toBe(live ? 1 : 8)
    const samples = await page.evaluate(() => (window as any).__latencySamples as Array<{ index: number, paintAt: number, emittedAt?: number }>)
    const observed = await (await page.request.get(`${origin}/__test__/timings`)).json() as { nativeFrames: Array<{ at: number, text: string }>, spawnCount: number }
    expect(observed.nativeFrames.length).toBeGreaterThan(0)
    const milliseconds = samples.map(sample => sample.paintAt - (sample.emittedAt ?? observed.nativeFrames[0].at))
    const report = { mode: live ? 'installed Grok: native stdout to browser paint' : 'scripted ACP process: stdout emission to browser paint', samples: milliseconds.length,
      firstMs: milliseconds[0], maxMs: Math.max(...milliseconds), milliseconds }
    await info.attach('agent-to-browser-latency.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
    console.log(`CHAT_LATENCY ${JSON.stringify(report)}`)
    expect(report.maxMs).toBeLessThan(1_000)
    // Reload uses the real durable transcript; it must neither replay the
    // prompt nor start another native process.
    await page.reload()
    await expect(page.locator('.chat-msg-agent')).toContainText('LATENCY_MARKER_0')
    const reloaded = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(reloaded.spawnCount).toBe(observed.spawnCount)
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
