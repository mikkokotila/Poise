// Settings panel — currently houses the GitHub personal access token.
// Slides in from the right, same pattern as the typography panel.

let panelEl: HTMLElement | null = null
let statusDot: HTMLElement | null = null
let statusText: HTMLElement | null = null
let tokenInput: HTMLInputElement | null = null
let saveBtn: HTMLButtonElement | null = null
let clearBtn: HTMLButtonElement | null = null
let helpEl: HTMLElement | null = null
let configured = false

async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status')
    const data = await res.json()
    configured = !!data.configured
    updateStatusUI()
  } catch {
    configured = false
    updateStatusUI()
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

async function saveToken() {
  if (!tokenInput || !saveBtn) return
  const token = tokenInput.value.trim()
  if (!token) {
    setHelp('Paste a classic PAT starting with ghp_', 'error')
    return
  }
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    const res = await fetch('/api/auth/set-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const data = await res.json()
    if (!res.ok) {
      setHelp(data.error || 'Failed to save', 'error')
    } else {
      setHelp('Token saved. Running initial sync…', 'ok')
      tokenInput.value = ''
      configured = true
      updateStatusUI()
      // Kick off a sync right away so the user sees data populate
      triggerSync()
    }
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
    // Broadcast so any visible view can refresh
    window.dispatchEvent(new CustomEvent('poise:synced'))
  } catch { /* ignore */ }
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'settings-panel'
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
        <input type="password" class="st-input" autocomplete="off" spellcheck="false" placeholder="ghp_…" />
        <div class="st-help st-help-info">Classic PAT with <code>repo</code> + <code>read:org</code> scopes.</div>
      </div>

      <div class="st-row">
        <button class="st-save">Save</button>
        <button class="st-clear" hidden>Clear</button>
      </div>

      <div class="tp-hint">
        Create a token at
        <a href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Poise"
           target="_blank" rel="noopener">github.com/settings/tokens</a>.
        It's stored locally in <code>~/.poise/cache.db</code> and only used to call the GitHub API on your behalf.
      </div>
    </div>
  `

  statusDot = panel.querySelector('.st-dot')
  statusText = panel.querySelector('.st-status-text')
  tokenInput = panel.querySelector('.st-input') as HTMLInputElement
  saveBtn = panel.querySelector('.st-save') as HTMLButtonElement
  clearBtn = panel.querySelector('.st-clear') as HTMLButtonElement
  helpEl = panel.querySelector('.st-help')

  saveBtn.addEventListener('click', saveToken)
  clearBtn.addEventListener('click', clearToken)
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveToken()
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
  setTimeout(() => tokenInput?.focus(), 200)
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
