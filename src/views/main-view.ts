// Main table view — reads through /api/gh from the unified /github API.

import { midnightInZone, startOfWeekInZone } from '../config'

const STORAGE_KEY = 'poise-filters'
const REVIEWED_KEY = 'poise-reviewed'
const PAGE_SIZE = 20

const reviewed: Set<string> = new Set(
  (() => { try { return JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]') } catch { return [] } })()
)
function saveReviewed() { localStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])) }

// Reviews in flight, by pull-request URL. This guard used to be two statements
// on the button element — `disabled = true`, and a re-entry check reading it
// back. buildRow rebuilds that button from scratch with no notion of a review
// in progress, and three ordinary things clear the whole tbody: returning to
// Archive, clicking a filter pill, and typing in the search box. Any of them
// handed back an enabled, idle-looking play button while the review was still
// running, and the call has a two-minute budget. Confab posts its output back
// on the pull request, so a second click meant a second review posted for real
// on the same PR. The guard has to outlive the node.
const reviewing = new Set<string>()

const PLAY_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>'
const SPIN_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'

interface PrRow {
  repo: string
  number: number
  title: string
  html_url: string
  author: string
  is_pr: number
  state: string
  owner_login: string | null
  owner_avatar: string | null
  updated_at: string
  merged_at: string | null
}

type TypeFilter = 'both' | 'issue' | 'pr'
type StatusFilter = 'all' | 'open'
type TimeFilter = 'all' | 'today' | 'yesterday' | 'week'

let typeFilter: TypeFilter = 'both'
let statusFilter: StatusFilter = 'all'
let timeFilter: TimeFilter = 'all'
let searchQuery = ''
let items: PrRow[] = []
let offset = 0
let total = 0
let done = false
let fetching = false
let initialized = false
let observer: IntersectionObserver | null = null
let searchDebounce: ReturnType<typeof setTimeout> | null = null
// Tick listener installed when the view is initialized; removed via
// stopMainRefresh() when navigating away. Single shared clock — see
// startRefreshTicker() in src/config.ts.
const onTick = () => refreshMainSoft()
let tickListening = false

// DOM
let tbody: HTMLTableSectionElement
let loader: HTMLDivElement
let empty: HTMLParagraphElement
let table: HTMLTableElement
let clusterEl: HTMLElement
let timePickerEl: HTMLElement
let countEl: HTMLSpanElement
let searchInput: HTMLInputElement
let sentinel: HTMLDivElement
let loadErrorEl: HTMLElement | null = null

// #empty used to carry both "No results." and every fetch error. The error was
// written into it once and never cleared, so after a single failure every
// legitimately-empty view reported a stale error for the rest of the session.
// Errors get their own line; #empty goes back to meaning what it says.
function showLoadError(message: string): void {
  if (!loadErrorEl) loadErrorEl = document.getElementById('main-load-error')
  if (!loadErrorEl) return
  loadErrorEl.textContent = message
  loadErrorEl.hidden = !message
}

function loadFilters(): { type: TypeFilter; status: StatusFilter; time: TimeFilter } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        type: ['both', 'issue', 'pr'].includes(parsed.type) ? parsed.type : 'both',
        status: ['all', 'open'].includes(parsed.status) ? parsed.status : 'all',
        time: ['all', 'today', 'yesterday', 'week'].includes(parsed.time) ? parsed.time : 'all',
      }
    }
  } catch { /* ignore */ }
  return { type: 'both', status: 'all', time: 'all' }
}

function saveFilters() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: typeFilter, status: statusFilter, time: timeFilter }))
}

function timeWindow(): { since?: string; until?: string } {
  if (timeFilter === 'today') {
    return { since: midnightInZone(0).toISOString() }
  }
  if (timeFilter === 'yesterday') {
    return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
  }
  if (timeFilter === 'week') {
    return { since: startOfWeekInZone().toISOString() }
  }
  return {}
}

