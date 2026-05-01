// Settings panel — GitHub PAT, org, username, timezone.
// Slides in from the right, same pattern as the typography panel.

import { getSettings as getCachedSettings, setLocalSettings, loadSettings, getRefreshRate, setRefreshRate } from './config'

let panelEl: HTMLElement | null = null
let statusDot: HTMLElement | null = null
let statusText: HTMLElement | null = null
let tokenInput: HTMLInputElement | null = null
let orgInput: HTMLInputElement | null = null
let meInput: HTMLInputElement | null = null
let tzSelect: HTMLSelectElement | null = null
let saveBtn: HTMLButtonElement | null = null
let clearBtn: HTMLButtonElement | null = null
let helpEl: HTMLElement | null = null
let configured = false

async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status')
    const data = await res.json()
    configured = !!data.configured
  } catch {
    configured = false
  }
  await loadSettings()
  syncFieldsFromCache()
  updateStatusUI()
}

function syncFieldsFromCache() {
  const s = getCachedSettings()
  if (orgInput) orgInput.value = s.org
  if (meInput) meInput.value = s.me
  if (tzSelect) {
    const fallback = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
    tzSelect.value = s.timezone || fallback
  }
}

function updateStatusUI() {
  if (!statusDot || !statusText || !tokenInput) return
  if (configured) {
    statusDot.className = 'st-dot ok'
    statusText.textContent = 'Connected'
    tokenInput.placeholder = '•••••••• (stored)'
    clearBtn!.hidden = false
  } else {
    statusDot.className = 'st-dot missing'
    statusText.textContent = 'No token'
    tokenInput.placeholder = 'ghp_…'
    clearBtn!.hidden = true
  }
}

function setHelp(text: string, cls: 'info' | 'error' | 'ok' = 'info') {
  if (!helpEl) return
  helpEl.textContent = text
  helpEl.className = `st-help st-help-${cls}`
}

async function saveAll() {
  if (!saveBtn || !tokenInput || !orgInput || !meInput || !tzSelect) return

  const tokenRaw = tokenInput.value.trim()
  const org = orgInput.value.trim()
  const me = meInput.value.trim()
  const tz = tzSelect.value

  if (!org || !me) {
    setHelp('Org and username are required.', 'error')
    return
  }

  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    // Token is optional on subsequent saves. Only post a token if the user typed one,
    // or if no token is configured yet.
    if (tokenRaw) {
      const tokenRes = await fetch('/api/auth/set-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenRaw }),
      })
      const tokenData = await tokenRes.json()
      if (!tokenRes.ok) {
        setHelp(tokenData.error || 'Failed to save token', 'error')
        return
      }
      configured = true
    } else if (!configured) {
      setHelp('Paste a PAT starting with ghp_', 'error')
      return
    }

    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, me, timezone: tz }),
    })
    const data = await res.json()
    if (!res.ok) {
      setHelp(data.error || 'Failed to save settings', 'error')
      return
    }
    setLocalSettings(data)

    setHelp('Saved. Running sync…', 'ok')
    tokenInput.value = ''
    updateStatusUI()
    triggerSync()
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

