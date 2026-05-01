import './style.css'
import { initTypography, toggleTypographyPanel } from './typo'
import { initSettings, toggleSettingsPanel, openSettingsPanel, isFullyConfigured } from './settings'
import { initMenu } from './menu'
import { initMainView, refreshMainView } from './views/main-view'
import { initFlowView } from './views/flow-view'
import { initTrustView } from './views/trust-view'
import { initStreamView } from './views/stream-view'
import { initSwarmView, stopSwarmRefresh } from './views/swarm-view'
import { loadSettings } from './config'

const viewMainEl = document.getElementById('view-main')!
const viewFlowEl = document.getElementById('view-flow')!
const viewTrustEl = document.getElementById('view-trust')!
const viewStreamEl = document.getElementById('view-stream')!
const viewSwarmEl = document.getElementById('view-swarm')!

function showView(v: 'main' | 'flow' | 'trust' | 'stream' | 'swarm') {
  const all = [viewMainEl, viewFlowEl, viewTrustEl, viewStreamEl, viewSwarmEl]
  const target = v === 'main' ? viewMainEl
    : v === 'flow' ? viewFlowEl
    : v === 'trust' ? viewTrustEl
    : v === 'stream' ? viewStreamEl
    : viewSwarmEl

  // Stop the swarm auto-refresh when leaving its view
  if (v !== 'swarm') stopSwarmRefresh()

  // Initialize the target first so content exists before the animation starts
  if (v === 'main') initMainView()
  else if (v === 'flow') initFlowView()
  else if (v === 'trust') initTrustView()
  else if (v === 'stream') initStreamView()
  else initSwarmView()

  for (const el of all) {
    if (el === target) {
      el.hidden = false
      el.classList.remove('view-entering')
      void (el as HTMLElement).offsetWidth
      el.classList.add('view-entering')
      window.setTimeout(() => el.classList.remove('view-entering'), 300)
    } else {
      el.hidden = true
    }
  }
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
}

// Init order: typography → settings → menu → initial view
initTypography()
initSettings()

const menu = initMenu({
  onSelectView: (v) => showView(v),
  onOpenTypography: () => toggleTypographyPanel(),
  onOpenSettings: () => toggleSettingsPanel(),
})

// On load: pull settings first so views can render with the correct org/me/timezone,
// then show the initial view, then sync.
;(async () => {
  await loadSettings()
  showView(menu.currentView())

  const ready = await isFullyConfigured()
  if (!ready) {
    openSettingsPanel()
    return
  }

  try {
    const res = await fetch('/api/cache/sync', { method: 'POST' })
    if (!res.ok) {
      if (res.status === 401 || res.status === 400) openSettingsPanel()
      return
    }
    const result = await res.json()
    console.log('[poise] sync:', result)
    if ((result.added > 0 || result.updated > 0) && menu.currentView() === 'main') {
      refreshMainView()
    }
  } catch (err) {
    console.warn('[poise] sync failed:', err)
  }
})()

// When settings saves a token + triggers sync, refresh any open view
window.addEventListener('poise:synced', () => {
  if (menu.currentView() === 'main') refreshMainView()
  else showView(menu.currentView()) // re-init flow/trust to pull fresh data
})

// Auto-refresh after 5 minutes idle
const IDLE_MS = 5 * 60 * 1000
let idleTimer: ReturnType<typeof setTimeout>
function resetIdleTimer() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(async () => {
    try { await fetch('/api/cache/sync', { method: 'POST' }) } catch { /* ignore */ }
    if (menu.currentView() === 'main') refreshMainView()
  }, IDLE_MS)
}
for (const evt of ['mousemove', 'keydown', 'scroll', 'click'] as const) {
  document.addEventListener(evt, resetIdleTimer, { passive: true })
}
resetIdleTimer()
