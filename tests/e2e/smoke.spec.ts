import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'main')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
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
})

test('boots the configured dashboard with deterministic API data', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('Poise')
  await expect(page.locator('#view-main')).toBeVisible()
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
  await expect(page.locator('#loader')).toBeHidden()
  await expect(page.locator('#tbody tr')).toHaveCount(0)
})

test('keeps the empty dashboard layout visually stable', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#loader')).toBeHidden()
  await expect(page.locator('#view-main')).not.toHaveClass(/view-entering/)

  await expect(page).toHaveScreenshot('configured-empty-dashboard.png', {
    fullPage: true,
  })
})
