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
  actor: string | null      // null on chat rows — nothing here may assume it is set
  model: string
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  // Chat runs are not tied to a repo or PR; this is what identifies them, and
  // it is the same id the chat pane opens a conversation by.
  session_id: string | null
  prompt: string
  started_at: string        // ISO-ish "YYYY-MM-DDTHH:MM:SS" — naive LOCAL time
                            // (agent-interface uses datetime.fromtimestamp().isoformat()
                            // which emits the system-local datetime without an offset).
  started_at_precise: string | null   // exact UTC instant; preferred when present
  completed_at: string | null
  time_elapsed: string
  status: string
  // The verdict of a finished review. 'completed' alone does not say whether
  // the agent approved or demanded changes.
  outcome: 'clean' | 'changes_requested' | 'approved' | 'superseded' | 'preflight_failed' | null
  response: string        // upstream availability marker; fetch body by full id
  error: string
}

// When a run started, as an exact instant. `started_at_precise` carries a UTC
// offset; `started_at` is naive local, which is ambiguous for the hour that
// repeats when the clock goes back and wrong for the hour that does not exist
// when it goes forward. Prefer the exact one and keep the naive one as the
// fallback for rows that predate it.
function startedAtMs(e: { started_at: string, started_at_precise?: string | null }): number {
  const precise = e.started_at_precise ? new Date(e.started_at_precise).getTime() : NaN
  if (isFinite(precise)) return precise
  // agent-interface emits a naive ISO in LOCAL time (no Z, no offset)
  // because datetime.fromtimestamp(ts).isoformat() does — see
  // agent_interface/__init__.py. JavaScript's Date constructor parses
  // naive ISO as local, which matches. An earlier version of this
  // function appended "Z" and parsed as UTC, which on UTC+N pushed the
  // start time N hours into the future and Math.max clamped the diff
  // to 0 — every fresh row read "0s" until N hours had passed.
  return e.started_at ? new Date(e.started_at).getTime() : NaN
}

