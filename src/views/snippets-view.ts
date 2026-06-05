// Snippets — manage espanso text-expansion pairs from Poise.
//
// Same table contract as Behaviors: the universal `table` / `thead th` /
// `tbody tr` rules in style.css do the layout, and this view only sets
// the trigger column width + the muted body preview. Editing reuses the
// Settings-panel grammar — a right-side slide-in (`tp-*` / `st-*`
// classes) holding the trigger + body fields. The list lives in
// espanso's match/poise.yml (see server/snippets.ts): Poise reads it on
// open and rewrites the whole set on each save; espanso hot-reloads so a
// `;trigger` expansion goes live the moment you save.

interface Snippet { trigger: string; replace: string }

let viewEl: HTMLElement
let initialized = false
let snippets: Snippet[] = []
let espansoOk = true

// Attribute-safe HTML escape — same helper the other views carry. Also
// escapes " and ' so attribute interpolations don't break on quotes.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

// ── shell + rows ─────────────────────────────────────────────────────────
function renderShell(): string {
  return `
    <header class="view-header">
      <div class="filter-cluster" id="snippets-filters">
        <button type="button" class="st-save snip-add">Add snippet</button>
        <span class="filter-count" id="snippets-count"></span>
        <span class="st-help st-help-info snip-espanso-hint" hidden>espanso not detected — install it (<code>brew install espanso</code>) for snippets to expand.</span>
      </div>
    </header>
    <main>
      <table id="snippets-table">
        <thead>
          <tr>
            <th class="col-snip-trigger">Trigger</th>
            <th class="col-title">Snippet</th>
          </tr>
        </thead>
        <tbody id="snippets-tbody"></tbody>
      </table>
      <p class="snip-empty" hidden>No snippets yet. Add one to create your first <code>;trigger</code>.</p>
    </main>
  `
}

// First non-empty line of the body — the row stays one calm line; the
// full text lives in the editor.
function previewLine(body: string): string {
  return body.split('\n').map((l) => l.trim()).find((l) => l) || ''
}

function renderRow(s: Snippet): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.dataset.trigger = s.trigger
  tr.innerHTML = `
    <td class="title-cell"><span class="snip-trigger">${escapeHtml(s.trigger)}</span></td>
    <td><span class="snip-preview">${escapeHtml(previewLine(s.replace))}</span></td>
  `
  return tr
}

function renderRows() {
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#snippets-tbody')!
  tbody.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const s of snippets) frag.appendChild(renderRow(s))
  tbody.appendChild(frag)

  const n = snippets.length
  viewEl.querySelector('#snippets-count')!.textContent = n ? `${n} snippet${n === 1 ? '' : 's'}` : ''
  viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = n === 0
  viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = n > 0
  viewEl.querySelector<HTMLElement>('.snip-espanso-hint')!.hidden = espansoOk
}

// ── editor panel (slide-in, Settings-panel grammar) ───────────────────────
let panelEl: HTMLElement | null = null
let triggerInput: HTMLInputElement | null = null
let bodyInput: HTMLTextAreaElement | null = null
let saveBtn: HTMLButtonElement | null = null
let deleteBtn: HTMLButtonElement | null = null
let statusEl: HTMLElement | null = null
// Original trigger of the snippet being edited; null = add mode.
let editingTrigger: string | null = null

function setStatus(text: string, cls: 'info' | 'ok' | 'error' = 'info') {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.className = `st-help st-help-${cls} snip-status`
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'snippet-editor-panel'
  panel.innerHTML = `
    <div class="tp-header">
      <span class="tp-title">Snippet</span>
      <button type="button" class="tp-close" aria-label="Close">&times;</button>
    </div>
    <div class="tp-body">
      <div class="tp-section">
        <label class="tp-label">Trigger</label>
        <input type="text" class="st-input snip-trigger-input" autocomplete="off" spellcheck="false" placeholder=";hello" />
        <div class="st-help st-help-info">Type this anywhere and espanso swaps it for the snippet. Convention: lead with <code>;</code>.</div>
      </div>
      <div class="tp-section">
        <label class="tp-label">Snippet</label>
        <textarea class="st-input snip-body-input" rows="8" spellcheck="false" placeholder="The text that replaces the trigger…"></textarea>
      </div>
      <div class="st-row">
        <button type="button" class="st-save snip-save">Save</button>
        <button type="button" class="st-clear snip-delete">Delete</button>
        <span class="st-help st-help-info snip-status" role="status"></span>
      </div>
      <div class="tp-hint">
        Stored in espanso's <code>match/poise.yml</code> and applied the moment you save.
      </div>
    </div>
  `
  triggerInput = panel.querySelector<HTMLInputElement>('.snip-trigger-input')
  bodyInput = panel.querySelector<HTMLTextAreaElement>('.snip-body-input')
  saveBtn = panel.querySelector<HTMLButtonElement>('.snip-save')
  deleteBtn = panel.querySelector<HTMLButtonElement>('.snip-delete')
  statusEl = panel.querySelector<HTMLElement>('.snip-status')

  panel.querySelector('.tp-close')!.addEventListener('click', closePanel)
  saveBtn!.addEventListener('click', () => void save())
  deleteBtn!.addEventListener('click', () => void del())
  // Plain Enter in the trigger field jumps to the body; Cmd/Ctrl+Enter
  // saves from either field (the body keeps plain Enter for newlines).
  triggerInput!.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (e.metaKey || e.ctrlKey) void save()
    else bodyInput?.focus()
  })
  bodyInput!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save() }
  })
  return panel
}

