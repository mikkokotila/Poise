// Burger menu — Main / Flow / Trust / divider / Settings / Typography
// Integrates with the typography and settings panels (opens them when clicked).

type ViewName = 'current' | 'swarm' | 'main'

const VIEW_KEY = 'poise-view'

const ICON_CURRENT = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="3" width="2.5" height="8" rx="0.6" stroke="currentColor" stroke-width="1.2"/><rect x="6" y="3" width="2.5" height="6" rx="0.6" stroke="currentColor" stroke-width="1.2"/><rect x="10" y="3" width="2.5" height="4" rx="0.6" stroke="currentColor" stroke-width="1.2"/></svg>'
const ICON_SWARM   = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7"   cy="3"   r="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="2.5" cy="10"  r="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M7 4.5L3.5 8.5M7 4.5l3.5 4M3.8 10h6.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
const ICON_ARCHIVE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M2 4v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4M5.5 7.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const ICON_TYPO  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M4 3v8M10 3v8M4 11h1.5M8.5 11H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_SETTINGS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M7 1v1.8M7 11.2V13M1 7h1.8M11.2 7H13M2.76 2.76l1.27 1.27M9.97 9.97l1.27 1.27M2.76 11.24l1.27-1.27M9.97 4.03l1.27-1.27" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const ICON_BURGER = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function loadView(): ViewName {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    // Stream was renamed to Current (and Pipe before that). Collapse the
    // legacy slugs to the new one once.
    if (v === 'pipe' || v === 'stream') {
      localStorage.setItem(VIEW_KEY, 'current')
      return 'current'
    }
    if (v === 'flow' || v === 'trust') {
      // Flow + Trust were dropped — land on Current (the new default).
      localStorage.setItem(VIEW_KEY, 'current')
      return 'current'
    }
    if (v === 'current' || v === 'swarm' || v === 'main') return v
  } catch { /* ignore */ }
  return 'current'
}
function saveView(v: ViewName) { localStorage.setItem(VIEW_KEY, v) }

export interface MenuCallbacks {
  onSelectView: (view: ViewName) => void
  onOpenTypography: () => void
  onOpenSettings: () => void
}

function anyPanelOpen(): boolean {
  return !!document.querySelector('#typo-panel.open, #settings-panel.open')
}
function closeAllPanels() {
  document.querySelector('#typo-panel.open')?.classList.remove('open')
  document.querySelector('#settings-panel.open')?.classList.remove('open')
}

export function initMenu(callbacks: MenuCallbacks): { switchTo: (v: ViewName) => void; currentView: () => ViewName } {
  let current: ViewName = loadView()

  // Toggle button (top-right)
  const toggle = document.createElement('button')
  toggle.id = 'menu-toggle'
  toggle.innerHTML = ICON_BURGER
  toggle.setAttribute('aria-label', 'Menu')
  document.body.appendChild(toggle)

  // Menu popover
  const menu = document.createElement('div')
  menu.id = 'menu-popover'
  menu.hidden = true
  menu.innerHTML = `
    <button class="menu-item" data-view="current">
      <span class="menu-icon">${ICON_CURRENT}</span><span class="menu-text">Current</span>
    </button>
    <button class="menu-item" data-view="swarm">
      <span class="menu-icon">${ICON_SWARM}</span><span class="menu-text">Swarm</span>
    </button>
    <button class="menu-item" data-view="main">
      <span class="menu-icon">${ICON_ARCHIVE}</span><span class="menu-text">Archive</span>
    </button>
    <div class="menu-divider"></div>
    <button class="menu-item" data-action="settings">
      <span class="menu-icon">${ICON_SETTINGS}</span><span class="menu-text">Settings</span>
    </button>
    <button class="menu-item" data-action="typography">
      <span class="menu-icon">${ICON_TYPO}</span><span class="menu-text">Typography</span>
    </button>
  `
  document.body.appendChild(menu)

  function setActiveItem() {
    menu.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === current)
    })
  }
  setActiveItem()

  function openMenu() {
    menu.hidden = false
    requestAnimationFrame(() => menu.classList.add('open'))
  }
  function closeMenu() {
    menu.classList.remove('open')
    setTimeout(() => {
      menu.hidden = true
      syncToggleIcon()
    }, 150)
  }

  function syncToggleIcon() {
    const anyOpen = !menu.hidden || anyPanelOpen()
    toggle.innerHTML = anyOpen ? ICON_CLOSE : ICON_BURGER
    toggle.classList.toggle('is-close', anyOpen)
  }

  // Watch panel class changes
  const panelObserver = new MutationObserver(syncToggleIcon)
  function observePanel(id: string) {
    const el = document.getElementById(id)
    if (el) panelObserver.observe(el, { attributes: true, attributeFilter: ['class'] })
  }
  observePanel('typo-panel')
  observePanel('settings-panel')
  // Also observe on first paint in case panels are appended later
  document.addEventListener('DOMContentLoaded', () => {
    observePanel('typo-panel')
    observePanel('settings-panel')
  })

  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    // Priority: if any panel is open, close it
    if (anyPanelOpen()) {
      closeAllPanels()
      syncToggleIcon()
      return
    }
    if (menu.hidden) openMenu()
    else closeMenu()
    syncToggleIcon()
  })

  menu.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn) return
    if (btn.dataset.view) {
      const next = btn.dataset.view as ViewName
      if (next !== current) {
        current = next
        saveView(current)
        setActiveItem()
        callbacks.onSelectView(current)
      }
      closeMenu()
    } else if (btn.dataset.action === 'typography') {
      closeMenu()
      callbacks.onOpenTypography()
    } else if (btn.dataset.action === 'settings') {
      closeMenu()
      callbacks.onOpenSettings()
    }
  })

  // Click outside → close menu (panels only close via X button / burger)
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== toggle && !toggle.contains(e.target as Node)) {
      closeMenu()
    }
  })

  return {
    switchTo: (v: ViewName) => {
      current = v
      saveView(current)
      setActiveItem()
      callbacks.onSelectView(current)
    },
    currentView: () => current,
  }
}