// Relative-time vocabulary (s / m / h / d / mo / y), the same one Current's
// live cards use, so the two views read alike.
function relFromMs(t: number): string {
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

function startedRel(e: LogEntry): string {
  return relFromMs(startedAtMs(e))
}

// How long a run has been going. agent-interface fills `time_elapsed` when the
// run ends, so a running row's value was whatever it happened to be at the last
// data poll — frozen for up to five minutes while the Started column beside it
// ticked every thirty seconds, which read as a stalled agent. Derive it live
// for a run that has not finished.
function elapsedText(e: LogEntry): string {
  const running = !e.completed_at && e.status !== 'completed' && e.status !== 'failed' && e.status !== 'error'
  if (!running) return e.time_elapsed || '—'
  const started = startedAtMs(e)
  if (!isFinite(started)) return e.time_elapsed || '—'
  const secs = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
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


// Reuse Archive's `.state` pill class — same closed vocabulary, same shape
// across both views, plus the agent flavours (ok / bad / flat).
//
// What a finished run actually decided. "completed" says the agent ran, not
// what it concluded — an approval and a demand for changes rendered as the same
// green pill, and the only way to tell them apart was to expand the row and
// read the prose.
const OUTCOME_LABEL: Record<string, { text: string, cls: string }> = {
  clean: { text: 'clean', cls: 'ok' },
  approved: { text: 'approved', cls: 'ok' },
  changes_requested: { text: 'changes', cls: 'warn' },
  superseded: { text: 'superseded', cls: 'flat' },
  preflight_failed: { text: 'preflight', cls: 'bad' },
}

function statusCell(e: LogEntry): string {
  const s = e.status
  const k = (s || '').toLowerCase()
  const cls = k === 'completed' ? 'ok' : (k === 'error' || k === 'failed') ? 'bad' : 'flat'
  const pill = `<span class="state ${cls}">${escapeHtml(s || '—')}</span>`
  const verdict = e.outcome ? OUTCOME_LABEL[e.outcome] : null
  if (!verdict) return pill
  return `${pill} <span class="state ${verdict.cls} state-outcome" title="Outcome: ${escapeHtml(e.outcome!)}">${escapeHtml(verdict.text)}</span>`
}

function modelCell(s: string): string {
  return `<span class="agent-model">${escapeHtml(s || '—')}</span>`
}

function behaviorCell(s: string | null): string {
  if (!s) return '<span class="agent-dash">—</span>'
  return `<span class="agent-behavior">${escapeHtml(s)}</span>`
}

// Repo + PR number as a short tag linking to GitHub when both are set.
//
// A session id is the only thing identifying a run that is not tied to a pull
// request, and Swarm has no Prompt column — so a chat, debate or find_alpha row
// used to carry no identifying information at all. The id itself is too long to
// read: strip the `editor-` prefix and the trailing uniqueness digits that
// editorChatSessionId appends, and keep the full value in the tooltip.
const SESSION_LABEL_MAX = 26

function sessionLabel(sessionId: string): string {
  let label = sessionId
  const editor = /^editor-(.+)-\d+$/.exec(sessionId)
  if (editor) label = editor[1]
  if (label.length <= SESSION_LABEL_MAX) return label
  return `${label.slice(0, SESSION_LABEL_MAX - 1)}…`
}

// What the Target column reads as, so the filter can match the same text the
// person is looking at. Empty when the row has no target at all.
function targetText(e: LogEntry): string {
  const repo = e.repo || ''
  const pr = e.pr_id ? String(e.pr_id) : ''
  if (repo || pr) {
    const short = repo ? (repo.includes('/') ? repo.split('/')[1] : repo) : ''
    return short && pr ? `${short}#${pr}` : (short || `#${pr}`)
  }
  return e.session_id ? sessionLabel(e.session_id) : ''
}

function targetCell(e: LogEntry): string {
  const repo = e.repo || ''
  const pr = e.pr_id ? String(e.pr_id) : ''
  const label = targetText(e)
  if (repo || pr) {
    // A GitHub pull-request URL needs owner/name. A bare repo name produced a
    // link to github.com/<name>/pull/<n>, which is someone else's namespace or
    // a 404 — render it as text rather than sending the person somewhere wrong.
    if (repo.includes('/') && pr) {
      const safeRepo = repo.split('/').map(encodeURIComponent).join('/')
      const href = `https://github.com/${safeRepo}/pull/${encodeURIComponent(pr)}`
      return `<a class="agent-target" href="${href}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    }
    return `<span class="agent-target" title="${escapeHtml(repo && pr ? `${repo}#${pr}` : label)}">${escapeHtml(label)}</span>`
  }
  // A session always resolves: listChatHistory reads the same agent log this
  // row came from, filtered by session_id, so the conversation contains at
  // least this run. Clicking opens it in the chat pane.
  if (e.session_id) {
    return `<button type="button" class="agent-target agent-session-link" data-session="${escapeHtml(e.session_id)}"`
      + ` title="Open this conversation — ${escapeHtml(e.session_id)}">${escapeHtml(label)}</button>`
  }
  return '<span class="agent-dash">—</span>'
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

// Replays in flight, by row id. This lived on the button element, which every
// render replaces — a filter keystroke destroyed it deterministically and the
// refresh tick did it by coincidence. The spinner vanished, the button came
// back idle and enabled while the spawn was still going, and a second click
// started another real agent against the same pull request. For a pr_approve
// row that is a second approval on a live pull request, so the guard has to
// outlive the DOM node.
const replaysInFlight = new Set<string>()

function replayCell(e: LogEntry): string {
  if (!isReplayable(e)) return '<span class="agent-dash">—</span>'
  const busy = replaysInFlight.has(e.id)
  return `<button class="replay-btn${busy ? ' spinning' : ''}"${busy ? ' disabled' : ''}`
    + ` title="${busy ? 'Replay in progress…' : 'Replay this run'}" aria-label="Replay this run">${REPLAY_SVG}</button>`
}

// The filter must match what the column shows. It matched `repo` and `pr_id`
// separately but never the rendered "name#123", so copying the Target cell and
// pasting it in — the first thing anyone tries — returned nothing. The error
// text and the outcome are searchable too: those are the rows a person is
// usually hunting for, and neither had any way to be found.
function matchesSearch(e: LogEntry): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  return [
    e.id, e.model, e.behavior, e.prompt, e.status, e.actor, e.repo, e.pr_id,
    targetText(e), e.session_id, e.outcome, e.error,
  ].some((f) => (f || '').toLowerCase().includes(q))
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
      <p id="swarm-stale" class="st-help st-help-error" role="status" hidden></p>
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
// A run that failed carries an `error` string — every one of them does — and
// the client already holds it. It was rendered nowhere: a red pill, no chevron,
// nothing to open, so diagnosing a failure meant leaving Poise for the CLI.
// A failed row is now expandable whether or not a response body exists; the
// error is what its expansion shows.
function hasDetail(e: LogEntry): boolean {
  return !!e.response || !!e.error
}

function mainRowInnerHTML(e: LogEntry): string {
  const isOpen = expanded.has(e.id)
  const btn = hasDetail(e)
    ? `<button class="expand-btn${isOpen ? ' open' : ''}" aria-expanded="${isOpen}"`
      + ` title="${isOpen ? 'Hide detail' : (e.response ? 'View response' : 'View error')}"`
      + ` aria-label="Toggle detail">${CHEV_SVG}</button>`
    : ''
  return `
    <td>${modelCell(e.model)}</td>
    <td>${behaviorCell(e.behavior)}</td>
    <td>${targetCell(e)}</td>
    <td>${statusCell(e)}</td>
    <td class="started-cell"><span class="date">${escapeHtml(startedRel(e))}</span></td>
    <td class="elapsed-cell"><span class="date">${escapeHtml(elapsedText(e))}</span></td>
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
  const state = expanded.get(id)
  if (!state) return
  const entry = entries.find((x) => x.id === id)
  const errorBlock = entry?.error
    ? `<pre class="agent-response-error">${escapeHtml(entry.error)}</pre>`
    : ''
  const inner = state.loading
    ? '<div class="agent-response-loading">Loading…</div>'
    : (state.body
        ? `<pre class="agent-response-body">${escapeHtml(state.body)}</pre>`
        : (errorBlock ? '' : '<div class="agent-response-empty">No response body.</div>'))
  tr.innerHTML = `<td colspan="8">${errorBlock}${inner}</td>`
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

// FLIP is right for a poll that reorders a few rows. It is wrong for filtering,
// where hundreds of surviving rows slide 700ms at once — and at typing speed
// each keystroke restarts the slide before the last one settles, so the table
// churns while the person is trying to narrow it. Worse, a row that survives a
// filter is measured against its old position tens of thousands of pixels down
// the page and animates in from off-screen, so results look missing.
function renderRowsPlain(list: LogEntry[]) {
  const frag = document.createDocumentFragment()
  for (const e of list) {
    frag.appendChild(buildMainRow(e))
    if (expanded.has(e.id)) frag.appendChild(buildExpandRow(e))
  }
  bodyEl.replaceChildren(frag)
}

function render(opts: { animate?: boolean } = {}) {
  // Nothing to paint into while the view is hidden. Swarm kept rebuilding all
  // ~1000 rows on every tick for the rest of the session after one visit —
  // a fetch, a parse and a full table rebuild every minute, on the main thread,
  // while the person was typing in another view.
  if (!viewEl || viewEl.hidden) return
  const list = visible()
  const empty = viewEl.querySelector<HTMLElement>('#swarm-empty')!
  const table = viewEl.querySelector<HTMLElement>('#swarm-table')!
  const countEl = viewEl.querySelector<HTMLElement>('#swarm-count')!
  if (entries.length === 0) {
    table.hidden = true
    empty.textContent = 'No agent calls.'
    empty.hidden = false
    countEl.textContent = ''
    bodyEl.innerHTML = ''
    return
  }
  countEl.textContent = list.length === entries.length ? `${entries.length}` : `${list.length} / ${entries.length}`
  // A filter matching nothing used to leave a bare header strip over blank
  // space, with only a small count pill to explain it. Archive says so in
  // words for exactly this case.
  if (list.length === 0) {
    table.hidden = true
    empty.textContent = 'No runs match this filter.'
    empty.hidden = false
    bodyEl.innerHTML = ''
    return
  }
  table.hidden = false
  empty.hidden = true
  if (opts.animate) applySwarmFlip(list)
  else renderRowsPlain(list)
}

async function loadResponse(id: string) {
  const e = entries.find((x) => x.id === id)
  // A failed run often has no response body at all — its detail is the error,
  // which is already in hand. Show it without a round trip that would 404.
  const bodyAvailable = !!e?.response
  expanded.set(id, { body: null, loading: bodyAvailable })

  // Optimistically insert the expand row right after its main row so
  // the user sees the loading state immediately. The next poll's FLIP
  // will preserve the row by id.
  const mainRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-row[data-id="${id}"]`)
  if (mainRow && e) mainRow.insertAdjacentElement('afterend', buildExpandRow(e))
  if (!bodyAvailable) return

  let next: { body: string | null, loading: boolean }
  try {
    const res = await fetch(`/api/agent-response/${encodeURIComponent(id)}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text ? `/api/agent-response ${res.status}: ${text.slice(0, 200)}` : `/api/agent-response ${res.status}`)
    }
    const data = await res.json()
    next = { body: data.body || '', loading: false }
  } catch (err) {
    next = { body: `Error: ${(err as Error).message}`, loading: false }
  }

  // The person may have collapsed the row while this was out. Writing the
  // result back unconditionally re-created the map entry with no row behind
  // it, which killed the next click on that chevron and made the row re-open
  // on its own at the next render.
  if (!expanded.has(id)) return
  expanded.set(id, next)
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
      if (replaysInFlight.has(id)) return
      replaysInFlight.add(id)
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
        replaysInFlight.delete(id)
        // The button that was clicked may have been replaced by a render while
        // the request was out; repaint whichever one is attached now.
        const current = bodyEl.querySelector<HTMLButtonElement>(
          `tr.agent-row[data-id="${id}"] .replay-btn`,
        )
        if (current) {
          current.classList.remove('spinning')
          current.disabled = false
          current.title = 'Replay this run'
        }
      }
      return
    }

    // Target on a run with no pull request → open that conversation.
    const sessionBtn = target.closest<HTMLButtonElement>('.agent-session-link')
    if (sessionBtn) {
      const session = sessionBtn.dataset.session || ''
      if (!session) return
      window.dispatchEvent(new CustomEvent('poise:open-chat', {
        detail: { session, label: sessionLabel(session) },
      }))
      return
    }

    // Expand chevron — toggles the response body row.
    const expandBtn = target.closest<HTMLButtonElement>('.expand-btn')
    if (!expandBtn) return
    const tr = expandBtn.closest<HTMLTableRowElement>('tr')!
    const id = tr.dataset.id || ''
    if (!id) return
    // The map used to be the only source of truth for open/closed, and it
    // could disagree with the DOM — a double-click, or collapsing a row whose
    // response was still loading, left an entry with no row behind it. The
    // next click then took the collapse branch again and did nothing visible,
    // and the row re-opened by itself on the following render. Trust the DOM
    // for what is on screen and keep the map in step with it.
    const openRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
    if (openRow) {
      openRow.remove()
      expanded.delete(id)
      expandBtn.classList.remove('open')
      expandBtn.setAttribute('aria-expanded', 'false')
      return
    }
    expanded.delete(id)
    expandBtn.classList.add('open')
    expandBtn.setAttribute('aria-expanded', 'true')
    void loadResponse(id)
  })
}

