// Settings panel — two tabs: General (org, username, timezone, refresh rate,
// theme) and Models (which model each place in Poise launches, with a
// fallback). Slides in from the right, same pattern as the typography panel.
//
// GitHub auth no longer lives here — Poise reads through the local
// `github-datastore` CLI which handles auth on its own side. The
// username here scopes the views to the user-footprint (things you're
// involved in) rather than the whole org.
//
// Model names are identities from Caller's catalog (`opus-5-max`), shown
// verbatim: the same string the Swarm log records and the CLI takes. The
// panel never invents a label for one.

import { getSettings as getCachedSettings, setLocalSettings, loadSettings, settingsLoadOk, getRefreshRate, setRefreshRate, getTheme, setTheme } from './config'

interface CatalogModel { identity: string, provider: string, selector: string, effort: string }
interface ModelPlace {
  key: string
  label: string
  why: string
  review: boolean
  default: string
  fallback: string
  notes: string[]
  stored: { default: string, fallback: string } | null
}
interface FixedPlace { key: string, label: string, model: string, why: string }
interface ModelsResponse {
  catalog: { models: CatalogModel[], review_providers: string[], path: string }
  places: ModelPlace[]
  fixed: FixedPlace[]
  refresh: { checked_at?: string, changed?: boolean, added?: string[], removed?: string[], families?: Record<string, { status: string, error?: string }> } | null
}

let panelEl: HTMLElement | null = null
let orgInput: HTMLInputElement | null = null
let meInput: HTMLInputElement | null = null
let tzSelect: HTMLSelectElement | null = null
let saveBtn: HTMLButtonElement | null = null
let helpEl: HTMLElement | null = null
let modelsEl: HTMLElement | null = null
let fixedEl: HTMLElement | null = null
let catalogStatusEl: HTMLElement | null = null
let refreshBtn: HTMLButtonElement | null = null
// A model select someone has changed keeps its value across background
// reloads until Save, exactly like the text fields keep typed text.
const dirtyModels = new Set<string>()

async function refreshStatus(): Promise<void> {
  await loadSettings()
  syncFieldsFromCache()
}

function syncFieldsFromCache() {
  const s = getCachedSettings()
  // openSettingsPanel kicks off a refresh it does not await, so on first run
  // its response lands a moment after the panel opens — straight over the
  // first characters someone has already typed into an empty field. Only fill
  // a field the person is not currently in.
  const active = document.activeElement
  if (orgInput && orgInput !== active) orgInput.value = s.org
  if (meInput && meInput !== active) meInput.value = s.me
  if (tzSelect && tzSelect !== active) {
    const fallback = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
    tzSelect.value = ensureTimezoneOption(s.timezone || fallback)
  }
}

// A <select> silently renders blank when told to show a value it has no option
// for — and the engine's list is not guaranteed to contain the browser's own
// zone, nor did the fallback list contain plain UTC in every branch. A blank
// timezone then saves as an empty string and the day-boundary filters quietly
// fall back to the machine zone. Add the value rather than show nothing.
function ensureTimezoneOption(zone: string): string {
  if (!tzSelect || !zone) return zone
  const has = [...tzSelect.options].some((o) => o.value === zone)
  if (!has) {
    const opt = document.createElement('option')
    opt.value = zone
    opt.textContent = zone
    tzSelect.insertBefore(opt, tzSelect.firstChild)
  }
  return zone
}

