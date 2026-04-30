// Pipe — five-lane kanban board. Cards persist in SQLite via /api/pipe.

type Lane = 'idea' | 'concept' | 'plan' | 'issue' | 'pr'
const LANES: Array<{ key: Lane; label: string }> = [
  { key: 'idea',    label: 'Idea' },
  { key: 'concept', label: 'Concept' },
  { key: 'plan',    label: 'Plan' },
  { key: 'issue',   label: 'Issue' },
  { key: 'pr',      label: 'PR' },
]

interface Card {
  id: number
  text: string
  lane: Lane
  position: number
  created_at: string
  updated_at: string
}

let initialized = false
let cards: Card[] = []
let dragId: number | null = null
let viewEl: HTMLElement

function escapeHtml(s: string): string {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML
}

function laneEl(lane: Lane): HTMLElement {
  return viewEl.querySelector(`.lane[data-lane="${lane}"]`)!
}

function laneListEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-list')!
}

function laneCountEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-count')!
}

function cardsInLane(lane: Lane): Card[] {
  return cards.filter((c) => c.lane === lane).sort((a, b) => a.position - b.position)
}

function renderShell(): string {
  const lanes = LANES.map((l) => `
    <section class="lane" data-lane="${l.key}">
      <header class="lane-header">
        <span class="lane-title">${l.label}</span>
        <span class="lane-count">0</span>
      </header>
      <div class="lane-list" data-lane="${l.key}"></div>
      <button class="lane-add" data-lane="${l.key}">+ Add a card</button>
    </section>
  `).join('')
  return `
    <header class="view-header">
      <div class="view-title">Pipe <span class="view-sub">five lanes, drag to move</span></div>
    </header>
    <div class="kanban">${lanes}</div>
  `
}

function renderCard(card: Card): HTMLElement {
  const el = document.createElement('article')
  el.className = 'card'
  el.draggable = true
  el.dataset.id = String(card.id)
  el.dataset.lane = card.lane
  el.innerHTML = `
    <div class="card-text">${escapeHtml(card.text).replace(/\n/g, '<br>')}</div>
    <button class="card-delete" title="Delete card" aria-label="Delete card">×</button>
  `
  return el
}

function renderAllCards() {
  for (const lane of LANES) {
    const list = laneListEl(lane.key)
    list.innerHTML = ''
    const items = cardsInLane(lane.key)
    for (const c of items) list.appendChild(renderCard(c))
    laneCountEl(lane.key).textContent = String(items.length)
  }
}

async function fetchCards() {
  const res = await fetch('/api/pipe')
  if (!res.ok) throw new Error(`/api/pipe ${res.status}`)
  const data = await res.json()
  cards = data.cards
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
  return res.json()
}

// ── Add card ─────────────────────────────────────────────────────────────────

function attachAddHandlers() {
  for (const l of LANES) {
    const btn = laneEl(l.key).querySelector<HTMLButtonElement>('.lane-add')!
    btn.addEventListener('click', () => openComposer(l.key))
  }
}

function openComposer(lane: Lane) {
  const laneNode = laneEl(lane)
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    (existing.querySelector('textarea') as HTMLTextAreaElement | null)?.focus()
    return
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  const composer = document.createElement('div')
  composer.className = 'composer'
  composer.innerHTML = `
    <textarea rows="3" placeholder="Write a card..." spellcheck="true"></textarea>
    <div class="composer-row">
      <button class="composer-add">Add</button>
      <button class="composer-cancel" type="button">Cancel</button>
      <span class="composer-hint">⌘↵ to add</span>
    </div>
  `
  laneNode.insertBefore(composer, addBtn)
  const ta = composer.querySelector<HTMLTextAreaElement>('textarea')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!

  const close = () => { composer.remove(); addBtn.hidden = false }
  const submit = async () => {
    const text = ta.value.trim()
    if (!text) { close(); return }
    addB.disabled = true
    try {
      const card = await api<Card>('POST', '/api/pipe', { text, lane })
      cards.push(card)
      renderAllCards()
      close()
    } catch (err) {
      addB.disabled = false
      console.error(err)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  })
  ta.focus()
}

// ── Edit card (click to edit) ────────────────────────────────────────────────

