import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../model-catalog-fixture'

type ClaudeAuthStatus =
  | 'checking'
  | 'authenticated'
  | 'reauth_required'
  | 'signing_in'
  | 'degraded'
  | 'unavailable'

interface ClaudeAuthResponse {
  status: ClaudeAuthStatus
  reason: string | null
  checkedAt: string | null
  verifiedAt: string | null
  authMethod: string | null
  subscriptionType: string | null
  loginInProgress: boolean
}

function authState(
  status: ClaudeAuthStatus,
  overrides: Partial<ClaudeAuthResponse> = {},
): ClaudeAuthResponse {
  return {
    status,
    reason: null,
    checkedAt: '2026-07-15T09:00:00.000Z',
    verifiedAt: status === 'authenticated' ? '2026-07-15T09:00:00.000Z' : null,
    authMethod: status === 'authenticated' ? 'claude.ai' : null,
    subscriptionType: status === 'authenticated' ? 'max' : null,
    loginInProgress: status === 'signing_in',
    ...overrides,
  }
}

type AuthResolver = (method: string) => ClaudeAuthResponse | Promise<ClaudeAuthResponse>

async function installApiRoutes(
  page: Page,
  resolveAuth: AuthResolver = () => authState('authenticated'),
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/claude-auth' || url.pathname === '/api/claude-auth/login') {
      const method = route.request().method()
      await route.fulfill({
        status: method === 'POST' ? 202 : 200,
        json: await resolveAuth(method),
      })
      return
    }
    if (url.pathname === '/api/settings') {
      await route.fulfill({
        json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} },
      })
      return
    }
    if (url.pathname === '/api/models') {
      await route.fulfill({ json: modelsResponse({}) })
      return
    }
    if (url.pathname === '/api/gh') {
      const body = route.request().postDataJSON() as { count_only?: boolean }
      await route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
      return
    }
    await route.fulfill({ json: {} })
  })
}

type ModelChoice = { default: string, fallback: string, secondary?: string, tertiary?: string }

// What /api/models answers for the catalog fixture and the given choices:
// every place resolved to its stored choice or the Caller default, and the
// PR review place with its secondary and tertiary reviewer.
function modelsResponse(models: Record<string, ModelChoice>) {
  const places = [
    { key: 'chat', label: 'Chat', why: 'Card chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'editor', label: 'Editor chat', why: 'Editor chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'pr_review', label: 'PR review', why: 'Reviews.', review: true, reviewers: true, seed: 'pr_review' },
    { key: 'pr_approve', label: 'PR approval', why: 'Approvals.', review: true, reviewers: false, seed: 'pr_approve' },
  ].map((place) => ({
    ...place,
    default: models[place.key]?.default || CATALOG.behaviors[place.seed as keyof typeof CATALOG.behaviors],
    fallback: models[place.key]?.fallback || CATALOG.behaviors.review_recovery,
    ...(place.reviewers
      ? { secondary: models[place.key]?.secondary || 'gpt-6-astra-ultra', tertiary: models[place.key]?.tertiary || 'grok-4.6-xhigh' }
      : {}),
    notes: [],
    stored: models[place.key] || null,
  }))
  const fixed = [{ key: 'content', label: '/content', model: CATALOG.behaviors.author_content, why: 'Set by Caller.' }]
  return { catalog: CATALOG, places, fixed, refresh: null }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'main')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await installApiRoutes(page)
})

test('boots the configured dashboard with deterministic API data', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('Poise')
  await expect(page.locator('#view-main')).toBeVisible()
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
  await expect(page.locator('#loader')).toBeHidden()
  await expect(page.locator('#tbody tr')).toHaveCount(0)
  await expect(page.locator('#claude-auth-banner')).toHaveCount(0)
})