async function clearToken() {
  if (!clearBtn) return
  clearBtn.disabled = true
  try {
    await fetch('/api/auth/set-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    })
    configured = false
    updateStatusUI()
    setHelp('Token cleared.', 'info')
  } finally {
    clearBtn.disabled = false
  }
}

async function triggerSync() {
  try {
    const res = await fetch('/api/cache/sync', { method: 'POST' })
    if (!res.ok) return
    window.dispatchEvent(new CustomEvent('poise:synced'))
  } catch { /* ignore */ }
}

function timezoneOptions(): string[] {
  try {
    const fn = (Intl as any).supportedValuesOf
    if (typeof fn === 'function') return fn('timeZone') as string[]
  } catch { /* ignore */ }
  return ['UTC', 'Europe/Helsinki', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore']
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'settings-panel'

  const tzList = timezoneOptions()
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
  const tzOptionsHtml = tzList.map((z) => `<option value="${z}">${z}</option>`).join('')

  panel.innerHTML = `
    <div class="tp-header"><span class="tp-title">Settings</span></div>
    <div class="tp-body">
      <div class="tp-group-label">GitHub</div>

      <div class="st-status">
        <span class="st-dot missing"></span>
        <span class="st-status-text">No token</span>
      </div>

      <div class="tp-section">
        <label class="tp-label">Personal access token</label>
        <input type="password" class="st-input st-input-token" autocomplete="off" spellcheck="false" placeholder="ghp_…" />
        <div class="st-help st-help-info">Classic PAT with <code>repo</code> + <code>read:org</code> scopes.</div>
      </div>

      <div class="tp-section">
        <label class="tp-label">Organization</label>
        <input type="text" class="st-input st-input-org" autocomplete="off" spellcheck="false" placeholder="acme-corp" />
      </div>

      <div class="tp-section">
        <label class="tp-label">Username (you)</label>
        <input type="text" class="st-input st-input-me" autocomplete="off" spellcheck="false" placeholder="octocat" />
      </div>

      <div class="tp-group-label">Time</div>

      <div class="tp-section">
        <label class="tp-label">Timezone</label>
        <select class="st-select st-input-tz">${tzOptionsHtml}</select>
        <div class="st-help st-help-info">Used to cut "today / yesterday / this week" in Main.</div>
      </div>

      <div class="tp-section">
        <label class="tp-label">Refresh rate</label>
        <div class="range-picker st-refresh-picker">
          <button type="button" data-rate="1m" class="${getRefreshRate() === '1m' ? 'active' : ''}">1m</button>
          <button type="button" data-rate="5m" class="${getRefreshRate() === '5m' ? 'active' : ''}">5m</button>
        </div>
        <div class="st-help st-help-info">How often Main, Stream, and Swarm pull fresh data.</div>
      </div>

      <div class="st-row">
        <button class="st-save">Save</button>
        <button class="st-clear" hidden>Clear token</button>
      </div>

      <div class="tp-hint">
        Create a token at
        <a href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Poise"
           target="_blank" rel="noopener">github.com/settings/tokens</a>.
        Settings are stored locally in <code>~/.poise/cache.db</code>.
      </div>
    </div>
  `

  statusDot = panel.querySelector('.st-dot')
  statusText = panel.querySelector('.st-status-text')
  tokenInput = panel.querySelector('.st-input-token') as HTMLInputElement
  orgInput = panel.querySelector('.st-input-org') as HTMLInputElement
  meInput = panel.querySelector('.st-input-me') as HTMLInputElement
  tzSelect = panel.querySelector('.st-input-tz') as HTMLSelectElement
  saveBtn = panel.querySelector('.st-save') as HTMLButtonElement
  clearBtn = panel.querySelector('.st-clear') as HTMLButtonElement
  helpEl = panel.querySelector('.st-help')

  // Default the timezone select to the browser zone before the cache loads.
  tzSelect.value = browserTz

  saveBtn.addEventListener('click', saveAll)
  clearBtn.addEventListener('click', clearToken)
  for (const inp of [tokenInput, orgInput, meInput]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAll() })
  }

  // Refresh-rate toggle — applies live (no Save needed); each view's
  // running timer restarts via the `poise:refresh-rate-changed` event.
  const refreshPicker = panel.querySelector<HTMLElement>('.st-refresh-picker')!
  refreshPicker.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.rate) return
    const rate = btn.dataset.rate as '1m' | '5m'
    refreshPicker.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    setRefreshRate(rate)
  })

  return panel
}

export function initSettings() {
  panelEl = buildPanel()
  document.body.appendChild(panelEl)
  refreshStatus()
}

export function openSettingsPanel() {
  if (!panelEl) return
  panelEl.classList.add('open')
  refreshStatus()
  setTimeout(() => {
    // Focus the first empty required field
    if (!tokenInput || !orgInput || !meInput) return
    if (!configured) tokenInput.focus()
    else if (!orgInput.value) orgInput.focus()
    else if (!meInput.value) meInput.focus()
    else tokenInput.focus()
  }, 200)
}

export function toggleSettingsPanel() {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) panelEl.classList.remove('open')
  else openSettingsPanel()
}

export async function isTokenConfigured(): Promise<boolean> {
  await refreshStatus()
  return configured
}

export async function isFullyConfigured(): Promise<boolean> {
  await refreshStatus()
  const s = getCachedSettings()
  return configured && !!s.org && !!s.me
}
