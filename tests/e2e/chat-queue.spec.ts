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
    // The writable fresh console can appear before history has loaded. This
    // journey deliberately targets the existing Grok fixture conversation.
    await expect(page.locator('.chat-session-item.active')).toContainText('Queue integration')
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
    // Memories edited after enqueue must still be included when items run.
    await page.getByRole('button', { name: 'Memories', exact: true }).click()
    const memory = page.getByRole('textbox', { name: 'Memories text' })
    await expect(memory).toBeEnabled()
    await memory.fill('Remember this on every queued task: äö.')
    await page.getByRole('button', { name: 'Close memories' }).click()
    await input.fill('First now'); await input.press('Enter')
    await expect(page.locator('.chat-msg-user')).toContainText('First now')
    await page.reload() // execution belongs to the server, not this tab's event listener
    await expect(page.locator('.chat-msg-user')).toHaveCount(6, { timeout: 30_000 })
    await expect(page.locator('.chat-msg-agent').last()).toContainText('DONE: Item 5')
    await expect(page.locator('.chat-message-queue')).toBeHidden()
    const after = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(after.events.filter((e: any) => e.event.type === 'turn.started').map((e: any) => e.event.prompt.text)).toEqual(['First now', 'Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5'])
    expect(after.spawnCount).toBe(1)
    expect(after.nativeInputs).toHaveLength(6)
    for (const blocks of after.nativeInputs) {
      expect(blocks.at(-1)).toEqual({ type: 'text', text: '\n\n[Memories]\nRemember this on every queued task: äö.' })
    }
    await page.reload()
    await expect(page.locator('.chat-msg-user')).toHaveCount(6)
    expect((await (await page.request.get(`${origin}/__test__/timings`)).json()).spawnCount).toBe(1)
    // The same real browser/runtime/stdio journey now chains a chosen model
    // into the Poise reply-review instruction rather than a native diff review.
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    await input.fill('/model')
    await page.locator('.chat-command-models [data-identity="grok-4.6-high"]').click()
    await input.fill('/review'); await input.press('Space'); await input.press('Enter')
    await expect.poll(async () => {
      const state = await (await page.request.get(`${origin}/__test__/timings`)).json()
      return state.events.filter((row: any) => row.event.type === 'turn.finished').length
    }, { timeout: 30_000 }).toBe(7)
    const reviewed = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(reviewed.spawnCount).toBe(1); expect(reviewed.nativeInputs).toHaveLength(7)
    const reviewBlocks = reviewed.nativeInputs[6] as Array<{ type: string, text?: string }>
    const reviewText = reviewBlocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(reviewText).toContain('adversarial critical review of the latest assistant reply')
    expect(reviewText).toContain('DONE: Item 5')
    expect(reviewText).toContain('Full preceding history index:')
    expect(reviewBlocks.at(-1)).toEqual({ type: 'text', text: '\n\n[Memories]\nRemember this on every queued task: äö.' })
    await page.reload()
    await expect(page.locator('.chat-msg-user')).toHaveCount(7)
    await expect(page.locator('.chat-msg-user').last()).toContainText('/model grok-4.6-high /review')
    // Exercise an attachment-bearing steer through the actual runtime/stdio,
    // then replay its file badge from SQLite after a browser reload.
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    await input.fill('QC steering task'); await input.press('Enter')
    await expect(page.locator('.chat-h-status')).toHaveText('running')
    await page.locator('.chat-file-input').setInputFiles({ name: 'steering-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Additional context: äö.') })
    await expect(page.locator('.chat-attachment-chip')).toContainText('steering-notes.txt')
    await input.fill('Use these notes too'); await input.press('Enter')
    await expect(page.locator('.chat-msg-steer')).toContainText('steering-notes.txt')
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    const steered = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(steered.nativeSteers).toHaveLength(1)
    expect(steered.nativeSteers[0]).toContain('Additional context: äö.')
    expect(steered.nativeSteers[0]).toContain('steering-notes.txt')
    expect(steered.nativeSteers[0].endsWith('[Memories]\nRemember this on every queued task: äö.')).toBe(true)
    expect(steered.events.filter((row: any) => row.event.type === 'turn.started')).toHaveLength(8)
    await page.reload()
    await expect(page.locator('.chat-msg-steer')).toContainText('Use these notes too')
    await expect(page.locator('.chat-msg-steer')).toContainText('steering-notes.txt')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await page.screenshot({ path: info.outputPath(`qc-steering-${theme}.png`), animations: 'disabled' })
    }
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    // /create is a local library edit: no native prompt, checkout action or turn.
    await input.fill('/create /release-notes\nUse concrete outcomes, evidence and limitations.'); await input.press('Enter')
    await expect(page.locator('.chat-notice')).toContainText('Saved /release-notes')
    const library = await (await page.request.get(`${origin}/api/chat/switches`)).json()
    expect(library.switches).toHaveLength(1)
    expect(library.switches[0]).toMatchObject({ name: 'release-notes', revision: 1, content: 'Use concrete outcomes, evidence and limitations.' })
    const created = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(created.nativeInputs).toHaveLength(8); expect(created.spawnCount).toBe(1)
    const nativeBefore = steered.session.nativeSessionId
    await input.fill('/compact'); await input.press('Space'); await input.press('Enter')
    await expect(page.locator('.chat-note')).toContainText('native compaction command')
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    await expect(page.locator('.chat-msg-steer')).toContainText('steering-notes.txt')
    const compacted = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(compacted.session.nativeSessionId).toBe(nativeBefore)
    expect(compacted.nativeInputs).toHaveLength(9)
    expect(compacted.nativeInputs[8][0].text).toBe('/compact')
    expect(compacted.nativeInputs[8].at(-1).text).toBe('\n\n[Memories]\nRemember this on every queued task: äö.')
    await input.fill('/reset'); await input.press('Space'); await input.press('Enter')
    await expect(page.locator('.chat-note')).toContainText('Chat reset')
    await expect(page.locator('.chat-msg-user')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.chat-msg-user')).toHaveCount(0)
    await expect(page.locator('.chat-note')).toContainText('Chat reset')
    const reset = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(reset.session.nativeSessionId).toBeUndefined()
    expect(reset.nativeInputs).toHaveLength(9)
    await input.fill('A wholly fresh task'); await input.press('Enter')
    await expect(page.locator('.chat-msg-agent')).toContainText('DONE: A wholly fresh task')
    const fresh = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(fresh.spawnCount).toBe(2)
    expect(fresh.sessionId).toBe(ready.sessionId)
    expect(fresh.session.nativeSessionId).not.toBe(nativeBefore)
    expect(fresh.nativeInputs.at(-1)[0].text).toBe('A wholly fresh task')
    expect(fresh.nativeInputs.at(-1).at(-1).text).toBe('\n\n[Memories]\nRemember this on every queued task: äö.')
    // The library survives reset/reload. Queue expansion uses the last saved body.
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    await input.fill('/queue /release-notes Describe the result'); await input.press('Enter')
    await expect(page.locator('.chat-message-queue')).toContainText('/release-notes Describe the result')
    await input.fill('/create /release-notes\nUpdated reusable instructions: concrete outcomes only.'); await input.press('Enter')
    await expect(page.locator('.chat-notice')).toContainText('Updated /release-notes')
    await input.fill('Initial task for the saved-switch queue'); await input.press('Enter')
    await expect(page.locator('.chat-msg-agent').last()).toContainText('DONE: Describe the result')
    await expect(page.locator('.chat-h-status')).toHaveText('idle')
    const reused = await (await page.request.get(`${origin}/__test__/timings`)).json()
    expect(reused.nativeInputs).toHaveLength(12)
    expect(reused.nativeInputs.at(-1)[0].text).toBe('Describe the result\n\n[Saved switch: /release-notes]\nUpdated reusable instructions: concrete outcomes only.\n[End saved switch: /release-notes]')
    expect(reused.nativeInputs.at(-1).at(-1).text).toBe('\n\n[Memories]\nRemember this on every queued task: äö.')
    await page.reload(); await input.fill('/release')
    await expect(page.locator('.chat-pop-label')).toHaveText('/release-notes')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await page.screenshot({ path: info.outputPath(`saved-switch-${theme}.png`), animations: 'disabled' })
    }
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
