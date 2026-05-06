// Current — five-lane kanban that mixes free-form thinking with live GitHub
// activity. The first three lanes (Idea / Concept / Plan) are manual cards
// you drag around; the last two (Issue / PR) are read-only feeds pulled
// from the local cache of issues + PRs you're involved in. Time + status
// filters in the header narrow the live lanes; the manual lanes are
// unaffected. The Issue lane has a richer composer (title / body / repo)
// that opens a real GitHub issue via the proxy.

import { getSettings, midnightInZone, startOfWeekInZone } from '../config'

type Lane = 'idea' | 'concept' | 'plan' | 'issue' | 'pr'
type LaneType = 'manual' | 'live'

interface LaneConfig { key: Lane; label: string; type: LaneType }

const LANES: LaneConfig[] = [
  { key: 'idea',    label: 'Idea',    type: 'manual' },
  { key: 'concept', label: 'Concept', type: 'manual' },
  { key: 'plan',    label: 'Plan',    type: 'manual' },
  { key: 'issue',   label: 'Issue',   type: 'live' },
  { key: 'pr',      label: 'PR',      type: 'live' },
]

interface ManualCard {
  id: number
  text: string
  lane: 'idea' | 'concept' | 'plan'
  position: number
  repo: string | null   // optional GitHub repo (full owner/name) the card connects to
  created_at: string
  updated_at: string
}

interface LiveItem {
  // Full GitHub identifier — `${repo}#${number}` is unique app-wide.
  repo: string                     // full name, "Vaquum/foo"
  number: number
  title: string
  url: string
  is_pr: 0 | 1
  state: 'open' | 'closed' | 'merged'
  created_at: string
  merged_at: string | null
  updated_at: string
}

interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  created_at: string
  updated_at: string
  merged_at: string | null
}

type PrStatus = 'mergeable'        // currently the only meaningful upstream signal
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000   // PRs created in the last 6h read as "just opened"

type TimeFilter = 'all' | 'today' | 'yesterday' | 'week'
type StatusFilter = 'all' | 'open'

const FILTER_KEY = 'poise-current-filters'
const LIVE_LIMIT = 200            // upper bound; time / status filters narrow further

let initialized = false
let manualCards: ManualCard[] = []
let liveItems: LiveItem[] = []
// Every Vaquum repo with any PR/issue history, populated from /api/repos
// on view init. Used by the manual + issue composers so the dropdown
// covers the whole org, not just the repos in the user's involvement.
let allRepos: string[] = []
// Set of `${repo}#${pr_id}` for agent-interface jobs currently running.
// Cards whose key matches get a subtle breathing accent so the user
// sees that something is going on behind the scenes for that ticket.
let agentActiveKeys: Set<string> = new Set()
let dragId: number | null = null
let viewEl: HTMLElement
let timeFilter: TimeFilter = 'all'
let statusFilter: StatusFilter = 'all'
let searchQuery = ''
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let prStatus: Map<string, PrStatus> = new Map()
// Optimistic queue for items the user just created (currently only
// the issue composer pushes into it). github-datastore is a polling
// consumer view — the moment after creation the datastore still
// returns the pre-creation list, which would make the new issue
// invisible. We park it here and prepend to liveItems on every
// fetchLive() until the datastore catches up; once it does, the
// canonical record from /api/gh takes over and the entry is dropped.
// One-hour TTL is a safety net so a stalled sync can't leave a ghost
// pinned at the top forever.
let pendingLiveItems: LiveItem[] = []
const PENDING_TTL_MS = 60 * 60 * 1000
// Tick listener installed on view init; removed via stopCurrentPolling()
// when navigating away. Single shared clock — see startRefreshTicker().
const onLiveTick = () => pollLiveTick()
let liveListening = false

// ── Helpers ─────────────────────────────────────────────────────────────────

// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >, which is fine for text-content interpolation but NOT for
// attribute values: an unescaped " or ' will close the attribute and
// the rest of the string will leak out as raw HTML (or just get
// dropped). We use this in both text and attribute positions, so the
// escape covers all five characters.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

function laneCfg(lane: Lane): LaneConfig {
  return LANES.find((l) => l.key === lane)!
}

function laneEl(lane: Lane): HTMLElement {
  return viewEl.querySelector(`.lane[data-lane="${lane}"]`)!
}

function laneListEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-list')!
}

function laneCountEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-count')!
}

function matchesSearch(...haystacks: (string | null | undefined)[]): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  for (const h of haystacks) {
    if (h && h.toLowerCase().includes(q)) return true
  }
  return false
}

function manualInLane(lane: 'idea' | 'concept' | 'plan'): ManualCard[] {
  return manualCards
    .filter((c) => c.lane === lane && matchesSearch(c.text))
    .sort((a, b) => a.position - b.position)
}

function timeWindow(): { since?: string; until?: string } {
  if (timeFilter === 'today')     return { since: midnightInZone(0).toISOString() }
  if (timeFilter === 'yesterday') return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
  if (timeFilter === 'week')      return { since: startOfWeekInZone().toISOString() }
  return {}
}

function liveInLane(lane: 'issue' | 'pr'): LiveItem[] {
  const isPr = lane === 'pr' ? 1 : 0
  // Items already arrive filtered server-side by status / time — search is
  // applied here client-side over the loaded set so typing is instant.
  return liveItems.filter((i) => i.is_pr === isPr && matchesSearch(i.title, i.repo))
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

// Open is implicit (the card existing tells you it's open). We only badge
// the deviations — merged and closed — so the eye lands on the cards that
// have actually moved past the "active work" state.
function liveStateLabel(item: LiveItem): { text: string; cls: string } | null {
  if (item.state === 'merged') return { text: 'merged', cls: 'merged' }
  if (item.state === 'closed') return { text: 'closed', cls: 'closed' }
  return null
}

function prKey(item: LiveItem): string {
  // repo is now the full owner/name, matching the /github record shape
  return `${item.repo}#${item.number}`
}

function shortRepo(fullRepo: string): string {
  const i = fullRepo.indexOf('/')
  return i < 0 ? fullRepo : fullRepo.slice(i + 1)
}

function isFresh(item: LiveItem): boolean {
  return Date.now() - new Date(item.created_at).getTime() < FRESH_WINDOW_MS
}

function isMergeable(item: LiveItem): boolean {
  return item.is_pr === 1 && prStatus.get(prKey(item)) === 'mergeable'
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (['all', 'today', 'yesterday', 'week'].includes(parsed.time)) timeFilter = parsed.time
    if (['all', 'open'].includes(parsed.status)) statusFilter = parsed.status
  } catch { /* ignore */ }
}

