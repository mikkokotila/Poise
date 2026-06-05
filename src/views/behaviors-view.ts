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

import { BEHAVIORS, isEnabled, setEnabled, getSetting, setSetting, getScratchpad, setScratchpad, getLastTriggered, refreshState, type BehaviorKey, type BehaviorSetting } from '../behaviors'

let viewEl: HTMLElement
let initialized = false
// Owner per behavior, fetched once from /api/behaviors. Server-side
// values come from env vars (REVIEW_AGENT_USERNAME, etc.) — these are
// the actual GitHub usernames the automations act as.
let behaviorOwners: Partial<Record<BehaviorKey, string | null>> = {}
// Tick listener — installed on view init, removed on view leave by
// stopBehaviorsRefresh(). Single shared clock, same pattern as the
// three other views. See startRefreshTicker() in src/config.ts.
const onTick = () => { void tickRefresh() }
let tickListening = false

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

// Relative-time formatter for the Last-triggered column. The value
// now flows from `agent-interface --logs` straight through the API,
// which emits naive ISO in local time (datetime.fromtimestamp().isoformat()
// — see the same parsing fix in swarm-view's startedRel). JavaScript's
// Date constructor parses naive ISO as local, which is what we want.
function relTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
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

// Memory cell — a pill button that opens the per-behavior scratchpad
// editor. Behaviors that don't run an agent (resolve-unblocking) have
// no prompt to inject a note into, so they render a dash like the
// Setting column does. A filled note tints the dot and flips the label
// from "Add" to "Edit"; the tooltip previews the saved text.
function memoryCell(meta: typeof BEHAVIORS[number]): string {
  if (!meta.hasMemory) return '<span class="last-dash">—</span>'
  const note = getScratchpad(meta.key).trim()
  const filled = !!note
  const title = filled ? note.slice(0, 140) : 'Add behavior memory'
  return `
    <button type="button" class="behavior-memory-btn${filled ? ' has-note' : ''}" data-behavior="${escapeHtml(meta.key)}" title="${escapeHtml(title)}" aria-label="Edit memory for ${escapeHtml(meta.key)}">
      <span class="behavior-memory-dot" aria-hidden="true"></span>
      <span class="behavior-memory-label">${filled ? 'Edit' : 'Add'}</span>
    </button>
  `
}

// ── Memory editor panel ─────────────────────────────────────────────────
// A right-side slide-in (same grammar as Settings / Typography) holding
// a textarea for the focused behavior's scratchpad. Built lazily on
// first open and reused across behaviors — only the title, textarea
// value, and the key it writes back to change. Closes on its × button,
// Escape, or a click anywhere outside it (which also covers switching
// views via the top-nav).
let memoryPanelEl: HTMLElement | null = null
let memoryTextarea: HTMLTextAreaElement | null = null
let memoryTitleEl: HTMLElement | null = null
let memorySaveBtn: HTMLButtonElement | null = null
let memoryStatusEl: HTMLElement | null = null
let memoryKey: BehaviorKey | null = null

function setMemoryStatus(text: string, cls: 'info' | 'ok' | 'error' = 'info') {
  if (!memoryStatusEl) return
  memoryStatusEl.textContent = text
  memoryStatusEl.className = `st-help st-help-${cls} behavior-memory-status`
}

function buildMemoryPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'behavior-memory-panel'
  panel.innerHTML = `
    <div class="tp-header">
      <span class="tp-title">Behavior memory</span>
      <button type="button" class="tp-close" aria-label="Close">&times;</button>
    </div>
    <div class="tp-body">
      <div class="tp-section">
        <label class="tp-label behavior-memory-for"></label>
        <textarea class="st-textarea behavior-memory-textarea" rows="14" maxlength="8000" spellcheck="false" placeholder="e.g. Always confirm the CHANGELOG is updated. This repo uses pnpm, not npm."></textarea>
        <div class="st-help st-help-info">Passed to the agent on every run of this behavior — a durable, behavior-specific instruction. Stored locally in <code>~/.poise/cache.db</code>.</div>
      </div>
      <div class="st-row">
        <button type="button" class="st-save behavior-memory-save">Save</button>
        <button type="button" class="st-clear behavior-memory-clear">Clear</button>
        <span class="st-help st-help-info behavior-memory-status" role="status"></span>
      </div>
    </div>
  `
  memoryTitleEl = panel.querySelector('.behavior-memory-for')
  memoryTextarea = panel.querySelector('.behavior-memory-textarea')
  memorySaveBtn = panel.querySelector('.behavior-memory-save')
  memoryStatusEl = panel.querySelector('.behavior-memory-status')

  panel.querySelector('.tp-close')!.addEventListener('click', closeMemoryPanel)
  memorySaveBtn!.addEventListener('click', () => void saveMemory())
  panel.querySelector('.behavior-memory-clear')!.addEventListener('click', () => {
    if (!memoryTextarea) return
    memoryTextarea.value = ''
    memoryTextarea.focus()
  })
  // Cmd/Ctrl+Enter saves from the textarea. Escape is handled at the
  // document level (onMemoryKeydown) so it works regardless of focus.
  memoryTextarea!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMemory() }
  })
  return panel
}