// Find and focus the most-recent log entry for repo+pr_id. Caller is
// responsible for switching to this view first; we await a poll so the data is
// fresh, then scroll the matching row into view and (if completed) expand it
// inline.
export async function focusRow(repo: string, pr_id: string): Promise<void> {
  if (!viewEl || !bodyEl) return
  // Pull fresh logs so behaviors that just fired show up immediately.
  await pollOnce()
  // entries are newest-first per the proxy, so the first match is the most
  // recent run against this pull request. This used to require
  // `behavior === 'pr_review'`, so the "Last triggered" links for approve-prs
  // and resolve-unblocking — which produce pr_approve and other behaviours —
  // matched nothing and the click did nothing.
  const match = entries.find((e) =>
    e.repo === repo && String(e.pr_id) === String(pr_id),
  )
  if (!match) {
    notFocusable(`No run found for ${repo}#${pr_id}.`)
    return
  }
  // An active filter can hide the very row we were asked to focus. Clearing it
  // is what the person meant by following the link — silently doing nothing
  // was not.
  if (!matchesSearch(match)) {
    searchQuery = ''
    if (searchEl) searchEl.value = ''
    render()
  }
  const row = bodyEl.querySelector<HTMLTableRowElement>(`tr.agent-row[data-id="${match.id}"]`)
  if (!row) {
    notFocusable(`The run for ${repo}#${pr_id} is not in the current list.`)
    return
  }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // Highlight briefly so the eye lands on the right row.
  row.classList.add('agent-row-focus')
  window.setTimeout(() => row.classList.remove('agent-row-focus'), 1500)
  // If the run is finished and has a response body, expand it inline.
  // Otherwise (running / failed-without-body) just show the row.
  if (match.status === 'completed' && match.response && !expanded.has(match.id)) {
    const btn = row.querySelector<HTMLButtonElement>('.expand-btn')
    if (btn) { btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true') }
    loadResponse(match.id)
  }
}

// Following a link and landing on nothing, with no explanation, is worse than
// being told the run is not here.
function notFocusable(message: string): void {
  const el = viewEl?.querySelector<HTMLElement>('#swarm-stale')
  if (!el) return
  el.textContent = message
  el.hidden = false
  window.setTimeout(() => {
    // Leave a real load error in place; only clear our own transient note.
    if (el.textContent === message) renderStaleBanner()
  }, 6000)
}

// The in-flight request itself, not just a flag. `focusRow` awaits pollOnce to
// get fresh data before looking for its row; with a bare flag the await
// resolved instantly against an empty list, so the first Behaviors → Swarm
// deep-link of a session silently did nothing and only worked on the second
// click. Callers now join the request that is already running.
let pollInFlight: Promise<void> | null = null

function pollOnce(): Promise<void> {
  if (pollInFlight) return pollInFlight
  const run = (async () => {
    try {
      const res = await fetch('/api/agent-logs')
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = ''
        try { detail = JSON.parse(text)?.error || '' } catch { detail = text.slice(0, 200) }
        throw new Error(detail ? `${res.status}: ${detail}` : `/api/agent-logs ${res.status}`)
      }
      const data = await res.json()
      entries = (data.logs || []) as LogEntry[]
      lastLoadError = null
      lastLoadedAt = Date.now()
      render({ animate: true })
      renderStaleBanner()
    } catch (err) {
      lastLoadError = (err as Error).message
      if (entries.length === 0) {
        const empty = viewEl?.querySelector<HTMLElement>('#swarm-empty')
        if (empty) {
          empty.textContent = `Error: ${lastLoadError}`
          empty.hidden = false
        }
      }
      renderStaleBanner()
    } finally {
      pollInFlight = null
    }
  })()
  pollInFlight = run
  return run
}

