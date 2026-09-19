import { createMemoriesEditor, readChatMemories, writeChatMemories } from '../chat-memories'

const OPEN_KEY = 'poise-chat-memories-open'
/** One pane for all sessions, kept mounted while the transcript streams. */
export function createMemoriesPane(view: HTMLElement, onChange: () => void) {
  let store: Storage | undefined
  try { store = sessionStorage } catch { /* storage may be disabled */ }
  const editor = createMemoriesEditor({ read: readChatMemories, write: writeChatMemories, store })
  const el = document.createElement('aside')
  el.id = 'chat-memories-pane'
  el.className = 'chat-memories-pane'
  el.setAttribute('aria-label', 'Memories')
  el.innerHTML = `<div class="chat-memories-inner">
    <div class="chat-memories-heading"><label for="chat-memories-text">Memories</label><button type="button" class="chat-icon-btn chat-memories-close" aria-label="Close memories" title="Close memories">×</button></div>
    <p class="chat-memories-help">Included last in every Chat message, across sessions and agents. Closing this pane keeps them active.</p>
    <textarea id="chat-memories-text" class="chat-memories-text" aria-label="Memories text" spellcheck="false" placeholder="What should every agent remember?"></textarea>
    <div class="chat-memories-footer"><span class="chat-memories-status" role="status"></span><button type="button" class="chat-h-btn chat-memories-retry" hidden>Retry save</button></div>
  </div>`
  const input = el.querySelector<HTMLTextAreaElement>('textarea')!
  const status = el.querySelector<HTMLElement>('.chat-memories-status')!
  const retry = el.querySelector<HTMLButtonElement>('.chat-memories-retry')!
  let open = false
  try { open = localStorage.getItem(OPEN_KEY) === 'true' } catch { /* optional preference */ }
  function render() {
    const state = editor.state
    if (input.value !== state.text) input.value = state.text
    input.disabled = !state.loaded
    status.textContent = state.error ? `Not saved — ${state.error}` : state.saving ? 'Saving…' : state.loading ? 'Loading…' : state.dirty ? 'Unsaved changes' : state.loaded ? 'Saved automatically' : ''
    status.classList.toggle('error', !!state.error)
    retry.hidden = !state.error
    retry.disabled = state.saving || state.loading
    if (state.loaded && !state.dirty && !state.saving) window.dispatchEvent(new Event('poise:memories-saved'))
    onChange()
  }
  function visibility(focus = false) {
    view.classList.toggle('chat-memories-open', open)
    if (!open && el.contains(document.activeElement)) view.querySelector<HTMLButtonElement>('.chat-h-memories')?.focus()
    el.inert = !open
    el.setAttribute('aria-hidden', String(!open))
    try { localStorage.setItem(OPEN_KEY, String(open)) } catch { /* optional preference */ }
    if (open) void editor.load(true).then(() => { if (open && focus) input.focus({ preventScroll: true }) }).catch(() => undefined)
    onChange()
  }
  function close() { open = false; visibility(); void editor.flush().catch(() => undefined) }
  input.addEventListener('input', () => editor.edit(input.value))
  el.querySelector('button')!.addEventListener('click', close)
  el.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close() } })
  retry.addEventListener('click', () => { void editor.retry().catch(() => undefined) })
  window.addEventListener('focus', () => { if (open) void editor.load(true).catch(() => undefined) })
  window.addEventListener('beforeunload', event => {
    if (editor.state.dirty || editor.state.saving) { event.preventDefault(); event.returnValue = '' }
  })
  editor.subscribe(render)
  render()
  return {
    el, editor,
    get open() { return open },
    mount() { visibility(); if (editor.state.dirty) void editor.flush().catch(() => undefined) },
    toggle() { open = !open; visibility(open); if (!open) void editor.flush().catch(() => undefined) },
  }
}
