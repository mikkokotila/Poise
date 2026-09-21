import { MESSAGE_HISTORY_LIMIT, historyLabel, type MessageHistoryEntry, type MessageHistorySnapshot } from '../chat-message-history'

interface HistoryHandlers {
  read(): MessageHistorySnapshot
  recall(entry: MessageHistoryEntry): void
  changed(): void
}

/** A selection list, not a second composer. Focus stays in the textarea and
 *  navigation never submits or replaces a draft. The snapshot stays stable
 *  during streaming; a still-loading transcript is filled when it arrives. */
export function createMessageHistory(input: HTMLTextAreaElement, handlers: HistoryHandlers) {
  const el = document.createElement('section')
  el.className = 'chat-message-history'
  el.hidden = true
  el.setAttribute('aria-label', 'Recent messages')
  el.innerHTML = `<div class="chat-history-heading"><span>Message history</span><span class="chat-history-count"></span>
    <span id="chat-history-help" class="chat-history-help">↑↓ select · Enter recall · Esc close</span></div>
    <div class="chat-history-state" role="status" hidden></div>
    <div id="chat-message-history-list" class="chat-history-list" role="listbox" aria-label="Message history"></div>`
  const list = el.querySelector<HTMLElement>('.chat-history-list')!
  const status = el.querySelector<HTMLElement>('.chat-history-state')!
  const count = el.querySelector<HTMLElement>('.chat-history-count')!
  const heading = el.querySelector<HTMLElement>('.chat-history-heading')!
  let entries: MessageHistoryEntry[] = []
  let index = -1
  let loading = false

  function select(next: number): void {
    index = next
    for (let i = 0; i < list.children.length; i++) {
      const row = list.children[i] as HTMLElement
      row.setAttribute('aria-selected', String(i === index))
      row.classList.toggle('active', i === index)
    }
    const row = list.children[index] as HTMLElement | undefined
    if (row) {
      input.setAttribute('aria-activedescendant', row.id)
      // Scroll only this list, never the conversation or the whole window.
      const top = row.offsetTop
      if (top < list.scrollTop) list.scrollTop = top
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight
    } else input.removeAttribute('aria-activedescendant')
  }
  function fill(snapshot: MessageHistorySnapshot): void {
    loading = !!snapshot.loading
    entries = loading ? [] : snapshot.entries.slice(-MESSAGE_HISTORY_LIMIT)
    list.replaceChildren()
    entries.forEach((entry, i) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.tabIndex = -1
      row.className = 'chat-history-item'
      row.id = `chat-history-option-${i}`
      row.dataset.index = String(i)
      row.setAttribute('role', 'option')
      const label = historyLabel(entry)
      row.textContent = label
      row.title = label
      list.appendChild(row)
    })
    count.textContent = entries.length ? String(entries.length) : ''
    status.textContent = loading ? 'Loading message history…' : snapshot.error ? `Cannot load history — ${snapshot.error}` : 'No messages in this conversation yet.'
    status.hidden = entries.length > 0
    list.hidden = !entries.length
    list.setAttribute('aria-busy', String(loading))
    select(entries.length - 1)
    handlers.changed()
  }
  function close(): void {
    if (el.hidden) return
    el.hidden = true
    entries = []; index = -1; loading = false
    list.replaceChildren()
    input.removeAttribute('aria-activedescendant')
    input.removeAttribute('aria-controls')
    input.removeAttribute('aria-describedby')
    handlers.changed()
  }
  function recall(): void {
    const entry = entries[index]
    if (!entry) return
    close()
    handlers.recall(entry)
    input.focus({ preventScroll: true })
  }
  el.addEventListener('mousedown', event => event.preventDefault())
  el.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.chat-history-item')
    if (!row) return
    index = Number(row.dataset.index)
    recall()
  })
  document.addEventListener('pointerdown', event => {
    if (event.target !== input && !el.contains(event.target as Node)) close()
  })
  input.addEventListener('blur', () => {
    setTimeout(() => { if (document.activeElement !== input && !el.contains(document.activeElement)) close() }, 0)
  })
  return {
    el, close,
    get open() { return !el.hidden },
    get fixedHeight() { return heading.offsetHeight + (status.hidden ? 0 : status.offsetHeight) + 10 },
    get rowsHeight() { return list.scrollHeight },
    setAvailableHeight(pixels: number) {
      const value = `${Math.max(0, Math.floor(pixels))}px`
      if (el.style.getPropertyValue('--chat-history-available') === value) return
      el.style.setProperty('--chat-history-available', value)
      if (!el.hidden) select(index)
    },
    refresh() { if (!el.hidden && loading) { const snapshot = handlers.read(); if (!snapshot.loading) fill(snapshot) } },
    key(event: KeyboardEvent, canOpen: boolean): boolean {
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      if (el.hidden) {
        if (event.key !== 'ArrowUp' || !canOpen) return false
        event.preventDefault()
        el.hidden = false
        input.setAttribute('aria-controls', list.id)
        input.setAttribute('aria-describedby', 'chat-history-help')
        fill(handlers.read())
        return true
      }
      if (event.key === 'Tab') { close(); return false }
      if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Home', 'End'].includes(event.key)) return false
      event.preventDefault()
      if (event.key === 'Escape' || (event.key === 'ArrowDown' && index === entries.length - 1)) close()
      else if (event.key === 'Enter') recall()
      else if (entries.length) select(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
        : event.key === 'ArrowUp' ? Math.max(0, index - 1) : Math.min(entries.length - 1, index + 1))
      return true
    },
  }
}
