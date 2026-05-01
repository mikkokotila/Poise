// Settings panel — org, username, timezone, refresh rate.
// Slides in from the right, same pattern as the typography panel.
//
// GitHub auth no longer lives here — Poise reads through the local
// /github service which uses gh-cli auth on its own side.

import { getSettings as getCachedSettings, setLocalSettings, loadSettings, getRefreshRate, setRefreshRate } from './config'

let panelEl: HTMLElement | null = null
let orgInput: HTMLInputElement | null = null
let meInput: HTMLInputElement | null = null
let tzSelect: HTMLSelectElement | null = null
let saveBtn: HTMLButtonElement | null = null
let helpEl: HTMLElement | null = null

async function refreshStatus(): Promise<void> {
  await loadSettings()
  syncFieldsFromCache()
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

function setHelp(text: string, cls: 'info' | 'error' | 'ok' = 'info') {
  if (!helpEl) return
  helpEl.textContent = text
  helpEl.className = `st-help st-help-${cls}`
}

async function saveAll() {
  if (!saveBtn || !orgInput || !meInput || !tzSelect) return

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
    setHelp('Saved.', 'ok')
    window.dispatchEvent(new CustomEvent('poise:synced'))
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
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

      <div class="tp-section">
        <label class="tp-label">Organization</label>
        <input type="text" class="st-input st-input-org" autocomplete="off" spellcheck="false" placeholder="acme-corp" />
      </div>

      <div class="tp-section">
        <label class="tp-label">Username (you)</label>
        <input type="text" class="st-input st-input-me" autocomplete="off" spellcheck="false" placeholder="octocat" />
        <div class="st-help st-help-info">Used to highlight your own comments. Your GitHub auth is handled by the local <code>/github</code> service.</div>
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
        <div class="st-help st-help-info">How often Current, Swarm, and Archive pull fresh data.</div>
      </div>

      <div class="st-row">
        <button class="st-save">Save</button>
      </div>

      <div class="tp-hint">
        Settings are stored locally in <code>~/.poise/cache.db</code>.
      </div>
    </div>
  `

  orgInput = panel.querySelector('.st-input-org') as HTMLInputElement
  meInput = panel.querySelector('.st-input-me') as HTMLInputElement
  tzSelect = panel.querySelector('.st-input-tz') as HTMLSelectElement
  saveBtn = panel.querySelector('.st-save') as HTMLButtonElement
  helpEl = panel.querySelector('.st-help')

  // Default the timezone select to the browser zone before the cache loads.
  tzSelect.value = browserTz

  saveBtn.addEventListener('click', saveAll)
  for (const inp of [orgInput, meInput]) {
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
    if (!orgInput || !meInput) return
    if (!orgInput.value) orgInput.focus()
    else if (!meInput.value) meInput.focus()
    else orgInput.focus()
  }, 200)
}

export function toggleSettingsPanel() {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) panelEl.classList.remove('open')
  else openSettingsPanel()
}

export async function isFullyConfigured(): Promise<boolean> {
  await refreshStatus()
  const s = getCachedSettings()
  return !!s.org && !!s.me
}
