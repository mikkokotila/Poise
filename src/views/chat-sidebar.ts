// A persistent split pane. Collapse keeps the element mounted so its width
// and contents can ease out; dragging follows the pointer without animation.
const WIDTH_KEY = 'poise-chat-sidebar-width'
const STATE_KEY = 'poise-chat-sidebar'
const DEFAULT_WIDTH = 260
const MIN_WIDTH = 200
const MAX_WIDTH = 480

function stored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* layout still works */ }
}

export function attachChatSidebar(view: HTMLElement, onLayout: () => void): { cancelResize(): void } {
  const layout = view.querySelector<HTMLElement>('.chat-layout')!
  const sidebar = view.querySelector<HTMLElement>('.chat-sidebar')!
  const handle = view.querySelector<HTMLElement>('.chat-sidebar-resize')!
  const toggle = view.querySelector<HTMLButtonElement>('.chat-sidebar-toggle')!
  const saved = Number(stored(WIDTH_KEY))
  let preferred = Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH
  let width = preferred
  let drag: { id: number, x: number, width: number } | null = null
  let collapsed = stored(STATE_KEY) === 'collapsed'
  const bounds = () => {
    const memories = view.querySelector<HTMLElement>('.chat-memories-pane')
    const occupied = memories && getComputedStyle(memories).position !== 'absolute' ? memories.getBoundingClientRect().width : 0
    const max = Math.max(160, Math.min(MAX_WIDTH, layout.clientWidth - occupied - 320))
    return { min: Math.min(MIN_WIDTH, max), max }
  }
  function resize(next = preferred): void {
    if (!layout.clientWidth) return // a hidden view has no usable bounds
    const { min, max } = bounds()
    width = Math.round(Math.max(min, Math.min(max, next)))
    view.style.setProperty('--chat-sidebar-width', `${width}px`)
    handle.setAttribute('aria-valuemin', String(min))
    handle.setAttribute('aria-valuemax', String(max))
    handle.setAttribute('aria-valuenow', String(width))
    handle.setAttribute('aria-valuetext', `${width} pixels`)
  }
  function persist(): void {
    preferred = Math.max(MIN_WIDTH, width)
    remember(WIDTH_KEY, String(preferred))
  }
  function cancelResize(): void {
    const pointer = drag?.id
    drag = null
    view.classList.remove('chat-sidebar-resizing')
    if (pointer !== undefined && handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    onLayout()
  }
  function setCollapsed(next: boolean): void {
    cancelResize()
    collapsed = next
    if (collapsed && sidebar.contains(document.activeElement)) toggle.focus()
    sidebar.inert = collapsed
    view.classList.toggle('chat-sidebar-collapsed', collapsed)
    toggle.setAttribute('aria-pressed', String(!collapsed))
    toggle.setAttribute('aria-expanded', String(!collapsed))
  }
  toggle.addEventListener('click', () => {
    setCollapsed(!collapsed)
    remember(STATE_KEY, collapsed ? 'collapsed' : 'open')
  })
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || collapsed) return
    event.preventDefault()
    handle.focus({ preventScroll: true })
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width }
    view.classList.add('chat-sidebar-resizing')
    handle.setPointerCapture(event.pointerId)
  })
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    resize(drag.width + event.clientX - drag.x)
  })
  handle.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return
    persist()
    cancelResize()
  })
  handle.addEventListener('pointercancel', cancelResize)
  handle.addEventListener('lostpointercapture', cancelResize)
  handle.addEventListener('dblclick', () => { resize(DEFAULT_WIDTH); persist(); onLayout() })
  window.addEventListener('blur', cancelResize)
  handle.addEventListener('keydown', event => {
    const { min, max } = bounds()
    const step = event.shiftKey ? 40 : 16
    const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step
      : event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (next === null) return
    event.preventDefault()
    resize(next)
    persist()
    onLayout()
  })
  sidebar.addEventListener('transitionend', event => {
    if (event.target === sidebar) onLayout()
  })
  // One observer for the app-lifetime view: shrinking the window clamps the
  // pane without replacing its saved preferred width. Returning restores it.
  const observer = new ResizeObserver(() => { resize(); onLayout() })
  observer.observe(layout)
  const memories = view.querySelector<HTMLElement>('.chat-memories-pane')
  if (memories) observer.observe(memories)
  resize()
  setCollapsed(collapsed)
  return { cancelResize }
}