function saveFilters() {
  localStorage.setItem(FILTER_KEY, JSON.stringify({ time: timeFilter, status: statusFilter }))
}

// ── Render: shell + lanes ───────────────────────────────────────────────────

function renderShell(): string {
  const lanes = LANES.map((l) => `
    <section class="lane" data-lane="${l.key}" data-lane-type="${l.type}">
      <header class="lane-header">
        <span class="lane-title">${l.label}</span>
        <span class="lane-count">0</span>
      </header>
      <div class="lane-list" data-lane="${l.key}"></div>
      ${l.key === 'pr' ? '' : `
        <button class="lane-add" data-lane="${l.key}">+ ${l.key === 'issue' ? 'Add an issue' : 'Add a card'}</button>
      `}
    </section>
  `).join('')

  return `
    <header class="view-header">
      <div class="filter-cluster" id="current-filters">
        <div class="range-picker" id="current-status-filter">
          <button data-status="all" class="${statusFilter === 'all' ? 'active' : ''}">Any</button>
          <button data-status="open" class="${statusFilter === 'open' ? 'active' : ''}">Open</button>
        </div>
        <div class="range-picker" id="current-time-picker">
          <button data-time="all" class="${timeFilter === 'all' ? 'active' : ''}">Any time</button>
          <button data-time="today" class="${timeFilter === 'today' ? 'active' : ''}">Today</button>
          <button data-time="yesterday" class="${timeFilter === 'yesterday' ? 'active' : ''}">Yesterday</button>
          <button data-time="week" class="${timeFilter === 'week' ? 'active' : ''}">This week</button>
        </div>
        <input class="search-input" id="current-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" />
      </div>
    </header>
    <div class="kanban">${lanes}</div>
  `
}

// ── Card chrome strategy ──────────────────────────────────────────────
// All interactive icons live in a single hover-revealed strip anchored
// bottom-right. Content (title/body) gets the full card width — the
// strip overlaps the meta row instead, which fades out on hover so
// icons aren't sitting on top of visible text.
//
//   ┌──────────────── card ──────────────────┐
//   │  card content (FULL WIDTH — no inset)  │
//   │  …                                     │
//   │  meta row (repo · time)                │   meta fades on hover
//   │                          [copy][chat][×] │ ← single bottom-right
//   └────────────────────────────────────────┘    strip; grows leftward
//
// Order is `[tools …][primary]` — destructive/active singletons (×
// delete on manual cards, ▶ review on PRs) anchor as the rightmost
// member. Adding a 4th/5th icon later is just another <button> child
// of .card-actions before the primary slot — no layout reasoning
// needed.

const CHAT_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M2.5 3h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>'
// Two-rectangles "duplicate" mark — most universal copy glyph, reads
// as "copy" without the verbosity of a clipboard.
const COPY_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
// Checkmark shown for ~1.2s after a successful copy as visual feedback.
const CHECK_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function chatButton(sessionId: string, label: string, draft: string): string {
  return `<button class="card-action-btn card-chat-btn" data-session="${escapeHtml(sessionId)}" data-label="${escapeHtml(label)}" data-draft="${escapeHtml(draft)}" title="Chat about this card" aria-label="Chat">${CHAT_ICON_SVG}</button>`
}

function copyButton(text: string): string {
  return `<button class="card-action-btn card-copy-btn" data-clip="${escapeHtml(text)}" title="Copy" aria-label="Copy">${COPY_ICON_SVG}</button>`
}

function deleteButton(): string {
  return `<button class="card-action-btn card-delete" title="Delete card" aria-label="Delete card">×</button>`
}

function reviewButton(): string {
  return `<button class="card-action-btn card-review-btn" title="Run PR review" aria-label="Run PR review">${PR_REVIEW_PLAY_SVG}</button>`
}

// Bottom-right action strip — single horizontal cluster holding all
// of a card's icons. Order is `[tools …][primary]`: copy + chat (and
// any future tool) on the left, the per-card-type primary action
// (delete on manual cards, review on PRs) anchored as the rightmost
// member. `primary` may be empty (issue cards have no primary).
function cardActions(opts: {
  sessionId: string,
  label: string,
  copyText: string,
  primary?: string,
}): string {
  return `<div class="card-actions">${copyButton(opts.copyText)}${chatButton(opts.sessionId, opts.label, opts.copyText)}${opts.primary || ''}</div>`
}

// Copy `text` to the clipboard and briefly swap the button's icon
// for a check mark as visual confirmation. Falls back to a stale
// `document.execCommand('copy')` path for the rare browser/context
// without `navigator.clipboard` (insecure context, old WebView, etc.).
async function copyTextWithFeedback(btn: HTMLButtonElement, text: string): Promise<void> {
  let ok = false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      ok = true
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
  } catch (err) {
    console.error('[copy] failed:', err)
  }
  if (!ok) return
  // Swap icon → check, mark .is-copied so CSS can settle the colour
  // to a quiet success tone, then revert after ~1.2s. Using two
  // rAFs ensures the icon swap actually paints before any CSS
  // transition piggy-backs.
  const original = btn.innerHTML
  btn.innerHTML = CHECK_ICON_SVG
  btn.classList.add('is-copied')
  window.setTimeout(() => {
    btn.classList.remove('is-copied')
    btn.innerHTML = original
  }, 1200)
}

