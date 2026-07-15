import './style.css'
import { initTypography, toggleTypographyPanel } from './typo'
import { initSettings, toggleSettingsPanel, openSettingsPanel, isFullyConfigured } from './settings'
import { initMenu } from './menu'
import { initMainView, refreshMainView } from './views/main-view'
import { initCurrentView } from './views/current-view'
import { initSwarmView, focusRow as focusSwarmRow } from './views/swarm-view'
import { initBehaviorsView } from './views/behaviors-view'
import { initSnippetsView } from './views/snippets-view'
import { initEditorView, stopEditorRefresh } from './views/editor-view'
import { toggle as toggleChat } from './views/chat-pane'
import { loadSettings, startRefreshTicker, applyTheme, getTheme } from './config'
import { initClaudeAuth } from './claude-auth'

const viewMainEl = document.getElementById('view-main')!
const viewCurrentEl = document.getElementById('view-current')!
const viewSwarmEl = document.getElementById('view-swarm')!
const viewBehaviorsEl = document.getElementById('view-behaviors')!
const viewSnippetsEl = document.getElementById('view-snippets')!
const viewEditorEl = document.getElementById('view-editor')!

type ViewSlug = 'main' | 'current' | 'swarm' | 'behaviors' | 'snippets' | 'editor'

function showView(v: ViewSlug) {
  const all = [viewMainEl, viewCurrentEl, viewSwarmEl, viewBehaviorsEl, viewSnippetsEl, viewEditorEl]
  const target =
      v === 'main'      ? viewMainEl
    : v === 'current'   ? viewCurrentEl
    : v === 'swarm'     ? viewSwarmEl
    : v === 'behaviors' ? viewBehaviorsEl
    : v === 'snippets'  ? viewSnippetsEl
    :                     viewEditorEl

  // Polling stays attached across view changes — every view that has
  // been visited at least once keeps fetching on every `poise:refresh-
  // tick`, so a row whose status flips from running → completed (or
  // whose time-elapsed advances) reflects on its next tick whether or
  // not its view is the one currently on screen. Returning to a view
  // therefore shows fresh data instantly rather than waiting for an
  // entry-fetch to land. The init functions are idempotent — each
  // guards its tick-listener with a boolean so re-entering doesn't
  // attach duplicates.
  //
  // Editor leave-cleanup is the one exception: stopEditorRefresh isn't
  // a polling-stop (the editor has no tick listener) — it flushes the
  // pending autosave, closes the doc-picker menu, and strips the
  // writer-mode body class so the chrome reappears in other views.
  // All of those are essential on leaving the editor; keep the call.
  if (v !== 'editor')    stopEditorRefresh()

  // Initialize the target first so content exists before the animation starts
  if (v === 'main')           initMainView()
  else if (v === 'current')   initCurrentView()
  else if (v === 'swarm')     initSwarmView()
  else if (v === 'behaviors') initBehaviorsView()
  else if (v === 'snippets')  initSnippetsView()
  else                        initEditorView()

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
initClaudeAuth()

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
// different card swaps the conversation in place. Hosts that want
// JSON-edit-card rendering (currently: the editor's toolbar chat)
// pass parseEdits=true in the event detail and may also supply hover
// / accept / decline callbacks so the host can react to user gestures
// on cards (highlight in surface, apply to surface, etc.); everyone
// else leaves them unset and gets plain prose rendering.
window.addEventListener('poise:open-chat', (ev) => {
  const detail = (ev as CustomEvent<{
    session: string,
    label: string,
    draft?: string,
    parseEdits?: boolean,
    onEditHover?: (edit: any) => void,
    onEditLeave?: () => void,
    onEditAccept?: (edit: any, key: string) => 'applied' | 'conflict',
    onEditDecline?: (edit: any, key: string) => void,
  }>).detail
  if (!detail) return
  toggleChat(detail.session, detail.label, detail.draft, {
    parseEdits: detail.parseEdits,
    onEditHover: detail.onEditHover,
    onEditLeave: detail.onEditLeave,
    onEditAccept: detail.onEditAccept,
    onEditDecline: detail.onEditDecline,
  })
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

// Chat /content → editor article. The chat pane dispatches
// `poise:open-editor-doc` after agent-interface --author-content
// completes; we switch to the editor view and re-dispatch a
// `poise:editor-load-doc` event the editor view listens for.
window.addEventListener('poise:open-editor-doc', (ev) => {
  const detail = (ev as CustomEvent<{ slug: string }>).detail
  if (!detail?.slug) return
  menu.switchTo('editor')
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail }))
  })
})
