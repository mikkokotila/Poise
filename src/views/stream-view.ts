// Stream — five-lane kanban that mixes free-form thinking with live GitHub
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
  created_at: string
  updated_at: string
}

interface LiveItem {
  id: number
  repo: string
  number: number
  title: string
  html_url: string
  is_pr: 0 | 1
  state: string                    // 'open' | 'closed'
  merged_at: string | null
  updated_at: string
}

type TimeFilter = 'all' | 'today' | 'yesterday' | 'week'
type StatusFilter = 'all' | 'open'

const FILTER_KEY = 'poise-stream-filters'
const LIVE_LIMIT = 200            // upper bound; time / status filters narrow further

let initialized = false
let manualCards: ManualCard[] = []
let liveItems: LiveItem[] = []
let dragId: number | null = null
let viewEl: HTMLElement
let timeFilter: TimeFilter = 'all'
let statusFilter: StatusFilter = 'all'

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
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

function manualInLane(lane: 'idea' | 'concept' | 'plan'): ManualCard[] {
  return manualCards.filter((c) => c.lane === lane).sort((a, b) => a.position - b.position)
}

function timeWindow(): { since?: string; until?: string } {
  if (timeFilter === 'today')     return { since: midnightInZone(0).toISOString() }
  if (timeFilter === 'yesterday') return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
  if (timeFilter === 'week')      return { since: startOfWeekInZone().toISOString() }
  return {}
}