function manualSessionId(card: ManualCard): string {
  return `poise.card.${card.id}`
}

function liveSessionId(item: LiveItem): string {
  return `poise.${item.is_pr === 1 ? 'pr' : 'issue'}.${item.repo}.${item.number}`
}

function renderManualCard(card: ManualCard): HTMLElement {
  const el = document.createElement('article')
  el.className = 'card'
  el.draggable = true
  el.dataset.id = String(card.id)
  el.dataset.lane = card.lane
  // Meta row mirrors the PR/Issue card shape — repo (if linked) on the
  // left, timestamp at the end. Bottom-right hosts the delete action;
  // the top-right strip hosts the non-destructive tool icons (chat,
  // copy, …) — see the chrome strategy comment near cardActions().
  const repoTag = card.repo
    ? `<span class="card-repo">${escapeHtml(shortRepo(card.repo))}</span>`
    : ''
  el.innerHTML = `
    <div class="card-text">${escapeHtml(card.text).replace(/\n/g, '<br>')}</div>
    <div class="card-meta">
      ${repoTag}
      <span class="card-time">${relativeTime(card.updated_at)}</span>
    </div>
    ${cardActions({
      sessionId: manualSessionId(card),
      label: card.text.slice(0, 60),
      copyText: card.text,
      primary: deleteButton(),
    })}
  `
  return el
}

// Small play icon for PR cards — same shape Archive uses for its
// consensus-review button so the visual vocabulary stays consistent.
const PR_REVIEW_PLAY_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>'
const PR_REVIEW_SPIN_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'

function renderLiveItem(item: LiveItem): HTMLElement {
  const el = document.createElement('article')
  const classes = ['card', 'card-live']
  if (isMergeable(item))      classes.push('card-mergeable')
  else if (isFresh(item) && item.is_pr === 1) classes.push('card-fresh')
  if (agentActiveKeys.has(prKey(item))) classes.push('card-active')
  el.className = classes.join(' ')
  el.dataset.id = prKey(item)        // stable id across refreshes for the FLIP
  const st = liveStateLabel(item)
  const stateBadge = st ? `<span class="state ${st.cls}">${st.text}</span>` : ''
  // PR cards get a tiny review icon as the rightmost member of the
  // action strip; issue cards have no primary action — only the
  // tools row.
  const primary = item.is_pr === 1 ? reviewButton() : ''
  el.innerHTML = `
    <a class="card-link" href="${item.url}" target="_blank" rel="noopener">
      <div class="card-text">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        <span class="card-repo">${escapeHtml(shortRepo(item.repo))}</span>
        <span class="card-num">#${item.number}</span>
        ${stateBadge}
        <span class="card-time">${relativeTime(item.updated_at)}</span>
      </div>
    </a>
    ${cardActions({
      sessionId: liveSessionId(item),
      label: `${shortRepo(item.repo)}#${item.number}`,
      copyText: `${item.title}\n${item.url}`,
      primary,
    })}
  `
  return el
}

function renderAll() {
  for (const l of LANES) {
    const list = laneListEl(l.key)
    list.innerHTML = ''
    let count = 0
    if (l.type === 'manual') {
      const items = manualInLane(l.key as 'idea' | 'concept' | 'plan')
      for (const c of items) list.appendChild(renderManualCard(c))
      count = items.length
    } else {
      const items = liveInLane(l.key as 'issue' | 'pr')
      for (const i of items) list.appendChild(renderLiveItem(i))
      count = items.length
    }
    laneCountEl(l.key).textContent = String(count)
  }
}

// Re-render only the live lanes. Two modes:
//   - snap (animate=false): clear + rebuild — used for filter / search
//     changes, where the user initiated the change and expects a hard
//     update.
//   - animated (animate=true): used by the once-a-minute background
//     refresh. Re-orders existing card nodes via a FLIP transition so
//     they glide to their new positions; new cards drop-and-fade in;
//     leaving cards just disappear (rare, and the FLIP handles the gap).
function renderLiveOnly(opts: { animate?: boolean } = {}) {
  for (const l of LANES) {
    if (l.type !== 'live') continue
    if (opts.animate) renderLiveLaneAnimated(l.key as 'issue' | 'pr')
    else              renderLiveLaneSnap(l.key as 'issue' | 'pr')
  }
}

function renderLiveLaneSnap(laneKey: 'issue' | 'pr') {
  const list = laneListEl(laneKey)
  list.innerHTML = ''
  const items = liveInLane(laneKey)
  for (const i of items) list.appendChild(renderLiveItem(i))
  laneCountEl(laneKey).textContent = String(items.length)
}

// FLIP — First, Last, Invert, Play. The single piece of motion in the
// app that earns its time on screen. ~700ms with the standard ease so
// it reads as a deliberate settling, not a glitch. No stagger — the
// whole column shifts together so the eye locks onto the new ordering
// rather than chasing individual cards.
const FLIP_MS = 700

function renderLiveLaneAnimated(laneKey: 'issue' | 'pr') {
  const list = laneListEl(laneKey)
  const newItems = liveInLane(laneKey)

  // 1. First — capture current bounding rects of every visible card
  const firstRects = new Map<string, DOMRect>()
  const existingEls = new Map<string, HTMLElement>()
  for (const el of [...list.children] as HTMLElement[]) {
    if (!el.classList.contains('card')) continue
    const id = el.dataset.id
    if (!id) continue
    firstRects.set(id, el.getBoundingClientRect())
    existingEls.set(id, el)
  }

  // 2. Last — reorder existing nodes + insert any new ones. Cards no
  //    longer in newItems are dropped from the DOM (no leave animation
  //    in v1; in practice the polling rarely sees a card disappear).
  const newIds = new Set(newItems.map(prKey))
  for (const [id, el] of existingEls) {
    if (!newIds.has(id)) el.remove()
  }
  const fragment = document.createDocumentFragment()
  for (const item of newItems) {
    const idStr = prKey(item)
    const existing = existingEls.get(idStr)
    if (existing) {
      fragment.appendChild(existing)        // moved to its new index
    } else {
      const fresh = renderLiveItem(item)
      fresh.classList.add('card-entering')   // CSS animation handles the fade-and-drop
      fragment.appendChild(fresh)
    }
  }
  list.appendChild(fragment)

  // 3. Invert — for every card that existed before AND after, compute
  //    the delta from old → new layout and apply the inverse transform
  //    so the card LOOKS like it's still in its old position.
  const movers: HTMLElement[] = []
  for (const item of newItems) {
    const cardEl = existingEls.get(prKey(item))
    if (!cardEl) continue
    const firstRect = firstRects.get(prKey(item))
    if (!firstRect) continue
    const lastRect = cardEl.getBoundingClientRect()
    const dx = firstRect.left - lastRect.left
    const dy = firstRect.top  - lastRect.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue   // didn't move
    cardEl.style.transition = 'none'
    cardEl.style.transform = `translate(${dx}px, ${dy}px)`
    movers.push(cardEl)
  }

  // 4. Play — flush layout, then animate transform back to identity.
  //    requestAnimationFrame guarantees the inverted position is painted
  //    before the transition kicks in.
  if (movers.length > 0) {
    void list.offsetHeight   // force reflow so the transform is committed
    requestAnimationFrame(() => {
      for (const cardEl of movers) {
        cardEl.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`
        cardEl.style.transform = ''
      }
      // Clean up inline styles after the animation finishes so they
      // don't interfere with future renders.
      window.setTimeout(() => {
        for (const cardEl of movers) {
          cardEl.style.transition = ''
          cardEl.style.transform = ''
        }
      }, FLIP_MS + 50)
    })
  }

  laneCountEl(laneKey).textContent = String(newItems.length)
}

