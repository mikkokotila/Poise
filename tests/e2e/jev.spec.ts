import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exampleJevDraft, requestFromDraft } from '../../src/jev-draft'

async function start(page: Page, info: TestInfo, assets: string) {
  const root = info.outputPath('runtime'); await mkdir(root, { recursive: true })
  const bundle = join(root, 'jev-server.mjs')
  await build({ entryPoints: ['tests/fixtures/chat/queue-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('server/process.ts')).href) }, logLevel: 'silent' })
  const child = spawn(process.execPath, [bundle], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, POISE_DB: join(root, 'chat.sqlite3'), POISE_EDITOR_DIR: join(root, 'editor'), POISE_LOCK_DIR: join(root, 'locks'),
    POISE_CHAT_ATTACHMENTS_DIR: join(root, 'attachments'), POISE_ESPANSO_MATCH_DIR: join(root, 'snippets'),
    LATENCY_ROOT: root, LATENCY_SOURCE_ROOT: process.cwd(), LATENCY_ASSETS_URL: assets, JEV_TEST_FIXTURE: '1', JEV_API_KEY: 'fixture-only-key',
  } })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup deadline: ${stderr}`)), 60_000)
    let output = ''
    child.stdout!.on('data', chunk => { output += String(chunk); for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); done(value.port) } } catch { /* readiness line */ } } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)) })
  }).catch(async error => { await stop(child); throw error })
  const origin = `http://127.0.0.1:${port}`
  await page.addInitScript(() => { localStorage.setItem('poise-view', 'chat') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
  await page.goto(origin)
  await expect(page.locator('.chat-session-item.active')).toContainText('Queue integration')
  return { origin, child, calls: async () => (await (await page.request.get(`${origin}/__test__/jev`)).json()).calls as Array<ReturnType<typeof requestFromDraft>> }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 10_000); child.once('exit', () => { clearTimeout(timer); done() }); child.kill('SIGTERM') })
}
async function openBuilder(page: Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.locator('.chat-d-model').selectOption('jev-primitives')
  await expect(page.locator('.chat-d-effort')).toBeHidden()
  await page.getByRole('button', { name: 'Open builder', exact: true }).click()
  await expect(page.locator('.jev-workspace')).toBeVisible()
  await expect(page.locator('.chat-v-composer')).toBeHidden()
}

test('JEV: build all three primitives, get typed results, reuse templates and keep native Chat separate', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000)
  const fixture = await start(page, info, baseURL!)
  try {
    await page.locator('.chat-input').fill('Keep this native Chat draft.')
    await openBuilder(page)
    await page.getByRole('button', { name: 'Try an example', exact: true }).click()
    await page.getByRole('textbox', { name: 'Workspace title', exact: true }).fill('Customer triage')
    await expect(page.locator('.jev-question')).toHaveCount(3)
    await expect(page.locator('.jev-evaluate')).toBeEnabled()
    expect(await fixture.calls()).toHaveLength(0)
    await page.locator('.jev-memories').click()
    await page.getByRole('textbox', { name: 'Memories text' }).fill('Use only the evidence supplied. äö')
    await page.getByRole('button', { name: 'Close memories', exact: true }).click()
    await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-result-card')).toHaveCount(3)
    await expect(page.locator('.jev-result')).toContainText('refund')
    await expect(page.locator('.jev-result')).toContainText('95.0%')
    await expect(page.locator('.jev-result')).toContainText('1.50')
    const calls = await fixture.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0].state).toBe(exampleJevDraft().state)
    for (const question of Object.values(calls[0].questions)) expect(question.instructions).toMatch(/\[Memories\]\nUse only the evidence supplied\. äö$/)
    expect(JSON.stringify(calls)).not.toContain('Keep this native Chat draft')
    const timings = await (await page.request.get(`${fixture.origin}/__test__/timings`)).json()
    expect(timings.spawnCount).toBe(0)
    await page.reload()
    await expect(page.locator('.jev-title')).toHaveValue('Customer triage')
    await expect(page.locator('.jev-result-card')).toHaveCount(3)
    expect(await fixture.calls()).toHaveLength(1)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await page.screenshot({ path: info.outputPath(`jev-results-${theme}.png`), animations: 'disabled' })
    }
    await page.getByRole('button', { name: 'Load snippet', exact: true }).click()
    await page.getByRole('textbox', { name: 'Template name', exact: true }).fill(';customer-triage')
    await page.getByRole('button', { name: 'Save template', exact: true }).click()
    await expect(page.locator('.jev-notice')).toContainText('Saved ;customer-triage')
    const library = await (await page.request.get(`${fixture.origin}/api/snippets`)).json()
    expect(JSON.parse(library.snippets[0].replace)).toEqual(requestFromDraft(exampleJevDraft()))
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
    await expect(page.locator('.chat-input')).toHaveValue('Keep this native Chat draft.')
    await page.locator('.jev-session-item').filter({ hasText: 'Customer triage' }).click()
    await expect(page.locator('.jev-result-card')).toHaveCount(3)
    await page.setViewportSize({ width: 560, height: 680 })
    await expect(page.locator('.jev-evaluate')).toBeInViewport()
    expect(await page.locator('.jev-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  } finally { await stop(fixture.child) }
})

