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

import { BEHAVIORS, isEnabled, setEnabled, getSetting, setSetting, getLastTriggered, refreshState, type BehaviorKey, type BehaviorSetting } from '../behaviors'

let viewEl: HTMLElement
let initialized = false
// Owner per behavior, fetched once from /api/behaviors. Server-side
// values come from env vars (REVIEW_AGENT_USERNAME, etc.) — these are
// the actual GitHub usernames the automations act as.
let behaviorOwners: Partial<Record<BehaviorKey, string | null>> = {}

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

// Setting dropdown — priority ceiling for the behavior. p0 is shown as
// `==p0` (only p0); the rest as `<=pX` (pX and below).
const SETTING_OPTIONS: { value: BehaviorSetting, label: string }[] = [
  { value: 'p0', label: '==p0' },
  { value: 'p1', label: '<=p1' },
  { value: 'p2', label: '<=p2' },
  { value: 'p3', label: '<=p3' },
  { value: 'p4', label: '<=p4' },
]

// Relative-time formatter shared with the Started column on Swarm.
function relTime(iso: string): string {
  if (!iso) return ''
  const normalized = /[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z'
  const t = new Date(normalized).getTime()
  if (!isFinite(t)) return ''
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

function lastTriggeredCell(key: BehaviorKey): string {
  const last = getLastTriggered(key)
  if (!last) return '<span class="last-dash">—</span>'
  return `<a class="behavior-last-link" href="#" data-target="${escapeHtml(last.target)}" title="${escapeHtml(last.target)} · ${escapeHtml(last.at)}">${escapeHtml(relTime(last.at))}</a>`
}

function settingCell(meta: typeof BEHAVIORS[number]): string {
  // Behaviors that don't take a priority ceiling render a dash so the
  // column still aligns visually but doesn't offer a control the
  // server would ignore anyway.
  if (!meta.hasSetting) return '<span class="last-dash">—</span>'
  const current = getSetting(meta.key)
  const opts = SETTING_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('')
  return `
    <select class="behavior-setting" data-behavior="${escapeHtml(meta.key)}" aria-label="Setting for ${escapeHtml(meta.key)}">
      ${opts}
    </select>
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
            <th class="col-setting">Setting</th>
            <th class="col-last">Last triggered</th>
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
    <td class="behavior-setting-cell">${settingCell(meta)}</td>
    <td class="behavior-last-cell">${lastTriggeredCell(meta.key)}</td>
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
  // Same call also pulls enabled flags into the client mirror so the
  // toggle reflects server truth at first render.
  await refreshState()
}

function renderRows() {
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#behaviors-tbody')!
  tbody.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const meta of BEHAVIORS) frag.appendChild(renderRow(meta))
  tbody.appendChild(frag)
}

function attachHandlers() {
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#behaviors-tbody')!
  tbody.addEventListener('change', (e) => {
    const target = e.target as HTMLElement
    // Toggle (Active column)
    if (target.matches('input[type="checkbox"][data-behavior]')) {
      const cb = target as HTMLInputElement
      const key = cb.dataset.behavior as BehaviorKey
      setEnabled(key, cb.checked)
      return
    }
    // Setting dropdown
    if (target.matches('select.behavior-setting[data-behavior]')) {
      const sel = target as HTMLSelectElement
      const key = sel.dataset.behavior as BehaviorKey
      setSetting(key, sel.value as BehaviorSetting)
      return
    }
  })
  // Last-triggered click → navigate to Swarm and focus the matching row.
  // The actual view-switch + focus is bridged through main.ts so this
  // module doesn't need to know about the menu.
  tbody.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('.behavior-last-link')
    if (!link) return
    e.preventDefault()
    const targetStr = link.dataset.target || ''
    const m = targetStr.match(/^(.+)#(\d+)$/)
    if (!m) return
    const [, repo, num] = m
    window.dispatchEvent(new CustomEvent('poise:goto-swarm-row', {
      detail: { repo, pr_id: num },
    }))
  })
}

export async function initBehaviorsView() {
  viewEl = document.getElementById('view-behaviors')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    attachHandlers()
    // Re-render when behavior state changes from elsewhere (e.g. boot
    // re-snapshot, programmatic toggle) so the UI never drifts.
    window.addEventListener('poise:behaviors-changed', () => renderRows())
  }
  // Fetch the server-provided owner map first so the very first paint
  // shows the right username/avatar instead of a flash of "—".
  await fetchBehaviorOwners()
  renderRows()
}