// ── Data fetches ─────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
  return res.json()
}

async function fetchManual() {
  const res = await fetch('/api/current')
  if (!res.ok) throw new Error(`/api/current ${res.status}`)
  const data = await res.json()
  manualCards = data.cards.filter((c: ManualCard) => c.lane === 'idea' || c.lane === 'concept' || c.lane === 'plan')
}

// Fill the org-wide repo list. Server caches 5 min so this is cheap on
// every view init. Silently swallows errors — composers fall back to
// the involvement-derived list.
async function fetchAllRepos() {
  try {
    const res = await fetch('/api/repos')
    if (!res.ok) return
    const data = await res.json()
    allRepos = Array.isArray(data.repos) ? data.repos : []
  } catch { /* ignore */ }
}

// Pull /api/agent-logs and rebuild the set of running-job keys. Called
// alongside fetchLive on each refresh tick. Errors are swallowed —
// the breathing accent simply doesn't show.
async function fetchAgentActive() {
  try {
    const res = await fetch('/api/agent-logs')
    if (!res.ok) return
    const data = await res.json()
    const next = new Set<string>()
    for (const e of (data.logs || [])) {
      if (e.status === 'running' && e.repo && e.pr_id) {
        next.add(`${e.repo}#${e.pr_id}`)
      }
    }
    agentActiveKeys = next
  } catch { /* ignore */ }
}

// Toggle `.card-active` in place across all live cards. Doesn't touch
// other classes or run a re-render — works alongside the FLIP that
// owns positional updates, similar to applyPrStatusClasses.
function applyActiveClasses() {
  for (const cardEl of viewEl.querySelectorAll<HTMLElement>('.card.card-live')) {
    const id = cardEl.dataset.id || ''
    cardEl.classList.toggle('card-active', agentActiveKeys.has(id))
  }
}

async function fetchPrStatus() {
  if (liveItems.filter((i) => i.is_pr === 1).length === 0) {
    if (prStatus.size > 0) { prStatus.clear(); applyPrStatusClasses() }
    return
  }
  try {
    const res = await fetch('/api/gh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'green_pr' }),
    })
    if (!res.ok) return
    const data = await res.json()
    // The /github endpoint already returns full records — repo here is
    // the full "Vaquum/repo" name, matching the format prKey() builds.
    const next = new Map<string, PrStatus>()
    for (const r of data.records || []) {
      next.set(`${r.repo}#${r.number}`, 'mergeable')
    }
    const changed = next.size !== prStatus.size
      || [...next.entries()].some(([k, v]) => prStatus.get(k) !== v)
    if (changed) {
      prStatus = next
      applyPrStatusClasses()
    }
  } catch { /* upstream offline — silent, cards stay neutral */ }
}

// Touch the mergeable / fresh classes on PR cards in place. Avoids a full
// re-render so the FLIP-induced inline transforms aren't disturbed and
// the user sees no flicker when only the PR-status map changed.
function applyPrStatusClasses() {
  for (const cardEl of viewEl.querySelectorAll<HTMLElement>('.card.card-live')) {
    const id = cardEl.dataset.id || ''
    const item = liveItems.find((i) => prKey(i) === id)
    if (!item || item.is_pr !== 1) continue
    const merge = isMergeable(item)
    const fresh = !merge && isFresh(item)
    cardEl.classList.toggle('card-mergeable', merge)
    cardEl.classList.toggle('card-fresh', fresh)
  }
}

export function stopCurrentPolling() {
  if (liveListening) {
    window.removeEventListener('poise:refresh-tick', onLiveTick)
    liveListening = false
  }
}

