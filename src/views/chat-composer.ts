// Chat composer — the chat pane's composer habits (mode-lock chip, auto-
// resize, attachment chips, Enter sends / Shift+Enter newline) plus what a
// coding session needs on top: `@` file mentions, a `/` command palette, and
// Send ↔ Stop ↔ Steer while a turn runs.
//
// The composer knows nothing about sessions. The view feeds it the session's
// commands and state, keeps one draft per session, and receives plain
// callbacks: send, steer, stop, and Poise's own commands (/model, /mode,
// /fork). The file input, paste and drop all funnel into one upload path.

import type { Attachment, CommandOption, Mention } from '../../server/chat/protocol'
import { escapeHtml } from '../markdown'
import { parseQueueMessage } from '../chat-queue'
import type { AgentInfo } from '../chat-client'
import { attachModelPicker } from './chat-model-picker'

export interface ComposerDraft {
  text: string
  attachments: Attachment[]
  mentions: Mention[]
  mode: string | null
}

export interface ComposerState {
  /** A turn is running: Enter steers, the button stops. */
  running: boolean
  /** Nothing can be sent; `placeholder` says why. */
  disabled: boolean
  placeholder?: string
  /** Draft model choice, shown before a session is created. */
  modelLabel?: string
  modelIdentity?: string
  /** Offer a Resume button (the session was interrupted). */
  resume?: boolean
  /** Whether the session has an upload target. */
  sessionId: string | null
}

export interface ComposerHandlers {
  onSend(draft: ComposerDraft): void
  onQueue(draft: ComposerDraft): void
  loadModels(): Promise<AgentInfo[]>
  onModelSelect(identity: string): void
  onSteer(text: string): void
  onStop(): void
  onResume(): void
  /** `/model x`, `/mode y`, `/fork` — Poise's own commands. */
  onCommand(name: string, arg: string): void
  /** Lazily create an upload target for an untouched console. */
  prepareUpload(): Promise<string>
  upload(file: File, sessionId: string): Promise<Attachment>
  searchFiles(q: string): Promise<string[]>
}

export interface Composer {
  el: HTMLElement
  setCommands(agentCommands: CommandOption[], own: { model?: boolean, modes: boolean, fork: boolean, poise?: boolean }): void
  setState(state: ComposerState): void
  getDraft(): ComposerDraft
  setDraft(draft: ComposerDraft | null): void
  focus(): void
  /** Recompute the textarea height, e.g. after the composer became visible. */
  layout(): void
  /** A File is on its way to the server; it cannot be carried across a reload. */
  isUploading(): boolean
}

export function emptyDraft(): ComposerDraft {
  return { text: '', attachments: [], mentions: [], mode: null }
}

const ICON_SEND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'
const ICON_STOP = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

/** Auto-resize: a scrollHeight past this, or an explicit newline, is multiline. */
const MULTILINE_THRESHOLD_PX = 50
/** Growth cap; beyond it the textarea scrolls inside itself. */
const MAX_INPUT_PX = 120
const MENTION_DEBOUNCE_MS = 120
const STEER_HINT_MS = 2000
const DEFAULT_PLACEHOLDER = 'Message…'

const OWN_COMMANDS: CommandOption[] = [
  { name: 'model', description: 'Switch model', hint: '<identity>' },
  { name: 'mode', description: 'Switch mode', hint: '<mode>' },
  { name: 'fork', description: 'Fork this session' },
  { name: 'queue', description: 'Queue a message after the current or next task', hint: '<message>' },
  { name: 'poise', description: 'Implement and release a Poise change', hint: '<request>' },
]

