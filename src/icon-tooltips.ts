/** Short, delayed tooltips for icon-only controls, including newly rendered ones. */
export function installIconTooltips(root: HTMLElement = document.body): () => void {
  const tip = document.createElement('div')
  tip.id = 'poise-icon-tooltip'
  tip.className = 'icon-tooltip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.appendChild(tip)
  let target: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  function icon(node: EventTarget | null): HTMLElement | null {
    const button = node instanceof Element ? node.closest<HTMLElement>('button, [role="button"]') : null
    if (!button || !root.contains(button)) return null
    return button.matches('.chat-icon-btn, .chat-copy-btn, .chat-attachment-remove, .chat-session-delete, [data-tooltip]')
      || (!!button.querySelector('svg') && !button.textContent?.trim()) ? button : null
  }
  function label(button: HTMLElement): string {
    const text = button.dataset.tooltip || button.getAttribute('aria-label') || button.title
    return (text || '').replace(/[.…]+$/g, '').trim().split(/\s+/).slice(0, 2).join(' ')
  }
  function hide(): void {
    clearTimeout(timer)
    if (target) {
      const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id)
      if (descriptions.length) target.setAttribute('aria-describedby', descriptions.join(' '))
      else target.removeAttribute('aria-describedby')
    }
    target = null
    tip.hidden = true
  }
  function show(button: HTMLElement): void {
    if (button === target) return
    hide()
    const text = label(button)
    if (!text) return
    // Prevent the browser's separate, long native title tooltip.
    if (!button.dataset.tooltip && !button.getAttribute('aria-label')) button.dataset.tooltip = text
    button.removeAttribute('title')
    target = button
    timer = setTimeout(() => {
      if (target !== button || !button.isConnected || button.closest('[hidden], [inert]')) return hide()
      tip.textContent = label(button)
      tip.hidden = false
      const box = button.getBoundingClientRect()
      const width = tip.offsetWidth
      const height = tip.offsetHeight
      tip.style.left = `${Math.max(8, Math.min(box.x + box.width / 2 - width / 2, innerWidth - width - 8))}px`
      tip.style.top = `${box.bottom + height + 8 <= innerHeight ? box.bottom + 6 : Math.max(8, box.top - height - 6)}px`
      button.setAttribute('aria-describedby', [button.getAttribute('aria-describedby'), tip.id].filter(Boolean).join(' '))
    }, 1000)
  }
  const over = (event: Event) => { const button = icon(event.target); if (button) show(button) }
  const out = (event: MouseEvent) => { if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide() }
  const key = () => hide()
  root.addEventListener('pointerover', over)
  root.addEventListener('pointerout', out)
  root.addEventListener('focusin', over)
  root.addEventListener('focusout', hide)
  root.addEventListener('pointerdown', hide)
  document.addEventListener('keydown', key, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  const observer = new MutationObserver(() => { if (target && (!target.isConnected || target.closest('[hidden], [inert]'))) hide() })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] })
  return () => {
    hide()
    observer.disconnect()
    root.removeEventListener('pointerover', over)
    root.removeEventListener('pointerout', out)
    root.removeEventListener('focusin', over)
    root.removeEventListener('focusout', hide)
    root.removeEventListener('pointerdown', hide)
    document.removeEventListener('keydown', key, true)
    document.removeEventListener('scroll', hide, true)
    window.removeEventListener('resize', hide)
    tip.remove()
  }
}
