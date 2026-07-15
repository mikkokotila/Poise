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
  started_at: string        // ISO-ish "YYYY-MM-DDTHH:MM:SS" — naive LOCAL time
                            // (agent-interface uses datetime.fromtimestamp().isoformat()
                            // which emits the system-local datetime without an offset).
  time_elapsed: string
  status: string
  response: string        // upstream availability marker; fetch body by full id
  error: string
}

// Relative-time formatter for the Started column. Mirrors the
// `relativeTime` used on Current's live cards so the two views read
// the same vocabulary (s / m / h / d / mo / y).
function startedRel(iso: string): string {
  if (!iso) return '—'
  // agent-interface emits a naive ISO in LOCAL time (no Z, no offset)
  // because datetime.fromtimestamp(ts).isoformat() does — see
  // agent_interface/__init__.py. JavaScript's Date constructor parses
  // naive ISO as local, which matches. The previous version of this
  // function appended "Z" and parsed as UTC, which on UTC+N pushed the
  // start time N hours into the future and Math.max clamped the diff
  // to 0 — every fresh row read "0s" until N hours had passed.
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
    const safeRepo = repo.split('/').map(encodeURIComponent).join('/')
    const href = `https://github.com/${safeRepo}/pull/${encodeURIComponent(pr)}`
    return `<a class="agent-target" href="${href}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
  }
  return `<span class="agent-target">${escapeHtml(label)}</span>`
}

// Chevron — same icon-button rhythm as Archive's .review-btn. Points
// right when collapsed, rotates 90° (down) when the row is expanded
// via .open class.
const CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Replay — circular arrow with a notch, classic "re-run" icon. Clicking
// it spawns a fresh agent-interface call with the same args; the new
// run shows up as a new row on the next poll.
const REPLAY_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 3.5A4 4 0 1 0 10.4 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polyline points="9.5 1 9.5 3.5 7 3.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>'

// Whether a row is replayable through agent-interface today —
// pr_review and pr_approve have standalone CLI invocations; chat is a
// continuous session (replay doesn't fit the semantic); other behaviors
// aren't first-class CLI entry points.
function isReplayable(e: LogEntry): boolean {
  return (e.behavior === 'pr_review' || e.behavior === 'pr_approve')
      && !!e.repo && !!e.pr_id
}

function replayCell(e: LogEntry): string {
  if (!isReplayable(e)) return '<span class="agent-dash">—</span>'
  return `<button class="replay-btn" title="Replay this run" aria-label="Replay this run">${REPLAY_SVG}</button>`
}

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
            <th class="col-replay">Replay</th>
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

// Cell markup for one agent-call row. Split out from buildMainRow so
// the FLIP path can refresh an *existing* row's cells in place — every
// value here (status, started, elapsed) is recomputed each call, so a
// reused row stops freezing at its first-render values.
// Prompt column dropped — agent-interface behaviors are mostly
// input-driven (pr_review takes a PR id, mergeable takes a PR), so
// the prompt field is empty for almost every row. The full prompt
// is still visible inside the expanded response view when relevant.
function mainRowInnerHTML(e: LogEntry): string {
  const hasResponse = !!e.response
  const isOpen = expanded.has(e.id)
  const btn = hasResponse
    ? `<button class="expand-btn${isOpen ? ' open' : ''}" title="${isOpen ? 'Hide response' : 'View response'}" aria-label="Toggle response">${CHEV_SVG}</button>`
    : ''
  return `
    <td>${modelCell(e.model)}</td>
    <td>${behaviorCell(e.behavior)}</td>
    <td>${targetCell(e)}</td>
    <td>${statusCell(e.status)}</td>
    <td class="started-cell"><span class="date">${escapeHtml(startedRel(e.started_at))}</span></td>
    <td class="elapsed-cell"><span class="date">${escapeHtml(e.time_elapsed || '—')}</span></td>
    <td class="replay-cell">${replayCell(e)}</td>
    <td class="action-cell">${btn}</td>
  `
}

function buildMainRow(e: LogEntry): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'agent-row'
  tr.dataset.id = e.id
  tr.dataset.callId = e.response ? e.id : ''
  tr.innerHTML = mainRowInnerHTML(e)
  return tr
}

function setExpandContent(tr: HTMLTableRowElement, id: string) {
  const state = expanded.get(id)!
  const inner = state.loading
    ? '<div class="agent-response-loading">Loading…</div>'
    : (state.body
        ? `<pre class="agent-response-body">${escapeHtml(state.body)}</pre>`
        : '<div class="agent-response-empty">No response body.</div>')
  tr.innerHTML = `<td colspan="8">${inner}</td>`
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
      // Reused row: refresh its cells from the latest data. Without
      // this the row keeps its first-render values forever (Started
      // frozen, status stuck at 'running'). The <tr> element identity
      // is preserved, so the FLIP slide animation is unaffected — only
      // the innards are swapped. dataset.callId too: a row going
      // running→completed becomes eligible for a full-id response read.
      main.dataset.callId = e.response ? e.id : ''
      main.innerHTML = mainRowInnerHTML(e)
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

async function loadResponse(id: string) {
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
    const res = await fetch(`/api/agent-response/${encodeURIComponent(id)}`)
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
  bodyEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement

    // Replay — re-spawns the same agent-interface CLI invocation with
    // the row's behavior/repo/pr_id. The new run lands as a fresh row;
    // the original row stays unchanged. Quick poll right after so the
    // user sees the new row land without waiting for the next 15s tick.
    const replayBtn = target.closest<HTMLButtonElement>('.replay-btn')
    if (replayBtn) {
      const tr = replayBtn.closest<HTMLTableRowElement>('tr')!
      const id = tr.dataset.id || ''
      const entry = entries.find((e) => e.id === id)
      if (!entry) return
      replayBtn.classList.add('spinning')
      replayBtn.disabled = true
      try {
        const res = await fetch('/api/agent-replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            behavior: entry.behavior,
            repo: entry.repo,
            pr_id: entry.pr_id,
          }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
        }
        // Pull the log right away so the new running row shows up
        // without the user waiting for the 15s poll.
        window.setTimeout(() => { void pollOnce() }, 800)
      } catch (err) {
        console.error('[swarm] replay failed:', err)
        alert(`Replay failed: ${(err as Error).message}`)
      } finally {
        replayBtn.classList.remove('spinning')
        replayBtn.disabled = false
      }
      return
    }

    // Expand chevron — toggles the response body row.
    const expandBtn = target.closest<HTMLButtonElement>('.expand-btn')
    if (!expandBtn) return
    const tr = expandBtn.closest<HTMLTableRowElement>('tr')!
    const id = tr.dataset.id || ''
    const callId = tr.dataset.callId || ''
    if (!id || !callId) return
    if (expanded.has(id)) {
      // Hide — surgical: remove the expand row, rotate the chevron back.
      expanded.delete(id)
      const expandRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
      expandRow?.remove()
      expandBtn.classList.remove('open')
    } else {
      expandBtn.classList.add('open')
      loadResponse(id)
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
    loadResponse(match.id)
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

// The Started column shows a relative time ("3m") computed at render.
// Polling only re-renders every 1–5 min, so between polls every
// Started cell is stale. This ticker re-derives just the Started text
// from data already in hand — no fetch — every 30s, so the column
// stays live. A changed value gets a `.date-tick` class for a soft
// fade. Created once; cheap enough (a handful of text comparisons) to
// leave running for the app's lifetime.
const STARTED_TICK_MS = 30_000
let startedTickTimer: ReturnType<typeof setInterval> | null = null

function refreshStartedCells(): void {
  if (!bodyEl) return
  for (const row of bodyEl.querySelectorAll<HTMLElement>('.agent-row')) {
    const id = row.dataset.id
    if (!id) continue
    const e = entries.find((x) => x.id === id)
    if (!e) continue
    const cell = row.querySelector<HTMLElement>('.started-cell .date')
    if (!cell) continue
    const next = startedRel(e.started_at)
    if (cell.textContent !== next) {
      cell.textContent = next
      cell.classList.remove('date-tick')
      void cell.offsetWidth                          // restart the keyframe
      cell.classList.add('date-tick')
    }
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
  if (!startedTickTimer) startedTickTimer = setInterval(refreshStartedCells, STARTED_TICK_MS)
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