export function createComposer(handlers: ComposerHandlers): Composer {
  const el = document.createElement('form')
  el.className = 'chat-composer chat-v-composer'
  el.innerHTML = `
    <div class="chat-input-wrap">
      <div class="chat-attachments" hidden></div>
      <div class="chat-input-row">
        <span class="chat-mode-chip chat-v-chip" aria-live="polite" hidden></span>
        <textarea class="chat-input" rows="1" placeholder="${DEFAULT_PLACEHOLDER}" spellcheck="true" aria-label="Message"></textarea>
      </div>
      <div class="chat-controls">
        <button class="chat-attach" type="button" aria-label="Attach file" title="Attach file">${ICON_PLUS}</button>
        <div class="chat-model-control" hidden>
          <button type="button" class="chat-default-model" aria-haspopup="listbox" aria-expanded="false" aria-controls="chat-console-models" title="Choose model and effort">
            <span class="chat-model-label"></span>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div id="chat-console-models" class="chat-model-menu" role="listbox" aria-label="Console model" tabindex="-1" hidden></div>
        </div>
        <span class="chat-steer-hint" hidden>steering</span>
        <span class="chat-controls-spacer"></span>
        <button class="chat-resume-btn" type="button" hidden>Resume</button>
        <button class="chat-send" type="submit" aria-label="Send" title="Send (Enter)">${ICON_SEND}</button>
      </div>
      <div class="chat-popover" role="listbox" hidden></div>
    </div>
    <input class="chat-file-input" type="file" multiple hidden />
  `
  const wrap = el.querySelector<HTMLElement>('.chat-input-wrap')!
  const input = el.querySelector<HTMLTextAreaElement>('.chat-input')!
  const chip = el.querySelector<HTMLElement>('.chat-v-chip')!
  const chipsEl = el.querySelector<HTMLElement>('.chat-attachments')!
  const sendBtn = el.querySelector<HTMLButtonElement>('.chat-send')!
  const attachBtn = el.querySelector<HTMLButtonElement>('.chat-attach')!
  const resumeBtn = el.querySelector<HTMLButtonElement>('.chat-resume-btn')!
  const fileInput = el.querySelector<HTMLInputElement>('.chat-file-input')!
  const steerHint = el.querySelector<HTMLElement>('.chat-steer-hint')!
  const modelPicker = attachModelPicker(el.querySelector<HTMLElement>('.chat-model-control')!, {
    loadModels: handlers.loadModels, onSelect: handlers.onModelSelect,
  })
  const popover = el.querySelector<HTMLElement>('.chat-popover')!

  let uploading = 0
  let attachments: Attachment[] = []
  let mentions: Mention[] = []
  let activeMode: string | null = null
  let agentCommands: CommandOption[] = []
  let ownCommands: CommandOption[] = [OWN_COMMANDS[0]]
  let state: ComposerState = { running: false, disabled: true, sessionId: null }
  let steerTimer: ReturnType<typeof setTimeout> | null = null

  // ── Auto-resize ───────────────────────────────────────────────────────
  // Single-line height comes from the computed line-height plus vertical
  // padding, so the type scale can change without a magic number here. Past
  // the threshold (or with an explicit newline) the height is an explicit
  // line-count estimate, capped; only beyond the cap does it scroll.
  function autoResize(): void {
    const cs = getComputedStyle(input)
    const lh = parseFloat(cs.lineHeight) || 19
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const single = Math.ceil(lh + padV)
    const minimum = Math.max(single, parseFloat(cs.minHeight) || 0)
    input.style.height = 'auto'
    const sh = input.scrollHeight
    const multiline = input.value.includes('\n') || sh > Math.max(MULTILINE_THRESHOLD_PX, minimum + 1)
    wrap.classList.toggle('multiline', multiline)
    let wanted = single
    if (multiline) {
      const lines = Math.max(input.value.split('\n').length, Math.round((sh - padV) / lh))
      wanted = Math.ceil(lines * lh + padV)
    }
    const height = Math.min(Math.max(wanted, minimum), MAX_INPUT_PX)
    input.style.height = `${height}px`
    input.style.overflowY = wanted > MAX_INPUT_PX ? 'auto' : 'hidden'
  }

  // ── Mode-lock chip ────────────────────────────────────────────────────

  function allCommands(): CommandOption[] {
    return [...ownCommands, ...agentCommands]
  }

  function applyMode(mode: string | null): void {
    activeMode = mode
    if (!mode) {
      chip.hidden = true
      chip.textContent = ''
      wrap.classList.remove('mode-locked')
      input.style.paddingLeft = ''
      applyState()
      return
    }
    chip.textContent = `/${mode}`
    chip.hidden = false
    wrap.classList.add('mode-locked')
    // The chip sits inside the textarea's box; its rendered width decides the
    // text inset, so a long command name never collides with the caret.
    const width = chip.getBoundingClientRect().width
    const base = parseFloat(getComputedStyle(input).paddingRight) || 12
    input.style.paddingLeft = `${Math.ceil(base + width + 6)}px`
    applyState()
  }

  // Space at end-of-input with the value exactly `/<command>` locks the chip.
  function tryEnterMode(e: KeyboardEvent): boolean {
    if (activeMode || e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return false
    if (input.selectionStart !== input.selectionEnd) return false
    if (input.selectionStart !== input.value.length) return false
    const t = input.value.trim().toLowerCase()
    if (!t.startsWith('/')) return false
    const match = allCommands().find((c) => `/${c.name.toLowerCase()}` === t)
    if (!match) return false
    e.preventDefault()
    input.value = ''
    autoResize()
    applyMode(match.name)
    closePopover()
    return true
  }

  // Backspace/Delete at position 0, or Cmd/Ctrl+X anywhere, unlocks.
  function tryExitMode(e: KeyboardEvent): boolean {
    if (!activeMode) return false
    if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
      applyMode(null)
      return true
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault()
      applyMode(null)
      return true
    }
    return false
  }

  // ── Attachments ───────────────────────────────────────────────────────

  function renderChips(): void {
    if (!attachments.length) {
      chipsEl.hidden = true
      chipsEl.innerHTML = ''
      return
    }
    chipsEl.hidden = false
    chipsEl.innerHTML = attachments.map((a) => `
      <span class="chat-attachment-chip" title="${escapeHtml(a.path)} · ${a.size} bytes">
        <span class="chat-attachment-name">${escapeHtml(a.name)}</span>
        <button type="button" class="chat-attachment-remove" data-path="${escapeHtml(a.path)}" aria-label="Remove ${escapeHtml(a.name)}">×</button>
      </span>`).join('')
  }

  async function uploadFiles(files: File[]): Promise<void> {
    if (state.disabled || uploading) return
    uploading += 1
    applyState()
    let target = state.sessionId
    try {
      target ||= await handlers.prepareUpload()
      for (const file of files) {
        try {
          const attachment = await handlers.upload(file, target)
          // The view saves an off-screen upload in that session's own draft.
          if (state.sessionId === target) {
            attachments.push(attachment)
            renderChips()
          }
        } catch (err) {
          if (state.sessionId === target) showNote(`Couldn't attach "${file.name}": ${(err as Error).message}`)
        }
      }
    } catch (err) {
      showNote(`Couldn't attach: ${(err as Error).message}`)
    } finally {
      uploading -= 1
      applyState()
    }
  }

  let noteTimer: ReturnType<typeof setTimeout> | null = null
  function showNote(text: string): void {
    steerHint.textContent = text
    steerHint.hidden = false
    if (noteTimer) clearTimeout(noteTimer)
    noteTimer = setTimeout(() => { steerHint.hidden = true; steerHint.textContent = 'steering' }, 4000)
  }

  // ── Popover: `/` palette and `@` mentions ─────────────────────────────

  type PopItem = { label: string, hint?: string, value: string }
  let popKind: 'command' | 'mention' | null = null
  let popItems: PopItem[] = []
  let popIndex = 0
  let mentionStart = -1
  let mentionTimer: ReturnType<typeof setTimeout> | null = null
  let mentionSeq = 0

  function closePopover(): void {
    mentionSeq++
    if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
    popKind = null
    popItems = []
    popover.hidden = true
    popover.innerHTML = ''
  }

  function renderPopover(): void {
    if (!popKind || !popItems.length) { closePopover(); return }
    popover.hidden = false
    popover.dataset.kind = popKind
    popover.innerHTML = popItems.map((it, i) =>
      `<button type="button" class="chat-pop-item${i === popIndex ? ' active' : ''}" role="option" aria-selected="${i === popIndex}" data-index="${i}">`
      + `<span class="chat-pop-label">${escapeHtml(it.label)}</span>${it.hint ? `<span class="chat-pop-hint">${escapeHtml(it.hint)}</span>` : ''}</button>`).join('')
    popover.querySelector<HTMLElement>('.chat-pop-item.active')?.scrollIntoView({ block: 'nearest' })
  }

  function updatePalette(): void {
    const v = input.value
    // A palette only while the whole input is one `/token` being typed.
    if (activeMode || !v.startsWith('/') || /\s/.test(v)) {
      if (popKind === 'command') closePopover()
      return
    }
    const q = v.slice(1).toLowerCase()
    const items = allCommands().filter((c) => c.name.toLowerCase().startsWith(q))
    popKind = 'command'
    popItems = items.map((c) => ({ label: `/${c.name}`, hint: [c.hint, c.description].filter(Boolean).join(' — '), value: c.name }))
    popIndex = 0
    renderPopover()
  }

  function mentionQuery(): { start: number, q: string } | null {
    const caret = input.selectionStart
    const before = input.value.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !/\s/.test(before[at - 1])) return null
    const q = before.slice(at + 1)
    if (/\s/.test(q)) return null
    return { start: at, q }
  }

  function updateMentions(): void {
    const m = mentionQuery()
    if (!m || !state.sessionId) {
      if (popKind === 'mention') closePopover()
      return
    }
    mentionStart = m.start
    if (mentionTimer) clearTimeout(mentionTimer)
    const seq = ++mentionSeq
    mentionTimer = setTimeout(async () => {
      let files: string[] = []
      try { files = await handlers.searchFiles(m.q) } catch { files = [] }
      if (seq !== mentionSeq) return
      const again = mentionQuery()
      if (!again) return
      popKind = 'mention'
      popItems = files.slice(0, 30).map((f) => ({ label: f, value: f }))
      popIndex = 0
      renderPopover()
    }, MENTION_DEBOUNCE_MS)
  }

  function acceptPopover(index: number): void {
    const item = popItems[index]
    if (!item || !popKind) return
    if (popKind === 'command') {
      input.value = `/${item.value}`
      // Own commands that take no argument act at once; the rest lock.
      closePopover()
      applyMode(item.value)
      input.value = ''
      autoResize()
      return
    }
    const caret = input.selectionStart
    const before = input.value.slice(0, mentionStart)
    const after = input.value.slice(caret)
    input.value = `${before}@${item.value} ${after}`
    const pos = before.length + item.value.length + 2
    input.setSelectionRange(pos, pos)
    if (!mentions.some((x) => x.path === item.value)) mentions.push({ path: item.value })
    closePopover()
    autoResize()
  }

  function popoverKey(e: KeyboardEvent): boolean {
    if (!popKind || !popItems.length) return false
    if (e.key === 'ArrowDown') { popIndex = (popIndex + 1) % popItems.length; renderPopover(); e.preventDefault(); return true }
    if (e.key === 'ArrowUp') { popIndex = (popIndex - 1 + popItems.length) % popItems.length; renderPopover(); e.preventDefault(); return true }
    if (e.key === 'Enter' && !e.shiftKey) { acceptPopover(popIndex); e.preventDefault(); return true }
    if (e.key === 'Tab') { acceptPopover(popIndex); e.preventDefault(); return true }
    if (e.key === 'Escape') { closePopover(); e.preventDefault(); return true }
    return false
  }

  // ── Send / steer / stop ───────────────────────────────────────────────

  function currentMentions(): Mention[] {
    // A mention the person deleted from the text is not sent.
    return mentions.filter((m) => input.value.includes(`@${m.path}`))
  }

  function submit(): void {
    if (state.disabled || uploading) return
    const text = input.value.trim()
    const queued = parseQueueMessage(text, activeMode)
    if (queued !== null) {
      if (!queued && !attachments.length) return
      handlers.onQueue({ text: queued, attachments: attachments.slice(), mentions: currentMentions(), mode: 'queue' })
      input.value = ''
      attachments = []
      mentions = []
      renderChips()
      applyMode(null)
      autoResize()
      closePopover()
      return
    }
    if (state.running) {
      if (!text) return
      handlers.onSteer(text)
      input.value = ''
      autoResize()
      steerHint.textContent = 'steering'
      steerHint.hidden = false
      if (steerTimer) clearTimeout(steerTimer)
      steerTimer = setTimeout(() => { steerHint.hidden = true }, STEER_HINT_MS)
      return
    }
    if (activeMode && ownCommands.some((c) => c.name === activeMode)) {
      const name = activeMode
      if (name !== 'fork' && !text) return
      if (name === 'poise') {
        handlers.onSend({ text: `/poise ${text}`.trim(), attachments: attachments.slice(), mentions: currentMentions(), mode: name })
        attachments = []; mentions = []; renderChips()
      } else handlers.onCommand(name, text)
      input.value = ''
      applyMode(null)
      autoResize()
      return
    }
    if (!text && !attachments.length) return
    const draft: ComposerDraft = {
      text: activeMode ? `/${activeMode} ${text}`.trim() : text,
      attachments: attachments.slice(),
      mentions: currentMentions(),
      mode: activeMode,
    }
    handlers.onSend(draft)
    input.value = ''
    attachments = []
    mentions = []
    renderChips()
    applyMode(null)
    autoResize()
    closePopover()
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  el.addEventListener('submit', (e) => {
    e.preventDefault()
    if (state.disabled) return
    if (state.running && parseQueueMessage(input.value, activeMode) === null) handlers.onStop()
    else submit()
  })
  input.addEventListener('input', () => {
    applyState()
    autoResize()
    updatePalette()
    updateMentions()
  })
  let composing = false
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => { composing = false })
  input.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') { closePopover(); return }
    if (popoverKey(e)) return
    if (tryEnterMode(e)) return
    if (tryExitMode(e)) return
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault()
      if (state.running) handlers.onStop()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })
  input.addEventListener('blur', () => {
    // Give a click on a popover item time to land before the list goes.
    setTimeout(() => { if (!popover.contains(document.activeElement)) closePopover() }, 150)
  })
  input.addEventListener('paste', (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || [])
    if (!files.length) return
    e.preventDefault()
    void uploadFiles(files)
  })
  wrap.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    wrap.classList.add('drag-over')
  })
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'))
  wrap.addEventListener('drop', (e) => {
    wrap.classList.remove('drag-over')
    const files = Array.from(e.dataTransfer?.files || [])
    if (!files.length) return
    e.preventDefault()
    void uploadFiles(files)
  })
  popover.addEventListener('mousedown', (e) => e.preventDefault())
  popover.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.chat-pop-item')
    if (!btn) return
    acceptPopover(Number(btn.dataset.index))
    input.focus()
  })
  attachBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || [])
    if (files.length) void uploadFiles(files)
    fileInput.value = ''
  })
  resumeBtn.addEventListener('click', () => handlers.onResume())
  chipsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chat-attachment-remove')
    if (!btn) return
    attachments = attachments.filter((a) => a.path !== btn.dataset.path)
    renderChips()
  })

  function applyState(): void {
    input.disabled = state.disabled
    attachBtn.disabled = state.disabled || uploading > 0
    const queuing = parseQueueMessage(input.value, activeMode) !== null
    input.placeholder = state.disabled ? (state.placeholder || 'Unavailable') : queuing ? 'Queue a follow-up…' : (state.running ? 'Steer the agent… (Enter)' : (state.placeholder || DEFAULT_PLACEHOLDER))
    sendBtn.disabled = state.disabled || (uploading > 0 && (queuing || !state.running))
    modelPicker.setState({ identity: state.modelIdentity || '', label: state.modelLabel || '', visible: !!state.modelLabel, disabled: state.disabled || uploading > 0 })
    sendBtn.innerHTML = state.running && !queuing ? ICON_STOP : ICON_SEND
    sendBtn.setAttribute('aria-label', queuing ? 'Queue message' : state.running ? 'Stop' : 'Send')
    sendBtn.title = queuing ? 'Add to queue (Enter)' : state.running ? 'Stop (⌘.)' : 'Send (Enter)'
    sendBtn.classList.toggle('is-stop', state.running && !queuing)
    resumeBtn.hidden = !state.resume
    if (state.disabled) closePopover()
  }
  applyState()
  autoResize()
  let observedWidth = 0
  const widthObserver = new ResizeObserver(([box]) => {
    if (!box || !box.contentRect.width || box.contentRect.width === observedWidth) return
    observedWidth = box.contentRect.width
    // Resize the text outside observer delivery, avoiding a resize loop when
    // wrapping changes the composer height while its width is animating.
    requestAnimationFrame(autoResize)
  })
  widthObserver.observe(el)

  return {
    el,
    setCommands(list, own) {
      agentCommands = list
      ownCommands = OWN_COMMANDS.filter((c) => c.name === 'queue' || (c.name === 'model' && own.model !== false) || (c.name === 'mode' && own.modes) || (c.name === 'fork' && own.fork) || (c.name === 'poise' && own.poise !== false))
    },
    setState(next) {
      // The view calls this on every render, including each streamed delta;
      // only a real change touches the DOM.
      const same = state.running === next.running && state.disabled === next.disabled
        && state.modelIdentity === next.modelIdentity && state.modelLabel === next.modelLabel && state.placeholder === next.placeholder && state.resume === next.resume && state.sessionId === next.sessionId
      state = next
      if (!same) applyState()
    },
    getDraft() {
      return { text: input.value, attachments: attachments.slice(), mentions: mentions.slice(), mode: activeMode }
    },
    setDraft(draft) {
      modelPicker.close()
      const d = draft || emptyDraft()
      input.value = d.text
      attachments = d.attachments.slice()
      mentions = d.mentions.slice()
      renderChips()
      applyMode(d.mode)
      closePopover()
      autoResize()
    },
    focus() { input.focus() },
    layout() { autoResize(); modelPicker.layout(); if (activeMode) applyMode(activeMode) },
    isUploading() { return uploading > 0 },
  }
}
