import type { AgentInfo } from '../chat-client'
import { consoleModelLabel } from '../chat-catalog'

interface ModelChoice { identity: string, label: string, available: boolean, reason?: string }
interface Handlers { load(): Promise<AgentInfo[]>, choose(identity: string): void, changed(): void }

/** The /model extension shares the history layout and keeps focus in the input. */
export function createCommandModels(input: HTMLTextAreaElement, handlers: Handlers) {
  const el = document.createElement('section')
  el.className = 'chat-message-history chat-command-models'
  el.hidden = true
  el.setAttribute('aria-label', 'Choose a model')
  el.innerHTML = '<div class="chat-history-heading"><span>Models</span><span class="chat-history-count"></span><span class="chat-history-help">↑↓ select · Enter choose · Esc close</span></div>'
    + '<div class="chat-history-state" role="status" hidden></div><button type="button" class="chat-command-model-retry" hidden>Try again</button>'
    + '<div id="chat-command-model-list" class="chat-history-list" role="listbox" aria-label="Models"></div>'
  const list = el.querySelector<HTMLElement>('.chat-history-list')!
  const status = el.querySelector<HTMLElement>('[role="status"]')!
  const retry = el.querySelector<HTMLButtonElement>('.chat-command-model-retry')!
  let choices: ModelChoice[] = [], visible: ModelChoice[] = []
  let index = -1, generation = 0
  let query = '', current = '', loading = false, error = false
  function select(next: number): void {
    index = next
    for (let i = 0; i < list.children.length; i++) {
      const row = list.children[i] as HTMLElement
      row.setAttribute('aria-selected', String(i === index))
      row.classList.toggle('active', i === index)
    }
    const row = list.children[index] as HTMLElement | undefined
    if (!row) { input.removeAttribute('aria-activedescendant'); return }
    input.setAttribute('aria-activedescendant', row.id)
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
  }
  function render(): void {
    const selected = visible[index]?.identity || current
    const normalized = query.toLowerCase().replace(/[-_]/g, ' ')
    visible = choices.filter(choice => `${choice.identity} ${choice.label}`.toLowerCase().replace(/[-_]/g, ' ').includes(normalized))
    list.replaceChildren()
    visible.forEach((choice, i) => {
      const row = document.createElement('button')
      row.type = 'button'; row.tabIndex = -1; row.id = `chat-command-model-${i}`
      row.className = 'chat-history-item chat-command-model-option'
      row.dataset.identity = choice.identity; row.dataset.index = String(i)
      row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(!choice.available))
      row.textContent = `${choice.label}${choice.available ? '' : ' · Unavailable'}`
      row.title = choice.reason || choice.identity
      list.appendChild(row)
    })
    el.querySelector('.chat-history-count')!.textContent = visible.length ? String(visible.length) : ''
    status.textContent = loading ? 'Loading models…' : error ? 'Could not load the catalogue.' : 'No matching models.'
    status.hidden = !loading && !error && visible.length > 0
    retry.hidden = !error; list.hidden = loading || error || !visible.length
    list.setAttribute('aria-busy', String(loading))
    const wanted = visible.findIndex(choice => choice.available && choice.identity === selected)
    select(wanted >= 0 ? wanted : visible.findIndex(choice => choice.available))
    handlers.changed()
  }
  function close(): void {
    generation++
    if (el.hidden) return
    el.hidden = true; loading = false
    input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-controls')
    handlers.changed()
  }
  async function load(): Promise<void> {
    const request = ++generation
    loading = true; error = false; choices = []; render()
    try {
      const agents = await handlers.load()
      if (el.hidden || generation !== request) return
      choices = agents.flatMap(agent => agent.models.map(model => ({ identity: model.identity,
        label: `${agent.label} · ${consoleModelLabel(model.identity, model.effort)}`, available: agent.available, reason: agent.reason })))
    } catch { if (generation !== request || el.hidden) return; error = true }
    loading = false; render()
  }
  function choose(): void {
    const selected = visible[index]
    if (loading || error || !selected?.available) return
    close(); handlers.choose(selected.identity); input.focus({ preventScroll: true })
  }
  el.addEventListener('mousedown', event => event.preventDefault())
  el.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]')
    if (row) { index = Number(row.dataset.index); choose() }
  })
  retry.addEventListener('click', () => { input.focus({ preventScroll: true }); void load() })
  document.addEventListener('pointerdown', event => { if (event.target !== input && !el.contains(event.target as Node)) close() })
  input.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== input && !el.contains(document.activeElement)) close() }, 0) })
  return {
    el, close,
    get open() { return !el.hidden },
    get fixedHeight() { return el.querySelector<HTMLElement>('.chat-history-heading')!.offsetHeight + (status.hidden ? 0 : status.offsetHeight) + (retry.hidden ? 0 : retry.offsetHeight) + 10 },
    get rowsHeight() { return list.scrollHeight },
    setAvailableHeight(pixels: number) { el.style.setProperty('--chat-history-available', `${Math.max(0, Math.floor(pixels))}px`); select(index) },
    show(nextQuery: string, identity: string): void {
      query = nextQuery; current = identity
      if (el.hidden) { el.hidden = false; input.setAttribute('aria-controls', list.id); void load() }
      else render()
    },
    key(event: KeyboardEvent): boolean {
      if (el.hidden || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      if (event.key === 'Escape') { event.preventDefault(); close(); return true }
      // Tab selects a ready choice, but must never trap focus in an empty,
      // loading or failed picker. Let normal keyboard navigation continue.
      if (event.key === 'Tab' && (loading || error || !visible[index]?.available)) { close(); return false }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab'].includes(event.key)) return false
      event.preventDefault()
      if (event.key === 'Enter' || event.key === 'Tab') { choose(); return true }
      const indices = visible.flatMap((choice, i) => choice.available ? [i] : [])
      if (!indices.length) return true
      const at = indices.indexOf(index)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? indices.length - 1
        : (at + (event.key === 'ArrowUp' ? -1 : 1) + indices.length) % indices.length
      select(indices[next]); return true
    },
  }
}