test('JEV: guided editing preserves text, focus and disclosures; Enter never submits', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  try {
    await openBuilder(page)
    await page.getByRole('textbox', { name: 'State', exact: true }).fill('\nA time-sensitive refund request.')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('\nIs the request time-sensitive?')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).press('Enter')
    expect(await w.calls()).toHaveLength(0)
    await page.getByRole('combobox', { name: 'Primitive', exact: true }).selectOption('score')
    await expect(page.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('\nA time-sensitive refund request.')
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('\nIs the request time-sensitive?\n')
    const levels = page.getByRole('textbox', { name: 'Level description', exact: true })
    for (let i = 0; i < 3; i++) await levels.nth(i).fill(['No time constraint', 'Needed this week', 'Needed today'][i])
    await page.locator('.jev-question > summary').click()
    await page.getByRole('button', { name: '+ Yes / no', exact: true }).click()
    await expect(page.locator('.jev-question').first()).not.toHaveAttribute('open', '')
    await page.locator('.jev-question').last().getByRole('textbox', { name: 'Instructions', exact: true }).fill('Is a refund requested?')
    await page.getByRole('button', { name: 'Request JSON', exact: true }).click()
    const raw = JSON.parse(await page.getByRole('textbox', { name: 'Request JSON', exact: true }).inputValue())
    expect(raw.questions.question_1.criteria).toEqual(['No time constraint', 'Needed this week', 'Needed today'])
    await page.getByRole('button', { name: 'Build', exact: true }).click()
    for (const theme of ['light', 'dark']) { await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme); await page.screenshot({ path: info.outputPath(`jev-builder-${theme}.png`), animations: 'disabled' }) }
    await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-result-card')).toHaveCount(2)
    expect(await w.calls()).toHaveLength(1)
  } finally { await stop(w.child) }
})

test('JEV: Stop and provider errors retain an editable builder without retrying', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  try {
    await openBuilder(page)
    const state = page.getByRole('textbox', { name: 'State', exact: true })
    await state.fill('JEV_TEST_WAIT')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Is this urgent?')
    await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-cancel')).toBeVisible()
    await state.fill('Newer unsent state')
    await page.locator('.jev-cancel').click()
    await expect(page.locator('.jev-result')).toContainText('Evaluation stopped')
    await expect(state).toHaveValue('Newer unsent state')
    expect(await w.calls()).toHaveLength(1)
    await state.fill('JEV_TEST_LIMIT'); await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-result')).toContainText('rate-limited')
    await expect(page.locator('.jev-evaluate')).toBeEnabled()
    await state.fill('JEV_TEST_BAD'); await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-result')).toContainText('different number of answers')
    await page.reload()
    await expect(page.locator('.jev-result')).toContainText('different number of answers')
    expect(await w.calls()).toHaveLength(3)
    await expect(page.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('JEV_TEST_BAD')
  } finally { await stop(w.child) }
})

for (const delivered of [false, true]) test(`JEV: an uncertain submission keeps its identity (delivered=${delivered})`, async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  try {
    await openBuilder(page); await page.getByRole('button', { name: 'Try an example', exact: true }).click()
    const ids: string[] = []; let recovering = false
    await page.route('**/api/jev/runs/*', route => recovering ? route.continue() : route.fulfill({ status: 404, json: { error: 'Receipt not yet visible' } }))
    await page.route('**/api/jev/sessions/*/runs', async route => {
      if (route.request().method() !== 'POST') { if (recovering) await route.continue(); else await route.fulfill({ json: { runs: [] } }); return }
      ids.push(route.request().postDataJSON().id)
      if (ids.length === 1) { if (delivered) await route.fetch(); await route.abort(); return }
      await route.continue()
    })
    await page.locator('.jev-evaluate').click()
    await expect(page.locator('.jev-resubmit')).toBeVisible()
    await expect(page.locator('.jev-evaluate')).toBeDisabled()
    expect(await w.calls()).toHaveLength(delivered ? 1 : 0)
    recovering = true
    await page.locator('.jev-resubmit').click()
    await expect(page.locator('.jev-result-card')).toHaveCount(3)
    expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0])
    expect(await w.calls()).toHaveLength(1)
  } finally { await stop(w.child) }
})

test('JEV: another tab cannot overwrite an unsaved builder without an explicit choice', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!), other = await page.context().newPage()
  try {
    await openBuilder(page)
    await page.getByRole('textbox', { name: 'Workspace title', exact: true }).fill('Shared builder')
    await page.getByRole('textbox', { name: 'State', exact: true }).fill('Original state')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Does it apply?')
    await expect(page.locator('.jev-save-status')).toHaveText('Builder saved')
    await other.goto(w.origin)
    await other.locator('.jev-session-item').filter({ hasText: 'Shared builder' }).click()
    await expect(other.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('Original state')
    await page.getByRole('textbox', { name: 'State', exact: true }).fill('Saved from first tab')
    await expect(page.locator('.jev-save-status')).toHaveText('Builder saved')
    await other.getByRole('textbox', { name: 'State', exact: true }).fill('My deliberate second version')
    await expect(other.locator('.jev-conflict')).toBeVisible()
    await expect(other.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('My deliberate second version')
    await other.getByRole('button', { name: 'Save my version', exact: true }).click()
    await expect(other.locator('.jev-save-status')).toHaveText('Builder saved')
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('My deliberate second version')
    expect(await w.calls()).toHaveLength(0)
  } finally { await other.close(); await stop(w.child) }
})

