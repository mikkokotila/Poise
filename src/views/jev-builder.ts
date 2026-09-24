import { escapeHtml as esc } from '../markdown'
import { emptyJevDraft, requestFromDraft, draftFromRequest, newQuestion, nextQuestionId, type JevDraft } from '../jev-draft'
import type { Primitive } from '../jev-types'

interface Handlers { models(): Promise<Array<{ name: string; description: string }>>; changed(draft: JevDraft): void; evaluate(): void; preview(): void; example(): void; template(): void }
const names = { noul: 'Yes / no', choice: 'Choose one', score: 'Rate a scale' }
function field(label: string, value: unknown, attrs: string, multiline = false): string {
  if (value !== null && typeof value !== 'string') return `<div class="jev-field"><span>${esc(label)} · structured JSON</span><pre>${esc(JSON.stringify(value, null, 2))}</pre><button type="button" data-action="json" class="st-clear">Edit in JSON</button></div>`
  return `<label class="jev-field">${esc(label)}${multiline ? `<textarea class="st-input" ${attrs}>${esc(String(value ?? ''))}</textarea>` : `<input class="st-input" value="${esc(String(value ?? ''))}" ${attrs}>`}</label>`
}
export function createJevBuilder(handlers: Handlers) {
  const el = document.createElement('div'); el.className = 'jev-builder'
  let current = emptyJevDraft()
  let modelList = [{ name: 'jev-latest', description: 'Latest stable' }, { name: 'jev-preview', description: 'Latest preview' }]
  let modelsLoaded = false, modelsLoading = false
  function changed() { handlers.changed(current) }
  function render(preserve = true) {
    const disclosure = new Map([...el.querySelectorAll<HTMLDetailsElement>('details')].map(d => [`${d.closest<HTMLElement>('[data-q]')?.dataset.q || ''}:${d.className}`, d.open]))
    const focus = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : null
    const focusedField = focus?.dataset.field, question = focus?.closest<HTMLElement>('[data-q]')?.dataset.q
    const raw = current.raw !== null
    el.innerHTML = `<div class="jev-builder-tabs" role="group" aria-label="Builder view"><button type="button" class="st-clear" data-action="build" aria-pressed="${!raw}">Build</button><button type="button" class="st-clear" data-action="json" aria-pressed="${raw}">Request JSON</button><span class="jev-spacer"></span><button type="button" class="st-clear" data-action="example">Try an example</button><button type="button" class="st-clear" data-action="template">Load snippet</button></div>
      <div class="jev-build-error st-help st-help-error" role="alert" hidden></div>
      ${raw ? field('Request JSON', current.raw, 'data-field="raw" aria-label="Request JSON" spellcheck="false"', true) : `<div class="jev-build-canvas"><section class="jev-state-card"><div class="jev-section-heading"><h3>1. State</h3><span>The material to evaluate</span><span class="jev-spacer"></span><button type="button" class="st-clear" data-action="file">Load text file</button><input type="file" class="jev-file" accept=".txt,.md,.json,.csv,.log" hidden></div>
        <div class="jev-builder-tabs"><button type="button" class="st-clear" data-format="text" aria-pressed="${current.format === 'text'}">Text</button><button type="button" class="st-clear" data-format="json" aria-pressed="${current.format === 'json'}">JSON</button></div>
        ${field('State', current.state, 'data-field="state" aria-label="State" placeholder="Paste the message, document or record to evaluate…" spellcheck="false"', true)}</section>
        <section class="jev-question-column"><div class="jev-section-heading"><h3>2. Questions</h3><span>Each one evaluates the same state, independently.</span></div>
        <div class="jev-questions">${current.questions.map((q, i) => `<details class="jev-question" data-q="${i}" ${i < 3 ? 'open' : ''}><summary><span class="chat-pill">${q.type === 'noul' ? 'Noul' : q.type === 'choice' ? 'Choice' : 'Score'}</span> <span>${esc(q.id || 'Untitled question')}</span></summary><div class="jev-question-body">
          <div class="jev-question-top">${field('Answer ID', q.id, 'data-field="id" aria-label="Answer ID" spellcheck="false"')}<label class="jev-field">Primitive<select class="st-select" data-field="type" aria-label="Primitive">${Object.entries(names).map(([type, name]) => `<option value="${type}" ${q.type === type ? 'selected' : ''}>${name} · ${type}</option>`).join('')}</select></label><button type="button" class="st-clear" data-action="duplicate">Duplicate</button><button type="button" class="st-clear" data-action="remove" ${current.questions.length === 1 ? 'disabled' : ''}>Remove</button></div>
          <p class="jev-shape">${q.type === 'noul' ? 'Returns a probability of yes, from 0 to 1.' : q.type === 'choice' ? 'Returns one option, with probabilities and confidence.' : `Returns a score from 0 to ${q.levels.length - 1}, with probabilities and confidence.`}</p>
          ${field('Instructions', q.instructions, 'data-field="instructions" aria-label="Instructions" placeholder="Ask one clear, focused question about the state…"', true)}
          ${q.type === 'noul' ? `<details class="jev-rubric"><summary>Define yes and no <span>optional</span></summary>${field('Yes means', q.yes, 'data-field="yes"')}${field('No means', q.no, 'data-field="no"')}</details>` : ''}
          ${q.type === 'choice' ? `<div class="jev-section-heading"><span>Options · no ranking implied</span></div>${q.options.map((option, n) => `<div class="jev-option" data-option="${n}">${field('Option', option.name, 'data-field="option-name" aria-label="Option name" placeholder="e.g. refund"')}${field('Description (optional)', option.description, 'data-field="option-description" aria-label="Option description"')}<button type="button" class="st-clear" data-action="remove-option" ${q.options.length <= 2 ? 'disabled' : ''}>Remove</button></div>`).join('')}<button type="button" class="st-clear" data-action="add-option" ${q.options.length >= 255 ? 'disabled' : ''}>+ Option</button><details class="jev-bulk"><summary>Paste many options</summary><textarea class="st-input" aria-label="Paste options" placeholder="One option per line. Optional: name | description"></textarea><button type="button" class="st-clear" data-action="paste-options">Replace options</button></details>` : ''}
          ${q.type === 'score' ? `<div class="jev-section-heading"><span>Levels · lowest to highest; scores may fall between levels</span></div>${q.levels.map((level, n) => `<div class="jev-option" data-level="${n}">${field(`Level ${n}`, level, 'data-field="level" aria-label="Level description" placeholder="Describe what this level means…"')}<button type="button" class="st-clear" data-action="up-level" aria-label="Move level up" data-tooltip="Move up" ${n === 0 ? 'disabled' : ''}>↑</button><button type="button" class="st-clear" data-action="remove-level" ${q.levels.length <= 2 ? 'disabled' : ''}>Remove</button></div>`).join('')}<button type="button" class="st-clear" data-action="add-level" ${q.levels.length >= 10 ? 'disabled' : ''}>+ Level</button>` : ''}
        </div></details>`).join('')}</div>
        <div class="jev-add-questions" role="group" aria-label="Add primitive">${Object.entries(names).map(([type, name]) => `<button type="button" class="st-clear" data-add="${type}">+ ${name}</button>`).join('')}</div></section></div>`}
      <details class="jev-advanced"><summary>Model & request details</summary>${raw ? '<p>Change the model in Request JSON.</p>' : field('Model or alias', current.model, 'data-field="model" aria-label="JEV model" list="jev-models" placeholder="jev-latest"')}<datalist id="jev-models">${modelList.map(m => `<option value="${esc(m.name)}">${esc(m.description)}</option>`).join('')}</datalist><p class="st-help">jev-latest follows stable releases. Use jev-preview or a versioned ID to choose another release. No chat history, tools, or agent permissions are sent.</p><button type="button" class="st-clear" data-action="preview">Preview exact request</button></details>`
    restoreUi(disclosure, preserve, focusedField, question)
  }
  function restoreUi(disclosure: Map<string, boolean>, preserve: boolean, field?: string, question?: string) {
    for (const area of el.querySelectorAll<HTMLTextAreaElement>('textarea[data-field]')) {
      const q = current.questions[Number(area.closest<HTMLElement>('[data-q]')?.dataset.q)]
      const key = area.dataset.field
      const value = key === 'raw' ? current.raw : key === 'state' ? current.state : key === 'instructions' ? q?.instructions : key === 'level' ? q?.levels[Number(area.closest<HTMLElement>('[data-level]')?.dataset.level)] : undefined
      if (typeof value === 'string') area.value = value
    }
    if (preserve) for (const d of el.querySelectorAll<HTMLDetailsElement>('details')) {
      const key = `${d.closest<HTMLElement>('[data-q]')?.dataset.q || ''}:${d.className}`
      if (disclosure.has(key)) d.open = disclosure.get(key)!
    }
    if (preserve && field) el.querySelector<HTMLElement>(`${question !== undefined ? `[data-q="${question}"] ` : ''}[data-field="${field}"]`)?.focus({ preventScroll: true })
  }
  function error(message: string) { const box = el.querySelector<HTMLElement>('.jev-build-error')!; box.hidden = !message; box.textContent = message }
  el.addEventListener('input', event => {
    const target = event.target as HTMLInputElement
    const key = target.dataset.field; if (!key) return
    const index = target.closest<HTMLElement>('[data-q]')?.dataset.q
    if (index !== undefined) {
      const q = current.questions[Number(index)]
      const option = target.closest<HTMLElement>('[data-option]')?.dataset.option
      if (key === 'option-name') q.options[Number(option)].name = target.value
      else if (key === 'option-description') q.options[Number(option)].description = target.value || null
      else if (key === 'level') q.levels[Number(target.closest<HTMLElement>('[data-level]')!.dataset.level)] = target.value
      else if (key === 'id' || key === 'instructions' || key === 'yes' || key === 'no') q[key] = target.value
    } else if (key === 'raw' || key === 'state' || key === 'model') current[key] = target.value
    changed()
  })
  el.addEventListener('change', event => {
    const target = event.target as HTMLSelectElement
    if (target.dataset.field === 'type') {
      const q = current.questions[Number(target.closest<HTMLElement>('[data-q]')!.dataset.q)]
      q.type = target.value as Primitive; render(); changed()
    }
    if (target.matches('.jev-file')) void loadFile(target as unknown as HTMLInputElement)
  })
  el.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return
    const action = button.dataset.action, index = Number(button.closest<HTMLElement>('[data-q]')?.dataset.q)
    const q = current.questions[index]
    try {
      if (button.dataset.add) current.questions.push(newQuestion(button.dataset.add as Primitive, nextQuestionId(current.questions)))
      else if (button.dataset.format) {
        const format = button.dataset.format as 'text' | 'json'
        if (format === current.format) return
        if (format === 'json') current.state = JSON.stringify(current.state, null, 2)
        else { const state: unknown = JSON.parse(current.state); current.state = typeof state === 'string' ? state : JSON.stringify(state, null, 2) }
        current.format = format
      } else if (action === 'json') { if (current.raw === null) current.raw = JSON.stringify(requestFromDraft(current, false), null, 2) }
      else if (action === 'build') { if (current.raw !== null) current = draftFromRequest(requestFromDraft(current)) }
      else if (action === 'duplicate') current.questions.splice(index + 1, 0, { ...structuredClone(q), id: nextQuestionId(current.questions) })
      else if (action === 'remove') current.questions.splice(index, 1)
      else if (action === 'add-option') q.options.push({ name: '', description: null })
      else if (action === 'remove-option') q.options.splice(Number(button.closest<HTMLElement>('[data-option]')!.dataset.option), 1)
      else if (action === 'add-level') q.levels.push('')
      else if (action === 'remove-level') q.levels.splice(Number(button.closest<HTMLElement>('[data-level]')!.dataset.level), 1)
      else if (action === 'up-level') { const n = Number(button.closest<HTMLElement>('[data-level]')!.dataset.level); [q.levels[n - 1], q.levels[n]] = [q.levels[n], q.levels[n - 1]] }
      else if (action === 'paste-options') {
        const text = button.closest('.jev-bulk')!.querySelector('textarea')!.value
        const options = text.split('\n').filter(line => line.trim()).map(line => { const separator = line.indexOf('|'); return { name: (separator < 0 ? line : line.slice(0, separator)).trim(), description: separator < 0 ? null : line.slice(separator + 1).trim() || null } })
        if (options.length < 2 || options.length > 255) throw new Error('Paste 2–255 options, one per line.')
        q.options = options
      } else if (action === 'preview') { handlers.preview(); return }
      else if (action === 'example') { handlers.example(); return }
      else if (action === 'template') { handlers.template(); return }
      else return
      render(); changed()
      if (button.dataset.add || action === 'duplicate') {
        const row = el.querySelectorAll<HTMLDetailsElement>('.jev-question')[button.dataset.add ? current.questions.length - 1 : index + 1]
        row.open = true; row.querySelector<HTMLTextAreaElement>('[data-field="instructions"]')?.focus()
      }
    } catch (err) { error((err as Error).message) }
  })
  el.addEventListener('toggle', event => {
    const details = event.target as HTMLDetailsElement
    if (!details.matches('.jev-advanced') || !details.open || modelsLoaded || modelsLoading) return
    modelsLoading = true
    void handlers.models().then(models => {
      modelList = models; modelsLoaded = true
      const choices = el.querySelector('datalist')
      if (choices) choices.innerHTML = models.map(m => `<option value="${esc(m.name)}">${esc(m.description)}</option>`).join('')
    }).catch(() => { /* The documented aliases and manually entered model IDs remain usable. */ }).finally(() => { modelsLoading = false })
  }, true)
  el.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.repeat) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); handlers.evaluate() }
  })
  async function loadFile(input: HTMLInputElement) {
    const file = input.files?.[0]; if (!file) return
    const origin = current, before = current.state
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a text file smaller than 1 MiB.')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
      catch { throw new Error('Choose a UTF-8 text file. Binary or undecodable files cannot be used as state.') }
      if (text.includes('\u0000')) throw new Error('JEV accepts text, not binary files.')
      if (current !== origin) return
      if (current.state !== before) throw new Error('The state changed while reading the file. Your newer text was kept; select the file again to replace it.')
      if (file.name.endsWith('.json')) { JSON.parse(text); current.format = 'json' } else current.format = 'text'
      current.state = text; render(); changed()
    } catch (err) { if (current === origin) error((err as Error).message) }
  }
  return { el, get draft(): JevDraft { return current }, set(draft: JevDraft) { current = structuredClone(draft); render(false) }, error }
}
