import { expect, test, type Page } from '@playwright/test'

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
        json: { org: 'acme', me: 'octocat', timezone: 'UTC' },
      })
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

test('saves the review model and restores it after reload', async ({ page }) => {
  let settings = { org: 'acme', me: 'octocat', timezone: 'UTC', reviewModel: 'opus' }
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() }
    await route.fulfill({ json: settings })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  const model = page.getByLabel('Review model')
  await expect(model).toHaveValue('opus')
  await model.selectOption('astra')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(settings.reviewModel).toBe('astra')
  await page.reload()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.getByLabel('Review model')).toHaveValue('astra')
  await page.getByLabel('Review model').selectOption('opus')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(settings.reviewModel).toBe('opus')
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