function setHelp(text: string, cls: 'info' | 'error' | 'ok' = 'info') {
  if (!helpEl) return
  helpEl.textContent = text
  // Keep st-status: assigning className wholesale dropped it, so the node lost
  // the class that identifies it after the very first message.
  helpEl.className = `st-help st-help-${cls} st-status`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// ── Models tab ──────────────────────────────────────────────────────────

function modelOptions(models: CatalogModel[], place: ModelPlace, reviewProviders: string[], selected: string): string {
  const eligible = place.review ? models.filter((m) => reviewProviders.includes(m.provider)) : models
  return eligible
    .map((m) => `<option value="${escapeHtml(m.identity)}"${m.identity === selected ? ' selected' : ''}>${escapeHtml(m.identity)}</option>`)
    .join('')
}

function renderPlaces(data: ModelsResponse) {
  if (!modelsEl || !fixedEl) return
  const kept = new Map<string, { default: string, fallback: string }>()
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    const key = section.dataset.place || ''
    if (!dirtyModels.has(key)) continue
    kept.set(key, {
      default: section.querySelector<HTMLSelectElement>('.st-model-default')?.value || '',
      fallback: section.querySelector<HTMLSelectElement>('.st-model-fallback')?.value || '',
    })
  }
  modelsEl.innerHTML = data.places.map((place) => {
    const current = kept.get(place.key) || { default: place.default, fallback: place.fallback }
    const notes = place.notes.map((n) => `<div class="st-help st-help-error">${escapeHtml(n)}</div>`).join('')
    return `
      <div class="tp-section st-place" data-place="${escapeHtml(place.key)}">
        <label class="tp-label">${escapeHtml(place.label)}</label>
        <div class="st-help st-help-info">${escapeHtml(place.why)}</div>
        <label class="st-sublabel">Default</label>
        <select class="st-select st-model-default" aria-label="${escapeHtml(place.label)} default model">${modelOptions(data.catalog.models, place, data.catalog.review_providers, current.default)}</select>
        <label class="st-sublabel">Fallback</label>
        <select class="st-select st-model-fallback" aria-label="${escapeHtml(place.label)} fallback model">${modelOptions(data.catalog.models, place, data.catalog.review_providers, current.fallback)}</select>
        ${notes}
      </div>`
  }).join('')
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    section.addEventListener('change', () => { dirtyModels.add(section.dataset.place || '') })
  }
  fixedEl.innerHTML = data.fixed.map((place) => `
      <div class="tp-section">
        <label class="tp-label">${escapeHtml(place.label)}</label>
        <div class="st-fixed-model"><code>${escapeHtml(place.model)}</code></div>
        <div class="st-help st-help-info">${escapeHtml(place.why)}</div>
      </div>`).join('')
  renderCatalogStatus(data)
}

function renderCatalogStatus(data: ModelsResponse) {
  if (!catalogStatusEl) return
  const count = data.catalog.models.length
  const report = data.refresh
  let line = `${count} models from Caller.`
  if (report?.checked_at) {
    const when = new Date(report.checked_at)
    const stamp = Number.isNaN(when.getTime()) ? report.checked_at : when.toLocaleString()
    const outcome = report.changed
      ? `updated: +${(report.added || []).join(', ') || '—'} −${(report.removed || []).join(', ') || '—'}`
      : 'nothing new'
    const down = Object.entries(report.families || {}).filter(([, f]) => f.status !== 'ok').map(([name, f]) => `${name} unavailable (${f.error || 'no answer'})`)
    line += ` Last checked ${stamp}, ${outcome}.${down.length ? ' ' + down.join('; ') + '.' : ''}`
  } else {
    line += ' Not checked yet; the daily check runs at 07:00.'
  }
  catalogStatusEl.textContent = line
}

async function loadModels(): Promise<void> {
  if (!modelsEl) return
  try {
    const res = await fetch('/api/models')
    const data = await res.json()
    if (!res.ok) {
      modelsEl.innerHTML = `<div class="st-help st-help-error">${escapeHtml(data.error || 'Model catalog unavailable')}</div>`
      return
    }
    renderPlaces(data as ModelsResponse)
  } catch (err) {
    modelsEl.innerHTML = `<div class="st-help st-help-error">Network error: ${escapeHtml((err as Error).message)}</div>`
  }
}

function collectModels(): Record<string, { default: string, fallback: string }> | null {
  if (!modelsEl) return null
  const models: Record<string, { default: string, fallback: string }> = {}
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    const key = section.dataset.place || ''
    const def = section.querySelector<HTMLSelectElement>('.st-model-default')?.value
    const fallback = section.querySelector<HTMLSelectElement>('.st-model-fallback')?.value
    if (!key || !def || !fallback) continue
    models[key] = { default: def, fallback }
  }
  return Object.keys(models).length ? models : null
}

