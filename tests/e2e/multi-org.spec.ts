import { expect, test, type Page } from '@playwright/test'
import type { Organization } from '../../src/config'
import type { BehaviorDiagnostics } from '../../src/behaviors'

function organization(login: string, status: Organization['status'] = 'ready'): Organization {
  return { login, managed: true, status, stage: status === 'initializing' ? 'syncing' : status, error: null, activatedAt: status === 'ready' ? '2026-10-01T08:00:00Z' : null }
}

function record(org: string) {
  return { repo: `${org}/same-repo`, number: 1, title: `${org} issue`, kind: 'issue', state: 'open', url: `https://github.com/${org}/same-repo/issues/1`, author: 'octocat', owner_login: null, owner_avatar: null, updated_at: '2026-10-01T08:00:00Z', created_at: '2026-10-01T08:00:00Z', merged_at: null }
}

async function setup(page: Page, initial = [organization('acme')], me = 'octocat') {
  const state = {
    organizations: initial,
    me,
    additions: [] as string[],
    retries: [] as string[],
    polls: 0,
    reads: [] as Array<{ path: string, org: string }>,
    behaviorWrites: [] as Array<{ org: string, body: Record<string, unknown> }>,
    behaviors: { 'review-new-prs': { enabled: true } } as Record<string, Record<string, unknown>>,
    diagnostics: null as BehaviorDiagnostics | null,
    partial: false,
  }
  await page.clock.setFixedTime(new Date('2026-10-01T08:00:10Z'))
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {}
    const org = url.searchParams.get('org') || String(body.org || '')
    state.reads.push({ path: url.pathname, org })
    if (url.pathname === '/api/settings') {
      if (request.method() === 'POST') state.me = String(body.me)
      return route.fulfill({ json: { org: 'acme', me: state.me, timezone: 'UTC', organizations: state.organizations, models: {} } })
    }
    if (url.pathname === '/api/organizations') {
      if (request.method() === 'POST') {
        state.additions.push(org)
        state.organizations = [...state.organizations, organization(org, 'initializing')]
      } else state.polls++
      return route.fulfill({ status: request.method() === 'POST' ? 202 : 200, json: { organizations: state.organizations } })
    }
    if (url.pathname.endsWith('/retry')) {
      const login = url.pathname.split('/')[3]
      state.retries.push(login)
      state.organizations = state.organizations.map((entry) => entry.login === login ? organization(login, 'initializing') : entry)
      return route.fulfill({ status: 202, json: { organizations: state.organizations } })
    }
    if (url.pathname === '/api/gh') {
      const records = state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => record(entry.login))
      const errors = state.partial ? [{ org: 'beta', error: 'Sync unavailable' }] : []
      return route.fulfill({ json: body.count_only ? { count: records.length, errors } : { records: body.operation === 'green_pr' ? [] : records, errors } })
    }
    if (url.pathname === '/api/repos') {
      return route.fulfill({ json: { repos: state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => `${entry.login}/same-repo`) } })
    }
    if (url.pathname === '/api/current') {
      return route.fulfill({ json: { cards: [{ id: 'personal', lane: 'idea', text: 'Personal idea', title: 'Personal idea', body: 'Personal idea', repo: null, position: 0, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z' }] } })
    }
    if (url.pathname === '/api/agent-logs') {
      return route.fulfill({ json: { logs: state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => ({
        id: entry.login, repo: `${entry.login}/same-repo`, pr_id: '1', model: 'opus-5', behavior: 'review', status: 'completed', completed_at: '2026-10-01T08:01:00Z', started_at: '2026-10-01T08:00:00Z', time_elapsed: '1m', response: '', error: '',
      })) } })
    }
    if (url.pathname.startsWith('/api/behaviors/')) {
      state.behaviorWrites.push({ org, body })
      const key = url.pathname.split('/').pop()!
      state.behaviors[key] = { ...state.behaviors[key], ...body }
      return route.fulfill({ json: state.behaviors[key] })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { enabled: false, setting: 'p2', reviewers: 1, scratchpad: '', repos: [], authors: [], owner: 'octocat', lastTriggered: null }
      return route.fulfill({ json: {
        ...Object.fromEntries(['review-new-prs', 'approve-prs', 'resolve-unblocking', 'review-new-issues'].map((key) => [key, { ...behavior, ...state.behaviors[key] }])),
        diagnostics: state.diagnostics,
      } })
    }
    if (url.pathname === '/api/models') return route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    return route.fulfill({ json: {} })
  })
  return state
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
}

test('adds an organization, saves the username, shows activation and refreshes the combined dashboard', async ({ page }) => {
  const state = await setup(page, [organization('acme')], '')
  await page.goto('/')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await page.getByLabel('Username (you)').fill('octocat')
  await page.getByLabel('New GitHub account').fill('beta')
  await page.locator('.st-add-organization').click()
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Syncing repositories…')
  expect(state.me).toBe('octocat')
  expect(state.additions).toEqual(['beta'])
  await expect(page.locator('.st-organization[data-org="acme"]')).toContainText('Ready')
  state.organizations = [organization('acme'), organization('beta')]
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Ready')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo', 'beta/same-repo'])
  await page.keyboard.press('Escape')
  await expect(page.locator('#main-filters').getByLabel('Account filter')).toBeVisible()
})

