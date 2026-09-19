import type { ChatFilePreview } from '../chat-file-reference'

/** Native modal focus/escape behavior; file contents are always text, not HTML. */
export function createFilePreview(parent: HTMLElement, read: (session: string, reference: string) => Promise<ChatFilePreview>) {
  const dialog = document.createElement('dialog')
  dialog.className = 'chat-file-preview'
  dialog.setAttribute('aria-label', 'File preview')
  dialog.innerHTML = `<header class="chat-file-header"><h2>File preview</h2><button type="button" class="chat-icon-btn" aria-label="Close file preview" title="Close">×</button></header>
    <div class="chat-file-path"></div><div class="chat-file-state" role="status"></div><pre class="chat-file-content" tabindex="0" aria-label="File contents"></pre>`
  parent.appendChild(dialog)
  const path = dialog.querySelector<HTMLElement>('.chat-file-path')!
  const status = dialog.querySelector<HTMLElement>('.chat-file-state')!
  const content = dialog.querySelector<HTMLElement>('.chat-file-content')!
  let generation = 0
  const close = () => { generation++; if (dialog.open) dialog.close() }
  dialog.querySelector('button')!.addEventListener('click', close)
  dialog.addEventListener('close', () => { generation++ })
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return
    const box = dialog.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close()
  })
  return { close, async show(session: string, reference: string) {
    const current = ++generation
    path.textContent = reference
    status.textContent = 'Loading file…'
    content.replaceChildren()
    if (!dialog.open) dialog.showModal()
    try {
      const file = await read(session, reference)
      if (current !== generation || !dialog.open) return
      path.textContent = file.path
      status.textContent = `Read only · current working copy${file.truncated ? ' · first 5,000 lines' : ''}`
      const fragment = document.createDocumentFragment()
      file.text.split('\n').forEach((text, index) => {
        const line = document.createElement('span')
        line.className = 'chat-file-line'
        line.dataset.line = String(index + 1)
        line.textContent = text || '\n'
        if (file.line && index + 1 >= file.line && index + 1 <= (file.endLine || file.line)) line.classList.add('selected')
        fragment.appendChild(line)
      })
      content.replaceChildren(fragment)
      content.querySelector<HTMLElement>('.selected')?.scrollIntoView({ block: 'center' })
    } catch (error) {
      if (current === generation && dialog.open) status.textContent = `Cannot preview this file — ${(error as Error).message}`
    }
  } }
}
