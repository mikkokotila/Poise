import type { AgentId, NewSessionRequest, SessionContext } from '../../server/chat/protocol'
import type { AgentsResponse } from '../chat-client'
import { catalogueFamilies, familyForIdentity } from '../chat-catalog'
import { escapeHtml } from '../markdown'

export function renderNewSessionDialog(
  container: HTMLElement, info: AgentsResponse, context: SessionContext | undefined,
  onCreate: (request: NewSessionRequest, error: HTMLElement) => void, onCancel: () => void,
): void {
  const families = catalogueFamilies(info.agents)
  const initial = familyForIdentity(families, info.defaults.model) ?? families.find(f => f.agent.available) ?? families[0]
  const options = info.agents.map(agent => `<optgroup label="${escapeHtml(agent.label)}">${families.filter(f => f.agent === agent).map(f => `<option value="${escapeHtml(f.key)}" data-provider="${escapeHtml(agent.id)}">${escapeHtml(f.label)}</option>`).join('')}</optgroup>`).join('')
  const fallback = info.defaults.fallbackReason ? `<fieldset class="chat-dialog-field chat-dialog-fallback">
    <legend>Model provider</legend><div class="st-help st-help-error">${escapeHtml(info.defaults.fallbackReason)}</div>
    <label class="chat-radio"><input type="radio" name="fallback" value="default" checked> Use the default, <code>${escapeHtml(info.defaults.model)}</code></label>
    <label class="chat-radio"><input type="radio" name="fallback" value="fallback"> Use the fallback, <code>${escapeHtml(info.defaults.fallback)}</code></label></fieldset>` : ''
  container.innerHTML = `<form class="chat-dialog-body">
    <div class="chat-dialog-title">New session</div>
    ${context ? `<div class="chat-dialog-context"><span class="chat-pill">${escapeHtml(context.kind)}</span> ${escapeHtml(context.title)}</div>` : ''}
    <div class="chat-dialog-row">
      <label class="chat-dialog-field">Model<select class="st-select chat-d-model" aria-label="Model">${options}</select></label>
      <label class="chat-dialog-field">Effort<select class="st-select chat-d-effort" aria-label="Effort"></select></label>
    </div>
    <div class="st-help chat-dialog-model-state" role="status"></div>${fallback}
    <div class="st-help chat-dialog-location">Sessions and their files stay local to Poise.</div>
    <div class="st-help st-help-error chat-dialog-error" role="alert" hidden></div>
    <div class="st-row"><button type="submit" class="st-save chat-dialog-create">Create</button>
      <button type="button" class="st-clear chat-dialog-cancel">Cancel</button></div>
  </form>`
  const form = container.querySelector<HTMLFormElement>('form')!
  const model = form.querySelector<HTMLSelectElement>('.chat-d-model')!
  const effort = form.querySelector<HTMLSelectElement>('.chat-d-effort')!
  const create = form.querySelector<HTMLButtonElement>('.chat-dialog-create')!
  const status = form.querySelector<HTMLElement>('.chat-dialog-model-state')!
  const error = form.querySelector<HTMLElement>('.chat-dialog-error')!
  function fillEfforts(wanted?: string): void {
    const family = families.find(f => f.key === model.value)
    const variants = family?.models ?? []
    effort.innerHTML = variants.map(row => `<option value="${escapeHtml(row.effort)}"${row.identity === wanted ? ' selected' : ''}>${escapeHtml(row.effort)}</option>`).join('')
    effort.disabled = variants.length === 0
    status.textContent = family?.agent.available ? family.agent.label : family?.agent.reason || 'No catalogue models are available'
    status.classList.toggle('st-help-error', !family?.agent.available)
    create.disabled = !family?.agent.available || variants.length === 0
  }
  function pick(identity: string): void {
    const family = familyForIdentity(families, identity) ?? initial
    if (family) model.value = family.key
    fillEfforts(identity)
  }
  pick(info.defaults.model)
  model.addEventListener('change', () => fillEfforts())
  form.querySelectorAll<HTMLInputElement>('input[name="fallback"]').forEach(radio => radio.addEventListener('change', () => {
    if (radio.checked) pick(radio.value === 'fallback' ? info.defaults.fallback : info.defaults.model)
  }))
  form.querySelector('.chat-dialog-cancel')!.addEventListener('click', onCancel)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const family = families.find(f => f.key === model.value)
    const selected = family?.models.find(row => row.effort === effort.value)
    if (!family?.agent.available || !selected) {
      error.textContent = family?.agent.reason || 'Pick a catalogue model and effort.'
      error.hidden = false
      return
    }
    const useFallback = form.querySelector<HTMLInputElement>('input[name="fallback"][value="fallback"]')?.checked
    onCreate({ agent: family.agent.id as AgentId, model: selected.identity, effort: selected.effort, context,
      ...(useFallback && selected.identity === info.defaults.fallback ? { fallbackModel: selected.identity } : {}) }, error)
  })
  model.focus()
}