async function refreshModels(): Promise<void> {
  if (!refreshBtn) return
  refreshBtn.disabled = true
  refreshBtn.textContent = 'Checking…'
  if (catalogStatusEl) catalogStatusEl.textContent = 'Asking each CLI what it offers today; this takes a minute or two.'
  try {
    const res = await fetch('/api/models/refresh', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      setHelp(data.error || 'Model check failed', 'error')
      return
    }
    await loadModels()
    setHelp(data.changed ? 'Catalog updated.' : 'Catalog checked; nothing new.', 'ok')
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    refreshBtn.disabled = false
    refreshBtn.textContent = 'Check now'
  }
}

// ── Save ────────────────────────────────────────────────────────────────

// Disabling the button is not a guard on its own: Enter in any field calls
// saveAll() directly and never looks at it, so a repeated Enter fired a POST
// and a full view remount each time.
let saving = false

// GitHub logins and organization names are 1–39 characters of alphanumerics
// and single hyphens, not starting or ending with one. Both fields were stored
// with nothing but .trim(), so a pasted URL or a typo saved cleanly and every
// downstream query silently returned nothing.
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

async function saveAll() {
  if (!saveBtn || !orgInput || !meInput || !tzSelect) return
  if (saving) return

  const org = orgInput.value.trim()
  const me = meInput.value.trim()
  const tz = tzSelect.value
  const models = collectModels()

  if (!org || !me) {
    setHelp('Org and username are required.', 'error')
    return
  }
  if (!GITHUB_NAME.test(org)) {
    setHelp('Organization must be a GitHub org name, not a URL.', 'error')
    orgInput.focus()
    return
  }
  if (!GITHUB_NAME.test(me)) {
    setHelp('Username must be a GitHub login, not a URL or email.', 'error')
    meInput.focus()
    return
  }
  for (const [key, choice] of Object.entries(models || {})) {
    if (choice.default === choice.fallback) {
      setHelp(`${key}: the fallback must differ from the default.`, 'error')
      return
    }
  }

  saving = true
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, me, timezone: tz, ...(models ? { models } : {}) }),
    })
    const data = await res.json()
    if (!res.ok) {
      setHelp(data.error || 'Failed to save settings', 'error')
      return
    }
    dirtyModels.clear()
    setLocalSettings(data)
    setHelp('Saved.', 'ok')
    window.dispatchEvent(new CustomEvent('poise:synced'))
    window.dispatchEvent(new CustomEvent('poise:models-changed'))
    void loadModels()
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    saving = false
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

