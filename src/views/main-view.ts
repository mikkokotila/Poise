// Main table view — reads from SQLite cache (/api/cache/prs)

import { getSettings, midnightInZone, startOfWeekInZone, getRefreshRateMs } from '../config'

const STORAGE_KEY = 'poise-filters'
const REVIEWED_KEY = 'poise-reviewed'
const PAGE_SIZE = 20

const reviewed: Set<string> = new Set(
  (() => { try { return JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]') } catch { return [] } })()
)
function saveReviewed() { localStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])) }

const PLAY_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>'
const SPIN_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'

interface PrRow {
  id: number
  repo: string
  number: number
  title: string
  html_url: string
  author: string
  author_avatar: string | null
  is_pr: number
  state: string
  status: string | null
  owner_login: string | null
  owner_avatar: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  comments_count: number
  last_commenter: string | null
  last_commenter_avatar: string | null
  last_comment_body: string | null
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
let refreshTimer: ReturnType<typeof setInterval> | null = null

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

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return '1d'
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

function stateLabel(item: PrRow): { text: string; cls: string } {
  if (item.is_pr === 1 && item.merged_at) return { text: 'Merged', cls: 'merged' }
  return item.state === 'open' ? { text: 'Open', cls: 'open' } : { text: 'Closed', cls: 'closed' }
}

function statusLabel(item: PrRow): { text: string; cls: string } {
  const s = item.status || 'IN REVIEW'
  if (s === 'ALLOCATED') return { text: 'Allocated', cls: 'allocated' }
  if (s === 'BUILDING')  return { text: 'Building',  cls: 'building' }
  return { text: 'In review', cls: 'review' }
}

function humanAvatarFallback(username: string): string {
  // Only works for real user accounts (not GitHub Apps). Used if we don't have the
  // API-reported avatar_url stored yet.
  return `https://github.com/${encodeURIComponent(username)}.png?size=48`
}

function ownerCell(item: PrRow): string {
  const name = item.owner_login
  if (!name) return '<span class="last-dash">—</span>'
  const isBot = /\[bot\]$/i.test(name)
  const src = item.owner_avatar && item.owner_avatar.length > 0 ? item.owner_avatar : humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${src}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />`
}

function lastCell(item: PrRow): string {
  // The "last" person on this thread. If nobody has commented yet, the original
  // author is the most recent voice — fall through to them so we never show a dash.
  let name = item.last_commenter
  let avatar = item.last_commenter_avatar
  if (!name) {
    name = item.author
    avatar = item.author_avatar
  }
  if (!name) return '<span class="last-dash">\u2014</span>'

  const isBot = /\[bot\]$/i.test(name)
  const src = avatar && avatar.length > 0 ? avatar : humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${src}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />`
}

function buildRow(item: PrRow, animate: boolean, idx: number): HTMLTableRowElement {
  const tr = document.createElement('tr')
  if (animate) tr.className = 'new'
  tr.dataset.idx = String(idx)
  const pr = item.is_pr === 1
  const st = stateLabel(item)
  const status = statusLabel(item)
  const isDone = reviewed.has(item.html_url)
  const actionHtml = pr
    ? `<button class="review-btn${isDone ? ' done' : ''}" data-idx="${idx}" title="Run consensus review">${PLAY_SVG}</button>`
    : ''

  tr.innerHTML = `
    <td><span class="type-toggle ${pr ? 'pr' : 'issue'}" data-idx="${idx}">${pr ? 'PR' : 'IS'}</span></td>
    <td class="title-cell"><a href="${item.html_url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></td>
    <td class="last-cell">${lastCell(item)}</td>
    <td><span class="repo-name">${escapeHtml(item.repo)}</span></td>
    <td><span class="status ${status.cls}">${status.text}</span></td>
    <td class="last-cell">${ownerCell(item)}</td>
    <td><span class="state ${st.cls}">${st.text}</span></td>
    <td><span class="date">${relativeDate(item.updated_at)}</span></td>
    <td class="action-cell">${actionHtml}</td>
  `
  return tr
}

function updateCount() {
  countEl.textContent = total > 0 ? `${Math.min(items.length, total)} / ${total}` : ''
}

function renderAll() {
  tbody.innerHTML = ''
  if (items.length === 0 && !fetching) {
    table.hidden = true
    empty.hidden = false
    updateCount()
    return
  }
  table.hidden = false
  empty.hidden = true
  for (let i = 0; i < items.length; i++) {
    tbody.appendChild(buildRow(items[i], false, i))
  }
  updateCount()
}

function appendRows(newItems: PrRow[], startIdx: number) {
  table.hidden = false
  empty.hidden = true
  // Batch append in a fragment to reduce reflows
  const frag = document.createDocumentFragment()
  for (let i = 0; i < newItems.length; i++) {
    const tr = buildRow(newItems[i], true, startIdx + i)
    // Tighter stagger (max 10 steps), capped at 80ms total
    tr.style.animationDelay = `${Math.min(i, 10) * 8}ms`
    frag.appendChild(tr)
  }
  tbody.appendChild(frag)
  updateCount()
}

function sentinelNeedsFetch(): boolean {
  if (!sentinel || done) return false
  const rect = sentinel.getBoundingClientRect()
  // Match observer's rootMargin: fire if sentinel is within 400px of viewport bottom
  return rect.top < window.innerHeight + 400
}

async function fetchPage(): Promise<void> {
  if (done || fetching) return
  fetching = true
  loader.hidden = false
  try {
    const win = timeWindow()
    const params = new URLSearchParams({
      type: typeFilter,
      status: statusFilter,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (win.since) params.set('since', win.since)
    if (win.until) params.set('until', win.until)
    if (searchQuery) params.set('q', searchQuery)
    const url = `/api/cache/prs?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Cache ${res.status}`)
    const data = await res.json()
    const newItems: PrRow[] = data.items
    total = data.total
    const startIdx = items.length
    items.push(...newItems)
    offset += newItems.length
    if (newItems.length < PAGE_SIZE || items.length >= total) done = true

    loader.hidden = done
    appendRows(newItems, startIdx)
  } catch (err) {
    loader.hidden = true
    empty.textContent = `Error: ${(err as Error).message}`
    empty.hidden = false
  } finally {
    fetching = false
  }

  // IntersectionObserver only fires on *state change*. If the sentinel is still
  // in view after this fetch (common when the batch doesn't fill the viewport),
  // the observer won't re-fire. Chain the next fetch manually.
  if (!done) {
    requestAnimationFrame(() => {
      if (sentinelNeedsFetch()) fetchPage()
    })
  }
}

function resetAndFetch() {
  items = []
  offset = 0
  total = 0
  done = false
  fetching = false
  tbody.innerHTML = ''
  countEl.textContent = ''
  fetchPage()
}

function initFilterButtons() {
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === typeFilter)
  })
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === statusFilter)
  })
  timePickerEl.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => {
    b.classList.toggle('active', b.dataset.time === timeFilter)
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
      clusterEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      saveFilters()
      resetAndFetch()
    }
    if (btn.dataset.status) {
      const next = btn.dataset.status as StatusFilter
      if (next === statusFilter) return
      statusFilter = next
      clusterEl.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
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

  // Expand/collapse last comment (already cached — no fetch!)
  tbody.addEventListener('click', (e) => {
    const toggle = (e.target as HTMLElement).closest('.type-toggle')
    if (!toggle) return
    const idx = Number((toggle as HTMLElement).dataset.idx)
    const item = items[idx]
    if (!item) return
    const row = toggle.closest('tr')!
    const titleCell = row.querySelector('.title-cell')!
    const existing = titleCell.querySelector('.inline-comment')
    if (existing) {
      existing.classList.add('closing')
      existing.addEventListener('animationend', () => existing.remove(), { once: true })
      row.classList.remove('expanded')
      return
    }
    row.classList.add('expanded')
    const wrapper = document.createElement('div')
    wrapper.className = 'inline-comment'

    const commenter = item.last_commenter || ''
    const me = (getSettings().me || '').toLowerCase()
    const isMe = !!me && commenter.toLowerCase() === me
    const nameHtml = commenter
      ? `<span class="comment-author ${isMe ? 'is-me' : ''}">${escapeHtml(commenter)}</span> `
      : ''

    if (item.last_comment_body) {
      wrapper.innerHTML = `${nameHtml}${escapeHtml(item.last_comment_body)}`
    } else {
      wrapper.innerHTML = '<span class="comment-none">no comments</span>'
    }
    titleCell.appendChild(wrapper)
  })

  // Consensus review
  tbody.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.review-btn')
    if (!btn) return
    if ((btn as HTMLButtonElement).disabled) return
    const idx = Number((btn as HTMLElement).dataset.idx)
    const item = items[idx]
    if (!item || item.is_pr !== 1) return
    const button = btn as HTMLButtonElement
    button.disabled = true
    button.innerHTML = SPIN_SVG
    button.classList.add('running')
    try {
      const reviewRes = await fetch('/api/confab/review/pr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.html_url }),
      })
      if (!reviewRes.ok) throw new Error(`Review API ${reviewRes.status}`)
      const reviewData = await reviewRes.json()
      const synthesis: string = reviewData.synthesis
      const org = getSettings().org
      if (!org) throw new Error('Org not configured')
      const commentRes = await fetch(`/api/github/repos/${org}/${item.repo}/issues/${item.number}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: synthesis }),
      })
      if (!commentRes.ok) throw new Error(`GitHub comment ${commentRes.status}`)
      reviewed.add(item.html_url)
      saveReviewed()
      button.innerHTML = PLAY_SVG
      button.classList.remove('running')
      button.classList.add('done')
      button.disabled = false
    } catch (err) {
      button.innerHTML = PLAY_SVG
      button.classList.remove('running')
      button.disabled = false
      console.error('Review failed:', err)
      alert(`Review failed: ${(err as Error).message}`)
    }
  })
}

export function initMainView() {
  if (initialized) { renderAll(); return }
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

// Called by idle refresh
export function refreshMainView() {
  if (!initialized) return
  resetAndFetch()
}

// Background refresh at the user-chosen cadence (1m or 5m). Pulls page 1
// only — the visible top of the table — so scroll position is preserved
// for users who are reading something further down. The total count
// updates so the "20 / 1083" pill stays honest.
export function stopMainRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

function startMainTimer() {
  stopMainRefresh()
  refreshTimer = setInterval(refreshMainView, getRefreshRateMs())
}

window.addEventListener('poise:refresh-rate-changed', () => {
  if (refreshTimer) startMainTimer()
})