test('prompts once for Claude subscription sign-in and clears after recovery', async ({ page }) => {
  await page.unroute('**/api/**')
  let currentAuth = authState('reauth_required', { reason: 'credentials_rejected' })
  let loginRequests = 0
  await installApiRoutes(page, (method) => {
    if (method === 'POST') {
      loginRequests += 1
      currentAuth = authState('signing_in', { loginInProgress: true })
    }
    return currentAuth
  })

  await page.goto('/')

  const alert = page.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toContainText('Claude subscription sign-in required')
  await expect(alert).toContainText('Claude Max or Pro subscription')
  await expect(alert).not.toContainText(/API key|Console/)
  const title = alert.locator('.claude-auth-title')
  await title.evaluate((element) => { element.setAttribute('data-render-identity', 'stable') })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(title).toHaveAttribute('data-render-identity', 'stable')
  await page.locator('#search-input').fill('app remains usable')
  await expect(page.locator('#search-input')).toHaveValue('app remains usable')

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.claude-auth-login')
    button?.click()
    button?.click()
  })
  await expect(alert).toContainText('Complete Claude sign-in in your browser')
  await expect(alert.getByRole('button')).toHaveCount(0)
  await expect.poll(() => loginRequests).toBe(1)

  currentAuth = authState('authenticated')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('offers reconnection after ambiguous failures but not when the CLI is unavailable', async ({ page }) => {
  await page.unroute('**/api/**')
  let currentAuth = authState('degraded', { reason: 'network_error' })
  let loginRequests = 0
  await installApiRoutes(page, (method) => {
    if (method === 'POST') {
      loginRequests += 1
      currentAuth = authState('signing_in', { loginInProgress: true })
    }
    return currentAuth
  })

  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toContainText('Claude subscription verification failed')
  await alert.getByRole('button', { name: 'Reconnect Claude' }).click()
  await expect.poll(() => loginRequests).toBe(1)
  await expect(alert).toContainText('Complete Claude sign-in in your browser')

  currentAuth = authState('unavailable', { reason: 'cli_missing' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(alert).toContainText('Claude subscription check unavailable')
  await expect(alert.getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(1)
})

test('keeps the empty dashboard layout visually stable', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#loader')).toBeHidden()
  await expect(page.locator('#view-main')).not.toHaveClass(/view-entering/)

  await expect(page).toHaveScreenshot('configured-empty-dashboard.png', {
    fullPage: true,
  })
})

test('saves a review model choice and restores it after reload', async ({ page }) => {
  let settings: { org: string, me: string, timezone: string, models: Record<string, ModelChoice> } = { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} }
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() }
    await route.fulfill({ json: settings })
  })
  await page.route('**/api/models', async (route) => {
    await route.fulfill({ json: modelsResponse(settings.models) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await page.getByRole('tab', { name: 'Models' }).click()
  const model = page.getByLabel('PR review default model')
  await expect(model).toHaveValue('opus-5-xhigh')
  await expect(page.getByLabel('PR review fallback model')).toHaveValue('gpt-6-astra-ultra')
  // Every place offers every catalog model; review places follow the providers Caller lists.
  await expect(model.locator('option')).toHaveCount(14)
  await expect(page.getByLabel('Chat default model', { exact: true }).locator('option')).toHaveCount(14)
  await expect(page.locator('.st-models-fixed')).toContainText('opus-5-max')
  // Only the PR review place names a secondary and a tertiary reviewer.
  await expect(page.getByLabel('PR review secondary reviewer')).toHaveValue('gpt-6-astra-ultra')
  await expect(page.getByLabel('PR review tertiary reviewer')).toHaveValue('grok-4.6-xhigh')
  await expect(page.getByLabel('PR approval secondary reviewer')).toHaveCount(0)
  await model.selectOption('gpt-6-astra-ultra')
  await page.getByLabel('PR review fallback model').selectOption('opus-5-xhigh')
  await page.getByLabel('PR review secondary reviewer').selectOption('gpt-6-astra-ultra')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('pr_review: the secondary reviewer must differ from the default.')
  await page.getByLabel('PR review secondary reviewer').selectOption('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(settings.models.pr_review).toEqual({ default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh', secondary: 'muse-spark-1.3-contributor-max', tertiary: 'grok-4.6-xhigh' })
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await page.getByRole('tab', { name: 'Models' }).click()
  await expect(page.getByLabel('PR review default model')).toHaveValue('gpt-6-astra-ultra')
  await expect(page.getByLabel('PR review fallback model')).toHaveValue('opus-5-xhigh')
  await expect(page.getByLabel('PR review secondary reviewer')).toHaveValue('muse-spark-1.3-contributor-max')
})

test('shows in Settings whether production is on main', async ({ page }) => {
  const deployed = 'b'.repeat(40)
  let production: Record<string, unknown> = {
    status: 'failed',
    checkedAt: new Date().toISOString(),
    deployedCommit: deployed,
    remoteCommit: 'c'.repeat(40),
    behind: 2,
    failingSince: new Date(Date.now() - 6 * 60_000).toISOString(),
    error: 'Remote Poise main is not a fast-forward of the deployed commit',
  }
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ json: { status: 'ok', production } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  const line = page.locator('.st-production')
  await expect(line).toBeVisible()
  await expect(line).toContainText('Deployed bbbbbbb · main ccccccc — 2 commits behind; updater failing since')
  await expect(line).toContainText('not a fast-forward')
  await expect(line).toHaveClass(/st-help-error/)

  // Back on main: the same line, quiet.
  production = { ...production, status: 'current', remoteCommit: deployed, behind: 0, failingSince: null, error: null }
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(line).toHaveText('Deployed bbbbbbb · main bbbbbbb — up to date, checked just now.')
  await expect(line).toHaveClass(/st-help-info/)

  // A dev server has no record, and no Production group.
  production = { status: 'unknown', checkedAt: null, deployedCommit: null, remoteCommit: null, behind: null, failingSince: null, error: null }
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
  await expect(page.locator('.st-production-group')).toBeHidden()
})

test('chooses how many reviewers each new pull request gets from Behaviors', async ({ page }) => {
  let reviewers = 1
  const writes: Array<Record<string, unknown>> = []
  const behavior = (extra: Record<string, unknown>) => ({
    owner: 'review-bot', enabled: false, setting: null, reviewers: null, scratchpad: '', lastTriggered: null, ...extra,
  })
  await page.route('**/api/behaviors', async (route) => {
    await route.fulfill({ json: {
      'review-new-prs': behavior({ setting: 'p2', reviewers }),
      'approve-prs': behavior({}),
      'resolve-unblocking': behavior({ scratchpad: null }),
      diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null }, identity: { status: 'valid', actor: 'review-bot', error: null }, failures: [], deadLetters: [] },
    } })
  })
  await page.route('**/api/behaviors/review-new-prs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    writes.push(body)
    if (typeof body.reviewers === 'number') reviewers = body.reviewers
    await route.fulfill({ json: { ok: true, enabled: false, setting: 'p2', reviewers, scratchpad: '' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  const select = page.getByLabel('Reviewers for review-new-prs')
  await expect(select).toHaveValue('1')
  await expect(page.locator('#behaviors-table thead')).toContainText('Reviewers')
  // The other behaviors have no reviewer count.
  await expect(page.getByLabel('Reviewers for approve-prs')).toHaveCount(0)
  await select.selectOption('3')
  await expect.poll(() => writes).toEqual([{ reviewers: 3 }])
  await page.reload()
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.getByLabel('Reviewers for review-new-prs')).toHaveValue('3')
})

test('opts repositories and trusted authors into Review New Issues from Behaviors', async ({ page }) => {
  let state: Record<string, unknown> = { repos: [], authors: ['mikkokotila', 'zero-bang', 'bit-mis'], reviewers: 1 }
  const writes: Array<Record<string, unknown>> = []
  const behavior = (extra: Record<string, unknown>) => ({
    owner: 'bit-mis', enabled: false, setting: null, reviewers: null, scratchpad: '', lastTriggered: null, ...extra,
  })
  await page.route('**/api/behaviors', async (route) => {
    await route.fulfill({ json: {
      'review-new-prs': behavior({ setting: 'p2', reviewers: 1 }),
      'approve-prs': behavior({}),
      'resolve-unblocking': behavior({ scratchpad: null }),
      'review-new-issues': behavior({ ...state }),
      diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null }, identity: { status: 'valid', actor: 'bit-mis', error: null }, failures: [], deadLetters: [] },
    } })
  })
  await page.route('**/api/behaviors/review-new-issues', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    writes.push(body)
    state = { ...state, ...body }
    await route.fulfill({ json: { ok: true, enabled: false, setting: null, scratchpad: '', ...state } })
  })
  await page.route('**/api/repos', async (route) => {
    await route.fulfill({ json: { repos: ['Vaquum/Limen', 'Vaquum/Origo', 'Vaquum/Praxis'] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  const row = page.locator('tr[data-behavior="review-new-issues"]')
  await expect(row).toContainText('Review New Issues')
  await expect(row).toContainText('bit-mis')
  const pill = row.locator('.behavior-triggers-btn')
  await expect(pill).toHaveText('No repos')

  await pill.click()
  const dialog = page.getByRole('dialog', { name: /Review New Issues/ })
  await expect(dialog).toBeVisible()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.locator('.bt-repo')).toHaveCount(3)
  const filter = dialog.locator('.bt-filter')
  await expect(filter).toBeFocused()
  await filter.fill('ori')
  await expect(dialog.locator('.bt-repo')).toHaveCount(1)
  // The keyboard reaches the list from the filter.
  await filter.press('ArrowDown')
  const origo = dialog.getByRole('checkbox', { name: 'Origo' })
  await expect(origo).toBeFocused()
  await origo.press('Space')
  await expect(origo).toBeChecked()
  await dialog.getByLabel('Trusted authors').fill('mikkokotila, zero-bang')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => writes).toEqual([{ repos: ['Vaquum/Origo'], authors: ['mikkokotila', 'zero-bang'] }])
  await expect(dialog).toBeHidden()
  await expect(pill).toHaveText('1 repo')
  await expect(pill).toBeFocused()
  // The refresh tick repaints the pill without taking focus from it.
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('behavior-triggers-btn'))).toBe(true)

  // A name GitHub would not accept keeps the dropdown open, with the reason.
  await pill.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.bt-repo')).toHaveCount(3)
  await dialog.getByLabel('Trusted authors').fill('mikkokotila name!')
  await page.keyboard.press('Escape')
  await expect(dialog.locator('.bt-status')).toContainText('Not a GitHub username: name!')
  await expect(dialog).toBeVisible()
  // Escape saves as well, like every other way of closing.
  await dialog.getByLabel('Trusted authors').fill('mikkokotila')
  await dialog.getByRole('checkbox', { name: 'Origo' }).uncheck()
  await page.keyboard.press('Escape')
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({ repos: [], authors: ['mikkokotila'] })
  await expect(dialog).toBeHidden()
  await expect(pill).toHaveText('No repos')

  // The issue review keeps its own reviewer count.
  await page.getByLabel('Reviewers for review-new-issues').selectOption('2')
  await expect.poll(() => writes.length).toBe(3)
  expect(writes[2]).toEqual({ reviewers: 2 })

  // With the state unreadable, what the pill shows may be a guess: it cannot be
  // opened, so nothing can be saved over the stored list.
  await page.unroute('**/api/behaviors')
  await page.route('**/api/behaviors', (route) => route.fulfill({ status: 500, json: { error: 'down' } }))
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(pill).toBeDisabled()
})