function openMemoryPanel(key: BehaviorKey) {
  if (!memoryPanelEl) {
    memoryPanelEl = buildMemoryPanel()
    document.body.appendChild(memoryPanelEl)
  }
  memoryKey = key
  const meta = BEHAVIORS.find((b) => b.key === key)
  if (memoryTitleEl) memoryTitleEl.textContent = `Memory for ${meta?.label ?? key}`
  if (memoryTextarea) memoryTextarea.value = getScratchpad(key)
  setMemoryStatus('')
  memoryPanelEl.classList.add('open')
  // Defer listener attach so the click that opened the panel doesn't
  // immediately count as an outside-click and close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onMemoryOutside)
    document.addEventListener('keydown', onMemoryKeydown)
    memoryTextarea?.focus()
  }, 0)
}

function closeMemoryPanel() {
  if (!memoryPanelEl) return
  memoryPanelEl.classList.remove('open')
  memoryKey = null
  document.removeEventListener('mousedown', onMemoryOutside)
  document.removeEventListener('keydown', onMemoryKeydown)
}

function onMemoryKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closeMemoryPanel() }
}

function onMemoryOutside(e: MouseEvent) {
  if (!memoryPanelEl) return
  const t = e.target as HTMLElement
  if (memoryPanelEl.contains(t)) return
  // A click on a memory button is handled by the tbody click handler
  // (toggle/switch); don't double-handle it here.
  if (t.closest('.behavior-memory-btn')) return
  closeMemoryPanel()
}

async function saveMemory() {
  if (!memoryKey || !memoryTextarea || !memorySaveBtn) return
  const key = memoryKey
  const text = memoryTextarea.value
  memorySaveBtn.disabled = true
  memorySaveBtn.textContent = 'Saving…'
  try {
    await setScratchpad(key, text)
    setMemoryStatus('Saved.', 'ok')
    refreshMemoryCell(key)
  } catch (err) {
    setMemoryStatus('Failed to save: ' + (err as Error).message, 'error')
  } finally {
    memorySaveBtn.disabled = false
    memorySaveBtn.textContent = 'Save'
  }
}

// Repaint a single row's memory cell so the dot/label reflect the
// just-saved filled/empty state without rebuilding the whole table.
function refreshMemoryCell(key: BehaviorKey) {
  const tr = viewEl.querySelector<HTMLTableRowElement>(`tr[data-behavior="${key}"]`)
  if (!tr) return
  const cell = tr.querySelector<HTMLElement>('.behavior-memory-cell')
  const meta = BEHAVIORS.find((b) => b.key === key)
  if (cell && meta) cell.innerHTML = memoryCell(meta)
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
            <th class="col-memory">Memory</th>
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
    <td class="behavior-memory-cell">${memoryCell(meta)}</td>
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
  tbody.addEventListener('click', (e) => {
    // Memory button → toggle the per-behavior scratchpad panel.
    const memBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.behavior-memory-btn')
    if (memBtn) {
      e.preventDefault()
      const key = memBtn.dataset.behavior as BehaviorKey
      if (memoryPanelEl?.classList.contains('open') && memoryKey === key) closeMemoryPanel()
      else openMemoryPanel(key)
      return
    }
    // Last-triggered click → navigate to Swarm and focus the matching row.
    // The actual view-switch + focus is bridged through main.ts so this
    // module doesn't need to know about the menu.
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

// In-place cell refresh — pulls fresh state from /api/behaviors and
// updates only the time-sensitive cells (last-triggered) without
// wiping the table. Toggle / setting / owner cells are user-driven
// (poise:behaviors-changed handles those) so they don't need to
// repaint on every tick. Same calm rhythm as Current's FLIP — no
// flicker, no rebuild.
async function tickRefresh() {
  await refreshState()
  for (const meta of BEHAVIORS) {
    const tr = viewEl.querySelector<HTMLTableRowElement>(`tr[data-behavior="${meta.key}"]`)
    if (!tr) continue
    const cell = tr.querySelector<HTMLElement>('.behavior-last-cell')
    if (cell) cell.innerHTML = lastTriggeredCell(meta.key)
  }
}

export function stopBehaviorsRefresh() {
  closeMemoryPanel()
  if (!tickListening) return
  window.removeEventListener('poise:refresh-tick', onTick)
  tickListening = false
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
  // Subscribe to the wall-clock-aligned ticker so the relative-time
  // strings ("2h", "5m") stay accurate and any newly-fired behavior
  // shows up without a manual reload.
  if (!tickListening) {
    window.addEventListener('poise:refresh-tick', onTick)
    tickListening = true
  }
}
