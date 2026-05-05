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


interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string
  model: string
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  prompt: string
  started_at: string        // ISO-ish "YYYY-MM-DDTHH:MM:SS" — UTC implied by upstream
  time_elapsed: string
  status: string
  response: string        // 8-char hash; pass to /api/agent-response/<hash> to fetch body
  error: string
}

// Relative-time formatter for the Started column. Mirrors the
// `relativeTime` used on Current's live cards so the two views read
// the same vocabulary (s / m / h / d / mo / y).
function startedRel(iso: string): string {
  if (!iso) return '—'
  // agent-interface emits a naive ISO without a Z or offset; treat as
  // UTC so the relative diff is correct regardless of the user's TZ.
  const normalized = /[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z'
  const t = new Date(normalized).getTime()
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

let viewEl: HTMLElement
let bodyEl: HTMLElement
let searchEl: HTMLInputElement | null = null
let initialized = false
let entries: LogEntry[] = []
let searchQuery = ''
let searchDebounce: ReturnType<typeof setTimeout> | null = null
// Tick listener — installed on view init, removed on view leave.
// Single shared clock — see startRefreshTicker() in src/config.ts.
const onSwarmTick = () => pollOnce()
let swarmListening = false
let fetchInFlight = false
const expanded = new Map<string, { body: string | null, loading: boolean }>()


function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}


// Reuse Archive's `.state` pill class — same closed vocabulary, same
// shape across both views. Add the closed-set agent flavors (ok / bad
// / flat) for the three swarm statuses we care about.
function statusCell(s: string): string {
  const k = (s || '').toLowerCase()
  const cls = k === 'completed' ? 'ok' : (k === 'error' || k === 'failed') ? 'bad' : 'flat'
  return `<span class="state ${cls}">${escapeHtml(s || '—')}</span>`
}

function modelCell(s: string): string {
  return `<span class="agent-model">${escapeHtml(s || '—')}</span>`
}

function behaviorCell(s: string | null): string {
  if (!s) return '<span class="agent-dash">—</span>'
  return `<span class="agent-behavior">${escapeHtml(s)}</span>`
}

// Repo + PR number formatted as a short tag with a link to GitHub when
// both are set. Either field missing → dash, so the column reads
// honestly when the call wasn't tied to a PR.
function targetCell(e: LogEntry): string {
  const repo = e.repo || ''
  const pr = e.pr_id ? String(e.pr_id) : ''
  if (!repo && !pr) return '<span class="agent-dash">—</span>'
  const short = repo ? (repo.includes('/') ? repo.split('/')[1] : repo) : ''
  const label = short && pr ? `${short}#${pr}` : (short || `#${pr}`)
  if (repo && pr) {
    const href = `https://github.com/${repo}/pull/${pr}`
    return `<a class="agent-target" href="${href}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
  }
  return `<span class="agent-target">${escapeHtml(label)}</span>`
}

// Chevron — same icon-button rhythm as Archive's .review-btn. Points
// right when collapsed, rotates 90° (down) when the row is expanded
// via .open class.
const CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function matchesSearch(e: LogEntry): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  return [e.id, e.model, e.behavior, e.prompt, e.status, e.actor, e.repo, e.pr_id].some(
    (f) => (f || '').toLowerCase().includes(q)
  )
}

function visible(): LogEntry[] {
  return entries.filter(matchesSearch)
}

function renderShell() {
  viewEl.innerHTML = `
    <header class="view-header">
      <div class="filter-cluster" id="swarm-filters">
        <div class="search-cluster">
          <input class="search-input" id="swarm-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" />
          <span class="filter-count" id="swarm-count"></span>
        </div>
      </div>
    </header>
    <main>
      <table id="swarm-table">
        <thead>
          <tr>
            <th class="col-model">Model</th>
            <th class="col-behavior">Behavior</th>
            <th class="col-target">Target</th>
            <th class="col-status">Status</th>
            <th class="col-started">Started</th>
            <th class="col-elapsed">Elapsed</th>
            <th class="col-action"></th>
          </tr>
        </thead>
        <tbody id="swarm-tbody"></tbody>
      </table>
      <p id="swarm-empty" hidden>No agent calls.</p>
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
  tr.dataset.hash = e.response || ''
  const hasResponse = !!e.response
  const isOpen = expanded.has(e.id)
  const btn = hasResponse
    ? `<button class="expand-btn${isOpen ? ' open' : ''}" title="${isOpen ? 'Hide response' : 'View response'}" aria-label="Toggle response">${CHEV_SVG}</button>`
    : ''
  // Prompt column dropped — agent-interface behaviors are mostly
  // input-driven (pr_review takes a PR id, mergeable takes a PR), so
  // the prompt field is empty for almost every row. The full prompt
  // is still visible inside the expanded response view when relevant.
  tr.innerHTML = `
    <td>${modelCell(e.model)}</td>
    <td>${behaviorCell(e.behavior)}</td>
    <td>${targetCell(e)}</td>
    <td>${statusCell(e.status)}</td>
    <td><span class="date">${escapeHtml(startedRel(e.started_at))}</span></td>
    <td><span class="date">${escapeHtml(e.time_elapsed || '—')}</span></td>
    <td class="action-cell">${btn}</td>
  `
  return tr
}

function setExpandContent(tr: HTMLTableRowElement, id: string) {
  const state = expanded.get(id)!
  const inner = state.loading
    ? '<div class="agent-response-loading">Loading…</div>'
    : (state.body
        ? `<pre class="agent-response-body">${escapeHtml(state.body)}</pre>`
        : '<div class="agent-response-empty">No response body.</div>')
  tr.innerHTML = `<td colspan="7">${inner}</td>`
}

function buildExpandRow(e: LogEntry): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'agent-expand-row'
  tr.dataset.expandFor = e.id
  setExpandContent(tr, e.id)
  return tr
}

// FLIP — same standard Current uses for its live lanes. Both main rows
// and their (optional) expand-row siblings get rect-captured before the
// reorder, then translated back to their old positions and animated
// home over 700ms. Expand rows ride along with their main rows so the
// pair never visually detaches during the animation.
const FLIP_MS = 700

function applySwarmFlip(nextEntries: LogEntry[]) {
  // 1. First — capture rects of every existing row.
  const firstRects = new Map<string, DOMRect>()        // keyed `m:<id>` for main, `e:<id>` for expand
  const existingMain = new Map<string, HTMLTableRowElement>()
  const existingExpand = new Map<string, HTMLTableRowElement>()
  for (const el of [...bodyEl.children] as HTMLTableRowElement[]) {
    if (el.classList.contains('agent-row')) {
      const id = el.dataset.id
      if (!id) continue
      firstRects.set(`m:${id}`, el.getBoundingClientRect())
      existingMain.set(id, el)
    } else if (el.classList.contains('agent-expand-row')) {
      const forId = el.dataset.expandFor
      if (!forId) continue
      firstRects.set(`e:${forId}`, el.getBoundingClientRect())
      existingExpand.set(forId, el)
    }
  }

  // 2. Last — drop departed rows, then reorder/insert.
  const newIds = new Set(nextEntries.map((e) => e.id))
  for (const [id, el] of existingMain)   if (!newIds.has(id))    el.remove()
  for (const [forId, el] of existingExpand) if (!newIds.has(forId)) el.remove()

  const fragment = document.createDocumentFragment()
  for (const e of nextEntries) {
    const main = existingMain.get(e.id)
    if (main) {
      fragment.appendChild(main)
    } else {
      const row = buildMainRow(e)
      row.classList.add('new')                     // fade-in (shared rowIn keyframe)
      fragment.appendChild(row)
    }
    if (expanded.has(e.id)) {
      const ex = existingExpand.get(e.id)
      fragment.appendChild(ex || buildExpandRow(e))
    }
  }
  bodyEl.appendChild(fragment)

  // 3. Invert — main rows and their expand siblings together.
  const movers: HTMLTableRowElement[] = []
  for (const e of nextEntries) {
    const mainEl = existingMain.get(e.id)
    if (mainEl) {
      const first = firstRects.get(`m:${e.id}`)
      if (first) {
        const last = mainEl.getBoundingClientRect()
        const dy = first.top - last.top
        if (Math.abs(dy) >= 0.5) {
          mainEl.style.transition = 'none'
          mainEl.style.transform = `translateY(${dy}px)`
          movers.push(mainEl)
        }
      }
    }
    if (expanded.has(e.id)) {
      const exEl = existingExpand.get(e.id)
      if (exEl) {
        const first = firstRects.get(`e:${e.id}`)
        if (first) {
          const last = exEl.getBoundingClientRect()
          const dy = first.top - last.top
          if (Math.abs(dy) >= 0.5) {
            exEl.style.transition = 'none'
            exEl.style.transform = `translateY(${dy}px)`
            movers.push(exEl)
          }
        }
      }
    }
  }

  // 4. Play — flush layout, then animate transforms back to identity.
  if (movers.length > 0) {
    void bodyEl.offsetHeight
    requestAnimationFrame(() => {
      for (const el of movers) {
        el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`
        el.style.transform = ''
      }
      window.setTimeout(() => {
        for (const el of movers) {
          el.style.transition = ''
          el.style.transform = ''
        }
      }, FLIP_MS + 50)
    })
  }
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
    bodyEl.innerHTML = ''
    return
  }
  table.hidden = false
  empty.hidden = true
  countEl.textContent = list.length === entries.length ? `${entries.length}` : `${list.length} / ${entries.length}`
  applySwarmFlip(list)
}

async function loadResponse(id: string, hash: string) {
  expanded.set(id, { body: null, loading: true })

  // Optimistically insert the expand row right after its main row so
  // the user sees the loading state immediately. The next poll's FLIP
  // will preserve the row by id.
  const mainRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-row[data-id="${id}"]`)
  if (mainRow) {
    const btn = mainRow.querySelector<HTMLButtonElement>('.agent-view-btn')
    if (btn) btn.textContent = 'hide'
    const e = entries.find((x) => x.id === id)
    if (e) {
      const expandRow = buildExpandRow(e)
      mainRow.insertAdjacentElement('afterend', expandRow)
    }
  }

  try {
    const res = await fetch(`/api/agent-response/${encodeURIComponent(hash)}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text ? `/api/agent-response ${res.status}: ${text.slice(0, 200)}` : `/api/agent-response ${res.status}`)
    }
    const data = await res.json()
    expanded.set(id, { body: data.body || '', loading: false })
  } catch (err) {
    expanded.set(id, { body: `Error: ${(err as Error).message}`, loading: false })
  }

  // Refresh the expand row's content in place — no rebuild, no flicker.
  const stillThere = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
  if (stillThere) setExpandContent(stillThere, id)
}

function attachClicks() {
  bodyEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.expand-btn')
    if (!btn) return
    const tr = btn.closest<HTMLTableRowElement>('tr')!
    const id = tr.dataset.id || ''
    const hash = tr.dataset.hash || ''
    if (!id || !hash) return
    if (expanded.has(id)) {
      // Hide — surgical: remove the expand row, rotate the chevron back.
      expanded.delete(id)
      const expandRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
      expandRow?.remove()
      btn.classList.remove('open')
    } else {
      btn.classList.add('open')
      loadResponse(id, hash)
    }
  })
}

// Find and focus the most-recent pr_review log entry for repo+pr_id.
// Caller is responsible for switching to this view first; we await a
// poll so the data is fresh, then scroll the matching row into view
// and (if completed) expand it inline.
export async function focusRow(repo: string, pr_id: string): Promise<void> {
  if (!viewEl || !bodyEl) return
  // Pull fresh logs so behaviors that just fired show up immediately.
  await pollOnce()
  // entries are newest-first per the proxy, so the first match is the
  // most-recent pr_review for this PR.
  const match = entries.find((e) =>
    e.repo === repo &&
    String(e.pr_id) === String(pr_id) &&
    e.behavior === 'pr_review',
  )
  if (!match) return
  const row = bodyEl.querySelector<HTMLTableRowElement>(`tr.agent-row[data-id="${match.id}"]`)
  if (!row) return
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // Highlight briefly so the eye lands on the right row.
  row.classList.add('agent-row-focus')
  window.setTimeout(() => row.classList.remove('agent-row-focus'), 1500)
  // If the run is finished and has a response body, expand it inline.
  // Otherwise (running / failed-without-body) just show the row.
  if (match.status === 'completed' && match.response && !expanded.has(match.id)) {
    const btn = row.querySelector<HTMLButtonElement>('.expand-btn')
    if (btn) btn.classList.add('open')
    loadResponse(match.id, match.response)
  }
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
  if (swarmListening) {
    window.removeEventListener('poise:refresh-tick', onSwarmTick)
    swarmListening = false
  }
}

function startSwarmPolling() {
  if (swarmListening) return
  window.addEventListener('poise:refresh-tick', onSwarmTick)
  swarmListening = true
}