function startEdit(cardEl: HTMLElement) {
  if (cardEl.classList.contains('editing')) return
  const id = Number(cardEl.dataset.id)
  const card = cards.find((c) => c.id === id)
  if (!card) return
  cardEl.classList.add('editing')
  cardEl.draggable = false

  const original = card.text
  const wrapper = document.createElement('div')
  wrapper.className = 'card-edit'
  wrapper.innerHTML = `
    <textarea rows="3" spellcheck="true"></textarea>
    <div class="composer-row">
      <button class="composer-add">Save</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  const ta = wrapper.querySelector<HTMLTextAreaElement>('textarea')!
  ta.value = original

  const textNode = cardEl.querySelector<HTMLElement>('.card-text')!
  const deleteBtn = cardEl.querySelector<HTMLButtonElement>('.card-delete')!
  textNode.hidden = true
  deleteBtn.hidden = true
  cardEl.appendChild(wrapper)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  const close = () => {
    cardEl.classList.remove('editing')
    cardEl.draggable = true
    wrapper.remove()
    textNode.hidden = false
    deleteBtn.hidden = false
  }
  const save = async () => {
    const text = ta.value.trim()
    if (!text || text === original) { close(); return }
    try {
      const updated = await api<Card>('PATCH', `/api/pipe/${id}`, { text })
      const idx = cards.findIndex((c) => c.id === id)
      if (idx >= 0) cards[idx] = updated
      renderAllCards()
    } catch (err) {
      console.error(err)
      close()
    }
  }

  wrapper.querySelector<HTMLButtonElement>('.composer-add')!.addEventListener('click', save)
  wrapper.querySelector<HTMLButtonElement>('.composer-cancel')!.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
  })
}

// ── Delete ───────────────────────────────────────────────────────────────────

async function deleteCard(id: number) {
  await api('DELETE', `/api/pipe/${id}`)
  cards = cards.filter((c) => c.id !== id)
  renderAllCards()
}

// ── Drag and drop ────────────────────────────────────────────────────────────

let dropIndicator: HTMLElement | null = null

function ensureIndicator(): HTMLElement {
  if (!dropIndicator) {
    dropIndicator = document.createElement('div')
    dropIndicator.className = 'drop-indicator'
  }
  return dropIndicator
}

function clearIndicator() {
  if (dropIndicator) dropIndicator.remove()
}

// Compute the insertion index in `list` for a pointer at clientY,
// excluding the card currently being dragged (so the indicator never
// renders adjacent to the moving card itself).
function insertionIndex(list: HTMLElement, clientY: number): number {
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card')]
    .filter((c) => Number(c.dataset.id) !== dragId)
  for (let i = 0; i < cardsInList.length; i++) {
    const rect = cardsInList[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return cardsInList.length
}

function placeIndicator(list: HTMLElement, index: number) {
  const indicator = ensureIndicator()
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card')]
    .filter((c) => Number(c.dataset.id) !== dragId)
  if (index >= cardsInList.length) {
    list.appendChild(indicator)
  } else {
    list.insertBefore(indicator, cardsInList[index])
  }
}

function attachDragHandlers() {
  // Card-level events (delegated to the kanban so newly-added cards are covered)
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!

  kanban.addEventListener('dragstart', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    if (!cardEl || cardEl.classList.contains('editing')) {
      e.preventDefault()
      return
    }
    dragId = Number(cardEl.dataset.id)
    cardEl.classList.add('dragging')
    e.dataTransfer?.setData('text/plain', String(dragId))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })

  kanban.addEventListener('dragend', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    cardEl?.classList.remove('dragging')
    dragId = null
    clearIndicator()
  })

  // Lane-list-level events (where the drop happens)
  for (const l of LANES) {
    const list = laneListEl(l.key)
    list.addEventListener('dragover', (e) => {
      if (dragId === null) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const idx = insertionIndex(list, e.clientY)
      placeIndicator(list, idx)
    })
    list.addEventListener('dragleave', (e) => {
      // Only clear when actually leaving the list (not when entering a child)
      const related = e.relatedTarget as Node | null
      if (related && list.contains(related)) return
      clearIndicator()
    })
    list.addEventListener('drop', async (e) => {
      e.preventDefault()
      if (dragId === null) return
      const movingId = dragId
      const targetLane = l.key
      const idx = insertionIndex(list, e.clientY)
      clearIndicator()

      // Optimistic local update
      const moving = cards.find((c) => c.id === movingId)
      if (!moving) return
      const sourceLane = moving.lane
      const sameLane = sourceLane === targetLane

      // Re-sequence positions locally so a re-render reflects the drop instantly
      const targets = cards.filter((c) => c.lane === targetLane && c.id !== movingId)
        .sort((a, b) => a.position - b.position)
      targets.splice(Math.min(idx, targets.length), 0, moving)
      targets.forEach((c, i) => { c.position = i; c.lane = targetLane })

      if (!sameLane) {
        const sources = cards.filter((c) => c.lane === sourceLane && c.id !== movingId)
          .sort((a, b) => a.position - b.position)
        sources.forEach((c, i) => { c.position = i })
      }
      renderAllCards()

      try {
        await api('PATCH', `/api/pipe/${movingId}`, { lane: targetLane, position: idx })
      } catch (err) {
        console.error('move failed:', err)
        // Refetch to recover from server-state divergence
        try { await fetchCards(); renderAllCards() } catch { /* ignore */ }
      }
    })
  }
}

// ── Card-level click delegation (edit / delete) ──────────────────────────────

function attachCardClickHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!
  kanban.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const delBtn = target.closest<HTMLElement>('.card-delete')
    if (delBtn) {
      e.stopPropagation()
      const cardEl = delBtn.closest<HTMLElement>('.card')!
      const id = Number(cardEl.dataset.id)
      try { await deleteCard(id) } catch (err) { console.error(err) }
      return
    }
    const cardEl = target.closest<HTMLElement>('.card')
    if (!cardEl) return
    if (cardEl.classList.contains('editing')) return
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
    startEdit(cardEl)
  })
}

export async function initPipeView() {
  viewEl = document.getElementById('view-pipe')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    attachAddHandlers()
    attachDragHandlers()
    attachCardClickHandlers()
  }
  try {
    await fetchCards()
    renderAllCards()
  } catch (err) {
    console.error('[pipe] failed to load:', err)
  }
}
