// Snippets — manage espanso text-expansion pairs from Poise.
//
// Same table contract as Behaviors / Swarm (the universal `table` /
// `thead th` / `tbody tr` rules do the layout). Editing is inline,
// mirroring Swarm's row expansion: clicking a row toggles a sibling
// expand row beneath it, with the same chevron cue (`.expand-btn` +
// CHEV_SVG, rotated via `.open`). Unlike Swarm's read-only response
// view, this expand row is an editor — trigger + body fields with Save
// and Delete. One row open at a time. The list lives in espanso's
// match/poise.yml (see server/snippets.ts): Poise rewrites the whole set
// on each save and espanso hot-reloads, so a `;trigger` goes live at once.

interface Snippet { trigger: string; replace: string }

let viewEl: HTMLElement
let tbodyEl: HTMLTableSectionElement
let initialized = false
let snippets: Snippet[] = []
let espansoOk = true

// Chevron — identical to Swarm's (src/views/swarm-view.ts). Points right
// when collapsed, rotates 90° via `.expand-btn.open .chev`.
const CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// Attribute-safe HTML escape — same helper the other views carry.
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
            <th class="col-action"></th>
          </tr>
        </thead>
        <tbody id="snippets-tbody"></tbody>
      </table>
      <p class="snip-empty" hidden>No snippets yet. Add one to create your first <code>;trigger</code>.</p>
    </main>
  `
}

// First non-empty line of the body — the row stays one calm line; the
// full text lives in the expanded editor.
function previewLine(body: string): string {
  return body.split('\n').map((l) => l.trim()).find((l) => l) || ''
}

function renderRow(s: Snippet): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'snip-row'
  tr.dataset.trigger = s.trigger
  tr.innerHTML = `
    <td class="title-cell"><span class="snip-trigger">${escapeHtml(s.trigger)}</span></td>
    <td><span class="snip-preview">${escapeHtml(previewLine(s.replace))}</span></td>
    <td class="action-cell"><button type="button" class="expand-btn" title="Edit" aria-label="Edit snippet">${CHEV_SVG}</button></td>
  `
  return tr
}

function renderRows() {
  tbodyEl.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const s of snippets) frag.appendChild(renderRow(s))
  tbodyEl.appendChild(frag)

  const n = snippets.length
  viewEl.querySelector('#snippets-count')!.textContent = n ? `${n} snippet${n === 1 ? '' : 's'}` : ''
  viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = n === 0
  viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = n > 0
  viewEl.querySelector<HTMLElement>('.snip-espanso-hint')!.hidden = espansoOk
}

// ── inline edit row (expand-to-edit) ──────────────────────────────────────
function setStatus(el: HTMLElement | null, text: string, cls: 'info' | 'ok' | 'error' = 'info') {
  if (!el) return
  el.textContent = text
  el.className = `st-help st-help-${cls} snip-status`
}

function buildEditRow(snip: Snippet | null, isDraft: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'snip-expand-row'
  tr.innerHTML = `
    <td colspan="3">
      <div class="snip-edit">
        <input type="text" class="st-input snip-trigger-input" placeholder=";hello" autocomplete="off" spellcheck="false" />
        <textarea class="st-input snip-body-input" placeholder="The text that replaces the trigger…" spellcheck="false"></textarea>
        <div class="st-row">
          <button type="button" class="st-save snip-save">Save</button>
          <button type="button" class="st-clear snip-delete">${isDraft ? 'Discard' : 'Delete'}</button>
          <span class="st-help st-help-info snip-status" role="status"></span>
        </div>
      </div>
    </td>
  `
  const triggerInput = tr.querySelector<HTMLInputElement>('.snip-trigger-input')!
  const bodyInput = tr.querySelector<HTMLTextAreaElement>('.snip-body-input')!
  // Seed via .value (not inline HTML) to dodge the textarea leading-newline quirk.
  triggerInput.value = snip?.trigger ?? ''
  bodyInput.value = snip?.replace ?? ''

  tr.querySelector('.snip-save')!.addEventListener('click', () => void save(tr))
  tr.querySelector('.snip-delete')!.addEventListener('click', () => void del(tr))
  // Escape collapses (discard); ⌘/Ctrl+↵ saves; plain Enter in the
  // trigger jumps to the body (which keeps Enter for newlines).
  triggerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); collapseOpen(); return }
    if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) void save(tr); else bodyInput.focus() }
  })
  bodyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); collapseOpen(); return }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(tr) }
  })
  return tr
}

// Collapse whatever row is open: remove its expand row, un-rotate the
// chevron, and discard the draft main row if that's what was open.
function collapseOpen() {
  const editRow = tbodyEl.querySelector('.snip-expand-row')
  if (!editRow) return
  const main = editRow.previousElementSibling as HTMLElement | null
  editRow.remove()
  if (main) {
    main.querySelector('.expand-btn')?.classList.remove('open')
    if (main.classList.contains('snip-draft')) main.remove()
  }
}

function onTbodyClick(e: MouseEvent) {
  // Only main rows toggle. Clicks inside the expand row (inputs/buttons)
  // have no `tr.snip-row` ancestor, so they never collapse the editor.
  const main = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr.snip-row')
  if (!main || !tbodyEl.contains(main)) return
  const sibling = main.nextElementSibling
  const isOpen = !!sibling && sibling.classList.contains('snip-expand-row')
  collapseOpen()
  if (isOpen) return                                   // clicked the open row → toggled closed
  const isDraft = main.classList.contains('snip-draft')
  const snip = isDraft ? null : (snippets.find((s) => s.trigger === main.dataset.trigger) || null)
  const editRow = buildEditRow(snip, isDraft)
  main.insertAdjacentElement('afterend', editRow)
  main.querySelector('.expand-btn')?.classList.add('open')
  // Existing snippet → land in the body; draft/add → land in the trigger.
  const focusSel = snip ? '.snip-body-input' : '.snip-trigger-input'
  ;(editRow.querySelector(focusSel) as HTMLElement | null)?.focus()
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

async function save(editRow: HTMLTableRowElement) {
  const main = editRow.previousElementSibling as HTMLElement | null
  const isDraft = !!main?.classList.contains('snip-draft')
  const editingTrigger = isDraft ? null : (main?.dataset.trigger ?? null)
  const triggerInput = editRow.querySelector<HTMLInputElement>('.snip-trigger-input')!
  const bodyInput = editRow.querySelector<HTMLTextAreaElement>('.snip-body-input')!
  const status = editRow.querySelector<HTMLElement>('.snip-status')
  const trigger = triggerInput.value.trim()
  const replace = bodyInput.value
  if (!trigger) { setStatus(status, 'Trigger is required.', 'error'); triggerInput.focus(); return }
  if (!replace.trim()) { setStatus(status, 'Snippet body is required.', 'error'); bodyInput.focus(); return }
  // Preserve order: edit replaces in place, add appends.
  const next = editingTrigger != null
    ? snippets.map((s) => (s.trigger === editingTrigger ? { trigger, replace } : s))
    : [...snippets, { trigger, replace }]
  if (next.filter((s) => s.trigger === trigger).length > 1) {
    setStatus(status, `A snippet with trigger "${trigger}" already exists.`, 'error')
    return
  }
  const saveBtn = editRow.querySelector<HTMLButtonElement>('.snip-save')!
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    snippets = await putSnippets(next)
    renderRows()                                       // rebuild collapses the (transient) edit row
  } catch (err) {
    setStatus(status, (err as Error).message || 'Failed to save.', 'error')
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

async function del(editRow: HTMLTableRowElement) {
  const main = editRow.previousElementSibling as HTMLElement | null
  const editingTrigger = main?.dataset.trigger ?? null
  // Draft (never saved) or somehow unkeyed → just discard, no server call.
  if (main?.classList.contains('snip-draft') || editingTrigger == null) { collapseOpen(); return }
  const next = snippets.filter((s) => s.trigger !== editingTrigger)
  const delBtn = editRow.querySelector<HTMLButtonElement>('.snip-delete')!
  delBtn.disabled = true
  try {
    snippets = await putSnippets(next)
    renderRows()
  } catch (err) {
    setStatus(editRow.querySelector<HTMLElement>('.snip-status'), (err as Error).message || 'Failed to delete.', 'error')
    delBtn.disabled = false
  }
}

// "Add snippet" → a draft main row pinned at the top, opened in edit mode.
// A second click on it / Escape / Discard removes it. One draft at a time.
function openAdd() {
  const existingDraft = tbodyEl.querySelector<HTMLElement>('tr.snip-draft')
  if (existingDraft) {
    ;(existingDraft.nextElementSibling?.querySelector('.snip-trigger-input') as HTMLElement | null)?.focus()
    return
  }
  collapseOpen()
  // The table is hidden while the saved list is empty — show it for the draft.
  viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = false
  viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = true
  const main = document.createElement('tr')
  main.className = 'snip-row snip-draft'
  main.innerHTML = `
    <td class="title-cell"><span class="snip-draft-label">New snippet</span></td>
    <td><span class="snip-preview"></span></td>
    <td class="action-cell"><button type="button" class="expand-btn open" title="Edit" aria-label="Edit snippet">${CHEV_SVG}</button></td>
  `
  tbodyEl.insertBefore(main, tbodyEl.firstChild)
  const editRow = buildEditRow(null, true)
  main.insertAdjacentElement('afterend', editRow)
  ;(editRow.querySelector('.snip-trigger-input') as HTMLElement | null)?.focus()
}

function attachHandlers() {
  viewEl.querySelector('.snip-add')!.addEventListener('click', openAdd)
  tbodyEl.addEventListener('click', onTbodyClick)
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
    tbodyEl = viewEl.querySelector<HTMLTableSectionElement>('#snippets-tbody')!
    attachHandlers()
  }
  await fetchSnippets()
  renderRows()
}