// Background tick: re-fetch live items, refresh PR mergeable status,
// and rebuild the agent-active set. The live re-render uses the FLIP
// path so cards glide to their new positions; PR-status and active
// passes only twiddle classes so they don't disturb the FLIP.
async function pollLiveTick() {
  try {
    await fetchLive()
    renderLiveOnly({ animate: true })
  } catch { /* network blip — try again next tick */ }
  try {
    await fetchPrStatus()
  } catch { /* same */ }
  try {
    await fetchAgentActive()
    applyActiveClasses()
  } catch { /* same */ }
}

async function fetchLive() {
  const win = timeWindow()
  const payload: Record<string, unknown> = {
    operation: 'list',
    record_type: 'all',
    record_state: statusFilter === 'open' ? 'open' : 'all',
    limit: LIVE_LIMIT,
    offset: 0,
  }
  if (win.since) payload.updated_since = win.since
  if (win.until) payload.updated_until = win.until
  const res = await fetch('/api/gh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`/api/gh ${res.status}`)
  const data = await res.json()
  const records: GhRecord[] = data.records || []
  liveItems = records.map((r) => ({
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
    is_pr: r.kind === 'pr' ? 1 : 0,
    state: r.state,
    created_at: r.created_at,
    merged_at: r.merged_at,
    updated_at: r.updated_at,
  }))
  reconcilePending()
}

// Drop pending entries the datastore has now picked up (matched by
// repo + number) and any older than PENDING_TTL_MS, then prepend the
// remaining optimistic items so they appear at the top of their lane.
// Called from fetchLive() right after liveItems is replaced.
function reconcilePending() {
  if (!pendingLiveItems.length) return
  const cutoff = Date.now() - PENDING_TTL_MS
  pendingLiveItems = pendingLiveItems.filter((p) => {
    if (new Date(p.created_at).getTime() < cutoff) return false
    return !liveItems.some((li) => li.repo === p.repo && li.number === p.number)
  })
  if (pendingLiveItems.length) {
    liveItems = [...pendingLiveItems, ...liveItems]
  }
}

// Full repo names ("Vaquum/foo") seen in the loaded live set, sorted by
// the short name so the issue dropdown reads cleanly.
function distinctRepos(): string[] {
  const set = new Set<string>()
  for (const i of liveItems) set.add(i.repo)
  return [...set].sort((a, b) => shortRepo(a).localeCompare(shortRepo(b)))
}

// ── Composers ────────────────────────────────────────────────────────────────

function attachAddHandlers() {
  for (const l of LANES) {
    if (l.key === 'pr') continue
    const btn = laneEl(l.key).querySelector<HTMLButtonElement>('.lane-add')
    if (!btn) continue
    btn.addEventListener('click', () => {
      if (l.key === 'issue') openIssueComposer()
      else openManualComposer(l.key as 'idea' | 'concept' | 'plan')
    })
  }
}

// "— no repo —" + every Vaquum repo. Falls back to the involvement set
// only if /api/repos hasn't loaded yet (cold start race).
function manualRepoOptionsHtml(selected: string | null = null): string {
  const repos = allRepos.length > 0 ? allRepos : distinctRepos()
  const opts = ['<option value="">— no repo —</option>']
  for (const r of repos) {
    const sel = selected === r ? ' selected' : ''
    opts.push(`<option value="${escapeHtml(r)}"${sel}>${escapeHtml(shortRepo(r))}</option>`)
  }
  return opts.join('')
}

function openManualComposer(lane: 'idea' | 'concept' | 'plan') {
  const laneNode = laneEl(lane)
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    (existing.querySelector('textarea') as HTMLTextAreaElement | null)?.focus()
    return
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  const composer = document.createElement('div')
  composer.className = 'composer'
  composer.innerHTML = `
    <textarea rows="3" placeholder="Write a card..." spellcheck="true"></textarea>
    <select class="manual-repo">${manualRepoOptionsHtml()}</select>
    <div class="composer-row">
      <button class="composer-add">Add</button>
      <button class="composer-cancel" type="button">Cancel</button>
      <span class="composer-hint">⌘↵ to add</span>
    </div>
  `
  laneNode.insertBefore(composer, addBtn)
  const ta = composer.querySelector<HTMLTextAreaElement>('textarea')!
  const repoSel = composer.querySelector<HTMLSelectElement>('.manual-repo')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!

  const close = () => { composer.remove(); addBtn.hidden = false }
  const submit = async () => {
    const text = ta.value.trim()
    if (!text) { close(); return }
    addB.disabled = true
    try {
      const repo = repoSel.value || null
      const card = await api<ManualCard>('POST', '/api/current', { text, lane, repo })
      manualCards.push(card)
      renderAll()
      close()
    } catch (err) {
      addB.disabled = false
      console.error(err)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  })
  ta.focus()
}

// `prefill` lets a drag-promote (manual card → Issue lane) reuse this
// composer with the card's content pre-loaded. The user just needs to
// type the title; if the card already had a repo linked, it's
// pre-selected too. On successful submit, the source manual card is
// deleted so the conversion is final. If the user cancels, the card
// stays put.
interface IssueComposerPrefill {
  body?: string
  repo?: string | null
  sourceCardId?: number
}

function openIssueComposer(prefill?: IssueComposerPrefill) {
  const laneNode = laneEl('issue')
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    if (!prefill) {
      // Plain "+ Add an issue" click while one is already open — just focus.
      ;(existing.querySelector('input') as HTMLInputElement | null)?.focus()
      return
    }
    // Drop with new prefill: replace what's there so the dropped card
    // wins. Whatever the user had typed in the existing composer is
    // discarded — that's the price of doing two things at once.
    existing.remove()
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  // Show short names in the dropdown but submit the full owner/name as the
  // value so the API call doesn't have to reassemble it. Sources from
  // /api/repos (every org repo); falls back to the involvement set only
  // if that hasn't loaded yet. If the dropped card carries a repo, we
  // pre-select it; the user can still change it before submitting.
  const repos = allRepos.length > 0 ? allRepos : distinctRepos()
  const wantRepo = prefill?.repo || ''
  const repoOptions = repos.length === 0
    ? '<option value="">(no repos available)</option>'
    : repos.map((r) => `<option value="${escapeHtml(r)}"${r === wantRepo ? ' selected' : ''}>${escapeHtml(shortRepo(r))}</option>`).join('')

  const composer = document.createElement('div')
  composer.className = 'composer composer-issue'
  composer.innerHTML = `
    <input type="text" class="issue-title" placeholder="Issue title" autocomplete="off" spellcheck="true" />
    <textarea class="issue-body" rows="3" placeholder="Body (optional)" spellcheck="true"></textarea>
    <select class="issue-repo">${repoOptions}</select>
    <div class="composer-row">
      <button class="composer-add">Open issue</button>
      <button class="composer-cancel" type="button">Cancel</button>
      <span class="composer-hint">⌘↵ to submit</span>
    </div>
    <div class="composer-error" hidden></div>
  `
  laneNode.insertBefore(composer, addBtn)
  const titleInput = composer.querySelector<HTMLInputElement>('.issue-title')!
  const bodyTa = composer.querySelector<HTMLTextAreaElement>('.issue-body')!
  const repoSel = composer.querySelector<HTMLSelectElement>('.issue-repo')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!
  const errEl = composer.querySelector<HTMLElement>('.composer-error')!

  // Prefilled body lands as the issue's body; user provides the title.
  if (prefill?.body) bodyTa.value = prefill.body

  const close = () => { composer.remove(); addBtn.hidden = false }
  const showError = (msg: string) => {
    errEl.textContent = msg
    errEl.hidden = false
  }
  const submit = async () => {
    const title = titleInput.value.trim()
    const body = bodyTa.value.trim()
    const repo = repoSel.value             // already the full owner/name
    if (!title) { showError('Title is required'); titleInput.focus(); return }
    if (!repo)  { showError('Repo is required'); return }

    addB.disabled = true
    addB.textContent = 'Opening…'
    errEl.hidden = true
    try {
      const ghRes = await fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'open_issue',
          repository_full_name: repo,
          title,
          body,
        }),
      })
      if (!ghRes.ok) {
        const text = await ghRes.text().catch(() => '')
        throw new Error(`Github ${ghRes.status}: ${text.slice(0, 160)}`)
      }
      // The server returns the freshly-created issue normalized as a
      // GhRecord. github-datastore is a polling consumer, so the
      // canonical record won't show up in /api/gh for some seconds —
      // we park the issue in pendingLiveItems and prepend it on every
      // fetchLive() until the datastore catches up. This guarantees
      // the new issue is visible the moment the composer closes.
      try {
        const result = await ghRes.json()
        const r = result?.record
        if (r && r.kind === 'issue' && r.number) {
          pendingLiveItems = pendingLiveItems.filter((p) => !(p.repo === r.repo && p.number === r.number))
          pendingLiveItems.unshift({
            repo: String(r.repo),
            number: Number(r.number),
            title: String(r.title),
            url: String(r.url),
            is_pr: 0,
            state: (r.state as 'open' | 'closed' | 'merged') || 'open',
            created_at: String(r.created_at),
            merged_at: r.merged_at ? String(r.merged_at) : null,
            updated_at: String(r.updated_at),
          })
        }
      } catch { /* fall through — fetchLive on its own may still surface it */ }
      // Drag-promote: the source manual card is deleted only after the
      // issue is confirmed created. If we got here, the POST returned
      // 200 — safe to remove. We swallow delete errors so a later DB
      // hiccup doesn't undo the promotion the user just confirmed.
      if (prefill?.sourceCardId !== undefined) {
        try { await deleteManualCard(prefill.sourceCardId) }
        catch (err) { console.error('[promote] delete source card failed:', err) }
      }
      close()
      await fetchLive()
      renderLiveOnly({ animate: true })
    } catch (err) {
      addB.disabled = false
      addB.textContent = 'Open issue'
      showError((err as Error).message)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', close)
  for (const inp of [titleInput, bodyTa]) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
    })
  }
  titleInput.focus()
}

