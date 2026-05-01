import './style.css'
import { initTypography, toggleTypographyPanel } from './typo'
import { initSettings, toggleSettingsPanel, openSettingsPanel, isFullyConfigured } from './settings'
import { initMenu } from './menu'
import { initMainView, refreshMainView, stopMainRefresh } from './views/main-view'
import { initStreamView, stopStreamPolling } from './views/stream-view'
import { initSwarmView, stopSwarmRefresh } from './views/swarm-view'
import { loadSettings } from './config'

const viewMainEl = document.getElementById('view-main')!
const viewStreamEl = document.getElementById('view-stream')!
const viewSwarmEl = document.getElementById('view-swarm')!

function showView(v: 'main' | 'stream' | 'swarm') {
  const all = [viewMainEl, viewStreamEl, viewSwarmEl]
  const target = v === 'main' ? viewMainEl
    : v === 'stream' ? viewStreamEl
    : viewSwarmEl

  // Stop background polling when leaving the views that own them
  if (v !== 'swarm') stopSwarmRefresh()
  if (v !== 'stream') stopStreamPolling()
  if (v !== 'main') stopMainRefresh()

  // Initialize the target first so content exists before the animation starts
  if (v === 'main') initMainView()
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

// On load: pull settings first so views render with the correct org/me/timezone,
// then show the initial view. The user's external service keeps the data
// fresh; Poise only reads.
;(async () => {
  await loadSettings()
  showView(menu.currentView())

  const ready = await isFullyConfigured()
  if (!ready) openSettingsPanel()
})()

// When settings saves and triggers a refresh, re-init the open view to
// pull fresh data through whatever cache layer it uses.
window.addEventListener('poise:synced', () => {
  if (menu.currentView() === 'main') refreshMainView()
  else showView(menu.currentView())
})
