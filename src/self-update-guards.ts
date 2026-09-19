// What stands between this tab and a reload onto a new build. Two sources:
// views declaring their own state (`declareUnsavedWork`, `registerReloadGuard`)
// and a reading of the real app DOM for everything undeclared. Every blocker
// has a name; self-update-reload classifies names into unsaved work (blocks
// any reload until it is saved or cleared), operations in flight (an explicit
// Refresh waits for them) and soft states (only an automatic reload waits).
//
// The DOM reading uses the app's actual signals — panels are open only with
// `.open` and are `inert` when closed, the Editor writes its save state into
// `#editor-meta`, Settings' Save button says `Saving…` — and never treats an
// off-screen, closed control as something a person is using. Fields count as
// dirty only after the person typed into them and only while their value still
// differs from what it was when they arrived; the chat composer is excluded
// because its draft is what the snapshot carries across.

export type ReloadGuard = () => string[]
export interface UnsavedState { dirty: boolean, saving?: boolean }

const guards = new Set<ReloadGuard>()
const declared = new Map<string, () => UnsavedState>()

export function registerReloadGuard(guard: ReloadGuard): () => void {
  guards.add(guard)
  return () => { guards.delete(guard) }
}

/** A view with real save state (the Editor's save queue, Settings' dirty set)
 *  reports it here as `unsaved:<source>` / `saving:<source>`; the DOM reading
 *  below stays as the fallback for views that do not. */
export function declareUnsavedWork(source: string, read: () => UnsavedState): () => void {
  declared.set(source, read)
  return () => { if (declared.get(source) === read) declared.delete(source) }
}

// ── DOM reading ──────────────────────────────────────────────────────────

let composing = false
/** Value a field had when the person arrived in it; set on focus, reset on save. */
const baseline = new WeakMap<Element, string>()
const edited = new WeakSet<Element>()
let domInstalled = false

const CLOSED = '[hidden], [inert], [aria-hidden="true"], #settings-panel:not(.open), #typo-panel:not(.open), #chat-panel:not(.open)'
const EXCLUDED_INPUT = 'input[type="search"], .chat-v-composer .chat-input, #editor-doc'

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(el.type)
  return (el as HTMLElement).isContentEditable === true
}

function valueOf(el: Element): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return (el as HTMLElement).textContent || ''
}

function isPresent(el: Element): boolean {
  if (!el.isConnected || el.closest(CLOSED)) return false
  if (!el.getClientRects().length) return false
  return getComputedStyle(el).visibility !== 'hidden'
}

function counts(el: Element | null): el is HTMLElement {
  return isEditable(el) && !el.matches(EXCLUDED_INPUT)
}

function resetBaselines(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('input, textarea, [contenteditable]'))) {
    if (edited.has(el)) baseline.set(el, valueOf(el))
  }
}

/** Listen once for what the reading needs: composition, focus baselines, edits, saves. */
export function installDomGuards(doc: Document = document): void {
  if (domInstalled) return
  domInstalled = true
  doc.addEventListener('compositionstart', () => { composing = true }, true)
  doc.addEventListener('compositionend', () => { composing = false }, true)
  doc.addEventListener('focusin', (e) => {
    const el = e.target as Element | null
    if (counts(el) && !baseline.has(el)) baseline.set(el, valueOf(el))
  }, true)
  doc.addEventListener('input', (e) => {
    const el = e.target as Element | null
    if (!counts(el)) return
    if (!baseline.has(el)) baseline.set(el, '')
    edited.add(el)
  }, true)
  // Settings saved: what is in its fields is now the saved value.
  window.addEventListener('poise:synced', () => {
    const panel = doc.getElementById('settings-panel')
    if (panel) resetBaselines(panel)
  })
}

export function domBlockers(doc: Document = document): string[] {
  const out: string[] = []
  if (composing) out.push('ime')
  const active = doc.activeElement
  if (counts(active) && isPresent(active)) out.push('focused-input')
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('input, textarea, [contenteditable]'))) {
    if (!edited.has(el) || !counts(el) || !isPresent(el)) continue
    if (valueOf(el) !== (baseline.get(el) ?? '')) { out.push('dirty-input'); break }
  }
  for (const card of Array.from(doc.querySelectorAll<HTMLElement>('.chat-question.pending'))) {
    if (!isPresent(card)) continue
    const typed = Array.from(card.querySelectorAll<HTMLInputElement>('.chat-q-text')).some((i) => i.value.trim())
    if (typed || card.querySelector('input:checked')) { out.push('question-form'); break }
  }
  // The Editor's own words about the document, whether or not its view is on
  // screen: a debounced save keeps running after the person left the view.
  const meta = doc.getElementById('editor-meta')?.textContent || ''
  if (/editing|saving|failed|conflict|not saved/i.test(meta)) out.push('editor')
  const saveBtn = doc.querySelector<HTMLElement>('#settings-panel .st-save')
  if (saveBtn?.textContent?.trim() === 'Saving…') out.push('save')
  if (doc.getElementById('settings-panel')?.classList.contains('open')) out.push('settings-open')
  if (doc.getElementById('typo-panel')?.classList.contains('open')) out.push('typography-open')
  if (doc.getElementById('chat-panel')?.classList.contains('open')) out.push('chat-pane-open')
  if (doc.querySelector('dialog[open], .chat-new-dialog:not([hidden])')) out.push('dialog-open')
  return out
}

/** Everything blocking a reload right now, by name, without repeats. */
export function collectBlockers(doc: Document = document): string[] {
  const out = domBlockers(doc)
  const add = (name: string) => { if (!out.includes(name)) out.push(name) }
  for (const [source, read] of declared) {
    try {
      const state = read()
      if (state.dirty) add(`unsaved:${source}`)
      if (state.saving) add(`saving:${source}`)
    } catch { add('guard-error') }
  }
  for (const guard of guards) {
    try { for (const b of guard()) add(b) } catch { add('guard-error') }
  }
  return out
}

/** Names a person can read, for the banner. */
export function describeBlocker(name: string): string {
  const fixed: Record<string, string> = {
    ime: 'text being composed',
    'focused-input': 'the field being edited',
    'dirty-input': 'unsaved text on the page',
    'question-form': 'a half-answered question',
    editor: 'the document being saved',
    save: 'settings being saved',
    'settings-open': 'the open Settings panel',
    'typography-open': 'the open Typography panel',
    'chat-pane-open': 'the open chat pane',
    'dialog-open': 'an open dialog',
    upload: 'an attachment upload',
    command: 'a command awaiting acknowledgement',
    'session-create': 'a session being created',
    'pending-request': 'an unanswered permission or question',
    'poise-change': 'a Poise change being started',
    snapshot: 'saving drafts locally',
    'guard-error': 'a view that could not report its state',
  }
  if (fixed[name]) return fixed[name]
  if (name.startsWith('unsaved:')) return `unsaved ${name.slice(8)} changes`
  if (name.startsWith('saving:')) return `${name.slice(7)} being saved`
  return name
}