test('retries failed activation and resumes status checks after reopening Settings', async ({ page }) => {
  const failed = { ...organization('beta', 'error'), error: 'GitHub access denied' }
  const state = await setup(page, [organization('acme'), failed])
  await page.goto('/')
  await openSettings(page)
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('GitHub access denied')
  await page.locator('[data-retry-org="beta"]').click()
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Activating…')
  expect(state.retries).toEqual(['beta'])
  await page.keyboard.press('Escape')
  // Waiting across two polling intervals verifies the closed panel releases its timer.
  await page.waitForTimeout(100)
  const pollsAtClose = state.polls
  await page.waitForTimeout(3200)
  expect(state.polls).toBe(pollsAtClose)
  state.organizations = [organization('acme'), organization('beta')]
  await openSettings(page)
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Ready')
})

test('shares organization scope across Archive, Current and Swarm with full repository identities', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  await page.goto('/')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo', 'beta/same-repo'])
  await page.locator('#main-filters').getByLabel('Account filter').selectOption('beta')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#current-filters').getByLabel('Account filter')).toHaveValue('beta')
  await expect(page.locator('#view-current .card-live .card-repo')).toHaveText(['beta/same-repo'])
  await expect(page.locator('#view-current')).toContainText('Personal idea')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-filters').getByLabel('Account filter')).toHaveValue('beta')
  await expect(page.locator('#swarm-tbody .agent-row')).toHaveCount(1)
  await expect(page.locator('#swarm-tbody .agent-org')).toHaveText(['beta'])
  await expect(page.locator('#swarm-tbody .agent-pr')).toHaveAttribute('title', 'beta/same-repo#1')
  await page.locator('#swarm-filters').getByLabel('Account filter').selectOption('')
  await expect(page.locator('#swarm-tbody .agent-row')).toHaveCount(2)
  expect(state.reads).toEqual(expect.arrayContaining([{ path: '/api/current', org: 'beta' }, { path: '/api/agent-logs', org: 'beta' }]))
})

test('uses one global behavior configuration regardless of the dashboard account filter', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  state.partial = true
  await page.goto('/')
  await expect(page.locator('#main-load-error')).toContainText('beta: Sync unavailable')
  await expect(page.locator('#tbody tr')).toHaveCount(2)
  await page.locator('#main-filters').getByLabel('Account filter').selectOption('beta')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.getByLabel('Behavior account')).toHaveCount(0)
  await expect(page.locator('#behaviors-filters')).toContainText('Behavior settings apply to all ready GitHub accounts.')
  const toggle = page.locator('input[data-behavior="review-new-prs"]')
  await expect(toggle).toBeChecked()
  await page.locator('tr[data-behavior="review-new-prs"] label.toggle').click()
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: '', body: { enabled: false } }])
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.locator('#main-filters').getByLabel('Account filter').selectOption('acme')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(toggle).not.toBeChecked()
  expect(state.reads.filter((read) => read.path === '/api/behaviors').every((read) => read.org === '')).toBe(true)
})

test('updates organization filters after activation finishes while Settings is closed', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta', 'initializing')])
  await page.goto('/')
  await expect(page.locator('#main-filters').getByLabel('Account filter')).toBeHidden()
  state.organizations = [organization('acme'), organization('beta')]
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator('#main-filters').getByLabel('Account filter')).toBeVisible()
  await expect(page.locator('#main-filters').getByLabel('Account filter').locator('option')).toHaveText(['All accounts', 'acme', 'beta'])
})

test('shows synchronization failures on previously activated organizations with a retry', async ({ page }) => {
  const state = await setup(page, [organization('acme'), { ...organization('beta'), stage: 'sync-error', error: 'GitHub rate limit exceeded' }])
  await page.goto('/')
  await openSettings(page)
  const row = page.locator('.st-organization[data-org="beta"]')
  await expect(row).toContainText('Sync failed')
  await expect(row).toContainText('GitHub rate limit exceeded')
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(row).toContainText('Syncing repositories…')
  expect(state.retries).toEqual(['beta'])
})