// Once Swarm had rows, a failing refresh was invisible: the table froze on the
// last good snapshot while the Started column kept ticking every thirty
// seconds, so a dead runtime read as a live one — statuses stuck on 'running',
// no new runs, and nothing to suggest looking elsewhere. One row that violates
// the schema is enough, because the server validates the whole batch.
let lastLoadError: string | null = null
let lastLoadedAt = 0

function renderStaleBanner(): void {
  if (!viewEl) return
  const el = viewEl.querySelector<HTMLElement>('#swarm-stale')
  if (!el) return
  if (!lastLoadError || entries.length === 0) {
    el.hidden = true
    el.textContent = ''
    return
  }
  const age = lastLoadedAt ? relFromMs(lastLoadedAt) : 'unknown'
  el.textContent = `Not updating — ${lastLoadError}. Showing the last successful read from ${age} ago.`
  el.hidden = false
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
  if (!bodyEl || !viewEl || viewEl.hidden) return
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const row of bodyEl.querySelectorAll<HTMLElement>('.agent-row')) {
    const id = row.dataset.id
    if (!id) continue
    const e = byId.get(id)
    if (!e) continue
    const cell = row.querySelector<HTMLElement>('.started-cell .date')
    if (cell) {
      const next = startedRel(e)
      if (cell.textContent !== next) {
        cell.textContent = next
        cell.classList.remove('date-tick')
        void cell.offsetWidth                        // restart the keyframe
        cell.classList.add('date-tick')
      }
    }
    // Elapsed ticks alongside Started for a run still going. It used to hold
    // whatever the last data poll said, so a running agent's elapsed sat still
    // for up to five minutes while Started counted up next to it.
    const elapsedEl = row.querySelector<HTMLElement>('.elapsed-cell .date')
    if (elapsedEl) {
      const nextElapsed = elapsedText(e)
      if (elapsedEl.textContent !== nextElapsed) elapsedEl.textContent = nextElapsed
    }
  }
  renderStaleBanner()
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
