// Behaviors — a table view listing automations with on/off toggles.
//
// Visual contract matches Archive and Swarm exactly: universal `table`,
// `thead th`, `tbody tr` rules in style.css do all the heavy lifting,
// and we only declare the column widths and the cells that are
// genuinely behavior-specific (the owner avatar and the toggle).
//
// Each row's "Active" toggle wires to behaviors.ts, which owns the
// runtime — the view is just a UI for state, not the place where
// agent automations actually run.

import { BEHAVIORS, isEnabled, setEnabled, type BehaviorKey } from '../behaviors'

let viewEl: HTMLElement
let initialized = false
// Owner per behavior, fetched once from /api/behaviors. Server-side
// values come from env vars (REVIEW_AGENT_USERNAME, etc.) — these are
// the actual GitHub usernames the automations act as.
let behaviorOwners: Partial<Record<BehaviorKey, string | null>> = {}

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

function humanAvatarFallback(username: string): string {
  return `https://github.com/${encodeURIComponent(username)}.png?size=48`
}

function ownerCell(username: string | null): string {
  if (!username) return '<span class="last-dash">—</span>'
  const isBot = /\[bot\]$/i.test(username)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  const src = humanAvatarFallback(username)
  return `
    <span class="behavior-owner">
      <img class="${classes.join(' ')}" src="${src}" alt="${escapeHtml(username)}" title="${escapeHtml(username)}" loading="lazy" decoding="async" onerror="this.classList.add('broken')" />
      <span class="behavior-owner-name">${escapeHtml(username)}</span>
    </span>
  `
}

function toggleCell(key: BehaviorKey): string {
  const on = isEnabled(key)
  return `
    <label class="toggle" aria-label="Toggle ${escapeHtml(key)}">
      <input type="checkbox" data-behavior="${escapeHtml(key)}" ${on ? 'checked' : ''} />
      <span class="toggle-slider"></span>
    </label>
  `
}

function renderShell(): string {
  return `
    <header class="view-header">
      <div class="filter-cluster" id="behaviors-filters"></div>
    </header>
    <main>
      <table id="behaviors-table">
        <thead>
          <tr>
            <th class="col-title">Behavior</th>
            <th class="col-owner-wide">Owner</th>
            <th class="col-active">Active</th>
          </tr>
        </thead>
        <tbody id="behaviors-tbody"></tbody>
      </table>
    </main>
  `
}

function renderRow(meta: typeof BEHAVIORS[number]): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.dataset.behavior = meta.key
  const owner = behaviorOwners[meta.key] || null
  tr.innerHTML = `
    <td class="title-cell"><span class="behavior-name">${escapeHtml(meta.label)}</span></td>
    <td>${ownerCell(owner)}</td>
    <td class="behavior-active-cell">${toggleCell(meta.key)}</td>
  `
  return tr
}

async function fetchBehaviorOwners() {
  try {
    const res = await fetch('/api/behaviors')
    if (!res.ok) return
    const data = await res.json()
    for (const key of Object.keys(data)) {
      behaviorOwners[key as BehaviorKey] = data[key]?.owner ?? null
    }
  } catch { /* leave owners null — cell will show a dash */ }
}

function renderRows() {
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#behaviors-tbody')!
  tbody.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const meta of BEHAVIORS) frag.appendChild(renderRow(meta))
  tbody.appendChild(frag)
}

function attachToggleHandler() {
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#behaviors-tbody')!
  tbody.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement
    if (!target.matches('input[type="checkbox"][data-behavior]')) return
    const key = target.dataset.behavior as BehaviorKey
    setEnabled(key, target.checked)
  })
}

export async function initBehaviorsView() {
  viewEl = document.getElementById('view-behaviors')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    attachToggleHandler()
    // Re-render when behavior state changes from elsewhere (e.g. boot
    // re-snapshot, programmatic toggle) so the UI never drifts.
    window.addEventListener('poise:behaviors-changed', () => renderRows())
  }
  // Fetch the server-provided owner map first so the very first paint
  // shows the right username/avatar instead of a flash of "—".
  await fetchBehaviorOwners()
  renderRows()
}