test('stops a running run from Swarm after a second click, and settles the row', async ({ page }) => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const id = 'c'.repeat(32)
  const done = 'd'.repeat(32)
  let row = {
    id, pr_id: '320', repo: 'Vaquum/Origo', actor: 'bit-mis', model: 'opus-5-high',
    behavior: 'pr_review', session_id: null, prompt: '', started_at: ago(5 * 60_000),
    started_at_precise: ago(5 * 60_000), completed_at: null as string | null,
    time_elapsed: '5m', status: 'running', outcome: null as string | null, response: '', error: '', error_code: null as string | null, progress: null,
  }
  const finished = { ...row, id: done, status: 'completed', completed_at: ago(60_000), outcome: 'reviewed_clean' }
  const stops: string[] = []
  await page.route('**/api/agent-logs', async (route) => {
    await route.fulfill({ json: { logs: [row, finished] } })
  })
  await page.route('**/api/agent-stop', async (route) => {
    stops.push(route.request().postDataJSON().id)
    row = { ...row, status: 'failed', completed_at: ago(0), error: 'Stopped by user', error_code: 'stopped' }
    await route.fulfill({ json: { id, stopped: true, status: 'failed', error_code: 'stopped' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const running = page.locator(`.agent-row[data-id="${id}"]`)
  const settled = page.locator(`.agent-row[data-id="${done}"]`)
  // Only a running row can be stopped.
  await expect(settled.locator('.stop-cell')).toHaveText('—')
  const stop = running.getByRole('button', { name: 'Stop this run' })
  await stop.click()
  expect(stops).toEqual([])
  await running.getByRole('button', { name: 'Confirm stopping this run' }).click()
  await expect.poll(() => stops).toEqual([id])
  await expect(running).toContainText('failed')
  await expect(running.locator('.stop-cell')).toHaveText('—')
  await running.getByRole('button', { name: 'Toggle detail' }).click()
  await expect(page.locator(`.agent-expand-row[data-expand-for="${id}"]`)).toContainText('Stopped by user')
})

test('shows live activity, preserves its expansion, and loads the final response', async ({ page }) => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const id = 'a'.repeat(32)
  let row = {
    id, pr_id: '320', repo: 'Vaquum/Origo', actor: 'bit-mis', model: 'opus-5-max',
    behavior: 'pr_approve', session_id: null, prompt: '', started_at: ago(30 * 60_000),
    started_at_precise: ago(30 * 60_000), completed_at: null as string | null,
    time_elapsed: '30m', status: 'running', outcome: null as string | null, response: '', error: '',
    progress: {
      version: 1, phase: 'reasoning', phase_started_at: ago(20 * 60_000), heartbeat_at: ago(1_000),
      last_provider_event_at: ago(7 * 60_000), deadline_at: new Date(Date.now() + 22 * 60_000).toISOString(),
      warning: null, events: [{ at: ago(7 * 60_000), message: 'Provider reported reasoning activity' }],
    },
  }
  let requests = 0
  await page.route('**/api/agent-logs', async (route) => {
    requests += 1
    await route.fulfill({ json: { logs: [row] } })
  })
  await page.route(`**/api/agent-response/${id}`, (route) => route.fulfill({ json: { id, body: 'Approval confirmed on GitHub.' } }))
  await page.clock.install()
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const main = page.locator(`.agent-row[data-id="${id}"]`)
  await expect(main).toContainText('No provider update for 7m')
  await main.getByRole('button', { name: 'Toggle detail' }).click()
  const detail = page.locator(`.agent-expand-row[data-expand-for="${id}"]`)
  await expect(detail).toContainText('Worker heartbeat')
  await expect(detail).toContainText('Stage deadline in 22m')
  await expect(detail).toContainText('Provider reported reasoning activity')
  await page.screenshot({ path: test.info().outputPath('live-progress.png'), fullPage: true })

  row.progress = { ...row.progress, phase: 'submitting', phase_started_at: ago(0), last_provider_event_at: ago(0),
    events: [...row.progress.events, { at: ago(0), message: 'GitHub command in progress' }] }
  await page.clock.fastForward(15_001)
  await expect(main).toContainText('GitHub command in progress')
  await expect(detail).toContainText('GitHub command in progress')
  await expect(main.getByRole('button', { name: 'Toggle detail' })).toHaveAttribute('aria-expanded', 'true')

  row = { ...row, status: 'completed', outcome: 'approved', completed_at: ago(0), response: id.slice(0, 8),
    progress: { ...row.progress, phase: 'completed', events: [...row.progress.events, { at: ago(0), message: 'Run completed' }] } }
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(main).toContainText('approved')
  await expect(detail).toContainText('Approval confirmed on GitHub.')
  await expect(detail).toContainText('Run completed')
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  const leftAt = requests
  await page.clock.fastForward(30_000)
  expect(requests).toBe(leftAt)
})

test('shows missing worker heartbeat, refreshes failures, and stops polling when hidden', async ({ page }) => {
  const now = new Date().toISOString()
  const logs = [
    { id: 'a'.repeat(32), model: 'opus-5-max', behavior: 'pr_review', repo: 'o/r', pr_id: '1',
      status: 'running', started_at: now, started_at_precise: now, response: '', error: '',
      progress: { version: 1, phase: 'waiting_provider', phase_started_at: now,
        heartbeat_at: new Date(Date.now() - 120_000).toISOString(), last_provider_event_at: null,
        deadline_at: null, warning: null, events: [{ at: now, message: 'Waiting for provider' }] } },
    { id: 'b'.repeat(32), model: 'astra', behavior: 'pr_review', repo: 'o/r', pr_id: '2',
      status: 'running', started_at: now, started_at_precise: now, response: '', error: '' },
  ]
  let requests = 0
  await page.route('**/api/agent-logs', (route) => {
    requests += 1
    return route.fulfill({ json: { logs } })
  })
  await page.clock.install()
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const main = page.locator('.agent-row').first()
  await expect(main).toContainText('Worker heartbeat missing for 2m')
  await expect(page.locator('.agent-row').nth(1)).toContainText('Progress unavailable for this run')
  await main.getByRole('button', { name: 'Toggle detail' }).click()
  logs[0].status = 'failed'
  const failure = "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."
  logs[0].error = failure
  await page.clock.fastForward(15_001)
  await expect(page.locator('.agent-expand-row')).toContainText(failure)
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  const leftAt = requests
  await page.clock.fastForward(30_000)
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  expect(requests).toBe(leftAt)
})


test('updates activity without detaching rows or collapsing provider reasoning', async ({ page }) => {
  const id = 'c'.repeat(32)
  const now = new Date().toISOString()
  const row = { id, model: 'opus-5-high', behavior: 'pr_approve', repo: 'Vaquum/Origo', pr_id: '320',
    status: 'running', started_at: now, started_at_precise: now, response: '', error: '',
    progress: { version: 1, phase: 'reasoning', phase_started_at: now, heartbeat_at: now,
      last_provider_event_at: now, deadline_at: null, warning: null, reasoning_available: true, reasoning_chars: 10,
      events: [{ at: now, message: 'Past minute: new reasoning activity (12 events)' }] } }
  let text = '<script>provider text</script>\n' + 'Evidence from the changed contract.\n'.repeat(100)
  let reads = 0
  await page.route('**/api/agent-logs', (route) => route.fulfill({ json: { logs: [row] } }))
  await page.route(`**/api/agent-reasoning/${id}`, (route) => {
    reads += 1
    return route.fulfill({ json: { id, body: text } })
  })
  await page.clock.install()
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const main = page.locator(`.agent-row[data-id="${id}"]`)
  await main.getByRole('button', { name: 'Toggle detail' }).click()
  await expect(page.locator('.agent-progress-detail')).toContainText('new reasoning activity (12 events)')
  await page.locator('.agent-reasoning summary').click()
  const reasoning = page.locator('.agent-reasoning-body')
  await expect(reasoning).toContainText('<script>provider text</script>')
  await expect(reasoning.locator('script')).toHaveCount(0)
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.agent-row, .agent-row td, .agent-row button, .agent-expand-row, .agent-reasoning, .agent-reasoning-body')]
    const pre = document.querySelector<HTMLElement>('.agent-reasoning-body')!
    pre.scrollTop = 70
    const removed: Node[] = []
    new MutationObserver((records) => records.forEach((record) => removed.push(...record.removedNodes)))
      .observe(document.querySelector('#swarm-body') || document.querySelector('.agent-row')!.parentNode!, { childList: true, subtree: true })
    Object.assign(window, { stableNodes: nodes, removedNodes: removed })
  })
  row.progress.events.push({ at: now, message: 'Past minute: no new reasoning activity' })
  await page.clock.fastForward(15_001)
  await expect(page.locator('.agent-progress-detail')).toContainText('no new reasoning activity')
  await expect(page.locator('.agent-reasoning')).toHaveAttribute('open', '')
  expect(reads).toBe(1)
  expect(await page.evaluate(() => {
    const state = window as unknown as { stableNodes: Node[], removedNodes: Node[] }
    return state.stableNodes.every((node) => node.isConnected && !state.removedNodes.includes(node))
  })).toBe(true)
  expect(await reasoning.evaluate((el) => el.scrollTop)).toBe(70)
  row.progress.reasoning_chars = 20
  text += 'New provider evidence.'
  await page.clock.fastForward(15_001)
  await expect(reasoning).toContainText('New provider evidence.')
  expect(reads).toBe(2)
  await expect(page.locator('.agent-reasoning')).toHaveAttribute('open', '')
  expect(await reasoning.evaluate((el) => el.scrollTop)).toBe(70)
})