for (const status of ['initializing', 'ready'] as const) {
  test(`waits for GitHub quota reset during ${status} and resumes automatically`, async ({ page }) => {
    const limited = {
      ...organization('beta', status), stage: 'rate-limited',
      error: 'GitHub API rate limit reached.', retryAt: '2026-10-01T08:30:00Z',
    }
    const state = await setup(page, [organization('acme'), limited])
    await page.goto('/')
    await openSettings(page)
    const row = page.locator('.st-organization[data-org="beta"]')
    await expect(row).toContainText('Waiting for GitHub')
    await expect(row).toContainText(`${status === 'ready' ? 'Sync' : 'Activation'} resumes automatically at`)
    await expect(row).toContainText('08:30:00')
    await expect(row.getByRole('button', { name: 'Retry' })).toBeDisabled()
    await expect(row.locator('.st-help-error')).toHaveCount(0)
    state.organizations = [organization('acme'), organization('beta')]
    await expect(row).toContainText('Ready')
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(state.retries).toEqual([])
  })
}


test('continues Archive pagination when an organization is missing only from the count', async ({ page }) => {
  await setup(page, [organization('acme'), organization('beta')])
  const records = Array.from({ length: 25 }, (_, i) => ({ ...record('acme'), number: i + 1, title: `Issue ${i + 1}`, url: `https://github.com/acme/same-repo/issues/${i + 1}` }))
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON() as { count_only?: boolean, offset?: number, limit?: number }
    await route.fulfill({ json: body.count_only
      ? { count: 1, errors: [{ org: 'beta', error: 'Count unavailable' }] }
      : { records: records.slice(body.offset || 0, (body.offset || 0) + (body.limit || 20)) } })
  })
  await page.goto('/')
  await expect(page.locator('#tbody tr')).toHaveCount(20)
  await expect(page.locator('#main-load-error')).toContainText('beta: Count unavailable')
  await page.locator('#main-sentinel').scrollIntoViewIfNeeded()
  await expect(page.locator('#tbody tr')).toHaveCount(25)
  await expect(page.locator('#count')).toHaveText('25 available')
})


test('keeps shared behavior memory editable when one account loses readiness', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await page.getByLabel('Edit memory for review-new-prs').click()
  await page.locator('.behavior-memory-textarea').fill('Shared review instructions')
  state.organizations = [organization('acme'), organization('beta', 'initializing')]
  // Keyboard navigation preserves the open memory draft while Settings reloads.
  await page.getByRole('button', { name: 'Menu', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-action="settings"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Activating…')
  await page.keyboard.press('Escape')
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: '', body: { scratchpad: 'Shared review instructions', scratchpadPrevious: '' } }])
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
  await page.getByLabel('Edit memory for review-new-prs').click()
  await expect(page.locator('.behavior-memory-textarea')).toHaveValue('Shared review instructions')
  await expect(page.getByLabel('Behavior account')).toHaveCount(0)
})

test('discards a background Archive response whose JSON arrives after switching organization', async ({ page }) => {
  await setup(page, [organization('acme'), organization('beta')])
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window)
    const state = window as typeof window & { holdArchive?: boolean, archiveWaiting?: boolean, releaseArchive?: () => void }
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : {}
      if (String(args[0]) === '/api/gh' && state.holdArchive && !body.count_only) {
        state.holdArchive = false
        const json = response.json.bind(response)
        response.json = async () => {
          const data = await json()
          state.archiveWaiting = true
          await new Promise<void>((resolve) => { state.releaseArchive = resolve })
          return data
        }
      }
      return response
    }
  })
  await page.goto('/')
  const filter = page.locator('#main-filters').getByLabel('Account filter')
  await filter.selectOption('acme')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo'])
  await page.evaluate(() => {
    ;(window as typeof window & { holdArchive?: boolean }).holdArchive = true
    window.dispatchEvent(new Event('poise:refresh-tick'))
  })
  await expect.poll(() => page.evaluate(() => !!(window as typeof window & { archiveWaiting?: boolean }).archiveWaiting)).toBe(true)
  await filter.selectOption('beta')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
  await page.evaluate(() => { (window as typeof window & { releaseArchive?: () => void }).releaseArchive?.() })
  await page.waitForTimeout(100)
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
})


