import type { MessageQueue, QueuedMessage } from '../../server/chat/protocol'
import { AGENT_LABELS } from '../../server/chat/protocol'
import type { AgentInfo } from '../chat-client'
import { consoleModelLabel } from '../chat-catalog'
import { escapeHtml } from '../markdown'

interface QueueHandlers {
  onModel(sessionId: string, itemId: string, model: string): void
  onRemove(sessionId: string, itemId: string): void
}
/** A stable, keyed list: streamed text never closes its disclosure or menus. */
export function createQueuePanel(handlers: QueueHandlers) {
  const el = document.createElement('details')
  el.className = 'chat-message-queue'
  el.setAttribute('aria-label', 'Queued messages')
  el.hidden = true
  el.innerHTML = '<summary><span class="chat-queue-chevron" aria-hidden="true">›</span><span class="chat-queue-title">Queue</span><span class="chat-queue-count"></span><span class="chat-queue-hint"></span></summary><ol class="chat-queue-items"></ol>'
  const list = el.querySelector<HTMLOListElement>('ol')!
  const count = el.querySelector<HTMLElement>('.chat-queue-count')!
  const hint = el.querySelector<HTMLElement>('.chat-queue-hint')!
  const expanded = new Map<string, boolean>()
  const counts = new Map<string, number>()
  const nodes = new Map<string, { el: HTMLLIElement, html: string }>()
  let sessionId = ''
  el.addEventListener('toggle', () => { if (sessionId && !el.hidden) expanded.set(sessionId, el.open) })
  el.addEventListener('change', event => {
    const target = event.target as HTMLSelectElement
    const row = target.closest<HTMLElement>('[data-queue-item]')
    if (row && target.matches('.chat-queue-agent')) handlers.onModel(sessionId, row.dataset.queueItem!, target.value)
  })
  el.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.chat-queue-remove')
    const row = target?.closest<HTMLElement>('[data-queue-item]')
    if (row) handlers.onRemove(sessionId, row.dataset.queueItem!)
  })
  function rowHtml(item: QueuedMessage, index: number, agents: AgentInfo[], pending: boolean): string {
    const options = agents.filter(agent => agent.models.length).map(agent => {
      const choices = agent.models.map(model => `<option value="${escapeHtml(model.identity)}"${model.identity === item.model ? ' selected' : ''}${agent.available ? '' : ' disabled'}>${escapeHtml(`${agent.label} · ${consoleModelLabel(model.identity, model.effort)}`)}${agent.available ? '' : ' — unavailable'}</option>`).join('')
      return `<optgroup label="${escapeHtml(agent.label)}">${choices}</optgroup>`
    }).join('')
    const present = agents.some(agent => agent.models.some(model => model.identity === item.model))
    const fallback = present ? '' : `<option value="${escapeHtml(item.model)}" selected>${escapeHtml(`${AGENT_LABELS[item.agent]} · ${consoleModelLabel(item.model, item.effort)}`)}</option>`
    const state = pending ? 'Saving…' : item.state === 'running' ? 'Running' : item.state === 'failed' ? 'Not completed' : ''
    return `<span class="chat-queue-number">${index + 1}</span><div class="chat-queue-content"><div class="chat-queue-text" title="${escapeHtml(item.prompt.text)}">${escapeHtml(item.prompt.text || 'Attachment task')}</div>
      ${item.prompt.attachments.length ? `<div class="chat-queue-files">${escapeHtml(item.prompt.attachments.map(file => file.name).join(', '))}</div>` : ''}
      <div class="chat-queue-meta"><select class="chat-queue-agent" aria-label="Agent and model for queued message ${index + 1}"${pending || item.state !== 'waiting' ? ' disabled' : ''}>${fallback}${options}</select><span class="chat-queue-state">${state}</span></div>
      ${item.error ? `<div class="chat-queue-error" role="status">${escapeHtml(item.error)}</div>` : ''}</div>
      <button type="button" class="chat-icon-btn chat-queue-remove" aria-label="Remove queued message ${index + 1}" title="Remove from queue"${pending || item.state === 'running' ? ' disabled' : ''}>×</button>`
  }
  return {
    el,
    render(id: string | null, queue: MessageQueue | undefined, agents: AgentInfo[], running: boolean, pending = new Set<string>()): void {
      const items = queue?.items || []
      const switched = sessionId !== (id || '')
      sessionId = id || ''
      el.hidden = !items.length
      if (!items.length) { if (id) counts.set(id, 0); return }
      if (switched || !counts.get(sessionId)) el.open = !counts.get(sessionId) || expanded.get(sessionId) !== false
      counts.set(sessionId, items.length)
      count.textContent = String(items.length)
      hint.textContent = queue?.waitingForRelease ? 'Waiting for the Poise release' : running || queue?.ready ? 'One at a time, after this turn' : 'Waiting for the next completed task'
      const keep = new Set(items.map(item => item.id))
      for (const [key, node] of nodes) if (!keep.has(key)) { node.el.remove(); nodes.delete(key) }
      items.forEach((item, index) => {
        let node = nodes.get(item.id)
        if (!node) { const row = document.createElement('li'); row.dataset.queueItem = item.id; row.className = 'chat-queue-item'; node = { el: row, html: '' }; nodes.set(item.id, node) }
        const html = rowHtml(item, index, agents, pending.has(item.id))
        if (node.html !== html) { node.html = html; node.el.innerHTML = html }
        node.el.dataset.state = item.state
        if (list.children[index] !== node.el) list.insertBefore(node.el, list.children[index] || null)
      })
    },
  }
}
