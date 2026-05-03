// Swarm — log of agent calls. One row per call: model, prompt
// (truncated), status, time elapsed, response (View → expand row to
// reveal the full response text underneath).
//
// Data source: /api/agent-logs (wraps `agent-interface --logs`).
// Response bodies: /api/agent-response/:id (reads the file the
// agent-interface project owns).
//
// Refresh: re-fetch the log list every 15s. The expanded-response state
// is keyed by id and survives the refresh — opens stay open through a
// FLIP-style row preservation.

import { getRefreshRateMs } from '../config'

interface LogEntry {
  id: string
  model: string
  prompt: string
  time_elapsed: string
  status: string
  response_path: string
  error: string
}

let viewEl: HTMLElement
let bodyEl: HTMLElement
let searchEl: HTMLInputElement | null = null
let initialized = false
let entries: LogEntry[] = []
let searchQuery = ''
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let fetchInFlight = false
const expanded = new Map<string, { body: string | null, loading: boolean }>()

const POLL_MS = 15_000

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function statusCell(s: string): string {
  const k = (s || '').toLowerCase()
  const cls = k === 'completed' ? 'ok' : (k === 'error' || k === 'failed') ? 'bad' : 'flat'
  return `<span class="agent-status ${cls}">${escapeHtml(s || '—')}</span>`
}

function modelCell(s: string): string {
  return `<span class="agent-model">${escapeHtml(s || '—')}</span>`
}

function matchesSearch(e: LogEntry): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  return [e.id, e.model, e.prompt, e.status].some((f) => (f || '').toLowerCase().includes(q))
}

function visible(): LogEntry[] {
  return entries.filter(matchesSearch)
}

function renderShell() {
  viewEl.innerHTML = `
    <header class="view-header">
      <div class="filter-cluster" id="swarm-filters">
        <input class="search-input" id="swarm-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" />
        <span class="filter-count" id="swarm-count"></span>
      </div>
    </header>
    <main>
      <table id="swarm-table">
        <thead>
          <tr>
            <th class="agent-col-model">Model</th>
            <th class="agent-col-prompt">Prompt</th>
            <th class="agent-col-status">Status</th>
            <th class="agent-col-time">Time</th>
            <th class="agent-col-response">Response</th>
          </tr>
        </thead>
        <tbody id="swarm-tbody"></tbody>
      </table>
      <p id="swarm-empty" class="agent-empty" hidden>No agent calls.</p>
      <div id="swarm-loader" class="loader" hidden><span></span><span></span><span></span></div>
    </main>
  `
  bodyEl = viewEl.querySelector<HTMLElement>('#swarm-tbody')!
  searchEl = viewEl.querySelector<HTMLInputElement>('#swarm-search')!
  searchEl.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = (searchEl!.value || '').trim()
      if (next === searchQuery) return
      searchQuery = next
      render()
    }, 90)
  })
}

function buildMainRow(e: LogEntry): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'agent-row'
  tr.dataset.id = e.id
  tr.innerHTML = `
    <td>${modelCell(e.model)}</td>
    <td class="agent-prompt-cell" title="${escapeHtml(e.prompt || '')}">${escapeHtml(truncate(e.prompt || '', 140))}</td>
    <td>${statusCell(e.status)}</td>
    <td><span class="agent-time">${escapeHtml(e.time_elapsed || '—')}</span></td>
    <td class="agent-response-cell">
      <button class="agent-view-btn" data-action="toggle">${expanded.has(e.id) ? 'hide' : 'view'}</button>
    </td>
  `
  return tr
}

function buildExpandRow(e: LogEntry): HTMLTableRowElement {
  const state = expanded.get(e.id)!
  const tr = document.createElement('tr')
  tr.className = 'agent-expand-row'
  tr.dataset.expandFor = e.id
  const inner = state.loading
    ? '<div class="agent-response-loading">Loading…</div>'
    : (state.body
        ? `<pre class="agent-response-body">${escapeHtml(state.body)}</pre>`
        : '<div class="agent-response-empty">No response body.</div>')
  tr.innerHTML = `<td colspan="5">${inner}</td>`
  return tr
}

function render() {
  const list = visible()
  const empty = viewEl.querySelector<HTMLElement>('#swarm-empty')!
  const table = viewEl.querySelector<HTMLElement>('#swarm-table')!
  const countEl = viewEl.querySelector<HTMLElement>('#swarm-count')!
  if (entries.length === 0) {
    table.hidden = true
    empty.hidden = false
    countEl.textContent = ''
    return
  }
  table.hidden = false
  empty.hidden = true
  countEl.textContent = list.length === entries.length ? `${entries.length}` : `${list.length} / ${entries.length}`

  bodyEl.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const e of list) {
    frag.appendChild(buildMainRow(e))
    if (expanded.has(e.id)) frag.appendChild(buildExpandRow(e))
  }
  bodyEl.appendChild(frag)
}

async function loadResponse(id: string) {
  expanded.set(id, { body: null, loading: true })
  render()
  try {
    const res = await fetch(`/api/agent-response/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`/api/agent-response ${res.status}`)
    const data = await res.json()
    expanded.set(id, { body: data.body || '', loading: false })
  } catch (err) {
    expanded.set(id, { body: `Error: ${(err as Error).message}`, loading: false })
  }
  render()
}

function attachClicks() {
  bodyEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.agent-view-btn')
    if (!btn) return
    const tr = btn.closest<HTMLTableRowElement>('tr')!
    const id = tr.dataset.id
    if (!id) return
    if (expanded.has(id)) {
      expanded.delete(id)
      render()
    } else {
      // Optimistically render the placeholder row, then fetch.
      loadResponse(id)
    }
  })
}

async function pollOnce() {
  if (fetchInFlight) return
  fetchInFlight = true
  try {
    const res = await fetch('/api/agent-logs')
    if (!res.ok) throw new Error(`/api/agent-logs ${res.status}`)
    const data = await res.json()
    entries = (data.logs || []) as LogEntry[]
    render()
  } catch (err) {
    if (entries.length === 0) {
      const empty = viewEl.querySelector<HTMLElement>('#swarm-empty')!
      empty.textContent = `Error: ${(err as Error).message}`
      empty.hidden = false
    }
  } finally {
    fetchInFlight = false
  }
}

export async function initSwarmView() {
  viewEl = document.getElementById('view-swarm')!
  if (!initialized) {
    initialized = true
    renderShell()
    attachClicks()
  }
  await pollOnce()
  startSwarmPolling()
}

export function stopSwarmRefresh() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function startSwarmPolling() {
  stopSwarmRefresh()
  // Cadence stays at the dedicated 15s for now — agent-interface logs
  // tick at their own rate, independent of the GitHub refresh-rate.
  // Reading getRefreshRateMs() lets a future toggle govern this too.
  void getRefreshRateMs
  pollTimer = setInterval(pollOnce, POLL_MS)
}
