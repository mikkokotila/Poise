import './style.css'
import { initTypography, toggleTypographyPanel } from './typo'
import { initSettings, toggleSettingsPanel, openSettingsPanel, isFullyConfigured } from './settings'
import { initMenu } from './menu'
import { initMainView, refreshMainView, stopMainRefresh } from './views/main-view'
import { initCurrentView, stopCurrentPolling } from './views/current-view'
import { initSwarmView, stopSwarmRefresh, focusRow as focusSwarmRow } from './views/swarm-view'
import { initBehaviorsView } from './views/behaviors-view'
import { toggle as toggleChat } from './views/chat-pane'
import { loadSettings, startRefreshTicker, applyTheme, getTheme } from './config'

const viewMainEl = document.getElementById('view-main')!
const viewCurrentEl = document.getElementById('view-current')!
const viewSwarmEl = document.getElementById('view-swarm')!
const viewBehaviorsEl = document.getElementById('view-behaviors')!

type ViewSlug = 'main' | 'current' | 'swarm' | 'behaviors'

function showView(v: ViewSlug) {
  const all = [viewMainEl, viewCurrentEl, viewSwarmEl, viewBehaviorsEl]
  const target =
      v === 'main'      ? viewMainEl
    : v === 'current'   ? viewCurrentEl
    : v === 'swarm'     ? viewSwarmEl
    :                     viewBehaviorsEl

  // Stop background polling when leaving the views that own them
  if (v !== 'swarm')   stopSwarmRefresh()
  if (v !== 'current') stopCurrentPolling()
  if (v !== 'main')    stopMainRefresh()

  // Initialize the target first so content exists before the animation starts
  if (v === 'main')           initMainView()
  else if (v === 'current')   initCurrentView()
  else if (v === 'swarm')     initSwarmView()
  else                        initBehaviorsView()

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

// Apply the saved theme as early as possible so the first paint matches
// the user's preference (no light → dark flash on dark-mode boots).
applyTheme(getTheme())

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
  // Single shared refresh clock — every view listens for poise:refresh-tick
  // and refreshes on it. Wall-clock-aligned so switching views never causes
  // an off-cycle re-fetch. (Behaviors run server-side on their own
  // wall-clock ticker — see server/behaviors.ts.)
  startRefreshTicker()

  const ready = await isFullyConfigured()
  if (!ready) openSettingsPanel()
})()

// When settings saves and triggers a refresh, re-init the open view to
// pull fresh data through whatever cache layer it uses.
window.addEventListener('poise:synced', () => {
  if (menu.currentView() === 'main') refreshMainView()
  else showView(menu.currentView())
})

// Card chat icon → toggle the chat pane bound to that card's session.
// Clicking the same card's icon again closes the pane; switching to a
// different card swaps the conversation in place.
window.addEventListener('poise:open-chat', (ev) => {
  const detail = (ev as CustomEvent<{ session: string, label: string }>).detail
  if (!detail) return
  toggleChat(detail.session, detail.label)
})

// Behaviors view → Swarm row navigation. The "Last triggered" link
// dispatches `poise:goto-swarm-row` with { repo, pr_id }; switch to
// Swarm, wait for it to mount, then ask it to focus the matching log
// entry (scroll + expand if completed).
window.addEventListener('poise:goto-swarm-row', (ev) => {
  const detail = (ev as CustomEvent<{ repo: string, pr_id: string }>).detail
  if (!detail) return
  menu.switchTo('swarm')
  // Defer one frame so showView's animation classes have applied and
  // initSwarmView() has run before we ask for a focus.
  window.requestAnimationFrame(() => {
    focusSwarmRow(detail.repo, detail.pr_id)
  })
})
