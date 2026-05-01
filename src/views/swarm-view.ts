// Swarm — live ops dashboard. Polls /api/swarm/events (proxied to the local
// hermes swarm-events service) every 15s and renders the same in-flight +
// idle structure as that service's HTML page, in our design language.

interface SwarmEvent {
  ts: string                // ISO without timezone, local-time
  swarm: 'worker' | 'pr'
  actor: string | null
  target: string | null    // "Vaquum/repo#123" or null
  phase: string
  status: string
  message: string
  level: string
  raw: string
  cycle: string
  cycle_done: boolean
}

import { getRefreshRateMs } from '../config'

const LIVE_STATUSES = new Set(['QUEUED', 'WORKING'])
const MILESTONE_STATUSES = new Set([
  'APPROVED', 'PUSHED', 'PR-OPENED', 'COMMENTED', 'EDITED', 'BLOCKED', 'COMPLETED',
])

let initialized = false
let viewEl: HTMLElement
let bodyEl: HTMLElement
let refreshTimer: ReturnType<typeof setInterval> | null = null
let fetchInFlight = false
let everRendered = false
let searchQuery = ''
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let lastDashboard: DashboardData | null = null

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

function targetLink(target: string | null): string {
  if (!target) return '—'
  const m = target.match(/^([^#]+)#(\d+)$/)
  if (!m) return escapeHtml(target)
  const repo = m[1], num = m[2]
  const shortRepo = repo.includes('/') ? repo.split('/', 2)[1] : repo
  return `<a href="https://github.com/${escapeHtml(repo)}/issues/${escapeHtml(num)}" target="_blank" rel="noopener">#${escapeHtml(num)} <span class="repo-tag">${escapeHtml(shortRepo)}</span></a>`
}

function agentCell(actor: string | null): string {
  if (!actor || actor === '—') return '<span class="last-dash">—</span>'
  const safe = escapeHtml(actor)
  const src = `https://github.com/${encodeURIComponent(actor)}.png?size=48`
  return `<a class="agent-link" href="https://github.com/${safe}" target="_blank" rel="noopener" title="${safe}">`
    + `<img class="last-avatar" src="${src}" alt="${safe}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />`
    + `<span class="agent-name">${safe}</span></a>`
}

function humanTime(ts: string, now: Date): string {
  const t = new Date(ts).getTime()
  const secs = Math.max(0, Math.floor((now.getTime() - t) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  const d = new Date(ts)
  const month = d.toLocaleString('en', { month: 'short' })
  return `${month} ${d.getDate().toString().padStart(2, '0')}`
}

function lastEightChars(ts: string): string {
  // Mirrors Python's e['ts'][-8:] which always returns "HH:MM:SS"
  return ts.slice(-8)
}

interface DashboardData {
  inFlight: SwarmEvent[]
  history: Map<string, SwarmEvent[]>   // key = `${swarm}::${target}`, milestones newest-first
  now: Date
  // KPIs
  blocked: number
  prsOpenedToday: number
  milestonesToday: number
  totalMilestones: number
}

function buildDashboard(events: SwarmEvent[]): DashboardData {
  const now = new Date()

  // events come in asc order from the proxy
  const latestPerTarget = new Map<string, SwarmEvent>()  // key = `${swarm}::${target}`
  const completedKeys = new Set<string>()

  for (const e of events) {
    if (!e.target) continue
    const key = `${e.swarm}::${e.target}`
    if (e.status === 'COMPLETED') completedKeys.add(key)
    if (LIVE_STATUSES.has(e.status) || MILESTONE_STATUSES.has(e.status)) {
      latestPerTarget.set(key, e)  // last-write-wins because asc-sorted
    }
  }

  const inFlight: SwarmEvent[] = []
  for (const [key, e] of latestPerTarget) {
    if (completedKeys.has(key)) continue
    const lastTs = new Date(e.ts).getTime()
    if ((now.getTime() - lastTs) > 30 * 60 * 1000) continue  // idle
    inFlight.push(e)
  }
  inFlight.sort((a, b) => b.ts.localeCompare(a.ts))   // newest first

  // Milestones: keep only first occurrence of (target, status, message);
  // subsequent same-signal repeats are noise. Then reverse to newest-first.
  const milestoneEvents = events.filter((e) => MILESTONE_STATUSES.has(e.status))
  const lastSig = new Map<string, string>()
  const pruned: SwarmEvent[] = []
  for (const e of milestoneEvents) {
    const tkey = `${e.swarm}::${e.target ?? ''}`
    const sig = `${e.status}${e.message}`
    if (lastSig.get(tkey) === sig) continue
    lastSig.set(tkey, sig)
    pruned.push(e)
  }
  pruned.reverse()

  // Group milestones by (swarm, target) for the per-row expand panel
  const history = new Map<string, SwarmEvent[]>()
  for (const m of pruned) {
    if (!m.target) continue
    const k = `${m.swarm}::${m.target}`
    let arr = history.get(k)
    if (!arr) { arr = []; history.set(k, arr) }
    arr.push(m)
  }

  // KPIs
  const todayStr = now.toISOString().slice(0, 10)
  const blocked = inFlight.filter((e) => e.status === 'BLOCKED').length
  let prsOpenedToday = 0
  let milestonesToday = 0
  for (const m of pruned) {
    const day = m.ts.slice(0, 10)
    if (day === todayStr) {
      milestonesToday++
      if (m.status === 'PR-OPENED') prsOpenedToday++
    }
  }

  return {
    inFlight, history, now,
    blocked, prsOpenedToday, milestonesToday,
    totalMilestones: pruned.length,
  }
}

function renderHistoryTable(hist: SwarmEvent[]): string {
  if (hist.length === 0) {
    return `<div class="section-empty">No milestones for this target yet.</div>`
  }
  const rows = hist.slice(0, 30).map((m) => `
    <tr>
      <td class="hist-time">${escapeHtml(lastEightChars(m.ts))}</td>
      <td class="hist-pill"><span class="pill s-${escapeHtml(m.status)}">${escapeHtml(m.status)}</span></td>
      <td class="hist-msg">${escapeHtml(m.message)}</td>
      <td class="hist-actor">${agentCell(m.actor)}</td>
    </tr>
  `).join('')
  return `
    <table class="child-table">
      <thead><tr>
        <th>Time</th><th>Status</th><th>Message</th><th>Agent</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderRow(e: SwarmEvent, hist: SwarmEvent[], now: Date, idx: number, idle: boolean): string {
  const rowId = idle ? `swarm-orphan-${idx}` : `swarm-row-${idx}`
  const hcount = hist.length
  const badge = hcount
    ? `<span class="hist-badge" title="${hcount} milestone(s)">${hcount}</span>`
    : ''
  const cycle = idle ? '—' : (e.cycle || '—')
  return `
    <tr id="${rowId}" class="target-row${idle ? ' idle' : ''}" data-row="${rowId}">
      <td class="col-toggle">
        <button type="button" class="toggle-btn" aria-expanded="false" data-target="${rowId}-child">
          <span class="toggle-plus">+</span><span class="toggle-minus">−</span>
        </button>
      </td>
      <td class="col-target">${targetLink(e.target)} ${badge}</td>
      <td class="col-cycle">${escapeHtml(cycle)}</td>
      <td class="col-state">
        <span class="pill s-${escapeHtml(e.status)}">${escapeHtml(e.status)}</span>
        <span class="state-msg">${escapeHtml(e.message)}</span>
      </td>
      <td class="col-actor">${agentCell(e.actor)}</td>
      <td class="col-time">${escapeHtml(humanTime(e.ts, now))}</td>
    </tr>
    <tr id="${rowId}-child" class="child-row"><td colspan="6">${renderHistoryTable(hist)}</td></tr>
  `
}

function flightTable(rowsHtml: string): string {
  return `
    <table class="flight-table">
      <thead><tr>
        <th class="col-toggle"></th>
        <th class="col-target">Target</th>
        <th class="col-cycle">Cycle</th>
        <th class="col-state">State</th>
        <th class="col-actor">Agent</th>
        <th class="col-time">Last</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `
}

function renderDashboard(d: DashboardData): string {
  // Apply search filter (client-side, over already-loaded data) — keeps a
  // row if the query appears in target / status / message / actor.
  const matchEvent = (e: SwarmEvent): boolean => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (e.target ?? '').toLowerCase().includes(q)
      || e.status.toLowerCase().includes(q)
      || e.message.toLowerCase().includes(q)
      || (e.actor ?? '').toLowerCase().includes(q)
  }
  const matchKey = (k: string): boolean => {
    if (!searchQuery) return true
    const hist = d.history.get(k) || []
    if (hist.some(matchEvent)) return true
    // Also match the key itself (so typing a repo name still works on idle
    // rows where the latest event might not contain it textually)
    return k.toLowerCase().includes(searchQuery.toLowerCase())
  }

  const inFlight = d.inFlight.filter(matchEvent)
  const inFlightKeys = new Set(inFlight.map((e) => `${e.swarm}::${e.target}`))
  const orphanKeys = [...d.history.keys()].filter((k) => !inFlightKeys.has(k) && matchKey(k))

  const flightRows = inFlight.map((e, i) => {
    const k = `${e.swarm}::${e.target}`
    return renderRow(e, d.history.get(k) || [], d.now, i, false)
  }).join('')

  const flightHtml = inFlight.length === 0
    ? `<div class="section-empty">${searchQuery ? 'No in-flight rows match the filter.' : 'Nothing in flight right now.'}</div>`
    : flightTable(flightRows)

  let idleHtml = ''
  if (orphanKeys.length > 0) {
    const orphanRows = orphanKeys.map((k, i) => {
      const hist = d.history.get(k)!
      const last = hist[0]   // newest
      return renderRow(last, hist, d.now, i, true)
    }).join('')
    idleHtml = `
      <div class="section-label">Idle <span class="section-note">no longer in flight, retained for reference</span></div>
      ${flightTable(orphanRows)}
    `
  }

  return `
    <div class="kpi-row swarm-kpis">
      <div class="kpi"><div class="kpi-label">In flight</div><div class="kpi-value">${inFlight.length}</div><div class="kpi-sub">live targets</div></div>
      <div class="kpi"><div class="kpi-label">Blocked</div><div class="kpi-value">${d.blocked}</div><div class="kpi-sub">need attention</div></div>
      <div class="kpi"><div class="kpi-label">PRs opened today</div><div class="kpi-value">${d.prsOpenedToday}</div><div class="kpi-sub">by worker</div></div>
      <div class="kpi"><div class="kpi-label">Milestones today</div><div class="kpi-value">${d.milestonesToday}</div><div class="kpi-sub">approved · pushed · merged · edited</div></div>
    </div>

    <div class="section-label">In flight <span class="section-note">click + on any row to expand its milestones</span></div>
    ${flightHtml}
    ${idleHtml}
  `
}

function attachToggleHandlers() {
  // Single delegated handler — survives every re-render because it lives on bodyEl
  bodyEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.toggle-btn')
    if (!btn) return
    const targetId = btn.dataset.target
    if (!targetId) return
    const child = document.getElementById(targetId)
    const parent = btn.closest('tr')
    if (!parent || !child) return
    parent.classList.toggle('open')
    child.classList.toggle('open')
    btn.setAttribute('aria-expanded', String(parent.classList.contains('open')))
  })
}

// Preserve which rows are open so a refresh doesn't collapse them
function snapshotOpenRows(): Set<string> {
  const open = new Set<string>()
  bodyEl.querySelectorAll<HTMLElement>('.target-row.open').forEach((tr) => {
    const id = tr.id
    // Map to a stable key based on target text + actor (since indices may shift)
    const target = tr.querySelector<HTMLAnchorElement>('.col-target a')?.href || id
    open.add(target)
  })
  return open
}

function restoreOpenRows(prev: Set<string>) {
  if (prev.size === 0) return
  bodyEl.querySelectorAll<HTMLElement>('.target-row').forEach((tr) => {
    const target = tr.querySelector<HTMLAnchorElement>('.col-target a')?.href || tr.id
    if (prev.has(target)) {
      tr.classList.add('open')
      const child = document.getElementById(`${tr.id}-child`)
      child?.classList.add('open')
      const btn = tr.querySelector('.toggle-btn')
      btn?.setAttribute('aria-expanded', 'true')
    }
  })
}

async function loadAndRender() {
  // The upstream service is single-threaded and a parse of both swarm logs
  // can take several seconds. Don't pile up overlapping refreshes — the
  // queued ones would only block the upstream further.
  if (fetchInFlight) return
  fetchInFlight = true

  const previouslyOpen = bodyEl.querySelector('.target-row') ? snapshotOpenRows() : new Set<string>()
  try {
    const url = '/api/swarm/events?show_held=true&show_info=true&dedupe=false&limit=10000&order=asc'
    const res = await fetch(url)
    if (!res.ok) {
      // Only show the error state if we have nothing rendered yet. Otherwise
      // keep the last good dashboard visible and the user can wait for the
      // next refresh tick.
      if (!everRendered) {
        bodyEl.innerHTML = renderError(`Swarm service unreachable (HTTP ${res.status}). Is the local swarm-events service running on 127.0.0.1:7878?`)
      }
      return
    }
    const json = await res.json()
    const events: SwarmEvent[] = json.events || []
    lastDashboard = buildDashboard(events)
    bodyEl.innerHTML = renderDashboard(lastDashboard)
    everRendered = true
    restoreOpenRows(previouslyOpen)
  } catch (err) {
    if (!everRendered) {
      bodyEl.innerHTML = renderError(`Swarm service unreachable: ${(err as Error).message}`)
    }
  } finally {
    fetchInFlight = false
  }
}

// Re-render only — used when only the search query changed and we want to
// avoid re-fetching the whole dashboard from the slow upstream.
function renderFromCache() {
  if (!lastDashboard) return
  const previouslyOpen = bodyEl.querySelector('.target-row') ? snapshotOpenRows() : new Set<string>()
  bodyEl.innerHTML = renderDashboard(lastDashboard)
  restoreOpenRows(previouslyOpen)
}

function renderLoading(): string {
  return `
    <div class="kpi-row swarm-kpis">
      <div class="kpi"><div class="kpi-label">In flight</div><div class="kpi-value swarm-skeleton">—</div><div class="kpi-sub">live targets</div></div>
      <div class="kpi"><div class="kpi-label">Blocked</div><div class="kpi-value swarm-skeleton">—</div><div class="kpi-sub">need attention</div></div>
      <div class="kpi"><div class="kpi-label">PRs opened today</div><div class="kpi-value swarm-skeleton">—</div><div class="kpi-sub">by worker</div></div>
      <div class="kpi"><div class="kpi-label">Milestones today</div><div class="kpi-value swarm-skeleton">—</div><div class="kpi-sub">approved · pushed · merged · edited</div></div>
    </div>
    <div class="section-label">In flight <span class="section-note">loading…</span></div>
    <div class="section-empty swarm-loading">Reading swarm logs…</div>
  `
}

function renderError(msg: string): string {
  return `<div class="section-empty">${escapeHtml(msg)}</div>`
}

export function stopSwarmRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

export async function initSwarmView() {
  viewEl = document.getElementById('view-swarm')!
  if (!initialized) {
    initialized = true
    // Persistent shell: header (search input) outside the body so typing
    // survives the 15-second auto-refresh that reflows the rest of the view.
    viewEl.innerHTML = `
      <header class="view-header">
        <div class="filter-cluster">
          <input class="search-input" id="swarm-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" />
        </div>
      </header>
      <div id="swarm-body"></div>
    `
    bodyEl = viewEl.querySelector<HTMLElement>('#swarm-body')!
    attachToggleHandlers()

    const searchEl = viewEl.querySelector<HTMLInputElement>('#swarm-search')!
    searchEl.addEventListener('input', () => {
      if (searchDebounce) clearTimeout(searchDebounce)
      searchDebounce = setTimeout(() => {
        const next = searchEl.value.trim()
        if (next === searchQuery) return
        searchQuery = next
        renderFromCache()
      }, 90)
    })
  } else {
    bodyEl = viewEl.querySelector<HTMLElement>('#swarm-body')!
  }
  // Show a skeleton immediately if we have nothing rendered yet — the
  // upstream service can take several seconds to respond, and a blank
  // viewport during that wait reads as broken.
  if (!everRendered) {
    bodyEl.innerHTML = renderLoading()
  }
  loadAndRender()  // intentionally not awaited — let the user see the skeleton
  startSwarmTimer()
}

function startSwarmTimer() {
  stopSwarmRefresh()
  refreshTimer = setInterval(loadAndRender, getRefreshRateMs())
}

window.addEventListener('poise:refresh-rate-changed', () => {
  if (refreshTimer) startSwarmTimer()
})
