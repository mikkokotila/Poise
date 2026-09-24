import type { AgentInfo } from '../chat-client'
import { consoleModelLabel } from '../chat-catalog'
import { escapeHtml } from '../markdown'

interface PickerState { identity: string, label: string, visible: boolean, disabled: boolean }
interface PickerHandlers { onJev?(): void; jevAvailable?(): boolean; loadModels(): Promise<AgentInfo[]>, onSelect(identity: string): void }

/** A draft-only choice: opening or choosing never creates a native session. */
export function attachModelPicker(container: HTMLElement, handlers: PickerHandlers) {
  const trigger = container.querySelector<HTMLButtonElement>('.chat-default-model')!
  const label = trigger.querySelector<HTMLElement>('.chat-model-label')!
  const menu = container.querySelector<HTMLElement>('.chat-model-menu')!
  let state: PickerState = { identity: '', label: '', visible: false, disabled: true }
  let generation = 0
  let agents: AgentInfo[] = []
  let positionFrame: number | null = null

  function close(restoreFocus = false): void {
    generation++ // A late catalogue response must not reopen a dismissed picker.
    menu.hidden = true
    if (positionFrame !== null) cancelAnimationFrame(positionFrame)
    positionFrame = null
    trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus && !trigger.disabled && !container.hidden) trigger.focus()
  }

  function position(): void {
    const anchor = trigger.getBoundingClientRect()
    const bounds = container.closest('.chat-main')!.getBoundingClientRect()
    const top = Math.max(bounds.top, 0) + 12
    const bottom = Math.min(bounds.bottom, window.innerHeight) - 12
    const above = Math.max(0, anchor.top - top - 8)
    const below = Math.max(0, bottom - anchor.bottom - 8)
    const upwards = above >= Math.min(320, below)
    const width = Math.max(120, Math.min(360, bounds.width - 24, window.innerWidth - 24))
    menu.dataset.side = upwards ? 'above' : 'below'
    menu.style.maxHeight = `${Math.min(360, upwards ? above : below)}px`
    menu.style.width = `${width}px`
    menu.style.left = `${Math.min(0, bounds.right - 12 - anchor.left - width)}px`
  }

  function followAnchor(): void {
    positionFrame = null
    if (menu.hidden) return
    // Follow the animated fresh console after viewport or catalogue changes.
    position()
    positionFrame = requestAnimationFrame(followAnchor)
  }

  function jevOption(): string {
    return handlers.onJev && handlers.jevAvailable?.() ? '<button type="button" role="option" tabindex="-1" aria-selected="false" aria-disabled="false" class="chat-model-option jev-picker-option">JEV · Primitive builder</button>' : ''
  }
  function options(): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>('[role="option"][aria-disabled="false"]')]
  }

  function focusOption(option: HTMLButtonElement | undefined): void {
    for (const item of options()) item.tabIndex = item === option ? 0 : -1
    if (option) { option.focus({ preventScroll: true }); option.scrollIntoView({ block: 'nearest' }) }
    else menu.focus({ preventScroll: true })
  }

  async function open(): Promise<void> {
    if (state.disabled || !state.visible) return
    menu.hidden = false
    if (positionFrame === null) positionFrame = requestAnimationFrame(followAnchor)
    // Move focus off Retry before removing it: removing a focused child can
    // emit focusout with no relatedTarget and otherwise dismiss this request.
    menu.focus({ preventScroll: true })
    const request = ++generation
    menu.innerHTML = '<div class="chat-model-status" role="status">Loading models…</div>'
    trigger.setAttribute('aria-expanded', 'true')
    position()
    try {
      const loaded = await handlers.loadModels()
      if (request !== generation) return
      agents = loaded
      menu.innerHTML = agents.filter(agent => agent.models.length).map(agent => `
        <div class="chat-model-group" role="group" aria-label="${escapeHtml(agent.label)}">
          <div class="chat-model-provider">${escapeHtml(agent.label)}</div>
          ${agent.available ? '' : `<div class="chat-model-unavailable">${escapeHtml(agent.reason || 'Unavailable')}</div>`}
          ${agent.models.map(model => `<button type="button" role="option" tabindex="-1"
            class="chat-model-option" data-identity="${escapeHtml(model.identity)}"
            aria-selected="${model.identity === state.identity}" aria-disabled="${!agent.available}"
            title="${escapeHtml(agent.available ? model.identity : agent.reason || 'Unavailable')}">
            <span>${escapeHtml(consoleModelLabel(model.identity, model.effort))}</span>
            <span class="chat-model-check" aria-hidden="true">${model.identity === state.identity ? '✓' : ''}</span>
          </button>`).join('')}
        </div>`).join('') || '<div class="chat-model-status" role="status">No catalogue models are available.</div>'
      menu.insertAdjacentHTML('beforeend', jevOption())
      position()
      focusOption(options().find(option => option.dataset.identity === state.identity) ?? options()[0])
    } catch {
      if (request !== generation) return
      menu.innerHTML = '<div class="chat-model-status" role="status">Could not load the model catalogue.</div><button type="button" class="chat-model-retry">Try again</button>'
      menu.querySelector<HTMLButtonElement>('button')!.focus({ preventScroll: true })
    }
  }

  trigger.addEventListener('click', () => { if (menu.hidden) void open(); else close() })
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (menu.hidden) void open(); else focusOption(options()[0])
  })
  menu.addEventListener('click', event => {
    const target = event.target as HTMLElement
    if (target.closest('.jev-picker-option')) { close(); handlers.onJev?.(); return }
    if (target.closest('.chat-model-retry')) { void open(); return }
    const option = target.closest<HTMLButtonElement>('[data-identity]')
    if (!option || state.disabled || option.getAttribute('aria-disabled') === 'true') return
    const identity = option.dataset.identity!
    if (!agents.some(agent => agent.available && agent.models.some(model => model.identity === identity))) return
    handlers.onSelect(identity)
    close(true)
  })
  menu.addEventListener('keydown', event => {
    const items = options()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    else return
    event.preventDefault()
    event.stopPropagation()
    focusOption(items[next])
  })
  container.addEventListener('focusout', event => {
    if (!container.contains(event.relatedTarget as Node | null)) close()
  })
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !container.contains(event.target as Node)) close()
  })
  window.addEventListener('resize', () => { if (!menu.hidden) position() })

  return {
    close,
    layout() { if (!menu.hidden) position() },
    setState(next: PickerState): void {
      state = next
      container.hidden = !state.visible
      trigger.disabled = state.disabled
      label.textContent = state.label
      trigger.setAttribute('aria-label', `Choose model, current: ${state.label}`)
      if (!state.visible || state.disabled) close()
    },
  }
}