// ── Edit / delete (manual lanes only) ────────────────────────────────────────

function startEdit(cardEl: HTMLElement) {
  if (cardEl.classList.contains('editing')) return
  if (cardEl.classList.contains('card-live')) return  // live cards are read-only
  const id = Number(cardEl.dataset.id)
  const card = manualCards.find((c) => c.id === id)
  if (!card) return
  cardEl.classList.add('editing')
  cardEl.draggable = false

  const originalText = card.text
  const originalRepo = card.repo ?? null
  const wrapper = document.createElement('div')
  wrapper.className = 'card-edit'
  wrapper.innerHTML = `
    <textarea rows="3" spellcheck="true"></textarea>
    <select class="manual-repo">${manualRepoOptionsHtml(originalRepo)}</select>
    <div class="composer-row">
      <button class="composer-add">Save</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  const ta = wrapper.querySelector<HTMLTextAreaElement>('textarea')!
  const repoSel = wrapper.querySelector<HTMLSelectElement>('.manual-repo')!
  ta.value = originalText

  const textNode = cardEl.querySelector<HTMLElement>('.card-text')!
  const metaNode = cardEl.querySelector<HTMLElement>('.card-meta')
  const deleteBtn = cardEl.querySelector<HTMLButtonElement>('.card-delete')!
  textNode.hidden = true
  if (metaNode) metaNode.hidden = true
  if (deleteBtn) deleteBtn.hidden = true
  cardEl.appendChild(wrapper)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  const close = () => {
    cardEl.classList.remove('editing')
    cardEl.draggable = true
    wrapper.remove()
    textNode.hidden = false
    if (metaNode) metaNode.hidden = false
    if (deleteBtn) deleteBtn.hidden = false
  }
  const save = async () => {
    const text = ta.value.trim()
    const repo = repoSel.value || null
    if (!text) { close(); return }
    if (text === originalText && repo === originalRepo) { close(); return }
    try {
      const patch: Record<string, unknown> = {}
      if (text !== originalText) patch.text = text
      if (repo !== originalRepo) patch.repo = repo
      const updated = await api<ManualCard>('PATCH', `/api/current/${id}`, patch)
      const idx = manualCards.findIndex((c) => c.id === id)
      if (idx >= 0) manualCards[idx] = updated
      renderAll()
    } catch (err) {
      console.error(err)
      close()
    }
  }

  wrapper.querySelector<HTMLButtonElement>('.composer-add')!.addEventListener('click', save)
  wrapper.querySelector<HTMLButtonElement>('.composer-cancel')!.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
  })
}

async function deleteManualCard(id: number) {
  await api('DELETE', `/api/current/${id}`)
  manualCards = manualCards.filter((c) => c.id !== id)
  renderAll()
}

// ── Drag and drop (manual lanes only) ────────────────────────────────────────

let dropIndicator: HTMLElement | null = null

function ensureIndicator(): HTMLElement {
  if (!dropIndicator) {
    dropIndicator = document.createElement('div')
    dropIndicator.className = 'drop-indicator'
  }
  return dropIndicator
}

function clearIndicator() {
  if (dropIndicator) dropIndicator.remove()
}

function insertionIndex(list: HTMLElement, clientY: number): number {
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card:not(.card-live)')]
    .filter((c) => Number(c.dataset.id) !== dragId)
  for (let i = 0; i < cardsInList.length; i++) {
    const rect = cardsInList[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return cardsInList.length
}

function placeIndicator(list: HTMLElement, index: number) {
  const indicator = ensureIndicator()
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card:not(.card-live)')]
    .filter((c) => Number(c.dataset.id) !== dragId)
  if (index >= cardsInList.length) {
    list.appendChild(indicator)
  } else {
    list.insertBefore(indicator, cardsInList[index])
  }
}

function attachDragHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!

  kanban.addEventListener('dragstart', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    if (!cardEl || cardEl.classList.contains('editing') || cardEl.classList.contains('card-live')) {
      e.preventDefault()
      return
    }
    dragId = Number(cardEl.dataset.id)
    cardEl.classList.add('dragging')
    e.dataTransfer?.setData('text/plain', String(dragId))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })

  kanban.addEventListener('dragend', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    cardEl?.classList.remove('dragging')
    dragId = null
    clearIndicator()
    viewEl.querySelectorAll('.lane.lane-drag-over').forEach((l) => l.classList.remove('lane-drag-over'))
  })

  // Drop targets are only the manual lanes — live lanes don't accept drops
  for (const l of LANES) {
    if (l.type !== 'manual') continue
    const lane = laneEl(l.key)
    const list = laneListEl(l.key)

    lane.addEventListener('dragover', (e) => {
      if (dragId === null) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const idx = insertionIndex(list, e.clientY)
      placeIndicator(list, idx)
      lane.classList.add('lane-drag-over')
    })

    lane.addEventListener('dragleave', (e) => {
      const related = e.relatedTarget as Node | null
      if (related && lane.contains(related)) return
      clearIndicator()
      lane.classList.remove('lane-drag-over')
    })

    lane.addEventListener('drop', async (e) => {
      e.preventDefault()
      lane.classList.remove('lane-drag-over')
      if (dragId === null) return
      const movingId = dragId
      const targetLane = l.key as 'idea' | 'concept' | 'plan'
      const idx = insertionIndex(list, e.clientY)
      clearIndicator()

      const moving = manualCards.find((c) => c.id === movingId)
      if (!moving) return
      const sourceLane = moving.lane
      const sameLane = sourceLane === targetLane

      const targets = manualCards.filter((c) => c.lane === targetLane && c.id !== movingId)
        .sort((a, b) => a.position - b.position)
      targets.splice(Math.min(idx, targets.length), 0, moving)
      targets.forEach((c, i) => { c.position = i; c.lane = targetLane })

      if (!sameLane) {
        const sources = manualCards.filter((c) => c.lane === sourceLane && c.id !== movingId)
          .sort((a, b) => a.position - b.position)
        sources.forEach((c, i) => { c.position = i })
      }
      renderAll()

      try {
        await api('PATCH', `/api/current/${movingId}`, { lane: targetLane, position: idx })
      } catch (err) {
        console.error('move failed:', err)
        try { await fetchManual(); renderAll() } catch { /* ignore */ }
      }
    })
  }

  // Issue lane is a special drop target: dragging a manual card here
  // doesn't reorder anything — it converts the card into a draft
  // GitHub issue. The drop opens the issue composer pre-populated
  // with the card's text (as the body) and repo (if linked), focuses
  // the title field, and only deletes the source card after the
  // issue is successfully created on GitHub. No insertion indicator,
  // no position math.
  const issueLane = laneEl('issue')
  issueLane.addEventListener('dragover', (e) => {
    if (dragId === null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'   // semantic hint: this is "convert", not "move"
    issueLane.classList.add('lane-drag-over')
  })
  issueLane.addEventListener('dragleave', (e) => {
    const related = e.relatedTarget as Node | null
    if (related && issueLane.contains(related)) return
    issueLane.classList.remove('lane-drag-over')
  })
  issueLane.addEventListener('drop', (e) => {
    e.preventDefault()
    issueLane.classList.remove('lane-drag-over')
    if (dragId === null) return
    const moving = manualCards.find((c) => c.id === dragId)
    if (!moving) return
    openIssueComposer({
      body: moving.text,
      repo: moving.repo,
      sourceCardId: moving.id,
    })
  })
}

// ── Card-level click delegation ──────────────────────────────────────────────

function attachCardClickHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!
  kanban.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    // Top-right action strip — both chat and copy live here. We match
    // each in turn before the per-card-type primary action below
    // (review/delete) so a click on a tool icon is never ambiguous
    // with the card-link navigation.

    // Copy icon — copies the card's content to the clipboard and
    // briefly swaps the icon for a checkmark as visual feedback.
    const copyBtn = target.closest<HTMLButtonElement>('.card-copy-btn')
    if (copyBtn) {
      e.preventDefault()
      e.stopPropagation()
      const text = copyBtn.dataset.clip || ''
      if (!text) return
      void copyTextWithFeedback(copyBtn, text)
      return
    }

    // Chat icon — opens (or toggles) the per-card chat pane on the
    // left. Sibling of card-link / card-text so it doesn't propagate
    // into navigation or edit.
    const chatBtn = target.closest<HTMLButtonElement>('.card-chat-btn')
    if (chatBtn) {
      e.preventDefault()
      e.stopPropagation()
      const session = chatBtn.dataset.session || ''
      const label = chatBtn.dataset.label || ''
      const draft = chatBtn.dataset.draft || ''
      if (!session) return
      window.dispatchEvent(new CustomEvent('poise:open-chat', { detail: { session, label, draft } }))
      return
    }

    // PR review icon — fires off agent-interface --pr-review for the PR
    // and shows a brief running/done indicator. Stop propagation so the
    // card link doesn't navigate to GitHub at the same time.
    const reviewBtn = target.closest<HTMLButtonElement>('.card-review-btn')
    if (reviewBtn) {
      e.preventDefault()
      e.stopPropagation()
      if (reviewBtn.disabled) return
      const cardEl = reviewBtn.closest<HTMLElement>('.card')!
      const id = cardEl.dataset.id || ''
      const item = liveItems.find((i) => prKey(i) === id)
      if (!item) return
      reviewBtn.disabled = true
      reviewBtn.classList.add('running')
      reviewBtn.innerHTML = PR_REVIEW_SPIN_SVG
      try {
        const res = await fetch('/api/pr-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text ? `${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status}`)
        }
        reviewBtn.classList.remove('running')
        reviewBtn.classList.add('done')
        reviewBtn.innerHTML = PR_REVIEW_PLAY_SVG
        // The breathing accent is driven entirely by /api/agent-logs
        // — it captures every running job, not just card-initiated
        // ones. Just nudge a re-poll after agent-interface has had a
        // moment to spawn its Python and write the running row, so
        // the user sees feedback in ~1.5s instead of waiting for the
        // next shared tick boundary.
        window.setTimeout(async () => {
          await fetchAgentActive()
          applyActiveClasses()
        }, 1500)
        // Brief done state, then reset so the user can re-trigger
        window.setTimeout(() => {
          reviewBtn.classList.remove('done')
          reviewBtn.disabled = false
        }, 2500)
      } catch (err) {
        reviewBtn.classList.remove('running')
        reviewBtn.disabled = false
        reviewBtn.innerHTML = PR_REVIEW_PLAY_SVG
        console.error('PR review trigger failed:', err)
        alert(`Could not start review: ${(err as Error).message}`)
      }
      return
    }

    const delBtn = target.closest<HTMLElement>('.card-delete')
    if (delBtn) {
      e.stopPropagation()
      const cardEl = delBtn.closest<HTMLElement>('.card')!
      const id = Number(cardEl.dataset.id)
      try { await deleteManualCard(id) } catch (err) { console.error(err) }
      return
    }
    const cardEl = target.closest<HTMLElement>('.card')
    if (!cardEl) return
    if (cardEl.classList.contains('card-live')) return     // links handle navigation
    if (cardEl.classList.contains('editing')) return
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
    startEdit(cardEl)
  })
}

// ── Filters ─────────────────────────────────────────────────────────────────

function attachFilterHandlers() {
  const timePicker = viewEl.querySelector<HTMLElement>('#current-time-picker')!
  timePicker.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.time) return
    const next = btn.dataset.time as TimeFilter
    if (next === timeFilter) return
    timeFilter = next
    timePicker.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    saveFilters()
    try { await fetchLive(); renderLiveOnly() } catch (err) { console.error(err) }
  })

  const statusBar = viewEl.querySelector<HTMLElement>('#current-status-filter')!
  statusBar.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.status) return
    const next = btn.dataset.status as StatusFilter
    if (next === statusFilter) return
    statusFilter = next
    statusBar.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    saveFilters()
    try { await fetchLive(); renderLiveOnly() } catch (err) { console.error(err) }
  })

  // Search — pure client-side filter over what's already loaded. Debounced
  // so typing doesn't thrash the renderer. Re-renders BOTH manual and live
  // lanes since search applies across the whole board.
  const searchEl = viewEl.querySelector<HTMLInputElement>('#current-search')!
  searchEl.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = searchEl.value.trim()
      if (next === searchQuery) return
      searchQuery = next
      renderAll()
    }, 90)
  })
}

// ── Init ────────────────────────────────────────────────────────────────────

export async function initCurrentView() {
  viewEl = document.getElementById('view-current')!
  if (!initialized) {
    initialized = true
    loadFilters()
    viewEl.innerHTML = renderShell()
    attachAddHandlers()
    attachDragHandlers()
    attachCardClickHandlers()
    attachFilterHandlers()
  }
  try {
    await Promise.all([fetchManual(), fetchLive(), fetchAllRepos(), fetchAgentActive()])
    renderAll()
    fetchPrStatus()                  // first PR-status pull, intentionally not awaited
  } catch (err) {
    console.error('[stream] failed to load:', err)
  }
  // Combined refresh at the user-chosen cadence (1m or 5m, from
  // Settings). Re-fetch live items + PR-status, re-render the live
  // lanes through the FLIP animator so cards glide to their new
  // updated_at order. Cancelled on view leave; restarted whenever the
  // rate changes.
  startLiveTimer()
}

function startLiveTimer() {
  if (liveListening) return
  window.addEventListener('poise:refresh-tick', onLiveTick)
  liveListening = true
}