test('JEV: the builder works without a native catalogue or key and never exposes credentials', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  try {
    await page.route('**/api/chat/agents', route => route.fulfill({ status: 503, json: { error: 'Native agents unavailable' } }))
    await page.route('**/api/jev/config', route => route.fulfill({ json: { configured: false, model: 'jev-latest' } }))
    await page.reload()
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await page.getByRole('button', { name: 'JEV · Primitive builder', exact: true }).click()
    await expect(page.locator('.jev-workspace')).toBeVisible()
    await page.getByRole('button', { name: 'Try an example', exact: true }).click()
    await expect(page.locator('.jev-evaluate')).toBeDisabled()
    await expect(page.locator('.jev-validation')).toContainText('JEV_API_KEY')
    const response = await page.request.get(w.origin + '/api/jev/config')
    const config = await response.json()
    expect(Object.keys(config).sort()).toEqual(['configured', 'model'])
    expect(await page.content()).not.toContain('fixture-only-key')
    expect(await page.content()).not.toContain('test-jev-key')
    const denied = await page.request.post(w.origin + '/api/jev/preview', { headers: { Origin: 'https://untrusted.example' }, data: requestFromDraft(exampleJevDraft()) })
    expect(denied.status()).toBe(403)
    expect(await w.calls()).toHaveLength(0)
  } finally { await stop(w.child) }
})


test('JEV: advanced JSON preserves structured primitives, imports text and discovers models without evaluating', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  try {
    await openBuilder(page)
    await page.locator('.jev-file').setInputFiles({ name: 'ticket.json', mimeType: 'application/json', buffer: Buffer.from('{"message":"A refund today"}') })
    await expect(page.getByRole('textbox', { name: 'State', exact: true })).toHaveValue('{"message":"A refund today"}')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Is a refund requested?')
    await page.getByRole('button', { name: 'Request JSON', exact: true }).click()
    const request = { model: 'jev-preview', state: { message: 'A refund today' }, questions: {
      check: { type: 'noul', instructions: { question: 'Is a refund requested?', context: ['Only explicit requests'] }, criteria: { true: ['Explicit refund'], false: { evidence: 'None' } } },
      route: { type: 'choice', instructions: ['Choose a team'], criteria: { billing: { description: 'Refunds' }, other: null } },
      rating: { type: 'score', instructions: 'How urgent?', criteria: ['No deadline', { description: 'Today' }] },
    } }
    await page.getByRole('textbox', { name: 'Request JSON', exact: true }).fill(JSON.stringify(request, null, 2))
    await page.getByRole('button', { name: 'Build', exact: true }).click()
    await expect(page.locator('.jev-question')).toHaveCount(3)
    await expect(page.locator('.jev-shape').first()).toContainText('probability of yes')
    await page.getByRole('button', { name: 'Request JSON', exact: true }).click()
    expect(JSON.parse(await page.getByRole('textbox', { name: 'Request JSON', exact: true }).inputValue())).toEqual(request)
    expect(await w.calls()).toHaveLength(0)
    await page.reload()
    expect(JSON.parse(await page.getByRole('textbox', { name: 'Request JSON', exact: true }).inputValue())).toEqual(request)
    await page.getByRole('button', { name: 'Build', exact: true }).click()
    await page.locator('.jev-advanced > summary').click()
    await expect(page.locator('#jev-models option')).toHaveCount(2)
  } finally { await stop(w.child) }
})


test('JEV: a delayed history poll cannot bring a stopped evaluation back to running', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  const w = await start(page, info, baseURL!)
  let release!: () => void, delayed = false
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await openBuilder(page)
    await page.getByRole('textbox', { name: 'State', exact: true }).fill('JEV_TEST_WAIT')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Is this urgent?')
    await page.route('**/api/jev/sessions/*/runs', async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return }
      const response = await route.fetch(), body = await response.json()
      if (!delayed && body.runs.some((r: { status: string }) => r.status === 'running')) { delayed = true; await held }
      await route.fulfill({ response, json: body })
    })
    await page.locator('.jev-evaluate').click()
    await expect.poll(() => delayed).toBe(true)
    await page.locator('.jev-cancel').click()
    await expect(page.locator('.jev-result')).toContainText('Evaluation stopped')
    const response = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'GET')
    release(); await response
    await expect(page.locator('.jev-result')).toContainText('Evaluation stopped')
    await expect(page.locator('.jev-cancel')).toBeHidden()
    expect(await w.calls()).toHaveLength(1)
  } finally { release(); await stop(w.child) }
})
