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