function selectTab(panel: HTMLElement, tab: string) {
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('.st-tabs [data-tab]')) {
    const on = btn.dataset.tab === tab
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  for (const section of panel.querySelectorAll<HTMLElement>('.st-tab')) {
    section.hidden = section.dataset.tab !== tab
  }
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
      <div class="range-picker st-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" data-tab="general" class="active" aria-selected="true">General</button>
        <button type="button" role="tab" data-tab="models" aria-selected="false">Models</button>
      </div>

      <section class="st-tab" data-tab="general">
        <div class="tp-group-label">GitHub</div>

        <div class="tp-section">
          <label class="tp-label">Organization</label>
          <input type="text" class="st-input st-input-org" autocomplete="off" spellcheck="false" placeholder="acme-corp" />
        </div>

        <div class="tp-section">
          <label class="tp-label">Username (you)</label>
          <input type="text" class="st-input st-input-me" autocomplete="off" spellcheck="false" placeholder="octocat" />
          <div class="st-help st-help-info">Scopes Current and Archive to your user-footprint (PRs and issues you're involved in). GitHub auth is handled by the local <code>github-datastore</code> CLI.</div>
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

        <div class="tp-group-label">Appearance</div>

        <div class="tp-section">
          <label class="tp-label">Theme</label>
          <div class="range-picker st-theme-picker">
            <button type="button" data-theme="light" class="${getTheme() === 'light' ? 'active' : ''}">Light</button>
            <button type="button" data-theme="dark"  class="${getTheme() === 'dark'  ? 'active' : ''}">Dark</button>
          </div>
          <div class="st-help st-help-info">Applies instantly. Stored locally; no reload needed.</div>
        </div>
      </section>

      <section class="st-tab" data-tab="models" hidden>
        <div class="tp-group-label">Where Poise launches a model</div>
        <div class="st-models"><div class="st-help st-help-info">Loading the catalog…</div></div>

        <div class="tp-group-label">Set by Caller</div>
        <div class="st-models-fixed"></div>

        <div class="tp-group-label">Catalog</div>
        <div class="tp-section">
          <div class="st-help st-help-info st-catalog-status"></div>
          <div class="st-row st-row-tight">
            <button type="button" class="st-clear st-refresh-models">Check now</button>
          </div>
          <div class="st-help st-help-info">Each family's CLI is asked for its latest model and top two efforts every morning at 07:00; a model that disappears is replaced by its successor and noted above.</div>
        </div>
      </section>

      <div class="st-row">
        <button class="st-save">Save</button>
        <span class="st-help st-help-info st-status" role="status" aria-live="polite"></span>
      </div>

      <div class="tp-hint">
        Organization, username, timezone and model choices are stored in
        <code>~/.poise/cache.db</code>. Refresh rate and theme are kept by this
        browser, so they do not follow you to another one.
      </div>
    </div>
  `

  orgInput = panel.querySelector('.st-input-org') as HTMLInputElement
  meInput = panel.querySelector('.st-input-me') as HTMLInputElement
  tzSelect = panel.querySelector('.st-input-tz') as HTMLSelectElement
  saveBtn = panel.querySelector('.st-save') as HTMLButtonElement
  modelsEl = panel.querySelector('.st-models')
  fixedEl = panel.querySelector('.st-models-fixed')
  catalogStatusEl = panel.querySelector('.st-catalog-status')
  refreshBtn = panel.querySelector('.st-refresh-models') as HTMLButtonElement
  refreshBtn.addEventListener('click', () => { void refreshModels() })
  // This used to be `panel.querySelector('.st-help')`, which is the Username
  // explainer — the first element of that class in the panel. Every "Saved."
  // and every validation error overwrote it, permanently for the session, and
  // in a short window the message landed off-screen where nobody would see it.
  // Status has its own node, beside the Save button.
  helpEl = panel.querySelector('.st-status')

  // Default the timezone select to the browser zone before the cache loads.
  tzSelect.value = browserTz

  saveBtn.addEventListener('click', saveAll)
  for (const inp of [orgInput, meInput]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAll() })
  }

  panel.querySelector<HTMLElement>('.st-tabs')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.tab) return
    selectTab(panel, btn.dataset.tab)
  })

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

  // Theme toggle — applies live, persisted in localStorage.
  const themePicker = panel.querySelector<HTMLElement>('.st-theme-picker')!
  themePicker.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.theme) return
    const theme = btn.dataset.theme as 'light' | 'dark'
    themePicker.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    setTheme(theme)
  })

  return panel
}

export function initSettings() {
  panelEl = buildPanel()
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  document.body.appendChild(panelEl)
  void refreshStatus()
}

export function openSettingsPanel() {
  if (!panelEl) return
  panelEl.removeAttribute('inert')
  panelEl.removeAttribute('aria-hidden')
  panelEl.classList.add('open')
  document.addEventListener('keydown', onSettingsKeydown)
  void refreshStatus()
  void loadModels()
  setTimeout(() => {
    // Focus the first empty required field
    if (!orgInput || !meInput) return
    if (!orgInput.value) orgInput.focus()
    else if (!meInput.value) meInput.focus()
    else orgInput.focus()
  }, 200)
}

export function closeSettingsPanel() {
  if (!panelEl) return
  panelEl.classList.remove('open')
  // Translated off-screen is not gone: without this the closed panel keeps its
  // place in the tab order, so tabbing from the last view control lands in
  // inputs nobody can see, and a screen reader still announces them.
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  document.removeEventListener('keydown', onSettingsKeydown)
}

function onSettingsKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (!panelEl?.classList.contains('open')) return
  e.preventDefault()
  closeSettingsPanel()
}

export function toggleSettingsPanel() {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) closeSettingsPanel()
  else openSettingsPanel()
}

// Mirrors isReady() on the server: org and username are what everything else
// is scoped by. A read that never reached the server is not an answer — say
// "configured" rather than force the panel open over a working install on a
// blip. The views surface their own errors when the server is unreachable.
export async function isFullyConfigured(): Promise<boolean> {
  await refreshStatus()
  if (!settingsLoadOk()) return true
  const s = getCachedSettings()
  return !!s.org && !!s.me
}