function openPanel(snippet: Snippet | null) {
  if (!panelEl) {
    panelEl = buildPanel()
    document.body.appendChild(panelEl)
  }
  editingTrigger = snippet ? snippet.trigger : null
  if (triggerInput) triggerInput.value = snippet ? snippet.trigger : ''
  if (bodyInput) bodyInput.value = snippet ? snippet.replace : ''
  if (deleteBtn) deleteBtn.hidden = !snippet          // Delete only in edit mode
  setStatus('')
  panelEl.classList.add('open')
  // Defer listener attach so the click that opened the panel isn't read
  // as an outside-click that immediately closes it.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKeydown)
    ;(snippet ? bodyInput : triggerInput)?.focus()
  }, 0)
}

function closePanel() {
  if (!panelEl) return
  panelEl.classList.remove('open')
  editingTrigger = null
  document.removeEventListener('mousedown', onOutside)
  document.removeEventListener('keydown', onKeydown)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closePanel() }
}

// Close on any click outside the panel. The Add button and table rows
// open/repopulate the panel themselves, so they're excluded — otherwise
// the panel would animate out and straight back in. Switching views via
// the top-nav is an outside click, so the panel tidies itself away.
function onOutside(e: MouseEvent) {
  if (!panelEl) return
  const t = e.target as HTMLElement
  if (panelEl.contains(t) || t.closest('.snip-add') || t.closest('#snippets-tbody tr')) return
  closePanel()
}

async function putSnippets(list: Snippet[]): Promise<Snippet[]> {
  const res = await fetch('/api/snippets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippets: list }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data.snippets as Snippet[]
}

async function save() {
  if (!triggerInput || !bodyInput || !saveBtn) return
  const trigger = triggerInput.value.trim()
  const replace = bodyInput.value
  if (!trigger) { setStatus('Trigger is required.', 'error'); triggerInput.focus(); return }
  if (!replace.trim()) { setStatus('Snippet body is required.', 'error'); bodyInput.focus(); return }
  // Build the next list, preserving order: edit replaces in place, add
  // appends.
  const next = editingTrigger != null
    ? snippets.map((s) => (s.trigger === editingTrigger ? { trigger, replace } : s))
    : [...snippets, { trigger, replace }]
  // Local uniqueness guard (the server enforces it too) for an instant message.
  if (next.filter((s) => s.trigger === trigger).length > 1) {
    setStatus(`A snippet with trigger "${trigger}" already exists.`, 'error')
    return
  }
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    snippets = await putSnippets(next)
    renderRows()
    closePanel()
  } catch (err) {
    setStatus((err as Error).message || 'Failed to save.', 'error')
  } finally {
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

async function del() {
  if (editingTrigger == null || !deleteBtn) return
  const next = snippets.filter((s) => s.trigger !== editingTrigger)
  deleteBtn.disabled = true
  try {
    snippets = await putSnippets(next)
    renderRows()
    closePanel()
  } catch (err) {
    setStatus((err as Error).message || 'Failed to delete.', 'error')
  } finally {
    deleteBtn.disabled = false
  }
}

function attachHandlers() {
  viewEl.querySelector('.snip-add')!.addEventListener('click', () => openPanel(null))
  const tbody = viewEl.querySelector<HTMLTableSectionElement>('#snippets-tbody')!
  tbody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-trigger]')
    if (!tr) return
    const s = snippets.find((x) => x.trigger === tr.dataset.trigger)
    if (s) openPanel(s)
  })
}

async function fetchSnippets() {
  try {
    const res = await fetch('/api/snippets')
    if (!res.ok) return
    const data = await res.json()
    snippets = Array.isArray(data.snippets) ? data.snippets : []
    espansoOk = data.espansoDetected !== false
  } catch { /* leave list empty — the view still renders */ }
}

export async function initSnippetsView() {
  viewEl = document.getElementById('view-snippets')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    attachHandlers()
  }
  await fetchSnippets()
  renderRows()
}