test('adds a personal GitHub account alongside an organization with shared behavior settings', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  await openSettings(page)
  await expect(page.locator('#settings-panel')).toContainText('GitHub accounts')
  await expect(page.locator('#settings-panel')).toContainText('Add an organization name or personal username.')
  await page.getByLabel('New GitHub account').fill('mikkokotila')
  await page.locator('.st-add-organization').click()
  const personal = page.locator('.st-organization[data-org="mikkokotila"]')
  await expect(personal).toContainText('Syncing repositories…')
  expect(state.additions).toEqual(['mikkokotila'])
  state.organizations = [organization('acme'), organization('mikkokotila')]
  await expect(personal).toContainText('Ready')
  await page.keyboard.press('Escape')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo', 'mikkokotila/same-repo'])
  const filter = page.locator('#main-filters').getByLabel('Account filter')
  await expect(filter.locator('option')).toHaveText(['All accounts', 'acme', 'mikkokotila'])
  await filter.selectOption('mikkokotila')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['mikkokotila/same-repo'])
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#current-filters').getByLabel('Account filter')).toHaveValue('mikkokotila')
  await expect(page.locator('#view-current .card-live .card-repo')).toHaveText(['mikkokotila/same-repo'])
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-filters').getByLabel('Account filter')).toHaveValue('mikkokotila')
  await expect(page.locator('#swarm-tbody .agent-row')).toHaveCount(1)
  await expect(page.locator('#swarm-tbody .agent-org')).toHaveText(['mikkokotila'])
  await expect(page.locator('#swarm-tbody .agent-pr')).toHaveAttribute('title', 'mikkokotila/same-repo#1')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.getByLabel('Behavior account')).toHaveCount(0)
  await expect(page.locator('input[data-behavior="review-new-prs"]')).toBeChecked()
  await expect(page.locator('#behaviors-filters')).toContainText('all ready GitHub accounts')
  expect(state.behaviorWrites).toEqual([])
})


test('lists repositories from every ready account for global issue review despite an active account filter', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('mikkokotila'), organization('pending', 'initializing')])
  await page.goto('/')
  await page.locator('#main-filters').getByLabel('Account filter').selectOption('mikkokotila')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await page.locator('tr[data-behavior="review-new-issues"] .behavior-triggers-btn').click()
  const dialog = page.getByRole('dialog', { name: /Review New Issues/ })
  await expect(dialog.locator('.bt-repo')).toHaveCount(2)
  await dialog.getByRole('checkbox', { name: 'acme/same-repo', exact: true }).check()
  await dialog.getByRole('checkbox', { name: 'mikkokotila/same-repo', exact: true }).check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: '', body: { repos: ['acme/same-repo', 'mikkokotila/same-repo'] } }])
  await page.locator('tr[data-behavior="review-new-issues"] .behavior-triggers-btn').click()
  await expect(dialog.getByRole('checkbox', { name: 'acme/same-repo', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'mikkokotila/same-repo', exact: true })).toBeChecked()
  expect(state.reads.filter((read) => read.path === '/api/repos').every((read) => read.org === '')).toBe(true)
})

test('reports failures across accounts in global behavior diagnostics', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('mikkokotila')])
  state.diagnostics = {
    status: 'degraded', agentLogsError: null,
    datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
    identity: { status: 'valid', actor: 'octocat', error: null },
    failures: [
      { org: 'acme', behavior: 'review-new-prs', target: 'acme/same-repo#7', kind: 'review', consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'First account error' },
      { org: 'mikkokotila', behavior: 'review-new-issues', kind: 'review', consecutiveFailures: 2, lastFailureAt: '', nextRetryAt: '', error: 'Personal account error' },
    ], deadLetters: [],
  }
  await page.goto('/')
  await page.locator('#main-filters').getByLabel('Account filter').selectOption('mikkokotila')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.locator('#behavior-diagnostics')).toContainText('acme: review-new-prs acme/same-repo#7: 1 consecutive review failure(s) — First account error')
  await expect(page.locator('#behavior-diagnostics')).toContainText('mikkokotila: review-new-issues: 2 consecutive review failure(s) — Personal account error')
  expect(state.reads.filter((read) => read.path === '/api/behaviors').every((read) => read.org === '')).toBe(true)
})

test('preserves selected repositories when one account cannot be listed', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('mikkokotila')])
  state.behaviors['review-new-issues'] = { repos: ['mikkokotila/same-repo'] }
  await page.route(/\/api\/repos(?:\?.*)?$/, (route) => route.fulfill({ json: {
    repos: ['acme/same-repo'], errors: [{ org: 'mikkokotila', error: 'Sync unavailable' }],
  } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await page.locator('tr[data-behavior="review-new-issues"] .behavior-triggers-btn').click()
  const dialog = page.getByRole('dialog', { name: /Review New Issues/ })
  await expect(dialog).toContainText('mikkokotila: Sync unavailable')
  await expect(dialog.getByRole('checkbox', { name: 'mikkokotila/same-repo', exact: true })).toBeChecked()
  await dialog.getByRole('checkbox', { name: 'acme/same-repo', exact: true }).check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: '', body: { repos: ['acme/same-repo', 'mikkokotila/same-repo'] } }])
})