function liveInLane(lane: 'issue' | 'pr'): LiveItem[] {
  const isPr = lane === 'pr' ? 1 : 0
  // Items already arrive filtered server-side — just split by type
  return liveItems.filter((i) => i.is_pr === isPr)
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

function liveStateLabel(item: LiveItem): { text: string; cls: string } {
  if (item.is_pr === 1 && item.merged_at) return { text: 'merged', cls: 'merged' }
  return item.state === 'open' ? { text: 'open', cls: 'open' } : { text: 'closed', cls: 'closed' }
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
      <div class="view-title">Stream <span class="view-sub" id="stream-sub">my involvement</span></div>
      <div class="range-picker" id="stream-time-picker">
        <button data-time="all" class="${timeFilter === 'all' ? 'active' : ''}">Any time</button>
        <button data-time="today" class="${timeFilter === 'today' ? 'active' : ''}">Today</button>
        <button data-time="yesterday" class="${timeFilter === 'yesterday' ? 'active' : ''}">Yesterday</button>
        <button data-time="week" class="${timeFilter === 'week' ? 'active' : ''}">This week</button>
      </div>
    </header>
    <nav id="stream-status-filter" class="stream-filters">
      <button data-status="all" class="${statusFilter === 'all' ? 'active' : ''}">Any</button>
      <button data-status="open" class="${statusFilter === 'open' ? 'active' : ''}">Open</button>
      <span class="stream-filters-note">Issue + PR lanes</span>
    </nav>
    <div class="kanban">${lanes}</div>
  `
}

function renderManualCard(card: ManualCard): HTMLElement {
  const el = document.createElement('article')
  el.className = 'card'
  el.draggable = true
  el.dataset.id = String(card.id)
  el.dataset.lane = card.lane
  el.innerHTML = `
    <div class="card-text">${escapeHtml(card.text).replace(/\n/g, '<br>')}</div>
    <button class="card-delete" title="Delete card" aria-label="Delete card">×</button>
  `
  return el
}

function renderLiveItem(item: LiveItem): HTMLElement {
  const el = document.createElement('article')
  el.className = 'card card-live'
  el.dataset.id = String(item.id)
  const st = liveStateLabel(item)
  el.innerHTML = `
    <a class="card-link" href="${item.html_url}" target="_blank" rel="noopener">
      <div class="card-text">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        <span class="card-repo">${escapeHtml(item.repo)}</span>
        <span class="card-num">#${item.number}</span>
        <span class="state ${st.cls}">${st.text}</span>
        <span class="card-time">${relativeTime(item.updated_at)}</span>
      </div>
    </a>
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

// Re-render only live lanes — used after filter changes / live refetches
function renderLiveOnly() {
  for (const l of LANES) {
    if (l.type !== 'live') continue
    const list = laneListEl(l.key)
    list.innerHTML = ''
    const items = liveInLane(l.key as 'issue' | 'pr')
    for (const i of items) list.appendChild(renderLiveItem(i))
    laneCountEl(l.key).textContent = String(items.length)
  }
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
  const res = await fetch('/api/stream')
  if (!res.ok) throw new Error(`/api/stream ${res.status}`)
  const data = await res.json()
  manualCards = data.cards.filter((c: ManualCard) => c.lane === 'idea' || c.lane === 'concept' || c.lane === 'plan')
}

async function fetchLive() {
  const win = timeWindow()
  const params = new URLSearchParams({
    type: 'both',
    status: statusFilter,
    limit: String(LIVE_LIMIT),
    offset: '0',
  })
  if (win.since) params.set('since', win.since)
  if (win.until) params.set('until', win.until)
  const res = await fetch(`/api/cache/prs?${params.toString()}`)
  if (!res.ok) throw new Error(`/api/cache/prs ${res.status}`)
  const data = await res.json()
  liveItems = data.items as LiveItem[]
}

function distinctRepos(): string[] {
  const set = new Set<string>()
  for (const i of liveItems) set.add(i.repo)
  return [...set].sort((a, b) => a.localeCompare(b))
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
    <div class="composer-row">
      <button class="composer-add">Add</button>
      <button class="composer-cancel" type="button">Cancel</button>
      <span class="composer-hint">⌘↵ to add</span>
    </div>
  `
  laneNode.insertBefore(composer, addBtn)
  const ta = composer.querySelector<HTMLTextAreaElement>('textarea')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!

  const close = () => { composer.remove(); addBtn.hidden = false }
  const submit = async () => {
    const text = ta.value.trim()
    if (!text) { close(); return }
    addB.disabled = true
    try {
      const card = await api<ManualCard>('POST', '/api/stream', { text, lane })
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

function openIssueComposer() {
  const laneNode = laneEl('issue')
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    (existing.querySelector('input') as HTMLInputElement | null)?.focus()
    return
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  const repos = distinctRepos()
  const repoOptions = repos.length === 0
    ? '<option value="">(no repos cached — sync first)</option>'
    : repos.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')

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

  const close = () => { composer.remove(); addBtn.hidden = false }
  const showError = (msg: string) => {
    errEl.textContent = msg
    errEl.hidden = false
  }
  const submit = async () => {
    const title = titleInput.value.trim()
    const body = bodyTa.value.trim()
    const repo = repoSel.value
    if (!title) { showError('Title is required'); titleInput.focus(); return }
    if (!repo)  { showError('Repo is required'); return }

    const org = getSettings().org
    if (!org)   { showError('Org not configured in Settings'); return }

    addB.disabled = true
    addB.textContent = 'Opening…'
    errEl.hidden = true
    try {
      const ghRes = await fetch(`/api/github/repos/${org}/${repo}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      })
      if (!ghRes.ok) {
        const text = await ghRes.text().catch(() => '')
        throw new Error(`GitHub ${ghRes.status}: ${text.slice(0, 160)}`)
      }
      close()
      // Pull the new issue into the cache and re-render the live lanes
      try {
        await fetch('/api/cache/sync', { method: 'POST' })
      } catch { /* sync best-effort */ }
      await fetchLive()
      renderLiveOnly()
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

  const original = card.text
  const wrapper = document.createElement('div')
  wrapper.className = 'card-edit'
  wrapper.innerHTML = `
    <textarea rows="3" spellcheck="true"></textarea>
    <div class="composer-row">
      <button class="composer-add">Save</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  const ta = wrapper.querySelector<HTMLTextAreaElement>('textarea')!
  ta.value = original

  const textNode = cardEl.querySelector<HTMLElement>('.card-text')!
  const deleteBtn = cardEl.querySelector<HTMLButtonElement>('.card-delete')!
  textNode.hidden = true
  if (deleteBtn) deleteBtn.hidden = true
  cardEl.appendChild(wrapper)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  const close = () => {
    cardEl.classList.remove('editing')
    cardEl.draggable = true
    wrapper.remove()
    textNode.hidden = false
    if (deleteBtn) deleteBtn.hidden = false
  }
  const save = async () => {
    const text = ta.value.trim()
    if (!text || text === original) { close(); return }
    try {
      const updated = await api<ManualCard>('PATCH', `/api/stream/${id}`, { text })
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
  await api('DELETE', `/api/stream/${id}`)
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
        await api('PATCH', `/api/stream/${movingId}`, { lane: targetLane, position: idx })
      } catch (err) {
        console.error('move failed:', err)
        try { await fetchManual(); renderAll() } catch { /* ignore */ }
      }
    })
  }
}

// ── Card-level click delegation ──────────────────────────────────────────────

function attachCardClickHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!
  kanban.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
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
  const timePicker = viewEl.querySelector<HTMLElement>('#stream-time-picker')!
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

  const statusBar = viewEl.querySelector<HTMLElement>('#stream-status-filter')!
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
}

// ── Init ────────────────────────────────────────────────────────────────────

export async function initStreamView() {
  viewEl = document.getElementById('view-stream')!
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
    await Promise.all([fetchManual(), fetchLive()])
    renderAll()
  } catch (err) {
    console.error('[stream] failed to load:', err)
  }
}