// The same s/m/h/d/mo/y vocabulary the other views use. This was a drifted
// copy that collapsed everything under a day to the word "today" — which read
// as wrong next to the Yesterday pill (a row updated at 00:30 today is
// "today", but so was one from 23 hours ago), and told you nothing about how
// recent a row actually was.
function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return '—'
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

// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >; we also need to escape " and ' so attribute interpolations
// like `title="${escapeHtml(text)}"` don't break on quoted content.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? escapeHtml(url.href) : '#'
  } catch {
    return '#'
  }
}

function stateLabel(item: PrRow): { text: string; cls: string } {
  if (item.is_pr === 1 && item.merged_at) return { text: 'Merged', cls: 'merged' }
  return item.state === 'open' ? { text: 'Open', cls: 'open' } : { text: 'Closed', cls: 'closed' }
}

function humanAvatarFallback(username: string): string {
  // Only works for real user accounts (not GitHub Apps). Used if we don't have the
  // API-reported avatar_url stored yet.
  return `https://github.com/${encodeURIComponent(username)}.png?size=48`
}

// Populated only when the pull request has an assignee — 7 of 400 rows in the
// current cache. The dash is honest, but it is worth saying which kind of
// absence it is rather than leaving it to be read as missing data.
function ownerCell(item: PrRow): string {
  const name = item.owner_login
  if (!name) return '<span class="last-dash" title="No assignee">—</span>'
  const isBot = /\[bot\]$/i.test(name)
  const src = item.owner_avatar && item.owner_avatar.length > 0 ? item.owner_avatar : humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${safeHttpsUrl(src)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />`
}

// The column this fills was headed "Last", which reads as "who acted last".
// There is no such field in the record — this is the author, and it always was
// (every one of the 400 sampled rows has one). The header now says Author, so
// the column and its contents agree.
function lastCell(item: PrRow): string {
  const name = item.author
  if (!name) return '<span class="last-dash">\u2014</span>'

  const isBot = /\[bot\]$/i.test(name)
  const src = humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${safeHttpsUrl(src)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />`
}

// Stable identity for a row across refreshes. Matches the format Current
// uses for live items so the FLIP path captures the same kind of key.
function rowKey(item: PrRow): string {
  return `${item.repo}#${item.number}`
}

// A settled pull request is not a review target. The button was rendered armed
// on every PR row — `stateLabel(item)` was computed on the line above it and
// never consulted — and Archive defaults to "Any" status, so merged and closed
// work fills the default view. Clicking one dispatched a full consensus review
// and had Confab post its output back on a pull request that shipped weeks
// ago. Current was changed for exactly this case; Archive never was.
//
// The in-flight state is rendered from `reviewing`, not left on the node, so a
// running review still reads as running after the table is rebuilt.
function reviewButtonHtml(item: PrRow, st: { text: string; cls: string }): string {
  const settled = st.cls === 'merged' || st.cls === 'closed'
  if (settled) {
    return `<button class="review-btn" disabled aria-label="Run consensus review (unavailable)"`
      + ` title="This pull request is ${st.text.toLowerCase()} — nothing to review">${PLAY_SVG}</button>`
  }
  const busy = reviewing.has(item.html_url)
  if (busy) {
    return `<button class="review-btn running" disabled aria-label="Consensus review running"`
      + ` title="Consensus review running…">${SPIN_SVG}</button>`
  }
  const isDone = reviewed.has(item.html_url)
  return `<button class="review-btn${isDone ? ' done' : ''}" aria-label="Run consensus review"`
    + ` title="${isDone ? 'Reviewed — run again' : 'Run consensus review'}">${PLAY_SVG}</button>`
}

function buildRow(item: PrRow, animate: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr')
  if (animate) tr.className = 'new'
  tr.dataset.key = rowKey(item)
  paintRow(tr, item)
  return tr
}

// Repaint an existing row from current data. The FLIP moved rows without ever
// touching their contents, so a pull request that merged since the first paint
// slid to a new position still showing "Open" and its original timestamp — the
// movement said something had changed and every cell said nothing had.
function paintRow(tr: HTMLTableRowElement, item: PrRow): void {
  const pr = item.is_pr === 1
  const st = stateLabel(item)
  const actionHtml = pr ? reviewButtonHtml(item, st) : ''

  tr.innerHTML = `
    <td><span class="type-toggle ${pr ? 'pr' : 'issue'}">${pr ? 'PR' : 'IS'}</span></td>
    <td class="title-cell"><a href="${safeHttpsUrl(item.html_url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></td>
    <td class="last-cell">${lastCell(item)}</td>
    <td><span class="repo-name">${escapeHtml(item.repo)}</span></td>
    <td class="last-cell">${ownerCell(item)}</td>
    <td><span class="state ${st.cls}">${st.text}</span></td>
    <td><span class="date">${relativeDate(item.updated_at)}</span></td>
    <td class="action-cell">${actionHtml}</td>
  `
}

function updateCount() {
  countEl.textContent = total > 0 ? `${Math.min(items.length, total)} / ${total}` : ''
}

function renderAll() {
  tbody.innerHTML = ''
  if (items.length === 0 && !fetching) {
    table.hidden = true
    // "Nothing here" and "a filter hid everything" looked identical, and the
    // filters persist across reloads — so a sticky filter from a previous
    // session presented as an empty archive.
    const filtered = !!searchQuery || typeFilter !== 'both'
      || statusFilter !== 'all' || timeFilter !== 'all'
    empty.textContent = filtered
      ? 'No results for the current filters.'
      : 'No results.'
    empty.hidden = false
    updateCount()
    return
  }
  table.hidden = false
  empty.hidden = true
  for (const item of items) {
    tbody.appendChild(buildRow(item, false))
  }
  updateCount()
}

function appendRows(newItems: PrRow[]) {
  table.hidden = false
  empty.hidden = true
  // Batch append in a fragment to reduce reflows
  const frag = document.createDocumentFragment()
  for (let i = 0; i < newItems.length; i++) {
    const tr = buildRow(newItems[i], true)
    // Tighter stagger (max 10 steps), capped at 80ms total
    tr.style.animationDelay = `${Math.min(i, 10) * 8}ms`
    frag.appendChild(tr)
  }
  tbody.appendChild(frag)
  updateCount()
}

// FLIP — same pattern Current uses for its live lanes. Reorders existing
// rows in place via inverse-transform-then-animate-back so the user sees
// the table settling into its new sort order rather than a cold rebuild.
// Existing <tr> nodes are MOVED via fragment, never replaced — that
// preserves expanded inline comments, hover state, and any in-flight
// review buttons. Only newly-arriving rows get fresh DOM with .new for
// the fade-in. Rows that left silently disappear.
const FLIP_MS = 700

function applyMainFlip(nextItems: PrRow[]) {
  // 1. First — capture rects of all existing rows.
  const firstRects = new Map<string, DOMRect>()
  const existingEls = new Map<string, HTMLTableRowElement>()
  for (const el of [...tbody.children] as HTMLTableRowElement[]) {
    const k = el.dataset.key
    if (!k) continue
    firstRects.set(k, el.getBoundingClientRect())
    existingEls.set(k, el)
  }

  // 2. Last — drop departed rows, then reorder/insert into a fragment.
  const newKeys = new Set(nextItems.map(rowKey))
  for (const [k, el] of existingEls) {
    if (!newKeys.has(k)) el.remove()
  }
  const fragment = document.createDocumentFragment()
  for (const item of nextItems) {
    const k = rowKey(item)
    const existing = existingEls.get(k)
    if (existing) {
      // Refresh the contents before reusing it — the element identity is what
      // the FLIP needs, not its stale cells.
      paintRow(existing, item)
      fragment.appendChild(existing)         // moved to its new position
    } else {
      fragment.appendChild(buildRow(item, true))   // .new for fade-in
    }
  }
  tbody.appendChild(fragment)

  // 3. Invert — for every row that existed before AND after, apply the
  //    inverse translateY so it visually stays where it was.
  const movers: HTMLTableRowElement[] = []
  for (const item of nextItems) {
    const k = rowKey(item)
    const cardEl = existingEls.get(k)
    if (!cardEl) continue
    const firstRect = firstRects.get(k)
    if (!firstRect) continue
    const lastRect = cardEl.getBoundingClientRect()
    const dy = firstRect.top - lastRect.top
    if (Math.abs(dy) < 0.5) continue
    cardEl.style.transition = 'none'
    cardEl.style.transform = `translateY(${dy}px)`
    movers.push(cardEl)
  }

  // 4. Play — flush layout, then animate transform back to identity.
  if (movers.length > 0) {
    void tbody.offsetHeight
    requestAnimationFrame(() => {
      for (const cardEl of movers) {
        cardEl.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`
        cardEl.style.transform = ''
      }
      window.setTimeout(() => {
        for (const cardEl of movers) {
          cardEl.style.transition = ''
          cardEl.style.transform = ''
        }
      }, FLIP_MS + 50)
    })
  }
}

function sentinelNeedsFetch(): boolean {
  if (!sentinel || done) return false
  const rect = sentinel.getBoundingClientRect()
  // Match observer's rootMargin: fire if sentinel is within 400px of viewport bottom
  return rect.top < window.innerHeight + 400
}

// Subset of the /api/gh record shape used by Archive. The proxy keeps
// the legacy envelope; we only pluck what the table needs.
interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string                      // "Vaquum/foo"
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  updated_at: string
  author: string
  merged_at: string | null
  owner_login: string | null
  owner_avatar: string | null
}

function recordToRow(r: GhRecord): PrRow {
  const shortRepo = r.repo.includes('/') ? r.repo.split('/', 2)[1] : r.repo
  return {
    repo: shortRepo,
    number: r.number,
    title: r.title,
    html_url: r.url,
    author: r.author,
    is_pr: r.kind === 'pr' ? 1 : 0,
    state: r.state === 'merged' ? 'closed' : r.state,   // collapse to open/closed; merged_at distinguishes
    owner_login: r.owner_login,
    owner_avatar: r.owner_avatar,
    updated_at: r.updated_at,
    merged_at: r.merged_at,
  }
}

function buildListPayload(): Record<string, unknown> {
  const win = timeWindow()
  const payload: Record<string, unknown> = {
    operation: 'list',
    record_type: typeFilter === 'both' ? 'all' : (typeFilter === 'pr' ? 'pull_request' : 'issue'),
    record_state: statusFilter === 'open' ? 'open' : 'all',
    limit: PAGE_SIZE,
    offset,
  }
  if (win.since)    payload.updated_since = win.since
  if (win.until)    payload.updated_until = win.until
  if (searchQuery)  payload.q = searchQuery
  return payload
}

// Every reset — a filter pill, a search keystroke — starts a new query. A page
// already on the wire belongs to the old one, and `resetAndFetch` only cleared
// the `fetching` flag without cancelling it, so its rows were appended into the
// new query's list and its `total` overwrote the new count. Round trips here
// run to several seconds, so this was routine rather than rare.
let queryGeneration = 0

// A page fetch that fails used to fall straight into the rAF chain below,
// which re-fired immediately because the sentinel was still in view and no
// rows had been added — an unbounded, backoff-free retry loop that also kept
// running after the view was left. Back off instead, and stop after a few
// attempts rather than hammering a datastore that is plainly down.
let consecutiveFailures = 0
const MAX_RETRIES = 4
let retryTimer: ReturnType<typeof setTimeout> | null = null

function cancelPendingRetry(): void {
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
}

async function fetchPage(): Promise<void> {
  if (done || fetching) return
  const mine = queryGeneration
  fetching = true
  loader.hidden = false
  try {
    const payload = buildListPayload()
    const [pageRes, countRes] = await Promise.all([
      fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      // Total count is a separate call so the page payload doesn't carry it.
      // count_only ignores limit/offset — it returns the size of the full
      // filtered set so the "20 / 1083" pill stays honest as the user pages.
      fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, count_only: true, limit: undefined, offset: undefined }),
      }),
    ])
    if (!pageRes.ok) throw new Error(`Github ${pageRes.status}`)
    const pageData  = await pageRes.json()
    // The count is a separate request and only feeds the "20 / 1083" pill.
    // Failing the whole page on it threw away rows that had arrived perfectly
    // well; the page is the thing the person came for.
    const countData = countRes.ok ? await countRes.json().catch(() => ({})) : {}
    // The filters moved while this was out; these rows answer a question
    // nobody is asking any more.
    if (mine !== queryGeneration) return
    const newItems: PrRow[] = (pageData.records as GhRecord[] || []).map(recordToRow)
    total = typeof countData.count === 'number' ? countData.count : items.length + newItems.length
    items.push(...newItems)
    offset += newItems.length
    if (newItems.length < PAGE_SIZE || items.length >= total) done = true

    consecutiveFailures = 0
    showLoadError('')
    loader.hidden = done
    appendRows(newItems)
  } catch (err) {
    if (mine !== queryGeneration) return
    loader.hidden = true
    consecutiveFailures++
    showLoadError(`Could not load: ${(err as Error).message}`)
    if (consecutiveFailures <= MAX_RETRIES) {
      const delay = Math.min(30_000, 1000 * 2 ** (consecutiveFailures - 1))
      cancelPendingRetry()
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (mine === queryGeneration && !done) void fetchPage()
      }, delay)
    }
  } finally {
    if (mine === queryGeneration) fetching = false
  }

  // IntersectionObserver only fires on *state change*. If the sentinel is still
  // in view after this fetch (common when the batch doesn't fill the viewport),
  // the observer won't re-fire. Chain the next fetch manually.
  // Only chain when the last attempt actually succeeded — chaining after a
  // failure is what produced the retry loop.
  if (!done && consecutiveFailures === 0 && mine === queryGeneration) {
    requestAnimationFrame(() => {
      if (mine === queryGeneration && sentinelNeedsFetch()) fetchPage()
    })
  }
}

function resetAndFetch() {
  // Retire whatever is on the wire: its rows belong to the previous query.
  queryGeneration++
  cancelPendingRetry()
  consecutiveFailures = 0
  items = []
  offset = 0
  total = 0
  done = false
  fetching = false
  tbody.innerHTML = ''
  countEl.textContent = ''
  showLoadError('')
  fetchPage()
}

// `active` is a class, which tells a screen reader nothing about which filter
// is applied. aria-pressed is set alongside it everywhere the class is.
function setPillActive(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle('active', on)
  b.setAttribute('aria-pressed', String(on))
}

function initFilterButtons() {
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => {
    setPillActive(b, b.dataset.filter === typeFilter)
  })
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => {
    setPillActive(b, b.dataset.status === statusFilter)
  })
  timePickerEl.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => {
    setPillActive(b, b.dataset.time === timeFilter)
  })
}

function attachHandlers() {
  // All filter pills live in one cluster now — single delegated click handler
  clusterEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn) return
    if (btn.dataset.filter) {
      const next = btn.dataset.filter as TypeFilter
      if (next === typeFilter) return
      typeFilter = next
      clusterEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => setPillActive(b, false))
      setPillActive(btn, true)
      saveFilters()
      resetAndFetch()
    }
    if (btn.dataset.status) {
      const next = btn.dataset.status as StatusFilter
      if (next === statusFilter) return
      statusFilter = next
      clusterEl.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => setPillActive(b, false))
      setPillActive(btn, true)
      saveFilters()
      resetAndFetch()
    }
    if (btn.dataset.time) {
      const next = btn.dataset.time as TimeFilter
      if (next === timeFilter) return
      timeFilter = next
      clusterEl.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      saveFilters()
      resetAndFetch()
    }
  })

  // Search — debounced live filter; resets pagination because the server
  // applies the LIKE query and re-counts the result set.
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = searchInput.value.trim()
      if (next === searchQuery) return
      searchQuery = next
      resetAndFetch()
    }, 150)
  })

  // Consensus review — Confab does the work and any side effects (e.g.
  // posting a comment back on the PR). Poise just kicks it off and
  // marks the row as reviewed when Confab returns OK.
  tbody.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.review-btn')
    if (!btn) return
    if ((btn as HTMLButtonElement).disabled) return
    const row = btn.closest('tr')!
    const key = row.dataset.key
    const item = items.find((i) => rowKey(i) === key)
    if (!item || item.is_pr !== 1) return
    // Re-check the target against current data rather than trusting the row
    // that was painted: a refresh can land between deciding and clicking, and
    // this dispatches a review that posts on a real pull request.
    const st = stateLabel(item)
    if (st.cls === 'merged' || st.cls === 'closed') return
    if (reviewing.has(item.html_url)) return
    reviewing.add(item.html_url)
    repaintReviewButton(item)
    try {
      const reviewRes = await fetch('/api/confab/review/pr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.html_url }),
      })
      if (!reviewRes.ok) {
        const detail = await reviewRes.text().catch(() => '')
        throw new Error(detail
          ? `${reviewRes.status}: ${detail.slice(0, 200)}`
          : `Review API ${reviewRes.status}`)
      }
      reviewed.add(item.html_url)
      saveReviewed()
    } catch (err) {
      console.error('Review failed:', err)
      alert(`Review failed: ${(err as Error).message}`)
    } finally {
      reviewing.delete(item.html_url)
      // The button that was clicked may be long gone — the table is rebuilt by
      // a filter, a search keystroke or a return to this view. Repaint
      // whichever node is attached now, so the outcome is actually visible.
      repaintReviewButton(item)
    }
  })
}

// Repaint one row's review button from current state, wherever it now lives.
function repaintReviewButton(item: PrRow): void {
  const row = tbody?.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(rowKey(item))}"]`)
  const cell = row?.querySelector<HTMLElement>('.action-cell')
  if (!cell) return
  // Replacing the node drops focus to <body>, so a keyboard user who activated
  // this button lands nowhere and has to tab back from the top of the table.
  const hadFocus = cell.contains(document.activeElement)
  cell.innerHTML = reviewButtonHtml(item, stateLabel(item))
  if (hadFocus) {
    const next = cell.querySelector<HTMLButtonElement>('.review-btn')
    if (next && !next.disabled) next.focus()
    else row?.querySelector<HTMLAnchorElement>('.title-cell a')?.focus()
  }
}

export function initMainView() {
  // Re-entry has to re-attach the tick. Leaving the view now removes the
  // listener (it never did before, which is why this early return could get
  // away with skipping startMainTimer), so without this Archive would refresh
  // on its first visit of a session and never again.
  if (initialized) { renderAll(); startMainTimer(); return }
  initialized = true

  tbody = document.getElementById('tbody') as HTMLTableSectionElement
  loader = document.getElementById('loader') as HTMLDivElement
  empty = document.getElementById('empty') as HTMLParagraphElement
  table = document.getElementById('table') as HTMLTableElement
  clusterEl = document.getElementById('main-filters') as HTMLElement
  timePickerEl = document.getElementById('time-picker') as HTMLElement
  searchInput = document.getElementById('search-input') as HTMLInputElement
  countEl = document.getElementById('count') as HTMLSpanElement

  const saved = loadFilters()
  typeFilter = saved.type
  statusFilter = saved.status
  timeFilter = saved.time

  initFilterButtons()
  attachHandlers()

  // Sentinel for infinite scroll
  sentinel = document.createElement('div')
  sentinel.id = 'main-sentinel'
  table.parentElement!.appendChild(sentinel)
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !done && !fetching) fetchPage()
  }, { rootMargin: '400px' })
  observer.observe(sentinel)

  fetchPage()
  startMainTimer()
}

// Background refresh at the user-chosen cadence (1m or 5m). Pulls page 1
// only — the visible top of the table — and stitches it onto the tail of
// what's already loaded so scroll position is preserved and the user
// doesn't watch the table empty out and rebuild. Existing rows glide to
// their new positions through the FLIP animator; new rows fade in;
// expanded inline comments and other in-row state survive.
async function refreshMainSoft() {
  if (!initialized || fetching) return
  // The guard was read here and never set, so a tick and a scroll-triggered
  // page fetch could run at once and interleave their writes to `items`.
  const mine = queryGeneration
  fetching = true
  try {
    const win = timeWindow()
    const payload: Record<string, unknown> = {
      operation: 'list',
      record_type: typeFilter === 'both' ? 'all' : (typeFilter === 'pr' ? 'pull_request' : 'issue'),
      record_state: statusFilter === 'open' ? 'open' : 'all',
      limit: PAGE_SIZE,
      offset: 0,
    }
    if (win.since)   payload.updated_since = win.since
    if (win.until)   payload.updated_until = win.until
    if (searchQuery) payload.q = searchQuery

    const [pageRes, countRes] = await Promise.all([
      fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, count_only: true, limit: undefined, offset: undefined }),
      }),
    ])
    // A bare `return` here left an HTTP failure of the background refresh
    // silent, which is the case that most needs saying.
    if (!pageRes.ok)  throw new Error(`Github ${pageRes.status}`)
    if (!countRes.ok) throw new Error(`Github ${countRes.status}`)
    if (mine !== queryGeneration) return
    const pageData  = await pageRes.json()
    const countData = await countRes.json()
    const newTop: PrRow[] = (pageData.records as GhRecord[] || []).map(recordToRow)

    // Stitch: the refreshed top, then every row already held that is not in
    // it, in the order they were already in. The tail used to be taken from
    // `items.slice(PAGE_SIZE)`, which threw away any row that had been inside
    // the old top-20 but was pushed out of the new one — it vanished from the
    // table, and paging could later fetch it again as a duplicate.
    const newKeyset = new Set(newTop.map(rowKey))
    const tail = items.filter((i) => !newKeyset.has(rowKey(i)))
    const next = [...newTop, ...tail]

    total = typeof countData.count === 'number' ? countData.count : next.length
    items = next
    offset = items.length
    const wasDone = done
    done = items.length >= total
    loader.hidden = done
    // When a refresh reopens paging — new rows arrived, so there is more to
    // load again — the IntersectionObserver does not re-fire on its own: it
    // reports state changes, and the sentinel never left the viewport. Without
    // a nudge the loader spins forever and scrolling loads nothing.
    if (wasDone && !done) {
      requestAnimationFrame(() => {
        if (mine === queryGeneration && sentinelNeedsFetch()) void fetchPage()
      })
    }

    if (next.length === 0) {
      tbody.innerHTML = ''
      table.hidden = true
      empty.hidden = false
    } else {
      table.hidden = false
      empty.hidden = true
      applyMainFlip(next)
    }
    updateCount()
    showLoadError('')
  } catch (err) {
    // A failing background refresh was completely invisible once the table had
    // rows: it froze on the last good page while the relative times kept
    // counting up, so a dead datastore read as a live one.
    if (mine === queryGeneration) showLoadError(`Not updating — ${(err as Error).message}`)
  } finally {
    if (mine === queryGeneration) fetching = false
  }
}

// Called by the idle timer at the user-chosen cadence (1m / 5m).
// Soft-refreshes the visible top so the table updates feel like a
// settling rather than a cold rebuild. Filter / search changes still go
// through resetAndFetch (which clears + refetches) because the user
// initiated the change and expects a hard reset.
export function refreshMainView() {
  if (!initialized) return
  refreshMainSoft()
}

export function stopMainRefresh() {
  if (tickListening) {
    window.removeEventListener('poise:refresh-tick', onTick)
    tickListening = false
  }
  // A scheduled retry outlives the view otherwise, and keeps asking a
  // datastore nobody is looking at.
  cancelPendingRetry()
}

function startMainTimer() {
  if (tickListening) return
  window.addEventListener('poise:refresh-tick', onTick)
  tickListening = true
}
